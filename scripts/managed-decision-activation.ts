import { isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "../packages/storage/control.ts";
import {
  ManagedDecisionActivationStore,
  readDecisionActivationMirror,
  readDecisionActivationRow,
} from "../packages/storage/managed-decision-activation.ts";
import {
  assertTrustedManagedRoot,
  readBoundedRegularFile,
} from "../packages/runtime/managed-operator.ts";
import { validateDecisionOperatorInput } from "../packages/domain/managed-decision-activation.ts";
import { canonical } from "../packages/domain/logic.ts";

/**
 * Trusted offline CLI for the separate, default-off decision activation profile.
 * Read-only commands open a genuine read-only control handle and create nothing;
 * `enable` requires --offline/--workers-terminated and a current valid schema audit.
 */

const MAX_INPUT_BYTES = 256 * 1024;
const ARITY: Record<string, number> = { status: 0, show: 0, enable: 1, disable: 0 };

function fail(message: string): never {
  process.stderr.write(`managed-decision-activation: ${message}\n`);
  process.exit(1);
}

function rootAndControl(): { root: string; controlPath: string } {
  const raw = process.env.BRAIN_MANAGED_ROOT;
  if (!raw || !isAbsolute(raw)) fail("Set BRAIN_MANAGED_ROOT to one existing absolute managed root.");
  const root = resolve(raw!);
  let binding;
  try {
    binding = assertTrustedManagedRoot(root);
  } catch {
    fail("The managed root is not a trusted, initialized managed root.");
  }
  return { root, controlPath: binding!.controlPath };
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || !(command in ARITY)) fail("Unknown command.");
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
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) fail("--expected-version requires a nonnegative integer.");
      expectedVersion = Number(raw);
      if (!Number.isSafeInteger(expectedVersion)) fail("--expected-version is out of range.");
    } else if (arg.startsWith("--")) fail("Unknown flag.");
    else positional.push(arg);
  }
  if (positional.length !== ARITY[command]!) fail(`Expected ${ARITY[command]} argument(s) for ${command}.`);
  if (command === "enable") {
    if (!offline || !terminated) fail("enable requires --offline and --workers-terminated.");
    if (expectedVersion !== null) fail("enable accepts no --expected-version.");
  } else if (command === "disable") {
    if (offline || terminated) fail("disable accepts no offline flags.");
    if (expectedVersion === null) fail("disable requires --expected-version.");
  } else if (offline || terminated || expectedVersion !== null) {
    fail("This command accepts no flags.");
  }

  const { root, controlPath } = rootAndControl();
  if (command === "status" || command === "show") {
    const db = new DatabaseSync(controlPath, { readOnly: true });
    try {
      const has = db.prepare("SELECT 1 AS p FROM sqlite_master WHERE type='table' AND name='managed_decision_activation'").get();
      if (!has) {
        console.log(JSON.stringify({ command, mode: "managed", profile: "absent", version: 0, effective: "off" }));
        return;
      }
      let row;
      try {
        row = readDecisionActivationRow(db);
      } catch {
        row = null;
      }
      let mirror;
      try {
        mirror = readDecisionActivationMirror(root);
      } catch {
        mirror = null;
      }
      // Genuine readonly comparison: both absent => absent; one side missing or any
      // field (including order) differing, or malformed => mismatch (never "present").
      const profile =
        row === undefined && mirror === undefined
          ? "absent"
          : row && mirror && canonical(row) === canonical(mirror)
            ? "present"
            : "mismatch";
      console.log(
        JSON.stringify({
          command,
          mode: "managed",
          profile,
          version: row?.version ?? 0,
          enabled: row?.enabled === true,
          // S1 has no readiness writer, so decision processing is never live for a
          // present profile; an absent profile is simply off.
          effective: profile === "absent" ? "off" : "unavailable",
          ...(command === "show" && row
            ? { provider: row.provider, model: row.model, endpoint: row.endpoint }
            : {}),
        }),
      );
    } finally {
      db.close();
    }
    return;
  }

  if (command === "enable") {
    const file = positional[0]!;
    if (!isAbsolute(file) || !existsSync(file)) fail("enable requires one existing absolute profile JSON file.");
    const text = readBoundedRegularFile(file, MAX_INPUT_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail("The profile file is not valid JSON.");
    }
    const operator = validateDecisionOperatorInput(parsed);
    const control = new ControlStore(controlPath, () => new Date());
    try {
      const store = new ManagedDecisionActivationStore(control, root, control.clock);
      const profile = store.enable(operator, { offline: true, workers_terminated: true });
      console.log(JSON.stringify({ command, version: profile.version, enabled: profile.enabled }));
    } finally {
      control.close();
    }
    return;
  }

  const control = new ControlStore(controlPath, () => new Date());
  try {
    const store = new ManagedDecisionActivationStore(control, root, control.clock);
    const result = store.disable(expectedVersion!);
    console.log(JSON.stringify({ command, disabled: true, version: result.version }));
  } finally {
    control.close();
  }
}

try {
  main();
} catch {
  // Static, content-free refusal: never echo a raw error/message/table/path.
  fail("The managed decision activation command was denied.");
}
