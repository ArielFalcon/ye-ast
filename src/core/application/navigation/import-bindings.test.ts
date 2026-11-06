import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModuleBinding, ModuleDependency } from "../../domain/impact/module-dependency.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge } from "../impact/fake-code-graph.testing.ts";
import { importBindings } from "./import-bindings.ts";

const NODES = [
  fakeNode("use", "file", "src/use.ts", 1, 9),
  fakeNode("barrel", "file", "src/lib/barrel.ts", 1, 3),
  fakeNode("original", "function", "src/lib/defs.ts", 3, 5),
  fakeNode("widgetFile", "file", "src/widget.ts", 1, 4),
  fakeNode("Panel", "class", "src/widget.ts", 2, 4),
];

function binding(overrides: Partial<ModuleBinding> = {}): ModuleBinding {
  return { local: "local", imported: "renamed", line: 1, column: 10, typeOnly: false, ...overrides };
}

function dependency(bindings: ModuleBinding[], file = "src/lib/barrel.ts"): ModuleDependency {
  return { file: "src/use.ts", line: bindings[0]?.line ?? 1, endLine: 1, specifier: "./x", kind: "import", typeOnly: false, target: { kind: "repository", file }, bindings };
}

function reached(edges: FakeEdge[], dependencies: ModuleDependency[]): (string | undefined)[] {
  const map = importBindings(fakeCodeGraph(NODES, edges), "src/use.ts", dependencies);
  return dependencies.flatMap((entry) => entry.bindings.map((item) => map.get(item)?.name));
}

test("a binding reaches the declaration the imports edge at its own position names, through a re-export of another file", () => {
  assert.deepEqual(reached([{ from: "use", to: "original", kind: "imports", line: 1, column: 9 }], [dependency([binding()])]), ["original"]);
});

test("an imports edge at another line or another column than the binding is not the binding's", () => {
  const edges: FakeEdge[] = [{ from: "use", to: "original", kind: "imports", line: 1, column: 20 }, { from: "use", to: "original", kind: "imports", line: 2, column: 9 }];
  assert.deepEqual(reached(edges, [dependency([binding()])]), [undefined]);
});

test("an imports edge that reaches a file never becomes a declaration", () => {
  assert.deepEqual(reached([{ from: "use", to: "widgetFile", kind: "imports", line: 1, column: 9 }], [dependency([binding({ imported: "default" })], "src/widget.ts")]), [undefined]);
});

test("a default binding no edge proves takes the declaration its file exports as default", () => {
  const edges: FakeEdge[] = [{ from: "use", to: "widgetFile", kind: "imports", line: 1, column: 9 }];
  assert.deepEqual(reached(edges, [dependency([binding({ imported: "default", exportedAs: "Panel" })], "src/widget.ts")]), ["Panel"]);
});
