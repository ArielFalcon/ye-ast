import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaDeclaredTypes } from "./java-declared-types.ts";

const ORDERS: SourceFile = { path: "src/main/java/app/Orders.java", content: "package app;\n\nimport java.util.List;\n\nclass Orders {\n  void run(List<String> items) {}\n}\n" };
const LIST = { file: ORDERS.path, line: 6, column: 12, spelled: "List", owner: { name: "run", line: 6, endLine: 6 } };

test("only an uncovered JVM source of the snapshot vetoes a platform annotation, never a build script", async () => {
  const declared = (extra: string) => createJavaDeclaredTypes(createJavaParser, [ORDERS], [ORDERS.path, extra])([LIST]);

  assert.deepEqual(await declared("build.gradle.kts"), [{ kind: "package", module: "java.util", name: "List" }]);
  assert.deepEqual(await declared("src/main/kotlin/app/Repo.kt"), [{ kind: "unknown" }]);
});
