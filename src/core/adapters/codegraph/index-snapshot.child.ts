import { createRequire } from "node:module";

const [bundle, root] = process.argv.slice(2);
const sdk = createRequire(import.meta.url)(bundle!) as typeof import("@colbymchenry/codegraph");
const graph = await sdk.CodeGraph.init(root!);
try {
  const result = await graph.indexAll();
  process.stdout.write(
    JSON.stringify({
      success: result.success,
      indexState: graph.getIndexState(),
      filesIndexed: result.filesIndexed,
      filesSkipped: result.filesSkipped,
      filesErrored: result.filesErrored,
      errors: result.errors.map((error) => error.message),
    }),
  );
} finally {
  graph.close();
}
