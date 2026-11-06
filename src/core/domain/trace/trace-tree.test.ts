import assert from "node:assert/strict";
import test from "node:test";
import { traceSteps, type ExternalCall, type WalkedStep } from "./trace-tree.ts";

function walked(symbol: string, overrides: Partial<WalkedStep> = {}): WalkedStep {
  return { declaration: { key: `src/${symbol}.ts:${symbol}`, file: `src/${symbol}.ts`, symbol, kind: "function", start: 10, end: 14 }, expanded: true, unsettled: false, children: [], external: [], ...overrides };
}

const CALLS: ExternalCall[] = [{ kind: "unnamed", name: "x.get" }];

test("a proven terminal step folds into its caller's leaves with its location", () => {
  const { steps } = traceSteps([walked("root", { children: [walked("leaf")] })]);
  assert.deepEqual(steps.map((step) => [step.symbol, step.leaves]), [["root", [{ symbol: "leaf", file: "src/leaf.ts", start: 10, end: 14 }]]]);
});

test("a step whose body holds an unsettled call stays a step", () => {
  const { steps } = traceSteps([walked("root", { children: [walked("open", { unsettled: true })] })]);
  assert.deepEqual(steps.map((step) => [step.symbol, step.leaves]), [["root", undefined], ["open", undefined]]);
});

test("a step a bound stopped stays a step", () => {
  const { steps } = traceSteps([walked("root", { children: [walked("stopped", { expanded: false })] })]);
  assert.deepEqual(steps.map((step) => step.symbol), ["root", "stopped"]);
});

test("a step with external calls stays a step, so its calls are not dropped", () => {
  const { steps } = traceSteps([walked("root", { children: [walked("outward", { external: CALLS })] })]);
  assert.deepEqual(steps.map((step) => [step.symbol, step.external]), [["root", undefined], ["outward", [{ kind: "unnamed", names: ["x.get"] }]]]);
});

test("a terminal root stays a step", () => {
  const { steps } = traceSteps([walked("root")]);
  assert.deepEqual(steps.map((step) => [step.id, step.symbol, step.leaves]), [[0, "root", undefined]]);
});

test("a later occurrence of a folded declaration folds too, so no step is seen at a folded one", () => {
  const leaf = walked("leaf");
  const { steps } = traceSteps([walked("root", { children: [leaf, walked("caller", { external: CALLS, children: [walked("leaf", { expanded: false, seen: leaf })] })] })]);
  assert.deepEqual(steps.map((step) => [step.symbol, step.seen, step.leaves?.map(({ symbol }) => symbol)]), [["root", undefined, ["leaf"]], ["caller", undefined, ["leaf"]]]);
});

test("a later occurrence of an expanded declaration is seen at the id of the step that expanded it", () => {
  const first = walked("shared", { external: CALLS });
  const { steps } = traceSteps([walked("root", { children: [first, walked("shared", { expanded: false, seen: first })] })]);
  assert.deepEqual(steps.map((step) => [step.id, step.symbol, step.seen]), [[0, "root", undefined], [1, "shared", undefined], [2, "shared", 1]]);
});

test("one declaration called twice by one step is one leaf", () => {
  const leaf = walked("leaf");
  const { steps } = traceSteps([walked("root", { children: [leaf, walked("leaf", { expanded: false, seen: leaf })] })]);
  assert.deepEqual(steps[0]?.leaves?.map(({ symbol }) => symbol), ["leaf"]);
});

test("ids, parents and depths follow pre-order, and each walked root maps to its id", () => {
  const second = walked("second", { external: CALLS });
  const { steps, ids } = traceSteps([walked("first", { children: [walked("a", { external: CALLS, children: [walked("c", { external: CALLS })] }), walked("b", { external: CALLS })] }), second]);
  assert.deepEqual(steps.map((step) => [step.id, step.symbol, step.parent, step.depth]), [
    [0, "first", undefined, 0],
    [1, "a", 0, 1],
    [2, "c", 1, 2],
    [3, "b", 0, 1],
    [4, "second", undefined, 0],
  ]);
  assert.equal(ids.get(second), 4);
});

test("a step keeps where its parent calls it, how and whether it runs later, and its own span", () => {
  const { steps } = traceSteps([walked("root", { children: [walked("callback", { at: { line: 8, column: 5 }, via: "reference", deferred: true, external: CALLS })] })]);
  const { file, symbol, kind, line, endLine, at, via, deferred } = steps[1]!;
  assert.deepEqual({ file, symbol, kind, line, endLine, at, via, deferred }, { file: "src/callback.ts", symbol: "callback", kind: "function", line: 10, endLine: 14, at: { line: 8, column: 5 }, via: "reference", deferred: true });
});

test("external calls group by module, each name once and sorted, imports first by module, then globals, then unnamed", () => {
  const external: ExternalCall[] = [
    { kind: "unnamed", name: "x.get" },
    { kind: "import", module: "rxjs", name: "subscribe" },
    { kind: "global", name: "setTimeout" },
    { kind: "import", module: "rxjs", name: "pipe" },
    { kind: "import", module: "rxjs", name: "subscribe" },
    { kind: "import", module: "@angular/core", name: "inject" },
  ];
  const { steps } = traceSteps([walked("root", { external })]);
  assert.deepEqual(steps[0]?.external, [
    { kind: "import", module: "@angular/core", names: ["inject"] },
    { kind: "import", module: "rxjs", names: ["pipe", "subscribe"] },
    { kind: "global", names: ["setTimeout"] },
    { kind: "unnamed", names: ["x.get"] },
  ]);
});

test("a root seen at a declaration folded below an earlier root stands as its own step", () => {
  const leaf = walked("leaf");
  const { steps } = traceSteps([walked("root", { children: [leaf] }), walked("leaf", { expanded: false, seen: leaf })]);
  assert.deepEqual(steps[1], { id: 1, depth: 0, file: "src/leaf.ts", symbol: "leaf", kind: "function", line: 10, endLine: 14 });
});

test("a leaf folded from a deferred occurrence stays deferred, apart from a direct call to the same declaration", () => {
  const leaf = walked("leaf");
  const { steps } = traceSteps([walked("root", { children: [leaf, walked("leaf", { expanded: false, seen: leaf, deferred: true })] })]);
  assert.deepEqual(steps[0]?.leaves, [
    { symbol: "leaf", file: "src/leaf.ts", start: 10, end: 14 },
    { symbol: "leaf", file: "src/leaf.ts", start: 10, end: 14, deferred: true },
  ]);
});
