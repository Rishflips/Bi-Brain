import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBillingAuthorityFixture } from "../helpers/billing-authority-fixture.ts";

// Actual competing Node processes; all observations/keys/accounts remain SYNTHETIC.
const childSource = `
import { join } from 'node:path';
import { ControlStore } from './packages/storage/control.ts';
import { BillingAuthority } from './packages/storage/billing-authority.ts';
const args = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
const clock = () => new Date(args.now);
const control = new ControlStore(join(args.root, 'control.sqlite'), clock);
let finishRead;
const source = {read: async () => {
  const answer = new Promise(resolve => {finishRead = resolve;});
  process.send({type:'reading'});
  return answer;
}};
const authority = new BillingAuthority({control, root:args.root, source, clock});
process.on('message', async message => {
  if (message === 'finish') {finishRead(args.facts); return;}
  if (message !== 'start') return;
  try {
    const result = await authority.reconcile(args.account_id);
    process.send({type:'outcome', state:result.state});
  } catch (error) {
    process.send({type:'outcome', state:'refused', code:typeof error?.code === 'string' ? error.code : 'ERROR',
      reason:error instanceof Error ? error.message : 'Synthetic child refused'});
  } finally {
    control.close();
    process.disconnect();
  }
});
process.send({type:'ready'});
`;

function actor(input: unknown) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "ComSpec", "PATH", "Path", "PATHEXT", "USERPROFILE", "HOME"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (process.platform === "win32") {
    env.TEMP = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Temp", "opencode");
    env.TMP = env.TEMP;
  }
  const child = spawn(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childSource,
      Buffer.from(JSON.stringify(input)).toString("base64url")],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-4000); });
  child.stdout!.resume();
  const closed = new Promise<number | null>((resolve) => { child.once("close", (code) => resolve(code)); });
  const waiters = new Map<string, (value: { type: string; state?: string }) => void>();
  const received = new Map<string, { type: string; state?: string }>();
  child.on("message", (value) => {
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return;
    const message = value as { type: string; state?: string };
    received.set(message.type, message); waiters.get(message.type)?.(message);
  });
  async function waitFor(type: string) {
    if (received.has(type)) return received.get(type)!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<{ type: string; state?: string }>((resolve) => { waiters.set(type, resolve); }),
        closed.then(() => { throw new Error(`Synthetic contender closed before ${type}: ${stderr}`); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Synthetic contender timed out at ${type}`)), 20_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); waiters.delete(type); }
  }
  return { child, closed, waitFor };
}

async function stop(child: ChildProcess, closed: Promise<number | null>) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await closed;
}

it("two actual processes publishing the same paid window create one period and one grant", async () => {
  const f = createBillingAuthorityFixture();
  const initial = Number((f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_log").get() as { n: number }).n);
  const input = { root: f.root, account_id: f.account_id, now: "2027-01-31T12:00:00.000Z", facts: f.facts };
  const contenders: ReturnType<typeof actor>[] = [];
  try {
    contenders.push(actor(input), actor(input));
    await Promise.all(contenders.map((a) => a.waitFor("ready")));
    for (const a of contenders) a.child.send("start");
    // Both hold the same pre-read snapshot before either receives the synthetic response.
    await Promise.all(contenders.map((a) => a.waitFor("reading")));
    for (const a of contenders) a.child.send("finish");
    const results = await Promise.all(contenders.map((a) => a.waitFor("outcome")));
    expect(results.some((result) => result.state === "granted")).toBe(true);
    expect(await Promise.all(contenders.map((a) => a.closed))).toEqual([0, 0]);
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_account_periods").get()).toMatchObject({ n: 1 });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_period").get()).toMatchObject({ n: 1 });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_terms").get()).toMatchObject({ n: 1 });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_log").get()).toMatchObject({ n: initial + 1 });
    expect(f.authority.billingEligibility(f.account_id).state).toBe("granted");
  } finally {
    await Promise.all(contenders.map((a) => stop(a.child, a.closed)));
    f.close();
  }
}, 60_000);

it("an adverse result committed by another process fences an older delayed active result", async () => {
  const f = createBillingAuthorityFixture();
  const contenders: ReturnType<typeof actor>[] = [];
  try {
    await f.authority.reconcile(f.account_id);
    const input = { root: f.root, account_id: f.account_id, now: "2027-01-31T12:00:00.000Z", facts: f.facts };
    const old = actor(input);
    contenders.push(old);
    const adverse = actor({ ...input, facts: { ...f.facts, current_state: "past_due", completed_payment: false } });
    contenders.push(adverse);
    await Promise.all(contenders.map((a) => a.waitFor("ready")));
    for (const a of contenders) a.child.send("start");
    await Promise.all(contenders.map((a) => a.waitFor("reading")));
    adverse.child.send("finish");
    expect(await adverse.waitFor("outcome")).toMatchObject({ state: "denied" });
    expect(await adverse.closed).toBe(0);
    old.child.send("finish");
    expect((await old.waitFor("outcome")).state).toBe("refused");
    expect(await old.closed).toBe(0);
    expect(f.authority.billingEligibility(f.account_id).state).toBe("unavailable");
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_account_periods").get()).toMatchObject({ n: 1 });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_denials").get()).toMatchObject({ n: 1 });
  } finally {
    await Promise.all(contenders.map((a) => stop(a.child, a.closed)));
    f.close();
  }
}, 60_000);
