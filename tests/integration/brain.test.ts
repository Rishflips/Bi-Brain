import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "node:sqlite";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { createApp } from "../../apps/server/app.ts";
import {
  extract,
  validateEvidence,
  localSchedule,
} from "../../packages/domain/logic.ts";
import {
  OpenAIProvider,
  type ReasoningProvider,
} from "../../packages/providers/openai.ts";
import type { Principal } from "../../packages/contracts/index.ts";
const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  let date = new Date("2026-09-27T06:00:00Z");
  const b = new Brain(s, () => date);
  return {
    b,
    s,
    dir,
    advance: (ms: number) => {
      date = new Date(date.getTime() + ms);
    },
  };
}
const note = (
  b: Brain,
  body = "Arbitrary 🧠 note: launch the beta after testing.",
  project = "inbox",
  visibility = "project",
) =>
  b.capture(owner, {
    title: "My original",
    body,
    project_id: project,
    visibility,
  }) as any;
async function drain(w: Worker) {
  for (let i = 0; i < 20; i++) if (!(await w.tick())) return;
  throw new Error("Unexpected job loop");
}
describe("persistent knowledge and trust", () => {
  it("arbitrary Unicode capture survives restart with a queued job and exact preview evidence", async () => {
    const { b, s, dir } = setup();
    const result = note(b);
    expect(b.job(owner, result.job.id).status).toBe("queued");
    s.close();
    const reopened = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => reopened.close());
    const next = new Brain(reopened, b.clock);
    expect(next.source(owner, result.source_id).body).toContain("🧠");
    await drain(new Worker(next));
    const brief = next.entities(owner, "brief")[0];
    expect(brief.data.mode).toBe("Extractive preview");
    expect(brief.data.items[0].text).toContain("Arbitrary 🧠");
    next.checkEvidence(owner, "inbox", brief.data.items[0].evidence);
  });
  it("capture idempotency rejects a changed body and supports separately dated duplicates", () => {
    const { b } = setup();
    const input = {
      title: "Title",
      body: "A stable input",
      project_id: "inbox",
    };
    const a = b.capture(owner, input, "key");
    expect(b.capture(owner, input, "key")).toEqual(a);
    expect(() =>
      b.capture(owner, { ...input, body: "different" }, "key"),
    ).toThrow("different content");
    expect((b.capture(owner, input) as any).duplicate).toBe(true);
    expect(
      (b.capture(owner, { ...input, separate: true }) as any).source_id,
    ).not.toBe((a as any).source_id);
  });
  it("correction invalidates old understanding, preserves source history and rejects lost updates", async () => {
    const { b } = setup();
    const n = note(b, "The launch is Monday.");
    await drain(new Worker(b));
    b.editSource(owner, n.source_id, {
      expected_version: 1,
      title: "New date",
      body: "The launch is Friday.",
    });
    expect(b.entities(owner, "brief")[0].data.status).toBe("stale");
    expect(() =>
      b.editSource(owner, n.source_id, {
        expected_version: 1,
        title: "Oops",
        body: "Tuesday",
      }),
    ).toThrow("changed");
    expect(b.source(owner, n.source_id, 1).body).toContain("Monday");
    await drain(new Worker(b));
    expect(JSON.stringify(b.context(owner, "inbox"))).toContain("Friday");
    expect(JSON.stringify(b.context(owner, "inbox"))).not.toContain("Monday");
  });
  it("source deletion purges all retained text including derivatives and staged imports", async () => {
    const { b, s } = setup();
    const n = note(b, "PURGE_UNIQUE_SECRET");
    await drain(new Worker(b));
    b.preview(owner, b.export(owner));
    b.removeSource(owner, n.source_id, 1, true);
    expect(b.sources(owner, undefined, "PURGE_UNIQUE")).toEqual([]);
    expect(() => b.source(owner, n.source_id, 1)).toThrow("unavailable");
    expect(s.all("SELECT body FROM source_versions")).toEqual([]);
    expect(s.all("SELECT * FROM entities")).toEqual([]);
    expect(s.all("SELECT * FROM imports")).toEqual([]);
    await drain(new Worker(b));
    expect(JSON.stringify(b.context(owner, "inbox"))).not.toContain(
      "PURGE_UNIQUE",
    );
  });
  it("private, unrelated and revoked knowledge is denied through every shared service", async () => {
    const { b } = setup();
    const other = b.createProject(owner, "Unrelated");
    note(b, "OTHER_PROJECT_SECRET", other.id);
    const privateNote = note(b, "PRIVATE_SECRET", "inbox", "private");
    note(b, "VISIBLE");
    await drain(new Worker(b));
    const g = b.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read", "propose_memory"],
      expires_at: "2026-10-01T00:00:00Z",
    });
    const agent = b.authenticateAgent(g.token);
    expect(JSON.stringify(b.sources(agent))).not.toMatch(/SECRET/);
    expect(() => b.source(agent, privateNote.source_id)).toThrow("unavailable");
    expect(() => b.context(agent, other.id)).toThrow("unavailable");
    expect(JSON.stringify(b.context(agent, "inbox"))).not.toMatch(/SECRET/);
    const a = b.propose(agent, {
      title: "Agent assertion",
      text: "REMEMBER_UNIQUE",
      project_id: "inbox",
      type: "unknown",
    }) as any;
    expect(b.source(owner, a.raw_id).origin).toContain("agent:");
    b.revoke(owner, g.id);
    expect(() => b.context(agent, "inbox")).toThrow("revoked");
    expect(() => b.sources(agent)).toThrow("revoked");
    expect(() =>
      b.propose(agent, {
        title: "x",
        text: "x",
        project_id: "inbox",
        type: "unknown",
      }),
    ).toThrow("revoked");
  });
  it("evidence uses Unicode code points and rejects cross-project and stale references", () => {
    const { b } = setup();
    const n = note(b, "🧠 abc");
    const source = b.source(owner, n.source_id);
    const evidence = {
      source_id: source.id,
      source_version: 1,
      start: 2,
      end: 5,
      quote: "abc",
    };
    expect(() => validateEvidence([evidence], [source], "inbox")).not.toThrow();
    expect(() =>
      validateEvidence([{ ...evidence, start: 3 }], [source], "inbox"),
    ).toThrow();
    expect(() => validateEvidence([evidence], [source], "elsewhere")).toThrow();
    expect(() =>
      validateEvidence([{ ...evidence, source_version: 2 }], [source], "inbox"),
    ).toThrow();
  });
  it("export excludes secrets, preview deduplicates and import conflicts roll back", async () => {
    const { b, s } = setup();
    const n = note(b);
    const g = b.goal(owner, {
      project_id: "inbox",
      title: "Beta",
      success_criteria: "Ship",
    });
    b.store.set("secret", "SHOULD_NOT_EXPORT");
    b.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read"],
      expires_at: "2026-10-01T00:00:00Z",
    });
    const exported = b.export(owner);
    expect(JSON.stringify(exported)).not.toContain("SHOULD_NOT_EXPORT");
    const target = setup().b;
    const preview = target.preview(owner, exported);
    expect(preview.conflicts).toEqual([]);
    target.applyImport(owner, preview.id);
    expect(target.source(owner, n.source_id).body).toBe(
      b.source(owner, n.source_id).body,
    );
    expect(target.entity(owner, g.id).data.preparation_enabled).toBe(false);
    const repeated = target.preview(owner, exported);
    target.applyImport(owner, repeated.id);
    expect(target.sources(owner)).toHaveLength(1);
    await drain(new Worker(b));
    const staged = b.preview(owner, b.export(owner));
    s.run(
      "UPDATE source_versions SET body=? WHERE source_id=?",
      "conflict",
      n.source_id,
    );
    expect(() => b.applyImport(owner, staged.id)).toThrow("conflicts");
  });
  it("consistent operational backup restores jobs, source and access state", async () => {
    const { b, s, dir } = setup();
    const n = note(b);
    const g = b.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read"],
      expires_at: "2026-10-01T00:00:00Z",
    });
    const path = join(dir, "backup.sqlite");
    await backup(s.db, path);
    const restored = new Storage(path);
    cleanup.push(() => restored.close());
    const next = new Brain(restored, b.clock);
    expect(next.store.get("PRAGMA integrity_check")?.integrity_check).toBe(
      "ok",
    );
    expect(next.store.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(next.source(owner, n.source_id).body).toContain("Arbitrary");
    expect(next.authenticateAgent(g.token).kind).toBe("agent");
    await drain(new Worker(next));
    expect(next.context(owner, "inbox").items.length).toBe(1);
  });
});
describe("durable preparation", () => {
  it("lease recovery fences old attempts and commits one result", async () => {
    const { b, advance, s } = setup();
    const n = note(b);
    const first = new Worker(b),
      second = new Worker(b);
    const leased = first.lease()!;
    advance(61000);
    await second.tick();
    expect(() => first.fenced(leased)).toThrow("no longer current");
    expect(b.job(owner, n.job.id).status).toBe("succeeded");
    expect(s.all("SELECT * FROM entities WHERE kind='brief'")).toHaveLength(1);
    expect(await second.tick()).toBe(false);
  });
  it("cancelled jobs do not publish and exhausted interrupted jobs become failed", async () => {
    const { b, s, advance } = setup();
    const a = note(b);
    b.jobAction(owner, a.job.id, "cancel");
    await drain(new Worker(b));
    expect(b.entities(owner, "brief")).toEqual([]);
    const n = note(b, "second");
    const w = new Worker(b);
    w.lease();
    s.run("UPDATE jobs SET attempts=3 WHERE id=?", n.job.id);
    advance(61000);
    w.schedule();
    expect(b.job(owner, n.job.id).status).toBe("failed");
  });
  it("changed source during a provider call cannot resurrect a deleted note", async () => {
    const { b } = setup();
    const n = note(b, "DELETION_DURING_CALL");
    b.prefs(owner, {
      ...b.prefs(owner),
      provider_enabled: true,
      daily_cap_micro_usd: 10000,
      per_job_cap_micro_usd: 1000,
    });
    const fake: ReasoningProvider = {
      upperBound: () => 100,
      prepare: async (sources) => {
        b.removeSource(owner, n.source_id, 1, true);
        return {
          ...extract(sources),
          usage: { input_tokens: 1, output_tokens: 1 },
          metadata: { provider: "fake", model: "test", prompt_version: "test" },
          cost_micro_usd: 10,
        };
      },
    };
    await new Worker(b, fake).tick();
    expect(b.entities(owner, "brief")).toEqual([]);
    expect(JSON.stringify(b.entities(owner))).not.toContain(
      "DELETION_DURING_CALL",
    );
  });
  it("budget admission is atomic and capture remains saved when denied", async () => {
    const { b } = setup();
    const a = note(b);
    const c = note(b, "second unique");
    b.prefs(owner, {
      ...b.prefs(owner),
      provider_enabled: true,
      daily_cap_micro_usd: 100,
      per_job_cap_micro_usd: 100,
    });
    const w1 = new Worker(b),
      w2 = new Worker(b);
    const j1 = w1.lease()!,
      j2 = w2.lease()!;
    w1.reserve(j1, 80);
    expect(() => w2.reserve(j2, 80)).toThrow("cap");
    expect(b.source(owner, a.source_id).body).toContain("Arbitrary");
    expect(b.source(owner, c.source_id).body).toContain("second");
  });
  it("proposal accept/undo is version checked, evidence backed and deduplicated", async () => {
    const { b } = setup();
    note(b, "Beta onboarding plan requires connecting agents first.");
    note(
      b,
      "Beta interview asks for one conversation before connecting accounts.",
    );
    const goal = b.goal(owner, {
      project_id: "inbox",
      title: "Beta onboarding",
      success_criteria: "Test a useful brief",
    });
    const enabled = b.editGoal(owner, goal.id, {
      expected_version: 1,
      preparation_enabled: true,
    });
    b.prepare(owner, enabled.id);
    await drain(new Worker(b));
    const p = b.entities(owner, "proposal")[0];
    expect(p.data.status).toBe("ready");
    expect(p.data.evidence.length).toBe(2);
    expect(b.entity(owner, goal.id).data.plan).toBe("");
    const accepted = b.review(
      owner,
      p.id,
      "accept",
      { expected_version: p.version },
      "accept-key",
    ) as any;
    expect(b.entity(owner, goal.id).data.plan).toContain("Hypothesis");
    b.undo(owner, accepted.receipt.id, accepted.goal.data.plan_version);
    expect(b.entity(owner, goal.id).data.plan).toBe("");
    b.prepare(owner, goal.id);
    await drain(new Worker(b));
    expect(b.entities(owner, "proposal")).toHaveLength(1);
  });
  it("undo cannot overwrite an intervening user edit; snooze has a real due time", async () => {
    const { b, advance } = setup();
    note(b, "Beta evidence one");
    note(b, "Beta evidence two");
    const goal = b.goal(owner, {
      project_id: "inbox",
      title: "Beta launch",
      success_criteria: "Beta success",
    });
    b.editGoal(owner, goal.id, {
      expected_version: 1,
      preparation_enabled: true,
    });
    b.prepare(owner, goal.id);
    await drain(new Worker(b));
    let p = b.entities(owner, "proposal")[0];
    b.review(owner, p.id, "snooze", {
      expected_version: p.version,
      until: "2026-09-27T07:00:00Z",
    });
    advance(3600001);
    new Worker(b).schedule();
    p = b.entity(owner, p.id);
    expect(p.data.status).toBe("ready");
    const accepted = b.review(owner, p.id, "accept", {
      expected_version: p.version,
    }) as any;
    const current = b.entity(owner, goal.id);
    b.editGoal(owner, goal.id, {
      expected_version: current.version,
      plan: "A later user edit",
    });
    expect(() =>
      b.undo(owner, accepted.receipt.id, accepted.goal.data.plan_version),
    ).toThrow("changed");
    expect(b.entity(owner, goal.id).data.plan).toBe("A later user edit");
  });
  it("pause, local quiet hours and catch-up create at most one daily bounded check", () => {
    const { b, advance, s } = setup();
    const g = b.goal(owner, {
      project_id: "inbox",
      title: "Beta",
      success_criteria: "Ship",
    });
    b.editGoal(owner, g.id, { expected_version: 1, preparation_enabled: true });
    const w = new Worker(b);
    w.schedule();
    expect(s.all("SELECT * FROM jobs")).toHaveLength(0);
    b.prefs(owner, { ...b.prefs(owner), enabled: true });
    w.schedule();
    w.schedule();
    expect(s.all("SELECT * FROM jobs")).toHaveLength(1);
    expect(
      localSchedule(new Date("2026-03-08T07:30:00Z"), {
        time_zone: "America/New_York",
        digest_hour: 9,
        quiet_start: 22,
        quiet_end: 8,
      }).eligible,
    ).toBe(false);
    advance(4 * 86400000);
    w.schedule();
    expect(s.all("SELECT * FROM jobs")).toHaveLength(1);
  });
  it("two eligible intentions create at most one in-app prompt per local day", async () => {
    const { b, advance } = setup();
    note(b, "Beta pilot should test five users first.");
    note(b, "Beta pilot support can track blockers.");
    await drain(new Worker(b));
    for (const title of ["Beta pilot", "Beta test"]) {
      const goal = b.goal(owner, {
        project_id: "inbox",
        title,
        success_criteria: "Review beta blockers",
      });
      b.editGoal(owner, goal.id, {
        expected_version: 1,
        preparation_enabled: true,
      });
    }
    b.prefs(owner, { ...b.prefs(owner), enabled: true });
    await drain(new Worker(b));
    expect(b.entities(owner, "proposal")).toHaveLength(2);
    expect(b.entities(owner, "ping")).toHaveLength(1);
    advance(3600000);
    await drain(new Worker(b));
    expect(b.entities(owner, "ping")).toHaveLength(1);
  });
  it("an intention with a future review time waits for that time before background admission", () => {
    const { b, advance, s } = setup();
    const goal = b.goal(owner, {
      project_id: "inbox",
      title: "Beta",
      success_criteria: "Review",
      review_at: "2026-09-28T06:00:00.000Z",
    });
    b.editGoal(owner, goal.id, {
      expected_version: 1,
      preparation_enabled: true,
    });
    b.prefs(owner, { ...b.prefs(owner), enabled: true });
    const worker = new Worker(b);
    worker.schedule();
    expect(s.all("SELECT * FROM jobs")).toHaveLength(0);
    advance(86400001);
    worker.schedule();
    expect(s.all("SELECT * FROM jobs")).toHaveLength(1);
  });
  it("malformed output and invented evidence do not publish or change budgets", async () => {
    const { b } = setup();
    note(b, "Valid beta note");
    b.prefs(owner, {
      ...b.prefs(owner),
      provider_enabled: true,
      daily_cap_micro_usd: 1000,
      per_job_cap_micro_usd: 1000,
    });
    const provider = new OpenAIProvider(
      {
        key: "test-not-real",
        model: "test",
        input_price: 1,
        output_price: 1,
        price_version: "test",
      },
      async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      items: [
                        {
                          text: "Invented",
                          epistemic_status: "supported",
                          evidence: [
                            {
                              source_id: "invented",
                              source_version: 1,
                              start: 0,
                              end: 1,
                              quote: "x",
                            },
                          ],
                        },
                      ],
                      unknowns: [],
                    }),
                  },
                ],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
    );
    await new Worker(b, provider).tick();
    expect(b.entities(owner, "brief")).toEqual([]);
    expect(b.status(owner).jobs[0].status).toBe("failed");
    expect(b.prefs(owner).daily_cap_micro_usd).toBe(1000);
    expect(b.store.all("SELECT * FROM reservations")[0].status).toBe("held");
  });
  it("model-backed goal proposal is reviewed, and active-owner output is discarded after dispatch", async () => {
    const { b, s } = setup();
    const first = note(b, "Beta rollout needs a test with five users.");
    await drain(new Worker(b));
    const goal = b.goal(owner, {
      project_id: "inbox",
      title: "Beta rollout",
      success_criteria: "Choose a safe first test",
    });
    b.editGoal(owner, goal.id, {
      expected_version: 1,
      preparation_enabled: true,
    });
    b.prefs(owner, {
      ...b.prefs(owner),
      provider_enabled: true,
      daily_cap_micro_usd: 1000,
      per_job_cap_micro_usd: 1000,
    });
    const evidence = {
      source_id: first.source_id,
      source_version: 1,
      start: 0,
      end: 45,
      quote: "Beta rollout needs a test with five users.",
    };
    evidence.end = Array.from(evidence.quote).length;
    const fake: ReasoningProvider = {
      upperBound: () => 100,
      prepare: async (sources) => ({
        ...extract(sources),
        usage: { input_tokens: 1, output_tokens: 1 },
        metadata: { provider: "fake", model: "test", prompt_version: "test" },
        cost_micro_usd: 10,
      }),
      prepareGoal: async () => ({
        outcome: "proposal",
        artifact:
          "Hypothesis: ask five users to try the beta and record blockers.",
        evidence: [evidence],
        usage: { input_tokens: 1, output_tokens: 1 },
        metadata: {
          provider: "fake",
          model: "test",
          prompt_version: "goal-test",
        },
        cost_micro_usd: 10,
      }),
    };
    b.prepare(owner, goal.id);
    await new Worker(b, fake).tick();
    expect(b.entities(owner, "proposal")[0].data.artifact).toContain(
      "ask five users",
    );
    expect(b.entity(owner, goal.id).data.plan).toBe("");
    expect(
      b.entities(owner, "receipt").some((r) => r.data.provider === "fake"),
    ).toBe(true);

    const secondGoal = b.goal(owner, {
      project_id: "inbox",
      title: "Beta follow-up",
      success_criteria: "Review blockers",
    });
    b.editGoal(owner, secondGoal.id, {
      expected_version: 1,
      preparation_enabled: true,
    });
    b.prefs(owner, { ...b.prefs(owner), enabled: true });
    const race: ReasoningProvider = {
      ...fake,
      prepareGoal: async () => {
        s.set("owner_activity", b.now());
        return fake.prepareGoal!(
          { title: "", success_criteria: "", plan: "" },
          [],
          new AbortController().signal,
        );
      },
    };
    new Worker(b, race).schedule();
    await drain(new Worker(b, race));
    expect(
      b
        .entities(owner, "proposal")
        .filter((p) => p.data.goal_id === secondGoal.id),
    ).toEqual([]);
    expect(
      b.status(owner).jobs.some((j: any) => j.status === "cancelled"),
    ).toBe(true);
  });
  it("structured goal provider rejects invented evidence before any proposal can publish", async () => {
    const { b } = setup();
    const saved = note(b, "Beta pilot starts with five users.");
    const source = b.source(owner, saved.source_id);
    let sent: any;
    const provider = new OpenAIProvider(
      {
        key: "synthetic-test-only",
        model: "synthetic",
        input_price: 1,
        output_price: 1,
        price_version: "fixture",
      },
      async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      outcome: "proposal",
                      artifact: "Invented next step",
                      evidence: [
                        {
                          source_id: "not-a-source",
                          source_version: 1,
                          start: 0,
                          end: 1,
                          quote: "x",
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
            usage: { input_tokens: 20, output_tokens: 10 },
          }),
        );
      },
    );
    await expect(
      provider.prepareGoal(
        { title: "Beta", success_criteria: "Test", plan: "" },
        [source],
        new AbortController().signal,
      ),
    ).rejects.toThrow("Evidence");
    expect(sent.store).toBe(false);
    expect(sent.text.format.name).toBe("goal_preparation");
    expect(JSON.stringify(sent.input)).toContain(source.id);
  });
});
describe("HTTP boundary", () => {
  it("owner pairing, CSRF, origin, grants and revocation use actual routes", async () => {
    const { b } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const req = (
      method: any,
      url: string,
      payload?: any,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method,
        url,
        headers: { host: "127.0.0.1:4317", ...headers },
        payload,
      });
    expect((await req("GET", "/api/v1/projects")).statusCode).toBe(401);
    expect(
      (
        await req("GET", "/api/v1/health/live", undefined, {
          host: "evil.example",
        })
      ).statusCode,
    ).toBe(403);
    const pairing = await req("POST", "/api/v1/session/pair", {
      secret: "test-code",
    });
    expect(pairing.statusCode).toBe(200);
    const cookie = pairing.cookies[0];
    const headers = {
      cookie: `${cookie.name}=${cookie.value}`,
      "x-brain-csrf": pairing.json().csrf,
    };
    expect(
      (
        await req(
          "POST",
          "/api/v1/projects",
          { title: "denied" },
          { cookie: headers.cookie },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await req(
          "POST",
          "/api/v1/projects",
          { title: "denied" },
          { ...headers, origin: "https://evil.example" },
        )
      ).statusCode,
    ).toBe(403);
    const capture = await req(
      "POST",
      "/api/v1/sources",
      { title: "HTTP arbitrary", body: "HTTP persistent note" },
      headers,
    );
    expect(capture.statusCode).toBe(201);
    const grant = await req(
      "POST",
      "/api/v1/agent-grants",
      {
        projects: ["inbox"],
        operations: ["read"],
        expires_at: "2026-10-01T00:00:00Z",
      },
      headers,
    );
    const auth = { authorization: `Bearer ${grant.json().token}` };
    expect(
      (
        await req(
          "GET",
          "/api/v1/search?project_id=inbox&q=persistent",
          undefined,
          auth,
        )
      ).json(),
    ).toHaveLength(1);
    expect(
      (await req("POST", "/api/v1/agent/verify", {}, auth)).statusCode,
    ).toBe(200);
    expect(
      (await req("GET", "/api/v1/connections", undefined, headers)).json()[0]
        .status,
    ).toBe("Connected");
    await req("DELETE", `/api/v1/agent-grants/${grant.json().id}`, {}, headers);
    expect(
      (await req("GET", "/api/v1/search?project_id=inbox", undefined, auth))
        .statusCode,
    ).toBe(401);
  });
  it("oversized explicit capture is rejected without any source insertion", () => {
    const { b } = setup();
    expect(() => note(b, "a".repeat(100001))).toThrow();
    expect(b.sources(owner)).toEqual([]);
  });
});
