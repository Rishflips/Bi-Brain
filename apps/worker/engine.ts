import { randomUUID } from "node:crypto";
import type { Brain } from "../../packages/domain/service.ts";
import {
  outputSchema,
  type Principal,
  type Source,
} from "../../packages/contracts/index.ts";
import {
  BrainError,
  extract,
  excerpt,
  localSchedule,
  validateEvidence,
} from "../../packages/domain/logic.ts";
import {
  OpenAIProvider,
  type ReasoningProvider,
} from "../../packages/providers/openai.ts";
const owner: Principal = { kind: "owner" };
export class Worker {
  readonly id = randomUUID();
  constructor(
    readonly brain: Brain,
    readonly provider: ReasoningProvider = new OpenAIProvider(),
  ) {}
  lease(): Record<string, any> | undefined {
    const b = this.brain;
    return b.store.transaction(() => {
      const j = b.store.get(
        `SELECT * FROM jobs WHERE ((status IN ('queued','retry_wait') AND next_at<=?) OR (status='running' AND lease_until<=?)) AND attempts<max_attempts ORDER BY created_at LIMIT 1`,
        b.now(),
        b.now(),
      );
      if (!j) return;
      const fence = j.fence + 1;
      b.store.run(
        "UPDATE jobs SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,fence=?,deadline_at=coalesce(deadline_at,?) WHERE id=?",
        this.id,
        new Date(b.clock().getTime() + 60000).toISOString(),
        fence,
        new Date(b.clock().getTime() + 300000).toISOString(),
        j.id,
      );
      return {
        ...j,
        fence,
        attempts: j.attempts + 1,
        payload: JSON.parse(j.payload),
      };
    });
  }
  fenced(j: any) {
    const row = this.brain.store.get(
      "SELECT status,fence,lease_owner FROM jobs WHERE id=?",
      j.id,
    );
    if (
      row?.status !== "running" ||
      row.fence !== j.fence ||
      row.lease_owner !== this.id
    )
      throw new BrainError(
        "JOB_CANCELLED",
        "This attempt is no longer current.",
        409,
      );
  }
  reserve(j: any, upper: number) {
    if (!Number.isSafeInteger(upper) || upper <= 0)
      throw new BrainError(
        "PROVIDER_UNAVAILABLE",
        "Provider estimate is invalid.",
        503,
      );
    const b = this.brain;
    return b.store.transaction(() => {
      this.fenced(j);
      const prior = b.store.get(
        "SELECT * FROM reservations WHERE job_id=?",
        j.id,
      );
      if (prior) {
        if (prior.status === "held")
          throw new BrainError(
            "BUDGET_EXHAUSTED",
            "An earlier call has unresolved usage; inspect before retrying.",
            409,
          );
        throw new BrainError(
          "BUDGET_EXHAUSTED",
          "This paid attempt already has an accounting record.",
          409,
        );
      }
      const prefs = b.prefs(owner);
      const day = localSchedule(b.clock(), prefs).day;
      const used = b.store.get(
        "SELECT coalesce(sum(CASE WHEN status=? THEN reserved ELSE actual END),0) AS amount FROM reservations WHERE day=?",
        "held",
        day,
      )!.amount;
      if (
        upper > prefs.per_job_cap_micro_usd ||
        used + upper > prefs.daily_cap_micro_usd
      )
        throw new BrainError(
          "BUDGET_EXHAUSTED",
          "Spending cap reached. Your note is saved.",
          409,
        );
      b.store.run(
        "INSERT INTO reservations VALUES(?,?,?,?,?)",
        j.id,
        day,
        upper,
        0,
        "held",
      );
    });
  }
  schedule() {
    const b = this.brain,
      prefs = b.prefs(owner);
    b.store.set("worker_heartbeat", b.now());
    b.store.run(
      "UPDATE jobs SET status='failed',fence=fence+1,error='Preparation deadline exceeded. Your original is saved.' WHERE status IN ('running','retry_wait') AND deadline_at<=?",
      b.now(),
    );
    b.store.run(
      "UPDATE jobs SET status='failed',error='Worker attempts exhausted after interruption.' WHERE status='running' AND lease_until<=? AND attempts>=max_attempts",
      b.now(),
    );
    for (const proposal of b.entities(owner, "proposal"))
      if (
        proposal.data.status === "snoozed" &&
        proposal.data.until <= b.now()
      ) {
        try {
          b.checkEvidence(owner, proposal.project_id, proposal.data.evidence);
          b.store.transaction(() =>
            b.revise(proposal, { ...proposal.data, status: "ready" }),
          );
        } catch {
          b.store.transaction(() =>
            b.revise(proposal, { ...proposal.data, status: "invalidated" }),
          );
        }
      }
    const schedule = localSchedule(b.clock(), prefs);
    if (!prefs.enabled || !schedule.eligible) return;
    const last = b.store.setting<string>("last_digest_day", "");
    if (last === schedule.day) return;
    b.store.transaction(() => {
      for (const goal of b
        .entities(owner, "goal")
        .filter(
          (g) => g.data.status === "active" && g.data.preparation_enabled,
        )) {
        const pending = b.store.get(
          "SELECT id FROM jobs WHERE project_id=? AND kind='review_changed_assumption' AND json_extract(payload,'$.goal_id')=? AND status IN ('queued','running','retry_wait')",
          goal.project_id,
          goal.id,
        );
        if (!pending)
          b.enqueue(goal.project_id, "review_changed_assumption", {
            goal_id: goal.id,
            principal: owner,
            manual: false,
          });
      }
      b.store.set("last_digest_day", schedule.day);
    });
  }
  async tick() {
    this.schedule();
    const j = this.lease();
    if (!j) return false;
    const b = this.brain;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const beat = setInterval(() => {
      try {
        b.store.run(
          "UPDATE jobs SET lease_until=? WHERE id=? AND fence=? AND lease_owner=? AND status='running'",
          new Date(b.clock().getTime() + 60000).toISOString(),
          j.id,
          j.fence,
          this.id,
        );
        const state = b.store.get(
          "SELECT status,fence FROM jobs WHERE id=?",
          j.id,
        );
        if (state?.status !== "running" || state.fence !== j.fence)
          controller.abort();
        b.store.set("worker_heartbeat", b.now());
      } catch {
        controller.abort();
      }
    }, 5000);
    try {
      const principal = j.payload.principal as Principal;
      b.access(
        principal,
        j.project_id,
        principal.kind === "agent" ? "propose_memory" : "read",
      );
      const prefs = b.prefs(owner);
      if (
        j.kind === "review_changed_assumption" &&
        !j.payload.manual &&
        !prefs.enabled
      )
        throw new BrainError(
          "JOB_CANCELLED",
          "Background help is paused.",
          409,
        );
      const allSources = b.sources(owner, j.project_id);
      const sources = allSources.slice(0, 20);
      const signature = b.evidenceSignature(sources);
      let output = extract(sources),
        metadata: any = {
          provider: "extractive",
          prompt_version: "extract-v1",
        },
        cost = 0;
      if (
        j.kind === "derive_brief" &&
        prefs.provider_enabled &&
        sources.some((s) => s.visibility === "project")
      ) {
        const selected = sources.filter((s) => s.visibility === "project");
        const upper = this.provider.upperBound(selected);
        this.reserve(j, upper);
        const prepared = await this.provider.prepare(
          selected,
          controller.signal,
        );
        output = outputSchema.parse({
          items: prepared.items,
          unknowns: prepared.unknowns,
        });
        output.items = [
          ...output.items,
          ...extract(sources.filter((s) => s.visibility === "private")).items,
        ].slice(0, 30);
        metadata = { ...prepared.metadata, usage: prepared.usage };
        cost = prepared.cost_micro_usd;
        if (!Number.isSafeInteger(cost) || cost < 0)
          throw new BrainError(
            "PROVIDER_UNAVAILABLE",
            "Provider cost is invalid; reservation remains held.",
            503,
          );
        const exceeded = b.store.transaction(() => {
          const r = b.store.get(
            "SELECT reserved FROM reservations WHERE job_id=?",
            j.id,
          )!;
          b.store.run(
            "UPDATE reservations SET actual=?,status=? WHERE job_id=?",
            cost,
            "settled",
            j.id,
          );
          if (cost > r.reserved) {
            b.store.set("preferences", { ...prefs, provider_enabled: false });
            return true;
          }
          return false;
        });
        if (exceeded)
          throw new BrainError(
            "BUDGET_EXHAUSTED",
            "Provider usage exceeded its estimate. Paid processing was disabled.",
            409,
          );
      }
      b.store.transaction(() => {
        this.fenced(j);
        b.access(
          principal,
          j.project_id,
          principal.kind === "agent" ? "propose_memory" : "read",
        );
        if (
          signature !==
          b.evidenceSignature(b.sources(owner, j.project_id).slice(0, 20))
        )
          throw new BrainError(
            "SOURCE_STALE",
            "Sources changed during preparation.",
            409,
          );
        let resultId: string | undefined;
        let outcome = "no_change",
          reason = "No new evidence for the selected goal.";
        if (j.kind === "derive_brief") {
          for (const item of output.items)
            validateEvidence(item.evidence, sources, j.project_id);
          const old = b
            .entities(owner, "brief")
            .find((e) => e.project_id === j.project_id);
          const corrections = (old?.data.items ?? []).filter((item: any) => {
            if (item.epistemic_status !== "user_assertion") return false;
            try {
              validateEvidence(item.evidence, sources, j.project_id);
              return true;
            } catch {
              return false;
            }
          });
          if (corrections.length)
            output.items = [...corrections, ...output.items].slice(0, 30);
          const data = {
            title: "Current understanding",
            status: "current",
            mode:
              metadata.provider === "extractive"
                ? "Extractive preview"
                : "Connected model",
            items: output.items,
            unknowns: output.unknowns,
            omitted_sources: allSources.length - sources.length,
            visibility:
              sources.some((s) => s.visibility === "private") ||
              (corrections.length && old?.data.visibility === "private")
                ? "private"
                : "project",
            source_versions: sources.map((s) => ({
              id: s.id,
              version: s.version,
            })),
            ...metadata,
          };
          resultId = (
            old
              ? b.revise(old, data)
              : b.createEntity(j.project_id, "brief", data)
          ).id;
          outcome = "changed";
          reason = "Prepared from retained source passages.";
          for (const goal of b
            .entities(owner, "goal")
            .filter(
              (g) =>
                g.project_id === j.project_id &&
                g.data.status === "active" &&
                g.data.preparation_enabled,
            ))
            if (prefs.enabled)
              b.enqueue(j.project_id, "review_changed_assumption", {
                goal_id: goal.id,
                principal: owner,
                manual: false,
              });
        } else if (j.kind === "review_changed_assumption") {
          const goal = b.entity(owner, j.payload.goal_id);
          if (
            goal.project_id !== j.project_id ||
            goal.data.status !== "active" ||
            !goal.data.preparation_enabled
          )
            throw new BrainError(
              "FORBIDDEN",
              "Goal preparation is disabled.",
              403,
            );
          const relevant = this.relevant(
            sources,
            goal.data.title + " " + goal.data.success_criteria,
          );
          const goalSignature = b.evidenceSignature(relevant);
          if (!(goal.data.signatures ?? []).includes(goalSignature)) {
            if (relevant.length >= 2) {
              const evidence = relevant.map(excerpt);
              b.checkEvidence(owner, j.project_id, evidence);
              const artifact = `Hypothesis: review the current plan for “${goal.data.title}” against these saved passages.\n\n${evidence.map((e) => `“${e.quote}”`).join("\n\n")}\n\nProposed experiment: compare the earlier plan with the new evidence, choose one small test, and record the result. The passages do not by themselves prove a contradiction.`;
              const proposal = b.createEntity(j.project_id, "proposal", {
                goal_id: goal.id,
                base_version: goal.data.plan_version,
                title: `Review new evidence for ${goal.data.title}`,
                reason:
                  "New saved material may affect this chosen goal. This is an extractive review prompt; no inferred contradiction or adopted decision.",
                artifact,
                evidence,
                status: "ready",
                epistemic_status: "hypothesis",
                signature,
              });
              resultId = proposal.id;
              outcome = "changed";
              reason =
                "Prepared a source-linked review prompt, not a model inference.";
            } else {
              outcome = "abstained";
              reason =
                "Not enough relevant source passages to prepare a useful review.";
            }
            b.revise(goal, {
              ...goal.data,
              signatures: [...(goal.data.signatures ?? []), goalSignature],
            });
          }
        } else throw new BrainError("INVALID_INPUT", "Unsupported job kind.");
        b.createEntity(j.project_id, "receipt", {
          job_id: j.id,
          outcome,
          reason,
          result_id: resultId,
          evidence: output.items.flatMap((i) => i.evidence),
          cost_micro_usd: cost,
          ...metadata,
        });
        b.store.run(
          "UPDATE jobs SET status='succeeded',result_id=?,lease_until=NULL WHERE id=? AND fence=?",
          resultId ?? null,
          j.id,
          j.fence,
        );
      });
    } catch (e) {
      const code = e instanceof BrainError ? e.code : "PROVIDER_UNAVAILABLE";
      const safe =
        e instanceof BrainError
          ? e.message
          : "Preparation failed validation or the provider was unavailable. Your original is saved.";
      try {
        b.store.transaction(() => {
          this.fenced(j);
          const retry =
            code === "PROVIDER_UNAVAILABLE" &&
            j.attempts < 3 &&
            !b.store.get(
              "SELECT job_id FROM reservations WHERE job_id=?",
              j.id,
            );
          const status = retry
            ? "retry_wait"
            : code === "JOB_CANCELLED"
              ? "cancelled"
              : "failed";
          b.store.run(
            "UPDATE jobs SET status=?,error=?,next_at=?,lease_until=NULL WHERE id=? AND fence=?",
            status,
            safe,
            new Date(
              b.clock().getTime() + 1000 * 2 ** j.attempts,
            ).toISOString(),
            j.id,
            j.fence,
          );
          b.createEntity(j.project_id, "receipt", {
            job_id: j.id,
            outcome: "failed",
            reason: safe,
            code,
            cost_micro_usd: 0,
            evidence: [],
          });
        });
      } catch {
        /* Cancellation/reclaimed lease owns the result. */
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(beat);
    }
    return true;
  }
  relevant(sources: Source[], goal: string) {
    const words = goal.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
    const stop = new Set([
      "this",
      "with",
      "that",
      "from",
      "users",
      "have",
      "will",
      "your",
      "goal",
    ]);
    const terms = words.filter((w) => !stop.has(w));
    return sources
      .filter((s) =>
        terms.some((w) => `${s.title} ${s.body}`.toLowerCase().includes(w)),
      )
      .slice(0, 6);
  }
}
