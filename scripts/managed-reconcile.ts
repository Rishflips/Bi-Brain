import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "../packages/storage/control.ts";
import { ManagedSpendingStore } from "../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../packages/storage/managed-reconciliation.ts";
import {
  assertTrustedManagedRoot,
  readBoundedRegularFile,
} from "../packages/runtime/managed-operator.ts";
import {
  auditManagedHistory,
  validateManagedAudit,
} from "../packages/runtime/managed-audit.ts";

/**
 * Trusted offline managed reconciliation CLI.
 *
 * It runs on the server filesystem against one explicit existing absolute
 * managed root (`BRAIN_MANAGED_ROOT`). Read-only commands (`status`, `inspect`,
 * `validate-audit`) open the control database through a genuine read-only handle
 * and never create money tables, an epoch or a credential. Mutating commands
 * require both `--offline` and `--workers-terminated`, which are a precondition
 * that all writers are stopped, not a programmatic quiescence proof.
 *
 * Usage:
 *   managed:reconcile status
 *   managed:reconcile inspect <call_id>
 *   managed:reconcile validate-audit <audit_id>
 *   managed:reconcile init-epoch --offline --workers-terminated
 *   managed:reconcile attest-settled <attestation.json> --offline --workers-terminated
 *   managed:reconcile attest-zero <attestation.json> --offline --workers-terminated
 *   managed:reconcile audit-history --offline --workers-terminated
 *   managed:reconcile suspend <account_id> --offline --workers-terminated
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INPUT_BYTES = 256 * 1024;

const ARITY: Record<string, number> = {
  status: 0,
  inspect: 1,
  "validate-audit": 1,
  "init-epoch": 0,
  "attest-settled": 1,
  "attest-zero": 1,
  "audit-history": 0,
  suspend: 1,
};
const MUTATING = new Set([
  "init-epoch",
  "attest-settled",
  "attest-zero",
  "audit-history",
  "suspend",
]);

function fail(message: string): never {
  process.stderr.write(`managed-reconcile: ${message}\n`);
  process.exit(1);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function controlSchemaOk(path: string): boolean {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return false;
  }
  try {
    if (!tableExists(db, "managed_accounts")) return false;
    const columns = (
      db.prepare("PRAGMA table_info(managed_accounts)").all() as { name: string }[]
    ).map((column) => column.name);
    return ["id", "issuer", "subject", "state"].every((c) => columns.includes(c));
  } catch {
    return false;
  } finally {
    db.close();
  }
}

interface PauseView {
  paused: boolean;
  reason: "usage_pending" | "awaiting_accounting" | null;
}

function pauseView(db: DatabaseSync): PauseView {
  const blocked =
    (tableExists(db, "managed_money_blocks") &&
      !!db.prepare("SELECT 1 AS present FROM managed_money_blocks LIMIT 1").get()) ||
    (tableExists(db, "managed_service_blocks") &&
      !!db.prepare("SELECT 1 AS present FROM managed_service_blocks LIMIT 1").get());
  if (blocked) return { paused: true, reason: "awaiting_accounting" };
  if (
    tableExists(db, "managed_reservations") &&
    db
      .prepare("SELECT 1 AS present FROM managed_reservations WHERE state='dispatched' LIMIT 1")
      .get()
  )
    return { paused: true, reason: "usage_pending" };
  return { paused: false, reason: null };
}

function statusView(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const accounts = (
      db.prepare("SELECT id,state FROM managed_accounts ORDER BY id").all() as {
        id: string;
        state: string;
      }[]
    ).map((account) => ({ account_id: account.id, state: account.state }));
    let epoch: number | null = null;
    if (tableExists(db, "managed_control_epoch")) {
      const row = db
        .prepare("SELECT epoch FROM managed_control_epoch WHERE singleton=1")
        .get() as { epoch: number } | undefined;
      epoch = row ? Number(row.epoch) : null;
    }
    const pause = pauseView(db);
    return {
      command: "status",
      mode: "managed",
      epoch,
      accounts,
      paused: pause.paused,
      paused_reason: pause.reason,
    };
  } finally {
    db.close();
  }
}

function inspectView(path: string, callId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!tableExists(db, "managed_reservations")) fail("Unknown managed dispatch.");
    const row = db
      .prepare(
        "SELECT call_id,account_id,state,reserved_micro_usd,actual_micro_usd,reconciliation_required,created_at,marked_at,settled_at,identity_hash,content_hash,account_period_id,provider,model,price_version,request_hash,config_hash,service_day,user_day,accounting_tz FROM managed_reservations WHERE call_id=?",
      )
      .get(callId) as any;
    if (!row) fail("Unknown managed dispatch.");
    let resolution_id: string | null = null;
    if (tableExists(db, "managed_resolutions")) {
      const resolution = db
        .prepare("SELECT resolution_id FROM managed_resolutions WHERE call_id=? ORDER BY decided_at DESC LIMIT 1")
        .get(callId) as { resolution_id: string } | undefined;
      resolution_id = resolution?.resolution_id ?? null;
    }
    let epoch: number | null = null;
    if (tableExists(db, "managed_control_epoch")) {
      const epochRow = db
        .prepare("SELECT epoch FROM managed_control_epoch WHERE singleton=1")
        .get() as { epoch: number } | undefined;
      epoch = epochRow ? Number(epochRow.epoch) : null;
    }
    return {
      command: "inspect",
      call_id: String(row.call_id),
      account_id: String(row.account_id),
      state: String(row.state),
      reserved_micro_usd: Number(row.reserved_micro_usd),
      actual_micro_usd:
        row.actual_micro_usd === null || row.actual_micro_usd === undefined
          ? null
          : Number(row.actual_micro_usd),
      reconciliation_required: Number(row.reconciliation_required) === 1,
      created_at: String(row.created_at),
      marked_at: row.marked_at ?? null,
      settled_at: row.settled_at ?? null,
      // Curated immutable financial identity for one exact typed attestation.
      // Never a request body, actor, key, evidence or source text.
      identity_hash: String(row.identity_hash),
      content_hash: String(row.content_hash),
      account_period_id: String(row.account_period_id),
      provider: String(row.provider),
      model: String(row.model),
      price_version: String(row.price_version),
      request_hash: String(row.request_hash),
      config_hash: String(row.config_hash),
      service_day: String(row.service_day),
      user_day: String(row.user_day),
      accounting_tz: String(row.accounting_tz),
      epoch,
      resolution_id,
    };
  } finally {
    db.close();
  }
}

function validateAuditView(
  path: string,
  root: string,
  auditId: string,
  clock: () => Date,
) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = validateManagedAudit({
      control: { db, path },
      root,
      auditId,
      clock,
    });
    return {
      command: "validate-audit",
      audit_id: auditId,
      valid: result.valid,
      reason: result.reason,
    };
  } finally {
    db.close();
  }
}

// ---- Validate every argument before touching the filesystem or the runtime ----
const argv = process.argv.slice(2);
const command = argv[0];
if (!command || !(command in ARITY)) fail("Unknown managed-reconcile command.");
const positional: string[] = [];
let offline = false;
let terminated = false;
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--offline") {
    if (offline) fail("Duplicate --offline flag.");
    offline = true;
  } else if (arg === "--workers-terminated") {
    if (terminated) fail("Duplicate --workers-terminated flag.");
    terminated = true;
  } else if (arg.startsWith("--")) fail("Unknown flag.");
  else positional.push(arg);
}
if (positional.length !== ARITY[command])
  fail(`Expected ${ARITY[command]} argument(s) for ${command}.`);
if (MUTATING.has(command)) {
  if (!offline || !terminated)
    fail("Mutating commands require --offline and --workers-terminated.");
} else if (offline || terminated) {
  fail("Read-only commands accept no flags.");
}

const rootRaw = process.env.BRAIN_MANAGED_ROOT;
if (!rootRaw || !isAbsolute(rootRaw))
  fail("Set BRAIN_MANAGED_ROOT to one existing absolute managed root.");
const root = resolve(rootRaw!);
let controlPath: string;
try {
  controlPath = assertTrustedManagedRoot(root).controlPath;
} catch {
  fail("The managed root is not a trusted, initialized managed root.");
}
if (!controlSchemaOk(controlPath!))
  fail("The managed root does not contain a Bi Brain control database.");

const clock = () => new Date();

function main(): void {
  if (command === "status") {
    console.log(JSON.stringify(statusView(controlPath!)));
    return;
  }
  if (command === "inspect") {
    const callId = positional[0]!;
    if (!UUID.test(callId)) fail("inspect requires a call UUID.");
    console.log(JSON.stringify(inspectView(controlPath!, callId)));
    return;
  }
  if (command === "validate-audit") {
    const auditId = positional[0]!;
    if (!UUID.test(auditId)) fail("validate-audit requires an audit UUID.");
    const result = validateAuditView(controlPath!, root, auditId, clock);
    console.log(JSON.stringify(result));
    if (!result.valid) process.exitCode = 1;
    return;
  }

  const ack = { offline: true as const, workers_terminated: true as const };
  const control = new ControlStore(controlPath!, clock);
  try {
    if (command === "init-epoch") {
      const epoch = new ManagedReconciliationStore(control, root, clock).initEpoch(ack);
      console.log(JSON.stringify({ command, epoch: epoch.epoch }));
      return;
    }
    if (command === "attest-settled" || command === "attest-zero") {
      const path = positional[0]!;
      const text = readBoundedRegularFile(path, MAX_INPUT_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        fail("The attestation file is not valid JSON.");
      }
      const recon = new ManagedReconciliationStore(control, root, clock);
      const resolution =
        command === "attest-settled"
          ? recon.attestSettled(parsed, ack)
          : recon.attestZero(parsed, ack);
      console.log(
        JSON.stringify({
          command,
          resolution_id: resolution.resolution_id,
          kind: resolution.kind,
          cost_micro_usd: resolution.cost_micro_usd,
          currency: resolution.currency,
          epoch: resolution.epoch,
        }),
      );
      return;
    }
    if (command === "audit-history") {
      void new ManagedSpendingStore(control, clock);
      const result = auditManagedHistory({
        control,
        root,
        offline: true,
        workers_terminated: true,
        clock,
      });
      if (!result.ok) fail(`Audit denied: ${result.reason}.`);
      console.log(
        JSON.stringify({
          command,
          audit_id: result.audit_id,
          evidence: result.evidence,
          root_epoch: result.inventory.root_epoch,
          accounts: result.inventory.accounts.length,
        }),
      );
      return;
    }
    if (command === "suspend") {
      const accountId = positional[0]!;
      if (!UUID.test(accountId)) fail("suspend requires an account UUID.");
      control.setAccountState(accountId, "suspended");
      console.log(JSON.stringify({ command, account_id: accountId, state: "suspended" }));
      return;
    }
  } finally {
    control.close();
  }
}

try {
  main();
} catch {
  // Never print a stack, a private path or untrusted content.
  fail("The managed operator command was denied.");
}
