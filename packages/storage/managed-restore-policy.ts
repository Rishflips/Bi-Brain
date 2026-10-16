import type { ControlStore } from "./control.ts";
import { ManagedSpendingStore } from "./managed-spending.ts";

/**
 * Control-plane restore barriers and the incomplete-restore marker.
 *
 * A restored control database keeps its account identities, policies and every
 * financial row byte-value, but its opaque credentials (browser sessions,
 * agent-token routes and pending OIDC correlations) must never work again: an
 * old backup must not resurrect revoked access. The financial block and the
 * dropped credentials are independent, so a later operator money-unblock can
 * never make a restored credential usable.
 */
export const MANAGED_RESTORE_INCOMPLETE = "MANAGED_RESTORE_INCOMPLETE";
export const controlRestoreBlockKey = "restore";

const RESTORED_CREDENTIAL_TABLES = [
  "managed_sessions",
  "managed_agent_tokens",
  "oidc_transactions",
];

/**
 * Idempotent, short transaction. Ensures the money namespace exists, sets the
 * durable service-wide deny, and deletes restored opaque credentials when their
 * tables exist. It never changes accounts, policies, reservations or an existing
 * overrun block.
 */
export function applyControlRestoreBarrier(
  control: ControlStore,
  clock: () => Date = () => new Date(),
): void {
  // Create the money tables first so the block insert has a target.
  void new ManagedSpendingStore(control, clock);
  control.db.exec("BEGIN IMMEDIATE");
  try {
    control.db
      .prepare(
        "INSERT INTO managed_money_blocks(key,reason,at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET reason=excluded.reason,at=excluded.at",
      )
      .run(controlRestoreBlockKey, "restored_backup", clock().toISOString());
    for (const table of RESTORED_CREDENTIAL_TABLES) {
      const present = control.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(table);
      if (present) control.db.prepare(`DELETE FROM ${table}`).run();
    }
    control.db.exec("COMMIT");
  } catch (error) {
    control.db.exec("ROLLBACK");
    throw error;
  }
}

/** True while the control store carries the durable restore deny. */
export function controlRestoreRequired(control: ControlStore): boolean {
  return !!control.db
    .prepare("SELECT 1 AS present FROM managed_money_blocks WHERE key=?")
    .get(controlRestoreBlockKey);
}
