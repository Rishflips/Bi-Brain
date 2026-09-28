import type { Storage } from "./index.ts";
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
