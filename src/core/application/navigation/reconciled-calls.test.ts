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

type Scope = SyntaxCall["owners"][number];

function scope(name: string, start: number, startColumn: number, endLine: number, endColumn: number): Scope {
  return { name, start, nameLine: start, nameColumn: startColumn, startColumn, endLine, endColumn };
}

function ownedBy(owners: readonly Scope[], call: SyntaxCall): SyntaxCall {
  return { ...call, owners };
}

async function callsOf(body: string, nodes: readonly FakeNode[], edges: readonly FakeEdge[], calls: readonly SyntaxCall[], unresolved: readonly FakeUnresolved[] = [], functionValues: DeclaredMemberNames["functionValues"] = [], text: Readonly<Record<number, string>> = {}): Promise<BodyCalls> {
  const store = fakeCodeGraph(nodes, edges, unresolved);
  const uses = createDeclarationUses(store, createGraphNavigation(store, () => false));
  const syntax: DeclaredMemberNames = { ...NOTHING_DECLARED, calls, functionValues };
  const reconciled = createReconciledCalls({ store, uses, syntaxOf: async (file) => (file === FILE ? syntax : NOTHING_DECLARED), lineOf: (file, line) => (file === FILE ? text[line] : undefined) });
  const [node] = store.symbolsByIds([body as GraphNodeId]);
  return reconciled.callsOf(node!);
}

function placed({ edges, references, contradicted, writtenOnly, ambiguous }: BodyCalls) {
  return {
    edges: edges.map(({ edge, target }) => `${target.name}@${edge.line}:${edge.column}`),
    references: references.map(({ name, line, column }) => `${name}@${line}:${column}`),
    contradicted: contradicted.map(({ record, target }) => `${record.name}@${record.line}:${record.column}${target === undefined ? "" : `->${target.id}`}`),
    writtenOnly: writtenOnly.map(({ name }) => name),
    ambiguous: ambiguous.map(({ name }) => name),
  };
}

test("only call-bearing records are aligned: extends, implements and references are neither matched nor contradicted", async () => {
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
  const empty = { edges: [], references: [], contradicted: [], writtenOnly: [], ambiguous: [] };
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
  assert.deepEqual(found, { edges: ["pipe@4:4"], references: [], contradicted: [], writtenOnly: ["this.http.get", "map"], ambiguous: [] });
});

test("homonym calls on one line pair each record with the call at its own column", async () => {
  // load() {                                    (3)
  //   a.save(); b.save();                       (4)
  // }                                           (5)
  const calls = [written(4, 5, "a.save", "save"), written(4, 15, "b.save", "save")];
  const edges: FakeEdge[] = [{ from: "load", to: "save", kind: "calls", line: 4, column: 14 }];
  const unresolved: FakeUnresolved[] = [{ from: "load", name: "a.save", kind: "calls", file: FILE, line: 4, column: 4 }];
  const found = placed(await callsOf("load", CHAIN_NODES, edges, calls, unresolved));
  assert.deepEqual(found, { edges: ["save@4:14"], references: ["a.save@4:4"], contradicted: [], writtenOnly: [], ambiguous: [] });
});

test("the construction of an anonymous class belongs to the body that runs it, the calls inside to the class", async () => {
  // Map<String, Object> build() {     (2)
  //   return new HashMap<>() {        (3)
  //     { put("k", v); }              (4)
  //   };                              (5)
  // }                                 (6)
  const method = scope("build", 2, 2, 6, 3);
  const anonymous = scope("", 3, 27, 5, 5);
  const nodes: FakeNode[] = [{ ...fakeNode("build", "method", FILE, 2, 6), startColumn: 2, endColumn: 3 }, { ...fakeNode("anonymous", "class", FILE, 3, 5), startColumn: 11, endColumn: 5 }];
  const calls = [ownedBy([method], { ...written(3, 12, "HashMap", "HashMap"), kind: "instantiates" }), ownedBy([method, anonymous], written(4, 7, "put", "put"))];
  assert.deepEqual(placed(await callsOf("build", nodes, [], calls)).writtenOnly, ["HashMap"]);
  assert.deepEqual(placed(await callsOf("anonymous", nodes, [], calls)).writtenOnly, ["put"]);
});

test("a call no body encloses belongs to its file's top level, deferred inside a function value the top level does not run", async () => {
  // enableProdMode();                          (1)
  // boot().catch((e) => console.log(e));       (2)
  const arrow = scope("", 2, 13, 2, 35);
  const nodes = [fakeNode("main", "file", FILE, 1, 3)];
  const calls = [written(1, 1, "enableProdMode", "enableProdMode"), written(2, 1, "boot().catch", "catch"), written(2, 1, "boot", "boot"), ownedBy([arrow], written(2, 21, "console.log", "log"))];
  const values = [{ start: { line: 2, column: 13 }, end: { line: 2, column: 35 } }];
  assert.deepEqual(placed(await callsOf("main", nodes, [], calls, [], values)).writtenOnly, ["enableProdMode", "boot().catch", "boot"]);
});

