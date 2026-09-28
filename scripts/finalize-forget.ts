import { Brain } from "../packages/domain/service.ts";
import { Storage } from "../packages/storage/index.ts";
const id = process.argv[2];
if (!id)
  throw new Error(
    "Usage: npm run vault:finalize-forget -- <deleted-source-id>",
  );
const store = new Storage();
try {
  const proof = new Brain(store).finalizeForget({ kind: "owner" }, id);
  console.log(JSON.stringify(proof, null, 2));
  if (
    ![
      proof.file_gone,
      proof.index_gone,
      proof.embedding_gone,
      proof.graph_edge_gone,
    ].every(Boolean)
  )
    process.exitCode = 1;
} finally {
  store.close();
}
