import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../domain/shared/result.ts";
import type { TrustRecordFault } from "../../ports/trust-record.port.ts";
import { RECORDS_DIRECTORY, createTrustRecords, defaultTrustRecordDeps } from "./trust-record.adapter.ts";

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-trust-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fresh(): Promise<{ directory: string; repo: string }> {
  counter += 1;
  const base = join(scratch, `case-${counter}`);
  const repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  return { directory: join(base, "config", "ye-ast"), repo };
}

async function recordFile(directory: string): Promise<string> {
  const [name] = await readdir(join(directory, RECORDS_DIRECTORY));
  return join(directory, RECORDS_DIRECTORY, name!);
}

function faultKind<T>(result: Result<T, TrustRecordFault>): string | undefined {
  return result.ok ? undefined : result.fault.kind;
}

test("a repository with no declaration reads as undeclared, even when the record directory does not exist", async () => {
  const { directory, repo } = await fresh();
  assert.deepEqual(await createTrustRecords(directory).read(repo), { ok: true, value: undefined });
});

test("the declared mode is read back for the repository", async () => {
  const { directory, repo } = await fresh();
  const records = createTrustRecords(directory);

  assert.deepEqual(await records.write(repo, "trusted"), { ok: true, value: undefined });

  assert.deepEqual(await records.read(repo), { ok: true, value: "trusted" });
});

test("a symlinked spelling of the directory is the same repository as its real path", async () => {
  const { directory, repo } = await fresh();
  const link = join(scratch, `link-${counter}`);
  await symlink(repo, link);
  const records = createTrustRecords(directory);

  await records.write(link, "trusted");

  assert.deepEqual(await records.read(repo), { ok: true, value: "trusted" });
  await records.write(repo, "untrusted");
  assert.deepEqual(await records.read(link), { ok: true, value: "untrusted" });
});

test("reinstalling with another mode replaces the entry and keeps the other repositories", async () => {
  const { directory, repo } = await fresh();
  const other = join(scratch, `other-${counter}`);
  await mkdir(other);
  const records = createTrustRecords(directory);
  await records.write(other, "trusted");
  await records.write(repo, "trusted");

  await records.write(repo, "untrusted");

  assert.deepEqual(await records.read(repo), { ok: true, value: "untrusted" });
  assert.deepEqual(await records.read(other), { ok: true, value: "trusted" });
});

test("concurrent installs of different repositories all keep their declaration", async () => {
  const { directory } = await fresh();
  const repos = await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const repo = join(scratch, `parallel-${counter}-${index}`);
      await mkdir(repo);
      return repo;
    }),
  );
  const records = createTrustRecords(directory);

  await Promise.all(repos.map((repo) => records.write(repo, "trusted")));

  assert.deepEqual(await Promise.all(repos.map((repo) => records.read(repo))), repos.map(() => ({ ok: true, value: "trusted" })));
});

test("the directories are private to the user and the record is readable by the user alone", async () => {
  const { directory, repo } = await fresh();

  await createTrustRecords(directory).write(repo, "trusted");

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, RECORDS_DIRECTORY))).mode & 0o777, 0o700);
  assert.equal((await stat(await recordFile(directory))).mode & 0o777, 0o600);
});

test("the record is replaced by a rename of a temporary file of the same directory, which leaves no other file", async () => {
  const { directory, repo } = await fresh();
  const renames: Array<[string, string]> = [];
  const records = createTrustRecords(directory, {
    ...defaultTrustRecordDeps,
    rename: async (from, to) => {
      renames.push([from, to]);
      await rename(from, to);
    },
  });

  await records.write(repo, "trusted");

  assert.equal(renames.length, 1);
  assert.equal(renames[0]![0] === renames[0]![1], false);
  assert.equal(join(renames[0]![0], ".."), join(directory, RECORDS_DIRECTORY));
  assert.equal(renames[0]![1], await recordFile(directory));
  assert.equal((await readdir(join(directory, RECORDS_DIRECTORY))).length, 1);
});

