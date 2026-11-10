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

/** The end record a candidate is forged from; the comment length is stated in bytes, not derived. */
function endRecord(fields: { entries: number; size: number; offset: number; commentLength: number }): Buffer {
  return Buffer.concat([
    u32(EOCD_SIGNATURE),
    u16(0),
    u16(0),
    u16(fields.entries),
    u16(fields.entries),
    u32(fields.size),
    u32(fields.offset),
    u16(fields.commentLength),
  ]);
}

/** A ZIP as a writer produces it: locals, then the central directory, then the end record. */
function zipBytes(members: readonly Member[], comment: string | Buffer = ""): Buffer {
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
  const stated = typeof comment === "string" ? Buffer.from(comment, "utf8") : comment;
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

test("a stored member whose directory states unequal sizes refuses the archive, never its raw bytes", async () => {
  const bytes = Buffer.from(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
  const directoryAt = bytes.readUInt32LE(bytes.length - 22 + 16);
  bytes.writeUInt32LE(3, directoryAt + 20);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.deepEqual(archive.names(""), []);
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});

test("an end record forged inside another end record's comment is refused, never read as an empty archive", async () => {
  const members = [{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }];
  for (const trailing of [0, 64]) {
    const commentAt = zipBytes(members).length;
    const comment = Buffer.concat([endRecord({ entries: 0, size: 0, offset: commentAt, commentLength: trailing }), Buffer.alloc(trailing)]);
    const archive = openJdkArchive(await archiveFile(zipBytes(members, comment)));
    assert.deepEqual(archive.names(""), ["java/lang/Object.class"]);
    assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "entry", name: "java/lang/Object.class", bytes: Buffer.from("OBJECT") });
    assert.deepEqual(archive.entry("java/lang/Forged.class"), { kind: "absent" });
  }
});

test("a forged comment naming a member the file does not hold lists nothing and reads that member as absent", async () => {
  const members = [{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }];
  const base = zipBytes(members);
  const phantom = zipBytes([{ name: "java/lang/Phantom.class", content: "GHOST", method: STORED }]);
  const phantomEnd = phantom.length - 22;
  const phantomDirectoryAt = phantom.readUInt32LE(phantomEnd + 16);
  const record = Buffer.from(phantom.subarray(0, phantomEnd));
  record.writeUInt32LE(base.length, phantomDirectoryAt + 42);
  const forged = endRecord({
    entries: 1,
    size: phantom.readUInt32LE(phantomEnd + 12),
    offset: base.length + phantomDirectoryAt,
    commentLength: 0,
  });
  const archive = openJdkArchive(await archiveFile(zipBytes(members, Buffer.concat([record, forged]))));
  assert.deepEqual(archive.names(""), ["java/lang/Object.class"]);
  assert.deepEqual(archive.entry("java/lang/Phantom.class"), { kind: "absent" });
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "entry", name: "java/lang/Object.class", bytes: Buffer.from("OBJECT") });
});

test("a stored member whose declared size reaches into the next record is unreadable, never fabricated bytes", async () => {
  const bytes = Buffer.from(
    zipBytes([
      { name: "java/lang/Object.class", content: "OBJECT", method: STORED },
      { name: "java/lang/String.class", content: "S".repeat(5_000), method: STORED },
    ]),
  );
  const directoryAt = bytes.readUInt32LE(bytes.length - 22 + 16);
  bytes.writeUInt32LE(1_000, directoryAt + 20);
  bytes.writeUInt32LE(1_000, directoryAt + 24);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.deepEqual(archive.names(""), []);
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
  assert.deepEqual(archive.entry("java/lang/String.class"), { kind: "unreadable", name: "java/lang/String.class" });
});

test("an entry name carrying a NUL byte is refused, never listed nor read", async () => {
  const name = "java/lang/Ob\u0000ject.class";
  const archive = openJdkArchive(await archiveFile(zipBytes([{ name, content: "OBJECT", method: STORED }])));
  assert.deepEqual(archive.names(""), []);
  assert.deepEqual(archive.entry(name), { kind: "unreadable", name });
});

