import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { NAMING_KINDS, questions } from "./java-declaration-questions.ts";
import { javaDeclarationIndex } from "./java-declaration-index.ts";
import { withJavaSources } from "./java-project.ts";
import { createJavaProject } from "./java-symbols.ts";
import { indexWrites, projectWrites } from "./java-written-names.ts";
import { rememberingFacts } from "./remembering-facts.testing.ts";

const BASE = { path: "app/Base.java", content: "package app;\npublic class Base { static final String KEY = \"k\"; void run() {} }\n" };
const IMPL = {
  path: "app/Impl.java",
  content: [
    "package app;",
    "import java.util.function.Supplier;",
    "@Service class Impl extends Base implements Runnable, Missing {",
    "  public void run() { Supplier<String> s = Impl::name; Object o = new Base() {}; class Local extends Impl {} }",
    "  String name() { return \"\"; }",
    "}",
    "",
  ].join("\n"),
};
const OTHER = { path: "b/Other.java", content: "package b; import app.Base; @Service class Other extends Base { static final int KEY = 2; Runnable r = Other::go; static void go() {} }\n" };
const SOURCES = [BASE, IMPL, OTHER];
const NAMES = ["Base", "Impl", "Runnable", "Missing", "Local", "Service", "KEY", "name", "go", "Absent"];

test("the files a project says write a name are the files its declaration index answers for each kind of writing", async () => {
  const parser = await createJavaParser();
  const index = javaDeclarationIndex(rememberingFacts(), parser, SOURCES, { generatesInterfaces: false, unreadJvm: false });
  withJavaSources(parser, (parse) => {
    const project = createJavaProject(parse(SOURCES).files);
    const files = new Map(project.types.map((type) => [type.file.path, type.file]));
    const answered = indexWrites(project, index.answer, (path) => files.get(path));
    const built = projectWrites(project);
    const written: Record<string, string[]> = {};
    for (const kind of NAMING_KINDS) {
      for (const name of NAMES) {
        const paths = built(kind, name).map((file) => file.path).sort();
        assert.deepEqual(answered(kind, name).map((file) => file.path).sort(), paths, `${kind} ${name}`);
        if (paths.length > 0) written[`${kind} ${name}`] = paths;
      }
    }
    assert.deepEqual(written, {
      "supertype Base": ["app/Impl.java", "b/Other.java"],
      "supertype Runnable": ["app/Impl.java"],
      "supertype Missing": ["app/Impl.java"],
      "unplaced-supertype Base": ["app/Impl.java"],
      "unplaced-supertype Impl": ["app/Impl.java"],
      "method-reference name": ["app/Impl.java"],
      "method-reference go": ["b/Other.java"],
      "annotation Service": ["app/Impl.java", "b/Other.java"],
      "constant KEY": ["app/Base.java", "b/Other.java"],
    });
  });
});

test("each file the index answers for a name is handed out by the project, so a derivation that asked records its content", async () => {
  const parser = await createJavaParser();
  const index = javaDeclarationIndex(rememberingFacts(), parser, SOURCES, { generatesInterfaces: false, unreadJvm: false });
  withJavaSources(parser, (parse) => {
    const project = createJavaProject(parse(SOURCES).files);
    const files = new Map(project.types.map((type) => [type.file.path, type.file]));
    const asked: string[] = [];
    const answered = indexWrites(project, (question) => (asked.push(question), index.answer(question)), (path) => files.get(path));
    const found = project.reading((question) => asked.push(question), () => answered("annotation", "Service"));
    assert.deepEqual(found.map((file) => file.path), ["app/Impl.java", "b/Other.java"]);
    assert.deepEqual(asked, [questions.naming("annotation", "Service"), questions.file("app/Impl.java"), questions.file("b/Other.java")]);
  });
});
