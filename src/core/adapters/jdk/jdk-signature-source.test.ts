import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { JdkArchive } from "./jdk-archive.adapter.js";
import { jdkSignaturesOf } from "./jdk-signature-source.js";
import { PINNED_JDK_DIGESTS } from "./jdk-signature-generator.js";

const [PINNED] = [...PINNED_JDK_DIGESTS];
const OBJECT_SIG = "N/java.base/java/lang/Object.sig";

function u16(value: number): Buffer {
  return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Buffer {
  return Buffer.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** A class file with no members: the smallest declaration the decoder accepts, for `java.lang.Object`. */
function objectClass(): Buffer {
  const name = Buffer.from("java/lang/Object");
  const utf8 = Buffer.concat([Buffer.from([1]), u16(name.length), name]);
  const classEntry = Buffer.from([7, 0, 1]);
  const ACC_PUBLIC_SUPER = 0x0021;
  const noSuper = u16(0), noInterfaces = u16(0), noFields = u16(0), noMethods = u16(0), noAttributes = u16(0);
  return Buffer.concat([u32(0xcafebabe), u16(0), u16(67), u16(3), utf8, classEntry, u16(ACC_PUBLIC_SUPER), u16(2), noSuper, noInterfaces, noFields, noMethods, noAttributes]);
}

function archiveOf(digest: string): JdkArchive {
  const bytes = objectClass();
  return {
    digest,
    names: (prefix) => (prefix === "" ? [OBJECT_SIG] : []),
    entry: (name) => ({ kind: "entry", name, bytes }),
  };
}

test("a JDK of another digest yields no table, and the pinned one yields it", () => {
  const other = (PINNED.startsWith("0") ? "1" : "0") + PINNED.slice(1);
  const pinned = jdkSignaturesOf({ kind: "host", path: "/jdk/pinned" }, { open: () => archiveOf(PINNED) });
  assert.equal(pinned?.release(23)?.has("java.lang.Object"), true);
  assert.equal(jdkSignaturesOf({ kind: "host", path: "/jdk/other" }, { open: () => archiveOf(other) }), undefined);
});

test("an unreadable archive, whose digest is empty, yields no table", () => {
  assert.equal(jdkSignaturesOf({ kind: "host", path: "/jdk/unreadable" }, { open: () => archiveOf("") }), undefined);
});

test("a pinned archive that holds no declaration yields no table instead of inventing one", () => {
  const empty: JdkArchive = { digest: PINNED, names: () => [], entry: () => assert.fail("no member is read") };
  assert.equal(jdkSignaturesOf({ kind: "host", path: "/jdk/empty" }, { open: () => empty }), undefined);
});

test("the archive read is the lib/ct.sym under the JDK home the source names", () => {
  const opened: string[] = [];
  jdkSignaturesOf({ kind: "host", path: "/jdk/home-lib" }, { open: (path) => { opened.push(path); return archiveOf(""); } });
  assert.deepEqual(opened, [join("/jdk/home-lib", "lib", "ct.sym")]);
});

test("no source reads no archive", () => {
  assert.equal(jdkSignaturesOf({ kind: "none" }, { open: () => assert.fail("no archive is opened") }), undefined);
});