test("an encrypted member refuses the archive, never answering its ciphertext", async () => {
  const bytes = Buffer.from(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
  const directoryAt = bytes.readUInt32LE(bytes.length - 22 + 16);
  bytes.writeUInt16LE(1, directoryAt + 8);
  bytes.writeUInt16LE(1, bytes.readUInt32LE(directoryAt + 42) + 6);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.deepEqual(archive.names(""), []);
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});

test("two members under one name refuse the archive, never a partial listing", async () => {
  const members = [
    { name: "java/lang/Object.class", content: "FIRST", method: STORED },
    { name: "java/lang/Object.class", content: "SECOND", method: STORED },
  ];
  const archive = openJdkArchive(await archiveFile(zipBytes(members)));
  assert.deepEqual(archive.names(""), []);
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});

test("a multi-disk archive is unreadable, whichever disk number reports it", async () => {
  const bytes = zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]);
  for (const at of [4, 6]) {
    const split = Buffer.from(bytes);
    split.writeUInt16LE(1, split.length - 22 + at);
    const archive = openJdkArchive(await archiveFile(split));
    assert.deepEqual(archive.names(""), []);
    assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
  }
});

test("a deflate bomb declaring a small size is refused without inflating it", async () => {
  const declared = 10;
  const bytes = Buffer.from(zipBytes([{ name: "java/lang/Bomb.class", content: "0".repeat(16_000_000), method: DEFLATE }]));
  const directoryAt = bytes.readUInt32LE(bytes.length - 22 + 16);
  bytes.writeUInt32LE(declared, directoryAt + 24);
  const archive = openJdkArchive(await archiveFile(bytes));
  const before = process.memoryUsage().external;
  const entry = archive.entry("java/lang/Bomb.class");
  const inflated = process.memoryUsage().external - before;
  assert.deepEqual(entry, { kind: "unreadable", name: "java/lang/Bomb.class" });
  assert.ok(inflated < 1_000_000, `the reader allocated ${inflated} bytes for a member declaring ${declared}`);
});

test("a ZIP64 entry count in the end record is refused even when the directory holds that many records", async () => {
  const members = Array.from({ length: 0xffff }, (_, index) => ({ name: `f/${index}.class`, content: "", method: STORED }));
  const archive = openJdkArchive(await archiveFile(zipBytes(members)));
  assert.deepEqual(archive.names(""), []);
  assert.deepEqual(archive.entry("f/0.class"), { kind: "unreadable", name: "f/0.class" });
});

test("an end record whose size or offset is the ZIP64 sentinel is refused", async () => {
  for (const at of [12, 16]) {
    const bytes = Buffer.from(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
    bytes.writeUInt32LE(0xffffffff, bytes.length - 22 + at);
    const archive = openJdkArchive(await archiveFile(bytes));
    assert.deepEqual(archive.names(""), []);
    assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
  }
});

test("a member whose size or offset is the ZIP64 sentinel refuses the archive, never listing it", async () => {
  for (const at of [20, 24, 42]) {
    const bytes = Buffer.from(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
    const directoryAt = bytes.readUInt32LE(bytes.length - 22 + 16);
    bytes.writeUInt32LE(0xffffffff, directoryAt + at);
    const archive = openJdkArchive(await archiveFile(bytes));
    assert.deepEqual(archive.names(""), []);
    assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
  }
});

test("a member whose local method differs from its directory method is unreadable", async () => {
  const bytes = Buffer.from(zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]));
  const directoryAt = bytes.readUInt32LE(bytes.length - 22 + 16);
  bytes.writeUInt16LE(DEFLATE, directoryAt + 10);
  const archive = openJdkArchive(await archiveFile(bytes));
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});

test("a jmod's JM header before the ZIP makes the archive unreadable, never unwrapped", async () => {
  const bytes = zipBytes([{ name: "java/lang/Object.class", content: "OBJECT", method: STORED }]);
  const header = Buffer.from([0x4a, 0x4d, 0x01, 0x00]);
  const archive = openJdkArchive(await archiveFile(Buffer.concat([header, bytes])));
  assert.deepEqual(archive.names(""), []);
  assert.deepEqual(archive.entry("java/lang/Object.class"), { kind: "unreadable", name: "java/lang/Object.class" });
});
