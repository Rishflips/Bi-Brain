import type { Storage } from "./index.ts";
import { paidProcessingBlockedSetting } from "./spend.ts";

/**
 * The first thing applied to any just-restored database. It disables connected
 * paid processing and sets a durable block that ordinary preferences cannot
 * clear, without deleting or rewriting any accounting history, and without
 * clearing an unknown hold. It runs before deletion-tombstone replay so a later
 * replay (or a later failure) can never re-enable paid work. It is safe to call
 * more than once: it only ever adds the block, never removes one.
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
  });
}

export function purgeRetainedDeletedSource(store: Storage, sourceId: string) {
  store.transaction(() => {
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
  });
}
