import { test } from "node:test";
import assert from "node:assert/strict";
import { joinsFact, type CodeNode } from "./code-node.ts";

const NODE: CodeNode = { file: "src/Orders.java", name: "list", startLine: 10, endLine: 14 };

test("a fact joins the node whose span holds its line, both ends included", () => {
  assert.equal(joinsFact(NODE, { path: "src/Orders.java", line: 10 }), true);
  assert.equal(joinsFact(NODE, { path: "src/Orders.java", line: 14 }), true);
  assert.equal(joinsFact(NODE, { path: "src/Orders.java", line: 9 }), false);
  assert.equal(joinsFact(NODE, { path: "src/Orders.java", line: 15 }), false);
});

test("a fact in another file never joins", () => {
  assert.equal(joinsFact(NODE, { path: "src/Other.java", line: 12 }), false);
});

test("a qualified symbol joins on its simple name only", () => {
  assert.equal(joinsFact(NODE, { path: "src/Orders.java", line: 12, symbol: "OrderController.list" }), true);
  assert.equal(joinsFact(NODE, { path: "src/Orders.java", line: 12, symbol: "list" }), true);
  assert.equal(joinsFact(NODE, { path: "src/Orders.java", line: 12, symbol: "OrderController.show" }), false);
});
