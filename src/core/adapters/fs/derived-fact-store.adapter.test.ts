import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DerivedFactRetentionPolicy } from "../../ports/derived-fact-store.port.ts";
import { createDerivedFactStore } from "./derived-fact-store.adapter.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 17);
const digest = { of: (text: string) => createHash("sha256").update(text).digest("hex") };
const KEY = digest.of("key");
const OTHER_KEY = digest.of("other key");
let scratch: string;
let counter = 0;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "ye-ast-derived-store-"));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fresh(): string {
  counter += 1;
  const directory = join(scratch, `case-${counter}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function storeOf(directory: string, retention?: DerivedFactRetentionPolicy) {
  return createDerivedFactStore({ directory, digest, now: () => NOW, ...(retention && { retention }) });
}

function entries(directory: string): string[] {
  const root = join(directory, "derived-facts");
  return existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)) : [];
}

function age(path: string, ms: number): void {
  const when = new Date(NOW - ms);
  utimesSync(path, when, when);
}

test("a value written is read back by another store over the same directory", () => {
  const directory = fresh();
  storeOf(directory).write(KEY, '{"starts":[3,1]}');

  assert.equal(storeOf(directory).read(KEY), '{"starts":[3,1]}');
  assert.equal(storeOf(directory).read(OTHER_KEY), undefined);
});

test("an entry cut short, altered, or kept under another key is a miss and is removed", () => {
  for (const damage of [(text: string) => text.slice(0, text.length - 3), (text: string) => text.replace("[3,1]", "[3,2]"), (text: string) => text.replace(KEY, OTHER_KEY)]) {
    const directory = fresh();
    storeOf(directory).write(KEY, '{"starts":[3,1]}');
    const [path] = entries(directory);
    assert.ok(path);
    const text = readFileSync(path, "utf8");
    writeFileSync(path, damage(text));

    assert.equal(storeOf(directory).read(KEY), undefined, text);
    assert.deepEqual(entries(directory), []);
  }
});

test("a write leaves only its entry, and one that cannot be written is not kept and does not throw", () => {
  const directory = fresh();
  storeOf(directory).write(KEY, "1");
  assert.equal(entries(directory).length, 1);
  assert.deepEqual(entries(directory).filter((path) => path.includes(".tmp")), []);

  const blocked = fresh();
  writeFileSync(join(blocked, "derived-facts"), "a file where the directory belongs");
  const store = storeOf(blocked);
  assert.doesNotThrow(() => store.write(KEY, "1"));
  assert.equal(store.read(KEY), undefined);
});

test("a directory other users can write is not used", () => {
  const directory = fresh();
  chmodSync(directory, 0o777);
  const store = storeOf(directory);
  store.write(KEY, "1");

  assert.equal(store.read(KEY), undefined);
  assert.deepEqual(entries(directory), []);
});

test("retention removes entries unused past the bound and then the least recently read beyond the byte budget, never the one just written", () => {
  const directory = fresh();
  const keys = ["a", "b", "c", "d"].map((name) => digest.of(name));
  const seed = storeOf(directory);
  for (const key of keys) seed.write(key, "x".repeat(100));
  const bytes = statSync(entries(directory)[0]!).size;
  const byKey = (key: string) => entries(directory).find((path) => path.endsWith(key))!;
  age(byKey(keys[0]!), 20 * DAY_MS);
  age(byKey(keys[1]!), 3 * DAY_MS);
  age(byKey(keys[2]!), 2 * DAY_MS);
  age(byKey(keys[3]!), 1 * DAY_MS);

  const swept = storeOf(directory, { unusedForMs: 14 * DAY_MS, maxBytes: 2 * bytes + 1 });
  const fresher = digest.of("e");
  swept.write(fresher, "y".repeat(100));

  const remaining = entries(directory).map((path) => keys.concat(fresher).find((key) => path.endsWith(key)));
  assert.deepEqual(remaining.sort(), [keys[3], fresher].sort());
});

test("a read counts as a use that retention respects", () => {
  const directory = fresh();
  const [old, other] = [digest.of("old"), digest.of("other")];
  const seed = storeOf(directory);
  seed.write(old, "1");
  seed.write(other, "2");
  for (const path of entries(directory)) age(path, 13 * DAY_MS);
  assert.equal(storeOf(directory).read(old), "1");
  for (const path of entries(directory)) if (!path.endsWith(old)) age(path, 15 * DAY_MS);

  storeOf(directory, { unusedForMs: 14 * DAY_MS, maxBytes: 1 << 20 }).write(digest.of("new"), "3");

  assert.equal(storeOf(directory).read(old), "1");
  assert.equal(storeOf(directory).read(other), undefined);
});
