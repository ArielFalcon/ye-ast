import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/**
 * Reads a JDK archive (`ct.sym`, a `jmods` member) as data, confined to the host path the caller names (ADR-0044
 * decision 10, ADR-0007's exact pin). The central directory is read once on open and a member is inflated only when it
 * is asked for. Every bound comes from the file itself, never from a header alone, so a truncated, corrupt, ZIP64 or
 * unsupported-method archive is `unreadable`, never a partial listing.
 */

/** One archive entry: its path inside the archive and its uncompressed bytes; absence is explicit, never empty. */
export type ArchiveEntry = { kind: "entry"; name: string; bytes: Buffer } | { kind: "absent" } | { kind: "unreadable"; name: string };

export interface JdkArchive {
  /** Every entry name under a prefix, sorted, read from the central directory only (no member is inflated). */
  names(prefix: string): readonly string[];
  entry(name: string): ArchiveEntry;
  /** SHA-256 of the archive's bytes, as the pin states it (hex); empty when the bytes could not be read. */
  readonly digest: string;
}

/** The path as the host states it, without following a link: a link is refused, never resolved (ADR-0037 decision 3). */
interface HostEntry {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface JdkArchiveDeps {
  stat(path: string): HostEntry | undefined;
  readFile(path: string): Buffer;
}

export const defaultJdkArchiveDeps: JdkArchiveDeps = {
  stat: (path) => lstatSync(path, { throwIfNoEntry: false }),
  readFile: (path) => readFileSync(path),
};

const END_SIGNATURE = 0x06054b50;
const END_RECORD_SIZE = 22;
const COMMENT_LIMIT = 0xffff;
const DIRECTORY_SIGNATURE = 0x02014b50;
const DIRECTORY_RECORD_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_RECORD_SIZE = 30;
/** A ZIP64 field the 32-bit record cannot state; this reader does not follow the ZIP64 records. */
const ZIP64_SENTINEL = 0xffffffff;
const ZIP64_ENTRIES = 0xffff;
const STORED = 0;
const DEFLATE = 8;
/** General-purpose bit 0: the member's payload is encrypted, which this reader never decrypts. */
const ENCRYPTED = 0x0001;
/** Deflate expands at most about 1032:1 (RFC 1951's 32 KiB window), so its input bounds the output. */
const DEFLATE_RATIO = 1032;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const PATH_SEGMENT = /[\\/]/;

interface Member {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

interface Directory {
  members: readonly Member[];
  byName: ReadonlyMap<string, Member>;
}

export function openJdkArchive(path: string, deps: JdkArchiveDeps = defaultJdkArchiveDeps): JdkArchive {
  const bytes = confinedBytes(path, deps);
  const directory = bytes === undefined ? undefined : readDirectory(bytes);
  return {
    names: (prefix) => namesOf(directory, prefix),
    entry: (name) => entryOf(bytes, directory, name),
    digest: bytes === undefined ? "" : createHash("sha256").update(bytes).digest("hex"),
  };
}

/** The archive's bytes, or `undefined` when the path is absent, a link, not a regular file, or unreadable. */
function confinedBytes(path: string, deps: JdkArchiveDeps): Buffer | undefined {
  let entry: HostEntry | undefined;
  try {
    entry = deps.stat(path);
  } catch (error) {
    if (!isPlatformFault(error)) throw error;
    return undefined;
  }
  if (entry === undefined || entry.isSymbolicLink() || !entry.isFile()) return undefined;
  try {
    return deps.readFile(path);
  } catch (error) {
    if (!isPlatformFault(error)) throw error;
    return undefined;
  }
}

/** A refusal of the platform (the file system or zlib), which carries its error code. */
function isPlatformFault(error: unknown): boolean {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

function namesOf(directory: Directory | undefined, prefix: string): readonly string[] {
  if (directory === undefined) return [];
  const names = new Set<string>();
  for (const member of directory.members) if (isConfined(member.name) && member.name.startsWith(prefix)) names.add(member.name);
  return [...names].sort();
}

function entryOf(bytes: Buffer | undefined, directory: Directory | undefined, name: string): ArchiveEntry {
  if (bytes === undefined || directory === undefined || !isConfined(name)) return { kind: "unreadable", name };
  const member = directory.byName.get(name);
  if (member === undefined) return { kind: "absent" };
  const content = readMember(bytes, member);
  return content === undefined ? { kind: "unreadable", name } : { kind: "entry", name, bytes: content };
}

/** A name is confined when it is relative, inside the archive and carries no segment that climbs out. */
function isConfined(name: string): boolean {
  if (name === "" || name.startsWith("/") || name.startsWith("\\") || DRIVE_PREFIX.test(name)) return false;
  return !name.split(PATH_SEGMENT).includes("..");
}

function readDirectory(bytes: Buffer): Directory | undefined {
  const end = endRecordAt(bytes);
  if (end === undefined) return undefined;
  const disk = u16At(bytes, end + 4);
  const directoryDisk = u16At(bytes, end + 6);
  const entries = u16At(bytes, end + 10);
  const size = u32At(bytes, end + 12);
  const offset = u32At(bytes, end + 16);
  if (disk === undefined || directoryDisk === undefined || entries === undefined || size === undefined || offset === undefined) {
    return undefined;
  }
  if (disk !== 0 || directoryDisk !== 0) return undefined;
  if (entries === ZIP64_ENTRIES || size === ZIP64_SENTINEL || offset === ZIP64_SENTINEL) return undefined;
  const limit = offset + size;
  if (size < entries * DIRECTORY_RECORD_SIZE || limit !== end) return undefined;
  const members: Member[] = [];
  const byName = new Map<string, Member>();
  let at = offset;
  for (let index = 0; index < entries; index += 1) {
    if (u32At(bytes, at) !== DIRECTORY_SIGNATURE) return undefined;
    const flags = u16At(bytes, at + 8);
    const method = u16At(bytes, at + 10);
    const compressedSize = u32At(bytes, at + 20);
    const uncompressedSize = u32At(bytes, at + 24);
    const nameLength = u16At(bytes, at + 28);
    const extraLength = u16At(bytes, at + 30);
    const commentLength = u16At(bytes, at + 32);
    const localOffset = u32At(bytes, at + 42);
    if (
      flags === undefined ||
      method === undefined ||
      compressedSize === undefined ||
      uncompressedSize === undefined ||
      nameLength === undefined ||
      extraLength === undefined ||
      commentLength === undefined ||
      localOffset === undefined
    ) {
      return undefined;
    }
    if ((flags & ENCRYPTED) !== 0) return undefined;
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) return undefined;
    if (method === STORED && compressedSize !== uncompressedSize) return undefined;
    const next = at + DIRECTORY_RECORD_SIZE + nameLength + extraLength + commentLength;
    if (next > limit) return undefined;
    const name = bytes.toString("utf8", at + DIRECTORY_RECORD_SIZE, at + DIRECTORY_RECORD_SIZE + nameLength);
    if (byName.has(name)) return undefined;
    const member: Member = { name, method, compressedSize, uncompressedSize, localOffset };
    members.push(member);
    byName.set(name, member);
    at = next;
  }
  return at === limit ? { members, byName } : undefined;
}

/** The end of central directory record: the last signature whose stated comment ends the file. */
function endRecordAt(bytes: Buffer): number | undefined {
  const oldest = Math.max(0, bytes.length - END_RECORD_SIZE - COMMENT_LIMIT);
  for (let at = bytes.length - END_RECORD_SIZE; at >= oldest; at -= 1) {
    if (u32At(bytes, at) !== END_SIGNATURE) continue;
    if (u16At(bytes, at + 20) === bytes.length - at - END_RECORD_SIZE) return at;
  }
  return undefined;
}

/** A member's uncompressed bytes; `undefined` when its local record or its inflated size contradicts the directory. */
function readMember(bytes: Buffer, member: Member): Buffer | undefined {
  if (u32At(bytes, member.localOffset) !== LOCAL_SIGNATURE) return undefined;
  const method = u16At(bytes, member.localOffset + 8);
  const nameLength = u16At(bytes, member.localOffset + 26);
  const extraLength = u16At(bytes, member.localOffset + 28);
  if (method === undefined || nameLength === undefined || extraLength === undefined || method !== member.method) return undefined;
  const nameAt = member.localOffset + LOCAL_RECORD_SIZE;
  const dataAt = nameAt + nameLength + extraLength;
  if (dataAt + member.compressedSize > bytes.length) return undefined;
  if (bytes.toString("utf8", nameAt, nameAt + nameLength) !== member.name) return undefined;
  const data = bytes.subarray(dataAt, dataAt + member.compressedSize);
  if (method === STORED) return Buffer.from(data);
  if (method !== DEFLATE) return undefined;
  let inflated: Buffer;
  try {
    const bound = Math.max(Math.min(member.uncompressedSize, member.compressedSize * DEFLATE_RATIO), 1);
    inflated = inflateRawSync(data, { maxOutputLength: bound });
  } catch (error) {
    if (!isPlatformFault(error)) throw error;
    return undefined;
  }
  return inflated.length === member.uncompressedSize ? inflated : undefined;
}

function u16At(bytes: Buffer, at: number): number | undefined {
  return at >= 0 && at + 2 <= bytes.length ? bytes.readUInt16LE(at) : undefined;
}

function u32At(bytes: Buffer, at: number): number | undefined {
  return at >= 0 && at + 4 <= bytes.length ? bytes.readUInt32LE(at) : undefined;
}
