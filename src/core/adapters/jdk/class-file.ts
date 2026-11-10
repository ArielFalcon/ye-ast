/**
 * Decodes one Java class file (or one `ct.sym` `.sig`, which is a class file without method bodies) into the declaration
 * ADR-0044 decision 10 needs: the type's kind, its `ACC_ABSTRACT` flag, its type parameters and direct supertypes, and
 * the public and protected methods with their generic signatures and their `ACC_STATIC`, `ACC_ABSTRACT` and
 * `ACC_VARARGS` flags (JVMS 4.6). Bridge and synthetic methods are left out.
 *
 * Every type is rendered in Java source form with fully qualified names and the type variables the signature keeps:
 * `java.util.List<T>`, `int`, `java.lang.String[]`, `? extends java.lang.Number`. A member's signature is used only
 * while every type variable it names is declared by the class or by the member itself; a signature that names an
 * undeclared variable (an inner class's artifact) keeps the descriptor's erased types instead. A file this reader cannot
 * state in full answers `undefined`, never a partial declaration.
 */

export interface ClassMember {
  name: string;
  typeParameters: readonly string[];
  /** Parameter and return types as the generic signature writes them, erased when no signature attribute exists. */
  parameters: readonly string[];
  returns: string;
  static: boolean;
  abstract: boolean;
  varargs: boolean;
}

export interface ClassDeclaration {
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  fqn: string;
  abstract: boolean;
  typeParameters: readonly string[];
  supertypes: readonly string[];
  members: readonly ClassMember[];
}

/** One class file's declaration; `undefined` when a flag (bridge, synthetic) or an unsupported attribute excludes it. */
export function readClassFile(bytes: Buffer): ClassDeclaration | undefined {
  try {
    return decode(bytes);
  } catch (error) {
    if (error instanceof ClassFileFault) return undefined;
    throw error;
  }
}

const MAGIC = 0xcafebabe;
const ACC_PUBLIC = 0x0001;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_BRIDGE = 0x0040;
const ACC_VARARGS = 0x0080;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_SYNTHETIC = 0x1000;
const ACC_ANNOTATION = 0x2000;
const ACC_ENUM = 0x4000;
const ACC_MODULE = 0x8000;

const UTF8_TAG = 1;
const INTEGER_TAG = 3;
const FLOAT_TAG = 4;
const LONG_TAG = 5;
const DOUBLE_TAG = 6;
const CLASS_TAG = 7;
const STRING_TAG = 8;
const METHOD_HANDLE_TAG = 15;
const METHOD_TYPE_TAG = 16;
const DYNAMIC_TAG = 17;
const INVOKE_DYNAMIC_TAG = 18;
const MODULE_TAG = 19;
const PACKAGE_TAG = 20;
/** The tags whose two `u2` fields are the whole entry: Fieldref, Methodref, InterfaceMethodref, NameAndType, the two Dynamic forms. */
const PAIR_TAGS: ReadonlySet<number> = new Set([9, 10, 11, 12, DYNAMIC_TAG, INVOKE_DYNAMIC_TAG]);

const SIGNATURE_ATTRIBUTE = "Signature";
const RECORD_ATTRIBUTE = "Record";

const BASE_TYPES: Readonly<Record<string, string>> = {
  B: "byte",
  C: "char",
  D: "double",
  F: "float",
  I: "int",
  J: "long",
  S: "short",
  Z: "boolean",
  V: "void",
};

/** Nested generic arguments beyond this depth are refused; a class name of the JDK never reaches it. */
const MAX_SIGNATURE_DEPTH = 64;

/** A class file this reader cannot state in full; caught at the boundary, which answers `undefined`. */
class ClassFileFault extends Error {
  constructor(readonly kind: "truncated" | "unsupported") {
    super(kind);
  }
}

function fault(kind: "truncated" | "unsupported" = "unsupported"): never {
  throw new ClassFileFault(kind);
}

type PoolEntry = { kind: "utf8"; text: string } | { kind: "class"; nameIndex: number };

/** One type parameter as the signature states it: its name and its rendered declaration. */
interface ParsedTypeParameter {
  name: string;
  text: string;
}

