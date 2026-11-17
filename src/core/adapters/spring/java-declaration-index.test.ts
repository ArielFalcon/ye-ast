import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaProject, scopeOf, type JavaProject } from "./java-symbols.ts";
import { questions } from "./java-declaration-questions.ts";
import { javaDeclarationIndex, type JavaDeclarationIndex } from "./java-declaration-index.ts";
import { declarationsOf } from "./java-declarations.ts";
import { withJavaSources } from "./java-project.ts";
import { rememberingFacts } from "./remembering-facts.testing.ts";

const BASE = { path: "app/Base.java", content: "package app;\npublic class Base { static final String KEY = \"k\"; void run() {} }\n" };
const IMPL = {
  path: "app/Impl.java",
  content: [
    "package app;",
    "import java.util.function.Supplier;",
    "@Service class Impl extends Base implements Runnable {",
    "  public void run() { Supplier<String> s = Impl::name; Object o = new Base() {}; }",
    "  String name() { return \"\"; }",
    "}",
    "",
  ].join("\n"),
};
const UNPARSED = { path: "app/Broken.java", content: "package app; class {" };
const BODY_ERROR = { path: "app/Half.java", content: "package app; class Half { void m() { int x = ; } }" };

const fingerprint = (inputs: object) => JSON.stringify(inputs);
const INPUTS = { generatesInterfaces: false, unreadJvm: false };

async function indexOf(sources: readonly { path: string; content: string }[], inputs = INPUTS): Promise<JavaDeclarationIndex> {
  return javaDeclarationIndex(rememberingFacts(), await createJavaParser(), sources, inputs);
}

test("the declarations of a file are plain data: its names, its supertypes and what its bodies write", async () => {
  const entry = declarationsOf(await createJavaParser(), IMPL, fingerprint);
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
  assert.equal(entry.state, "read");
  assert.equal(entry.header.packageName, "app");
  assert.deepEqual(entry.types.map(({ fqn, annotations, supertypes }) => ({ fqn, annotations, supertypes })), [{ fqn: "app.Impl", annotations: ["Service"], supertypes: [{ name: "Runnable", isInterface: true }, { name: "Base", isInterface: false }] }]);
  assert.deepEqual(entry.body, { unplacedSupertypes: ["Base"], methodReferences: ["name"], holdsFunctionValue: true, markers: [] });
});

test("a source states whether it is read in full, for its declarations only, or not at all", async () => {
  const parser = await createJavaParser();
  assert.equal(declarationsOf(parser, BASE, fingerprint).state, "read");
  const half = declarationsOf(parser, BODY_ERROR, fingerprint);
  assert.deepEqual([half.state, "line" in half && half.line, half.types], ["declarations-only", 1, []]);
  const broken = declarationsOf(parser, UNPARSED, fingerprint);
  assert.deepEqual([broken.state, "line" in broken && broken.line, broken.types], ["unparsed", 1, []]);
});

test("a body edit that moves no line keeps the digest of the declarations, and a changed supertype changes it", async () => {
  const parser = await createJavaParser();
  const before = declarationsOf(parser, IMPL, fingerprint);
  const body = declarationsOf(parser, { ...IMPL, content: IMPL.content.replace('return ""', 'return "x"') }, fingerprint);
  const supertype = declarationsOf(parser, { ...IMPL, content: IMPL.content.replace("extends Base", "extends Other") }, fingerprint);
  assert.notEqual(body.content, before.content);
  assert.equal(body.declarationsDigest, before.declarationsDigest);
  assert.notEqual(supertype.declarationsDigest, before.declarationsDigest);
});

test("the index answers each primitive question with sorted plain data, an empty answer included", async () => {
  const index = await indexOf([IMPL, UNPARSED, BASE]);
  assert.equal(index.answer(questions.file("app/Base.java")), declarationsOf(await createJavaParser(), BASE, fingerprint).content);
  assert.equal(index.answer(questions.file("app/Gone.java")), "");
  assert.equal(index.answer(questions.declarations("app/Gone.java")), "");
  assert.equal(index.answer(questions.declaring("app.Base")), '["app/Base.java"]');
  assert.equal(index.answer(questions.declaring("app.Missing")), "[]");
  assert.equal(index.answer(questions.named("Base")), '[["app.Base","app/Base.java"]]');
  assert.equal(index.answer(questions.package("prefix", "app")), "true");
  assert.equal(index.answer(questions.package("prefix", "ap")), "false");
  assert.equal(index.answer(questions.package("typed", "app")), "true");
  assert.equal(index.answer(questions.naming("supertype", "Base")), '["app/Impl.java"]');
  assert.equal(index.answer(questions.naming("unplaced-supertype", "Base")), '["app/Impl.java"]');
  assert.equal(index.answer(questions.naming("method-reference", "name")), '["app/Impl.java"]');
  assert.equal(index.answer(questions.naming("annotation", "Service")), '["app/Impl.java"]');
  assert.equal(index.answer(questions.naming("constant", "KEY")), '["app/Base.java"]');
  assert.equal(index.answer(questions.naming("constant", "NONE")), "[]");
  assert.equal(index.answer(questions.marked("aspect")), "[]");
  assert.deepEqual(JSON.parse(index.answer(questions.unread())), { files: [["app/Broken.java", "unparsed"]], unreadJvm: false });
  assert.equal(index.answer(questions.build("claimed")), "[]");
  assert.deepEqual(index.unread().map(({ path, state }) => [path, state.state]), [["app/Broken.java", "unparsed"]]);
});

