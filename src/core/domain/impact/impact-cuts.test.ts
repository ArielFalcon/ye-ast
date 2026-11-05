import { test } from "node:test";
import assert from "node:assert/strict";
import { referenceKey, nameTail, removedDeclarationCuts, unreadRelationCuts, unresolvedLinkCuts, type UnresolvedUse, type WalkedDeclaration } from "./impact-cuts.ts";

const SAVE: WalkedDeclaration = { file: "src/Repo.java", name: "save", kind: "method", qualifiedName: "Repo::save" };

function use(name: string, kind: string, file = "src/Use.java", line = 3): UnresolvedUse {
  return { name, kind, file, line, from: "caller", column: 0 };
}

function qualified(name: string, kind: string, candidates: readonly string[], file = "src/Use.java", line = 3): UnresolvedUse {
  return { name, kind, file, line, from: "caller", column: 0, candidates };
}

test("the tail of a name is what follows its last separator", () => {
  assert.deepEqual(["x.save", "this.svc.load", "Class.forName", "a::b", "Plain"].map(nameTail), ["save", "load", "forName", "b", "Plain"]);
});

test("a bare call that never resolved and shares a declared method's name is a cut at it, with every place", () => {
  const cuts = unresolvedLinkCuts([use("save", "calls", "src/Repo.java", 9), use("save", "calls", "src/Repo.java", 4)], [SAVE], []);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/Repo.java::save", "src/Repo.java:4", "src/Repo.java:9"] }]);
});

test("a bare call in another file is never attributed to a homonym it did not import", () => {
  const cuts = unresolvedLinkCuts([use("save", "calls", "src/Use.java", 5)], [SAVE], []);

  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/Use.java", "src/Use.java:5 save"] }]);
});

test("a bare call a binding proves is a cut at the declaration that binding names", () => {
  const bound = new Map([[referenceKey(use("save", "calls", "src/Use.java", 5))!, "src/Repo.java"]]);
  const cuts = unresolvedLinkCuts([use("save", "calls", "src/Use.java", 5)], [SAVE], [], new Set(), new Set(), bound);

  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/Repo.java::save", "src/Use.java:5"] }]);
});

test("an external proof retires the reference whose own root it proves", () => {
  const proven = use("inject.save", "calls", "src/Use.java", 3);

  assert.deepEqual(unresolvedLinkCuts([proven], [SAVE], [], new Set(), new Set([referenceKey(proven)!])), []);
});

test("an external proof never retires another reference that shares its line", () => {
  const proven = use("inject.save", "calls", "src/Use.java", 3);
  const other = use("repo.save", "calls", "src/Use.java", 3);

  assert.deepEqual(unresolvedLinkCuts([proven, other], [SAVE], [], new Set(), new Set([referenceKey(proven)!])), [
    { kind: "unresolved-link", at: ["src/Use.java", "src/Use.java:3 repo.save"] },
  ]);
});

test("a settlement retires the reference it names, never another reference that shares its line", () => {
  const settledUse = qualified("this.a.save", "calls", ["Repo::save"], "src/Use.java", 7);
  const other = qualified("this.b.save", "calls", ["Repo::save"], "src/Use.java", 7);

  assert.deepEqual(unresolvedLinkCuts([settledUse, other], [SAVE], [], new Set(), new Set([referenceKey(settledUse)!])), [
    { kind: "unresolved-link", at: ["src/Repo.java::save", "src/Use.java:7"] },
  ]);
});

test("a qualified call the index considered for the walked declaration is a cut at it", () => {
  const cuts = unresolvedLinkCuts([qualified("this.repo.save", "calls", ["Repo::save"], "src/Use.java", 5)], [SAVE], []);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/Repo.java::save", "src/Use.java:5"] }]);
});

test("a qualified call whose receiver the index attributed to no candidate is never a cut at a homonym, but cuts the caller's file and names the reference", () => {
  const resolve: WalkedDeclaration = { file: "src/app/address.service.ts", name: "resolve", kind: "method", qualifiedName: "AddressService::resolve" };
  const cuts = unresolvedLinkCuts([qualified("Promise.resolve", "calls", [], "src/app/order.component.ts", 12)], [resolve], []);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/app/order.component.ts", "src/app/order.component.ts:12 Promise.resolve"] }]);
});

