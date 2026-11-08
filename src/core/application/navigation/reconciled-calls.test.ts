import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNodeId } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames, SyntaxCall } from "../../ports/declared-member-names.port.ts";
import { createDeclarationUses } from "./declaration-uses.ts";
import { NOTHING_DECLARED } from "./edge-targets.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode, type FakeUnresolved } from "./fake-code-graph.testing.ts";
import { createGraphNavigation } from "./graph-navigation.ts";
import { createReconciledCalls, type BodyCalls } from "./reconciled-calls.ts";

const FILE = "src/c.ts";

function written(line: number, column: number, name: string, callee: string): SyntaxCall {
  return { kind: "calls", line, column, name, callee, owners: [] };
}

async function callsOf(body: string, nodes: readonly FakeNode[], edges: readonly FakeEdge[], calls: readonly SyntaxCall[], unresolved: readonly FakeUnresolved[] = []): Promise<BodyCalls> {
  const store = fakeCodeGraph(nodes, edges, unresolved);
  const uses = createDeclarationUses(store, createGraphNavigation(store, () => false));
  const syntax: DeclaredMemberNames = { ...NOTHING_DECLARED, calls };
  const reconciled = createReconciledCalls({ store, uses, syntaxOf: async (file) => (file === FILE ? syntax : NOTHING_DECLARED) });
  const [node] = store.symbolsByIds([body as GraphNodeId]);
  return reconciled.callsOf(node!);
}

function placed({ edges, references, indexOnly, writtenOnly, ambiguous }: BodyCalls) {
  return {
    edges: edges.map(({ edge, target }) => `${target.name}@${edge.line}:${edge.column}`),
    references: references.map(({ name, line, column }) => `${name}@${line}:${column}`),
    indexOnly: indexOnly.map(({ name }) => name),
    writtenOnly: writtenOnly.map(({ name }) => name),
    ambiguous: ambiguous.map(({ name }) => name),
  };
}

test("only call-bearing records are aligned: extends, implements and references are neither matched nor index-only", async () => {
  // class C extends Base implements Port {   (1)
  //   dto: Dto;                               (2)
  //   run() { this.svc.load(); }              (3)
  // }                                         (4)
  const nodes = [
    fakeNode("C", "class", FILE, 1, 4),
    fakeNode("dto", "field", FILE, 2),
    fakeNode("run", "method", FILE, 3),
    fakeNode("Base", "class", "src/base.ts", 1),
    fakeNode("Port", "interface", "src/port.ts", 1),
    fakeNode("Dto", "class", "src/dto.ts", 1),
    fakeNode("load", "method", "src/svc.ts", 1),
  ];
  const edges: FakeEdge[] = [
    { from: "C", to: "Base", kind: "extends", line: 1, column: 16 },
    { from: "C", to: "Port", kind: "implements", line: 1, column: 32 },
    { from: "dto", to: "Dto", kind: "references", line: 2, column: 7 },
    { from: "run", to: "load", kind: "calls", line: 3 },
  ];
  const calls = [written(3, 11, "this.svc.load", "load")];
  const empty = { edges: [], references: [], indexOnly: [], writtenOnly: [], ambiguous: [] };
  assert.deepEqual(placed(await callsOf("run", nodes, edges, calls)), { ...empty, edges: ["load@3:10"] });
  assert.deepEqual(placed(await callsOf("C", nodes, edges, calls)), empty);
  assert.deepEqual(placed(await callsOf("dto", nodes, edges, calls)), empty);
});

const CHAIN_NODES = [fakeNode("load", "method", FILE, 3, 5), fakeNode("pipe", "method", "src/lib.ts", 1), fakeNode("save", "method", "src/repo.ts", 1)];

test("two calls of one chain at one place: the record pairs with the call its name agrees with, the other is written-only", async () => {
  // load() {                                    (3)
  //   this.http.get(url).pipe(map(f));          (4)
  // }                                           (5)
  const calls = [written(4, 5, "this.http.get", "get"), written(4, 5, "this.http.get(url).pipe", "pipe"), written(4, 29, "map", "map")];
  const found = placed(await callsOf("load", CHAIN_NODES, [{ from: "load", to: "pipe", kind: "calls", line: 4, column: 4 }], calls));
  assert.deepEqual(found, { edges: ["pipe@4:4"], references: [], indexOnly: [], writtenOnly: ["this.http.get", "map"], ambiguous: [] });
});

test("homonym calls on one line pair each record with the call at its own column", async () => {
  // load() {                                    (3)
  //   a.save(); b.save();                       (4)
  // }                                           (5)
  const calls = [written(4, 5, "a.save", "save"), written(4, 15, "b.save", "save")];
  const edges: FakeEdge[] = [{ from: "load", to: "save", kind: "calls", line: 4, column: 14 }];
  const unresolved: FakeUnresolved[] = [{ from: "load", name: "a.save", kind: "calls", file: FILE, line: 4, column: 4 }];
  const found = placed(await callsOf("load", CHAIN_NODES, edges, calls, unresolved));
  assert.deepEqual(found, { edges: ["save@4:14"], references: ["a.save@4:4"], indexOnly: [], writtenOnly: [], ambiguous: [] });
});
