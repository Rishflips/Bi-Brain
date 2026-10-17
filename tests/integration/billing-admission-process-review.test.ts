import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

const childCode = `
import { join } from 'node:path';
import { ControlStore } from './packages/storage/control.ts';
import { ManagedSpendingStore } from './packages/storage/managed-spending.ts';
const a = JSON.parse(Buffer.from(process.argv[1],'base64url').toString('utf8'));
const clock = () => new Date(a.now);
const control = new ControlStore(join(a.root,'control.sqlite'), clock);
const ledger = new ManagedSpendingStore(control, clock);
process.once('message', () => {
  try {
    const row = ledger.mark(a.call_id,a.limits);
    process.send({type:'result',state:row.state,call_id:row.call_id});
  } catch(error) {
    process.send({type:'result',state:'refused',code:typeof error?.code==='string'?error.code:'ERROR'});
  } finally {control.close();process.disconnect();}
});
process.send({type:'ready'});
`;

function contender(input: unknown) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "ComSpec", "PATH", "Path", "PATHEXT", "USERPROFILE", "HOME"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (process.platform === "win32") {
    env.TEMP = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Temp", "opencode"); env.TMP = env.TEMP;
  }
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode,
    Buffer.from(JSON.stringify(input)).toString("base64url")],
  { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-4000); });
  child.stdout!.resume();
  const closed = new Promise<number | null>((resolve) => { child.once("close", resolve); });
  type Message = { type: string; state?: string; call_id?: string };
  const received = new Map<string, Message>(), waits = new Map<string, (message: Message) => void>();
  child.on("message", (raw) => {
    if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string") return;
    const message = raw as Message;
    received.set(message.type, message); waits.get(message.type)?.(message);
  });
  async function wait(type: string) {
    if (received.has(type)) return received.get(type)!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<Message>((resolve) => waits.set(type, resolve)),
        closed.then(() => { throw new Error(`Synthetic billing contender exited before ${type}: ${stderr}`); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Synthetic billing contender timed out: ${type}`)), 20_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); waits.delete(type); }
  }
  return { child, closed, wait };
}

it("two actual v5 processes freshly mark only one of two bound reservations until known settlement", async () => {
  const f = createBillingAdmissionFixture({ enrolled: true });
  const children: ReturnType<typeof contender>[] = [];
  try {
    const prepared = await f.prepare();
    if (prepared.state !== "prepared") throw new Error("Synthetic admission did not prepare.");
    expect(f.admit(prepared.preflight_id).state).toBe("admitted");
    const authority = new BillingAuthority({ control: f.control, root: f.root,
      clock: f.control.clock, source: { read: async () => f.facts } });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    const limits = { per_job_micro_usd: 100, user_daily_micro_usd: 500, time_zone: "UTC" };
    const reserve = () => f.spending.reserve({ account_id: f.account_id, job_id: randomUUID(), dispatch_key: "reasoning",
      stage: "reasoning", reserved_micro_usd: 3, provider: "synthetic", model: "SYNTHETIC-model",
      price_version: "SYNTHETIC-price", request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
    const reservations = [reserve(), reserve()];
    const proofBefore = f.control.db.prepare("SELECT * FROM control_billing_reservation ORDER BY call_id").all();
    expect(proofBefore).toHaveLength(2);
    for (const row of reservations) children.push(contender({ root: f.root, call_id: row.call_id,
      now: f.control.clock().toISOString(), limits }));
    await Promise.all(children.map((c) => c.wait("ready")));
    for (const c of children) c.child.send("mark");
    const results = await Promise.all(children.map((c) => c.wait("result")));
    expect(results.filter((result) => result.state === "dispatched")).toHaveLength(1);
    expect(results.filter((result) => result.state === "refused")).toHaveLength(1);
    expect(await Promise.all(children.map((c) => c.closed))).toEqual([0, 0]);
    const marked = results.find((result) => result.state === "dispatched")!.call_id!;
    const waiting = reservations.find((row) => row.call_id !== marked)!;
    expect(f.spending.serviceBarrier()).toEqual({ paused: true, reason: "usage_pending" });
    expect(f.spending.settleKnown(marked, 2).state).toBe("settled");
    expect(f.spending.mark(waiting.call_id, limits).state).toBe("dispatched");
    expect(f.control.db.prepare("SELECT * FROM control_billing_reservation ORDER BY call_id").all()).toEqual(proofBefore);
  } finally {
    await Promise.all(children.map(async (c) => {
      if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill();
      await c.closed;
    }));
    f.close();
  }
}, 60_000);