test("a qualified call the index considered for another declaration cuts the caller's file, not the walked one", () => {
  const cuts = unresolvedLinkCuts([qualified("this.repo.save", "calls", ["Other::save"], "src/Use.java", 5)], [SAVE], []);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/Use.java", "src/Use.java:5 this.repo.save"] }]);
});

test("a qualified call whose tail names no walked declaration is no cut", () => {
  assert.deepEqual(unresolvedLinkCuts([use("Promise.resolve", "calls"), use("repo.find", "calls")], [SAVE], []), []);
});

test("a call or a reference that never resolved and names a walked class field is a cut at it when the index considered it", () => {
  const total: WalkedDeclaration = { file: "src/store.ts", name: "total", kind: "property", qualifiedName: "Sale::total" };
  const cuts = unresolvedLinkCuts([qualified("this.sale.total", "calls", ["Sale::total"], "src/page.ts", 7), qualified("sale.total", "references", ["Sale::total"], "src/view.ts", 2)], [total], []);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/store.ts::total", "src/page.ts:7", "src/view.ts:2"] }]);
});

test("an unresolved reference whose kind cannot point at the walked kind is no cut", () => {
  assert.deepEqual(unresolvedLinkCuts([use("repo.save", "instantiates"), use("save", "imports"), use("save", "extends")], [SAVE], []), []);
});

test("an unresolved reference to a name no walked declaration has is no cut", () => {
  assert.deepEqual(unresolvedLinkCuts([use("repo.find", "calls")], [SAVE], []), []);
});

test("a file that loads a module by a computed name is a cut at the call, walked declarations or not", () => {
  const cuts = unresolvedLinkCuts([use("require", "calls", "src/a.ts", 7), use("Class.forName", "calls", "src/B.java", 2), use("require", "references", "src/c.ts", 1)], [], []);
  assert.deepEqual(cuts, [
    { kind: "unresolved-link", at: ["src/a.ts", "src/a.ts:7 require"] },
    { kind: "unresolved-link", at: ["src/B.java", "src/B.java:2 Class.forName"] },
  ]);
});

test("two computed-name loads in one file are one cut led by the file, with both places", () => {
  const cuts = unresolvedLinkCuts([use("require", "calls", "src/a.ts", 9), use("import", "calls", "src/a.ts", 2)], [], []);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/a.ts", "src/a.ts:2 import", "src/a.ts:9 require"] }]);
});

test("a load whose specifier is a literal names its module and is no cut, and a place with any computed load stays one", () => {
  const references = [use("import", "calls", "src/app.ts", 3), use("import", "calls", "src/routes.ts", 8), use("import", "calls", "src/read.ts", 1)];
  const loads = [
    { file: "src/app.ts", line: 3, specifier: "./app.component" },
    { file: "src/routes.ts", line: 8, specifier: "./one.routes" },
    { file: "src/routes.ts", line: 8 },
    { file: "src/read.ts", line: 1 },
  ];
  assert.deepEqual(unresolvedLinkCuts(references, [], loads), [
    { kind: "unresolved-link", at: ["src/routes.ts", "src/routes.ts:8 import"] },
    { kind: "unresolved-link", at: ["src/read.ts", "src/read.ts:1 import"] },
  ]);
});

test("a reference at head that never resolved and names a removed declaration is a cut led by that declaration, with every place", () => {
  const removed = [{ file: "src/Repo.java", name: "save" }];
  const cuts = removedDeclarationCuts([use("repo.save", "calls", "src/B.java", 9), use("save", "references", "src/A.java", 4), use("repo.find", "calls")], removed);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/Repo.java::save", "src/A.java:4", "src/B.java:9"] }]);
});

test("a removed declaration nothing at head names is no cut", () => {
  assert.deepEqual(removedDeclarationCuts([use("repo.find", "calls")], [{ file: "src/Repo.java", name: "save" }]), []);
});

