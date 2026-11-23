import assert from "node:assert/strict";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { scratchRuntime } from "./daemon.testing.ts";
import { daemonFiles, runtimeDirectory, runtimeDirectoryRefusal } from "./runtime-directory.ts";

const uid = 501;
const base = { platform: "darwin" as const, uid, tmpdir: "/var/folders/xy/T" };

test("the runtime directory is XDG_RUNTIME_DIR's when absolute, the temporary directory's otherwise, and none without account ids", () => {
  assert.equal(runtimeDirectory({ ...base, env: { XDG_RUNTIME_DIR: "/run/user/501" } }), "/run/user/501/ye-ast");
  assert.equal(runtimeDirectory({ ...base, env: { XDG_RUNTIME_DIR: "run/user" } }), "/var/folders/xy/T/ye-ast-501");
  assert.equal(runtimeDirectory({ ...base, env: {}, uid: undefined }), null);
  assert.equal(runtimeDirectory({ ...base, env: {}, platform: "win32" }), null);
});

test("a socket path longer than the platform binds moves to a directory under /tmp named by the preferred one, one per preferred directory", () => {
  const fits = "/t/" + "a".repeat(103 - "/t//ye-ast-501/".length - basename(daemonFiles("", "/any/installation").socket).length);
  assert.equal(runtimeDirectory({ ...base, env: {}, tmpdir: fits }), join(fits, "ye-ast-501"));
  const long = (suffix: string) => runtimeDirectory({ ...base, env: {}, tmpdir: `${fits}${suffix}` })!;
  assert.match(long("b"), /^\/tmp\/ye-ast-501-[0-9a-f]{16}$/);
  assert.notEqual(long("b"), long("c"));
  assert.equal(runtimeDirectory({ ...base, platform: "linux", env: {}, tmpdir: `${fits}bbbb` }), join(`${fits}bbbb`, "ye-ast-501"));
});

let scratch: Awaited<ReturnType<typeof scratchRuntime>>;
beforeEach(async () => {
  scratch = await scratchRuntime();
});
afterEach(async () => {
  await scratch.remove();
});

test("the runtime directory is created private, and one open to other accounts or a symbolic link is refused", async () => {
  const owner = process.getuid!();
  const fresh = join(scratch.directory, "fresh");
  assert.equal(await runtimeDirectoryRefusal(fresh, owner), null);
  const open = join(scratch.directory, "open");
  await mkdir(open);
  await chmod(open, 0o755);
  assert.notEqual(await runtimeDirectoryRefusal(open, owner), null);
  const linked = join(scratch.directory, "linked");
  await symlink(fresh, linked);
  assert.notEqual(await runtimeDirectoryRefusal(linked, owner), null);
  assert.notEqual(await runtimeDirectoryRefusal(fresh, owner + 1), null);
});
