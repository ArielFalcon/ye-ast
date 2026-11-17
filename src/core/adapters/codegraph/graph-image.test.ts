import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import { createCodeGraph, defaultCodeGraphDeps, type CodeGraphDeps } from "./codegraph.adapter.ts";
import { keptGraphImages } from "./graph-image.ts";
import { imageConformance } from "./graph-image.testing.ts";

const scratch = mkdtempSync(join(tmpdir(), "ye-ast-graph-image-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const MIXED: Readonly<Record<string, string>> = {
  "src/orders.ts": "import { audit } from 'audit-lib';\nexport function loadOrder(id: string): string {\n  audit(id);\n  return id;\n}\nexport function LoadOrder(): string {\n  return loadOrder('x');\n}\n",
  "src/app.ts": "import { loadOrder, LoadOrder } from './orders';\nexport class App {\n  run(): string {\n    return loadOrder('a') + LoadOrder() + missing();\n  }\n}\n",
  "java/Fmt.java": "package app;\npublic class Fmt implements Runnable {\n    public void run() { format(\"\"); format(1); }\n    String format(String v) { return v; }\n    String format(int v) { return Helper.help(); }\n}\n",
};

let built = 0;
async function storeOf(files: Readonly<Record<string, string>>, at = join(scratch, `store-${(built += 1)}`)): Promise<string> {
  const snapshot = join(scratch, `snapshot-${(built += 1)}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(snapshot, path)), { recursive: true });
    writeFileSync(join(snapshot, path), content);
  }
  const indexed = await createCodeGraph().index(snapshot, at);
  assert.ok(indexed.ok, JSON.stringify(indexed));
  return at;
}

function counting(): { deps: CodeGraphDeps; loads: () => number } {
  let loads = 0;
  const real = defaultCodeGraphDeps.loadSdk(defaultCodeGraphDeps.resolveBundle()!);
  const sdk = { ...real, CodeGraph: Object.assign(Object.create(real.CodeGraph) as typeof real.CodeGraph, { openSync: (...args: Parameters<typeof real.CodeGraph.openSync>) => ((loads += 1), real.CodeGraph.openSync(...args)) }) };
  return { deps: { ...defaultCodeGraphDeps, loadSdk: () => sdk }, loads: () => loads };
}

function opened(graph: ReturnType<typeof createCodeGraph>, store: string): CodeGraphReader {
  const reader = graph.open(store);
  assert.ok(reader.ok, JSON.stringify(reader));
  return reader.value;
}

test("the image answers every method over every file, id and name as the store's own reader does", async () => {
  const { checks, differences } = imageConformance(await storeOf(MIXED));
  assert.ok(checks > 100);
  assert.deepEqual(differences, []);
});

test("an image hands out frozen values in new lists, so a caller that sorts or edits what it got changes nothing kept", async () => {
  const reader = opened(createCodeGraph(defaultCodeGraphDeps, { imageBytes: Number.MAX_SAFE_INTEGER }), await storeOf(MIXED));
  const symbols = reader.symbolsInFiles(["src/orders.ts"]);
  const edges = reader.outgoingEdges(symbols.map(({ id }) => id));
  const references = reader.unresolvedReferences(["src/app.ts", "src/orders.ts"]);
  assert.ok(symbols.length > 1 && edges.length > 0 && references.length > 0);

  (symbols as unknown[]).reverse();
  assert.throws(() => Object.assign(symbols[0]!, { name: "renamed" }), TypeError);
  assert.throws(() => Object.assign(edges[0]!, { kind: "renamed" }), TypeError);
  assert.throws(() => (references[0]!.candidates as string[]).push("x"), TypeError);
  assert.deepEqual(reader.symbolsInFiles(["src/orders.ts"]), [...symbols].reverse());
});

test("a store rebuilt at the same path is read again, never answered from the image of the one it replaced", async () => {
  const { deps, loads } = counting();
  const graph = createCodeGraph(deps, { imageBytes: Number.MAX_SAFE_INTEGER });
  const store = await storeOf(MIXED);
  assert.deepEqual(opened(graph, store).symbolsInFiles(["src/extra.ts"]), []);
  opened(graph, store);
  assert.equal(loads(), 1);

  rmSync(store, { recursive: true });
  await storeOf({ ...MIXED, "src/extra.ts": "export function extra(): void {}\n" }, store);
  assert.deepEqual(opened(graph, store).symbolsInFiles(["src/extra.ts"]).map(({ name }) => name), ["extra", "extra.ts"]);
  assert.equal(loads(), 2);
});

test("images are kept within their bytes, the least recently used first out; one above the budget or one whose read failed is never kept", () => {
  const loads: string[] = [];
  const images = keptGraphImages(10);
  const obtain = (key: string, bytes: number): void => {
    images.obtain(key, () => (loads.push(key), { versions: { codegraph: "0", schema: 0, extraction: 0 }, bytes, reader: () => assert.fail("never read") }));
  };
  for (const key of ["a", "b", "a", "c", "a", "c", "b", "a"]) obtain(key, 4);
  obtain("large", 11);
  obtain("large", 11);
  assert.throws(() => images.obtain("failed", () => assert.fail("unreadable")));
  obtain("failed", 1);
  assert.deepEqual(loads, ["a", "b", "c", "b", "a", "large", "large", "failed"]);
});
