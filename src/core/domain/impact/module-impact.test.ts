import { test } from "node:test";
import assert from "node:assert/strict";
import type { FileChange } from "../change/diff-reader.ts";
import type { ModuleDependencies, ModuleDependency, ModuleSource } from "./module-dependency.ts";
import { moduleImpact } from "./module-impact.ts";

const source = (file: string, statements: string[] = [], moduleOnly = true): ModuleSource => ({ file, statements, moduleOnly });
const change = (path: string, deleted = false): FileChange => ({ path, deleted, binary: false, added: [], removals: [], removedNames: [] });
const edge = (file: string, target: string, overrides: Partial<ModuleDependency> = {}): ModuleDependency => ({ file, line: 7, endLine: 7, specifier: "@alias/target", kind: "import", typeOnly: false, target: { kind: "repository", file: target }, ...overrides });

test("referenced JSON content changes and deletions reach consumers without declaration origins", () => {
  const data = { ...source("data.json", ['{"value":1}']), resource: true as const };
  const dependency = edge("consumer.ts", "data.json");
  const base = snapshot([data, source("consumer.ts")], [dependency]);
  const head = snapshot([{ ...data, statements: ['{"value":2}'] }, source("consumer.ts")], [dependency]);
  const read = moduleImpact([change("data.json")], base, head);
  assert.deepEqual(read.value.origins, [{ file: "data.json", change: "modified" }]);
  assert.equal(read.value.modules.filter(({ file }) => file === "consumer.ts").length, 2);
  assert.ok(read.covered.has("data.json"));
  const deleted = moduleImpact([change("data.json", true)], base, snapshot([source("consumer.ts")]));
  assert.deepEqual(deleted.value.modules.map(({ snapshot, file }) => [snapshot, file]), [["base", "data.json"], ["base", "consumer.ts"]]);
});

test("conditional module evidence survives traversal and exact unsupported references remain cuts", () => {
  const untraversed = [{ file: "consumer.ts", line: 3, offset: 90, form: "dynamic-import" as const }];
  const base = { ...snapshot([source("root.ts", ["old"]), source("consumer.ts")], [edge("consumer.ts", "root.ts", { form: "dynamic-import", offset: 10 })]), untraversed };
  const head = { ...base, files: [source("root.ts", ["new"]), source("consumer.ts")] };
  const read = moduleImpact([change("root.ts")], base, head);
  assert.equal(read.value.modules.find(({ file }) => file === "consumer.ts")?.via?.form, "dynamic-import");
  assert.equal(read.cuts.length, 2);
  assert.ok(read.cuts.every((cut) => cut.at.some((place) => place.includes("offset 90"))));
});

test("an unread selected JSON resource cannot look like a complete empty change", () => {
  const base = snapshot([], [], [{ file: "data.json", reason: "source-unreadable" }]);
  const head = snapshot([{ ...source("data.json", ["new"]), resource: true }]);
  const read = moduleImpact([change("data.json")], base, head);
  assert.deepEqual(read.value.origins, []);
  assert.ok(read.cuts.some((cut) => cut.kind === "no-extractor" && cut.at.includes("module:base:data.json")));
});

test("module coverage gaps remain visible when unread origins prevent traversal", () => {
  const unread = [{ file: "root.ts", reason: "source-unreadable" as const }, { file: "consumer.ts", reason: "source-unreadable" as const }];
  const incomplete = {
    ...snapshot([], [edge("another.ts", "missing.ts", { target: { kind: "unresolved" as const, reason: "missing" } })], unread),
    untraversed: [{ file: "dynamic.ts", line: 4, offset: 25, form: "dynamic-import" as const }],
  };
  const result = moduleImpact([change("root.ts")], incomplete, incomplete);
  assert.deepEqual(result.value, { origins: [], modules: [], cost: { expansionsUsed: 0 } });
  assert.equal(result.covered.size, 0);
  for (const snapshot of ["base", "head"]) {
    for (const file of ["root.ts", "consumer.ts"]) assert.ok(result.cuts.some((cut) => cut.kind === "no-extractor" && cut.at.includes(`module:${snapshot}:${file}`)));
    for (const file of ["another.ts", "dynamic.ts"]) assert.ok(result.cuts.some((cut) => cut.kind === "unresolved-link" && cut.at.includes(`module:${snapshot}:${file}`)));
  }
});
const snapshot = (files: ModuleSource[], dependencies: ModuleDependency[] = [], unread: ModuleDependencies["unread"] = []): ModuleDependencies => ({ files, dependencies, unread });

