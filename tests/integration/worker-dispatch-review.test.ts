import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import type { JobLease } from "../../packages/domain/spend.ts";
import type { PreparedProvider, PreparedEnvelope } from "../../packages/providers/prepared.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const clock = () => new Date("2026-10-16T09:00:00Z");
function setup() {
  const store = new Storage(":memory:");
  const brain = new Brain(store, clock);
  const owner = brain.ownerPrincipal();
  brain.prefs(owner, { ...brain.prefs(owner), provider_enabled: true, per_job_cap_micro_usd: 1000, daily_cap_micro_usd: 1000 });
  const saved = brain.capture(owner, { title: "Synthetic", body: "SYNTHETIC dispatch review evidence" }) as { source_id: string; job: { id: string } };
  const capture = { source_id: saved.source_id, job: saved.job.id };
  return { store, brain, owner, capture };
}
function provider(run: () => PreparedEnvelope | Promise<PreparedEnvelope>): PreparedProvider {
  return { prepareCall(input) {
    return {
      identity: Object.freeze({ provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", prompt_version: "synthetic-v1",
        request_hash: sha(JSON.stringify(input)), config_hash: sha("synthetic-config"), reserved_micro_usd: 20 }),
      request_bytes: Buffer.byteLength(JSON.stringify(input)),
      async execute() { return run(); },
    };
  } };
}
const worker = (brain: Brain, p: PreparedProvider) => new Worker(brain, p as unknown as ConstructorParameters<typeof Worker>[1]);

it("settles known usage after cancellation without overwriting the terminal job or publishing output", async () => {
  const { store, brain, owner, capture } = setup();
  try {
    let sends = 0;
    const p = provider(() => {
      sends++;
      // Also proves provider execution runs outside a SQLite transaction.
      store.transaction(() => store.run("UPDATE jobs SET status='cancelled',fence=fence+1 WHERE id=?", capture.job));
      return {
        accounting: { state: "known", cost_micro_usd: 7, usage: { input_tokens: 3, output_tokens: 2 }, model: "synthetic" },
        output: { ok: true, kind: "brief", unknowns: [], items: [{ text: "An evidenced statement", epistemic_status: "supported",
          evidence: [{ source_id: capture.source_id, source_version: 1, start: 0, end: 9, quote: "SYNTHETIC" }] }] },
      };
    });
    await worker(brain, p).tick();
    expect(sends).toBe(1);
    expect(store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE job_id=?", capture.job)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    expect(store.get("SELECT status FROM jobs WHERE id=?", capture.job)?.status).toBe("cancelled");
    expect(brain.entities(owner, "brief")).toHaveLength(0);
    expect(brain.entities(owner, "receipt").filter((r) => r.data.job_id === capture.job)).toHaveLength(0);
  } finally { store.close(); }
});

it("keeps an unexpected post-dispatch failure held and its original accounting visible after retry", async () => {
  const { store, brain, owner, capture } = setup();
  try {
    let sends = 0;
    const p = provider(() => {
      sends++;
      throw new Error("SYNTHETIC_PROVIDER_BODY_DO_NOT_COPY");
    });
    await worker(brain, p).tick();
    const held = store.get("SELECT * FROM provider_dispatches WHERE job_id=?", capture.job);
    expect(held).toMatchObject({ state: "dispatched", actual_micro_usd: null, reserved_micro_usd: 20 });
    expect(store.get("SELECT status FROM jobs WHERE id=?", capture.job)?.status).toBe("failed");
    brain.jobAction(owner, capture.job, "retry");
    await worker(brain, p).tick();
    expect(sends).toBe(1);
    expect(store.all("SELECT call_id FROM provider_dispatches WHERE job_id=?", capture.job)).toHaveLength(1);
    const receipts = brain.entities(owner, "receipt").filter((r) => r.data.job_id === capture.job);
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) {
      expect(receipt.data).toMatchObject({ call_id: held!.call_id, usage_status: "unknown", cost_micro_usd: null });
      expect(JSON.stringify(receipt)).not.toContain("SYNTHETIC_PROVIDER_BODY_DO_NOT_COPY");
    }
    expect(brain.entities(owner, "brief")).toHaveLength(0);
  } finally { store.close(); }
});