interface MethodSignatureText {
  typeParameters: readonly ParsedTypeParameter[];
  parameters: readonly string[];
  returns: string;
  variables: ReadonlySet<string>;
}

interface ClassSignatureText {
  typeParameters: readonly ParsedTypeParameter[];
  superclass: string;
  superinterfaces: readonly string[];
}

function decode(bytes: Buffer): ClassDeclaration {
  const cursor = new Cursor(bytes);
  if (cursor.u4() !== MAGIC) fault();
  cursor.u2();
  cursor.u2();
  const pool = readPool(cursor);
  const access = cursor.u2();
  if ((access & (ACC_MODULE | ACC_SYNTHETIC)) !== 0) fault();
  const fqn = classNameOf(pool, cursor.u2());
  const superIndex = cursor.u2();
  const superName = superIndex === 0 ? undefined : classNameOf(pool, superIndex);
  const interfaces = readClassNames(cursor, pool);
  skipFields(cursor, pool);
  const methods = readMethods(cursor, pool);
  const attributes = readAttributes(cursor, pool, [SIGNATURE_ATTRIBUTE, RECORD_ATTRIBUTE]);

  const stated = attributes.get(SIGNATURE_ATTRIBUTE);
  const classSignature = stated === undefined ? undefined : parseClassSignature(attributeText(pool, stated));
  const declared = new Set((classSignature?.typeParameters ?? []).map((parameter) => parameter.name));
  const kind = kindOf(access, attributes.has(RECORD_ATTRIBUTE));
  return {
    kind,
    fqn,
    abstract: (access & ACC_ABSTRACT) !== 0,
    typeParameters: (classSignature?.typeParameters ?? []).map((parameter) => parameter.text),
    supertypes: supertypesOf(kind, superName, interfaces, classSignature),
    members: methods.map((method) => memberOf(method, declared)),
  };
}

function kindOf(access: number, record: boolean): ClassDeclaration["kind"] {
  if ((access & ACC_ANNOTATION) !== 0) return "annotation";
  if ((access & ACC_ENUM) !== 0) return "enum";
  if (record) return "record";
  if ((access & ACC_INTERFACE) !== 0) return "interface";
  return "class";
}

/**
 * The direct supertypes: the superclass first, then the declared interfaces. An interface's class file names
 * `java.lang.Object` as its superclass, which is no superinterface, so it is left out there; the generic class signature
 * is used only while it states as many supertypes as the descriptor does.
 */
function supertypesOf(
  kind: ClassDeclaration["kind"],
  superName: string | undefined,
  interfaces: readonly string[],
  signature: ClassSignatureText | undefined,
): readonly string[] {
  const erased = [...(superName === undefined ? [] : [superName]), ...interfaces];
  const stated = signature === undefined ? undefined : [signature.superclass, ...signature.superinterfaces];
  if (stated !== undefined && stated.length !== erased.length) fault();
  const chosen = stated ?? erased;
  return kind === "interface" || kind === "annotation" ? chosen.slice(1) : chosen;
}

interface RawMember {
  flags: number;
  name: string;
  descriptor: string;
  signature: string | undefined;
}

/** The field table: a field states no member of the declaration, and its structure is skipped whole. */
function skipFields(cursor: Cursor, pool: readonly (PoolEntry | undefined)[]): void {
  const count = cursor.u2();
  for (let index = 0; index < count; index += 1) {
    cursor.u2();
    cursor.u2();
    cursor.u2();
    readAttributes(cursor, pool, []);
  }
}

function readMethods(cursor: Cursor, pool: readonly (PoolEntry | undefined)[]): readonly RawMember[] {
  const count = cursor.u2();
  const methods: RawMember[] = [];
  for (let index = 0; index < count; index += 1) {
    const flags = cursor.u2();
    const name = utf8Of(pool, cursor.u2());
    const descriptor = utf8Of(pool, cursor.u2());
    const attributes = readAttributes(cursor, pool, [SIGNATURE_ATTRIBUTE]);
    if ((flags & (ACC_PUBLIC | ACC_PROTECTED)) === 0) continue;
    if ((flags & (ACC_BRIDGE | ACC_SYNTHETIC)) !== 0) continue;
    const signature = attributes.has(SIGNATURE_ATTRIBUTE) ? attributeText(pool, attributes.get(SIGNATURE_ATTRIBUTE)!) : undefined;
    methods.push({ flags, name, descriptor, signature });
  }
  return methods;
}