test("traverses alias-resolved reexports with separate snapshot evidence", () => {
  const base = snapshot([source("barrel.ts", ["export old"]), source("middle.ts"), source("app.ts")], [edge("middle.ts", "barrel.ts", { kind: "reexport", typeOnly: true }), edge("app.ts", "middle.ts")]);
  const head = snapshot([source("barrel.ts", ["export new"]), source("middle.ts"), source("app.ts")], [edge("middle.ts", "barrel.ts", { line: 9, kind: "reexport", typeOnly: true }), edge("app.ts", "middle.ts")]);
  const result = moduleImpact([change("barrel.ts")], base, head);
  assert.deepEqual(result.value.origins, [{ file: "barrel.ts", change: "modified" }]);
  assert.deepEqual(result.value.modules.filter((item) => item.file === "middle.ts").map(({ snapshot, depth, origins, via }) => ({ snapshot, depth, origins, via })), [
    { snapshot: "base", depth: 1, origins: [0], via: { file: "barrel.ts", line: 7, specifier: "@alias/target", kind: "reexport", typeOnly: true } },
    { snapshot: "head", depth: 1, origins: [0], via: { file: "barrel.ts", line: 9, specifier: "@alias/target", kind: "reexport", typeOnly: true } },
  ]);
  assert.equal(result.value.modules.filter((item) => item.file === "app.ts").length, 2);
  assert.deepEqual([...result.covered], ["barrel.ts"]);
});

test("preserves origins in cycles without crossing depth bounds", () => {
  const files = [source("a.ts", ["old"]), source("b.ts", ["old"]), source("c.ts")];
  const graph = [edge("b.ts", "a.ts"), edge("a.ts", "b.ts"), edge("c.ts", "b.ts")];
  const result = moduleImpact([change("a.ts"), change("b.ts")], snapshot(files, graph), snapshot([source("a.ts", ["new"]), source("b.ts", ["new"]), source("c.ts")], graph), { depth: 1 });
  assert.deepEqual(result.value.modules.filter((item) => item.file === "c.ts").map((item) => item.origins), [[1], [1]]);
});

test("ignores declaration-only edits and test origins", () => {
  const base = snapshot([source("body.ts", ["import x"], false), source("a.test.ts", ["old"])]);
  const head = snapshot([source("body.ts", ["import x"], false), source("a.test.ts", ["new"])]);
  const result = moduleImpact([change("body.ts"), change("a.test.ts")], base, head);
  assert.deepEqual(result.value, { origins: [], modules: [], cost: { expansionsUsed: 0 } });
  assert.deepEqual(result.cuts, []);
});

test("a reached module does not hide provenance truncated for another origin", () => {
  const base = snapshot([source("a.ts", ["old"]), source("b.ts", ["old"]), source("x.ts"), source("z.ts")], [edge("x.ts", "a.ts"), edge("z.ts", "x.ts"), edge("z.ts", "b.ts")]);
  const head = { ...base, files: base.files.map((file) => file.file === "a.ts" || file.file === "b.ts" ? { ...file, statements: ["new"] } : file) };
  const result = moduleImpact([change("a.ts"), change("b.ts")], base, head, { depth: 1 });
  assert.deepEqual(result.value.modules.find((module) => module.file === "z.ts" && module.snapshot === "head")?.origins, [1]);
  assert.ok(result.cuts.some((cut) => cut.kind === "depth" && cut.at.includes("module:head:x.ts")));
  assert.equal(result.covered.size, 2);
});

test("an unread selected module remains a cut even when its surface cannot be read", () => {
  const result = moduleImpact([change("broken.ts")], snapshot([]), snapshot([], [], [{ file: "broken.ts", reason: "source-unreadable" }]));
  assert.equal(result.value.origins.length, 0);
  assert.ok(result.cuts.some((cut) => cut.kind === "no-extractor" && cut.at.includes("module:head:broken.ts")));
});

