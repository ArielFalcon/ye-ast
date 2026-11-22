import assert from "node:assert/strict";
import { test } from "node:test";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createJavaRelations } from "../core/adapters/spring/java-relations.adapter.ts";
import { createJavaParser, createJavaTreeHolds } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createDerivedFacts } from "../core/application/snapshot/derived-facts.ts";
import { createSnapshotDataCache } from "../core/application/snapshot/snapshot-data-cache.ts";
import type { DerivedFacts, RecordedAnswers } from "../core/ports/derived-facts.port.ts";
import type { SourceFile } from "../core/ports/entrypoint-extractor.port.ts";

const java = (name: string, body: string): SourceFile => ({ path: `src/main/java/app/${name}.java`, content: `package app;\n${body}\n` });
const ORDERS = java("Orders", "class Orders { Ghost ghost; Items items; void list() { items.one(); } }");
const PLAIN = java("Plain", "class Plain { Items items; void run() { items.one(); } }");
const REPORT = java("Report", "class Report { Orders orders; void print() { orders.list(); } }");
const SOURCES = [java("Items", "class Items { void one() {} }"), ORDERS, PLAIN, REPORT];

/** One process: a memory tier kept across reads, over which each read lists the questions asked of the declaration index and the files derived again. */
function oneProcess() {
  const cache = createSnapshotDataCache(32 * 1024 * 1024);
  const digest = createSha256Digest();
  const holds = createJavaTreeHolds();
  return async (sources: readonly SourceFile[]) => {
    const facts = createDerivedFacts(cache, digest, "untrusted");
    const asked = new Set<string>();
    const derived = new Set<string>();
    const listing: DerivedFacts = {
      ...facts,
      ofReads: (slot, subject, answers, derive) => {
        const counting: RecordedAnswers = { ...answers, answerIfKnown: (question) => (asked.add(question), answers.answerIfKnown(question)) };
        return facts.ofReads(slot, subject, counting, (record) => (derived.add((subject as { path: string }).path), derive(record)));
      },
    };
    const hold = holds.open();
    try {
      const relations = await createJavaRelations(() => createJavaParser(holds)).extract(hold.keep(sources), { hold, facts: listing });
      return { relations: JSON.stringify(relations), asked: [...asked].sort(), derived: [...derived].sort() };
    } finally {
      hold.release();
    }
  };
}

const edited = (target: SourceFile, from: string, to: string) => SOURCES.map((file) => (file === target ? { ...file, content: file.content.replace(from, to) } : file));

test("after a body edit the kept relations ask only the questions of the edited file, and only the relations that read it derive again", async () => {
  const read = oneProcess();
  await read(SOURCES);
  const after = await read(edited(ORDERS, "items.one();", "items.one(); "));
  assert.deepEqual({ asked: after.asked, derived: after.derived }, { asked: [`file|${ORDERS.path}`], derived: [ORDERS.path, REPORT.path] });
});

test("a signature edit derives again exactly the relations that asked the name it changed, and equals a cold read", async () => {
  const read = oneProcess();
  await read(SOURCES);
  const renamed = edited(PLAIN, "class Plain", "class Ghost");
  const after = await read(renamed);
  assert.deepEqual(after.derived, [ORDERS.path, PLAIN.path]);
  assert.equal(after.relations, (await oneProcess()(renamed)).relations);
});
