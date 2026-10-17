import type { DatabaseSync } from "node:sqlite";
import { canonical } from "../domain/logic.ts";
import {
  decisionActivationAuditDigest,
  readDecisionActivationMirror,
  readDecisionActivationRow,
  type DecisionReadState,
} from "./managed-decision-activation.ts";
import type { DecisionActivationProfile } from "../domain/managed-decision-activation.ts";
import {
  centralSchemaDigest,
  managedControlInventoryDigest,
  supportedActivationSchema,
} from "./managed-activation-state.ts";
import {
  assertTrustedManagedRoot,
  readRootMarker,
  rootEpochMatches,
} from "../runtime/managed-operator.ts";

/**
 * Read-only DECISION activation state. It proves the SQL row and the
 * `decision-activation.json` mirror agree EXACTLY (canonical, including array order),
 * that the control handle belongs to the trusted root, and that the live epoch and
 * whole-audit digest are current. It opens no writer, creates no DDL and never trusts a
 * caller-supplied profile. It mirrors the reasoning `readGuardSnapshot` discipline for
 * the separate decision stage.
 */

export type DecisionGuardSnapshot =
  | { state: "absent" }
  | { state: "mismatch" }
  | {
      state: "active";
      profile: DecisionActivationProfile;
      epoch: { epoch: number; nonce: string };
      audit_digest: string;
      central_inventory_digest: string;
      schema_digest: string;
    };

function readLiveEpoch(
  db: DatabaseSync,
): { epoch: number; nonce: string } | undefined {
  const table = db
    .prepare("SELECT 1 AS p FROM sqlite_master WHERE type='table' AND name='managed_control_epoch'")
    .get();
  if (!table) return undefined;
  const row = db
    .prepare("SELECT epoch,nonce FROM managed_control_epoch WHERE singleton=1")
    .get() as { epoch: number; nonce: string } | undefined;
  return row ? { epoch: Number(row.epoch), nonce: String(row.nonce) } : undefined;
}

/** Full read-only decision guard snapshot, under no writer. */
export function readDecisionGuardSnapshot(
  control: { db: DatabaseSync; path: string },
  root: string,
): DecisionGuardSnapshot {
  try {
    assertTrustedManagedRoot(root, control.path);
  } catch {
    return { state: "mismatch" };
  }
  let row: DecisionActivationProfile | undefined;
  let mirror: DecisionActivationProfile | undefined;
  let malformed = false;
  try {
    row = readDecisionActivationRow(control.db);
  } catch {
    malformed = true;
  }
  try {
    mirror = readDecisionActivationMirror(root);
  } catch {
    malformed = true;
  }
  if (malformed) return { state: "mismatch" };
  if (!row && !mirror) return { state: "absent" };
  if (!row || !mirror || canonical(row) !== canonical(mirror)) return { state: "mismatch" };
  if (!supportedActivationSchema(control, root)) return { state: "mismatch" };
  const epoch = readLiveEpoch(control.db);
  if (!epoch) return { state: "mismatch" };
  let marker;
  try {
    marker = readRootMarker(root);
  } catch {
    return { state: "mismatch" };
  }
  if (!rootEpochMatches(marker, { ...epoch, rotated_at: "" })) return { state: "mismatch" };
  if (row.epoch !== epoch.epoch || row.root_nonce !== epoch.nonce)
    return { state: "mismatch" };
  const audit = decisionActivationAuditDigest(control.db, row.audit_id);
  if (!audit) return { state: "mismatch" };
  return {
    state: "active",
    profile: row,
    epoch,
    audit_digest: audit,
    central_inventory_digest: managedControlInventoryDigest(control.db),
    schema_digest: centralSchemaDigest(control.db),
  };
}

/** Closed state: only an exact SQL+mirror match is `active`; malformed is `mismatch`. */
export function readDecisionActivationState(
  control: { db: DatabaseSync; path: string },
  root: string,
): DecisionReadState {
  const snapshot = readDecisionGuardSnapshot(control, root);
  if (snapshot.state === "active") return { state: "active", profile: snapshot.profile };
  return snapshot.state === "absent" ? { state: "absent" } : { state: "mismatch" };
}
