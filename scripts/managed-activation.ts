import { isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "../packages/storage/control.ts";
import { ManagedSpendingStore } from "../packages/storage/managed-spending.ts";
import { ManagedActivationStore } from "../packages/storage/managed-activation.ts";
import {
  assertTrustedManagedRoot,
  readBoundedRegularFile,
} from "../packages/runtime/managed-operator.ts";
import {
  evaluateConfiguredPolicy,
  readActivationState,
} from "../packages/runtime/managed-activation.ts";
import { validateManagedAudit } from "../packages/runtime/managed-audit.ts";
import { validateActivationOperatorInput } from "../packages/domain/managed-activation.ts";
import { BrainError } from "../packages/domain/logic.ts";

/**
 * Trusted offline operator CLI for the shared managed provider activation policy.
 *
 * It runs on the server filesystem against one explicit, already-initialized
 * managed root (`BRAIN_MANAGED_ROOT`). Read-only commands open a genuine read-only
 * control handle and never create money tables, an epoch, an account or a marker.
 * `enable` requires `--offline` and `--workers-terminated` and a current valid
 * schema-3 audit; `disable` is immediate (no offline precondition) and always
 * allowed. It never contacts a provider and never prints a secret or a raw path.
 *
 * Usage:
 *   managed:activation status
 *   managed:activation show
 *   managed:activation enable <profile-json-file> --offline --workers-terminated
 *   managed:activation disable --expected-version <n>
 */

const MAX_INPUT_BYTES = 256 * 1024;
const ARITY: Record<string, number> = {
  status: 0,
  show: 0,
  enable: 1,
  disable: 0,
};

function fail(message: string): never {
  process.stderr.write(`managed-activation: ${message}\n`);
  process.exit(1);
}

function rootAndControl(): { root: string; controlPath: string } {
  const rootRaw = process.env.BRAIN_MANAGED_ROOT;
  if (!rootRaw || !isAbsolute(rootRaw))
    fail("Set BRAIN_MANAGED_ROOT to one existing absolute managed root.");
  const root = resolve(rootRaw!);
  let binding;
  try {
    binding = assertTrustedManagedRoot(root);
  } catch {
    fail("The managed root is not a trusted, initialized managed root.");
  }
  return { root, controlPath: binding!.controlPath };
}

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  offline: boolean;
  terminated: boolean;
  expectedVersion: number | null;
} {
  const command = argv[0];
  if (!command || !(command in ARITY)) fail("Unknown managed-activation command.");
  const positional: string[] = [];
  let offline = false;
  let terminated = false;
  let expectedVersion: number | null = null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--offline") {
      if (offline) fail("Duplicate --offline flag.");
      offline = true;
    } else if (arg === "--workers-terminated") {
      if (terminated) fail("Duplicate --workers-terminated flag.");
      terminated = true;
    } else if (arg === "--expected-version") {
      if (expectedVersion !== null) fail("Duplicate --expected-version flag.");
      const raw = argv[++i];
      if (typeof raw !== "string" || !/^\d+$/.test(raw))
        fail("--expected-version requires a nonnegative integer.");
      const value = Number(raw);
      if (!Number.isSafeInteger(value))
        fail("--expected-version is out of range.");
      expectedVersion = value;
    } else if (arg.startsWith("--")) fail("Unknown flag.");
    else positional.push(arg);
  }
  if (positional.length !== ARITY[command]!)
    fail(`Expected ${ARITY[command]} argument(s) for ${command}.`);
  if (command === "enable") {
    if (!offline || !terminated)
      fail("enable requires --offline and --workers-terminated.");
    if (expectedVersion !== null) fail("enable accepts no --expected-version.");
  } else if (command === "disable") {
    if (offline || terminated) fail("disable accepts no offline flags.");
    if (expectedVersion === null) fail("disable requires --expected-version.");
  } else if (offline || terminated || expectedVersion !== null) {
    fail("This command accepts no flags.");
  }
  return { command, positional, offline, terminated, expectedVersion };
}

