import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AnswerFolder } from "../core/ports/answer-files.port.ts";
import { ANSWER_RETENTION, composeAnswerFiles } from "./answer-files.ts";
import { processHost } from "./process-host.ts";

let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-answer-composition-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const folderOf = (inputs: object): AnswerFolder => ({ tool: "callers", inputs, files: { "answer.json": "{}", "summary.txt": "s", "details.txt": "d" } });

test("composed answer files sweep a folder unused beyond the default budget", async () => {
  const directory = await mkdtemp(join(scratch, "cache-"));
  const files = composeAnswerFiles({ directory, report: () => undefined });
  const old = (await files.keep(folderOf({ n: 1 })))!;
  const at = new Date(Date.now() - ANSWER_RETENTION.unusedForMs - 1000);
  await utimes(join(old, "answer.json"), at, at);
  const current = (await files.keep(folderOf({ n: 2 })))!;
  assert.deepEqual(await readdir(dirname(old)), [current.split("/").at(-1)]);
});

test("a diagnostic line reaches the host redacted", async () => {
  const directory = await mkdtemp(join(scratch, "cache-"));
  await mkdir(join(directory, "password=hunter2hunter2xyz"));
  await writeFile(join(directory, "password=hunter2hunter2xyz", "answers"), "a file where the directory belongs");
  const lines: string[] = [];
  const files = composeAnswerFiles({ directory: join(directory, "password=hunter2hunter2xyz"), report: (line) => lines.push(line) });
  assert.equal(await files.keep(folderOf({})), null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.includes("hunter2"), false);
});

test("the process host writes answer files under the cache directory, and without one it has none", async () => {
  const directory = await mkdtemp(join(scratch, "cache-"));
  const signal = new AbortController().signal;
  assert.equal(processHost({ signal }).answerFiles, undefined);
  const folder = await processHost({ signal, indexCache: directory }).answerFiles!.keep(folderOf({}));
  assert.ok(folder!.startsWith(join(directory, "answers", "callers")));
});
