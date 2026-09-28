import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { detectSecrets } from "../storage/secrets.ts";
import { parseImport } from "../importers/local.ts";
import {
  proposeSchema,
  classify,
  overlaps,
  policyVersion,
  classifierVersion,
  type GateResult,
} from "./claims.ts";
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
  previewLocalImport(p: Principal, input: unknown) {
    this.owner(p);
    const preview = parseImport(input);
    this.access(p, preview.project_id);
    return preview;
  }
  applyLocalImport(p: Principal, input: unknown, checkpoint: string) {
    const preview = this.previewLocalImport(p, input);
    if (
      preview.checkpoint !==
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(checkpoint)
    )
      throw new BrainError(
        "VERSION_CONFLICT",
        "Selected import changed. Preview it again.",
        409,
      );
    const results = preview.items.map((item) => ({
      path: item.path,
      ...this.capture(p, {
        project_id: preview.project_id,
        title: item.title,
        body: item.body,
      }),
    }));
    return {
      imported: results.filter((r: any) => !r.duplicate).length,
      duplicates: results.filter((r: any) => r.duplicate).length,
      results,
      warnings: preview.warnings,
    };
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
  capture(p: Principal, input: unknown, key?: string, fromGate = false) {
    if (p.kind === "agent" && !fromGate)
      throw new BrainError(
        "FORBIDDEN",
        "Agents propose through the evidence gate.",
        403,
      );
    this.captureLimit(input);
    const v = captureSchema.parse(input);
    this.access(
      p,
      v.project_id,
      p.kind === "agent" ? "propose_memory" : "read",
    );
    if (p.kind === "agent" && v.visibility === "private" && !fromGate)
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
        const scan = this.store.vault?.capture(
          id,
          1,
          v.body,
          detectSecrets(v.title).length > 0,
        );
        const quarantined =
          scan?.quarantined ||
          detectSecrets(v.body + "\n" + v.title).length > 0;
        if (quarantined) {
          if (!this.store.vault)
            throw new BrainError(
              "QUARANTINE_UNAVAILABLE",
              "Secret detection requires a protected local vault before capture.",
              503,
            );
          v.body =
            "[Quarantined: suspected secret. Original retained outside the vault.]";
          v.title = "Quarantined source";
          v.visibility = "private";
        }
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
        return {
          source_id: id,
          job,
          duplicate: false,
          quarantined,
          warning: quarantined
            ? "Suspected secret retained in protected quarantine; excluded from previews, agents and models."
            : undefined,
        };
      }),
    );
  }
  invalidate(project: string) {
    for (const row of this.store.all<Entity & { data: string }>(
      "SELECT * FROM entities WHERE project_id=? AND kind='claim'",
      project,
    )) {
      const data = JSON.parse(row.data);
      if (
        data.status === "current" &&
        data.evidence?.some((e: Evidence) => !this.evidenceCurrent(project, e))
      )
        this.revise(
          { ...row, data },
          {
            ...data,
            status: "retired",
            valid_to: this.now(),
            retirement_reason: "source_changed",
          },
        );
    }
    for (const row of this.store.all<Entity & { data: any }>(
      "SELECT * FROM entities WHERE project_id=? AND kind='goal'",
      project,
    )) {
      const data = JSON.parse(row.data);
      if (
        data.plan_evidence?.some(
          (e: Evidence) => !this.evidenceCurrent(project, e),
        )
      )
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
      else if (
        ["ready", "snoozed"].includes(data.status) &&
        data.evidence?.some((e: Evidence) => !this.evidenceCurrent(project, e))
      )
        data.status = "invalidated";
      this.store.run(
        "UPDATE entities SET data=? WHERE id=?",
        JSON.stringify(data),
        row.id,
      );
    }
  }
  evidenceCurrent(project: string, evidence: Evidence) {
    const source = this.store.get<Source>(
      "SELECT * FROM sources WHERE id=?",
      evidence.source_id,
    );
    return (
      source?.state === "active" &&
      source.project_id === project &&
      source.version === evidence.source_version
    );
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
      const scan = this.store.vault?.capture(
        id,
        version,
        v.body,
        detectSecrets(v.title).length > 0,
      );
      if (scan?.quarantined || detectSecrets(v.body + "\n" + v.title).length) {
        if (!this.store.vault)
          throw new BrainError(
            "QUARANTINE_UNAVAILABLE",
            "Protected vault required.",
            503,
          );
        v.body =
          "[Quarantined: suspected secret. Original retained outside the vault.]";
        v.title = "Quarantined source";
        v.visibility = "private";
      }
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
    const run = () => {
      const result = this.store.transaction(() => {
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
            "SELECT * FROM entities WHERE kind='goal'",
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
          for (const row of this.store.all<Entity & { data: any }>(
            "SELECT * FROM entities WHERE kind IN ('brief','proposal','receipt','claim','gate','intent','handoff','link','ping')",
          )) {
            const versions = this.store.all<{ data: string }>(
              "SELECT data FROM entity_versions WHERE entity_id=?",
              row.id,
            );
            // Purge dependencies in current data and retained revisions, including former projects.
            const depends = (value: unknown): boolean => {
              if (!value || typeof value !== "object") return false;
              if (
                (value as { source_id?: string }).source_id === id ||
                (value as { raw_id?: string }).raw_id === id
              )
                return true;
              return Object.values(value).some(depends);
            };
            if (
              row.project_id === s.project_id ||
              depends(JSON.parse(row.data)) ||
              versions.some((v) => depends(JSON.parse(v.data)))
            )
              this.store.run("DELETE FROM entities WHERE id=?", row.id);
          }
          this.store.run("DELETE FROM idempotency");
          this.store.run("DELETE FROM imports");
        }
        this.enqueue(s.project_id, "derive_brief", { principal: p });
        return { state: purge ? "deleted" : "withdrawn" };
      });
      if (!purge || !this.store.vault) return result;
      try {
        return { ...result, proof: this.finalizeForget(p, id) };
      } catch {
        throw new BrainError(
          "FORGET_INCOMPLETE",
          "Source left active use, but managed erasure needs retry with finalize-forget.",
          503,
        );
      }
    };
    try {
      return this.store.vault ? this.store.vault.withLock(run) : run();
    } catch (error) {
      if (
        purge &&
        this.store.vault &&
        this.store.get("SELECT state FROM sources WHERE id=?", id)?.state ===
          "deleted"
      ) {
        this.store.vault.markPendingForget(id);
        throw new BrainError(
          "FORGET_INCOMPLETE",
          "Source left active use, but managed erasure needs retry with finalize-forget.",
          503,
        );
      }
      throw error;
    }
  }
  finalizeForget(p: Principal, sourceId: string) {
    this.owner(p);
    const id = z.string().uuid().parse(sourceId);
    if (!this.store.vault)
      throw new BrainError(
        "FORGET_INCOMPLETE",
        "No managed vault is configured.",
        503,
      );
    const source = this.store.get("SELECT state FROM sources WHERE id=?", id);
    if (source?.state !== "deleted")
      throw new BrainError(
        "VERSION_CONFLICT",
        "Delete this source before finalizing erasure.",
        409,
      );
    return this.store.vault.withLock(() => {
      this.store.vault!.forget(id, this.store.portableState());
      this.store.sanitizeMigrationBackup();
      const files = this.store.vault!.verifyForget(id);
      const backup = this.store.verifyMigrationBackup(id);
      const originals = Number(
        this.store.get(
          "SELECT count(*) AS n FROM source_versions WHERE source_id=?",
          id,
        )?.n ?? 0,
      );
      const search = Number(
        this.store.get(
          "SELECT count(*) AS n FROM source_fts WHERE source_id=?",
          id,
        )?.n ?? 0,
      );
      const derived =
        Number(
          this.store.get(
            "SELECT count(*) AS n FROM entities WHERE data LIKE ?",
            `%${id}%`,
          )?.n ?? 0,
        ) +
        Number(
          this.store.get(
            "SELECT count(*) AS n FROM entity_versions WHERE data LIKE ?",
            `%${id}%`,
          )?.n ?? 0,
        );
      const indexGone =
        originals === 0 && search === 0 && derived === 0 && backup.absent;
      const embeddingStores = this.store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%embedding%'",
      );
      const edgeStores = this.store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%edge%'",
      );
      const proof = {
        operation_id: randomUUID(),
        verified_at: this.now(),
        deletion_generation: this.store.vault!.generation(),
        file_gone: files.file_gone,
        index_gone: indexGone,
        embedding_gone: embeddingStores.length === 0,
        graph_edge_gone: edgeStores.length === 0 && derived === 0,
        per_store: {
          ...files.evidence,
          sqlite_original_versions: originals,
          sqlite_search_rows: search,
          sqlite_derived_references: derived,
          migration_backup: backup,
          embeddings: {
            configured: embeddingStores.length > 0,
            active_artifacts: embeddingStores.length ? "unverified" : 0,
          },
          graph: {
            configured: edgeStores.length > 0,
            active_artifacts: edgeStores.length ? "unverified" : 0,
          },
          transmitted_copies:
            "Previously delivered client or provider copies cannot be recalled.",
          unmanaged_backups:
            "Not inspected; operator-managed backups require separate deletion.",
        },
      };
      this.store.set(`forget_proof:${proof.operation_id}`, proof);
      return proof;
    });
  }
  forgetProof(p: Principal, operationId: string) {
    this.owner(p);
    const id = z.string().uuid().parse(operationId);
    const proof = this.store.setting(`forget_proof:${id}`, null);
    if (!proof)
      throw new BrainError("NOT_FOUND", "Forget proof unavailable.", 404);
    return proof;
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
        due_at: z.iso.datetime().optional(),
        review_at: z.iso.datetime().optional(),
      })
      .strict()
      .parse(input);
    this.access(p, v.project_id);
    return this.store.transaction(() =>
      this.createEntity(v.project_id, "goal", {
        title: v.title,
        owner: "owner",
        goal: v.title,
        success_criteria: v.success_criteria,
        due_at: v.due_at,
        review_at: v.review_at,
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
        due_at: z.iso.datetime().optional(),
        review_at: z.iso.datetime().optional(),
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
        plan_private:
          v.plan !== undefined
            ? detectSecrets(v.plan).length > 0 ||
              (e.data.plan_evidence ?? []).some(
                (ref: Evidence) =>
                  this.source(p, ref.source_id).visibility === "private",
              )
            : e.data.plan_private,
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
    const reviewed = this.store.transaction(() =>
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
            plan_private:
              proposal.data.evidence.some(
                (ref: Evidence) =>
                  this.source(p, ref.source_id).visibility === "private",
              ) ||
              detectSecrets(v.edited_artifact ?? proposal.data.artifact)
                .length > 0,
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
    if (action === "accept" && this.store.vault && "receipt" in reviewed) {
      const setting = `accepted_vault_commit:${reviewed.receipt.id}`;
      if (!this.store.setting(setting, ""))
        this.store.set(setting, this.store.vault.git("rev-parse", "HEAD"));
    }
    return reviewed;
  }
  revertAcceptedVaultCommit(p: Principal, receiptId: string) {
    this.owner(p);
    const vault = this.store.vault;
    if (!vault)
      throw new BrainError("FORBIDDEN", "Managed vault required.", 403);
    return vault.withLock(() => {
      const receipt = this.entity(p, receiptId);
      if (
        receipt.kind !== "receipt" ||
        receipt.data.outcome !== "accepted" ||
        receipt.data.reverted
      )
        throw new BrainError(
          "VERSION_CONFLICT",
          "This acceptance is no longer revertible.",
          409,
        );
      const goal = this.entity(p, receipt.data.goal_id);
      requireVersion(goal.data.plan_version, receipt.data.applied_version);
      const commit = this.store.setting<string>(
        `accepted_vault_commit:${receipt.id}`,
        "",
      );
      if (
        !/^[a-f0-9]{40,64}$/.test(commit) ||
        vault.git("rev-parse", "HEAD") !== commit
      )
        throw new BrainError(
          "VERSION_CONFLICT",
          "Later vault edits exist. Compare them before reverting.",
          409,
        );
      let target: { sources: any[]; source_versions: any[] };
      try {
        const previous = JSON.parse(
          vault.git("show", `${commit}^:manifest.json`),
        );
        target = JSON.parse(vault.git("show", `${commit}^:${previous.state}`));
      } catch {
        throw new BrainError(
          "VERSION_CONFLICT",
          "Earlier vault generation is unavailable.",
          409,
        );
      }
      for (const source of this.store.all<{ id: string }>(
        "SELECT id FROM sources WHERE state='deleted'",
      ))
        if (
          target.sources.some(
            (item) => item.id === source.id && item.state !== "deleted",
          ) ||
          target.source_versions.some((item) => item.source_id === source.id)
        )
          throw new BrainError(
            "VERSION_CONFLICT",
            "An earlier generation would restore forgotten material.",
            409,
          );
      try {
        vault.git("revert", "--no-edit", commit);
      } catch {
        try {
          vault.git("revert", "--abort");
        } catch {}
        throw new BrainError(
          "VERSION_CONFLICT",
          "Vault revert conflicted; current work was preserved.",
          409,
        );
      }
      const revertCommit = vault.git("rev-parse", "HEAD");
      this.store.rebuild();
      const audit = this.store.transaction(() =>
        this.createEntity(receipt.project_id, "receipt", {
          outcome: "git_reverted",
          original_receipt_id: receipt.id,
          goal_id: goal.id,
          reverted_commit: commit,
          revert_commit: revertCommit,
          reason:
            "Owner reverted the latest accepted vault change. The projection was rebuilt.",
          evidence: [],
        }),
      );
      return {
        reverted: true,
        revert_commit: revertCommit,
        audit_id: audit.id,
      };
    });
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
        operations: z
          .array(z.enum(["read", "propose_memory", "forget"]))
          .min(1),
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
  propose(p: Principal, input: unknown, key?: string): GateResult {
    const v = proposeSchema.parse(input);
    const identityLike =
      v.type === "identity" ||
      ["name", "preference"].includes(v.field?.aspect ?? "") ||
      /^(me|myself|owner|user|identity)$/i.test(v.entity ?? "") ||
      /\b(my name|i am|i prefer|my preference)\b/i.test(v.text);
    this.access(
      p,
      v.project_id,
      p.kind === "agent" ? "propose_memory" : "read",
    );
    const who = p.kind === "owner" ? "owner" : p.grant_id;
    const fingerprint = hash(canonical(v));
    if (key) {
      const previous = this.store.get(
        "SELECT * FROM idempotency WHERE principal=? AND operation=? AND key=?",
        who,
        "gate",
        key,
      );
      if (previous) {
        if (previous.hash !== fingerprint)
          throw new BrainError(
            "IDEMPOTENCY_CONFLICT",
            "Retry key used with different proposal.",
            409,
          );
        return JSON.parse(previous.result);
      }
    }
    const classification = classify(v);
    const capture = this.capture(
      p,
      {
        project_id: v.project_id,
        title: v.title,
        body: v.text,
        visibility: identityLike ? "private" : "project",
      },
      key ? `propose:${key}` : undefined,
      true,
    ) as { source_id: string; quarantined?: boolean };
    const source = this.source({ kind: "owner" }, capture.source_id);
    const result = this.store.transaction(() => {
      const start = v.field
        ? Array.from(source.body).join("").indexOf(String(v.field.value))
        : -1;
      const evidence =
        start >= 0
          ? [
              {
                source_id: source.id,
                source_version: source.version,
                start: Array.from(source.body.slice(0, start)).length,
                end:
                  Array.from(source.body.slice(0, start)).length +
                  Array.from(String(v.field!.value)).length,
                quote: String(v.field!.value),
              },
            ]
          : [];
      if (evidence.length)
        this.checkEvidence(
          identityLike ? { kind: "owner" } : p,
          v.project_id,
          evidence,
        );
      const sensitive = capture.quarantined || identityLike;
      const conflicts = this.entities({ kind: "owner" }, "claim").filter(
        (c) =>
          c.project_id === v.project_id &&
          c.data.status === "current" &&
          c.data.entity === v.entity &&
          c.data.aspect === v.field?.aspect &&
          JSON.stringify(c.data.value) !== JSON.stringify(v.field?.value) &&
          overlaps(
            {
              valid_from: String(c.data.valid_from),
              valid_to: c.data.valid_to,
            },
            { valid_from: v.valid_from ?? this.now(), valid_to: v.valid_to },
          ),
      );
      const canCommit =
        v.type === "fact" &&
        classification.confidence >= 0.95 &&
        evidence.length > 0 &&
        !sensitive &&
        conflicts.length === 0 &&
        !!v.field &&
        !!v.entity;
      const reasons = [
        classification.reason,
        ...(sensitive ? ["sensitive_owner_review"] : []),
        ...(conflicts.length ? ["overlapping_conflict"] : []),
        ...(["decision", "identity"].includes(v.type)
          ? ["owner_review_required"]
          : []),
      ];
      const proposal = this.createEntity(v.project_id, "gate", {
        raw_id: source.id,
        type: v.type,
        entity: v.entity,
        field: v.field,
        evidence,
        status: canCommit ? "committed" : "queued",
        reasons,
        actor: p.kind === "owner" ? "owner" : `agent:${p.grant_id}`,
        policy_version: policyVersion,
        classifier_version: classifierVersion,
      });
      const claimIds: string[] = [];
      if (canCommit) {
        const claim = this.createEntity(v.project_id, "claim", {
          entity: v.entity,
          aspect: v.field!.aspect,
          value: v.field!.value,
          source_id: source.id,
          source_version: source.version,
          agent: p.kind === "owner" ? "owner" : `agent:${p.grant_id}`,
          ts: source.captured_at,
          valid_from: v.valid_from ?? this.now(),
          valid_to: v.valid_to,
          recorded_at: this.now(),
          status: "current",
          authority: p.kind === "owner" ? "owner_literal" : "agent_literal",
          evidence,
          supersedes: [],
          conflicts_with: [],
          proposal_id: proposal.id,
        });
        claimIds.push(claim.id);
      }
      return {
        proposal_id: proposal.id,
        raw_id: source.id,
        disposition: canCommit ? ("commit" as const) : ("queue" as const),
        type: v.type,
        confidence: classification.confidence,
        reason_codes: reasons,
        policy_version: policyVersion,
        classifier_version: classifierVersion,
        claim_ids: claimIds,
      };
    });
    if (key)
      this.store.run(
        "INSERT INTO idempotency VALUES(?,?,?,?,?)",
        who,
        "gate",
        key,
        fingerprint,
        JSON.stringify(result),
      );
    return result;
  }
  reviewGate(p: Principal, id: string, input: unknown) {
    this.owner(p);
    const v = z
      .object({
        action: z.enum(["accept", "reject"]),
        expected_version: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const gate = this.entity(p, id);
      if (gate.kind !== "gate")
        throw new BrainError("INVALID_INPUT", "Not a pending review.");
      requireVersion(gate.version, v.expected_version);
      if (gate.data.status !== "queued")
        throw new BrainError("VERSION_CONFLICT", "Already reviewed.", 409);
      const source = this.source(p, gate.data.raw_id);
      if (source.state !== "active")
        throw new BrainError(
          "SOURCE_STALE",
          "Original is no longer active.",
          409,
        );
      const claims: string[] = [];
      if (v.action === "accept" && gate.data.field && gate.data.entity) {
        this.checkEvidence(p, gate.project_id, gate.data.evidence);
        const field = gate.data.field;
        const claim = this.createEntity(gate.project_id, "claim", {
          entity: gate.data.entity,
          aspect: field.aspect,
          value: field.value,
          source_id: source.id,
          source_version: source.version,
          agent: gate.data.actor,
          ts: source.captured_at,
          valid_from: this.now(),
          recorded_at: this.now(),
          status: "current",
          authority: "owner_reviewed",
          evidence: gate.data.evidence,
          supersedes: [],
          conflicts_with: [],
          proposal_id: gate.id,
        });
        claims.push(claim.id);
      }
      this.revise(gate, {
        ...gate.data,
        status: v.action === "accept" ? "accepted" : "rejected",
        reviewed_at: this.now(),
        claim_ids: claims,
      });
      return { reviewed: true, claim_ids: claims };
    });
  }
  retireClaim(p: Principal, id: string, expected: number) {
    this.owner(p);
    return this.store.transaction(() => {
      const c = this.entity(p, id);
      if (c.kind !== "claim")
        throw new BrainError("INVALID_INPUT", "Not a claim.");
      requireVersion(c.version, expected);
      if (c.data.status !== "current")
        throw new BrainError("VERSION_CONFLICT", "Claim already retired.", 409);
      return this.revise(c, {
        ...c.data,
        status: "retired",
        valid_to: this.now(),
      });
    });
  }
  currentClaims(p: Principal, project: string, includeRetired = false) {
    this.access(p, project);
    return this.entities({ kind: "owner" }, "claim").filter(
      (c) =>
        c.project_id === project &&
        (includeRetired || c.data.status === "current") &&
        (!c.data.evidence?.length ||
          (() => {
            try {
              if (c.data.status === "current")
                this.checkEvidence(p, project, c.data.evidence);
              else
                for (const e of c.data.evidence as Evidence[]) {
                  const source = this.source(p, e.source_id, e.source_version);
                  if (
                    source.project_id !== project ||
                    Array.from(source.body).slice(e.start, e.end).join("") !==
                      e.quote
                  )
                    throw new Error("Historical evidence unavailable");
                }
              return true;
            } catch {
              return false;
            }
          })()) &&
        (p.kind === "owner" ||
          (c.data.aspect !== "name" &&
            c.data.aspect !== "preference" &&
            c.data.authority !== "owner_private")),
    );
  }
  pages(p: Principal, project: string, query = "", includeRetired = false) {
    this.access(p, project);
    query = z.string().max(200).parse(query).toLocaleLowerCase();
    const claims = this.currentClaims(p, project, includeRetired);
    const groups = new Map<string, Entity[]>();
    for (const c of claims) {
      if (
        query &&
        !`${c.data.entity} ${c.data.aspect} ${String(c.data.value)}`
          .toLocaleLowerCase()
          .includes(query)
      )
        continue;
      groups.set(c.data.entity, [...(groups.get(c.data.entity) ?? []), c]);
    }
    const queued =
      p.kind === "owner"
        ? this.entities(p, "gate").filter(
            (g) => g.project_id === project && g.data.status === "queued",
          )
        : [];
    return [...groups].map(([entity, entries]) => {
      const conflicts = entries.filter((a, i) =>
        entries.some(
          (b, j) =>
            i !== j &&
            a.data.aspect === b.data.aspect &&
            JSON.stringify(a.data.value) !== JSON.stringify(b.data.value) &&
            overlaps(
              {
                valid_from: String(a.data.valid_from),
                valid_to: a.data.valid_to,
              },
              {
                valid_from: String(b.data.valid_from),
                valid_to: b.data.valid_to,
              },
            ),
        ),
      );
      return {
        entity,
        project_id: project,
        current: entries.filter((c) => c.data.status === "current"),
        history: includeRetired
          ? entries.filter((c) => c.data.status !== "current")
          : [],
        conflicts,
        uncertain: queued.filter((g) => g.data.entity === entity),
        open_intents: this.entities({ kind: "owner" }, "goal")
          .filter(
            (g) =>
              g.project_id === project &&
              g.data.status === "active" &&
              g.data.title
                .toLocaleLowerCase()
                .includes(entity.toLocaleLowerCase()),
          )
          .map((g) => ({ id: g.id, title: g.data.title })),
      };
    });
  }
  agentCapabilities(p: Principal) {
    const grant = this.grant(p);
    const operations = grant?.operations ?? [
      "read",
      "propose_memory",
      "forget",
    ];
    return {
      operations,
      tools: [
        "brain.search",
        "brain.get",
        "brain.ask",
        "brain.diff",
        ...(operations.includes("propose_memory")
          ? ["brain.propose", "brain.link", "brain.intent"]
          : []),
        ...(operations.includes("forget") ? ["brain.forget"] : []),
      ],
    };
  }
  handoff(p: Principal, project: string) {
    this.owner(p);
    this.access(p, project);
    const identityAllowlist = this.store.setting<string[]>(
      `identity_allowlist:${project}`,
      [],
    );
    const claims = this.currentClaims(p, project)
      .filter((c) => {
        const identity = ["name", "preference"].includes(c.data.aspect);
        return identity
          ? identityAllowlist.includes(c.id)
          : (c.data.evidence ?? []).every(
              (e: Evidence) =>
                this.source(p, e.source_id).visibility === "project",
            );
      })
      .slice(0, 12);
    const goals = this.entities(p, "goal")
      .filter(
        (g) =>
          g.project_id === project &&
          g.data.status === "active" &&
          !g.data.plan_private,
      )
      .slice(0, 8);
    const refs = claims
      .filter((c) => !["name", "preference"].includes(c.data.aspect))
      .flatMap((c) => c.data.evidence ?? []);
    const disclosedIdentityIds = claims
      .filter((c) => ["name", "preference"].includes(c.data.aspect))
      .map((c) => c.id);
    const summary = [
      "# Continue this project",
      "",
      "## Current accepted understanding",
      ...claims.map(
        (c) =>
          `- ${c.data.entity} — ${c.data.aspect}: ${String(c.data.value)} (claim ${c.id})`,
      ),
      "",
      "## Open intentions",
      ...goals.map(
        (g) =>
          `- ${g.data.title}: ${g.data.plan || "No accepted next step yet."}`,
      ),
      "",
      "## Done and blocked",
      "No agent-reported completion is inferred from saved material.",
      "",
      "## Source references",
      ...refs.map((e: Evidence) => `- ${e.source_id} v${e.source_version}`),
      "",
      "## Next action",
      goals[0]?.data.plan ||
        "Review the current evidence and choose a next step.",
    ].join("\n");
    return this.store.transaction(() => {
      for (const previous of this.entities(p, "handoff").filter(
        (h) => h.project_id === project && h.data.status === "current",
      ))
        this.revise(previous, { ...previous.data, status: "retired" });
      return this.createEntity(project, "handoff", {
        title: "Current handoff",
        text: summary,
        evidence: refs,
        goals: goals.map((g) => g.id),
        observed_claim_ids: claims.map((c) => c.id),
        disclosed_identity_ids: disclosedIdentityIds,
        agent_reports: [],
        status: "current",
        created_at: this.now(),
      });
    });
  }
  identityDisclosure(p: Principal, project: string, selected?: string[]) {
    this.owner(p);
    this.access(p, project);
    const claims = this.currentClaims(p, project).filter((c) =>
      ["name", "preference"].includes(c.data.aspect),
    );
    if (selected !== undefined) {
      const ids = z.array(z.string().max(100)).max(30).parse(selected);
      if (ids.some((id) => !claims.some((c) => c.id === id)))
        throw new BrainError(
          "INVALID_INPUT",
          "Choose only current identity fields in this project.",
        );
      const prior = this.store.setting<string[]>(
        `identity_allowlist:${project}`,
        [],
      );
      const removed = prior.filter((id) => !ids.includes(id));
      const apply = () => {
        this.store.transaction(() => {
          this.store.set(`identity_allowlist:${project}`, [...new Set(ids)]);
          this.store.set(
            `identity_policy_version:${project}`,
            this.store.setting<number>(
              `identity_policy_version:${project}`,
              0,
            ) + 1,
          );
          for (const handoff of this.entities(p, "handoff").filter(
            (h) => h.project_id === project,
          )) {
            const disclosed = handoff.data.disclosed_identity_ids ?? [];
            if (disclosed.some((id: string) => removed.includes(id)))
              this.store.run("DELETE FROM entities WHERE id=?", handoff.id);
            else if (handoff.data.status === "current")
              this.revise(handoff, { ...handoff.data, status: "retired" });
          }
        });
        if (removed.length && this.store.vault)
          this.store.vault.sanitizeManagedHistory(this.store.portableState());
      };
      if (this.store.vault) this.store.vault.withLock(apply);
      else apply();
    }
    return {
      claims: claims.map((c) => ({
        id: c.id,
        aspect: c.data.aspect,
        value: c.data.value,
      })),
      selected: this.store.setting<string[]>(
        `identity_allowlist:${project}`,
        [],
      ),
      policy_version: this.store.setting<number>(
        `identity_policy_version:${project}`,
        0,
      ),
    };
  }
  agentSearch(
    p: Principal,
    project: string,
    query: string,
    mode: "current" | "historical" | "raw" = "current",
    offset = 0,
    limit = 20,
  ) {
    this.access(p, project);
    query = z.string().max(200).parse(query);
    offset = z.number().int().min(0).max(1000000).parse(offset);
    limit = z.number().int().min(1).max(50).parse(limit);
    if (mode === "raw")
      return {
        mode,
        items: this.sources(p, project, query)
          .slice(offset, offset + limit)
          .map((s) => ({
            id: s.id,
            title: s.title,
            excerpt: excerpt(s).quote,
            source_version: s.version,
          })),
        next_offset: offset + limit,
      };
    return {
      mode,
      items: this.pages(p, project, query, mode === "historical").slice(
        offset,
        offset + limit,
      ),
      next_offset: offset + limit,
    };
  }
  agentGet(p: Principal, project: string, id: string, version?: number) {
    this.access(p, project);
    try {
      const s = this.source(p, id, version);
      if (s.project_id !== project) throw new Error();
      return { kind: "source", item: s };
    } catch {}
    const e = this.store.get<Entity & { data: string }>(
      "SELECT * FROM entities WHERE id=?",
      id,
    );
    if (!e || e.project_id !== project)
      throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    if (e.kind === "claim") {
      if (version && version !== e.version) {
        const historical = this.store.get<{ data: string }>(
          "SELECT data FROM entity_versions WHERE entity_id=? AND version=?",
          id,
          version,
        );
        if (!historical)
          throw new BrainError("NOT_FOUND", "Revision unavailable.", 404);
        const data = JSON.parse(historical.data);
        if (p.kind === "agent" && ["name", "preference"].includes(data.aspect))
          throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
        for (const ref of data.evidence ?? []) {
          const source = this.source(p, ref.source_id, ref.source_version);
          if (
            source.project_id !== project ||
            Array.from(source.body).slice(ref.start, ref.end).join("") !==
              ref.quote
          )
            throw new BrainError(
              "NOT_FOUND",
              "Historical evidence unavailable.",
              404,
            );
        }
        return { kind: "claim", item: { ...e, version, data } };
      }
      const claim = this.currentClaims(p, project, !!version).find(
        (c) => c.id === id,
      );
      if (!claim) throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
      return { kind: "claim", item: claim };
    }
    if (e.kind === "brief") return { kind: "brief", item: this.entity(p, id) };
    if (e.kind === "goal") {
      const data = JSON.parse(e.data);
      if (p.kind === "agent" && data.plan_private)
        throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
      return {
        kind: "intent",
        item: {
          id: e.id,
          project_id: project,
          version: e.version,
          title: data.title,
          status: data.status,
          next_step: data.plan || "",
          due_at: data.due_at,
          review_at: data.review_at,
        },
      };
    }
    if (e.kind === "handoff") {
      const handoff = { ...e, data: JSON.parse(e.data) };
      if (handoff.data.status !== "current")
        throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
      if (p.kind === "agent") {
        const allowlist = this.store.setting<string[]>(
          `identity_allowlist:${project}`,
          [],
        );
        if (
          (handoff.data.disclosed_identity_ids ?? []).some(
            (claimId: string) => !allowlist.includes(claimId),
          )
        )
          throw new BrainError(
            "NOT_FOUND",
            "Handoff changed; ask for a new preview.",
            404,
          );
      }
      this.checkEvidence(p, project, handoff.data.evidence ?? []);
      return { kind: "handoff", item: handoff };
    }
    if (p.kind === "owner" && ["receipt", "gate", "link"].includes(e.kind))
      return { kind: e.kind, item: this.entity(p, id) };
    throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
  }
  agentAsk(p: Principal, project: string, question: string) {
    this.access(p, project);
    question = z.string().trim().min(1).max(500).parse(question);
    const tokens = question
      .toLocaleLowerCase()
      .split(/\W+/)
      .filter((t) => t.length >= 3);
    const hits = this.currentClaims(p, project)
      .filter((c) =>
        tokens.some((t) =>
          `${c.data.entity} ${c.data.aspect}`.toLocaleLowerCase().includes(t),
        ),
      )
      .slice(0, 5);
    if (!hits.length)
      return {
        answer: "I don't have accepted evidence for that in this project.",
        abstained: true,
        claims: [],
        uncertainty:
          "No current accepted claim matched; ask the owner or search raw separately.",
      };
    return {
      answer: hits
        .map(
          (c) => `${c.data.entity} — ${c.data.aspect}: ${String(c.data.value)}`,
        )
        .join("\n"),
      abstained: false,
      claims: hits.map((c) => ({ id: c.id, evidence: c.data.evidence })),
      uncertainty:
        "Literal evidence and owner reviews are not independent truth verification.",
    };
  }
  agentDiff(
    p: Principal,
    project: string,
    id: string,
    fromVersion: number,
    toVersion: number,
  ) {
    this.access(p, project);
    const before = this.agentGet(p, project, id, fromVersion);
    const after = this.agentGet(p, project, id, toVersion);
    return {
      id,
      from_version: fromVersion,
      to_version: toVersion,
      before,
      after,
      changed: JSON.stringify(before) !== JSON.stringify(after),
    };
  }
  agentForget(p: Principal, project: string, id: string, expected: number) {
    const grant = this.grant(p);
    if (p.kind !== "agent" || !grant?.operations.includes("forget"))
      throw new BrainError(
        "FORBIDDEN",
        "Dedicated deletion access required.",
        403,
      );
    const source = this.source(p, id);
    if (
      source.project_id !== project ||
      source.origin !== `agent:${p.grant_id}`
    )
      throw new BrainError(
        "FORBIDDEN",
        "This grant may delete only its own captures.",
        403,
      );
    return this.removeSource({ kind: "owner" }, id, expected, true);
  }
  agentLink(p: Principal, input: unknown) {
    const v = z
      .object({
        project_id: z.string().max(100),
        from_id: z.string().max(100),
        to_id: z.string().max(100),
        relation: z.enum(["supports", "blocks", "supersedes", "related"]),
        from_version: z.number().int().positive(),
        to_version: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    this.access(
      p,
      v.project_id,
      p.kind === "agent" ? "propose_memory" : "read",
    );
    const from = this.agentGet(p, v.project_id, v.from_id),
      to = this.agentGet(p, v.project_id, v.to_id);
    requireVersion(from.item.version, v.from_version);
    requireVersion(to.item.version, v.to_version);
    return this.store.transaction(() =>
      this.createEntity(v.project_id, "gate", {
        status: "queued",
        type: "link",
        from_id: v.from_id,
        to_id: v.to_id,
        relation: v.relation,
        expected_versions: [v.from_version, v.to_version],
        evidence: [],
        reasons: ["owner_review_required"],
        actor: p.kind === "owner" ? "owner" : `agent:${p.grant_id}`,
      }),
    );
  }
  agentIntent(
    p: Principal,
    project: string,
    action: "list" | "get" | "propose" | "update" | "close",
    input: any,
  ) {
    this.access(
      p,
      project,
      action === "list" || action === "get"
        ? "read"
        : p.kind === "agent"
          ? "propose_memory"
          : "read",
    );
    if (action === "list")
      return this.entities({ kind: "owner" }, "goal")
        .filter(
          (g) =>
            g.project_id === project &&
            g.data.status === "active" &&
            (p.kind === "owner" || !g.data.plan_private),
        )
        .map((g) => ({
          id: g.id,
          title: g.data.title,
          status: g.data.status,
          version: g.version,
        }));
    if (action === "get")
      return this.agentGet(p, project, z.string().max(100).parse(input.id));
    if (p.kind === "agent")
      return this.propose(p, {
        project_id: project,
        title: "Proposed intention",
        text: z.string().min(1).max(2000).parse(input.text),
        type: "intent",
      });
    if (action === "propose")
      return this.propose(p, {
        project_id: project,
        title: "Proposed intention",
        text: z.string().min(1).max(2000).parse(input.text),
        type: "intent",
      });
    const goal = this.entity(p, z.string().max(100).parse(input.id));
    if (goal.kind !== "goal" || goal.project_id !== project)
      throw new BrainError("NOT_FOUND", "Intent unavailable.", 404);
    return this.editGoal(p, goal.id, {
      expected_version: z
        .number()
        .int()
        .positive()
        .parse(input.expected_version),
      ...(action === "close"
        ? { status: "done" }
        : { plan: z.string().max(20000).parse(input.text) }),
    });
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
