import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { dispatchPrepared, type DispatchDeps } from "../../apps/worker/dispatch.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import type { JobLease } from "../../packages/domain/spend.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { fakePreparedProvider } from "../helpers/prepared-provider.ts";

const owner = { kind: "owner" } as const;
let current = "2026-10-16T09:00:00Z";
const clock = () => new Date(current);
const dirs: string[] = [];
const stores: Storage[] = [];

afterEach(() => {
  current = "2026-10-16T09:00:00Z";
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bibrain-dispatch-"));
  dirs.push(dir);
  const path = join(dir, "brain.sqlite");
  const store = new Storage(path);
  stores.push(store);
  const b = new Brain(store, clock);
  b.prefs(owner, {
    ...b.prefs(owner),
    provider_enabled: true,
    daily_cap_micro_usd: 100000,
    per_job_cap_micro_usd: 10000,
  });
  b.capture(owner, {
    project_id: "inbox",
    title: "note",
    body: "SYNTHETIC dispatch integration note with two useful passages.",
  });
  const jobId = store.get<{ id: string }>(
    "SELECT id FROM jobs WHERE kind='derive_brief' ORDER BY created_at DESC LIMIT 1",
  )!.id;
  return { dir, path, store, b, jobId };
}

const dispatches = (s: Storage) =>
  s.all<{ call_id: string; state: string; actual_micro_usd: number | null; reserved_micro_usd: number }>(
    "SELECT call_id,state,actual_micro_usd,reserved_micro_usd FROM provider_dispatches ORDER BY created_at",
  );

const failedReceipt = (b: Brain) =>
  b.entities(owner, "receipt").find((r) => r.data.outcome === "failed");

const limitsFor = (b: Brain) => {
  const p = b.prefs(owner);
  return {
    per_job_micro_usd: p.per_job_cap_micro_usd,
    daily_micro_usd: p.daily_cap_micro_usd,
    time_zone: p.time_zone,
  };
};

describe("worker paid dispatch integration", () => {
  it("settles known cost and publishes once", async () => {
    const { store, b } = setup();
    const provider = fakePreparedProvider();
    expect(await new Worker(b, provider).tick()).toBe(true);

    const rows = dispatches(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("settled");
    expect(rows[0]!.actual_micro_usd).toBe(10);
    expect(provider.calls).toBe(1);

    const brief = b.entities(owner, "brief")[0]!;
    expect(JSON.stringify(brief.data)).toContain("SYNTHETIC dispatch integration");

    const receipt = b
      .entities(owner, "receipt")
      .find((r) => r.data.outcome === "changed")!;
    expect(receipt.data.call_id).toBe(rows[0]!.call_id);
    expect(receipt.data.usage_status).toBe("settled");
    expect(receipt.data.cost_micro_usd).toBe(10);
  });

  it("retains a known cost when output evidence is invalid and publishes nothing", async () => {
    const { store, b } = setup();
    const provider = fakePreparedProvider({
      result: () => ({
        accounting: {
          state: "known",
          cost_micro_usd: 7,
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "test-model",
        },
        output: {
          ok: true,
          kind: "brief",
          items: [
            {
              text: "Invented",
              epistemic_status: "supported",
              evidence: [
                { source_id: "invented", source_version: 1, start: 0, end: 1, quote: "x" },
              ],
            },
          ],
          unknowns: [],
        },
      }),
    });
    expect(await new Worker(b, provider).tick()).toBe(true);

    expect(b.entities(owner, "brief")).toEqual([]);
    expect(b.status(owner).jobs[0]!.status).toBe("failed");
    expect(dispatches(store)[0]!.state).toBe("settled");
    expect(dispatches(store)[0]!.actual_micro_usd).toBe(7);
    const receipt = failedReceipt(b)!;
    expect(receipt.data.call_id).toBe(dispatches(store)[0]!.call_id);
    expect(receipt.data.usage_status).toBe("settled");
    expect(receipt.data.cost_micro_usd).toBe(7);
  });

  const unknownProvider = () =>
    fakePreparedProvider({
      result: () => ({
        accounting: { state: "unknown", usage: { input_tokens: 3, output_tokens: 2 } },
        output: { ok: false, code: "PROVIDER_UNAVAILABLE", reason: "unavailable" },
      }),
    });

  it("holds unknown usage conservatively and never records a zero cost", async () => {
    const { store, b } = setup();
    const provider = unknownProvider();
    expect(await new Worker(b, provider).tick()).toBe(true);

    const rows = dispatches(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("dispatched");
    expect(rows[0]!.actual_micro_usd).toBeNull();
    const receipt = failedReceipt(b)!;
    expect(receipt.data.usage_status).toBe("unknown");
    expect(receipt.data.cost_micro_usd).toBeNull();
    expect(receipt.data.call_id).toBe(rows[0]!.call_id);
    expect(provider.calls).toBe(1);
    expect(b.entities(owner, "brief")).toEqual([]);
  });

  it("survives a restart and never resends an existing hold across an explicit retry", async () => {
    const { path, store, b, jobId } = setup();
    const provider = unknownProvider();
    expect(await new Worker(b, provider).tick()).toBe(true);
    const callId = dispatches(store)[0]!.call_id;
    const limits = limitsFor(b);
    store.close();

    const reopened = new Storage(path);
    try {
      expect(
        new DispatchLedger(reopened, clock).summary(limits).unresolved_micro_usd,
      ).toBe(dispatches(reopened)[0]!.reserved_micro_usd);

      const b2 = new Brain(reopened, clock);
      b2.jobAction(owner, jobId, "retry");
      expect(await new Worker(b2, provider).tick()).toBe(true);
      expect(provider.calls).toBe(1);
      expect(dispatches(reopened)).toHaveLength(1);
      expect(dispatches(reopened)[0]!.call_id).toBe(callId);
      const receipt = failedReceipt(b2)!;
      expect(receipt.data.call_id).toBe(callId);
      expect(receipt.data.usage_status).toBe("unknown");
      expect(receipt.data.cost_micro_usd).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it("rejects a changed request without resending and keeps the existing unknown call", async () => {
    const { store, b, jobId } = setup();
    const provider = unknownProvider();
    expect(await new Worker(b, provider).tick()).toBe(true);
    const callId = dispatches(store)[0]!.call_id;

    // A later capture changes the source signature and therefore the request hash.
    b.capture(owner, {
      project_id: "inbox",
      title: "second",
      body: "SYNTHETIC second passage that changes the request content.",
    });
    b.jobAction(owner, jobId, "retry");
    expect(await new Worker(b, provider).tick()).toBe(true);

    expect(provider.calls).toBe(1);
    const rows = dispatches(store);
    const forJob = rows.filter((r) => r.call_id === callId);
    expect(forJob).toHaveLength(1);
    const receipt = failedReceipt(b)!;
    expect(receipt.data.call_id).toBe(callId);
    expect(receipt.data.usage_status).toBe("unknown");
  });

  it("blocks a new paid dispatch when a legacy reservation exists", async () => {
    const { store, b, jobId } = setup();
    store.run(
      "INSERT INTO reservations VALUES(?,?,?,?,?)",
      jobId,
      "2026-10-16",
      5,
      0,
      "held",
    );
    const provider = fakePreparedProvider();
    expect(await new Worker(b, provider).tick()).toBe(true);

    expect(provider.calls).toBe(0);
    expect(dispatches(store)).toHaveLength(0);
    expect(b.status(owner).jobs[0]!.status).toBe("failed");
    expect(failedReceipt(b)!.data.reason).toContain("legacy");
    expect(
      store.get<{ status: string }>("SELECT status FROM reservations WHERE job_id=?", jobId)!
        .status,
    ).toBe("held");
  });

  it("settles an over-bound charge, blocks, and rejects publication even for ok output", async () => {
    const { store, b, jobId } = setup();
    const provider = fakePreparedProvider({
      reserved_micro_usd: 1,
      result: (request) => ({
        accounting: {
          state: "known",
          cost_micro_usd: 999999,
          usage: { input_tokens: 10, output_tokens: 10 },
          model: "test-model",
        },
        output:
          request.kind === "brief"
            ? {
                ok: true,
                kind: "brief",
                items: [
                  {
                    text: "ok",
                    epistemic_status: "supported",
                    evidence: [
                      {
                        source_id: request.sources[0]!.id,
                        source_version: 1,
                        start: 0,
                        end: 9,
                        quote: request.sources[0]!.body.slice(0, 9),
                      },
                    ],
                  },
                ],
                unknowns: [],
              }
            : { ok: true, kind: "goal", outcome: "abstain", artifact: "", evidence: [] },
      }),
    });
    expect(await new Worker(b, provider).tick()).toBe(true);
    expect(b.entities(owner, "brief")).toEqual([]);
    expect(dispatches(store)[0]!.state).toBe("settled");
    expect(dispatches(store)[0]!.actual_micro_usd).toBe(999999);
    expect(store.setting("paid_processing_blocked", null)).not.toBeNull();
    const receipt = failedReceipt(b)!;
    expect(receipt.data.usage_status).toBe("settled");
    expect(receipt.data.cost_micro_usd).toBe(999999);
    // The over-bound first job failed and its known charge is preserved.
    expect(b.status(owner).jobs.some((job) => job.status === "failed")).toBe(true);

    // While the durable block stands, paid processing stays unavailable, so a
    // later note is served extractively: no new provider call, no new
    // dispatch, and the block is unchanged.
    const beforeCalls = provider.calls;
    const beforeDispatches = dispatches(store).length;
    b.capture(owner, { project_id: "inbox", title: "third", body: "SYNTHETIC third note for extractive." });
    expect(await new Worker(b, provider).tick()).toBe(true);
    expect(provider.calls).toBe(beforeCalls);
    expect(dispatches(store)).toHaveLength(beforeDispatches);
    expect(store.setting("paid_processing_blocked", null)).not.toBeNull();
    expect(
      b.entities(owner, "brief").some((r) => r.data.mode === "Extractive preview"),
    ).toBe(true);
    void jobId;
  });

  it("releases a reserved dispatch only when it was never sent", async () => {
    const { store, b } = setup();
    const provider = fakePreparedProvider();
    const worker = new Worker(b, provider);
    const j = worker.lease()!;
    const deps: DispatchDeps = {
      brain: b,
      ledger: new LocalDispatchAccounting(b.store, b.clock),
      provider,
      owner: b.ownerPrincipal(),
    };
    let calls = 0;
    const guard = () => {
      calls += 1;
      if (calls === 2)
        throw new BrainError("JOB_CANCELLED", "cancelled before dispatch", 409);
    };
    await expect(
      dispatchPrepared(
        deps,
        { kind: "brief", sources: b.sources(owner, j.project_id) },
        j as { id: string; fence: number },
        worker.id,
        guard,
        new AbortController().signal,
      ),
    ).rejects.toThrow("before dispatch");

    expect(provider.calls).toBe(0);
    const rows = dispatches(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("released");
    expect(rows[0]!.actual_micro_usd).toBeNull();
  });

  it("releases a reserved hold and never sends when cancelled before mark", async () => {
    const { store, b } = setup();
    const provider = fakePreparedProvider();
    const worker = new Worker(b, provider);
    const j = worker.lease()!;
    const controller = new AbortController();
    const deps: DispatchDeps = {
      brain: b,
      ledger: new LocalDispatchAccounting(b.store, b.clock),
      provider,
      owner: b.ownerPrincipal(),
    };
    let guardCalls = 0;
    const guard = () => {
      guardCalls += 1;
      // Aborts after reserve but before markDispatched.
      if (guardCalls === 1) controller.abort();
    };
    await expect(
      dispatchPrepared(
        deps,
        { kind: "brief", sources: b.sources(owner, j.project_id) },
        j as { id: string; fence: number },
        worker.id,
        guard,
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(provider.calls).toBe(0);
    const rows = dispatches(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("released");
    expect(rows[0]!.actual_micro_usd).toBeNull();
  });

  it("never reserves when the signal is already aborted", async () => {
    const { store, b } = setup();
    const provider = fakePreparedProvider();
    const worker = new Worker(b, provider);
    const j = worker.lease()!;
    const controller = new AbortController();
    controller.abort();
    const deps: DispatchDeps = {
      brain: b,
      ledger: new LocalDispatchAccounting(b.store, b.clock),
      provider,
      owner: b.ownerPrincipal(),
    };
    await expect(
      dispatchPrepared(
        deps,
        { kind: "brief", sources: b.sources(owner, j.project_id) },
        j as { id: string; fence: number },
        worker.id,
        () => {},
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(provider.calls).toBe(0);
    expect(dispatches(store)).toHaveLength(0);
  });

  it("keeps a settled charge but publishes nothing when the job is cancelled after execute", async () => {
    const { store, b, jobId } = setup();
    const provider = fakePreparedProvider({
      onExecute: () => {
        b.jobAction(owner, jobId, "cancel");
      },
    });
    expect(await new Worker(b, provider).tick()).toBe(true);
    expect(dispatches(store)[0]!.state).toBe("settled");
    expect(dispatches(store)[0]!.actual_micro_usd).toBe(10);
    expect(b.entities(owner, "brief")).toEqual([]);
    expect(provider.calls).toBe(1);
  });

  it("keeps a settled charge but publishes nothing when an agent grant is revoked after execute", async () => {
    const { store, b } = setup();
    const grant = b.createGrant(owner, {
      projects: ["inbox"],
      operations: ["propose_memory"],
      expires_at: new Date(clock().getTime() + 86400000).toISOString(),
    });
    const agent = b.authenticateAgent(grant.token);
    const agentJob = b.enqueue("inbox", "derive_brief", { principal: agent });
    // Leave only the agent-originated job leasable.
    store.run("UPDATE jobs SET status='cancelled' WHERE id<>?", agentJob.id);

    const provider = fakePreparedProvider({
      onExecute: () => {
        b.revoke(owner, grant.id);
      },
    });
    expect(await new Worker(b, provider).tick()).toBe(true);
    expect(dispatches(store)[0]!.state).toBe("settled");
    expect(dispatches(store)[0]!.actual_micro_usd).toBe(10);
    expect(b.entities(owner, "brief")).toEqual([]);
    expect(provider.calls).toBe(1);
  });

  it("performs the provider call outside any SQLite transaction", async () => {
    const { b } = setup();
    let ranOutsideTx = false;
    const provider = fakePreparedProvider({
      onExecute: () => {
        // A nested BEGIN IMMEDIATE would throw if the worker held a transaction.
        b.store.transaction(() => {});
        ranOutsideTx = true;
      },
    });
    expect(await new Worker(b, provider).tick()).toBe(true);
    expect(ranOutsideTx).toBe(true);
    expect(dispatches(b.store)[0]!.state).toBe("settled");
  });

  /**
   * The mark commits before the network call. A change to trusted state that
   * lands while the mark is committing must be re-checked afterwards; the marked
   * hold is never refunded and the call is never sent twice.
   */
  function markedRace() {
    const { store, b, jobId } = setup();
    const provider = fakePreparedProvider();
    const worker = new Worker(b, provider);
    const j = worker.lease()!;
    const controller = new AbortController();
    return { store, b, jobId, provider, worker, j, controller };
  }

  it("does not send when consent is withdrawn while the mark is committing", async () => {
    const { store, b, provider, worker, j, controller } = markedRace();
    class Mutating extends LocalDispatchAccounting {
      constructor() {
        super(b.store, b.clock);
      }
      markDispatched(callId: string, lease: JobLease) {
        const record = super.markDispatched(callId, lease);
        b.prefs(owner, { ...b.prefs(owner), provider_enabled: false });
        return record;
      }
    }
    const guard = () => {
      if (!b.prefs(owner).provider_enabled)
        throw new BrainError("JOB_CANCELLED", "consent withdrawn", 409);
    };
    await expect(
      dispatchPrepared(
        { brain: b, ledger: new Mutating(), provider, owner },
        { kind: "brief", sources: b.sources(owner, j.project_id) },
        j as { id: string; fence: number },
        worker.id,
        guard,
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(provider.calls).toBe(0);
    const rows = dispatches(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("dispatched");

    // A retry never resends: the committed mark is the sole permission and it is
    // not re-granted.
    await expect(
      dispatchPrepared(
        { brain: b, ledger: new LocalDispatchAccounting(b.store, b.clock), provider, owner },
        { kind: "brief", sources: b.sources(owner, j.project_id) },
        j as { id: string; fence: number },
        worker.id,
        () => {},
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(provider.calls).toBe(0);
    expect(dispatches(store)).toHaveLength(1);
  });

  it("does not send when the attempt is aborted while the mark is committing", async () => {
    const { store, b, provider, worker, j, controller } = markedRace();
    class Mutating extends LocalDispatchAccounting {
      constructor() {
        super(b.store, b.clock);
      }
      markDispatched(callId: string, lease: JobLease) {
        const record = super.markDispatched(callId, lease);
        controller.abort();
        return record;
      }
    }
    await expect(
      dispatchPrepared(
        { brain: b, ledger: new Mutating(), provider, owner },
        { kind: "brief", sources: b.sources(owner, j.project_id) },
        j as { id: string; fence: number },
        worker.id,
        () => {},
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(provider.calls).toBe(0);
    expect(dispatches(store)[0]!.state).toBe("dispatched");
  });

  it("does not send when sources change while the mark is committing", async () => {
    const { store, b, provider, worker, j, controller } = markedRace();
    const signature = b.evidenceSignature(b.sources(owner, j.project_id).slice(0, 20));
    class Mutating extends LocalDispatchAccounting {
      constructor() {
        super(b.store, b.clock);
      }
      markDispatched(callId: string, lease: JobLease) {
        const record = super.markDispatched(callId, lease);
        b.capture(owner, {
          project_id: j.project_id,
          title: "late",
          body: "SYNTHETIC_LATE_SOURCE_CHANGES_THE_SIGNATURE",
        });
        return record;
      }
    }
    const guard = () => {
      if (
        signature !==
        b.evidenceSignature(b.sources(owner, j.project_id).slice(0, 20))
      )
        throw new BrainError("SOURCE_STALE", "sources changed", 409);
    };
    await expect(
      dispatchPrepared(
        { brain: b, ledger: new Mutating(), provider, owner },
        { kind: "brief", sources: b.sources(owner, j.project_id) },
        j as { id: string; fence: number },
        worker.id,
        guard,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(provider.calls).toBe(0);
    expect(dispatches(store)[0]!.state).toBe("dispatched");
  });

  it("does not send when the user lowers a cap while the mark is committing", async () => {
    const { store, b, provider, worker, j, controller } = markedRace();
    class Mutating extends LocalDispatchAccounting {
      constructor() {
        super(b.store, b.clock);
      }
      markDispatched(callId: string, lease: JobLease) {
        const record = super.markDispatched(callId, lease);
        b.prefs(owner, { ...b.prefs(owner), per_job_cap_micro_usd: 1 });
        return record;
      }
    }
    await expect(
      dispatchPrepared(
        { brain: b, ledger: new Mutating(), provider, owner },
        { kind: "brief", sources: b.sources(owner, j.project_id) },
        j as { id: string; fence: number },
        worker.id,
        () => {},
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(provider.calls).toBe(0);
    expect(dispatches(store)[0]!.state).toBe("dispatched");
  });
});
