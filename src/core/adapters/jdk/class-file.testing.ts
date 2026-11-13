/** Builders of class files for tests: hand-written bytes, never JDK-derived ones. */
export const ACC_PUBLIC = 0x0001;
export const ACC_PRIVATE = 0x0002;
export const ACC_STATIC = 0x0008;
export const ACC_FINAL = 0x0010;
export const ACC_SUPER = 0x0020;
export const ACC_BRIDGE = 0x0040;
export const ACC_VARARGS = 0x0080;
export const ACC_INTERFACE = 0x0200;
export const ACC_ABSTRACT = 0x0400;
export const ACC_SYNTHETIC = 0x1000;
export const ACC_ANNOTATION = 0x2000;
export const ACC_ENUM = 0x4000;
export const ACC_MODULE = 0x8000;

export const MAGIC = 0xcafebabe;
export const MAJOR = 52;
export const LONG_TAG = 5;
export const INTEGER_TAG = 3;

export function u8(value: number): Buffer {
  return Buffer.from([value]);
}

export function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value, 0);
  return bytes;
}

export function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}

/** The constant pool of one fixture: only the entries a declaration reads are named, the rest are raw. */
class Pool {
  private readonly entries: Buffer[] = [];
  private readonly indices = new Map<string, number>();
  private next = 1;

  utf8(text: string): number {
    const key = `u:${text}`;
    const known = this.indices.get(key);
    if (known !== undefined) return known;
    const body = Buffer.from(text, "utf8");
    const at = this.take(1);
    this.indices.set(key, at);
    this.entries.push(Buffer.concat([u8(1), u16(body.length), body]));
    return at;
  }

  classEntry(internalName: string): number {
    const key = `c:${internalName}`;
    const known = this.indices.get(key);
    if (known !== undefined) return known;
    const name = this.utf8(internalName);
    const at = this.take(1);
    this.indices.set(key, at);
    this.entries.push(Buffer.concat([u8(7), u16(name)]));
    return at;
  }

  /** An entry no declaration reads; a Long takes two slots, as the format states. */
  unused(tag: number, body: Buffer): void {
    this.take(tag === 5 || tag === 6 ? 2 : 1);
    this.entries.push(Buffer.concat([u8(tag), body]));
  }

  get count(): number {
    return this.next;
  }

  bytes(): Buffer {
    return Buffer.concat(this.entries);
  }

  private take(slots: number): number {
    const at = this.next;
    this.next += slots;
    return at;
  }
}

export interface MemberSpec {
  flags: number;
  name: string;
  descriptor: string;
  /** The `Signature` attribute's text, when the member states one. */
  signature?: string;
}

export interface FieldSpec {
  flags: number;
  name: string;
  descriptor: string;
}

export interface ClassSpec {
  access: number;
  name: string;
  /** `null` states no superclass, as `module-info` does; absent means `java.lang.Object`. */
  superName?: string | null;
  interfaces?: readonly string[];
  fields?: readonly FieldSpec[];
  members?: readonly MemberSpec[];
  /** The class's `Signature` attribute, when it states one. */
  signature?: string;
  /** Whether the class states a `Record` attribute. */
  record?: boolean;
  /** Other class attributes, which the decoder skips by their stated length. */
  attributes?: readonly { name: string; text?: string; body?: Buffer }[];
  extra?: readonly { tag: number; body: Buffer }[];
  major?: number;
}

export function buildClass(spec: ClassSpec): Buffer {
  const pool = new Pool();
  for (const extra of spec.extra ?? []) pool.unused(extra.tag, extra.body);
  const thisClass = pool.classEntry(spec.name);
  const superName = spec.superName === undefined ? "java/lang/Object" : spec.superName;
  const superClass = superName === null ? 0 : pool.classEntry(superName);
  const interfaces = (spec.interfaces ?? []).map((name) => pool.classEntry(name));
  const fields = (spec.fields ?? []).map((field) =>
    Buffer.concat([u16(field.flags), u16(pool.utf8(field.name)), u16(pool.utf8(field.descriptor)), u16(0)]),
  );
  const members = (spec.members ?? []).map((member) => {
    const name = pool.utf8(member.name);
    const descriptor = pool.utf8(member.descriptor);
    const attributes =
      member.signature === undefined ? [] : [Buffer.concat([u16(pool.utf8("Signature")), u32(2), u16(pool.utf8(member.signature))])];
    return Buffer.concat([u16(member.flags), u16(name), u16(descriptor), u16(attributes.length), ...attributes]);
  });
  const classAttributes: Buffer[] = [];
  if (spec.signature !== undefined) classAttributes.push(Buffer.concat([u16(pool.utf8("Signature")), u32(2), u16(pool.utf8(spec.signature))]));
  if (spec.record === true) classAttributes.push(Buffer.concat([u16(pool.utf8("Record")), u32(2), u16(0)]));
  for (const attribute of spec.attributes ?? []) {
    const body = attribute.text === undefined ? (attribute.body ?? Buffer.alloc(0)) : u16(pool.utf8(attribute.text));
    classAttributes.push(Buffer.concat([u16(pool.utf8(attribute.name)), u32(body.length), body]));
  }
  return Buffer.concat([
    u32(MAGIC),
    u16(0),
    u16(spec.major ?? MAJOR),
    u16(pool.count),
    pool.bytes(),
    u16(spec.access),
    u16(thisClass),
    u16(superClass),
    u16(interfaces.length),
    ...interfaces.map((index) => u16(index)),
    u16(fields.length),
    ...fields,
    u16(members.length),
    ...members,
    u16(classAttributes.length),
    ...classAttributes,
  ]);
}
