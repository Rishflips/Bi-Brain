import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { installBillingMoney5 } from "../../packages/storage/billing-install.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";

// Independent user-visible boundary: installing non-funding billing must not lock
// knowledge behind payment, keys or the deferred offline enrollment operation.
const ORIGIN = "https://brain.synthetic.invalid";
const clock = () => new Date("2027-01-31T12:00:00.000Z");
function root() {
  const base = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Temp", "opencode") : tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "brain-billing-knowledge-parent-"));
}

it("an existing schema-1 tenant retains real authenticated capture and retrieval after non-funding install", async () => {
  const path = root();
  const runtime = new ManagedRuntime(path, { clock });
  new ManagedSpendingStore(runtime.control, clock);
  const app = await createApp(undefined, { managed: runtime, publicOrigin: ORIGIN, static: false });
  try {
    const account = runtime.provision("https://synthetic.invalid", "SYNTHETIC-existing-knowledge-owner");
    const markerPath = join(path, account.id, "provisioned.json");
    const originalMarker = readFileSync(markerPath, "utf8");
    expect(JSON.parse(originalMarker).schema).toBe(1);
    const session = runtime.control.issueSession(account.id);
    const headers = { host: "brain.synthetic.invalid", origin: ORIGIN,
      cookie: `brain_session=${session.token}`, "x-brain-csrf": session.csrf };
    const capture = await app.inject({ method: "POST", url: "/api/v1/sources", headers,
      payload: { project_id: "inbox", title: "SYNTHETIC original", body: "SYNTHETIC saved before billing installation." } });
    expect(capture.statusCode).toBe(201);
    const source = capture.json().source_id as string;
    installBillingMoney5({ root: path, control: runtime.control, offline: true, workers_terminated: true });
    expect(readFileSync(markerPath, "utf8")).toBe(originalMarker);
    const retained = await app.inject({ method: "GET", url: `/api/v1/sources/${source}`, headers });
    expect(retained.statusCode).toBe(200);
    expect(retained.body).toContain("SYNTHETIC saved before billing installation.");
    const after = await app.inject({ method: "POST", url: "/api/v1/sources", headers,
      payload: { project_id: "inbox", title: "SYNTHETIC next capture", body: "SYNTHETIC saved without paying or enrolling." } });
    expect(after.statusCode).toBe(201);
    expect(existsSync(join(path, ".protected", "billing-authority.key"))).toBe(false);
    expect(runtime.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_account").get()).toMatchObject({ n: 0 });
    expect(runtime.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_log").get()).toMatchObject({ n: 0 });
  } finally {
    await app.close(); runtime.close();
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("a new v5 tenant gets one durable incarnation without funding authority or a protected key", () => {
  const path = root();
  const runtime = new ManagedRuntime(path, { clock });
  new ManagedSpendingStore(runtime.control, clock);
  try {
    installBillingMoney5({ root: path, control: runtime.control, offline: true, workers_terminated: true });
    const account = runtime.provision("https://synthetic.invalid", "SYNTHETIC-new-v5-owner");
    const marker = JSON.parse(readFileSync(join(path, account.id, "provisioned.json"), "utf8"));
    const row = runtime.control.db.prepare("SELECT incarnation,provisioning_generation FROM managed_account_incarnation WHERE account_id=?")
      .get(account.id) as { incarnation: string; provisioning_generation: number };
    expect(marker).toMatchObject({ schema: 2, account_id: account.id, issuer: account.issuer,
      subject: account.subject, incarnation: row.incarnation, provisioning_generation: 1 });
    expect(row.incarnation).toMatch(/^[a-f0-9]{64}$/);
    expect(row.provisioning_generation).toBe(1);
    expect(runtime.provision(account.issuer, account.subject).id).toBe(account.id);
    expect(runtime.control.db.prepare("SELECT incarnation,provisioning_generation FROM managed_account_incarnation WHERE account_id=?").get(account.id))
      .toEqual(row);
    expect(runtime.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_account").get()).toMatchObject({ n: 0 });
    expect(existsSync(join(path, ".protected", "billing-authority.key"))).toBe(false);
    const handle = runtime.acquire(account.id);
    try {
      const saved = handle.brain.capture(handle.brain.ownerPrincipal(), { project_id: "inbox",
        title: "SYNTHETIC unpaid", body: "SYNTHETIC knowledge remains available." });
      expect(saved.source_id).toBeTruthy();
    } finally { handle.release(); }
  } finally {
    runtime.close(); rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
