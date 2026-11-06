import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode } from "../navigation/fake-code-graph.testing.ts";
import { fakeLive, type FakeLive } from "../live/fake-live.testing.ts";
import type { OutlineSelector } from "../../ports/outline-queries.port.ts";
import { createOutlineQueries, type OutlineQueriesDeps } from "./outline-queries.ts";

const SHA = "a".repeat(40);
const SUMMARY = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "fake", schema: 0, extraction: 0 } };
const STORE = "/scratch/store";

interface Options {
  live?: FakeLive;
  /** The paths the commit export wrote, so the index's own list of what it could not hold is meaningful. */
  written?: readonly string[];
  nodes?: Parameters<typeof fakeCodeGraph>[0];
  edges?: Parameters<typeof fakeCodeGraph>[1];
  /** What the path matcher answers for a repository path and a declared glob; every glob matches by default. */
  matches?: (path: string, glob: string) => boolean;
  snapshotCache?: OutlineQueriesDeps["snapshotCache"];
}

function setup(options: Options = {}) {
  const log = { closed: 0, reads: 0, extractions: 0 };
  const store = { ...fakeCodeGraph(options.nodes ?? [], options.edges ?? []), close: () => void (log.closed += 1) };
  const written = options.written ?? [];
  const deps = {
    vcs: {
      resolveCommit: async () => ({ ok: true, value: SHA }),
      exportCommit: async () => ({ ok: true, value: { files: written.map((path) => ({ path, blob: "1", written: true })), skipped: [] } }),
    },
    scratch: { create: async () => "/scratch/head", remove: async () => undefined },
    reader: { read: async () => { log.reads++; return []; } },
    extractor: { extract: () => { log.extractions++; return []; } },
    digest: { of: (value: string) => `digest:${value}` },
    producer: { name: "ye-ast", version: "0.0.0" },
    matcher: { matches: options.matches ?? (() => true) },
    graph: { index: async () => ({ ok: true, value: SUMMARY }), open: () => ({ ok: true, value: store }) },
    engines: {},
    moduleReaders: [{ extract: async () => ({ files: written.map((file) => ({ file, statements: [], moduleOnly: true })), dependencies: [], unread: [] }) }],
    ...(options.snapshotCache && { snapshotCache: options.snapshotCache }),
    ...(options.live && { live: options.live.deps, trust: { read: async () => ({ ok: true, value: "trusted" }) } }),
  } as unknown as OutlineQueriesDeps;
  return { queries: createOutlineQueries(deps), log, store };
}

test("a requested file the scope leaves out is unknown with its evidence, not an empty outline", async () => {
  const { queries } = setup({ matches: (path, glob) => (glob === "docs/**" ? path.startsWith("docs/") : true) });

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: ["src/A.ts", "docs/notes.md"], scope: { exclude: ["docs/**"] } });

  assert.equal(answer.ok, true);
  const fact = answer.ok ? answer.value : undefined;
  assert.equal(fact?.status, "unknown");
  assert.equal(fact?.status === "unknown" ? fact.reason : "", "out-of-scope");
  assert.deepEqual(fact?.evidence, [{ path: "docs/notes.md", line: 1 }]);
});

test("a file the index holds nothing of is a cut, and says which reason, so an empty list never reads as nothing declared", async () => {
  const { queries } = setup({ written: ["src/Held.ts"] });

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: ["src/Held.ts", "src/Never.ts"] });

  const fact = answer.ok ? answer.value : undefined;
  assert.equal(fact?.status, "partial");
  assert.deepEqual(fact?.value, { files: [], unheld: ["src/Held.ts", "src/Never.ts"] });
  assert.deepEqual(fact?.cuts?.map((cut) => [cut.kind, cut.at]), [
    ["no-extractor", ["src/Held.ts"]],
    ["not-exported", ["src/Never.ts"]],
  ]);
});

test("a file the index holds answers its declarations and closes the store", async () => {
  const { queries, log, store } = setup({
    written: ["src/Order.java"],
    nodes: [fakeNode("Order.java", "file", "src/Order.java", 1, 40), fakeNode("Order.total", "method", "src/Order.java", 20, 24, "total")],
  });
  assert.ok(store);

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: ["src/Order.java"] });

  const fact = answer.ok ? answer.value : undefined;
  assert.equal(fact?.status, "complete");
  assert.deepEqual(fact?.value, { files: [{ file: "src/Order.java", declarations: [{ kind: "method", name: "total", line: 20, endLine: 24 }], imports: [] }], unheld: [] });
  assert.equal(log.closed, 1, "the store is closed on every path that opened it");
});

for (const live of [false, true]) {
  test(`a ${live ? "live" : "revisioned"} outline reads the index and its sources without extracting entrypoints`, async () => {
    const mirror = live ? fakeLive({ "src/Order.java": "1" }) : undefined;
    const { queries, log } = setup({
      written: ["src/Order.java"],
      nodes: [fakeNode("Order.total", "method", "src/Order.java", 20, 24, "total")],
      ...(mirror && { live: mirror }),
    });

    const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", files: ["src/Order.java"], ...(live ? { live: true } : { revision: "HEAD" }) });

    assert.ok(answer.ok);
    assert.equal(answer.value.status, "complete");
    assert.deepEqual(answer.value.value, { files: [{ file: "src/Order.java", declarations: [{ kind: "method", name: "total", line: 20, endLine: 24 }], imports: [] }], unheld: [] });
    assert.equal(log.extractions, 0);
    assert.equal(log.closed, 1);
    if (mirror) assert.deepEqual(mirror.held, { locks: 1, released: 1 });
  });
}