/**
 * One method: its flags from the access flags and the descriptor's last parameter shape, and its types from the generic
 * signature while every variable it names is declared; otherwise the descriptor's erased types, signature discarded.
 */
function memberOf(method: RawMember, classVariables: ReadonlySet<string>): ClassMember {
  const erased = parseMethodDescriptor(method.descriptor);
  const declaredVarargs = (method.flags & ACC_VARARGS) !== 0;
  if (declaredVarargs && !erased.lastParameterArray) fault();
  const flags = {
    name: method.name,
    static: (method.flags & ACC_STATIC) !== 0,
    abstract: (method.flags & ACC_ABSTRACT) !== 0,
    varargs: declaredVarargs,
  };
  if (method.signature === undefined) return { ...flags, typeParameters: [], parameters: erased.parameters, returns: erased.returns };
  const generic = parseMethodSignature(method.signature);
  const declared = new Set([...classVariables, ...generic.typeParameters.map((parameter) => parameter.name)]);
  if ([...generic.variables].some((variable) => !declared.has(variable))) return { ...flags, typeParameters: [], parameters: erased.parameters, returns: erased.returns };
  return {
    ...flags,
    typeParameters: generic.typeParameters.map((parameter) => parameter.text),
    parameters: generic.parameters,
    returns: generic.returns,
  };
}

function readClassNames(cursor: Cursor, pool: readonly (PoolEntry | undefined)[]): readonly string[] {
  const count = cursor.u2();
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) names.push(classNameOf(pool, cursor.u2()));
  return names;
}

function readPool(cursor: Cursor): readonly (PoolEntry | undefined)[] {
  const count = cursor.u2();
  const entries: (PoolEntry | undefined)[] = [undefined];
  for (let index = 1; index < count; index += 1) {
    const tag = cursor.u1();
    if (tag === UTF8_TAG) {
      const length = cursor.u2();
      entries[index] = { kind: "utf8", text: cursor.text(length) };
    } else if (tag === CLASS_TAG) {
      entries[index] = { kind: "class", nameIndex: cursor.u2() };
    } else if (tag === LONG_TAG || tag === DOUBLE_TAG) {
      cursor.skip(8);
      index += 1;
    } else if (tag === INTEGER_TAG || tag === FLOAT_TAG) {
      cursor.skip(4);
    } else if (tag === STRING_TAG || tag === METHOD_TYPE_TAG || tag === MODULE_TAG || tag === PACKAGE_TAG) {
      cursor.skip(2);
    } else if (tag === METHOD_HANDLE_TAG) {
      cursor.skip(3);
    } else if (PAIR_TAGS.has(tag)) {
      cursor.skip(4);
    } else {
      fault();
    }
  }
  return entries;
}

/** The attribute bodies the caller named, in the order the file states them; every other attribute is skipped by its length. */
function readAttributes(cursor: Cursor, pool: readonly (PoolEntry | undefined)[], wanted: readonly string[]): ReadonlyMap<string, Buffer> {
  const count = cursor.u2();
  const found = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    const name = utf8Of(pool, cursor.u2());
    const length = cursor.u4();
    const body = cursor.bytes(length);
    if (!wanted.includes(name)) continue;
    if (found.has(name)) fault();
    found.set(name, body);
  }
  return found;
}

/** The one constant pool index a `Signature` attribute states. */
function attributeText(pool: readonly (PoolEntry | undefined)[], body: Buffer): string {
  const cursor = new Cursor(body);
  const text = utf8Of(pool, cursor.u2());
  if (cursor.remaining() !== 0) fault();
  return text;
}

