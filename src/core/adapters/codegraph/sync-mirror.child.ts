import { createRequire } from "node:module";

const [bundle, root, ...paths] = process.argv.slice(2);
const sdk = createRequire(import.meta.url)(bundle!) as typeof import("@colbymchenry/codegraph");
const graph = await sdk.CodeGraph.open(root!);
try {
  const result = await graph.sync({ paths });
  process.stdout.write(JSON.stringify({ filesFailed: result.failedFilePaths ?? [] }));
} catch (error) {
  if (!(error instanceof sdk.LockUnavailableError)) throw error;
  process.stdout.write(JSON.stringify({ lockUnavailable: true }));
} finally {
  graph.close();
}
