import { randomUUID } from "node:crypto";
import { detectSecrets } from "../../packages/storage/secrets.ts";
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
  PreparedReasoningProvider,
  type PreparedEvidence,
  type PreparedProvider,
  type PreparedUsage,
} from "../../packages/providers/prepared.ts";
import type { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";
import type { DispatchRecord } from "../../packages/domain/spend.ts";
import { dispatchPrepared, type PreparedAttempt } from "./dispatch.ts";
import { runSystemOneJob, type SystemOneClient } from "./system-one.ts";
import { runDecisionAdvisory } from "./decision-advisory.ts";
import { AccountingPersistenceError } from "../../packages/storage/managed-spending.ts";
import {
  LocalDispatchAccounting,
  TenantOnlyAccounting,
  type DispatchAccounting,
} from "./accounting.ts";

type GoalPrepared = {
  outcome: "proposal" | "abstain";
  artifact: string;
  evidence: PreparedEvidence;
  usage?: PreparedUsage;
  metadata: { provider: string; model: string; prompt_version: string };
  cost_micro_usd: number;
};

export class Worker {
  readonly id = randomUUID();
  private readonly accounting: DispatchAccounting;
  /**
   * The explicit, OPTIONAL decision-stage pair. When BOTH are present the same
   * owner review job runs one bounded advisory pass (its own account-bound
   * coordinator and a structural one-method adapter) BEFORE the independent
   * reasoning pass. When either is absent, only the reasoning path exists and it
   * behaves exactly as the S1 worker.
   */
  private readonly decisionAccounting?: DispatchAccounting;
  private readonly decisionProvider?: Pick<
    PreparedDecisionProvider,
    "prepareDecision"
  >;
  constructor(
    readonly brain: Brain,
    readonly provider: PreparedProvider = new PreparedReasoningProvider(),
    accounting?: DispatchAccounting,
    decision?: {
      decisionAccounting?: DispatchAccounting;
      decisionProvider?: Pick<PreparedDecisionProvider, "prepareDecision">;
    },
    /** Local sorting help. Null (the default) means it is not configured. */
    private readonly systemOne: SystemOneClient | null = null,
  ) {
    if (brain.tenantId !== undefined) {
      // A tenant-bound brain must never fall back to local money. Without an
      // injected account-bound central coordinator it can still run extractive,
      // unpaid work but any paid admission fails closed.
      if (accounting && accounting.accountId !== brain.tenantId)
        throw new BrainError(
          "UNAUTHORIZED",
          "Managed paid work requires its account-bound central accounting.",
          401,
        );
      this.accounting =
        accounting ?? new TenantOnlyAccounting(brain.store, brain.clock, brain.tenantId);
    } else {
      this.accounting =
        accounting ?? new LocalDispatchAccounting(brain.store, brain.clock);
    }
    const decisionAccounting = decision?.decisionAccounting;
    const decisionProvider = decision?.decisionProvider;
    // Both halves are required to opt into the decision path: a coordinator with
    // no adapter (or vice versa) leaves the reasoning behavior untouched. A
    // decision coordinator is account-bound exactly like the reasoning one, so a
    // foreign account can never be attached.
    if (decisionAccounting && decisionProvider) {
      if (decisionAccounting.accountId !== brain.tenantId)
        throw new BrainError(
          "UNAUTHORIZED",
          "Managed decision work requires its account-bound coordinator.",
          401,
        );
      this.decisionAccounting = decisionAccounting;
      this.decisionProvider = decisionProvider;
    }
  }
  /**
   * The owner principal for this worker's brain, derived per call rather than
   * from a module-global literal. A managed brain yields an owner bound to its
   * own tenant; a local brain yields the unbound local owner. Job payloads keep
   * their own persisted principal, so agent-originated scopes are never
   * upgraded to owner.
   */
  private get owner(): Principal {
    return this.brain.ownerPrincipal();
  }
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
  schedule() {
    const b = this.brain,
      prefs = b.prefs(this.owner);
    b.store.set("worker_heartbeat", b.now());
    b.store.run(
      "UPDATE jobs SET status='failed',fence=fence+1,error='Preparation deadline exceeded. Your original is saved.' WHERE status IN ('running','retry_wait') AND deadline_at<=?",
      b.now(),
    );
    b.store.run(
      "UPDATE jobs SET status='failed',error='Worker attempts exhausted after interruption.' WHERE status='running' AND lease_until<=? AND attempts>=max_attempts",
      b.now(),
    );
    for (const proposal of b.entities(this.owner, "proposal"))
      if (
        proposal.data.status === "snoozed" &&
        proposal.data.until <= b.now()
      ) {
        try {
          b.checkEvidence(
            this.owner,
            proposal.project_id,
            proposal.data.evidence,
          );
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
    if (this.ownerActive()) return;
    const last = b.store.setting<string>("last_digest_day", "");
    if (last === schedule.day) return;
    b.store.transaction(() => {
      for (const goal of b
        .entities(this.owner, "goal")
        .filter(
          (g) =>
            g.data.status === "active" &&
            b.isWatched(g.project_id) &&
            g.data.preparation_enabled &&
            (!g.data.review_at || g.data.review_at <= b.now()),
        )) {
        const pending = b.store.get(
          "SELECT id FROM jobs WHERE project_id=? AND kind='review_changed_assumption' AND json_extract(payload,'$.goal_id')=? AND status IN ('queued','running','retry_wait')",
          goal.project_id,
          goal.id,
        );
        if (!pending)
          b.enqueue(goal.project_id, "review_changed_assumption", {
            goal_id: goal.id,
            principal: this.owner,
            manual: false,
          });
      }
      b.store.set("last_digest_day", schedule.day);
    });
  }
  ownerActive() {
    const last = this.brain.store.setting<string | null>(
      "owner_activity",
      null,
    );
    return (
      !!last && this.brain.clock().getTime() - Date.parse(last) < 5 * 60_000
    );
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
      // Sorting help is advice only: its own spend path, no brief or receipt.
      if (j.kind === "system_one_route") {
        const r = await runSystemOneJob(
          {
            brain: b,
            ledger: this.accounting,
            client: this.systemOne,
            owner: this.owner,
            leaseOwner: this.id,
          },
          j as Parameters<typeof runSystemOneJob>[1],
          controller.signal,
        );
        b.store.run(
          "UPDATE jobs SET status=?,lease_until=NULL WHERE id=? AND fence=?",
          r.outcome === "recorded" ? "succeeded" : "cancelled",
          j.id,
          j.fence,
        );
        return true;
      }
      const prefs = b.prefs(this.owner);
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
      if (
        j.kind === "review_changed_assumption" &&
        !j.payload.manual &&
        this.ownerActive()
      )
        throw new BrainError(
          "JOB_CANCELLED",
          "Owner is active; background preparation was cancelled.",
          409,
        );
      const allSources = b.sources(this.owner, j.project_id);
      const sources = allSources.slice(0, 20);
      const signature = b.evidenceSignature(sources);
      let output = extract(sources),
        metadata: any = {
          provider: "extractive",
          prompt_version: "extract-v1",
        },
        cost = 0;
      let goalPrepared: GoalPrepared | undefined;
      let attempt: PreparedAttempt | undefined;
      let goalGuardVersion: number | undefined;
      // The advisory decision stage of the SAME owner review job. It runs after
      // the tick's cancellation/principal/access checks and BEFORE the
      // independently authorized reasoning branch, so a decision outcome can
      // never suppress or authorize reasoning. Missing decision config leaves
      // this block inert and the reasoning path byte-unchanged.
      if (
        this.decisionAccounting &&
        this.decisionProvider &&
        j.kind === "review_changed_assumption"
      )
        await runDecisionAdvisory(
          {
            brain: b,
            accounting: this.decisionAccounting,
            provider: this.decisionProvider,
            owner: this.owner,
          },
          j as { id: string; fence: number },
          this.id,
          controller.signal,
        );
      if (
        prefs.provider_enabled &&
        sources.some((s) => s.visibility === "project") &&
        (j.kind === "derive_brief" ||
          j.kind === "review_changed_assumption")
      ) {
        const selected = sources.filter((s) => s.visibility === "project");
        const guard = () => {
          // Re-reads authoritative state before reserve and again before mark.
          b.access(
            principal,
            j.project_id,
            principal.kind === "agent" ? "propose_memory" : "read",
          );
          if (!b.prefs(this.owner).provider_enabled)
            throw new BrainError(
              "JOB_CANCELLED",
              "Paid processing was turned off before dispatch.",
              409,
            );
          if (
            j.kind === "review_changed_assumption" &&
            !j.payload.manual &&
            this.ownerActive()
          )
            throw new BrainError(
              "JOB_CANCELLED",
              "Owner is active; background preparation was cancelled.",
              409,
            );
          if (
            signature !==
            b.evidenceSignature(b.sources(this.owner, j.project_id).slice(0, 20))
          )
            throw new BrainError(
              "SOURCE_STALE",
              "Sources changed before dispatch.",
              409,
            );
          if (j.kind === "review_changed_assumption") {
            const current = b.entity(this.owner, j.payload.goal_id);
            if (
              current.project_id !== j.project_id ||
              current.kind !== "goal" ||
              current.data.status !== "active" ||
              !current.data.preparation_enabled ||
              current.version !== goalGuardVersion
            )
              throw new BrainError(
                "SOURCE_STALE",
                "Selected goal changed before dispatch.",
                409,
              );
          }
        };
        if (j.kind === "derive_brief") {
          const paid = await dispatchPrepared(
            {
              brain: b,
              ledger: this.accounting,
              provider: this.provider,
              owner: this.owner,
            },
            { kind: "brief", sources: selected },
            j as { id: string; fence: number },
            this.id,
            guard,
            controller.signal,
          );
          attempt = paid;
          if (!paid.output.ok)
            throw new BrainError(paid.output.code, paid.output.reason, 503);
          if (paid.output.kind !== "brief")
            throw new BrainError(
              "PROVIDER_UNAVAILABLE",
              "The provider returned an unusable brief.",
              503,
            );
          output = outputSchema.parse({
            items: paid.output.items,
            unknowns: paid.output.unknowns,
          });
          output.items = [
            ...output.items,
            ...extract(sources.filter((s) => s.visibility === "private")).items,
          ].slice(0, 30);
        } else {
          const goal = b.entity(this.owner, j.payload.goal_id);
          if (
            goal.project_id !== j.project_id ||
            goal.kind !== "goal" ||
            goal.data.status !== "active"
          )
            throw new BrainError("SOURCE_STALE", "Selected goal changed.", 409);
          if (
            detectSecrets(
              `${goal.data.title}\n${goal.data.success_criteria}\n${goal.data.plan ?? ""}`,
            ).length
          )
            throw new BrainError(
              "INVALID_INPUT",
              "Goal contains suspected secrets; connected preparation was not sent.",
            );
          goalGuardVersion = goal.version;
          const goalInput = {
            title: goal.data.title,
            success_criteria: goal.data.success_criteria,
            plan: goal.data.plan_private ? "" : (goal.data.plan ?? ""),
          };
          const paid = await dispatchPrepared(
            {
              brain: b,
              ledger: this.accounting,
              provider: this.provider,
              owner: this.owner,
            },
            { kind: "goal", goal: goalInput, sources: selected },
            j as { id: string; fence: number },
            this.id,
            guard,
            controller.signal,
          );
          attempt = paid;
          if (!paid.output.ok || paid.output.kind !== "goal")
            throw new BrainError(
              paid.output.ok ? "PROVIDER_UNAVAILABLE" : paid.output.code,
              paid.output.ok
                ? "The provider returned an unusable preparation."
                : paid.output.reason,
              503,
            );
          goalPrepared = {
            outcome: paid.output.outcome,
            artifact: paid.output.artifact,
            evidence: paid.output.evidence,
            usage: paid.accounting.usage,
            metadata: {
              provider: paid.identity.provider,
              model: paid.identity.model,
              prompt_version: paid.identity.prompt_version,
            },
            cost_micro_usd: paid.accounting.cost_micro_usd,
          };
        }
        metadata = {
          provider: attempt.identity.provider,
          model: attempt.identity.model,
          prompt_version: attempt.identity.prompt_version,
          price_version: attempt.identity.price_version,
          usage: attempt.accounting.usage,
        };
        cost = attempt.accounting.cost_micro_usd;
      }
      b.store.transaction(() => {
        this.fenced(j);
        if (
          j.kind === "review_changed_assumption" &&
          !j.payload.manual &&
          this.ownerActive()
        )
          throw new BrainError(
            "JOB_CANCELLED",
            "Owner became active; provider output was discarded.",
            409,
          );
        b.access(
          principal,
          j.project_id,
          principal.kind === "agent" ? "propose_memory" : "read",
        );
        if (
          signature !==
          b.evidenceSignature(b.sources(this.owner, j.project_id).slice(0, 20))
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
            .entities(this.owner, "brief")
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
            .entities(this.owner, "goal")
            .filter(
              (g) =>
                g.project_id === j.project_id &&
                g.data.status === "active" &&
                g.data.preparation_enabled,
            ))
            if (prefs.enabled)
              b.enqueue(j.project_id, "review_changed_assumption", {
                goal_id: goal.id,
                principal: this.owner,
                manual: false,
              });
        } else if (j.kind === "review_changed_assumption") {
          const goal = b.entity(this.owner, j.payload.goal_id);
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
          if (goalGuardVersion !== undefined && goal.version !== goalGuardVersion)
            throw new BrainError(
              "SOURCE_STALE",
              "The selected goal changed before the provider result could be published.",
              409,
            );
          const relevant = this.relevant(
            sources,
            goal.data.title + " " + goal.data.success_criteria,
          );
          const goalSignature = b.evidenceSignature(relevant);
          if (!(goal.data.signatures ?? []).includes(goalSignature)) {
            if (
              goalPrepared?.outcome === "proposal" ||
              (!goalPrepared && relevant.length >= 2)
            ) {
              const evidence = goalPrepared
                ? goalPrepared.evidence
                : relevant.map(excerpt);
              b.checkEvidence(this.owner, j.project_id, evidence);
              const artifact =
                goalPrepared?.artifact ??
                `Hypothesis: review the current plan for “${goal.data.title}” against these saved passages.\n\n${evidence.map((e) => `“${e.quote}”`).join("\n\n")}\n\nProposed experiment: compare the earlier plan with the new evidence, choose one small test, and record the result. The passages do not by themselves prove a contradiction.`;
              const proposal = b.createEntity(j.project_id, "proposal", {
                goal_id: goal.id,
                base_version: goal.data.plan_version,
                title: `Review new evidence for ${goal.data.title}`,
                reason: goalPrepared
                  ? "A connected model proposed a source-linked next step for owner review. No decision was adopted."
                  : "New saved material may affect this chosen goal. This is an extractive review prompt; no inferred contradiction or adopted decision.",
                artifact,
                evidence,
                status: "ready",
                epistemic_status: "hypothesis",
                signature,
              });
              resultId = proposal.id;
              outcome = "changed";
              reason = goalPrepared
                ? "Prepared a model-backed next step for owner review."
                : "Prepared a source-linked review prompt, not a model inference.";
            } else {
              outcome = "abstained";
              reason = goalPrepared
                ? "The connected model abstained."
                : "Not enough relevant source passages to prepare a useful review.";
            }
            const local = localSchedule(b.clock(), prefs);
            const notify =
              !j.payload.manual &&
              outcome === "changed" &&
              local.eligible &&
              b.store.setting<string>("last_ping_day", "") !== local.day;
            if (notify) {
              b.createEntity(j.project_id, "ping", {
                title: "One prepared step to review",
                goal_id: goal.id,
                proposal_id: resultId,
                local_day: local.day,
                status: "ready",
              });
              b.store.set("last_ping_day", local.day);
            }
            b.revise(goal, {
              ...goal.data,
              signatures: [...(goal.data.signatures ?? []), goalSignature],
              last_notified_date: notify
                ? local.day
                : goal.data.last_notified_date,
            });
          }
        } else throw new BrainError("INVALID_INPUT", "Unsupported job kind.");
        const combined = this.decisionAccounting
          ? this.combinedPaidAccounting(j.id)
          : undefined;
        let call_id: string | null;
        let cost_micro_usd: number | null;
        let usage_status: string;
        if (combined?.present) {
          call_id = combined.call_id;
          usage_status = combined.usage_status;
          cost_micro_usd =
            combined.usage_status === "settled"
              ? combined.cost_micro_usd
              : combined.usage_status === "no_attempt"
                ? cost
                : null;
        } else {
          const persisted = this.accounting.receiptForJob(j.id);
          call_id = persisted?.call_id ?? null;
          cost_micro_usd =
            persisted?.state === "settled" ? persisted.actual_micro_usd : cost;
          usage_status = !persisted
            ? "no_provider_call"
            : persisted.state === "settled"
              ? "settled"
              : persisted.state === "released"
                ? "no_attempt"
                : "unknown";
        }
        b.createEntity(j.project_id, "receipt", {
          job_id: j.id,
          input_hash: signature,
          policy_version: "dream-gate-v1",
          outcome,
          reason,
          result_id: resultId,
          evidence: output.items.flatMap((i) => i.evidence),
          goal_evidence: goalPrepared?.evidence ?? [],
          call_id,
          cost_micro_usd,
          usage_status,
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
      // A failed safety-marker write is a fatal managed condition: it must stop
      // managed worker scheduling, never be downgraded to an ordinary job error.
      if (e instanceof AccountingPersistenceError) throw e;
      const code = e instanceof BrainError ? e.code : "PROVIDER_UNAVAILABLE";
      const safe =
        e instanceof BrainError
          ? e.message
          : "Preparation failed validation or the provider was unavailable. Your original is saved.";
      try {
        b.store.transaction(() => {
          this.fenced(j);
          // The exact REASONING slot decides whether this attempt may be retried.
          // A settled/held DECISION row on the SAME job must never suppress a
          // normal pre-send reasoning retry (its own `hasUnresolved` stays
          // byte-identical; only the new D-enabled path distinguishes the slots).
          const accounted = this.decisionAccounting
            ? (() => {
                const r = this.accounting.receiptForSlot(j.id, "reasoning");
                return !!r && r.state !== "released";
              })()
            : this.accounting.hasUnresolved(j.id);
          const legacy = !!b.store.get(
            "SELECT 1 FROM reservations WHERE job_id=?",
            j.id,
          );
          const retry =
            code === "PROVIDER_UNAVAILABLE" &&
            j.attempts < 3 &&
            !accounted &&
            !legacy;
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
          const persisted = this.accounting.receiptForJob(j.id);
          // A blocked legacy reservation has no dispatch row but still owns real
          // accounting: report it authoritatively instead of claiming no attempt.
          const legacyRow = persisted
            ? undefined
            : b.store.get<{ status: string; reserved: number; actual: number }>(
                "SELECT status,reserved,actual FROM reservations WHERE job_id=?",
                j.id,
              );
          let receiptCallId = persisted?.call_id ?? null;
          let accountingSource = persisted ? "dispatch" : legacyRow ? "legacy" : null;
          let legacyJobId = legacyRow ? j.id : null;
          let usageStatus = persisted
            ? persisted.state === "settled"
              ? "settled"
              : persisted.state === "released"
                ? "no_attempt"
                : "unknown"
            : legacyRow
              ? legacyRow.status === "settled"
                ? "settled"
                : "unknown"
              : "no_attempt";
          let costMicroUsd = persisted
            ? persisted.state === "settled"
              ? persisted.actual_micro_usd
              : null
            : legacyRow?.status === "settled"
              ? Number(legacyRow.actual)
              : null;
          // D-enabled: read BOTH exact own-account stage slots and aggregate. Any
          // marked stage keeps the whole-job total unknown (never zero or a
          // partial subtotal).
          const combined = this.decisionAccounting
            ? this.combinedPaidAccounting(j.id)
            : undefined;
          if (combined?.present) {
            receiptCallId = combined.call_id;
            accountingSource = "dispatch";
            legacyJobId = null;
            usageStatus = combined.usage_status;
            costMicroUsd =
              combined.usage_status === "settled"
                ? combined.cost_micro_usd
                : null;
          }
          b.createEntity(j.project_id, "receipt", {
            job_id: j.id,
            outcome: "failed",
            reason: safe,
            code,
            call_id: receiptCallId,
            accounting_source: accountingSource,
            legacy_job_id: legacyJobId,
            usage_status: usageStatus,
            cost_micro_usd: costMicroUsd,
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
  /**
   * Exact own-account stage accounting for one job. It reads the DECISION and
   * REASONING slots independently (never the "latest" row), so a settled decision
   * and a settled reasoning call sum to the true known job cost while ANY still
   * marked/unresolved stage forces the whole-job total to unknown — never zero and
   * never a partial subtotal. Only used on the D-enabled path; the default
   * reasoning-only path keeps its original receipt mapping byte-for-byte.
   */
  private combinedPaidAccounting(jobId: string): {
    present: boolean;
    call_id: string | null;
    cost_micro_usd: number | null;
    usage_status: "settled" | "unknown" | "no_attempt";
  } {
    const slots = [
      this.decisionAccounting?.receiptForSlot(jobId, "decision"),
      this.accounting.receiptForSlot(jobId, "reasoning"),
    ].filter((slot): slot is DispatchRecord => !!slot);
    if (!slots.length)
      return {
        present: false,
        call_id: null,
        cost_micro_usd: null,
        usage_status: "no_attempt",
      };
    const call_id = slots[slots.length - 1].call_id;
    if (slots.some((s) => s.state === "reserved" || s.state === "dispatched"))
      return { present: true, call_id, cost_micro_usd: null, usage_status: "unknown" };
    if (slots.every((s) => s.state === "released"))
      return { present: true, call_id, cost_micro_usd: null, usage_status: "no_attempt" };
    let total = 0;
    for (const slot of slots) {
      if (slot.state !== "settled") continue;
      const value = slot.actual_micro_usd;
      if (value === null || !Number.isSafeInteger(value))
        return { present: true, call_id, cost_micro_usd: null, usage_status: "unknown" };
      const next = total + value;
      if (!Number.isSafeInteger(next))
        return { present: true, call_id, cost_micro_usd: null, usage_status: "unknown" };
      total = next;
    }
    return { present: true, call_id, cost_micro_usd: total, usage_status: "settled" };
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