it("does not publish an apparently valid brief as zero-cost when accounting is unknown", async () => {
  const { store, brain, owner, capture } = setup();
  try {
    const p = provider(() => ({
      accounting: { state: "unknown" },
      output: { ok: true, kind: "brief", items: [{ text: "A hypothesis", epistemic_status: "hypothesis", evidence: [] }], unknowns: [] },
    }));
    await worker(brain, p).tick();
    expect(brain.entities(owner, "brief")).toHaveLength(0);
    expect(store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE job_id=?", capture.job)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    const receipt = brain.entities(owner, "receipt").find((r) => r.data.job_id === capture.job);
    expect(receipt?.data).toMatchObject({ outcome: "failed", usage_status: "unknown", cost_micro_usd: null });
  } finally { store.close(); }
});

for (const phase of ["prepare", "execute"] as const) {
  it(`rejects a goal result when its plan changes during ${phase}, retaining any known charge`, async () => {
    const { store, brain, owner, capture } = setup();
    try {
      store.run("UPDATE jobs SET status='succeeded' WHERE id=?", capture.job);
      const goal = brain.goal(owner, { project_id: "inbox", title: "Synthetic goal", success_criteria: "Use evidence" });
      const enabled = brain.editGoal(owner, goal.id, { expected_version: goal.version, preparation_enabled: true });
      const job = brain.prepare(owner, goal.id);
      let sends = 0;
      const changePlan = () => brain.editGoal(owner, goal.id, { expected_version: enabled.version, plan: "A later human plan" });
      const base = provider(() => {
        sends++;
        if (phase === "execute") changePlan();
        return {
          accounting: { state: "known", cost_micro_usd: 7, usage: { input_tokens: 3, output_tokens: 2 }, model: "synthetic" },
          output: { ok: true, kind: "goal", outcome: "proposal", artifact: "A proposal based on the older plan",
            evidence: [{ source_id: capture.source_id, source_version: 1, start: 0, end: 9, quote: "SYNTHETIC" }] },
        };
      });
      const p: PreparedProvider = { prepareCall(input) {
        const call = base.prepareCall(input);
        if (phase === "prepare") changePlan();
        return call;
      } };
      await worker(brain, p).tick();
      expect(brain.entities(owner, "proposal")).toHaveLength(0);
      expect(brain.entity(owner, goal.id).data.plan).toBe("A later human plan");
      expect(store.get("SELECT status FROM jobs WHERE id=?", job.id)?.status).toBe("failed");
      expect(sends).toBe(phase === "execute" ? 1 : 0);
      if (phase === "execute") expect(store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE job_id=?", job.id)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    } finally { store.close(); }
  });
}

it.each(["held", "settled"])("reports existing legacy %s accounting instead of claiming no attempt", async (state) => {
  const { store, brain, owner, capture } = setup();
  try {
    const actual = state === "settled" ? 7 : 0;
    store.run("INSERT INTO reservations VALUES(?,?,?,?,?)", capture.job, "2026-10-16", 20, actual, state);
    let sends = 0;
    const p = provider(() => {
      sends++;
      return { accounting: { state: "unknown" }, output: { ok: false, code: "PROVIDER_UNAVAILABLE", reason: "Synthetic unavailable" } };
    });
    await worker(brain, p).tick();
    expect(sends).toBe(0);
    const receipt = brain.entities(owner, "receipt").find((r) => r.data.job_id === capture.job);
    expect(receipt?.data).toMatchObject({ usage_status: state === "settled" ? "settled" : "unknown", cost_micro_usd: state === "settled" ? 7 : null });
    expect(store.get("SELECT status,reserved,actual FROM reservations WHERE job_id=?", capture.job)).toMatchObject({ status: state, reserved: 20, actual });
  } finally { store.close(); }
});

it("rechecks consent after a dispatch-marker wait before any provider execution", async () => {
  const { store, brain, owner, capture } = setup();
  try {
    let sends = 0;
    class ConsentChangedWhileMarking extends LocalDispatchAccounting {
      override markDispatched(callId: string, lease: JobLease) {
        // Deterministic interleaving: another process can change tenant preferences
        // while this worker waits for the dispatch-marker SQLite write lock.
        brain.prefs(owner, { ...brain.prefs(owner), provider_enabled: false });
        return super.markDispatched(callId, lease);
      }
    }
    const p = provider(() => {
      sends++;
      return { accounting: { state: "unknown" }, output: { ok: false, code: "PROVIDER_UNAVAILABLE", reason: "Synthetic unavailable" } };
    });
    await new Worker(brain, p, new ConsentChangedWhileMarking(store, clock)).tick();
    expect(sends).toBe(0);
    expect(brain.prefs(owner).provider_enabled).toBe(false);
    expect(store.get("SELECT status FROM jobs WHERE id=?", capture.job)?.status).toBe("failed");
    expect(brain.entities(owner, "brief")).toHaveLength(0);
  } finally { store.close(); }
});