test("deleted module retains only base traversal and unresolved head remains a cut", () => {
  const base = snapshot([source("gone.ts"), source("user.ts")], [edge("user.ts", "gone.ts")]);
  const head = snapshot([source("user.ts")], [edge("user.ts", "gone.ts", { target: { kind: "unresolved", reason: "missing" } })]);
  const result = moduleImpact([change("gone.ts", true)], base, head);
  assert.deepEqual(result.value.origins, [{ file: "gone.ts", change: "deleted" }]);
  assert.deepEqual(result.value.modules.map(({ file, snapshot }) => [file, snapshot]), [["gone.ts", "base"], ["user.ts", "base"]]);
  assert.ok(result.cuts.some((cut) => cut.kind === "unresolved-link" && cut.at.some((at) => at.includes("user.ts:7"))));
  assert.deepEqual([...result.covered], ["gone.ts"]);
});

test("source coverage is independent of traversal cuts but never masks an unread origin", () => {
  const base = snapshot([source("barrel.ts", ["old"]), source("mixed.ts", ["old"], false)], [], [{ file: "unknown.ts", reason: "no-extractor" }]);
  const head = snapshot([source("barrel.ts", ["new"]), source("mixed.ts", ["new"], false)]);
  const result = moduleImpact([change("barrel.ts"), change("mixed.ts")], base, head);
  assert.deepEqual([...result.covered], ["barrel.ts"]);
  assert.ok(result.cuts.some((cut) => cut.kind === "no-extractor" && cut.at.some((at) => at.includes("unknown.ts"))));
  const clean = moduleImpact([change("barrel.ts"), change("mixed.ts")], { ...base, unread: [] }, head);
  assert.deepEqual([...clean.covered], ["barrel.ts"]);
  const unreadOrigin = moduleImpact([change("barrel.ts")], snapshot([], [], [{ file: "barrel.ts", reason: "source-unreadable" }]), head);
  assert.equal(unreadOrigin.covered.size, 0);
});

test("bounds cut only unreached consumers and exclude test consumers", () => {
  const files = [source("root.ts", ["old"]), source("a.ts"), source("b.ts"), source("a.test.ts")];
  const edges = [edge("a.ts", "root.ts"), edge("b.ts", "root.ts"), edge("a.test.ts", "root.ts")];
  const base = snapshot(files, edges);
  const head = snapshot([source("root.ts", ["new"]), ...files.slice(1)], edges);
  for (const [budget, kind] of [[{ depth: 0 }, "depth"], [{ hubFanIn: 1 }, "hub"], [{ expansions: 0 }, "caller-budget"]] as const) {
    const result = moduleImpact([change("root.ts")], base, head, budget);
    assert.ok(result.cuts.some((cut) => cut.kind === kind && cut.at.includes("module:base:root.ts")));
    assert.deepEqual([...result.covered], ["root.ts"]);
    assert.ok(result.value.modules.every((item) => item.file !== "a.test.ts"));
  }
  const cycle = [edge("a.ts", "root.ts"), edge("root.ts", "a.ts")];
  const complete = moduleImpact([change("root.ts")], snapshot(files, cycle), snapshot([source("root.ts", ["new"]), ...files.slice(1)], cycle), { depth: 1 });
  assert.deepEqual(complete.cuts, []);
  const unbounded = moduleImpact([change("root.ts")], base, head);
  assert.ok(unbounded.value.modules.some((item) => item.file === "a.ts"));
  assert.ok(unbounded.value.modules.every((item) => item.file !== "a.test.ts"));
});

test("classifies new modules and ignores proven external imports deterministically", () => {
  const base = snapshot([]);
  const head = snapshot([source("new.ts", ["import external"]), source("user.ts")], [edge("new.ts", "external", { target: { kind: "external", module: "pkg" } }), edge("user.ts", "new.ts")]);
  const first = moduleImpact([change("new.ts")], base, head);
  assert.deepEqual(first.value.origins, [{ file: "new.ts", change: "added" }]);
  assert.deepEqual(first.cuts, []);
  assert.deepEqual([...first.covered], ["new.ts"]);
  assert.deepEqual(first, moduleImpact([change("new.ts")], base, head));
});

test("shares expansion budget between snapshots", () => {
  const base = snapshot([source("root.ts", ["old"]), source("user.ts")], [edge("user.ts", "root.ts")]);
  const head = snapshot([source("root.ts", ["new"]), source("user.ts")], [edge("user.ts", "root.ts")]);
  const result = moduleImpact([change("root.ts")], base, head, { expansions: 2 });
  assert.equal(result.value.cost.expansionsUsed, 2);
  assert.ok(result.cuts.some((cut) => cut.kind === "caller-budget" && cut.at.includes("module:head:root.ts")));
});
