import assert from "node:assert/strict";
import test from "node:test";
import type { SourceReading, TokenReading } from "../../domain/change/source-tokens.ts";
import { tokenTexts } from "../../domain/change/token-lines.ts";
import { createTypeScriptTokens } from "./source-tokens.adapter.ts";

const read = (lines: readonly string[]): Promise<SourceReading> => createTypeScriptTokens().tokensOf({ path: "src/a.ts", content: lines.join("\n") });
const reading = async (lines: readonly string[]): Promise<TokenReading> => {
  const held = await read(lines);
  assert.equal(held.status, "read");
  return held as TokenReading;
};
const texts = async (lines: readonly string[]): Promise<readonly string[]> => tokenTexts((await reading(lines)).tokens);
const same = async (base: readonly string[], head: readonly string[]): Promise<void> => assert.deepEqual(await texts(head), await texts(base));
const differs = async (base: readonly string[], head: readonly string[]): Promise<void> => assert.notDeepEqual(await texts(head), await texts(base));

test("JSDoc, blank lines and comments are trivia, so editing them leaves every token equal", async () => {
  await same(["", "/** one */", "export function run(): void {}"], ["", "/** two */", "export function run(): void {}"]);
  await same(["export function one(): void {}", "export function two(): void {}"], ["export function one(): void {}", "", "export function two(): void {}"]);
  await same(["function run(): void {", "  // note", "}"], ["function run(): void {", "  // another", "}"]);
});

test("a line break between two tokens is a token, so a split return or a re-wrapped call changes the tokens", async () => {
  await differs(["function f(x: number) { return x; }"], ["function f(x: number) {", "  return", "  x;", "}"]);
  await differs(["f(a, b);"], ["f(a,", "  b);"]);
});

test("directives, pragmas, bundler annotations and import() comments are tokens", async () => {
  await differs(["// a note", "run();"], ["// @ts-expect-error", "run();"]);
  await differs(['import(/* webpackChunkName: "a" */ "./x");'], ['import(/* webpackChunkName: "b" */ "./x");']);
  await differs(["/*#__PURE__*/ run();"], ["run();"]);
  await differs(["run();"], ["/*@__PURE__*/ run();"]);
  await same(["/* pure */ run();"], ["/* impure */ run();"]);
  await differs(["/// <reference types=\"a\" />", "run();"], ["/// <reference types=\"b\" />", "run();"]);
});

test("an import swap, a decorator argument, a template literal and a type argument all change the tokens", async () => {
  await differs(['import { a } from "./a";', 'import { b } from "./b";'], ['import { b } from "./b";', 'import { a } from "./a";']);
  await differs(["@Component({ selector: \"a\" }) class A {}"], ["@Component({ selector: \"b\" }) class A {}"]);
  await differs(["const page = `a`;"], ["const page = `b`;"]);
  await differs(["const all: List<A> = [];"], ["const all: List<B> = [];"]);
});

test("a source that does not parse is unread", async () => {
  assert.deepEqual(await read(["", "function (", ""]), { status: "unread", reason: "unparsed" });
});

test("the same source read twice gives the same reading", async () => {
  const source = ["export function run(): void {", "  return;", "}"];
  assert.deepEqual(await read(source), await read(source));
});
