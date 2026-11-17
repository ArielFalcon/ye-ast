import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addedFile, bodyEdit, signatureEdit } from "./warm-differential-edits.ts";

const JAVA = [
  "public class OrderService {",
  "  public OrderService(Repo repo) {",
  "  }",
  "  @GetMapping(\"/orders\")",
  "  public List<Order> list(int page) {",
  "    if (page > 0) {",
  "      repo.find(page, (a) -> {",
  "      });",
  "    }",
  "  }",
  "}",
].join("\n");

describe("bodyEdit", () => {
  it("inserts a statement after the first method body opener, skipping control blocks and lambdas", () => {
    const lines = bodyEdit("src/OrderService.java", JAVA)!.split("\n");
    assert.equal(lines[2], "int yeAstEdit = 0;");
    assert.equal(lines.length, JAVA.split("\n").length + 1);
  });

  it("is undefined for a file with no body opener, so the step is skipped instead of edited otherwise", () => {
    assert.equal(bodyEdit("src/types.ts", "export interface A {\n  b: string;\n}"), undefined);
  });
});

describe("signatureEdit", () => {
  it("renames the first declared method, never the constructor, a control block or a lambda's call", () => {
    const edited = signatureEdit("src/OrderService.java", JAVA)!.split("\n");
    assert.equal(edited[4], "  public List<Order> listYeAst(int page) {");
    assert.deepEqual(edited.filter((_, index) => index !== 4), JAVA.split("\n").filter((_, index) => index !== 4));
  });

  it("renames a TypeScript method whose return type closes a generic", () => {
    assert.equal(signatureEdit("src/a.service.ts", "export class A {\n  load(id: string): Promise<void> {\n  }\n}"), "export class A {\n  loadYeAst(id: string): Promise<void> {\n  }\n}");
  });
});

describe("addedFile", () => {
  it("names the copy after the original and renames only whole occurrences of its own type", () => {
    assert.deepEqual(addedFile("src/a/Order.java", "class Order { OrderLine line; Order next; }"), { path: "src/a/OrderYeAst.java", text: "class OrderYeAst { OrderLine line; OrderYeAst next; }" });
  });
});
