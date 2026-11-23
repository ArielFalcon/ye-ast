import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SourceFile } from "../../ports/source-file.port.ts";
import { createDerivedFacts } from "./derived-facts.ts";
import { keptOverReadSources } from "./kept-over-read-sources.ts";
import { createSnapshotDataCache } from "./snapshot-data-cache.ts";

const READ = { path: "src/app/a.ts", content: "export const a = 1;\n", blob: "blob-a-1" };
const UNREAD = { path: "src/main/java/B.java", content: "class B {}\n", blob: "blob-b-1" };
const SOURCES: readonly SourceFile[] = [READ, UNREAD];

/** One process: one memory tier, a stage that reads only the TypeScript contents of what it is given, and how many times it derived. */
function oneProcess() {
  const cache = createSnapshotDataCache(1 << 20);
  let derived = 0;
  return {
    derived: () => derived,
    read: (sources: readonly SourceFile[], inputs: object = {}) =>
      keptOverReadSources(createDerivedFacts(cache, { of: (text) => `digest(${text})` }, "untrusted"), "stage", sources, inputs, async (files) => {
        derived += 1;
        return files.filter(({ path }) => path.endsWith(".ts")).map(({ path, content }) => `${path}:${content.length}`);
      }),
  };
}

const edited = (target: SourceFile, blob: string): SourceFile[] => SOURCES.map((file) => (file === target ? { ...file, content: `${file.content}// edit\n`, blob } : file));

test("an edit of a file the stage never read answers the kept value without deriving again", async () => {
  const process = oneProcess();
  const first = await process.read(SOURCES);
  const after = await process.read(edited(UNREAD, "blob-b-2"));
  assert.deepEqual({ derived: process.derived(), after }, { derived: 1, after: first });
});

test("an edit of a file the stage read derives again", async () => {
  const process = oneProcess();
  await process.read(SOURCES);
  const after = await process.read(edited(READ, "blob-a-2"));
  assert.deepEqual({ derived: process.derived(), after }, { derived: 2, after: [`${READ.path}:${READ.content.length + 8}`] });
});

test("a renamed path derives again though the stage never read its content", async () => {
  const process = oneProcess();
  await process.read(SOURCES);
  await process.read([READ, { ...UNREAD, path: "src/main/java/C.java" }]);
  assert.equal(process.derived(), 2);
});

test("other inputs derive again over the same sources", async () => {
  const process = oneProcess();
  await process.read(SOURCES, { proofs: true });
  await process.read(SOURCES, { proofs: false });
  assert.equal(process.derived(), 2);
});
