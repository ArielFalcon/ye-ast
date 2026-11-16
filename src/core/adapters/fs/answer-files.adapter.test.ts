import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ANSWER_FILE_NAMES, type AnswerFolder } from "../../ports/answer-files.port.ts";
import { DEBRIS_STALE_MS } from "../../ports/live-mirror.port.ts";
import { createAnswerFiles } from "./answer-files.adapter.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-answers-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fresh(): Promise<string> {
  counter += 1;
  const directory = join(scratch, `case-${counter}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function answer(overrides: Partial<AnswerFolder> = {}, bytes = "{}"): AnswerFolder {
  return { tool: "callers", inputs: { query: "q" }, files: { "answer.json": bytes, "summary.txt": "summary", "details.txt": "details" }, ...overrides };
}

function adapter(directory: string, extra: Partial<Parameters<typeof createAnswerFiles>[0]> = {}) {
  const lines: string[] = [];
  const files = createAnswerFiles({ directory, digest: { of: (text) => createHash("sha256").update(text).digest("hex") }, engine: "engine-1", report: (line) => lines.push(line), ...extra });
  return { files, lines };
}

test("an answer is written whole as three owner-only files in a folder named by its key under its tool", async () => {
  const directory = await fresh();
  const { files, lines } = adapter(directory);
  const folder = await files.keep(answer({}, '{"guide":"g"}'));
  assert.ok(folder);
  assert.equal(dirname(folder), join(directory, "answers", "callers"));
  assert.match(basename(folder), /^[0-9a-f]{64}$/);
  assert.deepEqual((await readdir(folder)).sort(), [...ANSWER_FILE_NAMES].sort());
  assert.equal(await readFile(join(folder, "answer.json"), "utf8"), '{"guide":"g"}');
  assert.equal(await readFile(join(folder, "summary.txt"), "utf8"), "summary");
  assert.equal((await stat(folder)).mode & 0o077, 0);
  assert.equal((await stat(join(folder, "answer.json"))).mode & 0o077, 0);
  assert.deepEqual(await readdir(dirname(folder)), [basename(folder)]);
  assert.deepEqual(lines, []);
});

test("the key follows the tool, every input and the engine, and nothing else", async () => {
  const directory = await fresh();
  const { files } = adapter(directory);
  const first = await files.keep(answer());
  const sameInputs = await files.keep(answer({}, '{"other":"bytes"}'));
  assert.equal(sameInputs, first);
  const folders = [
    await files.keep(answer({ inputs: { query: "q2" } })),
    await files.keep(answer({ tool: "impact" })),
    await adapter(directory, { engine: "engine-2" }).files.keep(answer()),
  ];
  assert.equal(new Set([first, ...folders]).size, 4);
});

test("an identical answer finds its folder and rewrites nothing", async () => {
  const directory = await fresh();
  const { files, lines } = adapter(directory);
  const folder = (await files.keep(answer()))!;
  const planted = join(folder, "planted.txt");
  await writeFile(planted, "still here");
  const inode = (await stat(folder)).ino;
  assert.equal(await files.keep(answer()), folder);
  assert.equal((await stat(folder)).ino, inode);
  assert.equal(await readFile(planted, "utf8"), "still here");
  assert.deepEqual(lines, []);
});

test("the same key with other bytes keeps the folder and reports one line", async () => {
  const directory = await fresh();
  const { files, lines } = adapter(directory);
  const folder = (await files.keep(answer({}, '{"v":1}')))!;
  assert.equal(await files.keep(answer({}, '{"v":2}')), folder);
  assert.equal(await readFile(join(folder, "answer.json"), "utf8"), '{"v":1}');
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("callers") && lines[0]!.includes(basename(folder)));
});

test("a directory open to other accounts is not written to, and the fault is reported", { skip: process.platform === "win32" }, async () => {
  const directory = await fresh();
  await mkdir(join(directory, "answers"), { mode: 0o700 });
  await chmod(join(directory, "answers"), 0o777);
  const { files, lines } = adapter(directory);
  assert.equal(await files.keep(answer()), null);
  assert.deepEqual(await readdir(join(directory, "answers")), []);
  assert.equal(lines.length, 1);
});

test("an unwritable answers directory reports one line and answers null instead of rejecting", async () => {
  const directory = await fresh();
  await writeFile(join(directory, "answers"), "a file where the directory belongs");
  const { files, lines } = adapter(directory);
  assert.equal(await files.keep(answer()), null);
  assert.equal(lines.length, 1);
});

async function ageOf(folder: string, ageMs: number, now: number): Promise<void> {
  const at = new Date(now - ageMs);
  await utimes(join(folder, "answer.json"), at, at);
}

test("retention removes the folder unused beyond the bound and keeps the one just written", async () => {
  const directory = await fresh();
  const now = Date.now();
  const writer = adapter(directory, { retention: { unusedForMs: 14 * DAY_MS, maxBytes: 1e9 }, now: () => now }).files;
  const old = (await writer.keep(answer({ inputs: { n: 1 } })))!;
  const recent = (await writer.keep(answer({ inputs: { n: 2 } })))!;
  await ageOf(old, 14 * DAY_MS + 1, now);
  await ageOf(recent, 14 * DAY_MS - 1, now);
  const current = (await writer.keep(answer({ inputs: { n: 3 } })))!;
  assert.deepEqual((await readdir(dirname(old))).sort(), [basename(recent), basename(current)].sort());
});

test("an answer written again counts as used, so its folder outlives the bound", async () => {
  const directory = await fresh();
  const now = Date.now();
  const writer = adapter(directory, { retention: { unusedForMs: 14 * DAY_MS, maxBytes: 1e9 }, now: () => now }).files;
  const again = (await writer.keep(answer({ inputs: { n: 1 } })))!;
  await ageOf(again, 20 * DAY_MS, now);
  await writer.keep(answer({ inputs: { n: 1 } }));
  await writer.keep(answer({ inputs: { n: 2 } }));
  assert.ok(await stat(again));
});

test("the byte cap removes the least recently used folders and never the one just written", async () => {
  const directory = await fresh();
  const now = Date.now();
  const bytes = (n: number) => "x".repeat(n);
  const writer = adapter(directory, { retention: { unusedForMs: 365 * DAY_MS, maxBytes: 250 }, now: () => now }).files;
  const oldest = (await writer.keep(answer({ inputs: { n: 1 } }, bytes(100))))!;
  const middle = (await writer.keep(answer({ inputs: { n: 2 } }, bytes(100))))!;
  await ageOf(oldest, 2 * DAY_MS, now);
  await ageOf(middle, DAY_MS, now);
  const current = (await writer.keep(answer({ inputs: { n: 3 } }, bytes(100))))!;
  assert.deepEqual((await readdir(dirname(oldest))).sort(), [basename(middle), basename(current)].sort());
});

test("the folder just written stays even when it alone exceeds the byte cap", async () => {
  const directory = await fresh();
  const now = Date.now();
  const writer = adapter(directory, { retention: { unusedForMs: 365 * DAY_MS, maxBytes: 10 }, now: () => now }).files;
  const previous = (await writer.keep(answer({ inputs: { n: 1 } }, "x".repeat(100))))!;
  const current = (await writer.keep(answer({ inputs: { n: 2 } }, "x".repeat(100))))!;
  assert.deepEqual(await readdir(dirname(previous)), [basename(current)]);
});

test("a folder is never judged while it is being built: only a build directory unwritten beyond the debris bound is removed", async () => {
  const directory = await fresh();
  const now = Date.now();
  const parent = join(directory, "answers", "callers");
  const abandoned = join(parent, ".build-abandoned");
  const running = join(parent, ".build-running");
  for (const [path, ageMs] of [[abandoned, DEBRIS_STALE_MS + 1], [running, DEBRIS_STALE_MS - 1]] as const) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const at = new Date(now - ageMs);
    await utimes(path, at, at);
  }
  await adapter(directory, { retention: { unusedForMs: 14 * DAY_MS, maxBytes: 1e9 }, now: () => now }).files.keep(answer());
  const names = await readdir(parent);
  assert.ok(names.includes(".build-running"));
  assert.ok(!names.includes(".build-abandoned"));
});

test("nothing is removed without a retention policy", async () => {
  const directory = await fresh();
  const now = Date.now();
  const writer = adapter(directory, { now: () => now }).files;
  const old = (await writer.keep(answer({ inputs: { n: 1 } })))!;
  await ageOf(old, 400 * DAY_MS, now);
  await writer.keep(answer({ inputs: { n: 2 } }));
  assert.ok(await stat(old));
});