const RUN = fakeNode("run", "method", FILE, 2, 9);
const LIB = [fakeNode("alpha", "function", "src/lib.ts", 1), fakeNode("beta", "function", "src/lib.ts", 2), fakeNode("handler", "method", "src/handler.ts", 1), fakeNode("bridge", "method", "src/bridge.ts", 1)];

test("a synthesized or unplaced edge is kept as the index has it and an ignored synthesizer's is preserved unfollowed, none contradicted", async () => {
  // run() {                                       (2)
  //   find(id);                                   (3)  a mapper the index wires to its handler at the declaration
  // }
  const edges: FakeEdge[] = [
    { from: "run", to: "handler", kind: "calls", line: 2, column: 8, synthesizedBy: "mybatis-java-xml" },
    { from: "run", to: "bridge", kind: "calls", line: 2, column: 8, synthesizedBy: "interface-impl" },
    { from: "run", to: "alpha", kind: "calls" },
  ];
  const found = placed(await callsOf("run", [RUN, ...LIB], edges, [written(3, 3, "find", "find")]));
  assert.deepEqual({ edges: found.edges, contradicted: found.contradicted }, { edges: ["handler@2:8", "alpha@null:null"], contradicted: [] });
});

test("a record whose name no written call at its place agrees with is contradicted, and the call there is written-only", async () => {
  // run() {                                       (2)
  //   alpha();                                    (3)  the index records beta here
  // }
  const found = placed(await callsOf("run", [RUN, ...LIB], [{ from: "run", to: "beta", kind: "calls", line: 3, column: 2 }], [written(3, 3, "alpha", "alpha")]));
  assert.deepEqual(found, { edges: [], references: [], contradicted: ["beta@3:2->beta"], writtenOnly: ["alpha"], ambiguous: [] });
});

test("a record placed where the file writes no call is contradicted once", async () => {
  // type Module = typeof import("lib");           (2)
  const nodes = [fakeNode("module", "file", FILE, 1, 3)];
  const found = placed(await callsOf("module", nodes, [], [], [{ from: "module", name: "import", kind: "calls", file: FILE, line: 2, column: 21 }]));
  assert.deepEqual(found.contradicted, ["import@2:21"]);
});

test("a link of a chain with repeated names matches the link the index spells without its arguments, the others stay written-only", async () => {
  // run() {                                       (2)
  //   sb.append("a")                              (3)
  //     // .append(old)
  //     .append(x).append("c");                   (5)
  // }
  const middle = 'sb.append("a")\n    // .append(old)\n    .append';
  const calls = [written(3, 3, "sb.append", "append"), written(3, 3, middle, "append"), written(3, 3, `${middle}(x).append`, "append")];
  const found = placed(await callsOf("run", [RUN], [], calls, [{ from: "run", name: "sb.append().append", kind: "calls", file: FILE, line: 3, column: 2 }]));
  assert.deepEqual({ contradicted: found.contradicted, writtenOnly: found.writtenOnly }, { contradicted: [], writtenOnly: ["sb.append", `${middle}(x).append`] });
});

test("a record naming the receiver a written call starts from is kept as the index has it and the member call stays written-only", async () => {
  // run() {                                       (2)
  //   const result = SCHEMA.safeParse(value);     (3)  the index records a call of the constant SCHEMA
  // }
  const nodes = [RUN, fakeNode("SCHEMA", "constant", "src/schema.ts", 1)];
  const found = placed(await callsOf("run", nodes, [{ from: "run", to: "SCHEMA", kind: "calls", line: 3, column: 17 }], [written(3, 18, "SCHEMA.safeParse", "safeParse")]));
  assert.deepEqual(found, { edges: ["SCHEMA@3:17"], references: [], contradicted: [], writtenOnly: ["SCHEMA.safeParse"], ambiguous: [] });
});

test("a record two written calls at its place agree with is undecidable: kept as the index has it, recovering neither", async () => {
  // run() {                                       (2)
  //   currency = store.getCurrency().getCurrency();   (3)
  // }
  const nodes = [RUN, fakeNode("getCurrency", "method", "src/store.ts", 1)];
  const calls = [written(3, 14, "store.getCurrency", "getCurrency"), written(3, 14, "store.getCurrency().getCurrency", "getCurrency")];
  const found = placed(await callsOf("run", nodes, [{ from: "run", to: "getCurrency", kind: "calls", line: 3, column: 13 }], calls));
  assert.deepEqual(found, { edges: ["getCurrency@3:13"], references: [], contradicted: [], writtenOnly: [], ambiguous: [] });
});

