import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode } from "../impact/fake-code-graph.testing.ts";
import { readOutline } from "./outline.ts";

test("a file answers its declarations in line order with their spans, and a file the index does not hold is unheld", () => {
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
  const read = readOutline(store, ["src/Order.java", "src/Gone.java"]);
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

test("imports name the files the edges reach once each, never the file itself", () => {  const store = fakeCodeGraph(
    [
      fakeNode("a", "file", "src/a.ts", 1, 9),
      fakeNode("a.own", "function", "src/a.ts", 3, 7, "own"),
      fakeNode("b", "file", "src/b.ts", 1, 9),
      fakeNode("b.one", "function", "src/b.ts", 2, 4, "one"),
      fakeNode("c", "file", "src/c.ts", 1, 9),
    ],
    [
      { from: "a", to: "b", kind: "imports", line: 1 },
      { from: "a", to: "c", kind: "imports", line: 2 },
      { from: "a", to: "b", kind: "imports", line: 3 },
      { from: "a", to: "a.own", kind: "contains" },
    ],
  );
  const read = readOutline(store, ["src/a.ts"]);
  assert.deepEqual(read.files.map((file) => file.imports), [["src/b.ts", "src/c.ts"]]);
  assert.deepEqual(read.unheld, []);
});

test("an imports edge whose target the store does not know names no file", () => {
  const store = fakeCodeGraph(
    [fakeNode("a", "file", "src/a.ts", 1, 9), fakeNode("a.own", "function", "src/a.ts", 3, 7, "own")],
    [{ from: "a", to: "gone", kind: "imports", line: 1 }],
  );
  const read = readOutline(store, ["src/a.ts"]);
  assert.deepEqual(read.files.map((file) => file.imports), [[]]);
  assert.deepEqual(read.unheld, []);
});

test("a declaration a contains edge places inside another declaration of the file is listed under it, at any depth", () => {
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
  assert.deepEqual(readOutline(store, ["src/auth.ts"]).files[0]?.declarations, [
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

test("the children of a declaration come in line order, then name order, whatever order the edges come in", () => {
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
  const [only] = readOutline(store, ["src/auth.ts"]).files[0]?.declarations ?? [];
  assert.deepEqual(only?.children?.map((child) => child.name), ["login", "id", "token"]);
});

test("a declaration no contains edge places inside a declaration of its file stays at the top level, even inside another's span", () => {
  const store = fakeCodeGraph(
    [
      fakeNode("Auth", "class", "src/auth.ts", 3, 40, "AuthService"),
      fakeNode("Auth.route", "route", "src/auth.ts", 10, 10, "GET /login"),
      fakeNode("Auth.login", "method", "src/auth.ts", 10, 20, "login"),
      fakeNode("other", "class", "src/other.ts", 1, 90, "Other"),
    ],
    [{ from: "other", to: "Auth.login", kind: "contains" }],
  );
  assert.deepEqual(readOutline(store, ["src/auth.ts"]).files[0]?.declarations.map((declaration) => declaration.name), ["AuthService", "GET /login", "login"]);
});