test("a file that appears changes the answers about the names it declares and no other answer", async () => {
  const before = await indexOf([BASE]);
  const after = await indexOf([BASE, { path: "other/Late.java", content: "package other; class Late { static final int KEY = 1; }" }]);
  assert.equal(before.answer(questions.declaring("other.Late")), "[]");
  assert.equal(after.answer(questions.declaring("other.Late")), '["other/Late.java"]');
  assert.equal(after.answer(questions.package("prefix", "other")), "true");
  assert.equal(after.answer(questions.naming("constant", "KEY")), '["app/Base.java","other/Late.java"]');
  assert.notEqual(after.answer(questions.listing()), before.answer(questions.listing()));
  for (const unchanged of [questions.declaring("app.Base"), questions.named("Base"), questions.file("app/Base.java"), questions.declarations("app/Base.java"), questions.package("prefix", "app")]) assert.equal(after.answer(unchanged), before.answer(unchanged), unchanged);
});

test("the platform packages the sources claim, the build and the JVM sources no extractor reads are answered", async () => {
  const claiming = await indexOf([{ path: "x/Own.java", content: "package org.springframework.boot.custom; class Own {}" }], { generatesInterfaces: true, unreadJvm: true });
  assert.equal(claiming.answer(questions.build("claimed")), '["org.springframework.boot."]');
  assert.equal(claiming.answer(questions.build("generatesInterfaces")), "true");
  assert.equal(JSON.parse(claiming.answer(questions.unread())).unreadJvm, true);
});

test("the index declares the types the project over the same sources declares", async () => {
  const sources = [BASE, IMPL, { path: "b/Other.java", content: "package b; class Other { class Inner { static final int KEY = 2; } }" }];
  const index = await indexOf(sources);
  const declared = withJavaSources(await createJavaParser(), (parse) => createJavaProject(parse(sources).files).types.map((type) => [type.fqn, type.file.path, type.name] as const));
  assert.equal(declared.length, 4);
  for (const [fqn, path, name] of declared) {
    assert.ok(JSON.parse(index.answer(questions.declaring(fqn))).includes(path), fqn);
    assert.ok(JSON.parse(index.answer(questions.named(name))).some((pair: string[]) => pair[0] === fqn && pair[1] === path), fqn);
  }
  assert.deepEqual(JSON.parse(index.answer(questions.naming("constant", "KEY"))), ["app/Base.java", "b/Other.java"]);
});

const NESTED = { path: "app/Parent.java", content: "package app;\npublic class Parent { public static class Inner {} }\n" };
const CHILD = { path: "app/Child.java", content: "package app;\nclass Child extends Parent { Inner field; Ghost ghost; }\n" };

async function reading<T>(run: (project: JavaProject, child: JavaProject["types"][number]) => T, record?: (question: string) => void): Promise<T> {
  return withJavaSources(await createJavaParser(), (parse) => {
    const project = createJavaProject(parse([NESTED, CHILD]).files);
    const child = project.types.find((type) => type.name === "Child")!;
    return record === undefined ? run(project, child) : project.reading(record, () => run(project, child));
  });
}

test("the project tells a derivation each question its answer rests on, the ones that answer nothing included", async () => {
  const asked = new Set<string>();
  await reading((project, child) => {
    assert.equal(typeof project.lookupType("Parent", scopeOf(child)), "object");
    assert.equal(project.lookupType("Ghost", scopeOf(child)), undefined);
  }, (question) => asked.add(question));
  assert.ok(asked.has(questions.declaring("app.Parent")));
  assert.ok(asked.has(questions.file("app/Parent.java")));
  assert.ok(asked.has(questions.declaring("app.Ghost")));
  assert.ok(!asked.has(questions.file("app/Ghost.java")));
});

test("the types the sources declare under a qualified name tell the file of each one they hand out, and the name when none is declared", async () => {
  const asked = new Set<string>();
  await reading((project) => {
    assert.equal(project.typesDeclaring("app.Parent").length, 1);
    assert.equal(project.typesDeclaring("app.Ghost").length, 0);
  }, (question) => asked.add(question));
  assert.deepEqual([...asked].sort(), [questions.declaring("app.Ghost"), questions.declaring("app.Parent"), questions.file("app/Parent.java")].sort());
});

test("a member type a memo answers tells the reads of the computation that filled it, filled by a recorded read or not", async () => {
  const sort = (asked: Set<string>) => [...asked].sort();
  const readTwice = async (recordedFirst: boolean) => withJavaSources(await createJavaParser(), (parse) => {
    const project = createJavaProject(parse([NESTED, CHILD]).files);
    const scope = scopeOf(project.types.find((type) => type.name === "Child")!);
    const first = new Set<string>();
    if (recordedFirst) project.reading((question) => first.add(question), () => project.bindName("Inner", scope, "lenient"));
    else project.bindName("Inner", scope, "lenient");
    const later = new Set<string>();
    project.reading((question) => later.add(question), () => project.bindName("Inner", scope, "lenient"));
    return { first: sort(first), later: sort(later) };
  });
  const filledUnrecorded = await readTwice(false);
  const filledRecorded = await readTwice(true);
  assert.ok(filledUnrecorded.later.includes(questions.file("app/Parent.java")));
  assert.deepEqual(filledRecorded.later, filledRecorded.first);
  assert.deepEqual(filledUnrecorded.later, filledRecorded.later);
});
