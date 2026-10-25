import type { Storage } from "./index.ts";
import { paidProcessingBlockedSetting } from "./spend.ts";
import { clearRecallIndex, fillRecallIndex } from "./recall-index.ts";
import {
  attemptReferencesSource,
  purgeDecisionAttempts,
} from "./decision-advisory.ts";

/**
 * Mark every stored advisory entity `withdrawn` with an explicit new version, so
 * a restore or a rebuilt-from-vault projection can never leave a previously
 * active advisory readable. It is idempotent and preserves every other field,
 * including a previously valid judgment (history is retained, not rewritten).
 * The caller must own a transaction.
 */
export function withdrawAllAdvisories(
  store: Storage,
  clock: () => Date,
): number {
  let changed = 0;
  for (const row of store.all<{ id: string; version: number; data: string }>(
    "SELECT id,version,data FROM entities WHERE kind='advisory'",
  )) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (data.status === "withdrawn") continue;
    const next = { ...data, status: "withdrawn" };
    store.run(
      "UPDATE entities SET data=?,version=? WHERE id=?",
      JSON.stringify(next),
      row.version + 1,
      row.id,
    );
    store.run(
      "INSERT INTO entity_versions VALUES(?,?,?,?)",
      row.id,
      row.version + 1,
      JSON.stringify(next),
      clock().toISOString(),
    );
    changed += 1;
  }
  return changed;
}

/**
 * The first thing applied to any just-restored database. It disables connected
 * paid processing and sets a durable block that ordinary preferences cannot
 * clear, without deleting or rewriting any accounting history, and without
 * clearing an unknown hold. It also marks stored advisories `withdrawn` so a
 * restore cannot leave stale generated judgments readable. It runs before
 * deletion-tombstone replay so a later replay (or a later failure) can never
 * re-enable paid work. It is safe to call more than once: it only ever adds the
 * block and only ever withdraws a still-active advisory.
 */
export function applyRestoreSafetyBarrier(
  store: Storage,
  clock: () => Date = () => new Date(),
): void {
  store.transaction(() => {
    const prefs = store.setting<Record<string, unknown> | null>(
      "preferences",
      null,
    );
    if (prefs) store.set("preferences", { ...prefs, provider_enabled: false });
    store.set(paidProcessingBlockedSetting, {
      reason: "restored_backup",
      at: clock().toISOString(),
    });
    withdrawAllAdvisories(store, clock);
  });
}

export function purgeRetainedDeletedSource(store: Storage, sourceId: string) {
  store.transaction(() => {
    // The new attempt ledger is not part of the generic entity sweep below, so
    // scrub its exact references (parsed, never a data substring) and leave a
    // hash-only tombstone so the same paid question can never be re-claimed.
    const source = store.get<{ project_id: string }>(
      "SELECT project_id FROM sources WHERE id=?",
      sourceId,
    );
    purgeDecisionAttempts(
      store,
      (row) =>
        row.project_id === source?.project_id ||
        attemptReferencesSource(row, sourceId),
      () => new Date(),
    );
    store.run("DELETE FROM source_fts WHERE source_id=?", sourceId);
    store.run("DELETE FROM source_versions WHERE source_id=?", sourceId);
    for (const entity of store.all<{ id: string; data: string }>(
      "SELECT id,data FROM entities",
    )) {
      const versions = store.all<{ data: string }>(
        "SELECT data FROM entity_versions WHERE entity_id=?",
        entity.id,
      );
      if (
        [entity.data, ...versions.map((version) => version.data)].some((data) =>
          data.includes(`\"${sourceId}\"`),
        )
      )
        store.run("DELETE FROM entities WHERE id=?", entity.id);
    }
    store.run("DELETE FROM idempotency");
    store.run("DELETE FROM imports");
    // The sweep above deletes entities that mention the source by id; refill so their fact rows leave the file too.
    clearRecallIndex(store);
    fillRecallIndex(store);
  });
}