function utf8Of(pool: readonly (PoolEntry | undefined)[], index: number): string {
  const entry = pool[index];
  if (entry?.kind !== "utf8") fault();
  return entry.text;
}

function classNameOf(pool: readonly (PoolEntry | undefined)[], index: number): string {
  const entry = pool[index];
  if (entry?.kind !== "class") fault();
  return internalToSource(utf8Of(pool, entry.nameIndex));
}

/** A binary name as Java source writes it: `java/util/Map$Entry` is `java.util.Map.Entry`. */
function internalToSource(name: string): string {
  return name.replaceAll("/", ".").replaceAll("$", ".");
}

/** The bytes of one class file, read forward; every read is bounded by the file's own length. */
class Cursor {
  private at = 0;

  constructor(private readonly source: Buffer) {}

  remaining(): number {
    return this.source.length - this.at;
  }

  u1(): number {
    if (this.at + 1 > this.source.length) fault("truncated");
    const value = this.source.readUInt8(this.at);
    this.at += 1;
    return value;
  }

  u2(): number {
    if (this.at + 2 > this.source.length) fault("truncated");
    const value = this.source.readUInt16BE(this.at);
    this.at += 2;
    return value;
  }

  u4(): number {
    if (this.at + 4 > this.source.length) fault("truncated");
    const value = this.source.readUInt32BE(this.at);
    this.at += 4;
    return value;
  }

  skip(length: number): void {
    this.bytes(length);
  }

  /** A window into the file, never a copy: a length beyond the file is a cut. */
  bytes(length: number): Buffer {
    if (length > this.remaining()) fault("truncated");
    const window = this.source.subarray(this.at, this.at + length);
    this.at += length;
    return window;
  }

  text(length: number): string {
    return this.bytes(length).toString("utf8");
  }
}

/** One type over the descriptor grammar: `int`, `java.lang.String`, `java.lang.String[]`. */
function descriptorType(cursor: TextCursor, depth: number): string {
  if (depth > MAX_SIGNATURE_DEPTH) fault();
  const tag = cursor.take();
  const base = BASE_TYPES[tag];
  if (base !== undefined) return base;
  if (tag === "[") return `${descriptorType(cursor, depth + 1)}[]`;
  if (tag !== "L") fault();
  const name = internalToSource(cursor.until(";"));
  cursor.expect(";");
  return name;
}

function parseMethodDescriptor(text: string): { parameters: readonly string[]; returns: string; lastParameterArray: boolean } {
  const cursor = new TextCursor(text);
  cursor.expect("(");
  const parameters: string[] = [];
  let lastParameterArray = false;
  while (cursor.peek() !== ")") {
    lastParameterArray = cursor.peek() === "[";
    parameters.push(descriptorType(cursor, 0));
  }
  cursor.expect(")");
  const returns = descriptorType(cursor, 0);
  if (!cursor.done()) fault();
  return { parameters, returns, lastParameterArray: parameters.length > 0 && lastParameterArray };
}

/**
 * One type over the signature grammar (JVMS 4.7.9.1), rendered in Java source form; every type variable it names is
 * collected in `variables`, so the caller can tell a signature that belongs to this declaration from an inner artifact.
 */
function signatureType(cursor: TextCursor, variables: Set<string>, depth: number): string {
  if (depth > MAX_SIGNATURE_DEPTH) fault();
  const tag = cursor.peek();
  if (tag === "[") {
    cursor.take();
    return `${signatureType(cursor, variables, depth + 1)}[]`;
  }
  if (tag === "T") {
    cursor.take();
    const variable = cursor.until(";");
    cursor.expect(";");
    variables.add(variable);
    return variable;
  }
  if (tag !== "L") {
    const base = BASE_TYPES[cursor.take()];
    if (base === undefined) fault();
    return base;
  }
  cursor.take();
  return classType(cursor, variables, depth);
}

/** A class type signature: its package, its simple name, its arguments, and the `.` suffixes of a nested type. */
function classType(cursor: TextCursor, variables: Set<string>, depth: number): string {
  let name = internalToSource(cursor.until(".;<>"));
  if (cursor.peek() === "<") name += typeArguments(cursor, variables, depth);
  while (cursor.peek() === ".") {
    cursor.take();
    name += `.${cursor.until(".;<>")}`;
    if (cursor.peek() === "<") name += typeArguments(cursor, variables, depth);
  }
  cursor.expect(";");
  return name;
}

