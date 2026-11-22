import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaProject, scopeOf, type JavaProject } from "./java-symbols.ts";
import { JAVA_MARKERS, NAMING_KINDS, PACKAGE_QUESTIONS, questions } from "./java-declaration-questions.ts";
import { javaDeclarationIndex, UnknownDeclarationQuestionError, type JavaDeclarationIndex } from "./java-declaration-index.ts";
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

test("the fingerprint is equal for the same files in any order, and moves with a file's content and with each input", async () => {
  const fingerprintOf = async (sources: readonly { path: string; content: string }[], inputs = INPUTS) => (await indexOf(sources, inputs)).fingerprint;
  const base = await fingerprintOf([BASE, IMPL]);
  assert.equal(await fingerprintOf([IMPL, BASE]), base);
  const moved = [
    await fingerprintOf([BASE, { ...IMPL, content: IMPL.content.replace('return ""', 'return "x"') }]),
    await fingerprintOf([BASE, IMPL], { ...INPUTS, unreadJvm: true }),
    await fingerprintOf([BASE, IMPL], { ...INPUTS, generatesInterfaces: true }),
  ];
  assert.deepEqual(moved.map((other) => other === base), [false, false, false]);
});

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

test("a question outside the vocabulary has no answer, in each of its parts, and asking it is a typed error", async () => {
  const index = await indexOf([IMPL, BASE]);
  for (const outside of ["gone|Q", "", "naming|bogus|Base", "naming|toString|Base", "package|bogus|app", "marked|bogus", "build|bogus"]) {
    assert.equal(index.answerIfKnown(outside), undefined, outside);
    assert.throws(() => index.answer(outside), UnknownDeclarationQuestionError, outside);
  }
  for (const known of [questions.file("app/Base.java"), questions.naming("supertype", "Base"), questions.package("typed", "app"), questions.marked("aspect"), questions.build("generatesInterfaces"), questions.unread(), questions.listing()]) assert.equal(index.answerIfKnown(known), index.answer(known), known);
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

test("a package declares types where a source declares one in it, and the project tells the question it rests on", async () => {
  const asked = new Set<string>();
  await reading((project) => {
    assert.equal(project.declaresTypesIn("app"), true);
    assert.equal(project.declaresTypesIn("ap"), false);
  }, (question) => asked.add(question));
  assert.deepEqual([...asked].sort(), [questions.package("typed", "ap"), questions.package("typed", "app")].sort());
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

/** Every question about a name, a package or a path that the sources state, plus names none states: what an edit could change. */
async function questionsAbout(...snapshots: readonly (readonly { path: string; content: string }[])[]): Promise<string[]> {
  const parser = await createJavaParser();
  const asked = new Set<string>([questions.unread(), questions.listing(), questions.build("claimed"), questions.build("generatesInterfaces"), questions.declaring("app.Missing"), questions.named("Missing")]);
  for (const marker of JAVA_MARKERS) asked.add(questions.marked(marker));
  for (const source of snapshots.flat()) {
    const entry = declarationsOf(parser, source, fingerprint);
    for (const question of [questions.file(source.path), questions.declarations(source.path)]) asked.add(question);
    const packageName = entry.header.packageName;
    for (const [end] of packageName.split(".").entries()) {
      for (const kind of PACKAGE_QUESTIONS) asked.add(questions.package(kind, packageName.split(".").slice(0, end + 1).join(".")));
    }
    const names = [...entry.body.unplacedSupertypes, ...entry.body.methodReferences, ...entry.types.flatMap((type) => [type.name, ...type.annotations, ...type.constantNames, ...type.supertypes.map(({ name }) => name)])];
    for (const type of entry.types) asked.add(questions.declaring(type.fqn));
    for (const name of names) {
      asked.add(questions.named(name));
      for (const kind of NAMING_KINDS) asked.add(questions.naming(kind, name));
    }
  }
  return [...asked].sort();
}

/** The questions of `about` that `after` tells changed since `before`, and the ones whose answers differ. */
async function changes(before: JavaDeclarationIndex, after: JavaDeclarationIndex, about: readonly string[]) {
  const changed = after.changedSince(before.version);
  assert.ok(changed !== undefined);
  return { told: about.filter(changed), differing: about.filter((question) => before.answer(question) !== after.answer(question)) };
}

test("a body edit tells changed only the content of the edited file and the listing", async () => {
  const edited = { ...IMPL, content: IMPL.content.replace('return ""', 'return "x"') };
  const { told } = await changes(await indexOf([BASE, IMPL]), await indexOf([BASE, edited]), await questionsAbout([BASE, IMPL, edited]));
  assert.deepEqual(told, [questions.file(IMPL.path), questions.listing()]);
});

test("a signature edit tells changed the edited file's questions and the names in its difference, and no other name", async () => {
  const edited = { ...IMPL, content: IMPL.content.replace("extends Base", "extends Other") };
  const { told } = await changes(await indexOf([BASE, IMPL]), await indexOf([BASE, edited]), await questionsAbout([BASE, IMPL, edited]));
  assert.deepEqual(told, [questions.declarations(IMPL.path), questions.file(IMPL.path), questions.listing(), questions.naming("supertype", "Base"), questions.naming("supertype", "Other")].sort());
});

test("every question whose answer an edit changes is told changed, whatever the edit", async () => {
  const base = [BASE, IMPL];
  const replaced = (file: typeof IMPL, from: string, to: string) => ({ ...file, content: file.content.replace(from, to) });
  const edits: readonly { name: string; after: readonly (typeof BASE)[]; inputs?: typeof INPUTS }[] = [
    { name: "a type renamed", after: [replaced(BASE, "class Base", "class Root"), IMPL] },
    { name: "a package moved", after: [replaced(BASE, "package app;", "package app.inner;"), IMPL] },
    { name: "a platform package claimed", after: [replaced(BASE, "package app;", "package org.springframework.boot.custom;"), IMPL] },
    { name: "an annotation, a constant and a marker", after: [replaced(BASE, "public class Base { static final String KEY", "@Aspect public class Base { static final String OTHER"), IMPL] },
    { name: "a method reference and an anonymous class", after: [BASE, replaced(IMPL, "Impl::name; Object o = new Base() {};", "Impl::other; Object o = new Runnable() {};")] },
    { name: "a file that appears", after: [...base, UNPARSED, { path: "other/Late.java", content: "package other; class Late extends Base { static final int KEY = 1; }" }] },
    { name: "a file that disappears", after: [IMPL] },
    { name: "a file that stops parsing", after: [BASE, UNPARSED, { ...IMPL, content: "package app; class {" }] },
    { name: "a body that stops parsing", after: [BASE, replaced(IMPL, 'return ""', "return ;")] },
    { name: "the inputs", after: base, inputs: { generatesInterfaces: true, unreadJvm: true } },
  ];
  const before = await indexOf(base);
  for (const edit of edits) {
    const { told, differing } = await changes(before, await indexOf(edit.after, edit.inputs), await questionsAbout(base, edit.after));
    assert.ok(differing.length > 0, edit.name);
    assert.deepEqual(differing.filter((question) => !told.includes(question)), [], edit.name);
  }
});

test("an index cannot tell what changed since a version it did not make", async () => {
  assert.equal((await indexOf([BASE])).changedSince({}), undefined);
});