test("a removed name never captures a reference whose own root is proven external", () => {
  const removed = [{ file: "src/Repo.java", name: "save" }];
  const references = [use("library.save", "calls"), use("repo.save", "calls")];
  const known = new Set([referenceKey(references[0]!)!]);

  assert.deepEqual(removedDeclarationCuts(references, removed, known), [
    { kind: "unresolved-link", at: ["src/Repo.java::save", "src/Use.java:3"] },
  ]);
  assert.deepEqual(removedDeclarationCuts([references[0]!], removed, known), []);
});

test("a removed name keeps an unsettled reference sharing a settled reference's line", () => {
  const removed = [{ file: "src/Repo.java", name: "save" }];
  const settled = use("this.current.save", "calls");
  const unknown = use("this.previous.save", "calls");
  const known = new Set([referenceKey(settled)!]);

  assert.deepEqual(removedDeclarationCuts([settled], removed, known), []);
  assert.deepEqual(removedDeclarationCuts([settled, unknown], removed, known), [
    { kind: "unresolved-link", at: ["src/Repo.java::save", "src/Use.java:3"] },
  ]);
});

test("a removed bare name is attributed only to the file its import proves when that proof is available", () => {
  const reference = use("save", "calls");
  const removed = [{ file: "src/Previous.java", name: "save" }, { file: "src/Current.java", name: "save" }];
  const bound = new Map([[referenceKey(reference)!, "src/Current.java"]]);

  assert.deepEqual(removedDeclarationCuts([reference], removed, new Set(), bound), [
    { kind: "unresolved-link", at: ["src/Current.java::save", "src/Use.java:3"] },
  ]);
});

test("the same name removed from two files is one cut per file", () => {
  const removed = [
    { file: "src/A.java", name: "save" },
    { file: "src/B.java", name: "save" },
  ];
  assert.deepEqual(
    removedDeclarationCuts([use("x.save", "calls", "src/C.java", 1)], removed).map((cut) => cut.at[0]),
    ["src/A.java::save", "src/B.java::save"],
  );
});

test("a relation the reader could not place is a cut only in a file the walk reached, with its place and reason", () => {
  const unread = [
    { path: "src/app/a.ts", line: 9, reason: "unresolved" },
    { path: "src/app/a.ts", line: 3, reason: "no-extractor" },
    { path: "src/app/far.ts", line: 4, reason: "unresolved" },
  ];
  assert.deepEqual(unreadRelationCuts(unread, new Set(["src/app/a.ts", "src/app/b.ts"]), new Map()), [{ kind: "unresolved-link", at: ["src/app/a.ts", "src/app/a.ts:3 no-extractor", "src/app/a.ts:9 unresolved"] }]);
  assert.deepEqual(unreadRelationCuts([], new Set(["src/app/a.ts"]), new Map()), []);
});

test("an unreadable template is a cut when the walk reached a component that names it", () => {
  const unread = [{ path: "src/app/page.html", line: 2, reason: "source-unreadable" }];
  const owners = new Map([["src/app/page.html", ["src/app/page.ts"]]]);
  assert.deepEqual(unreadRelationCuts(unread, new Set(["src/app/page.ts"]), owners), [{ kind: "unresolved-link", at: ["src/app/page.html", "src/app/page.html:2 source-unreadable"] }]);
  assert.deepEqual(unreadRelationCuts(unread, new Set(["src/app/other.ts"]), owners), []);
});

test("same_line_same_name_only_exact_proof_retires", async () => {
  const { referenceKey } = await import("./impact-cuts.ts");
  const first = { ...use("save", "calls", "src/Repo.java", 9), from: "a", column: 0 };
  const second = { ...first, column: 8 };
  assert.deepEqual(unresolvedLinkCuts([first, second], [SAVE], [], new Set(), new Set([referenceKey(first)!])), [{ kind: "unresolved-link", at: ["src/Repo.java::save", "src/Repo.java:9"] }]);
});

test("ambiguous_exact_occurrence_keeps_both", async () => {
  const { referenceKey } = await import("./impact-cuts.ts");
  const occurrence = { ...use("save", "calls", "src/Repo.java", 9), from: "a", column: 0 };
  assert.deepEqual(unresolvedLinkCuts([occurrence, { ...occurrence }], [SAVE], [], new Set(), new Set([referenceKey(occurrence)!])), [{ kind: "unresolved-link", at: ["src/Repo.java::save", "src/Repo.java:9"] }]);
});

