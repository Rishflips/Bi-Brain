import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ControlStore } from "../packages/storage/control.ts";
import { DatabaseSync } from "node:sqlite";
import { enrollBillingAuthorityOffline } from "../packages/storage/billing-enrollment.ts";
import {
  restoreBillingKeyArchive,
  writeBillingKeyArchive,
} from "../packages/storage/billing-key-archive.ts";
import {
  hardenBillingWindowsAcl,
  verifyBillingWindowsAcl,
} from "../packages/storage/billing-windows-acl.ts";
import { billingSchemaVariant } from "../packages/storage/billing-schema.ts";
import {
  loadBillingContext,
  loadEnrollmentAnchor,
  paidTransportsAllowed,
} from "../packages/storage/billing-verify.ts";
import {
  assertNonLinkedPathChain,
  assertTrustedManagedRoot,
  readBoundedRegularFile,
} from "../packages/runtime/managed-operator.ts";
import { dirname } from "node:path";

/**
 * Explicit offline B0 billing operator CLI. It never creates a key, chooses money
 * limits, contacts a payment/model provider, or prints secret material.
 *
 * Usage:
 *   managed:billing enroll <audit_uuid> <policy_json_abs> <key_bin_abs> --offline --workers-terminated
 *   managed:billing key-backup <archive_abs> <passphrase_file_abs> --offline --workers-terminated
 *   managed:billing key-restore <archive_abs> <passphrase_file_abs> <commitment> --offline --workers-terminated
 *   managed:billing harden-acl --offline --workers-terminated
 *   managed:billing status
 *   managed:billing verify-acl
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ARITY: Record<string, number> = {
  enroll: 3,
  "key-backup": 2,
  "key-restore": 3,
  "harden-acl": 0,
  status: 0,
  "verify-acl": 0,
};
const MUTATING = new Set(["enroll", "key-backup", "key-restore", "harden-acl"]);

function fail(message: string): never {
  process.stderr.write(`managed-billing: ${message}\n`);
  process.exit(1);
}

function exactBinary(path: string, bytes: number): Uint8Array {
  if (!isAbsolute(path)) fail("The billing key file must be an absolute path.");
  const absolute = resolve(path);
  assertNonLinkedPathChain(dirname(absolute));
  const stat = lstatSync(absolute);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size !== bytes
  )
    fail(`The billing key file must be exactly ${bytes} raw bytes.`);
  return Uint8Array.from(readFileSync(absolute));
}

const argv = process.argv.slice(2);
const command = argv[0];
if (!command || !(command in ARITY)) fail("Unknown managed-billing command.");
let offline = false;
let terminated = false;
const positional: string[] = [];
for (const arg of argv.slice(1)) {
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
const root = resolve(rootRaw);
let controlPath: string;
try {
  controlPath = assertTrustedManagedRoot(root).controlPath;
} catch {
  fail("The managed root is not a trusted, initialized managed root.");
}

try {
  if (command === "status") {
    const db = new DatabaseSync(controlPath, { readOnly: true });
    try {
      const control = { db, path: controlPath };
      const variant = billingSchemaVariant(db);
      let enrollment = null;
      let authorityReady = false;
      try {
        enrollment = loadEnrollmentAnchor(control, root);
        if (enrollment) {
          loadBillingContext(control, root);
          if (process.platform === "win32") verifyBillingWindowsAcl(root);
          authorityReady = true;
        }
      } catch {
        authorityReady = false;
      }
      process.stdout.write(
        JSON.stringify({
          command,
          schema: variant,
          enrollment: enrollment
            ? "enrolled"
            : variant === "integrated"
              ? "unenrolled"
              : "legacy",
          mode: enrollment?.anchor.mode ?? null,
          authority_ready: authorityReady,
          paid_transports_allowed: paidTransportsAllowed(control, root),
        }),
      );
      if (enrollment && !authorityReady) process.exitCode = 1;
    } finally {
      db.close();
    }
  } else if (command === "verify-acl") {
    verifyBillingWindowsAcl(root);
    process.stdout.write(
      JSON.stringify({ command, verified: true, platform: process.platform }),
    );
  } else if (command === "harden-acl") {
    hardenBillingWindowsAcl(root);
    process.stdout.write(
      JSON.stringify({ command, verified: true, platform: process.platform }),
    );
  } else if (command === "key-backup") {
    const result = writeBillingKeyArchive({
      root,
      destination: positional[0]!,
      passphrase_file: positional[1]!,
      offline: true,
      workers_terminated: true,
    });
    process.stdout.write(
      JSON.stringify({
        command,
        key_commitment: result.key_commitment,
        encrypted: true,
      }),
    );
  } else if (command === "key-restore") {
    if (!HEX64.test(positional[2]!))
      fail("The expected key commitment is invalid.");
    const result = restoreBillingKeyArchive({
      root,
      archive: positional[0]!,
      passphrase_file: positional[1]!,
      expected_commitment: positional[2]!,
      offline: true,
      workers_terminated: true,
    });
    if (process.platform === "win32") hardenBillingWindowsAcl(root);
    process.stdout.write(
      JSON.stringify({
        command,
        key_commitment: result.key_commitment,
        restored: true,
      }),
    );
  } else {
    const auditId = positional[0]!;
    if (!UUID.test(auditId)) fail("enroll requires an audit UUID.");
    const policyText = readBoundedRegularFile(positional[1]!, 16 * 1024);
    let policy: unknown;
    try {
      policy = JSON.parse(policyText);
    } catch {
      fail("The billing policy file is not valid JSON.");
    }
    const key = exactBinary(positional[2]!, 32);
    const control = new ControlStore(controlPath);
    try {
      const result = enrollBillingAuthorityOffline({
        control,
        root,
        key,
        policy,
        audit_id: auditId,
        offline: true,
        workers_terminated: true,
      });
      process.stdout.write(JSON.stringify({ command, ...result }));
    } finally {
      key.fill(0);
      control.close();
    }
  }
} catch {
  fail("The managed billing operator command was denied.");
}
