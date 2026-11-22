import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createJavaParser, type JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaImportsReader } from "./java-imports.adapter.ts";
import { edited, java, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-import-targets";
const OWNER = java("Owner", ["package app.owner;", "", "public class Owner {", "  public static final int LIMIT = 1;", "}"], "app/owner");
const CLIENT = java("Client", ["package app.api;", "", "import app.owner.Owner;", "import static app.owner.Owner.LIMIT;", "import java.util.List;", "import com.acme.Missing;", "", "class Client {}"], "app/api");
const LISTS = java("Lists", ["package app.api;", "", "import java.util.List;", "", "class Lists {}"], "app/api");
const UNRELATED = java("Unrelated", ["package app.misc;", "", "class Unrelated {", "  int count() { return 1; }", "}"], "app/misc");
const NOTHING = java("Nothing", ["package app.misc;", "", "class Nothing {}"], "app/misc");
const BROKEN = java("Broken", ["import a.b.C;", "class {"], "app/misc");
const SOURCES = [OWNER, CLIENT, LISTS, UNRELATED, NOTHING];

function countingParser(parser: JavaParser): { parser: JavaParser; parsed: () => number } {
  let count = 0;
  return { parser: { parse: (source, reading) => (count++, parser.parse(source, reading)) }, parsed: () => count };
}

const plain = async (sources: readonly SourceFile[], files?: readonly string[]) => createJavaImportsReader(await createJavaParser()).extract(sources, files === undefined ? undefined : { files });

test("an outline of one file after an edit elsewhere parses the edited file alone and answers the bytes of a read without facts", async () => {
  const counting = countingParser(await createJavaParser());
  const reader = createJavaImportsReader(counting.parser);
  const facts = rememberingFacts();
  await reader.extract(SOURCES, { files: [CLIENT.path], facts });
  const resolutions = facts.readsOf(SLOT);
  const after = [...SOURCES.slice(0, 3), edited(UNRELATED, ["return 1;", "return 2;"]), NOTHING];
  const parsedBefore = counting.parsed();

  const read = await reader.extract(after, { files: [CLIENT.path], facts });

  assert.equal(counting.parsed() - parsedBefore, 1);
  assert.deepEqual(facts.readsOf(SLOT), { hits: resolutions.hits + 1, misses: resolutions.misses });
  assert.deepEqual(read, await plain(after, [CLIENT.path]));
});

test("a file whose import led to a type is derived again when no source declares that type, and a file whose imports asked nothing of it is not", async () => {
  const facts = rememberingFacts();
  const reader = createJavaImportsReader(await createJavaParser());
  const before = await reader.extract(SOURCES, { facts });
  assert.deepEqual(facts.readsOf(SLOT), { hits: 0, misses: 2 });
  const renamed = SOURCES.map((source) => (source === OWNER ? edited(OWNER, ["class Owner", "class Renamed"]) : source));

  const read = await reader.extract(renamed, { facts });

  assert.deepEqual(facts.readsOf(SLOT), { hits: 1, misses: 3 });
  assert.deepEqual(read, await plain(renamed));
  assert.notDeepEqual(read.dependencies.map(({ target }) => target), before.dependencies.map(({ target }) => target));
});

test("an import of every type of a package is derived again when the package stops declaring types, though the name it imports is declared by no source", async () => {
  const EXTRA = java("Extra", ["package app.extra;", "", "public class Extra {}"], "app/extra");
  const WIDE = java("Wide", ["package app.api;", "", "import app.extra.*;", "", "class Wide {}"], "app/api");
  const facts = rememberingFacts();
  const reader = createJavaImportsReader(await createJavaParser());
  const kept = await reader.extract([EXTRA, WIDE], { facts });
  assert.equal(kept.dependencies[0]?.target.kind, "unresolved");
  assert.match((kept.dependencies[0]!.target as { reason: string }).reason, /package of the repository/);

  const read = await reader.extract([WIDE], { facts });

  assert.deepEqual(read, await plain([WIDE]));
  assert.match((read.dependencies[0]!.target as { reason: string }).reason, /no source of the snapshot declares/);
  assert.deepEqual(facts.readsOf(SLOT), { hits: 0, misses: 2 });
});

test("every selection of a list with sources the parser rejects answers the bytes of a read without facts", async () => {
  const PARTIAL = java("Partial", ["package app.misc;", "", "import java.util.Map;", "", "class Partial {", "  void run() { int x = ; }", "}"], "app/misc");
  const sources = [...SOURCES, BROKEN, PARTIAL];
  const reader = createJavaImportsReader(await createJavaParser());
  const facts = rememberingFacts();

  for (const files of [undefined, [CLIENT.path], [CLIENT.path, OWNER.path], [OWNER.path], [BROKEN.path], [PARTIAL.path]]) {
    const read = await reader.extract(sources, files === undefined ? { facts } : { files, facts });
    assert.deepEqual(read, await plain(sources, files), JSON.stringify(files));
  }
  assert.deepEqual((await reader.extract(sources, { facts })).unread.map(({ file }) => file), [BROKEN.path, PARTIAL.path]);
});
