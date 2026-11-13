import assert from "node:assert/strict";
import test from "node:test";
import type { Node } from "web-tree-sitter";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { withJavaSources } from "./java-project.ts";
import { createJavaProject, isTypeDeclaration } from "./java-symbols.ts";

const SOURCE = [
  "class Outer {",
  "  interface Port {}",
  "  enum Kind { A }",
  "  record Pair(int a) {}",
  "  @interface Marker {}",
  "  Outer() {}",
  "  void run() { class Local {} }",
  "}",
].join("\n");

test("a type declaration is a class, an interface, an enum, a record or an annotation type, never a method or a constructor", async () => {
  const parsed = (await createJavaParser()).parse({ path: "src/A.java", content: SOURCE });
  assert.ok(parsed.ok);
  const declared: string[] = [];
  const visit = (node: Node): void => {
    if (isTypeDeclaration(node)) declared.push(node.childForFieldName("name")?.text ?? "");
    node.namedChildren.forEach(visit);
  };

  visit(parsed.value.root);
  parsed.value.dispose();

  assert.deepEqual(declared, ["Outer", "Port", "Kind", "Pair", "Marker", "Local"]);
});

test("a name java.lang offers keeps its identity under an on-demand import of an unknown package, unless a type of the sources or a static import of an unknown owner may offer it", async () => {
  const parser = await createJavaParser();
  const identities = (header: string, names: readonly string[], extra: readonly string[] = []) => withJavaSources(parser, (parse) => {
    const { files } = parse([{ path: "src/a/A.java", content: `package a;\n${header}\nclass A {}\n` }, ...extra.map((content, index) => ({ path: `src/a/Extra${index}.java`, content }))]);
    const project = createJavaProject(files);
    const scope = { file: files[0]!, type: project.types.find((type) => type.name === "A") };
    return names.map((name) => project.typeIdentity(name, scope));
  });
  const [string, page, other] = identities("import org.springframework.data.domain.*;", ["String", "Page", "Other"]);
  assert.equal(string, "java.lang.String");
  assert.ok(page?.startsWith("context:") && other?.startsWith("context:") && page !== other);
  assert.equal(identities("import org.springframework.data.domain.*;", ["String"], ["package a;\nclass String {}"])[0], "a.String");
  assert.ok(identities("import static vendor.Holder.*;\nimport vendor.*;", ["String"])[0]?.startsWith("context:"));
});
