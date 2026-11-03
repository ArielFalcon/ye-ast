import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode } from "../impact/fake-code-graph.testing.ts";
import { createOutlineQueries, type OutlineQueriesDeps } from "./outline-queries.ts";

const SHA = "a".repeat(40);
const SUMMARY = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "fake", schema: 0, extraction: 0 } };
const STORE = "/scratch/store";

interface Options {
  /** The paths the commit export wrote, so the index's own list of what it could not hold is meaningful. */
  written?: readonly string[];
  nodes?: Parameters<typeof fakeCodeGraph>[0];
  /** What the path matcher answers for a repository path and a declared glob; every glob matches by default. */
  matches?: (path: string, glob: string) => boolean;
}

function setup(options: Options = {}) {
  const log = { closed: 0 };
  const store = { ...fakeCodeGraph(options.nodes ?? [], []), close: () => void (log.closed += 1) };
  const written = options.written ?? [];
  const deps = {
    vcs: {
      resolveCommit: async () => ({ ok: true, value: SHA }),
      exportCommit: async () => ({ ok: true, value: { files: written.map((path) => ({ path, blob: "1", written: true })), skipped: [] } }),
    },
    scratch: { create: async () => "/scratch/head", remove: async () => undefined },
    reader: { read: async () => [] },
    extractor: { extract: () => [] },
    digest: { of: (value: string) => `digest:${value}` },
    producer: { name: "ye-ast", version: "0.0.0" },
    matcher: { matches: options.matches ?? (() => true) },
    graph: { index: async () => ({ ok: true, value: SUMMARY }), open: () => ({ ok: true, value: store }) },
    engines: {},
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
