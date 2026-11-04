import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeclarationEvidenceReader } from "./declaration-evidence.adapter.ts";

const reader = createDeclarationEvidenceReader();
const check = (base: string | undefined, head: string | undefined, names: string[], deleted = false, path = "src/a.ts") =>
  reader.validate({ path, base, head, names, deleted });

test("rejects callback calls while retaining genuinely removed declarations by owner", () => {
  assert.deepEqual(check('class A { save() {} } class B { save() {} }\neffect(() => { });', 'class B { save() {} }', ["effect", "save"]), ["save"]);
});

test("retains uncertain sources and recognizes deleted files", () => {
  assert.deepEqual(check(undefined, '', ['x']), ['x']);
  assert.deepEqual(check('function x( {', '', ['x']), ['x']);
  assert.deepEqual(check('function x() {}', undefined, ['x', 'effect'], true), ['x']);
  assert.deepEqual(check('effect(() => {})', '', ['effect'], false, 'src/a.java'), ['effect']);
});

test("recognizes nested and multiline declarations and signature changes", () => {
  assert.deepEqual(check('class A {\n save(\n x: string\n): void {}\n}', 'class A { save(x: number): void {} }', ['save']), []);
  assert.deepEqual(check('class A { save(x: string): void; save(x: any) {} }', 'class A { save(x: any) {} }', ['save']), ['save']);
  assert.deepEqual(check('function outer() { function inner() {} }', 'function outer() {}', ['inner']), ['inner']);
});


test("unnamed blocks cannot conceal a deleted declaration behind a homonym", () => {
  assert.deepEqual(check('{ function save() {} } { function save() {} }', '{ function save() {} }', ['save']), ['save']);
  assert.deepEqual(check('class A { save() {} } class A { save() {} }', 'class A { save() {} } class A { save() {} }', ['save']), ['save']);
});

test("a removed constructor remains a candidate", () => {
  assert.deepEqual(check('class A { constructor() {} }', 'class A {}', ['constructor']), ['constructor']);
});

test("renames and moves do not conceal existing candidates", () => {
  assert.deepEqual(check('class A { save() {} }', 'class B { save() {} }', ['save']), ['save']);
  assert.deepEqual(check('function save() {}', 'function send() {}', ['save']), ['save']);
  assert.deepEqual(check('class A { save() {} }', 'class A { save() {} }', ['save']), []);
});

test("computed declarations and malformed heads keep candidates", () => {
  assert.deepEqual(check('class A { [key]() {} }', 'class A {}', ['key']), ['key']);
  assert.deepEqual(check('function save() {}', 'function broken(', ['save']), ['save']);
  assert.deepEqual(check('function save() {}', undefined, ['save']), ['save']);
});

test("destructured bindings preserve real deletions without making unrelated callback calls declarations", () => {
  for (const [before, after] of [
    ["const { value: save, ...rest } = input;", "const { value: other } = input;"],
    ["const [save, ...rest] = input;", "const [other] = input;"],
    ["const { nested: { save }, rest } = input;", "const { nested: { other } } = input;"],
  ]) {
    assert.deepEqual(check(`${before}\nobserve(() => {});`, after, ["observe", "save", "rest"]), ["save", "rest"]);
  }
  assert.deepEqual(check("const { value: save } = input;", "const { value: save } = input;", ["save", "value"]), []);
});