test("an aborted live outline returns the cancellation fault before acquiring its mirror or reading its index", async () => {
  const mirror = fakeLive({ "src/Order.java": "1" });
  const { queries, log } = setup({ live: mirror });
  const controller = new AbortController();
  controller.abort();

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", files: ["src/Order.java"], live: true, signal: controller.signal });

  assert.ok(!answer.ok);
  assert.equal(answer.fault.kind, "aborted");
  assert.equal(log.closed, 0);
  assert.equal(log.reads, 0);
  assert.equal(log.extractions, 0);
  assert.deepEqual(mirror.held, { locks: 0, released: 0 });
});

test("a focused outline never reads nor restores source data", async () => {
  let restored = 0;
  const { queries, log } = setup({ written: ["src/Order.java"], nodes: [fakeNode("Order.total", "method", "src/Order.java", 20, 24, "total")], snapshotCache: { get: () => { restored++; return { sources: [] }; }, put: () => undefined } });
  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus: [{ file: "src/Order.java", symbol: "total" }] });
  assert.ok(answer.ok && answer.value.status === "complete");
  assert.equal(restored, 0);
  assert.equal(log.reads, 0);
  assert.equal(log.extractions, 0);
});

const API = "src/api.ts";
const TWO_CLASSES = {
  written: [API],
  nodes: [
    fakeNode("api", "file", API, 1, 40),
    fakeNode("A", "class", API, 1, 12, "A"),
    fakeNode("A.m", "method", API, 2, 6, "m"),
    fakeNode("A.m.inner", "function", API, 3, 5, "inner"),
    fakeNode("A.n", "method", API, 8, 10, "n"),
    fakeNode("B", "class", API, 14, 24, "B"),
    fakeNode("B.m", "method", API, 15, 18, "m"),
    fakeNode("Aardvark", "constant", API, 30, 30, "Aardvark"),
  ],
  edges: [
    { from: "api", to: "A", kind: "contains" },
    { from: "api", to: "B", kind: "contains" },
    { from: "A", to: "A.m", kind: "contains" },
    { from: "A.m", to: "A.m.inner", kind: "contains" },
    { from: "A", to: "A.n", kind: "contains" },
    { from: "B", to: "B.m", kind: "contains" },
    { from: "api", to: "other", kind: "imports", line: 1 },
  ],
};

async function focusOf(focus: readonly OutlineSelector[]) {
  return setup(TWO_CLASSES).queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus });
}

function focusValue(answer: Awaited<ReturnType<typeof focusOf>>) {
  assert.ok(answer.ok && answer.value.status === "complete", JSON.stringify(answer));
  return answer.value.value;
}

test("a dotted focus answers only that member with its subtree and its containers, without siblings nor imports", async () => {
  const value = focusValue(await focusOf([{ file: API, symbol: "A.m" }]));
  assert.deepEqual(value, {
    focus: [{
      file: API,
      selector: "A.m",
      path: "A.m",
      ancestors: [{ kind: "class", name: "A", line: 1, endLine: 12 }],
      declaration: { kind: "method", name: "m", line: 2, endLine: 6, children: [{ kind: "function", name: "inner", line: 3, endLine: 5 }] },
      omitted: 4,
    }],
    unheld: [],
  });
});

test("a bare focus matching a member of two classes answers both, each with its own path, in line order", async () => {
  const value = focusValue(await focusOf([{ file: API, symbol: "m" }]));
  assert.deepEqual(value.focus?.map((match) => [match.path, match.declaration.line]), [["A.m", 2], ["B.m", 15]]);
});

test("the matches of several selectors come in line order, whatever order the request gives", async () => {
  const value = focusValue(await focusOf([{ file: API, symbol: "m" }, { file: API, symbol: "Aardvark" }, { file: API, line: 16 }]));
  assert.deepEqual(value.focus?.map((match) => [match.path, match.selector]), [["A.m", "m"], ["B.m", "16"], ["B.m", "m"], ["Aardvark", "Aardvark"]]);
});

test("a line focus answers the innermost declaration holding it, with its containers", async () => {
  const value = focusValue(await focusOf([{ file: API, line: 4 }]));
  assert.deepEqual(value.focus?.map((match) => [match.selector, match.path]), [["4", "A.m.inner"]]);
});

test("a focus symbol that matches no declaration is an unknown-symbol fault whose candidates are the file's dotted paths", async () => {
  const answer = await focusOf([{ file: API, symbol: "B.n" }]);
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [{ file: API, symbol: "B.n", candidates: ["A", "A.m", "A.m.inner", "A.n", "Aardvark", "B", "B.m"] }]);
});

test("a focus line outside every declaration is a top-level-line fault with the file's dotted paths", async () => {
  const answer = await focusOf([{ file: API, symbol: "A" }, { file: API, line: 27 }]);
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "top-level-line" && answer.fault.entries, [{ file: API, line: 27, candidates: ["A", "A.m", "A.m.inner", "A.n", "Aardvark", "B", "B.m"] }]);
});

test("a focus on a file the index holds nothing of leaves it unheld with its cut instead of a fault", async () => {
  const answer = await setup(TWO_CLASSES).queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus: [{ file: "src/gone.ts", symbol: "A" }] });
  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.value, { focus: [], unheld: ["src/gone.ts"] });
  assert.deepEqual(answer.value.cuts.map((cut) => cut.kind), ["not-exported"]);
});

test("a focused fact records its selectors once each in a fixed order, in place of files", async () => {
  const answer = await focusOf([{ file: API, symbol: "m" }, { file: API, line: 16 }, { file: API, symbol: "m" }]);
  assert.ok(answer.ok);
  assert.deepEqual(answer.value.inputs.declaredConfig, { focus: [`${API}:16`, `${API}:m`] });
});
