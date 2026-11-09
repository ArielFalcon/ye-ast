import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParser, createJavaTreeHolds, type JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { heldJavaProject, withJavaSources } from "./java-project.ts";

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
      if (source.content === "throws") throw new RangeError("parser failure");
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

const A = { path: "app/A.java", content: "package app; class A {}" };
const B = { path: "app/B.java", content: "package app; class B {}" };

async function heldParser(holds: ReturnType<typeof createJavaTreeHolds>): Promise<{ parser: JavaParser; parses: () => number }> {
  const real = await createJavaParser(holds);
  let parses = 0;
  return {
    parser: {
      parse(source) {
        parses++;
        return real.parse(source);
      },
      holdOf: (source) => real.holdOf?.(source),
    },
    parses: () => parses,
  };
}

test("two readers share one project for the read, and the hold frees its trees only at release", async () => {
  const holds = createJavaTreeHolds();
  const { parser, parses } = await heldParser(holds);
  const hold = holds.open();
  const sources = [A, B];

  const first = await heldJavaProject(hold, () => Promise.resolve(parser), sources);
  const second = await heldJavaProject(hold, () => Promise.resolve(parser), sources);
  assert.equal(first.project, second.project, "the read's one project is shared by every reader");
  assert.equal(parses(), sources.length, "each source parses once for the whole read");
  assert.equal(first.files[0]!.owned, true);
  assert.equal(first.owns(A.path), true);
  assert.deepEqual(first.files.map(({ file }) => file.root.namedChildren.some((child) => child.type === "class_declaration")), [true, true], "the hold keeps the trees alive for the read");

  hold.release();
  assert.throws(() => first.files[0]!.file.root.namedChild(0), "the read's end frees every tree");
  const nextHold = holds.open();
  const third = await heldJavaProject(nextHold, () => Promise.resolve(parser), sources);
  assert.notEqual(third.project, first.project, "a released hold's project is never read again");
  assert.equal(parses(), sources.length * 2, "a source a released hold kept parses again");
  assert.deepEqual(third.files.map(({ file }) => file.root.namedChildren.some((child) => child.type === "class_declaration")), [true, true], "the trees the second read parses are live");
  nextHold.release();
});

test("a declared source is a declaration the project holds and never one the read owns", async () => {
  const holds = createJavaTreeHolds();
  const { parser } = await heldParser(holds);
  const hold = holds.open();
  const sources = hold.keep([A]);
  const declared = [{ path: "generated/Gen.java", content: "package app; class Gen {}" }];

  const held = await heldJavaProject(hold, () => Promise.resolve(parser), sources, declared);
  assert.deepEqual(held.files.map(({ file, owned }) => [file.path, owned]), [[A.path, true], ["generated/Gen.java", false]]);
  assert.equal(held.owns("generated/Gen.java"), false);
  assert.ok(held.project.types.some((type) => type.name === "Gen"), "the declaration is part of the project");
  hold.release();
});
