/**
 * Measurement harness (RFC-0012 step 4). Runs every query family twice over the same commit and records the facts,
 * the wall clock, the resident memory and the measurement lines the process emitted. Exits 1 when two runs of the
 * same request disagree.
 *
 *   node --import tsx scripts/measure.ts <repo> --base <rev> [--head <rev>] [--target f:s]... [--file <path>]... [--out <path>]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { composeQueries } from "../src/composition/compose.ts";
import type { CallersTarget } from "../src/core/ports/impact-queries.port.ts";

const USAGE = "usage: node --import tsx scripts/measure.ts <repo> --base <rev> [--head <rev>] [--target <file:symbol|file:start-end>]... [--file <path>]... [--out <path>]";

interface Row {
  method: string;
  identical: boolean;
  wall_ms: number[];
  bytes: number;
  rss_bytes: number;
  measurements: unknown[];
  answer: unknown;
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    base: { type: "string" },
    head: { type: "string" },
    target: { type: "string", multiple: true },
    file: { type: "string", multiple: true },
    out: { type: "string" },
  },
  allowPositionals: true,
});

const [path, ...extra] = positionals;
if (path === undefined || values.base === undefined || extra.length > 0) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const repo = resolve(path);
const repoId = basename(repo);
const head = values.head ?? "HEAD";
const directory = await mkdtemp(join(tmpdir(), "ye-ast-measure-"));
const scratchRoot = join(directory, "scratch");
await mkdir(scratchRoot, { recursive: true });
const recorded: string[] = [];
const queries = composeQueries({ indexCache: join(directory, "indexes"), scratchRoot, measure: (line) => recorded.push(line) });

async function pair(method: string, call: () => Promise<unknown>): Promise<Row> {
  recorded.length = 0;
  const firstStarted = performance.now();
  const first = await call();
  const firstWall = Math.round(performance.now() - firstStarted);
  const firstLines = [...recorded];
  recorded.length = 0;
  const secondStarted = performance.now();
  const second = await call();
  const secondWall = Math.round(performance.now() - secondStarted);
  return {
    method,
    identical: JSON.stringify(first) === JSON.stringify(second),
    wall_ms: [firstWall, secondWall],
    bytes: Buffer.byteLength(JSON.stringify(first)),
    rss_bytes: process.memoryUsage().rss,
    measurements: firstLines.map((line) => JSON.parse(line) as unknown),
    answer: first,
  };
}

const rows: Row[] = [];
try {
  rows.push(await pair("map", () => queries.entrypoints.map({ repo, repoId, revision: head })));
  rows.push(await pair("impact.ofChange", () => queries.impact.ofChange({ repo, repoId, base: values.base as string, head })));
  if (values.target !== undefined) rows.push(await pair("impact.callers", () => queries.impact.callers({ repo, repoId, revision: head, targets: values.target!.map(parseTarget) })));
  if (values.file !== undefined) rows.push(await pair("impact.importers", () => queries.impact.importers({ repo, repoId, revision: head, files: values.file! })));
} finally {
  await rm(directory, { recursive: true, force: true });
}

const report = { repo, repoId, base: values.base, head, rows };
if (values.out === undefined) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
}

for (const row of rows) process.stderr.write(`${row.identical ? "identical" : "DIVERGED"}  ${row.method}  ${row.wall_ms.join(" ms, ")} ms  ${row.bytes} B\n`);
process.exitCode = rows.every((row) => row.identical) ? 0 : 1;

function parseTarget(spec: string): CallersTarget {
  const colon = spec.lastIndexOf(":");
  const file = spec.slice(0, colon);
  const rest = spec.slice(colon + 1);
  const range = /^([1-9]\d*)-([1-9]\d*)$/.exec(rest);
  if (colon <= 0 || rest === "") throw new Error(`not a target: ${spec}`);
  if (range === null) return { file, symbol: rest };
  return { file, start: Number(range[1]), end: Number(range[2]) };
}
