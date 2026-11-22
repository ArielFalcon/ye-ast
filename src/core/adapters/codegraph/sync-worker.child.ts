import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { CodeGraph as SdkGraph } from "@colbymchenry/codegraph";
import { listMirror, storedFiles } from "./mirror-files.ts";
import { readStoredVersions } from "./store-version.ts";
import type { WorkerAnswer, WorkerRequest } from "./sync-worker.ts";

const [bundle, root] = process.argv.slice(2) as [string, string];
const sdk = createRequire(import.meta.url)(bundle) as typeof import("@colbymchenry/codegraph");
let graph: SdkGraph | null = null;

/** Closes the open store, so the next sync starts from a fresh open of what is on disk. */
function release(): void {
  graph?.close();
  graph = null;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sync(paths: readonly string[]): Promise<WorkerAnswer> {
  const listed = await listMirror(root);
  if (!listed.ok) return { kind: "stage-failed", detail: listed.fault.detail };
  let filesFailed: readonly string[];
  try {
    graph ??= await sdk.CodeGraph.open(root);
    filesFailed = (await graph.sync({ paths: [...paths] })).failedFilePaths ?? [];
  } catch (error) {
    release();
    return error instanceof sdk.LockUnavailableError ? { kind: "locked" } : { kind: "failed", detail: detail(error) };
  }
  try {
    return { kind: "synced", filesFailed, ...storedFiles(sdk, graph, listed.value, paths), stored: readStoredVersions(sdk, root), codegraph: graph.getIndexBuildInfo().version };
  } catch (error) {
    return { kind: "unreadable", detail: detail(error) };
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })) {
  const request = JSON.parse(line) as WorkerRequest;
  if (request.op === "release" || request.reopen) release();
  const answer: WorkerAnswer = request.op === "sync" ? await sync(request.paths) : { kind: "released" };
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}
release();
