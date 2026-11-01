import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FIXED_LAYER_DIRECTORY } from "../../ports/fixed-layer-store.port.ts";
import { createFixedLayerStore, defaultFixedLayerStoreDeps, type FixedLayerStoreDeps } from "./fixed-layer-store.adapter.ts";

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-fixed-layer-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  counter += 1;
  return join(scratch, `root-${counter}`);
}

test("write creates the layer directory and read returns the content", async () => {
  const root = await freshRoot();
  const store = createFixedLayerStore();
  const written = await store.write(root, "entrypoints.json", "{}\n");
  assert.equal(written.ok, true);
  assert.equal(await readFile(join(root, FIXED_LAYER_DIRECTORY, "entrypoints.json"), "utf8"), "{}\n");
  assert.deepEqual(await store.read(root, "entrypoints.json"), { ok: true, value: "{}\n" });
});

test("read answers undefined for a file the layer does not hold", async () => {
  const root = await freshRoot();
  assert.deepEqual(await createFixedLayerStore().read(root, "entrypoints.json"), { ok: true, value: undefined });
});

test("write renames a temporary file of the same directory over the target and leaves no other file", async () => {
  const root = await freshRoot();
  const layer = join(root, FIXED_LAYER_DIRECTORY);
  const renames: { from: string; to: string; targetExisted: boolean }[] = [];
  const deps: FixedLayerStoreDeps = {
    ...defaultFixedLayerStoreDeps,
    rename: async (from, to) => {
      renames.push({ from, to, targetExisted: await stat(to).then(() => true, () => false) });
      await defaultFixedLayerStoreDeps.rename(from, to);
    },
  };
  const store = createFixedLayerStore(deps);
  await store.write(root, "README.md", "old\n");
  await store.write(root, "README.md", "new\n");

  assert.equal(renames.length, 2);
  for (const rename of renames) {
    assert.equal(dirname(rename.from), layer);
    assert.equal(rename.to, join(layer, "README.md"));
    assert.notEqual(rename.from, rename.to);
  }
  assert.equal(renames[1]?.targetExisted, true);
  assert.deepEqual(await readdir(layer), ["README.md"]);
  assert.equal(await readFile(join(layer, "README.md"), "utf8"), "new\n");
});

test("a failed rename leaves the previous file whole and no temporary file", async () => {
  const root = await freshRoot();
  const layer = join(root, FIXED_LAYER_DIRECTORY);
  await createFixedLayerStore().write(root, "README.md", "old\n");
  const failing = createFixedLayerStore({
    ...defaultFixedLayerStoreDeps,
    rename: async () => {
      throw new Error("disk gone");
    },
  });
  const result = await failing.write(root, "README.md", "new\n");
  assert.deepEqual(result.ok ? undefined : result.fault.kind, "unwritable");
  assert.deepEqual(await readdir(layer), ["README.md"]);
  assert.equal(await readFile(join(layer, "README.md"), "utf8"), "old\n");
});

test("write answers unwritable when the root is not a directory", async () => {
  const root = await freshRoot();
  await writeFile(root, "a file");
  const result = await createFixedLayerStore().write(root, "README.md", "x");
  assert.deepEqual(result.ok ? undefined : result.fault.kind, "unwritable");
});

test("read answers unreadable when the layer path is not a directory", async () => {
  const root = await freshRoot();
  await createFixedLayerStore().write(root, "README.md", "x");
  const store = createFixedLayerStore();
  const result = await store.read(join(root, FIXED_LAYER_DIRECTORY, "README.md"), "entrypoints.json");
  assert.deepEqual(result.ok ? undefined : result.fault.kind, "unreadable");
});

test("a name that would leave the layer directory is invalid for read and write", async () => {
  const root = await freshRoot();
  const store = createFixedLayerStore();
  for (const name of ["../escape.json", "sub/file.json", "..", ""]) {
    const written = await store.write(root, name, "x");
    assert.deepEqual(written.ok ? undefined : written.fault.kind, "invalid-name", name);
    const read = await store.read(root, name);
    assert.deepEqual(read.ok ? undefined : read.fault.kind, "invalid-name", name);
  }
  assert.equal(await stat(join(root, "escape.json")).then(() => true, () => false), false);
});

test("write refuses a layer directory that is a symbolic link and writes nothing through it", async () => {
  const root = await freshRoot();
  const outside = join(scratch, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(root, FIXED_LAYER_DIRECTORY));
  const result = await createFixedLayerStore().write(root, "README.md", "x");
  assert.deepEqual(result.ok ? undefined : result.fault.kind, "unwritable");
  assert.deepEqual(await readdir(outside), []);
});