test("a write that fails halfway leaves the previous record and no temporary file", async () => {
  const { directory, repo } = await fresh();
  await createTrustRecords(directory).write(repo, "trusted");
  const failing = createTrustRecords(directory, {
    ...defaultTrustRecordDeps,
    rename: async () => {
      throw new Error("disk gone");
    },
  });

  const result = await failing.write(repo, "untrusted");

  assert.equal(faultKind(result), "unwritable");
  assert.deepEqual(await createTrustRecords(directory).read(repo), { ok: true, value: "trusted" });
  assert.equal((await readdir(join(directory, RECORDS_DIRECTORY))).length, 1);
});

for (const [name, content] of [
  ["is not JSON", "{not json"],
  ["has another version", JSON.stringify({ version: 2, repository: "x", trust: "trusted" })],
  ["holds a value that is not a trust mode", JSON.stringify({ version: 1, repository: "x", trust: "admin" })],
] as const) {
  test(`a record that ${name} is an unreadable fault on read and is never overwritten`, async () => {
    const { directory, repo } = await fresh();
    const records = createTrustRecords(directory);
    await records.write(repo, "trusted");
    const file = await recordFile(directory);
    const held = content.replace('"x"', JSON.stringify(await realpath(repo)));
    await writeFile(file, held, { mode: 0o600 });

    assert.equal(faultKind(await records.read(repo)), "unreadable");
    assert.equal(faultKind(await records.write(repo, "untrusted")), "unreadable");
    assert.equal(await readFile(file, "utf8"), held);
  });
}

test("a record that names another repository is an unreadable fault", async () => {
  const { directory, repo } = await fresh();
  const records = createTrustRecords(directory);
  await records.write(repo, "trusted");
  await writeFile(await recordFile(directory), JSON.stringify({ version: 1, repository: "/elsewhere", trust: "trusted" }), { mode: 0o600 });

  assert.equal(faultKind(await records.read(repo)), "unreadable");
});

test("a record directory open to other accounts is refused on read and on write, and is not repaired", async () => {
  const { directory, repo } = await fresh();
  const records = createTrustRecords(directory);
  await records.write(repo, "trusted");
  await chmod(directory, 0o777);

  assert.equal(faultKind(await records.read(repo)), "refused");
  assert.equal(faultKind(await records.write(repo, "untrusted")), "refused");
  assert.equal((await stat(directory)).mode & 0o777, 0o777);
});

test("a record directory that is a symbolic link is refused on read and on write", async () => {
  const { directory, repo } = await fresh();
  const real = join(scratch, `real-config-${counter}`);
  await mkdir(real, { mode: 0o700 });
  await mkdir(join(directory, ".."), { recursive: true });
  await symlink(real, directory);
  const records = createTrustRecords(directory);

  assert.equal(faultKind(await records.read(repo)), "refused");
  assert.equal(faultKind(await records.write(repo, "trusted")), "refused");
  assert.deepEqual(await readdir(real), []);
});

test("a record readable by others is refused on read and on write, and is not repaired", async () => {
  const { directory, repo } = await fresh();
  const records = createTrustRecords(directory);
  await records.write(repo, "trusted");
  const file = await recordFile(directory);
  await chmod(file, 0o666);

  assert.equal(faultKind(await records.read(repo)), "refused");
  assert.equal(faultKind(await records.write(repo, "untrusted")), "refused");
  assert.equal((await stat(file)).mode & 0o777, 0o666);
});

test("a record of another account is refused", async () => {
  const { directory, repo } = await fresh();
  const records = createTrustRecords(directory, { ...defaultTrustRecordDeps, ownerUid: (process.getuid?.() ?? 0) + 1 });
  await createTrustRecords(directory).write(repo, "trusted");

  assert.equal(faultKind(await records.read(repo)), "refused");
});

test("without a place for the record nothing is read and a write is a no-location fault", async () => {
  const { repo } = await fresh();
  const records = createTrustRecords(null);

  assert.deepEqual(await records.read(repo), { ok: true, value: undefined });
  assert.equal(faultKind(await records.write(repo, "trusted")), "no-location");
});

test("a repository that does not exist cannot be declared and reads as undeclared", async () => {
  const { directory } = await fresh();
  const missing = join(scratch, "missing");

  assert.equal(faultKind(await createTrustRecords(directory).write(missing, "trusted")), "unwritable");
  assert.deepEqual(await createTrustRecords(directory).read(missing), { ok: true, value: undefined });
});
