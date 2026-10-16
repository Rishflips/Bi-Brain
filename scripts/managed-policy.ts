import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../packages/storage/managed-spending.ts";

/**
 * Trusted operator CLI for managed spending policy. It runs on the server
 * filesystem only, against one explicit, already-initialized managed root, and
 * never creates accounts, contacts a model, accepts a browser-supplied grant, or
 * mutates anything before every argument and the target database are validated.
 *
 * Usage (BRAIN_MANAGED_ROOT must point at an existing managed root that already
 * contains a real control.sqlite):
 *   managed:policy set-service <daily_micro_usd>
 *   managed:policy configure-period <account_id> <starts_at> <ends_at> <allowance_micro_usd>
 *   managed:policy set-account <account_id> <per_job_micro_usd> <user_daily_micro_usd>
 *   managed:policy revoke-period <period_id>
 */

const USAGE =
  "Usage: managed-policy <set-service|configure-period|set-account|revoke-period> ...";
const ARITY: Record<string, number> = {
  "set-service": 1,
  "configure-period": 4,
  "set-account": 3,
  "revoke-period": 1,
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseMicro(value: string | undefined, field: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    fail(`${field} must be a nonnegative integer micro-USD amount.`);
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) fail(`${field} is out of range.`);
  return amount;
}

function parseUuid(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !UUID.test(value))
    fail(`${field} must be a UUID.`);
  return value!;
}

function parseInstant(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value)))
    fail(`${field} must be an ISO 8601 date-time with an explicit Z or offset.`);
  return value!;
}

function realDirectory(path: string, message: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(message);
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(message);
}

/**
 * Rejects anything that is not an already-initialized Bi Brain control database,
 * using a read-only preflight, before the runtime can create or rewrite tables.
 */
function assertControlDatabase(path: string): void {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    fail("The managed root has no readable control database; run managed setup first.");
    return;
  }
  let ok = true;
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='managed_accounts'",
      )
      .get();
    if (!table) ok = false;
    else {
      const columns = (
        db.prepare("PRAGMA table_info(managed_accounts)").all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      for (const required of ["id", "issuer", "subject", "state"])
        if (!columns.includes(required)) ok = false;
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    fail(
      "The managed root does not contain a Bi Brain control database; refusing to change it.",
    );
    return;
  }
}

// ---- Validate everything before touching the filesystem or the runtime. ----
const [op, ...args] = process.argv.slice(2);
if (!op || !(op in ARITY)) fail(USAGE);
if (args.length !== ARITY[op]!) fail(`${USAGE}\nExpected ${ARITY[op]} argument(s) for ${op}.`);

let validated: Record<string, unknown>;
if (op === "set-service") {
  validated = { daily_micro_usd: parseMicro(args[0], "daily_micro_usd") };
} else if (op === "configure-period") {
  const starts = parseInstant(args[1], "starts_at");
  const ends = parseInstant(args[2], "ends_at");
  if (Date.parse(ends) <= Date.parse(starts)) fail("The period must end after it starts.");
  validated = {
    account_id: parseUuid(args[0], "account_id"),
    starts_at: starts,
    ends_at: ends,
    allowance_micro_usd: parseMicro(args[3], "allowance_micro_usd"),
  };
} else if (op === "set-account") {
  validated = {
    account_id: parseUuid(args[0], "account_id"),
    per_job_micro_usd: parseMicro(args[1], "per_job_micro_usd"),
    user_daily_micro_usd: parseMicro(args[2], "user_daily_micro_usd"),
  };
} else {
  validated = { period_id: parseUuid(args[0], "period_id") };
}

const rootRaw = process.env.BRAIN_MANAGED_ROOT;
if (!rootRaw || !isAbsolute(rootRaw))
  fail(
    "Set BRAIN_MANAGED_ROOT to one existing absolute managed root; there is no local default.",
  );
const root = resolve(rootRaw!);
realDirectory(root, "The managed root must be an existing real directory, not a link.");
const controlPath = join(root, "control.sqlite");
try {
  const stat = lstatSync(controlPath);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error("not a real file");
} catch {
  fail("The managed root has no real control.sqlite; run managed setup first.");
}
assertControlDatabase(controlPath);

// ---- Only now may the runtime open and the policy write happen. ----
const runtime = new ManagedRuntime(root);
try {
  const store = new ManagedSpendingStore(runtime.control);
  const emit = (value: unknown) => {
    console.log(JSON.stringify(value));
  };
  if (op === "set-service") {
    emit(store.setServicePolicy(validated as { daily_micro_usd: number }));
  } else if (op === "configure-period") {
    if (!runtime.control.account((validated as any).account_id))
      fail("Unknown managed account.");
    emit(store.configureAccountPeriod(validated));
  } else if (op === "set-account") {
    if (!runtime.control.account((validated as any).account_id))
      fail("Unknown managed account.");
    emit(store.setAccountPolicy(validated));
  } else {
    emit(store.revokeAccountPeriod((validated as any).period_id));
  }
} finally {
  runtime.close();
}