test("reference identity preserves all tuple fields and rejects missing coordinates", () => {
  const base = { file: "a\0b", line: 1, column: 0, from: "c", name: "inject", kind: "calls" };
  const variants = [{ ...base, name: "inject().hit" }, { ...base, kind: "references" }, { ...base, from: "d" }, { ...base, file: "a", from: "b\0c" }];
  assert.equal(new Set([referenceKey(base), ...variants.map(referenceKey)]).size, 5);
  const { column: _column, ...noColumn } = base;
  assert.equal(referenceKey(noColumn), undefined);
  assert.equal(referenceKey({ ...base, column: -1 }), undefined);
  assert.equal(referenceKey({ ...base, line: 0 }), undefined);
});

test("local callback excludes only a bare call to a removed declaration in another file", () => {
  const local = { ...use("resolve", "calls", "src/promise.ts", 1), column: 4 };
  const unknown = { ...local, column: 20 };
  const qualified = { ...local, name: "obj.resolve", column: 30 };
  const removed = [{ file: "src/address.ts", name: "resolve" }, { file: "src/promise.ts", name: "resolve" }];
  const proof = new Set([referenceKey(local)!]);
  assert.deepEqual(removedDeclarationCuts([local], removed, new Set(), new Map(), proof), [{ kind: "unresolved-link", at: ["src/promise.ts::resolve", "src/promise.ts:1"] }]);
  assert.equal(removedDeclarationCuts([local, unknown, qualified], removed, new Set(), new Map(), proof).length, 2);
  const { column: _column, ...noColumn } = local;
  assert.equal(removedDeclarationCuts([noColumn], removed, new Set(), new Map(), proof).length, 2);
});

test("anchor settlement does not retire another occurrence on the same line", async () => {
  const { declarationUseKey } = await import("./impact-cuts.ts");
  const a = { ...qualified("this.a.save", "calls", ["Repo::save"], "src/Use.java", 7), column: 0 };
  const b = { ...a, column: 20 };
  const settled = new Set([declarationUseKey("src/Repo.java::save", referenceKey(a)!)]);
  assert.deepEqual(unresolvedLinkCuts([a, b], [SAVE], [], settled), [{ kind: "unresolved-link", at: ["src/Repo.java::save", "src/Use.java:7"] }]);
});

test("missing_column_never_retires", () => {
  const legacy = use("save", "calls", "src/Repo.java", 2);
  const { column: _column, ...withoutColumn } = legacy;
  const imagined = referenceKey(legacy)!;
  assert.deepEqual(unresolvedLinkCuts([withoutColumn], [SAVE], [], new Set(), new Set([imagined])), [{ kind: "unresolved-link", at: ["src/Repo.java::save", "src/Repo.java:2"] }]);
});


test("a joined member target excludes only a distinct expanded declaration and exact occurrence", () => {
  const reference = qualified("this.store.save", "calls", [SAVE.qualifiedName]);
  const key = referenceKey(reference)!;
  const members = { targets: new Map([[key, "src/Other.java::save"]]), expanded: new Set(["src/Repo.java::save"]) };
  assert.deepEqual(unresolvedLinkCuts([reference], [SAVE], [], new Set(), new Set(), new Map(), members), []);
  const baseline = unresolvedLinkCuts([reference], [SAVE], []);
  assert.deepEqual(unresolvedLinkCuts([reference], [SAVE], [], new Set(), new Set(), new Map(), { ...members, expanded: new Set() }), baseline);
  assert.deepEqual(unresolvedLinkCuts([reference], [SAVE], [], new Set(), new Set(), new Map(), { ...members, targets: new Map([[key, "src/Repo.java::save"]]) }), baseline);
  const neighbor = { ...reference, column: 10 };
  assert.deepEqual(unresolvedLinkCuts([neighbor], [SAVE], [], new Set(), new Set(), new Map(), members), baseline);
  assert.deepEqual(unresolvedLinkCuts([reference, reference], [SAVE], [], new Set(), new Set(), new Map(), members), baseline);
});
