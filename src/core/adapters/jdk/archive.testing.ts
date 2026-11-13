/** Builders of ZIP archives for tests: hand-written bytes, never JDK-derived ones. */
import { deflateRawSync } from "node:zlib";

export interface Member {
  name: string;
  content: string | Buffer;
  /** 0 stored, 8 deflate; anything else states a method the reader does not support. */
  method?: number;
}

export const STORED = 0;
export const DEFLATE = 8;
export const EOCD_SIGNATURE = 0x06054b50;
export const LOCAL_SIGNATURE = 0x04034b50;
export const DIRECTORY_SIGNATURE = 0x02014b50;

export function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
}

export function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
}

/** The end record a candidate is forged from; the comment length is stated in bytes, not derived. */
export function endRecord(fields: { entries: number; size: number; offset: number; commentLength: number }): Buffer {
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
export function zipBytes(members: readonly Member[], comment: string | Buffer = ""): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const method = member.method ?? STORED;
    const content = Buffer.isBuffer(member.content) ? member.content : Buffer.from(member.content, "utf8");
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
