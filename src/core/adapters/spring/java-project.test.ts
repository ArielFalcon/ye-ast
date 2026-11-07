import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParser, type JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { withJavaSources } from "./java-project.ts";

const SOURCES = [
  { path: "A.java", content: "class A {}" },
  { path: "B.java", content: "class B {\n  int x = ;\n}" },
  { path: "C.java", content: "throws" },
];

async function countingParser(): Promise<{ parser: JavaParser; live: () => number }> {
  const real = await createJavaParser();
  let live = 0;
  const parser: JavaParser = {
    parse(source) {
      if (source === "throws") throw new RangeError("parser failure");
      const result = real.parse(source);
      if (!result.ok) return result;
      live++;
      const { root, dispose } = result.value;
      return { ok: true, value: { root, dispose: () => { live--; dispose(); } } };
    },
  };
  return { parser, live: () => live };
}

test("a scope frees every tree it parsed, when it returns and when it throws", async () => {
  const { parser, live } = await countingParser();

  withJavaSources(parser, (parse) => {
    parse(SOURCES);
    parse(SOURCES.slice(0, 1));
    assert.equal(live(), 2);
  });
  assert.equal(live(), 0);
  assert.throws(() => withJavaSources(parser, (parse) => { parse(SOURCES); throw new TypeError("stop"); }), TypeError);
  assert.equal(live(), 0);
});

test("a source that does not parse is unparsed at its first syntax error, and at line 1 when the parser throws", async () => {
  const { parser } = await countingParser();

  const parsed = withJavaSources(parser, (parse) => {
    const { files, unparsed } = parse(SOURCES);
    return { files: files.map((file) => file.path), unparsed };
  });

  assert.deepEqual(parsed, { files: ["A.java"], unparsed: [{ path: "B.java", line: 2 }, { path: "C.java", line: 1 }] });
});
