import { test } from "node:test";
import assert from "node:assert/strict";
import { readClassFile } from "./class-file.ts";

const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_SUPER = 0x0020;
const ACC_BRIDGE = 0x0040;
const ACC_VARARGS = 0x0080;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_SYNTHETIC = 0x1000;
const ACC_ANNOTATION = 0x2000;
const ACC_ENUM = 0x4000;
const ACC_MODULE = 0x8000;

const MAGIC = 0xcafebabe;
const MAJOR = 52;
const LONG_TAG = 5;
const INTEGER_TAG = 3;

function u8(value: number): Buffer {
  return Buffer.from([value]);
}

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value, 0);
  return bytes;
}

function u32(value: number): Buffer {
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

interface MemberSpec {
  flags: number;
  name: string;
  descriptor: string;
  /** The `Signature` attribute's text, when the member states one. */
  signature?: string;
}

interface FieldSpec {
  flags: number;
  name: string;
  descriptor: string;
}

interface ClassSpec {
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

function buildClass(spec: ClassSpec): Buffer {
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

test("a class file states a varargs member, a static interface member and skips a bridge", () => {
  const marker = buildClass({
    access: ACC_PUBLIC | ACC_INTERFACE | ACC_ABSTRACT,
    name: "app/Marker",
    members: [
      { flags: ACC_PUBLIC | ACC_STATIC, name: "of", descriptor: "(Ljava/lang/String;)Ljava/lang/String;" },
      { flags: ACC_PUBLIC, name: "render", descriptor: "()Ljava/lang/String;" },
      { flags: ACC_PUBLIC | ACC_ABSTRACT, name: "size", descriptor: "()I" },
      { flags: ACC_PRIVATE, name: "hidden", descriptor: "()V" },
      { flags: ACC_PUBLIC | ACC_BRIDGE | ACC_SYNTHETIC, name: "apply", descriptor: "(Ljava/lang/Object;)Ljava/lang/Object;" },
    ],
  });
  const formats = buildClass({
    access: ACC_PUBLIC | ACC_SUPER,
    name: "app/Formats",
    members: [
      { flags: ACC_PUBLIC | ACC_VARARGS, name: "<init>", descriptor: "([Ljava/lang/String;)V" },
      { flags: ACC_PUBLIC, name: "fill", descriptor: "([Ljava/lang/String;)V" },
    ],
  });

  const declaration = readClassFile(marker);
  assert.equal(declaration?.kind, "interface");
  assert.deepEqual(declaration?.members.map((member) => member.name), ["of", "render", "size"]);
  const [of, render, size] = declaration?.members ?? [];
  assert.equal(of?.static, true);
  assert.equal(of?.abstract, false);
  assert.equal(render?.static, false);
  assert.equal(render?.abstract, false);
  assert.equal(size?.abstract, true);
  assert.deepEqual(of?.parameters, ["java.lang.String"]);
  assert.equal(of?.returns, "java.lang.String");

  const [constructor, fill] = readClassFile(formats)?.members ?? [];
  assert.equal(constructor?.name, "<init>");
  assert.equal(constructor?.varargs, true);
  assert.deepEqual(constructor?.parameters, ["java.lang.String[]"]);
  assert.equal(constructor?.returns, "void");
  assert.equal(fill?.varargs, false);
});

test("a field states no member and does not hide the methods after it", () => {
  const bytes = buildClass({
    access: ACC_PUBLIC | ACC_SUPER,
    name: "app/Point",
    fields: [
      { flags: ACC_PUBLIC | ACC_FINAL, name: "x", descriptor: "I" },
      { flags: ACC_PRIVATE | ACC_STATIC, name: "origin", descriptor: "Lapp/Point;" },
    ],
    members: [{ flags: ACC_PUBLIC, name: "x", descriptor: "()I" }],
  });

  const declaration = readClassFile(bytes);
  assert.deepEqual(declaration?.members.map((member) => member.name), ["x"]);
  assert.equal(declaration?.members[0]?.returns, "int");
});

test("a generic class keeps its type variables in the supertypes and in its members' types", () => {
  const box = buildClass({
    access: ACC_PUBLIC | ACC_SUPER,
    name: "app/Box",
    superName: "java/util/AbstractList",
    interfaces: ["java/util/List"],
    signature: "<E:Ljava/lang/Object;>Ljava/util/AbstractList<TE;>;Ljava/util/List<TE;>;",
    members: [
      { flags: ACC_PUBLIC, name: "get", descriptor: "()Ljava/lang/Object;", signature: "()TE;" },
      { flags: ACC_PUBLIC, name: "put", descriptor: "(Ljava/lang/Object;)V", signature: "(TE;)V" },
      { flags: ACC_PUBLIC, name: "swap", descriptor: "(Ljava/util/List;Ljava/util/List;)V", signature: "(Ljava/util/List<TE;>;Ljava/util/List<+TE;>;)V" },
    ],
  });

  const declaration = readClassFile(box);
  assert.deepEqual(declaration?.typeParameters, ["E"]);
  assert.deepEqual(declaration?.supertypes, ["java.util.AbstractList<E>", "java.util.List<E>"]);
  assert.deepEqual(declaration?.members.map((member) => ({ parameters: member.parameters, returns: member.returns })), [
    { parameters: [], returns: "E" },
    { parameters: ["E"], returns: "void" },
    { parameters: ["java.util.List<E>", "java.util.List<? extends E>"], returns: "void" },
  ]);
});

test("a class file's kind comes from its flags and its Record attribute", () => {
  const noteSpec: ClassSpec = { access: ACC_PUBLIC | ACC_INTERFACE | ACC_ABSTRACT | ACC_ANNOTATION, name: "app/Note", interfaces: ["java/lang/annotation/Annotation"] };
  const portSpec: ClassSpec = { access: ACC_PUBLIC | ACC_INTERFACE | ACC_ABSTRACT, name: "app/Port" };
  const kinds: readonly (readonly [string, ClassSpec, string])[] = [
    ["annotation", noteSpec, "annotation"],
    ["enum", { access: ACC_PUBLIC | ACC_FINAL | ACC_SUPER | ACC_ENUM, name: "app/Kind", superName: "java/lang/Enum" }, "enum"],
    ["record", { access: ACC_PUBLIC | ACC_FINAL | ACC_SUPER, name: "app/Point", record: true }, "record"],
    ["interface", portSpec, "interface"],
    ["class", { access: ACC_PUBLIC | ACC_SUPER, name: "app/Impl" }, "class"],
  ];
  for (const [label, spec, expected] of kinds) assert.equal(readClassFile(buildClass(spec))?.kind, expected, label);

  assert.deepEqual(readClassFile(buildClass(noteSpec))?.supertypes, ["java.lang.annotation.Annotation"]);
  assert.deepEqual(readClassFile(buildClass(portSpec))?.supertypes, []);
});

test("a constant pool entry the decoder does not use is skipped by its stated size", () => {
  const bytes = buildClass({
    access: ACC_PUBLIC | ACC_SUPER,
    name: "app/Grown",
    members: [{ flags: ACC_PUBLIC, name: "size", descriptor: "()I" }],
    extra: [
      { tag: LONG_TAG, body: Buffer.concat([u32(0), u32(1)]) },
      { tag: INTEGER_TAG, body: u32(7) },
    ],
  });

  assert.deepEqual(readClassFile(bytes)?.members.map((member) => member.name), ["size"]);
});

test("a truncated or foreign class file states no declaration at all", () => {
  const bytes = buildClass({
    access: ACC_PUBLIC | ACC_SUPER,
    name: "app/Whole",
    members: [{ flags: ACC_PUBLIC, name: "size", descriptor: "()I" }],
    attributes: [{ name: "SourceFile", text: "Whole.java" }],
  });
  for (let cut = 0; cut < bytes.length; cut += 1) assert.equal(readClassFile(bytes.subarray(0, cut)), undefined, `a cut at ${cut}`);
  assert.equal(readClassFile(Buffer.from("not a class file")), undefined);
});

test("a member signature over a type variable the declaration does not state is erased", () => {
  const inner = buildClass({
    access: ACC_PUBLIC | ACC_SUPER,
    name: "app/Inner",
    members: [
      { flags: ACC_PUBLIC, name: "outer", descriptor: "()Ljava/lang/Object;", signature: "()TT;" },
      { flags: ACC_PUBLIC, name: "id", descriptor: "(Ljava/lang/Object;)Ljava/lang/Object;", signature: "<U:Ljava/lang/Object;>(TU;)TU;" },
    ],
  });

  const [outer, id] = readClassFile(inner)?.members ?? [];
  assert.deepEqual(outer?.typeParameters, []);
  assert.deepEqual(outer?.parameters, []);
  assert.equal(outer?.returns, "java.lang.Object");
  assert.deepEqual(id?.typeParameters, ["U"]);
  assert.deepEqual(id?.parameters, ["U"]);
  assert.equal(id?.returns, "U");
});

test("a synthetic class or a module states no declaration", () => {
  assert.equal(readClassFile(buildClass({ access: ACC_PUBLIC | ACC_SYNTHETIC, name: "app/Hidden" })), undefined);
  assert.equal(readClassFile(buildClass({ access: ACC_MODULE, name: "module-info", superName: null })), undefined);
});
