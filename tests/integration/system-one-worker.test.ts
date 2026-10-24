import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import { publishSystemOneStatus, runSystemOneJob, type SystemOneClient } from "../../apps/worker/system-one.ts";
import { systemOneCapability } from "../../apps/server/system-one-capability.ts";
import { createApp } from "../../apps/server/app.ts";
import { systemOneFromEnv } from "../../packages/providers/system-one-env.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import type { DispatchSpec, JobLease, SpendLimits } from "../../packages/domain/spend.ts";

const owner: Principal = { kind: "owner" };
const KEY = "sk-live-do-not-leak-0123456789";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

type Provider = "ollama" | "cloudflare";
function clientFor(provider: Provider, fetcher: typeof fetch): SystemOneClient {
  const env: Record<string, string> = {
    BRAIN_SYSTEM1_PROVIDER: provider,
    BRAIN_SYSTEM1_ENDPOINT: "http://127.0.0.1:9/v1/systemone",
    BRAIN_DECISION_API_KEY: KEY,
  };
  const s = systemOneFromEnv(env);
  if (!s.config) throw new Error(s.reason);
  return { config: s.config, fetcher };
}

/** A Clef-shaped answer built from the questions actually asked. */
function answerFor(provider: Provider, body: any, over: { project?: string; broken?: boolean } = {}): Response {
  const answers: Record<string, any> = {};
  for (const [id, q] of Object.entries<any>(body.questions)) {
    if (q.type === "noul") {
      answers[id] = { type: "noul", noul: id === "show" ? 0.9 : 0.1 };
      continue;
    }
    const ids = Object.keys(q.criteria);
    const choice = id === "project" && over.project ? over.project : ids[0];
    const probabilities = Object.fromEntries(ids.map((x) => [x, x === choice ? 0.9 : 0.1 / (ids.length - 1)]));
    // A broken answer names an option the request never offered.
    answers[id] = { type: "choice", choice: over.broken && id === "project" ? "not-offered" : choice, confidence: 0.9, probabilities };
  }
  const node = { model: "clef-flash", answers, usage: { input_tokens: 300, output_tokens: 0 } };
  return new Response(JSON.stringify(provider === "cloudflare" ? { success: true, result: node } : node), { status: 200 });
}