test("a record whose written call another body owns stays in the index's body, which then recovers nothing of it", async () => {
  // run() {                                       (2)
  //   return new Base() {                         (3)
  //     { alpha(); }                              (4)  the index records it from run, the syntax owns it by the class
  //   };                                          (5)
  // }                                             (6)
  const outer = scope("run", 2, 0, 6, 1);
  const inner = scope("", 3, 22, 5, 3);
  const nodes = [{ ...fakeNode("run", "method", FILE, 2, 6), startColumn: 0, endColumn: 1 }, { ...fakeNode("inner", "class", FILE, 3, 5), startColumn: 9, endColumn: 3 }, ...LIB];
  const calls = [ownedBy([outer, inner], written(4, 5, "alpha", "alpha"))];
  const edges: FakeEdge[] = [{ from: "run", to: "alpha", kind: "calls", line: 4, column: 4 }];
  assert.deepEqual(placed(await callsOf("run", nodes, edges, calls)).edges, ["alpha@4:4"]);
  assert.deepEqual(placed(await callsOf("inner", nodes, edges, calls)).writtenOnly, []);
});

test("a decorator and its argument calls the index records from the file move to the class the syntax says runs them", async () => {
  // @Injectable({ useFactory: make() })          (1)
  // export class Service {                        (2)
  //   run() {}                                    (3)
  // }                                             (4)
  const service = { ...scope("Service", 1, 0, 4, 1), nameLine: 2, nameColumn: 13 };
  const nodes = [fakeNode("file", "file", FILE, 1, 5), { ...fakeNode("Service", "class", FILE, 2, 4), startColumn: 0, endColumn: 1 }];
  const calls = [ownedBy([service], written(1, 2, "Injectable", "Injectable")), ownedBy([service], written(1, 27, "make", "make"))];
  const unresolved: FakeUnresolved[] = [{ from: "file", name: "Injectable", kind: "calls", file: FILE, line: 1, column: 1 }, { from: "file", name: "make", kind: "calls", file: FILE, line: 1, column: 26 }];
  const [file, owner] = await Promise.all(["file", "Service"].map(async (body) => placed(await callsOf(body, nodes, [], calls, unresolved))));
  assert.deepEqual([file!.references, owner!.references, owner!.writtenOnly], [[], ["Injectable@1:1", "make@1:26"], []]);
});

test("past a line's first character outside ASCII a record is compared on its line, so a column counted in bytes still matches", async () => {
  // run() {                                       (2)
  //   log("é"); alpha();                          (3)  the index counts é as two columns
  // }
  const text = { 3: '  log("é"); alpha();' };
  const found = placed(await callsOf("run", [RUN, ...LIB], [{ from: "run", to: "alpha", kind: "calls", line: 3, column: 13 }], [written(3, 3, "log", "log"), written(3, 13, "alpha", "alpha")], [], [], text));
  assert.deepEqual({ edges: found.edges, contradicted: found.contradicted }, { edges: ["alpha@3:12"], contradicted: [] });
});

test("a top-level call and a static initializer's call match the records of the file and of the constant", async () => {
  // enableProdMode();                                                  (1)
  // class App {                                                        (2)
  //   private static final Logger LOG = LoggerFactory.getLogger(App.class);   (3)
  // }                                                                  (4)
  const app = scope("App", 2, 0, 4, 1);
  const log = { ...scope("LOG", 3, 30, 3, 70), nameColumn: 30 };
  const nodes = [fakeNode("main", "file", FILE, 1, 5), { ...fakeNode("App", "class", FILE, 2, 4), startColumn: 0, endColumn: 1 }, { ...fakeNode("LOG", "constant", FILE, 3, 3), startColumn: 30, endColumn: 70 }];
  const calls = [written(1, 1, "enableProdMode", "enableProdMode"), ownedBy([app, log], written(3, 37, "LoggerFactory.getLogger", "getLogger"))];
  const unresolved: FakeUnresolved[] = [{ from: "main", name: "enableProdMode", kind: "calls", file: FILE, line: 1, column: 0 }, { from: "LOG", name: "LoggerFactory.getLogger", kind: "calls", file: FILE, line: 3, column: 36 }];
  const [main, constant, owner] = await Promise.all(["main", "LOG", "App"].map(async (body) => placed(await callsOf(body, nodes, [], calls, unresolved))));
  assert.deepEqual([main!.references, main!.writtenOnly, constant!.references, constant!.contradicted, owner!.writtenOnly], [["enableProdMode@1:0"], [], ["LoggerFactory.getLogger@3:36"], [], []]);
});
