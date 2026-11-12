import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode } from "../navigation/fake-code-graph.testing.ts";
import { readOutline as readOutlineWithModel } from "./outline.ts";
import { createDeclarationModel } from "../navigation/declaration-model.ts";

const readOutline = (store: Parameters<typeof readOutlineWithModel>[0], files: readonly string[], modules: Parameters<typeof readOutlineWithModel>[2], model = createDeclarationModel({ store, declarationsIn: async () => [] })) => readOutlineWithModel(store, files, modules, model);

const NO_MODULES = { files: [], dependencies: [], unread: [] };

test("a syntax-only member is outlined with its own span under its proven holder", async () => {
  const file = "src/store.ts";
  const store = fakeCodeGraph([fakeNode("D", "constant", file, 1, 8)], []);
  const model = createDeclarationModel({ store, declarationsIn: async () => [{ name: "m", kind: "method", invoked: true, container: { line: 1, column: 0 }, span: { start: { line: 3, column: 2 }, end: { line: 5, column: 3 } } }] });
  const answer = await readOutline(store, [file], NO_MODULES, model);
  assert.deepEqual(answer.value.files[0]?.declarations, [{ kind: "constant", name: "D", line: 1, endLine: 8, children: [{ kind: "method", name: "m", line: 3, endLine: 5 }] }]);
});

test("a file answers its declarations in line order with their spans, and a file the index does not hold is unheld", async () => {
  const store = fakeCodeGraph(
    [
      fakeNode("Order.java", "file", "src/Order.java", 1, 40),
      fakeNode("Order.total", "method", "src/Order.java", 20, 24, "total"),
      fakeNode("Order", "class", "src/Order.java", 3, 40, "Order"),
      fakeNode("Order.id", "field", "src/Order.java", 5, 5, "id"),
      fakeNode("java.util", "import", "src/Order.java", 1, 1, "java.util"),
    ],
    [],
  );
  const read = (await readOutline(store, ["src/Order.java", "src/Gone.java"], NO_MODULES)).value;
  assert.deepEqual(read.unheld, ["src/Gone.java"]);
  assert.deepEqual(read.files, [
    {
      file: "src/Order.java",
      declarations: [
        { kind: "class", name: "Order", line: 3, endLine: 40 },
        { kind: "field", name: "id", line: 5, endLine: 5 },
        { kind: "method", name: "total", line: 20, endLine: 24 },
      ],
      imports: [],
    },
  ]);
});

test("a declaration a contains edge places inside another declaration of the file is listed under it, at any depth", async () => {
  const store = fakeCodeGraph(
    [
      fakeNode("file", "file", "src/auth.ts", 1, 60),
      fakeNode("Auth", "class", "src/auth.ts", 3, 40, "AuthService"),
      fakeNode("Auth.login", "method", "src/auth.ts", 10, 30, "login"),
      fakeNode("Auth.login.check", "function", "src/auth.ts", 12, 14, "check"),
      fakeNode("helper", "function", "src/auth.ts", 45, 50, "helper"),
    ],
    [
      { from: "file", to: "Auth", kind: "contains" },
      { from: "file", to: "helper", kind: "contains" },
      { from: "Auth", to: "Auth.login", kind: "contains" },
      { from: "Auth.login", to: "Auth.login.check", kind: "contains" },
    ],
  );
  assert.deepEqual((await readOutline(store, ["src/auth.ts"], NO_MODULES)).value.files[0]?.declarations, [
    {
      kind: "class",
      name: "AuthService",
      line: 3,
      endLine: 40,
      children: [{ kind: "method", name: "login", line: 10, endLine: 30, children: [{ kind: "function", name: "check", line: 12, endLine: 14 }] }],
    },
    { kind: "function", name: "helper", line: 45, endLine: 50 },
  ]);
});

test("the children of a declaration come in line order, then name order, whatever order the edges come in", async () => {
  const store = fakeCodeGraph(
    [
      fakeNode("Auth", "class", "src/auth.ts", 3, 40, "AuthService"),
      fakeNode("Auth.token", "property", "src/auth.ts", 5, 5, "token"),
      fakeNode("Auth.id", "property", "src/auth.ts", 5, 5, "id"),
      fakeNode("Auth.login", "method", "src/auth.ts", 4, 4, "login"),
    ],
    [
      { from: "Auth", to: "Auth.token", kind: "contains" },
      { from: "Auth", to: "Auth.login", kind: "contains" },
      { from: "Auth", to: "Auth.id", kind: "contains" },
    ],
  );
  const [only] = (await readOutline(store, ["src/auth.ts"], NO_MODULES)).value.files[0]?.declarations ?? [];
  assert.deepEqual(only?.children?.map((child) => child.name), ["login", "id", "token"]);
});

test("a declaration no contains edge places inside a declaration of its file stays at the top level, even inside another's span", async () => {
  const store = fakeCodeGraph(
    [
      fakeNode("Auth", "class", "src/auth.ts", 3, 40, "AuthService"),
      fakeNode("Auth.route", "route", "src/auth.ts", 10, 10, "GET /login"),
      fakeNode("Auth.login", "method", "src/auth.ts", 10, 20, "login"),
      fakeNode("other", "class", "src/other.ts", 1, 90, "Other"),
    ],
    [{ from: "other", to: "Auth.login", kind: "contains" }],
  );
  assert.deepEqual((await readOutline(store, ["src/auth.ts"], NO_MODULES)).value.files[0]?.declarations.map((declaration) => declaration.name), ["AuthService", "GET /login", "login"]);
});
