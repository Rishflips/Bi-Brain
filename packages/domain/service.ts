import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { Storage } from "../storage/index.ts";
import {
  captureSchema,
  outputSchema,
  evidenceSchema,
  preferencesSchema,
  type Entity,
  type Source,
  type Principal,
  type Evidence,
  type Preferences,
} from "../contracts/index.ts";
import {
  BrainError,
  hash,
  canonical,
  requireVersion,
  validateEvidence,
  excerpt,
  localSchedule,
} from "./logic.ts";
export const defaults: Preferences = {
  enabled: false,
  time_zone: "Asia/Calcutta",
  digest_hour: 9,
  quiet_start: 22,
  quiet_end: 8,
  daily_cap_micro_usd: 0,
  per_job_cap_micro_usd: 0,
  provider_enabled: false,
};
export class Brain {
  constructor(
    readonly store: Storage,
    readonly clock: () => Date = () => new Date(),
  ) {}
  now() {
    return this.clock().toISOString();
  }
  captureLimit(input: unknown) {
    const body = (input as { body?: unknown } | null)?.body;
    if (
      typeof body === "string" &&
      (Array.from(body).length > 100000 ||
        Buffer.byteLength(body, "utf8") > 1048576)
    )
      throw new BrainError(
        "INVALID_INPUT",
        "Text exceeds the 100,000 character / 1 MiB limit.",
        413,
      );
  }
  owner(p: Principal) {
    if (p.kind !== "owner")
      throw new BrainError("FORBIDDEN", "Owner access required.", 403);
  }
  issueSession() {
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(24).toString("hex");
    this.store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(token),
      csrf,
      new Date(this.clock().getTime() + 7 * 86400000).toISOString(),
    );
    return { token, csrf };
  }
  ownerSession(token: string) {
    const session = this.store.get(
      "SELECT csrf FROM sessions WHERE token_hash=? AND expires_at>?",
      hash(token),
      this.now(),
    );
    if (!session)
      throw new BrainError(
        "UNAUTHORIZED",
        "Pair this browser to your local brain.",
        401,
      );
    return session;
  }
  revokeSession(p: Principal, token: string) {
    this.owner(p);
    this.store.run("DELETE FROM sessions WHERE token_hash=?", hash(token));
    return { signed_out: true };
  }
  grant(p: Principal) {
    if (p.kind === "owner") return;
    const g = this.store.get(
      "SELECT * FROM grants WHERE id=? AND revoked_at IS NULL AND expires_at>?",
      p.grant_id,
      this.now(),
    );
    if (!g)
      throw new BrainError(
        "UNAUTHORIZED",
        "Access expired or was revoked.",
        401,
      );
    return {
      ...g,
      projects: JSON.parse(g.projects) as string[],
      operations: JSON.parse(g.operations) as string[],
    };
  }
  access(p: Principal, project: string, op = "read") {
    const g = this.grant(p);
    if (g && (!g.projects.includes(project) || !g.operations.includes(op)))
      throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    if (!this.store.get("SELECT id FROM projects WHERE id=?", project))
      throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
  }
  projects(p: Principal) {
    const g = this.grant(p);
    return this.store
      .all("SELECT * FROM projects ORDER BY created_at")
      .filter((r) => !g || g.projects.includes(r.id));
  }
  createProject(p: Principal, title: string) {
    this.owner(p);
    title = z.string().trim().min(1).max(200).parse(title);
    const project = { id: randomUUID(), title, created_at: this.now() };
    this.store.run(
      "INSERT INTO projects VALUES(?,?,?)",
      project.id,
      title,
      project.created_at,
    );
    return project;
  }
  source(p: Principal, id: string, version?: number): Source {
    const s = this.store.get(
      "SELECT * FROM sources WHERE id=? AND state!=?",
      id,
      "deleted",
    );
    if (!s) throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    this.access(p, s.project_id);
    if (
      p.kind === "agent" &&
      (s.visibility === "private" || s.state !== "active")
    )
      throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    const v = this.store.get(
      "SELECT title,body FROM source_versions WHERE source_id=? AND version=?",
      id,
      version ?? s.version,
    );
    if (!v) throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    return { ...s, ...v, version: version ?? s.version } as Source;
  }
  sources(p: Principal, project?: string, q = "") {
    if (project) this.access(p, project);
    const g = this.grant(p);
    let rows = this.store.all<Source>(
      `SELECT s.*,v.title,v.body FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.version=s.version WHERE s.state='active' ${project ? "AND s.project_id=?" : ""} ORDER BY s.captured_at DESC`,
      ...(project ? [project] : []),
    );
    rows = rows.filter(
      (s) =>
        (!g ||
          (g.projects.includes(s.project_id) &&
            s.visibility === "project" &&
            g.operations.includes("read"))) &&
        (!q ||
          `${s.title}\n${s.body}`
            .toLocaleLowerCase()
            .includes(q.toLocaleLowerCase())),
    );
    return rows;
  }
  entity(p: Principal, id: string): Entity {
    const row = this.store.get<Entity & { data: any }>(
      "SELECT * FROM entities WHERE id=?",
      id,
    );
    if (!row) throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    this.access(p, row.project_id);
    const e = { ...row, data: JSON.parse(row.data) };
    if (
      p.kind === "agent" &&
      (e.kind !== "brief" ||
        e.data.status !== "current" ||
        e.data.visibility === "private")
    )
      throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    if (p.kind === "agent")
      this.checkEvidence(
        p,
        e.project_id,
        e.data.items?.flatMap((i: any) => i.evidence) ?? [],
      );
    return e;
  }
  entities(p: Principal, kind?: string) {
    const g = this.grant(p);
    return this.store
      .all<Entity & { data: any }>(
        "SELECT * FROM entities ORDER BY created_at DESC",
      )
      .filter(
        (r) =>
          (!kind || r.kind === kind) &&
          (!g || g.projects.includes(r.project_id)),
      )
      .flatMap((r) => {
        try {
          return [this.entity(p, r.id)];
        } catch {
          return [];
        }
      });
  }
  createEntity(
    project: string,
    kind: string,
    data: Record<string, any>,
    id = randomUUID(),
  ): Entity {
    const e = {
      id,
      project_id: project,
      kind,
      version: 1,
      data,
      created_at: this.now(),
    };
    this.store.run(
      "INSERT INTO entities VALUES(?,?,?,?,?,?)",
      id,
      project,
      kind,
      1,
      JSON.stringify(data),
      e.created_at,
    );
    this.store.run(
      "INSERT INTO entity_versions VALUES(?,?,?,?)",
      id,
      1,
      JSON.stringify(data),
      e.created_at,
    );
    return e;
  }
  revise(e: Entity, data: Record<string, any>) {
    const version = e.version + 1;
    const changed = this.store.run(
      "UPDATE entities SET data=?,version=? WHERE id=? AND version=?",
      JSON.stringify(data),
      version,
      e.id,
      e.version,
    );
    if (changed.changes !== 1)
      throw new BrainError(
        "VERSION_CONFLICT",
        "This item changed since you opened it.",
        409,
      );
    this.store.run(
      "INSERT INTO entity_versions VALUES(?,?,?,?)",
      e.id,
      version,
      JSON.stringify(data),
      this.now(),
    );
    return { ...e, version, data };
  }
  enqueue(project: string, kind: string, payload: unknown) {
    const id = randomUUID();
    this.store.run(
      "INSERT INTO jobs(id,project_id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?,?)",
      id,
      project,
      kind,
      JSON.stringify(payload),
      this.now(),
      this.now(),
    );
    return { id, status: "queued" };
  }
  idempotent<T>(
    p: Principal,
    op: string,
    key: string | undefined,
    input: unknown,
    fn: () => T,
  ): T {
    if (!key) return fn();
    z.string().min(1).max(200).parse(key);
    const who = p.kind === "owner" ? "owner" : p.grant_id;
    const digest = hash(JSON.stringify(input));
    const old = this.store.get(
      "SELECT * FROM idempotency WHERE principal=? AND operation=? AND key=?",
      who,
      op,
      key,
    );
    if (old) {
      if (old.hash !== digest)
        throw new BrainError(
          "IDEMPOTENCY_CONFLICT",
          "This retry key was used with different content.",
          409,
        );
      return JSON.parse(old.result);
    }
    const result = fn();
    this.store.run(
      "INSERT INTO idempotency VALUES(?,?,?,?,?)",
      who,
      op,
      key,
      digest,
      JSON.stringify(result),
    );
    return result;
  }
  capture(p: Principal, input: unknown, key?: string) {
    this.captureLimit(input);
    const v = captureSchema.parse(input);
    this.access(
      p,
      v.project_id,
      p.kind === "agent" ? "propose_memory" : "read",
    );
    if (p.kind === "agent" && v.visibility === "private")
      throw new BrainError(
        "FORBIDDEN",
        "Agents may propose project assertions only.",
        403,
      );
    return this.store.transaction(() =>
      this.idempotent(p, `capture:${v.project_id}`, key, v, () => {
        const old = this.store.get(
          `SELECT s.id FROM sources s JOIN source_versions v ON s.id=v.source_id AND s.version=v.version WHERE s.project_id=? AND s.state='active' AND s.visibility=? AND v.body=?`,
          v.project_id,
          v.visibility,
          v.body,
        );
        if (old && !v.separate) return { source_id: old.id, duplicate: true };
        const id = randomUUID();
        this.store.run(
          "INSERT INTO sources VALUES(?,?,?,?,?,?,?)",
          id,
          v.project_id,
          1,
          "active",
          v.visibility,
          p.kind === "owner" ? "manual" : `agent:${p.grant_id}`,
          this.now(),
        );
        this.store.run(
          "INSERT INTO source_versions VALUES(?,?,?,?,?)",
          id,
          1,
          v.title,
          v.body,
          this.now(),
        );
        this.store.run(
          "INSERT INTO source_fts VALUES(?,?,?)",
          id,
          v.title,
          v.body,
        );
        this.invalidate(v.project_id);
        const job = this.enqueue(v.project_id, "derive_brief", {
          principal: p,
        });
        return { source_id: id, job, duplicate: false };
      }),
    );
  }
  invalidate(project: string) {
    for (const row of this.store.all<Entity & { data: any }>(
      "SELECT * FROM entities WHERE project_id=? AND kind='goal'",
      project,
    )) {
      const data = JSON.parse(row.data);
      if (data.plan_evidence?.length)
        this.store.run(
          "UPDATE entities SET data=? WHERE id=?",
          JSON.stringify({ ...data, plan_stale: true }),
          row.id,
        );
    }
    for (const row of this.store.all<Entity & { data: any }>(
      "SELECT * FROM entities WHERE project_id=? AND kind IN (?,?)",
      project,
      "brief",
      "proposal",
    )) {
      const data = JSON.parse(row.data);
      if (row.kind === "brief") data.status = "stale";
      else if (["ready", "snoozed"].includes(data.status))
        data.status = "invalidated";
      this.store.run(
        "UPDATE entities SET data=? WHERE id=?",
        JSON.stringify(data),
        row.id,
      );
    }
  }
  editSource(p: Principal, id: string, input: unknown) {
    this.owner(p);
    this.captureLimit(input);
    const v = z
      .object({
        body: captureSchema.shape.body,
        title: captureSchema.shape.title,
        expected_version: z.number().int().positive(),
        project_id: z.string().optional(),
        visibility: z.enum(["private", "project"]).optional(),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const s = this.source(p, id);
      requireVersion(s.version, v.expected_version);
      if (s.state !== "active")
        throw new BrainError(
          "SOURCE_WITHDRAWN",
          "This source is withdrawn.",
          409,
        );
      if (v.project_id) this.access(p, v.project_id);
      const project = v.project_id ?? s.project_id;
      const version = s.version + 1;
      this.store.run(
        "UPDATE sources SET version=?,project_id=?,visibility=? WHERE id=?",
        version,
        project,
        v.visibility ?? s.visibility,
        id,
      );
      this.store.run(
        "INSERT INTO source_versions VALUES(?,?,?,?,?)",
        id,
        version,
        v.title,
        v.body,
        this.now(),
      );
      this.store.run("DELETE FROM source_fts WHERE source_id=?", id);
      this.store.run(
        "INSERT INTO source_fts VALUES(?,?,?)",
        id,
        v.title,
        v.body,
      );
      this.invalidate(s.project_id);
      if (project !== s.project_id) this.invalidate(project);
      this.enqueue(project, "derive_brief", { principal: p });
      return this.source(p, id);
    });
  }
  removeSource(p: Principal, id: string, expected: number, purge: boolean) {
    this.owner(p);
    return this.store.transaction(() => {
      const s = this.source(p, id);
      requireVersion(s.version, expected);
      this.store.run(
        "UPDATE sources SET state=? WHERE id=?",
        purge ? "deleted" : "withdrawn",
        id,
      );
      this.store.run("DELETE FROM source_fts WHERE source_id=?", id);
      this.invalidate(s.project_id);
      if (purge) {
        for (const row of this.store.all<Entity & { data: any }>(
          "SELECT * FROM entities WHERE project_id=? AND kind='goal'",
          s.project_id,
        )) {
          const data = JSON.parse(row.data);
          const depended = this.store
            .all("SELECT data FROM entity_versions WHERE entity_id=?", row.id)
            .some((v) =>
              JSON.parse(v.data).plan_evidence?.some(
                (e: Evidence) => e.source_id === id,
              ),
            );
          if (depended) {
            const cleaned = this.revise(
              { ...row, data },
              {
                ...data,
                plan: "",
                plan_evidence: [],
                plan_stale: false,
                plan_version: data.plan_version + 1,
              },
            );
            this.store.run(
              "DELETE FROM entity_versions WHERE entity_id=?",
              row.id,
            );
            this.store.run(
              "INSERT INTO entity_versions VALUES(?,?,?,?)",
              row.id,
              cleaned.version,
              JSON.stringify(cleaned.data),
              this.now(),
            );
          }
        }
        this.store.run("DELETE FROM source_versions WHERE source_id=?", id);
        this.store.run(
          "DELETE FROM entities WHERE project_id=? AND kind IN (?,?,?)",
          s.project_id,
          "brief",
          "proposal",
          "receipt",
        );
        this.store.run("DELETE FROM idempotency");
        this.store.run("DELETE FROM imports");
      }
      this.enqueue(s.project_id, "derive_brief", { principal: p });
      return { state: purge ? "deleted" : "withdrawn" };
    });
  }
  checkEvidence(p: Principal, project: string, evidence: Evidence[]) {
    this.access(p, project);
    const sources = evidence.map((e) => this.source(p, e.source_id));
    validateEvidence(evidence, sources, project);
  }
  editBrief(p: Principal, id: string, input: unknown) {
    this.owner(p);
    const v = outputSchema
      .extend({ expected_version: z.number().int().positive() })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const e = this.entity(p, id);
      if (e.kind !== "brief" || e.data.status !== "current")
        throw new BrainError(
          "SOURCE_STALE",
          "Wait for the updated brief.",
          409,
        );
      requireVersion(e.version, v.expected_version);
      for (const item of v.items) {
        if (item.epistemic_status === "supported" && !item.evidence.length)
          throw new BrainError(
            "INVALID_INPUT",
            "Supported statements need evidence.",
          );
        this.checkEvidence(p, e.project_id, item.evidence);
      }
      return this.revise(e, {
        ...e.data,
        items: v.items,
        unknowns: v.unknowns,
        author: "user",
      });
    });
  }
  goal(p: Principal, input: unknown) {
    this.owner(p);
    const v = z
      .object({
        project_id: z.string(),
        title: z.string().trim().min(1).max(200),
        success_criteria: z.string().max(2000),
      })
      .strict()
      .parse(input);
    this.access(p, v.project_id);
    return this.store.transaction(() =>
      this.createEntity(v.project_id, "goal", {
        title: v.title,
        success_criteria: v.success_criteria,
        status: "active",
        preparation_enabled: false,
        plan: "",
        plan_version: 0,
        signatures: [],
      }),
    );
  }
  editGoal(p: Principal, id: string, input: unknown) {
    this.owner(p);
    const v = z
      .object({
        expected_version: z.number().int().positive(),
        status: z.enum(["active", "paused", "done"]).optional(),
        preparation_enabled: z.boolean().optional(),
        plan: z.string().max(20000).optional(),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const e = this.entity(p, id);
      if (e.kind !== "goal")
        throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
      requireVersion(e.version, v.expected_version);
      return this.revise(e, {
        ...e.data,
        ...v,
        plan_version: e.data.plan_version + (v.plan !== undefined ? 1 : 0),
      });
    });
  }
  prepare(p: Principal, goalId: string) {
    this.owner(p);
    const g = this.entity(p, goalId);
    if (
      g.kind !== "goal" ||
      g.data.status !== "active" ||
      !g.data.preparation_enabled
    )
      throw new BrainError(
        "FORBIDDEN",
        "Choose an active goal and enable preparation first.",
        403,
      );
    return this.enqueue(g.project_id, "review_changed_assumption", {
      goal_id: g.id,
      principal: p,
      manual: true,
    });
  }
  review(
    p: Principal,
    id: string,
    action: string,
    input: unknown,
    key?: string,
  ) {
    this.owner(p);
    const v = z
      .object({
        expected_version: z.number().int().positive(),
        edited_artifact: z.string().min(1).max(20000).optional(),
        until: z.iso.datetime().optional(),
        reason: z.string().max(2000).optional(),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() =>
      this.idempotent(p, `${action}:${id}`, key, v, () => {
        const proposal = this.entity(p, id);
        if (proposal.kind !== "proposal")
          throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
        requireVersion(proposal.version, v.expected_version);
        if (!["ready", "snoozed"].includes(proposal.data.status))
          throw new BrainError(
            "VERSION_CONFLICT",
            "This proposal is no longer awaiting review.",
            409,
          );
        this.checkEvidence(p, proposal.project_id, proposal.data.evidence);
        const goal = this.entity(p, proposal.data.goal_id);
        if (action === "accept") {
          requireVersion(goal.data.plan_version, proposal.data.base_version);
          const previous = goal.data.plan;
          const updated = this.revise(goal, {
            ...goal.data,
            plan: v.edited_artifact ?? proposal.data.artifact,
            plan_evidence: proposal.data.evidence,
            plan_stale: false,
            plan_version: goal.data.plan_version + 1,
          });
          const receipt = this.createEntity(goal.project_id, "receipt", {
            proposal_id: id,
            goal_id: goal.id,
            previous_plan: previous,
            previous_evidence: goal.data.plan_evidence ?? [],
            applied_plan: updated.data.plan,
            applied_version: updated.data.plan_version,
            outcome: "accepted",
            evidence: proposal.data.evidence,
            reverted: false,
          });
          this.revise(proposal, { ...proposal.data, status: "accepted" });
          return { receipt, goal: updated };
        }
        if (action === "snooze") {
          if (!v.until || Date.parse(v.until) <= this.clock().getTime())
            throw new BrainError(
              "INVALID_INPUT",
              "Choose a future reminder time.",
            );
          return this.revise(proposal, {
            ...proposal.data,
            status: "snoozed",
            until: new Date(v.until).toISOString(),
          });
        }
        if (action !== "dismiss")
          throw new BrainError("INVALID_INPUT", "Unknown review action.");
        return this.revise(proposal, {
          ...proposal.data,
          status: "dismissed",
          feedback: v.reason ?? "",
        });
      }),
    );
  }
  undo(p: Principal, id: string, expected: number) {
    this.owner(p);
    return this.store.transaction(() => {
      const r = this.entity(p, id);
      if (
        r.kind !== "receipt" ||
        r.data.outcome !== "accepted" ||
        r.data.reverted
      )
        throw new BrainError(
          "VERSION_CONFLICT",
          "This change cannot be undone.",
          409,
        );
      const g = this.entity(p, r.data.goal_id);
      requireVersion(g.data.plan_version, expected);
      requireVersion(g.data.plan_version, r.data.applied_version);
      const next = this.revise(g, {
        ...g.data,
        plan: r.data.previous_plan,
        plan_evidence: r.data.previous_evidence ?? [],
        plan_version: g.data.plan_version + 1,
      });
      this.revise(r, { ...r.data, reverted: true });
      const proposal = this.entity(p, r.data.proposal_id);
      this.revise(proposal, { ...proposal.data, status: "reverted" });
      return next;
    });
  }
  prefs(p: Principal, input?: unknown) {
    this.owner(p);
    if (input !== undefined)
      this.store.set("preferences", preferencesSchema.parse(input));
    return this.store.setting("preferences", defaults);
  }
  connections(p: Principal) {
    this.owner(p);
    return this.store
      .all(
        "SELECT id,projects,operations,expires_at,revoked_at,last_verified_at FROM grants",
      )
      .map((g) => ({
        ...g,
        projects: JSON.parse(g.projects),
        operations: JSON.parse(g.operations),
        status: g.revoked_at
          ? "Revoked"
          : g.expires_at <= this.now()
            ? "Needs attention"
            : g.last_verified_at
              ? "Connected"
              : "Not connected",
      }));
  }
  createGrant(p: Principal, input: unknown) {
    this.owner(p);
    const v = z
      .object({
        projects: z.array(z.string()).min(1).max(30),
        operations: z.array(z.enum(["read", "propose_memory"])).min(1),
        expires_at: z.iso.datetime(),
      })
      .strict()
      .parse(input);
    for (const project of v.projects) this.access(p, project);
    if (Date.parse(v.expires_at) <= this.clock().getTime())
      throw new BrainError(
        "INVALID_INPUT",
        "Expiration must be in the future.",
      );
    const id = randomUUID(),
      token = randomBytes(32).toString("hex");
    this.store.run(
      "INSERT INTO grants VALUES(?,?,?,?,?,NULL,NULL)",
      id,
      hash(token),
      JSON.stringify(v.projects),
      JSON.stringify(v.operations),
      new Date(v.expires_at).toISOString(),
    );
    return { id, token };
  }
  revoke(p: Principal, id: string) {
    this.owner(p);
    this.store.run("UPDATE grants SET revoked_at=? WHERE id=?", this.now(), id);
    return { revoked: true };
  }
  authenticateAgent(token: string): Principal {
    const row = this.store.get(
      "SELECT id FROM grants WHERE token_hash=?",
      hash(token),
    );
    if (!row) throw new BrainError("UNAUTHORIZED", "Access unavailable.", 401);
    const p: Principal = { kind: "agent", grant_id: row.id };
    this.grant(p);
    return p;
  }
  context(p: Principal, project: string, maxTokens = 3000) {
    this.access(p, project);
    maxTokens = z.number().int().min(64).max(3000).parse(maxTokens);
    const sources = this.sources(p, project);
    const brief = this.entities(p, "brief").find(
      (e) => e.project_id === project && e.data.status === "current",
    );
    const candidates =
      brief?.data.items ??
      sources.map((s) => ({
        text: excerpt(s).quote,
        evidence: [excerpt(s)],
        epistemic_status: s.origin.startsWith("agent:")
          ? "user_assertion"
          : "supported",
      }));
    let remaining = maxTokens * 3;
    const goals = this.entities({ kind: "owner" }, "goal")
      .filter((g) => g.project_id === project && g.data.status === "active")
      .flatMap((g) => {
        if (p.kind === "agent" && g.data.plan_private) return [];
        try {
          this.checkEvidence(p, project, g.data.plan_evidence ?? []);
          const goal = {
            title: g.data.title,
            success_criteria: g.data.success_criteria,
            plan: g.data.plan,
            epistemic_status: "user_assertion",
          };
          const size = Array.from(JSON.stringify(goal)).length;
          if (size > remaining) return [];
          remaining -= size;
          return [goal];
        } catch {
          return [];
        }
      });
    const items = [];
    for (const item of candidates) {
      const size = Array.from(JSON.stringify(item)).length;
      if (size <= remaining) {
        items.push(item);
        remaining -= size;
      }
    }
    const unknowns: string[] = [];
    for (const unknown of brief?.data.unknowns ?? []) {
      const size = Array.from(unknown).length;
      if (size <= remaining) {
        unknowns.push(unknown);
        remaining -= size;
      }
    }
    this.access(p, project);
    for (const item of items) this.checkEvidence(p, project, item.evidence);
    return {
      project_id: project,
      items,
      goals,
      unknowns,
      omitted_items: candidates.length - items.length,
      omitted_sources: brief?.data.omitted_sources ?? 0,
      insufficient_context: !items.length,
      estimate:
        "Unicode characters / 3 estimate; bounded items, evidence, goals, and unknowns; transport metadata excluded",
      freshness: this.now(),
      max_tokens: maxTokens,
    };
  }
  changes(p: Principal, project: string, cursor?: string) {
    this.access(p, project);
    const offset = cursor
      ? z
          .string()
          .regex(/^\d{1,9}$/)
          .parse(cursor)
      : "0";
    const changes = this.store.all(
      `SELECT c.seq,c.source_id AS id,s.version,s.state FROM source_changes c JOIN sources s ON s.id=c.source_id WHERE c.project_id=? AND s.project_id=? AND c.seq>? ${p.kind === "agent" ? "AND s.visibility='project'" : ""} ORDER BY c.seq LIMIT 50`,
      project,
      project,
      Number(offset),
    );
    this.access(p, project);
    return {
      changes: changes.map(({ seq: _seq, ...row }) => row),
      opaque_cursor: String(changes.at(-1)?.seq ?? Number(offset)),
      note: "Incremental source changes; returned state is the latest permitted version.",
    };
  }
  export(p: Principal, project?: string) {
    this.owner(p);
    if (project) this.access(p, project);
    const projects = this.projects(p).filter(
      (r) => !project || r.id === project,
    );
    const ids = projects.map((r) => r.id);
    const sources = this.store
      .all(
        "SELECT s.*,v.title,v.body,v.version AS version FROM sources s JOIN source_versions v ON s.id=v.source_id WHERE s.state!=?",
        "deleted",
      )
      .filter((s) => ids.includes(s.project_id));
    const entities = this.entities(p).filter((e) => ids.includes(e.project_id));
    const payload = { projects, sources, entities };
    return { format_version: 1, payload, checksum: hash(canonical(payload)) };
  }
  preview(p: Principal, input: unknown) {
    this.owner(p);
    const manifest = z
      .object({
        format_version: z.literal(1),
        payload: z.object({
          projects: z.array(
            z.object({
              id: z.string().max(100),
              title: z.string().min(1).max(200),
              created_at: z.iso.datetime(),
            }),
          ),
          sources: z.array(
            z.object({
              id: z.string().max(100),
              project_id: z.string().max(100),
              version: z.number().int().positive(),
              title: captureSchema.shape.title,
              body: captureSchema.shape.body,
              visibility: z.enum(["private", "project"]),
              state: z.enum(["active", "withdrawn"]),
              captured_at: z.iso.datetime(),
              origin: z.string().max(200),
            }),
          ),
          entities: z.array(
            z.object({
              id: z.string().max(100),
              project_id: z.string().max(100),
              kind: z.enum(["brief", "goal", "proposal", "receipt"]),
              version: z.number().int().positive(),
              data: z.record(z.string(), z.unknown()),
              created_at: z.iso.datetime(),
            }),
          ),
        }),
        checksum: z.string(),
      })
      .strict()
      .parse(input);
    if (hash(canonical(manifest.payload)) !== manifest.checksum)
      throw new BrainError("INVALID_INPUT", "Import checksum does not match.");
    const conflicts: string[] = [];
    for (const s of manifest.payload.sources) {
      if (!manifest.payload.projects.some((p) => p.id === s.project_id))
        throw new BrainError("INVALID_INPUT", "Source project missing.");
      const old = this.store.get(
        "SELECT body,title FROM source_versions WHERE source_id=? AND version=?",
        s.id,
        s.version,
      );
      const tomb = this.store.get("SELECT state FROM sources WHERE id=?", s.id);
      if (
        (old && (old.body !== s.body || old.title !== s.title)) ||
        tomb?.state === "deleted"
      )
        conflicts.push(s.id);
    }
    for (const entity of manifest.payload.entities) {
      if (
        !manifest.payload.projects.some(
          (project) => project.id === entity.project_id,
        )
      )
        throw new BrainError("INVALID_INPUT", "Knowledge project missing.");
      const old = this.store.get<Entity & { data: any }>(
        "SELECT * FROM entities WHERE id=?",
        entity.id,
      );
      if (
        old &&
        hash(canonical({ ...old, data: JSON.parse(old.data) })) !==
          hash(canonical(entity)) &&
        this.store.setting<string>(`import_digest:${entity.id}`, "") !==
          hash(canonical(entity))
      )
        conflicts.push(entity.id);
    }
    const id = randomUUID();
    this.store.run(
      "INSERT INTO imports VALUES(?,?,?)",
      id,
      JSON.stringify(manifest),
      this.now(),
    );
    return {
      id,
      projects: manifest.payload.projects.length,
      sources: manifest.payload.sources.length,
      conflicts,
      source_preview: manifest.payload.sources.map((s) => ({
        title: s.title,
        version: s.version,
        visibility: s.visibility,
        body: Array.from(s.body).slice(0, 500).join(""),
      })),
      plan_preview: manifest.payload.entities
        .filter((e) => e.kind === "goal")
        .map((e) => ({ title: e.data.title, plan: e.data.plan ?? "" })),
      policy:
        "Conflicts block apply. Source and knowledge IDs are preserved. Imported understanding is checked against originals; historical plans are imported as your assertions. Preparation is disabled, pending proposals are invalidated, and imported acceptance receipts cannot undo local work.",
    };
  }
  applyImport(p: Principal, id: string) {
    this.owner(p);
    const r = this.store.get("SELECT manifest FROM imports WHERE id=?", id);
    if (!r)
      throw new BrainError("NOT_FOUND", "Import preview unavailable.", 404);
    const m = JSON.parse(r.manifest);
    return this.store.transaction(() => {
      for (const project of m.payload.projects)
        this.store.run(
          "INSERT OR IGNORE INTO projects VALUES(?,?,?)",
          project.id,
          project.title,
          project.created_at,
        );
      for (const s of m.payload.sources) {
        const old = this.store.get(
          "SELECT body,title FROM source_versions WHERE source_id=? AND version=?",
          s.id,
          s.version,
        );
        const parent = this.store.get("SELECT * FROM sources WHERE id=?", s.id);
        if (
          (parent &&
            (parent.state === "deleted" ||
              parent.project_id !== s.project_id ||
              parent.visibility !== s.visibility)) ||
          (old && (old.body !== s.body || old.title !== s.title))
        )
          throw new BrainError(
            "VERSION_CONFLICT",
            "Import conflicts with local data. Nothing was imported.",
            409,
          );
        this.store.run(
          "INSERT OR IGNORE INTO sources VALUES(?,?,?,?,?,?,?)",
          s.id,
          s.project_id,
          s.version,
          s.state,
          s.visibility,
          "import",
          s.captured_at,
        );
        this.store.run(
          "INSERT OR IGNORE INTO source_versions VALUES(?,?,?,?,?)",
          s.id,
          s.version,
          s.title,
          s.body,
          s.captured_at,
        );
        if (!parent || s.version > parent.version)
          this.store.run(
            "UPDATE sources SET version=? WHERE id=?",
            s.version,
            s.id,
          );
      }
      for (const e of m.payload.entities) {
        const digest = hash(canonical(e));
        const existing = this.store.get<Entity & { data: any }>(
          "SELECT * FROM entities WHERE id=?",
          e.id,
        );
        if (existing) {
          if (
            hash(
              canonical({ ...existing, data: JSON.parse(existing.data) }),
            ) !== digest &&
            this.store.setting<string>(`import_digest:${e.id}`, "") !== digest
          )
            throw new BrainError(
              "VERSION_CONFLICT",
              "Imported knowledge conflicts with a local revision.",
              409,
            );
          continue;
        }
        if (!m.payload.projects.some((pr: any) => pr.id === e.project_id))
          throw new BrainError("INVALID_INPUT", "Goal project missing.");
        let data: Record<string, any>;
        if (e.kind === "goal") {
          data = z
            .object({
              title: z.string().max(200),
              success_criteria: z.string().max(2000),
              plan: z.string().max(20000).default(""),
              plan_version: z.number().int().nonnegative().default(0),
              plan_evidence: z.array(evidenceSchema).max(30).default([]),
              status: z.enum(["active", "paused", "done"]).default("active"),
            })
            .parse(e.data);
          data = {
            ...data,
            preparation_enabled: false,
            signatures: [],
            imported: true,
          };
          data.plan_private = data.plan_evidence.length
            ? data.plan_evidence.some((ref: Evidence) => {
                try {
                  return this.source(p, ref.source_id).visibility === "private";
                } catch {
                  return true;
                }
              })
            : !!data.plan;
          try {
            this.checkEvidence(p, e.project_id, data.plan_evidence);
          } catch {
            data.plan_stale = true;
          }
        } else if (e.kind === "brief") {
          const content = outputSchema.parse({
            items: e.data.items,
            unknowns: e.data.unknowns,
          });
          for (const item of content.items) {
            if (item.epistemic_status === "supported" && !item.evidence.length)
              throw new BrainError(
                "INVALID_INPUT",
                "Imported factual understanding needs evidence.",
              );
            this.checkEvidence(p, e.project_id, item.evidence);
          }
          const privateRefs = content.items.some(
            (item) =>
              !item.evidence.length ||
              item.evidence.some(
                (ref) => this.source(p, ref.source_id).visibility === "private",
              ),
          );
          data = {
            title: z.string().max(200).parse(e.data.title),
            ...content,
            status: "stale",
            mode: "Imported understanding",
            visibility: privateRefs ? "private" : "project",
            imported: true,
          };
        } else if (e.kind === "proposal") {
          data = z
            .object({
              goal_id: z.string().max(100),
              base_version: z.number().int().nonnegative(),
              title: z.string().max(200),
              reason: z.string().max(2000),
              artifact: z.string().max(20000),
              evidence: z.array(evidenceSchema).max(30),
              status: z.enum([
                "ready",
                "snoozed",
                "invalidated",
                "accepted",
                "dismissed",
                "reverted",
              ]),
            })
            .parse(e.data);
          data = {
            ...data,
            status: ["ready", "snoozed"].includes(data.status)
              ? "invalidated"
              : data.status,
            imported: true,
          };
        } else {
          data = {
            outcome: "imported_history",
            reason:
              "Historical receipt retained from a reviewed export; it cannot undo a local change.",
            historical_outcome: z.string().max(100).parse(e.data.outcome),
            evidence: z
              .array(evidenceSchema)
              .max(100)
              .parse(e.data.evidence ?? []),
            imported: true,
          };
        }
        this.createEntity(e.project_id, e.kind, data, e.id);
        this.store.run(
          "UPDATE entities SET version=?,created_at=? WHERE id=?",
          e.version,
          e.created_at,
          e.id,
        );
        this.store.run("DELETE FROM entity_versions WHERE entity_id=?", e.id);
        this.store.run(
          "INSERT INTO entity_versions VALUES(?,?,?,?)",
          e.id,
          e.version,
          JSON.stringify(data),
          e.created_at,
        );
        this.store.set(`import_digest:${e.id}`, digest);
      }
      this.store.run("DELETE FROM source_fts");
      for (const s of this.sources(p))
        this.store.run(
          "INSERT INTO source_fts VALUES(?,?,?)",
          s.id,
          s.title,
          s.body,
        );
      for (const pr of m.payload.projects) {
        this.invalidate(pr.id);
        this.enqueue(pr.id, "derive_brief", { principal: p });
      }
      this.store.run("DELETE FROM imports WHERE id=?", id);
      return { imported: true };
    });
  }
  status(p: Principal) {
    this.owner(p);
    const beat = this.store.setting<string | null>("worker_heartbeat", null);
    const prefs = this.prefs(p);
    const day = localSchedule(this.clock(), prefs).day;
    const spend = this.store.get(
      "SELECT coalesce(sum(CASE WHEN status='held' THEN reserved ELSE 0 END),0) AS reserved,coalesce(sum(actual),0) AS actual FROM reservations WHERE day=?",
      day,
    );
    return {
      worker_online:
        !!beat && this.clock().getTime() - Date.parse(beat) < 15000,
      worker_last_seen: beat,
      provider_configured: !!process.env.OPENAI_API_KEY,
      mode: prefs.provider_enabled
        ? "Connected model requested"
        : "Extractive preview",
      spend,
      jobs: this.store.all(
        "SELECT id,kind,status,error,project_id FROM jobs ORDER BY created_at DESC LIMIT 20",
      ),
    };
  }
  job(p: Principal, id: string) {
    const j = this.store.get("SELECT * FROM jobs WHERE id=?", id);
    if (!j) throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    this.access(p, j.project_id);
    if (p.kind === "agent") {
      const payload = JSON.parse(j.payload);
      if (payload.principal?.grant_id !== p.grant_id)
        throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    }
    return {
      id: j.id,
      status: j.status,
      error: j.error,
      result_id: j.result_id,
    };
  }
  jobAction(p: Principal, id: string, action: "cancel" | "retry") {
    this.owner(p);
    this.job(p, id);
    if (action === "cancel")
      this.store.run(
        "UPDATE jobs SET status='cancelled',fence=fence+1 WHERE id=? AND status IN ('queued','running','retry_wait')",
        id,
      );
    else
      this.store.run(
        "UPDATE jobs SET status='queued',attempts=0,next_at=?,fence=fence+1,error=NULL,deadline_at=NULL WHERE id=? AND status IN ('failed','cancelled')",
        this.now(),
        id,
      );
    return this.job(p, id);
  }
  verify(p: Principal) {
    if (p.kind !== "agent")
      throw new BrainError("FORBIDDEN", "Use an agent token.", 403);
    this.grant(p);
    this.store.run(
      "UPDATE grants SET last_verified_at=? WHERE id=?",
      this.now(),
      p.grant_id,
    );
    return { verified_at: this.now() };
  }
  evidenceSignature(sources: Source[]) {
    return hash(
      sources
        .map((s) => `${s.id}:${s.version}`)
        .sort()
        .join("|"),
    );
  }
  activeEvidence(p: Principal, project: string) {
    return this.sources(p, project).slice(0, 20).map(excerpt);
  }
}
