import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode } from "../navigation/fake-code-graph.testing.ts";
import { walkTrace, type TraceWalkInput } from "./trace-walk.ts";

const use = "src/main/java/p/Use.java";
const port = "src/main/java/p/Port.java";

test("a Java receiver is settled by the binding, not by a second rule in the walk", async () => {
  const store = fakeCodeGraph([
    fakeNode("run", "method", use, 1, 12),
    fakeNode("Port", "interface", port, 1, 5),
    fakeNode("Port.load", "method", port, 4, 4, "load"),
    fakeNode("Sibling", "class", port, 7, 10),
    fakeNode("Sibling.load", "method", port, 9, 9, "load"),
  ], [{ from: "Port", to: "Port.load", kind: "contains" }, { from: "Sibling", to: "Sibling.load", kind: "contains" }], [
    { from: "run", file: use, name: "port.load", kind: "calls", line: 3, column: 4 },
    { from: "run", file: use, name: "other.load", kind: "calls", line: 4, column: 4 },
    { from: "run", file: use, name: "lib.open", kind: "calls", line: 5, column: 4 },
  ]);
  const [run] = store.symbolsInFiles([use]);
  const symbols = store.symbolsInFiles([port]);
  const target = symbols.find((node) => node.id === "Port.load")!;
  const sibling = symbols.find((node) => node.id === "Sibling")!;
  const siblingMethod = symbols.find((node) => node.id === "Sibling.load")!;
  const references = store.unresolvedReferences([use]);
  let established = true;
  // The binding and annotation deliberately disagree so the chosen owner is observable.
  const input = {
    store, unresolvedIn: (file: string) => store.unresolvedReferences([file]),
    origins: {
      declaredTypes: async () => [{ kind: "nominal", file: port, name: "Sibling", line: 7 }],
      replacedRoots: async () => ({ paths: [], globalObjects: new Set(), packages: new Set() }),
      dispatchTargets: async () => [{ kind: "unknown" }],
      receiverMethods: async () => [{ kind: "method", file: port, start: 9, nameLine: 9 }],
    },
    targets: { verdictsOf: async () => [] },
    bindings: {
      bindCalls: async () => [
        { kind: "receiver", proof: { link: "syntax", holds: { kind: "annotated", type: "Sibling", line: 2, column: 1 }, type: sibling }, ...(established ? { target } : {}), candidates: [target], attributed: [] },
        { kind: "unbound", form: "member", candidates: [siblingMethod], attributed: [] },
        { kind: "outside", form: "chain", origin: { kind: "external", module: "library" } },
      ],
      boundCalls: async () => [], namedDeclarations: () => [siblingMethod],
    },
    uses: { followed: () => [], referencesFrom: () => [] },
    reconciled: { callsOf: async (node: NonNullable<typeof run>) => ({ edges: [], references: node.id === run!.id ? references : [], contradicted: [], writtenOnly: [], ambiguous: [], deferredOnly: [] }) },
    inScope: () => true, memberDeclarations: async () => new Map(),
    syntaxOf: async () => ({ callables: [{ name: "load", start: 4, nameLine: 4, body: true, overridable: false }], functionValueCalls: [] }), budget: {},
  } as unknown as TraceWalkInput;
  const result = await walkTrace([run!], input);
  assert.notEqual(result, "aborted");
  if (result === "aborted") return;
  assert.deepEqual(result.roots[0]!.children.map(({ declaration }) => [declaration.file, declaration.start]), [[port, 4]]);
  assert.equal(result.cuts.length, 1);
  assert.deepEqual(result.cuts[0]!.at[0], `${use}:4 other.load`);
  assert.deepEqual(result.roots[0]!.external, [{ kind: "import", module: "library", name: "lib.open" }]);

  established = false;
  const unestablished = await walkTrace([run!], input);
  assert.notEqual(unestablished, "aborted");
  if (unestablished === "aborted") return;
  assert.deepEqual(unestablished.roots[0]!.children, []);
  assert.equal(unestablished.cuts.length, 2);
});

test("a written reference is deferred and an unresolved reference remains a cut", async () => {
  const store = fakeCodeGraph([fakeNode("run", "method", use, 1, 12), fakeNode("load", "method", port, 4, 4, "load")], []);
  const run = store.symbolsInFiles([use])[0]!;
  const target = store.symbolsInFiles([port])[0]!;
  const written = [{ from: run.id, file: use, name: "load", kind: "references", line: 3, column: 4, candidates: [] }, { from: run.id, file: use, name: "ambiguous", kind: "references", line: 4, column: 4, candidates: [] }];
  let dispatched = 0;
  const input = {
    store, unresolvedIn: () => [],
    origins: { replacedRoots: async () => ({ paths: [], globalObjects: new Set(), packages: new Set() }), dispatchTargets: async () => (dispatched++, [{ kind: "unknown" }]) },
    targets: { verdictsOf: async () => [] },
    bindings: { bindCalls: async () => [], boundCalls: async (calls: readonly unknown[]) => calls.length === 0 ? [] : [{ kind: "declaration", target, link: "declared-receiver" }, { kind: "unbound", form: "bare", candidates: [target], attributed: [target] }], namedDeclarations: () => [] },
    uses: { followed: () => [], referencesFrom: () => [] },
    reconciled: { callsOf: async (node: typeof run) => ({ edges: [], references: [], contradicted: [], writtenOnly: [], ambiguous: [], deferredOnly: node.id === run.id ? written : [] }) },
    inScope: () => true, memberDeclarations: async () => new Map(), syntaxOf: async () => ({ callables: [], functionValueCalls: [] }), budget: {},
  } as unknown as TraceWalkInput;
  const result = await walkTrace([run], input);
  assert.notEqual(result, "aborted");
  if (result === "aborted") return;
  assert.equal(result.roots[0]!.children[0]!.via, "reference");
  assert.equal(result.roots[0]!.children[0]!.deferred, true);
  assert.equal(result.cuts.length, 1);
  assert.equal(dispatched, 0);
});