function setup(opts: { client?: "none" | Provider; ledger?: (l: LocalDispatchAccounting) => LocalDispatchAccounting } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "s1-worker-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => {
    try {
      store.close();
    } catch {}
  });
  const time = { now: new Date("2026-10-24T09:00:00Z") };
  const clock = () => time.now;
  const brain = new Brain(store, clock, undefined, undefined, undefined, undefined, () => ({ ready: true, reason: "test" }));
  brain.prefs(owner, { ...brain.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
  const calls = { n: 0, bodies: [] as any[] };
  const provider: Provider = opts.client === "cloudflare" ? "cloudflare" : "ollama";
  let behave: (body: any) => Response | Promise<Response> = (body) => answerFor(provider, body);
  const fetcher = (async (_url: any, init: any) => {
    calls.n++;
    const body = JSON.parse(init.body);
    calls.bodies.push(body);
    return behave(body);
  }) as unknown as typeof fetch;
  const client = opts.client === "none" ? null : clientFor(provider, fetcher);
  const ledger = (opts.ledger ?? ((l) => l))(new LocalDispatchAccounting(store, clock));
  const worker = new Worker(brain, undefined, ledger, undefined, client);
  const job = () => store.get<any>("SELECT * FROM jobs WHERE kind='system_one_route' ORDER BY created_at DESC LIMIT 1");
  const ledgerRows = () => store.all<any>("SELECT * FROM provider_dispatches");
  /** Runs every job that is ready now (the brief job and the sorting job). */
  const drain = async () => {
    for (let i = 0; i < 6 && (await worker.tick()); i++);
  };
  return { store, brain, worker, time, calls, job, ledgerRows, drain, provider, setBehave: (fn: typeof behave) => (behave = fn), ledger };
}

describe("the worker runs sorting help", () => {
  for (const provider of ["ollama", "cloudflare"] as const) {
    it(`stores the answer, settles the reported cost and finishes the job (${provider})`, async () => {
      const t = setup({ client: provider });
      const p = t.brain.createProject(owner, "Northstar");
      const { source_id } = t.brain.capture(owner, { project_id: "inbox", title: "Pricing", body: "Northstar ships with one plan.", visibility: "project" }) as any;
      t.setBehave((body) => answerFor(provider, body, { project: p.id }));
      await t.drain();
      expect(t.calls.n).toBe(1);
      expect(t.job().status).toBe("succeeded");
      expect(t.brain.entities(owner, "s1_answer")).toHaveLength(1);
      const [row] = t.ledgerRows();
      expect(row).toMatchObject({ state: "settled", actual_micro_usd: 27, stage: "decision", dispatch_key: "system_one", provider });
      const [card] = t.brain.brief(owner).items.filter((i) => i.kind === "file");
      expect(card.title).toBe("File in Northstar?");
      expect(source_id).toBeTruthy();
    });
  }

  it("does nothing without a configured client: cancelled, no ledger row, no card", async () => {
    const t = setup({ client: "none" });
    t.brain.createProject(owner, "Northstar");
    t.brain.capture(owner, { project_id: "inbox", title: "Pricing", body: "Northstar ships with one plan.", visibility: "project" });
    await t.drain();
    expect(t.job().status).toBe("cancelled");
    expect(t.ledgerRows()).toHaveLength(0);
    expect(t.calls.n).toBe(0);
    expect(t.brain.brief(owner).items.filter((i) => i.kind === "file")).toHaveLength(0);
  });

  it("queues nothing at a zero cap, and sends nothing when the cap drops after the mark", async () => {
    const zero = setup();
    zero.brain.prefs(owner, { ...zero.brain.prefs(owner), daily_cap_micro_usd: 0 });
    zero.brain.capture(owner, { project_id: "inbox", title: "A", body: "Some note.", visibility: "project" });
    expect(zero.job()).toBeUndefined();

    // Timing is forced through the ledger seam: the caps drop inside markDispatched,
    // exactly the window between reserve and the network call.
    let lower = () => {};
    const t = setup({
      ledger: (l) => {
        const mark = l.markDispatched.bind(l);
        l.markDispatched = (callId, lease) => {
          const r = mark(callId, lease);
          lower();
          return r;
        };
        return l;
      },
    });
    lower = () => t.brain.prefs(owner, { ...t.brain.prefs(owner), per_job_cap_micro_usd: 0 });
    t.brain.capture(owner, { project_id: "inbox", title: "A", body: "Some note.", visibility: "project" });
    await t.drain();
    expect(t.calls.n).toBe(0);
    expect(t.job().status).toBe("cancelled");
    // Marked, so the hold stays rather than being refunded.
    expect(t.ledgerRows().map((r) => r.state)).toEqual(["dispatched"]);
  });

  for (const [name, change] of [
    ["the project is unwatched", (t: ReturnType<typeof setup>, pid: string) => t.brain.watchProject(owner, pid, { watched: false })],
    ["consent is withdrawn", (t: ReturnType<typeof setup>) => t.brain.prefs(owner, { ...t.brain.prefs(owner), decision_provider_enabled: false })],
  ] as const) {
    it(`sends nothing and keeps the hold when ${name} right after the mark`, async () => {
      let change_ = () => {};
      const t = setup({
        ledger: (l) => {
          const mark = l.markDispatched.bind(l);
          l.markDispatched = (callId, lease) => {
            const r = mark(callId, lease);
            change_();
            return r;
          };
          return l;
        },
      });
      const p = t.brain.createProject(owner, "Northstar");
      change_ = () => change(t, p.id);
      t.brain.capture(owner, { project_id: p.id, title: "Notes", body: "Northstar notes.", visibility: "project" });
      await t.drain();
      expect(t.calls.n).toBe(0);
      expect(t.job().status).toBe("cancelled");
      expect(t.ledgerRows().map((r) => r.state)).toEqual(["dispatched"]);
    });
  }

  it("cancels a job for an older version of an edited note, then answers the newer one", async () => {
    const t = setup();
    const { source_id } = t.brain.capture(owner, { project_id: "inbox", title: "Pricing", body: "Northstar ships.", visibility: "project" }) as any;
    t.brain.editSource(owner, source_id, { title: "Pricing", body: "Northstar ships soon.", expected_version: 1 });
    const jobs = () => t.store.all<any>("SELECT id,status,payload FROM jobs WHERE kind='system_one_route' ORDER BY created_at");
    expect(jobs()).toHaveLength(2);
    await t.drain();
    const byVersion = (v: number) => jobs().find((j) => JSON.parse(j.payload).source_version === v);
    expect(byVersion(1).status).toBe("cancelled");
    expect(byVersion(2).status).toBe("succeeded");
    expect(t.calls.n).toBe(1);
    const answers = t.brain.entities(owner, "s1_answer");
    expect(answers.map((a: any) => a.data.source_version)).toEqual([2]);
    expect(t.ledgerRows()).toHaveLength(1);
  });

  it("says why in Settings when a note is not sent because it looks like a secret", async () => {
    const t = setup();
    publishSystemOneStatus(t.brain, { configured: true, label: "Ollama (estimated cost)" });
    // Capture quarantines secret-shaped notes, so no job is queued from it.
    t.brain.capture(owner, { project_id: "inbox", title: "Keys", body: "Use sk-abcdefghijklmnopqrstuvwxyz0123456789 for the build.", visibility: "project" });
    expect(t.job()).toBeUndefined();
    // Drive the job directly with a context that holds the secret.
    t.brain.systemOneContext = () => ({ note: "Use sk-abcdefghijklmnopqrstuvwxyz0123456789 for the build.", title: "Keys", project_id: "inbox", projects: [], hasCurrentFacts: false });
    const client = clientFor("ollama", (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch);
    const r = await runSystemOneJob(
      { brain: t.brain, ledger: t.ledger, client, owner, leaseOwner: "w" },
      { id: "j", project_id: "inbox", fence: 1, payload: { source_id: "s", source_version: 1 } },
      new AbortController().signal,
    );
    expect(r.outcome).toBe("cancelled");
    expect(t.ledgerRows()).toHaveLength(0);
    expect(t.store.setting<any>("system_one_status", null).last_error).toBe("A note looked like it held a secret, so it was not sent for sorting.");
  });

  it("rejects an answer naming an unoffered project whole, settles its cost and files nothing", async () => {
    const t = setup();
    t.brain.createProject(owner, "Northstar");
    t.brain.capture(owner, { project_id: "inbox", title: "Pricing", body: "Northstar ships with one plan.", visibility: "project" });
    t.setBehave((body) => answerFor("ollama", body, { broken: true }));
    await t.drain();
    expect(t.job().status).toBe("failed");
    expect(t.brain.entities(owner, "s1_answer")).toHaveLength(0);
    expect(t.brain.brief(owner).items.filter((i) => i.kind === "file")).toHaveLength(0);
    expect(t.ledgerRows().map((r) => [r.state, r.actual_micro_usd])).toEqual([["settled", 27]]);
    // An invalid answer is final: later ticks never ask again.
    t.time.now = new Date(t.time.now.getTime() + 3_600_000);
    await t.drain();
    expect(t.calls.n).toBe(1);
  });

  it("is cancelled without a request when the project stops being watched", async () => {
    const t = setup();
    const p = t.brain.createProject(owner, "Northstar");
    t.brain.capture(owner, { project_id: p.id, title: "Notes", body: "Northstar notes.", visibility: "project" });
    t.brain.watchProject(owner, p.id, { watched: false });
    await t.drain();
    expect(t.calls.n).toBe(0);
    expect(t.job().status).toBe("cancelled");
    expect(t.ledgerRows()).toHaveLength(0);
  });

  it("never runs for a managed (tenant) brain", async () => {
    const t = setup();
    const managed = new Brain(t.store, () => t.time.now, "tenant-1");
    const r = await runSystemOneJob(
      { brain: managed, ledger: t.ledger, client: clientFor("ollama", (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch), owner: managed.ownerPrincipal(), leaseOwner: "w" },
      { id: "j", project_id: "inbox", fence: 1, payload: { source_id: "s", source_version: 1 } },
      new AbortController().signal,
    );
    expect(r.outcome).toBe("cancelled");
    expect(t.ledgerRows()).toHaveLength(0);
  });

  it("retries a failure before anything was held, then succeeds on the third try", async () => {
    let failures = 2;
    const t = setup({
      ledger: (l) => {
        const reserve = l.reserve.bind(l);
        l.reserve = (spec: DispatchSpec, lease: JobLease, limits: SpendLimits) => {
          if (failures-- > 0) throw new BrainError("PROVIDER_UNAVAILABLE", "The ledger was busy.", 503);
          return reserve(spec, lease, limits);
        };
        return l;
      },
    });
    t.brain.capture(owner, { project_id: "inbox", title: "A", body: "Some note.", visibility: "project" });
    await t.drain();
    expect(t.job().status).toBe("retry_wait");
    t.time.now = new Date(t.job().next_at);
    t.time.now = new Date(t.time.now.getTime() + 1);
    await t.drain();
    expect(t.job().status).toBe("retry_wait");
    t.time.now = new Date(new Date(t.job().next_at).getTime() + 1);
    await t.drain();
    expect(t.job().status).toBe("succeeded");
    expect(t.calls.n).toBe(1);
  });

  it("keeps the hold and never resends when the service fails after the request went out", async () => {
    const t = setup();
    t.brain.capture(owner, { project_id: "inbox", title: "A", body: "Some note.", visibility: "project" });
    t.setBehave(() => new Response("down", { status: 503 }));
    await t.drain();
    expect(t.job().status).toBe("failed");
    expect(t.ledgerRows().map((r) => r.state)).toEqual(["dispatched"]);
    t.time.now = new Date(t.time.now.getTime() + 3_600_000);
    await t.drain();
    expect(t.calls.n).toBe(1);
  });
});

describe("the published status", () => {
  it("records success and failure in plain words and never holds the key", async () => {
    const t = setup();
    publishSystemOneStatus(t.brain, { configured: true, label: "Ollama (estimated cost)" });
    t.brain.capture(owner, { project_id: "inbox", title: "A", body: "Some note.", visibility: "project" });
    await t.drain();
    let status = t.store.setting<any>("system_one_status", null);
    expect(status).toMatchObject({ configured: true, label: "Ollama (estimated cost)" });
    expect(status.last_ok_at).toBeTruthy();
    t.setBehave(() => new Response("down", { status: 503 }));
    t.brain.capture(owner, { project_id: "inbox", title: "B", body: "Another note.", visibility: "project" });
    await t.drain();
    status = t.store.setting<any>("system_one_status", null);
    expect(status.last_error).toMatch(/sorting service/i);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(JSON.stringify(t.store.all<any>("SELECT payload,error FROM jobs"))).not.toContain(KEY);
  });
});

describe("consent for sorting help", () => {
  async function server(beat: string | null, status: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "s1-consent-test-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
    cleanup.push(() => {
      try {
        store.close();
      } catch {}
    });
    const clock = () => new Date("2026-10-24T09:00:00Z");
    const brain = new Brain(store, clock, undefined, undefined, undefined, undefined, systemOneCapability(store, clock));
    if (status) store.set("system_one_status", status);
    if (beat) store.set("worker_heartbeat", beat);
    const app = await createApp(brain, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "test-code" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    return async (body: Record<string, unknown>) => {
      const current = (await req("GET", "/api/v1/preferences/background", undefined, headers)).json();
      return req("PATCH", "/api/v1/preferences/background", { ...current, ...body }, headers);
    };
  }
  const ok = { configured: true, label: "Ollama", updated_at: "2026-10-24T08:59:00Z" };

  it("refuses consent when the worker never published a status", async () => {
    const patch = await server("2026-10-24T08:59:50Z", null);
    const res = await patch({ decision_provider_enabled: true });
    expect(res.statusCode).toBe(409);
  });

  it("accepts consent when sorting help is configured and the worker is alive", async () => {
    const patch = await server("2026-10-24T08:59:50Z", ok);
    const res = await patch({ decision_provider_enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision_provider_enabled).toBe(true);
  });

  it("refuses consent when the worker's heartbeat is stale", async () => {
    const patch = await server("2026-10-24T08:58:00Z", ok);
    const res = await patch({ decision_provider_enabled: true });
    expect(res.statusCode).toBe(409);
  });

  it("explains an unconfigured worker with its published reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "s1-cap-test-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
    cleanup.push(() => {
      try {
        store.close();
      } catch {}
    });
    store.set("system_one_status", { configured: false, reason: "Add your Ollama API key to turn on sorting help.", updated_at: "x" });
    store.set("worker_heartbeat", "2026-10-24T08:59:50Z");
    const cap = systemOneCapability(store, () => new Date("2026-10-24T09:00:00Z"))();
    expect(cap).toEqual({ ready: false, reason: "Add your Ollama API key to turn on sorting help." });
  });
});
