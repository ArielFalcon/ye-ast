import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { defaultJdkArchiveDeps, openJdkArchive, type JdkArchiveDeps } from "./jdk-archive.adapter.ts";

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-jdk-archive-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Member {
  name: string;
  content: string;
  /** 0 stored, 8 deflate; anything else states a method the reader does not support. */
  method?: number;
}

const STORED = 0;
const DEFLATE = 8;
const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DIRECTORY_SIGNATURE = 0x02014b50;

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
}

/** A ZIP as a writer produces it: locals, then the central directory, then the end record. */
function zipBytes(members: readonly Member[], comment = ""): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const method = member.method ?? STORED;
    const content = Buffer.from(member.content, "utf8");
    const data = method === STORED ? content : deflateRawSync(content);
    const name = Buffer.from(member.name, "utf8");
    const local = Buffer.concat([
      u32(LOCAL_SIGNATURE),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(content.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    locals.push(local);
    directory.push(
      Buffer.concat([
        u32(DIRECTORY_SIGNATURE),
        u16(20),
        u16(20),
        u16(0),
        u16(method),
        u16(0),
        u16(0),
        u32(0),
        u32(data.length),
        u32(content.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const central = Buffer.concat(directory);
  const stated = Buffer.from(comment, "utf8");
  return Buffer.concat([
    ...locals,
    central,
    Buffer.concat([u32(EOCD_SIGNATURE), u16(0), u16(0), u16(members.length), u16(members.length), u32(central.length), u32(offset), u16(stated.length), stated]),
  ]);
}

async function archiveFile(bytes: Buffer): Promise<string> {
  counter += 1;
  const path = join(scratch, `archive-${counter}.zip`);
  await writeFile(path, bytes);
  return path;
}

test("an archive lists the entries under a prefix and inflates one by name", async () => {
  const stored = { name: "java/lang/Object.class", content: "OBJECT", method: STORED };
  const deflated = { name: "java/util/List.class", content: "LIST ".repeat(40), method: DEFLATE };
  const other = { name: "java/util/Map.class", content: "MAP", method: DEFLATE };
  const archive = openJdkArchive(await archiveFile(zipBytes([deflated, stored, other], "pinned by digest")));
  assert.deepEqual(archive.names("java/util/"), ["java/util/List.class", "java/util/Map.class"]);
  assert.deepEqual(archive.names(""), ["java/lang/Object.class", "java/util/List.class", "java/util/Map.class"]);
  assert.deepEqual(archive.entry("java/util/List.class"), { kind: "entry", name: deflated.name, bytes: Buffer.from(deflated.content) });
  assert.deepEqual(archive.entry("java/lang/Missing.class"), { kind: "absent" });
});

test("a truncated archive answers unreadable for every entry, never absent", async () => {
  const bytes = zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]);
  const archive = openJdkArchive(await archiveFile(bytes.subarray(0, bytes.length - 12)));
  assert.deepEqual(archive.names(""), []);
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});

test("an entry name that climbs out, is absolute or names a drive is refused, never listed", async () => {
  const names = ["../escape.class", "/absolute.class", "C:\\drive.class", "java/ok.class"];
  const archive = openJdkArchive(await archiveFile(zipBytes(names.map((name) => ({ name, content: name })))));
  assert.deepEqual(archive.names(""), ["java/ok.class"]);
  for (const name of names.slice(0, 3)) assert.deepEqual(archive.entry(name), { kind: "unreadable", name });
  assert.equal(archive.entry("java/ok.class").kind, "entry");
});

test("a ZIP64 archive is refused, never listed partially", async () => {
  const bytes = Buffer.from(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
  const end = bytes.length - 22;
  bytes.writeUInt16LE(0xffff, end + 8);
  bytes.writeUInt16LE(0xffff, end + 10);
  bytes.writeUInt32LE(0xffffffff, end + 12);
  bytes.writeUInt32LE(0xffffffff, end + 16);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.deepEqual(archive.names(""), []);
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});

test("a member compressed with a method other than stored or deflate is unreadable", async () => {
  const archive = openJdkArchive(await archiveFile(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: 12 }])));
  assert.deepEqual(archive.names("java/lang/"), ["java/lang/Object.class"]);
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});

test("a path that is a link, not a regular file, absent or unreadable reads nothing", async () => {
  const path = await archiveFile(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
  const link = join(scratch, "linked.zip");
  await symlink(path, link);
  const directory = join(scratch, "folder");
  await mkdir(directory, { recursive: true });
  const denied: JdkArchiveDeps = {
    ...defaultJdkArchiveDeps,
    stat: () => undefined,
  };
  const deniedRead: JdkArchiveDeps = {
    ...defaultJdkArchiveDeps,
    readFile: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
  };
  const followsLinks: JdkArchiveDeps = {
    ...defaultJdkArchiveDeps,
    stat: () => ({ isFile: () => true, isSymbolicLink: () => true }),
  };
  const archives = [
    openJdkArchive(link),
    openJdkArchive(directory),
    openJdkArchive(join(scratch, "missing.zip")),
    openJdkArchive(path, denied),
    openJdkArchive(link, followsLinks),
    openJdkArchive(path, deniedRead),
  ];
  for (const archive of archives) {
    assert.deepEqual(archive.names(""), []);
    assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
    assert.equal(archive.digest, "");
  }
});

test("the digest is the SHA-256 of the archive's bytes", async () => {
  const bytes = zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.equal(archive.digest, createHash("sha256").update(bytes).digest("hex"));
});

test("an end record that understates the directory is refused, never answered absent", async () => {
  const bytes = Buffer.from(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
  const end = bytes.length - 22;
  bytes.writeUInt16LE(0, end + 8);
  bytes.writeUInt16LE(0, end + 10);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});

test("a member whose bytes contradict its directory record is unreadable", async () => {
  const bytes = Buffer.from(zipBytes([{ name: "java/util/List.class", content: "LIST ".repeat(40), method: DEFLATE }]));
  const end = bytes.length - 22;
  const directoryAt = bytes.readUInt32LE(end + 16);
  bytes.writeUInt32LE(1, directoryAt + 24);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.deepEqual(archive.entry("java/util/List.class"), { kind: "unreadable", name: "java/util/List.class" });
});

test("a member whose local record names another entry is unreadable", async () => {
  const bytes = Buffer.from(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
  bytes.writeUInt8("X".charCodeAt(0), 30);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});

test("a member whose stated length reaches past the file is unreadable, never clamped", async () => {
  const bytes = Buffer.from(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
  const end = bytes.length - 22;
  const directoryAt = bytes.readUInt32LE(end + 16);
  bytes.writeUInt32LE(bytes.readUInt32LE(directoryAt + 20) + 1_000_000, directoryAt + 20);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});
