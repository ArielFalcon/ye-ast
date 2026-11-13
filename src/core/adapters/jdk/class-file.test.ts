import { test } from "node:test";
import assert from "node:assert/strict";
import { readClassFile } from "./class-file.ts";
import { ACC_ABSTRACT, ACC_ANNOTATION, ACC_BRIDGE, ACC_ENUM, ACC_FINAL, ACC_INTERFACE, ACC_MODULE, ACC_PRIVATE, ACC_PUBLIC, ACC_STATIC, ACC_SUPER, ACC_SYNTHETIC, ACC_VARARGS, INTEGER_TAG, LONG_TAG, MAGIC, MAJOR, buildClass, u16, u32, u8, type ClassSpec, type FieldSpec, type MemberSpec } from "./class-file.testing.ts";

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

test("a class whose pool names its own class before the name reads the same declaration", () => {
  const name = Buffer.from("Probe", "utf8");
  const pool = Buffer.concat([
    u16(3),
    Buffer.concat([u8(7), u16(2)]),
    Buffer.concat([u8(1), u16(name.length), name]),
  ]);
  const bytes = Buffer.concat([
    u32(MAGIC), u16(0), u16(MAJOR), pool,
    u16(ACC_PUBLIC | ACC_SUPER), u16(1), u16(0), u16(0), u16(0), u16(0), u16(0),
  ]);
  const declaration = readClassFile(bytes);
  assert.equal(declaration?.fqn, "Probe");
  assert.equal(declaration?.kind, "class");
  assert.deepEqual(declaration?.supertypes, []);
});