function typeArguments(cursor: TextCursor, variables: Set<string>, depth: number): string {
  cursor.expect("<");
  const arguments_: string[] = [];
  while (cursor.peek() !== ">") {
    const marker = cursor.peek();
    if (marker === "*") {
      cursor.take();
      arguments_.push("?");
    } else if (marker === "+" || marker === "-") {
      cursor.take();
      arguments_.push(`? ${marker === "+" ? "extends" : "super"} ${signatureType(cursor, variables, depth + 1)}`);
    } else {
      arguments_.push(signatureType(cursor, variables, depth + 1));
    }
  }
  cursor.expect(">");
  return `<${arguments_.join(", ")}>`;
}

/** The type parameters a signature states, each with its bounds; an `Object`-only bound is not written. */
function readTypeParameters(cursor: TextCursor, variables: Set<string>, depth: number): readonly ParsedTypeParameter[] {
  const parameters: ParsedTypeParameter[] = [];
  if (cursor.done() || cursor.peek() !== "<") return parameters;
  cursor.expect("<");
  while (cursor.peek() !== ">") {
    const name = cursor.until(":");
    cursor.expect(":");
    const bounds: string[] = [];
    if (cursor.peek() !== ":") bounds.push(signatureType(cursor, variables, depth + 1));
    while (cursor.peek() === ":") {
      cursor.take();
      bounds.push(signatureType(cursor, variables, depth + 1));
    }
    parameters.push({ name, text: renderTypeParameter(name, bounds) });
  }
  cursor.expect(">");
  return parameters;
}

function renderTypeParameter(name: string, bounds: readonly string[]): string {
  if (bounds.length === 0 || (bounds.length === 1 && bounds[0] === "java.lang.Object")) return name;
  return `${name} extends ${bounds.join(" & ")}`;
}

function parseMethodSignature(text: string): MethodSignatureText {
  const cursor = new TextCursor(text);
  const variables = new Set<string>();
  const typeParameters = readTypeParameters(cursor, variables, 0);
  cursor.expect("(");
  const parameters: string[] = [];
  while (cursor.peek() !== ")") parameters.push(signatureType(cursor, variables, 0));
  cursor.expect(")");
  const returns = signatureType(cursor, variables, 0);
  while (!cursor.done() && cursor.peek() === "^") {
    cursor.take();
    signatureType(cursor, variables, 0);
  }
  if (!cursor.done()) fault();
  return { typeParameters, parameters, returns, variables };
}

function parseClassSignature(text: string): ClassSignatureText {
  const cursor = new TextCursor(text);
  const variables = new Set<string>();
  const typeParameters = readTypeParameters(cursor, variables, 0);
  const superclass = signatureType(cursor, variables, 0);
  const superinterfaces: string[] = [];
  while (!cursor.done()) superinterfaces.push(signatureType(cursor, variables, 0));
  const declared = new Set(typeParameters.map((parameter) => parameter.name));
  if ([...variables].some((variable) => !declared.has(variable))) fault();
  return { typeParameters, superclass, superinterfaces };
}

/** One signature or descriptor, read forward; a read past its end or an unexpected character is a fault. */
class TextCursor {
  private at = 0;

  constructor(private readonly text: string) {}

  done(): boolean {
    return this.at >= this.text.length;
  }

  peek(): string {
    if (this.done()) fault();
    return this.text[this.at]!;
  }

  take(): string {
    const character = this.peek();
    this.at += 1;
    return character;
  }

  expect(character: string): void {
    if (this.take() !== character) fault();
  }

  /** The run of characters before one of `stop`, which is left unread. */
  until(stop: string): string {
    const start = this.at;
    while (this.at < this.text.length && !stop.includes(this.text[this.at]!)) this.at += 1;
    if (this.at === start) fault();
    return this.text.slice(start, this.at);
  }
}
