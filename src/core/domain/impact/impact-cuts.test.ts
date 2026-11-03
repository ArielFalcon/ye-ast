import { test } from "node:test";
import assert from "node:assert/strict";
import { nameTail, removedDeclarationCuts, unreadRelationCuts, unresolvedLinkCuts, type UnresolvedUse, type WalkedDeclaration } from "./impact-cuts.ts";

const SAVE: WalkedDeclaration = { file: "src/Repo.java", name: "save", kind: "method", qualifiedName: "Repo::save" };

function use(name: string, kind: string, file = "src/Use.java", line = 3): UnresolvedUse {
  return { name, kind, file, line };
}

function qualified(name: string, kind: string, candidates: readonly string[], file = "src/Use.java", line = 3): UnresolvedUse {
  return { name, kind, file, line, candidates };
}

test("the tail of a name is what follows its last separator", () => {
  assert.deepEqual(["x.save", "this.svc.load", "Class.forName", "a::b", "Plain"].map(nameTail), ["save", "load", "forName", "b", "Plain"]);
});

test("a bare call that never resolved and shares a walked method's name is a cut at it, with every place", () => {
  const cuts = unresolvedLinkCuts([use("save", "calls", "src/B.java", 9), use("save", "calls", "src/A.java", 4)], [SAVE], []);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/Repo.java::save", "src/A.java:4", "src/B.java:9"] }]);
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
