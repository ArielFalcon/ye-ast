import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeGraph, CodeGraphFault } from "../../ports/code-graph.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import { createCodeGraph, defaultCodeGraphDeps, type CodeGraphDeps } from "./codegraph.adapter.ts";
import type { SpawnWorker, WorkerRequest } from "./sync-worker.ts";

const BASE: Readonly<Record<string, string>> = {
  "src/orders.ts": "export function loadOrder(id: string): string {\n  return id;\n}\n",
  "src/app.ts": "import { loadOrder } from \"./orders\";\nexport function handle(): string {\n  return loadOrder(\"1\");\n}\n",
};

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mirrorOf(files: Readonly<Record<string, string>>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ye-ast-worker-")), "mirror");
  scratches.push(dirname(dir));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function unwrap<T>(result: Result<T, CodeGraphFault>): T {
  assert.ok(result.ok, result.ok ? "" : `${result.fault.kind}: ${result.fault.detail}`);
  return result.value;
}

interface Watched {
  graph: CodeGraph;
  /** Every worker started, in order. */
  workers: ChildProcess[];
  /** Every request written to a worker, by worker index. */
  requests: { worker: number; request: WorkerRequest }[];
  /** The one-shot sync children run. */
  oneShotSyncs: number;
}

/** Runs `then` with each line written to the child's stdin, right after it is written. */
function afterWrite(child: ChildProcess, then: (line: string) => void): ChildProcess {
  const stdin = child.stdin!;
  const write = stdin.write.bind(stdin) as (line: string) => boolean;
  stdin.write = ((line: string) => {
    const written = write(line);
    then(line);
    return written;
  }) as typeof stdin.write;
  return child;
}

/** The real adapter, with each worker start and each one-shot sync recorded; `start` may replace the started process. */
function watched(start: (launch: Parameters<SpawnWorker>[0], index: number) => ChildProcess = (launch) => defaultCodeGraphDeps.spawnWorker(launch), shutdown?: AbortSignal): Watched {
  const seen: Watched = { graph: undefined!, workers: [], requests: [], oneShotSyncs: 0 };
  const deps: CodeGraphDeps = {
    ...defaultCodeGraphDeps,
    runIndexer: (command, args, env, signal) => {
      if (args.some((arg) => arg.includes("sync-mirror.child"))) seen.oneShotSyncs += 1;
      return defaultCodeGraphDeps.runIndexer(command, args, env, signal);
    },
    spawnWorker: (launch) => {
      const index = seen.workers.length;
      const child = start(launch, index);
      seen.workers.push(child);
      return afterWrite(child, (line) => seen.requests.push({ worker: index, request: JSON.parse(line) as WorkerRequest }));
    },
  };
  seen.graph = createCodeGraph(deps, { shutdown });
  return seen;
}

function edit(mirror: string, name: string): string[] {
  writeFileSync(join(mirror, "src/orders.ts"), `${BASE["src/orders.ts"]}export function ${name}(): number {\n  return 1;\n}\n`);
  return ["src/orders.ts"];
}

function declares(graph: CodeGraph, mirror: string, name: string): boolean {
  const reader = unwrap(graph.open(mirror));
  try {
    return reader.symbolsInFiles(["src/orders.ts"]).some((symbol) => symbol.name === name);
  } finally {
    reader.close();
  }
}

test("two syncs of one mirror run in one process, and each brings the store up to date", async () => {
  const seen = watched();
  const mirror = mirrorOf(BASE);
  unwrap(await seen.graph.buildMirror(mirror));
  unwrap(await seen.graph.syncMirror(mirror, edit(mirror, "first")));
  unwrap(await seen.graph.syncMirror(mirror, edit(mirror, "second")));
  assert.equal(seen.workers.length + seen.oneShotSyncs, 1);
  assert.ok(declares(seen.graph, mirror, "second") && !declares(seen.graph, mirror, "first"));
});

/** A real worker that runs `then` right after a request is written to it. */
function interrupted(launch: Parameters<SpawnWorker>[0], then: (child: ChildProcess) => void): ChildProcess {
  const child = defaultCodeGraphDeps.spawnWorker(launch);
  return afterWrite(child, () => then(child));
}

const LOSSES: readonly { name: string; start: (launch: Parameters<SpawnWorker>[0]) => ChildProcess }[] = [
  { name: "is killed", start: (launch) => interrupted(launch, (child) => child.kill("SIGKILL")) },
  {
    name: "answers a line that is no answer",
    start: () => spawn(process.execPath, ["-e", "process.stdin.once('data', () => process.stdout.write('not an answer\\n'))"], { stdio: ["pipe", "pipe", "ignore"] }),
  },
];

for (const loss of LOSSES) {
  test(`a worker that ${loss.name} during a sync is replaced, and that sync runs in a child of its own`, async () => {
    const seen = watched((launch, index) => (index === 0 ? loss.start(launch) : defaultCodeGraphDeps.spawnWorker(launch)));
    const mirror = mirrorOf(BASE);
    unwrap(await seen.graph.buildMirror(mirror));
    unwrap(await seen.graph.syncMirror(mirror, edit(mirror, "first")));
    assert.equal(seen.oneShotSyncs, 1);
    assert.ok(declares(seen.graph, mirror, "first"));
    unwrap(await seen.graph.syncMirror(mirror, edit(mirror, "second")));
    assert.deepEqual([seen.workers.length, seen.oneShotSyncs], [2, 1]);
    assert.ok(declares(seen.graph, mirror, "second"));
  });
}

test("a worker reopens the store unless the generation committed before a sync is the one its own last sync committed", async () => {
  const own = watched();
  const other = createCodeGraph();
  const mirror = mirrorOf(BASE);
  unwrap(await own.graph.buildMirror(mirror));
  unwrap(await own.graph.syncMirror(mirror, edit(mirror, "first"), undefined, { held: "built", next: "g1" }));
  assert.ok(declares(own.graph, mirror, "first"));
  unwrap(await own.graph.syncMirror(mirror, edit(mirror, "second"), undefined, { held: "g1", next: "g2" }));
  unwrap(await other.syncMirror(mirror, edit(mirror, "foreign"), undefined, { held: "g2", next: "g3" }));
  unwrap(await own.graph.syncMirror(mirror, edit(mirror, "third"), undefined, { held: "g3", next: "g4" }));
  unwrap(await own.graph.syncMirror(mirror, edit(mirror, "unfinished"), undefined, { held: "", next: "g5" }));
  unwrap(await own.graph.syncMirror(mirror, edit(mirror, "unnamed")));
  unwrap(await own.graph.syncMirror(mirror, edit(mirror, "last"), undefined, { held: "g6", next: "g7" }));
  const reopens = own.requests.map(({ request }) => request.op === "sync" && request.reopen);
  assert.deepEqual(reopens, [false, false, true, true, true, true]);
  assert.ok(declares(own.graph, mirror, "last"));
});

test("an aborted sync stops its worker and answers aborted; the next sync starts another", async () => {
  const controller = new AbortController();
  const seen = watched((launch, index) => (index === 0 ? interrupted(launch, () => controller.abort()) : defaultCodeGraphDeps.spawnWorker(launch)));
  const mirror = mirrorOf(BASE);
  unwrap(await seen.graph.buildMirror(mirror));
  const result = await seen.graph.syncMirror(mirror, edit(mirror, "first"), controller.signal);
  assert.equal(result.ok ? "ok" : result.fault.kind, "aborted");
  unwrap(await seen.graph.syncMirror(mirror, edit(mirror, "second")));
  assert.deepEqual([seen.workers.length, seen.oneShotSyncs], [2, 0]);
  assert.ok(declares(seen.graph, mirror, "second"));
});

test("shutdown ends every worker", async () => {
  const shutdown = new AbortController();
  const { graph, workers } = watched(undefined, shutdown.signal);
  const mirror = mirrorOf(BASE);
  unwrap(await graph.buildMirror(mirror));
  unwrap(await graph.syncMirror(mirror, edit(mirror, "first")));
  const exited = new Promise<number | null>((resolve) => workers[0]!.once("exit", resolve));
  shutdown.abort();
  assert.equal(await exited, 0);
});

test("retiring a mirror ends its worker, and the next sync of that mirror starts another", { timeout: 60_000 }, async () => {
  const seen = watched();
  const mirror = mirrorOf(BASE);
  unwrap(await seen.graph.buildMirror(mirror));
  unwrap(await seen.graph.syncMirror(mirror, edit(mirror, "first")));
  const exited = new Promise<number | null>((resolve) => seen.workers[0]!.once("exit", resolve));

  seen.graph.retireMirror(mirror);
  unwrap(await seen.graph.syncMirror(mirror, edit(mirror, "second")));

  assert.deepEqual([seen.workers.length, seen.oneShotSyncs], [2, 0]);
  assert.ok(declares(seen.graph, mirror, "second"));
  assert.equal(await exited, 0);
});