function optIn(): boolean {
  return (process.env.BRAIN_MANAGED_ALLOW_PAID ?? "").trim() === "1";
}

function statusView(root: string, controlPath: string) {
  const db = new DatabaseSync(controlPath, { readOnly: true });
  try {
    let epoch: number | null = null;
    if (
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='managed_control_epoch'")
        .get()
    ) {
      const row = db
        .prepare("SELECT epoch FROM managed_control_epoch WHERE singleton=1")
        .get() as { epoch: number } | undefined;
      epoch = row ? Number(row.epoch) : null;
    }
    const control = { db, path: controlPath };
    const state = readActivationState(control, root);
    const profile =
      state.state === "active"
        ? state.profile
        : state.state === "absent"
          ? undefined
          : null;
    const reason =
      profile === null
        ? "profile_invalid"
        : evaluateConfiguredPolicy({
            control,
            root,
            now: new Date(),
            optIn: optIn(),
            profile: profile ?? undefined,
          }).reason;
    const kind =
      state.state === "mismatch"
        ? "mismatch"
        : !profile
          ? "absent"
          : profile.enabled
            ? "enabled"
            : "disabled";
    return {
      command: "status",
      mode: "managed",
      profile: kind,
      version: profile?.version ?? 0,
      epoch,
      fingerprint: profile?.fingerprint ?? null,
      config_digest: profile?.config_digest ?? null,
      reason,
    };
  } finally {
    db.close();
  }
}

function main(): void {
  const { command, positional, expectedVersion } = parseArgs(process.argv.slice(2));
  const { root, controlPath } = rootAndControl();
  if (command === "status" || command === "show") {
    console.log(JSON.stringify(statusView(root, controlPath)));
    return;
  }
  if (command === "enable") {
    const file = positional[0]!;
    if (!isAbsolute(file) || !existsSync(file))
      fail("enable requires one existing absolute profile JSON file.");
    const text = readBoundedRegularFile(file, MAX_INPUT_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail("The profile file is not valid JSON.");
    }
    const operator = validateActivationOperatorInput(parsed);
    const control = new ControlStore(controlPath, () => new Date());
    try {
      // Explicit schema-3 migration before any audit/enrollment.
      void new ManagedSpendingStore(control, control.clock);
      const validation = validateManagedAudit({
        control: { db: control.db, path: control.path },
        root,
        auditId: operator.audit_id,
      });
      if (!validation.valid)
        fail(
          "The chosen audit is not a current valid schema-3 enrollment audit; run managed:reconcile audit-history first.",
        );
      const store = new ManagedActivationStore(control, root, control.clock);
      const profile = store.enable(operator, {
        offline: true,
        workers_terminated: true,
      });
      console.log(
        JSON.stringify({
          command: "enable",
          version: profile.version,
          epoch: profile.epoch,
          fingerprint: profile.fingerprint,
          config_digest: profile.config_digest,
          audit_id: profile.audit_id,
        }),
      );
    } finally {
      control.close();
    }
    return;
  }
  // disable
  const control = new ControlStore(controlPath, () => new Date());
  try {
    const store = new ManagedActivationStore(control, root, control.clock);
    const result = store.disable(expectedVersion!);
    console.log(
      JSON.stringify({ command: "disable", disabled: true, version: result.version }),
    );
  } finally {
    control.close();
  }
}

const SAFE_MESSAGE = /^[A-Za-z0-9 .,;'()\-]{1,200}$/;
try {
  main();
} catch (error) {
  // Only our own content-free BrainError messages may be echoed. A raw OS or
  // SQLite error can contain a private path or trigger text, so it is replaced
  // with a fixed safe refusal.
  const raw =
    error instanceof BrainError && typeof error.message === "string"
      ? error.message
      : "";
  fail(
    raw && SAFE_MESSAGE.test(raw)
      ? raw
      : "The managed activation command was denied.",
  );
}
