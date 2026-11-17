import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createDerivedFactStore } from "../core/adapters/fs/derived-fact-store.adapter.ts";
import { createJavaRelations } from "../core/adapters/spring/java-relations.adapter.ts";
import { createSpringRoutesExtractor } from "../core/adapters/spring/spring-routes.adapter.ts";
import { createJavaParser, createJavaTreeHolds } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createDerivedFacts } from "../core/application/snapshot/derived-facts.ts";
import { createSnapshotDataCache } from "../core/application/snapshot/snapshot-data-cache.ts";
import { STORED_DERIVED_FACT_VERSIONS } from "../core/domain/snapshot/stored-derived-facts.ts";
import type { SourceFile } from "../core/ports/entrypoint-extractor.port.ts";

const WEB = "import org.springframework.web.bind.annotation.*;";
const java = (name: string, body: string): SourceFile => ({ path: `src/main/java/app/${name}.java`, content: `package app;\n${WEB}\n${body}\n` });
const SOURCES = [
  java("Base", `@RequestMapping("/v1") abstract class Base {}`),
  java("Orders", `@RestController class Orders extends Base { Ghost ghost; @GetMapping("/orders") void list() {} }`),
  java("Items", `@RestController @RequestMapping("/items") class Items { @GetMapping("/{id}") void one() {} }`),
  java("Plain", `class Plain { Items items; }`),
];

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "ye-ast-reads-disk-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One process over the cache directory: a fresh memory tier over the disk tier the directory holds. */
async function readInNewProcess(directory: string, sources: readonly SourceFile[], versions: Readonly<Record<string, number>> = STORED_DERIVED_FACT_VERSIONS) {
  const digest = createSha256Digest();
  const disk = { store: createDerivedFactStore({ directory, digest }), versions: Object.fromEntries(Object.entries(versions).map(([slot, version]) => [slot, String(version)])) };
  const facts = createDerivedFacts(createSnapshotDataCache(32 * 1024 * 1024), digest, "untrusted", disk);
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    const kept = hold.keep(sources);
    const relations = await createJavaRelations(() => createJavaParser(holds)).extract(kept, { hold, facts });
    const entrypoints = (await createSpringRoutesExtractor(await createJavaParser(holds)).extract(kept, [], { hold, facts })).findings;
    return { answer: JSON.stringify({ relations, entrypoints }), tally: facts.drain() };
  } finally {
    hold.release();
  }
}

function cacheDirectory(name: string): string {
  const directory = join(root, name);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

test("a second process answers the relations and the entrypoints of every file from the disk tier, byte for byte, and derives none", async () => {
  const directory = cacheDirectory("warm");
  const cold = await readInNewProcess(directory, SOURCES);
  assert.equal(cold.tally.diskHits, 0);

  const warm = await readInNewProcess(directory, SOURCES);

  assert.equal(warm.answer, cold.answer);
  assert.ok(warm.answer.includes("/v1/orders"));
  assert.equal(warm.tally.misses, 0);
  assert.equal(warm.tally.diskHits, SOURCES.length * 4);
});

test("a third process after an edit derives the files whose recorded answers changed and answers the others from disk", async () => {
  const directory = cacheDirectory("edited");
  await readInNewProcess(directory, SOURCES);
  const edited = SOURCES.map((source) => (source === SOURCES[2] ? { ...source, content: source.content.replace('"/items"', '"/things"') } : source));

  const after = await readInNewProcess(directory, edited);

  assert.equal(after.answer.includes("/things/{id}"), true);
  assert.deepEqual(JSON.parse(after.answer), JSON.parse((await readInNewProcess(cacheDirectory("edited-cold"), edited)).answer));
  assert.ok(after.tally.misses > 0 && after.tally.misses < after.tally.hits);
});

test("a reader version bump discards what the old version stored", async () => {
  const directory = cacheDirectory("bumped");
  await readInNewProcess(directory, SOURCES);
  const bumped = await readInNewProcess(directory, SOURCES, { ...STORED_DERIVED_FACT_VERSIONS, "java-relations": 2, "java-entrypoints": 2 });
  assert.equal(bumped.tally.misses, SOURCES.length * 2);
  assert.equal(bumped.tally.diskHits, SOURCES.length * 2);
});
