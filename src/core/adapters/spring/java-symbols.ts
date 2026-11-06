import type { Node } from "web-tree-sitter";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { charLiteralValue, integerLiteralValue, stringLiteralValue, type LiteralValue } from "./java-literals.ts";

const LIBRARY_ROOT = "(library)";

/** The sources of the repositories a snapshot depends on, under a root no repository path can have. */
export function asLibrarySources(sources: readonly SourceFile[]): SourceFile[] {
  return sources.map((source, index) => ({ ...source, path: `${LIBRARY_ROOT}/${index}/${source.path}` }));
}

export function isLibraryPath(path: string): boolean {
  return path.startsWith(`${LIBRARY_ROOT}/`);
}

export interface JavaFile {
  path: string;
  root: Node;
  packageName: string;
  /** Simple name to fully qualified name of each `import a.b.C;`. */
  singleImports: ReadonlyMap<string, string>;
  /** The package or type of each `import a.b.*;`. */
  onDemandImports: readonly string[];
  /** The class and member of each `import static a.b.C.NAME;`. */
  staticImports: readonly { className: string; member: string }[];
  /** The class of each `import static a.b.C.*;`. */
  staticOnDemandImports: readonly string[];
}

export type TypeKind = "class" | "interface" | "annotation" | "other";

export interface Scope {
  file: JavaFile;
  type: TypeDecl | undefined;
}

/** An expression and the scope its names are resolved in; a constant also carries the type its field declares. */
export interface Expr {
  node: Node;
  scope: Scope;
  declaredType?: string;
}

/** Why a construct yields no value: the sources do not decide it, or it is a form the extractor does not read. */
export type GapReason = "unresolved" | "no-extractor";

export interface Gap {
  reason: GapReason;
  file: JavaFile;
  node: Node;
}

export type Evaluation = { value: string } | { gap: GapReason };

/** A type, `"ambiguous"` when several files declare the name, or `undefined` when no source does. */
export type TypeLookup = TypeDecl | "ambiguous" | undefined;

/** A supertype the sources do not settle: declared by several files, or declared by none and not owned by the platform. */
export interface SupertypeGap {
  kind: "ambiguous" | "missing";
  isInterface: boolean;
  /** The type as written, without type arguments. */
  name: string;
  /** How many types precede it in the order Spring searches the hierarchy. */
  before: number;
  file: JavaFile;
  node: Node;
}

export interface Hierarchy {
  types: readonly TypeDecl[];
  gaps: readonly SupertypeGap[];
}

export interface MethodDecl {
  name: string;
  node: Node;
  owner: TypeDecl;
  parameterTypes: readonly string[];
  /** The type variables of the method and of the types around it: a parameter of one of them accepts any type. */
  typeVariables: ReadonlySet<string>;
  modifiers: readonly string[];
  overrides: boolean;
  hasBody: boolean;
}

export interface TypeDecl {
  /** With the package: `app.Outer.Inner`. */
  fqn: string;
  /** Without the package: `Outer.Inner`. */
  qualifiedName: string;
  name: string;
  kind: TypeKind;
  file: JavaFile;
  node: Node;
  isAbstract: boolean;
  typeVariables: ReadonlySet<string>;
  outer: TypeDecl | undefined;
  members: Map<string, TypeDecl>;
  constants: Map<string, Expr>;
  methods: MethodDecl[];
}

export interface JavaProject {
  types: readonly TypeDecl[];
  /** The files whose declarations could not be read; none of their types is in the project. */
  unreadable: readonly JavaFile[];
  lookupType(name: string, scope: Scope): TypeLookup;
  /**
   * Whether a name no source declares belongs to the platform: it sits under a platform package, and no package the
   * sources declare claims the segment after that prefix.
   */
  isPlatformName(fqn: string): boolean;
  /** The type, then each interface with its own hierarchy, then the superclass with its own: the order Spring searches. */
  hierarchy(type: TypeDecl): Hierarchy;
  /** The type and its superclasses declared in the project. */
  classChain(type: TypeDecl): readonly TypeDecl[];
  /** The string a constant expression evaluates to, or why the sources do not give it. */
  evaluate(expr: Expr): Evaluation;
  /** The decimal value of an integral constant expression, as a `long` annotation attribute holds it. */
  evaluateLong(expr: Expr): Evaluation;
}

const PLATFORM_PACKAGES = ["org.springframework.", "java.", "javax.", "jakarta.", "lombok."];
/** A package starts lowercase, so a qualified name whose first segment does is one. */
const PACKAGE_SEGMENT = /^[a-z]/;
const JAVA_LANG: ReadonlySet<string> = new Set([
  "Object",
  "Override",
  "Deprecated",
  "SuppressWarnings",
  "SafeVarargs",
  "FunctionalInterface",
  "Comparable",
  "Runnable",
  "Iterable",
  "AutoCloseable",
  "Cloneable",
  "CharSequence",
  "Appendable",
  "Readable",
]);

const TYPE_KINDS: Readonly<Record<string, TypeKind>> = {
  class_declaration: "class",
  interface_declaration: "interface",
  annotation_type_declaration: "annotation",
  enum_declaration: "other",
  record_declaration: "class",
};

/** A placeholder is resolved at run time; U+FFFD stands for source bytes that were not UTF-8. */
export const UNKNOWABLE_TEXT = /\$\{|#\{|\uFFFD/;

export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child) => !child.type.endsWith("_comment"));
}

export function scopeOf(type: TypeDecl): Scope {
  return { file: type.file, type };
}

export function describeFile(path: string, root: Node): JavaFile {
  const singleImports = new Map<string, string>();
  const onDemandImports: string[] = [];
  const staticImports: { className: string; member: string }[] = [];
  const staticOnDemandImports: string[] = [];
  let packageName = "";
  for (const child of namedChildren(root)) {
    if (child.type === "package_declaration") {
      packageName = child.namedChildren.find((part) => part.type.endsWith("identifier"))?.text ?? "";
    } else if (child.type === "import_declaration") {
      const name = child.namedChildren.find((part) => part.type.endsWith("identifier"))?.text;
      if (name === undefined) continue;
      const wildcard = child.namedChildren.some((part) => part.type === "asterisk");
      const isStatic = child.children.some((part) => part.type === "static");
      if (isStatic && wildcard) staticOnDemandImports.push(name);
      else if (isStatic) staticImports.push({ className: name.slice(0, name.lastIndexOf(".")), member: name.slice(name.lastIndexOf(".") + 1) });
      else if (wildcard) onDemandImports.push(name);
      else singleImports.set(name.slice(name.lastIndexOf(".") + 1), name);
    }
  }
  return { path, root, packageName, singleImports, onDemandImports, staticImports, staticOnDemandImports };
}

/**
 * The fully qualified names a type that no source declares may have, from the imports of the file that names it.
 * A name no import mentions may also be a type of the file's own package when `samePackage` holds.
 */
export function externalNames(name: string, file: JavaFile, samePackage: boolean): string[] {
  const head = name.split(".")[0] ?? "";
  const imported = file.singleImports.get(head);
  if (imported !== undefined) return [`${imported}${name.slice(head.length)}`];
  if (name.includes(".")) return [name];
  if (JAVA_LANG.has(name)) return [`java.lang.${name}`];
  const own = file.packageName === "" ? name : `${file.packageName}.${name}`;
  const wildcards = file.onDemandImports.map((container) => `${container}.${name}`);
  return samePackage || wildcards.length === 0 ? [...wildcards, own] : wildcards;
}

/**
 * The fully qualified name of a type the sources declare, or that a single import, a qualified name or `java.lang` names.
 * A qualified name starts with a package, lowercase by Java's naming convention. A name that starts with a type no import
 * names may be a type of the file's package or of a wildcard import, so it is not resolved.
 */
export function qualifiedTypeName(name: string, scope: Scope, project: JavaProject): string | undefined {
  const declared = project.lookupType(name, scope);
  if (declared !== undefined) return declared === "ambiguous" ? undefined : declared.fqn;
  const [candidate] = externalNames(name, scope.file, false);
  const head = name.split(".")[0] ?? "";
  const named = scope.file.singleImports.has(head) || (name.includes(".") && PACKAGE_SEGMENT.test(head)) || candidate === `java.lang.${name}`;
  return named ? candidate : undefined;
}

/** The platform prefix and its next segment, when a package the sources declare sits under a platform prefix. */
function claimedPlatformPackage(packageName: string): string | undefined {
  const prefix = PLATFORM_PACKAGES.find((candidate) => packageName.startsWith(candidate));
  const next = prefix === undefined ? undefined : packageName.slice(prefix.length).split(".")[0];
  return next ? `${prefix}${next}.` : undefined;
}

export function createJavaProject(files: readonly JavaFile[]): JavaProject {
  const types: TypeDecl[] = [];
  const unreadable: JavaFile[] = [];
  const namesToTypes = new Map<string, TypeDecl[]>();
  for (const file of files) {
    const declared: TypeDecl[] = [];
    try {
      declareTypes(file, declared);
    } catch {
      unreadable.push(file);
      continue;
    }
    for (const type of declared) {
      types.push(type);
      namesToTypes.set(type.fqn, [...(namesToTypes.get(type.fqn) ?? []), type]);
    }
  }

  const claimed = [...new Set(files.map((file) => claimedPlatformPackage(file.packageName)).filter((owned) => owned !== undefined))];

  function isPlatformName(fqn: string): boolean {
    return PLATFORM_PACKAGES.some((prefix) => fqn.startsWith(prefix)) && claimed.every((owned) => !fqn.startsWith(owned));
  }

  /** A name that two files declare (modules of one repository may) is not resolved: the sources do not say which is meant. */
  function byFqn(fqn: string): TypeLookup {
    const found = namesToTypes.get(fqn);
    return found === undefined ? undefined : found.length === 1 ? found[0] : "ambiguous";
  }

  function resolveSimple(head: string, scope: Scope): TypeLookup {
    for (let type = scope.type; type !== undefined; type = type.outer) {
      if (type.name === head) return type;
      const member = type.members.get(head);
      if (member !== undefined) return member;
    }
    const { file } = scope;
    const imported = file.singleImports.get(head);
    if (imported !== undefined) return byFqn(imported);
    const samePackage = byFqn(file.packageName === "" ? head : `${file.packageName}.${head}`);
    if (samePackage !== undefined) return samePackage;
    for (const container of file.onDemandImports) {
      const found = byFqn(`${container}.${head}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function lookupType(name: string, scope: Scope): TypeLookup {
    const [head = "", ...rest] = name.split(".");
    let type = resolveSimple(head, scope);
    if (type === "ambiguous") return type;
    for (const part of rest) type = type?.members.get(part);
    return type ?? byFqn(name);
  }

  function typeNodeName(node: Node): string {
    return (node.type === "generic_type" ? node.namedChildren[0] : node)?.text ?? "";
  }

  function interfaceNodes(type: TypeDecl): Node[] {
    const clause =
      type.kind === "interface"
        ? type.node.namedChildren.find((child) => child.type === "extends_interfaces")
        : type.node.childForFieldName("interfaces");
    const list = clause?.namedChildren.find((child) => child.type === "type_list");
    return list === undefined ? [] : namedChildren(list);
  }

  function superclassNode(type: TypeDecl): Node | undefined {
    return type.node.childForFieldName("superclass")?.namedChildren[0];
  }

  function superclassOf(type: TypeDecl): TypeDecl | undefined {
    const node = superclassNode(type);
    const found = node === undefined ? undefined : lookupType(typeNodeName(node), scopeOf(type));
    return typeof found === "object" ? found : undefined;
  }

  function supertypeGap(found: TypeLookup, node: Node, type: TypeDecl, isInterface: boolean, before: number): SupertypeGap | undefined {
    const name = typeNodeName(node);
    const gap = { isInterface, name, before, file: type.file, node };
    if (found === "ambiguous") return { ...gap, kind: "ambiguous" };
    return found === undefined && !externalNames(name, type.file, true).every(isPlatformName) ? { ...gap, kind: "missing" } : undefined;
  }

  function hierarchy(root: TypeDecl): Hierarchy {
    const members: TypeDecl[] = [];
    const gaps: SupertypeGap[] = [];
    const visited = new Set<TypeDecl>();
    const frames: { type: TypeDecl; parents: { node: Node; isInterface: boolean }[]; next: number }[] = [];
    function enter(type: TypeDecl): void {
      if (visited.has(type)) return;
      visited.add(type);
      members.push(type);
      const superclass = superclassNode(type);
      const parents = [
        ...interfaceNodes(type).map((node) => ({ node, isInterface: true })),
        ...(superclass === undefined ? [] : [{ node: superclass, isInterface: false }]),
      ];
      frames.push({ type, parents, next: 0 });
    }
    enter(root);
    for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
      const parent = frame.parents[frame.next++];
      if (parent === undefined) {
        frames.pop();
        continue;
      }
      const found = lookupType(typeNodeName(parent.node), scopeOf(frame.type));
      const gap = supertypeGap(found, parent.node, frame.type, parent.isInterface, members.length);
      if (gap !== undefined) gaps.push(gap);
      if (typeof found === "object") enter(found);
    }
    return { types: members, gaps };
  }

  function classChain(root: TypeDecl): TypeDecl[] {
    const chain: TypeDecl[] = [];
    for (let current: TypeDecl | undefined = root; current !== undefined && !chain.includes(current); current = superclassOf(current)) chain.push(current);
    return chain;
  }

  function constantIn(type: TypeDecl, name: string): Expr | undefined {
    for (const member of hierarchy(type).types) {
      const constant = member.constants.get(name);
      if (constant !== undefined) return constant;
    }
    return undefined;
  }

  function lookupConstant(name: string, scope: Scope): Expr | undefined {
    for (let type = scope.type; type !== undefined; type = type.outer) {
      const constant = constantIn(type, name);
      if (constant !== undefined) return constant;
    }
    const { file } = scope;
    const owners = [
      ...file.staticImports.filter((imported) => imported.member === name).map((imported) => imported.className),
      ...file.staticOnDemandImports,
    ];
    for (const owner of owners) {
      const type = byFqn(owner);
      const constant = typeof type === "object" ? constantIn(type, name) : undefined;
      if (constant !== undefined) return constant;
    }
    return undefined;
  }

  function lookupQualifiedConstant(qualifiedName: string, scope: Scope): Expr | undefined {
    const dot = qualifiedName.lastIndexOf(".");
    const type = lookupType(qualifiedName.slice(0, dot), scope);
    return typeof type === "object" ? constantIn(type, qualifiedName.slice(dot + 1)) : undefined;
  }

  /** A `+` chain and nested parentheses are walked with loops: a source file can make them arbitrarily deep. */
  function valueOf(expr: Expr, resolving: ReadonlySet<Node>): LiteralValue | GapReason {
    const { scope } = expr;
    const node = unwrapParentheses(expr.node);
    if (node === undefined) return "unresolved";
    switch (node.type) {
      case "string_literal": {
        const value = stringLiteralValue(node.text);
        return value === undefined || UNKNOWABLE_TEXT.test(value) ? "unresolved" : { type: "string", value };
      }
      case "character_literal": {
        const value = charLiteralValue(node.text);
        return value === undefined ? "unresolved" : { type: "char", value };
      }
      case "decimal_integer_literal":
      case "hex_integer_literal":
      case "octal_integer_literal":
      case "binary_integer_literal":
        return integerLiteralValue(node.text) ?? "unresolved";
      case "decimal_floating_point_literal":
      case "hex_floating_point_literal":
      case "true":
      case "false":
        return "no-extractor";
      case "binary_expression":
        return binaryValue(node, scope, resolving);
      case "unary_expression":
      case "cast_expression":
      case "ternary_expression": {
        const operands = ["operand", "value", "condition", "consequence", "alternative"].flatMap((field) => {
          const operand = node.childForFieldName(field);
          return operand === null ? [] : [valueOf({ node: operand, scope }, resolving)];
        });
        return operands.includes("unresolved") ? "unresolved" : "no-extractor";
      }
      case "identifier":
      case "field_access": {
        const constant = node.type === "identifier" ? lookupConstant(node.text, scope) : lookupQualifiedConstant(node.text, scope);
        if (constant === undefined || resolving.has(constant.node)) return "unresolved";
        const value = valueOf(constant, new Set(resolving).add(constant.node));
        return typeof value === "string" ? value : convertTo(constant.declaredType ?? "", value);
      }
      default:
        return "unresolved";
    }
  }

  function binaryValue(root: Node, scope: Scope, resolving: ReadonlySet<Node>): LiteralValue | GapReason {
    const operations: { operator: string | undefined; right: Node }[] = [];
    let operand = unwrapParentheses(root);
    while (operand?.type === "binary_expression") {
      const left = operand.childForFieldName("left");
      const right = operand.childForFieldName("right");
      if (left === null || right === null) {
        operand = undefined;
        break;
      }
      operations.push({ operator: operand.childForFieldName("operator")?.text, right });
      operand = unwrapParentheses(left);
    }
    let accumulated = operand === undefined ? "unresolved" : valueOf({ node: operand, scope }, resolving);
    for (const { operator, right } of operations.reverse()) accumulated = combine(accumulated, valueOf({ node: right, scope }, resolving), operator);
    return accumulated;
  }

  return {
    types,
    unreadable,
    lookupType,
    isPlatformName,
    hierarchy,
    classChain,
    evaluate(expr) {
      const value = valueOf(expr, new Set());
      if (typeof value === "string") return { gap: value };
      return value.type === "string" ? { value: value.value } : { gap: "unresolved" };
    },
    evaluateLong(expr) {
      const value = valueOf(expr, new Set());
      if (typeof value === "string") return { gap: value };
      return value.type === "string" ? { gap: "unresolved" } : { value: String(numericValue(value)) };
    },
  };
}

function unwrapParentheses(node: Node): Node | undefined {
  let current: Node | undefined = node;
  while (current?.type === "parenthesized_expression") current = namedChildren(current)[0];
  return current;
}

function combine(first: LiteralValue | GapReason, second: LiteralValue | GapReason, operator: string | undefined): LiteralValue | GapReason {
  if (typeof first === "string" || typeof second === "string") return first === "unresolved" || second === "unresolved" ? "unresolved" : "no-extractor";
  return operator === "+" ? add(first, second) : "no-extractor";
}

/** The value a constant of the declared type holds: Java converts the initializer to that type. */
function convertTo(declaredType: string, value: LiteralValue): LiteralValue | GapReason {
  switch (declaredType) {
    case "String":
      return value;
    case "int":
    case "short":
    case "byte":
      return { type: "int", value: numericValue(value) };
    case "long":
      return { type: "long", value: numericValue(value) };
    case "char":
      return { type: "char", value: String.fromCharCode(Number(numericValue(value))) };
    case "boolean":
    case "double":
    case "float":
      return "no-extractor";
    default:
      return "unresolved";
  }
}

/** Java's `+`: string conversion when either operand is a String, otherwise numeric promotion. */
function add(left: LiteralValue, right: LiteralValue): LiteralValue {
  if (left.type === "string" || right.type === "string") return { type: "string", value: stringConversion(left) + stringConversion(right) };
  const isLong = left.type === "long" || right.type === "long";
  const sum = numericValue(left) + numericValue(right);
  return { type: isLong ? "long" : "int", value: BigInt.asIntN(isLong ? 64 : 32, sum) };
}

function stringConversion(value: LiteralValue): string {
  return String(value.value);
}

function numericValue(value: LiteralValue): bigint {
  return value.type === "char" ? BigInt(value.value.charCodeAt(0)) : value.type === "string" ? 0n : value.value;
}

export type Counterpart = MethodDecl | "ambiguous" | undefined;

/**
 * The method of `type` that `method` overrides or is overridden by: same name and arity, told apart by parameter types.
 * Declarations that match only through a type variable and that several methods claim equally are `"ambiguous"`.
 */
export function counterpart(type: TypeDecl, method: MethodDecl): Counterpart {
  const compatibleWith = (candidates: readonly MethodDecl[], target: MethodDecl) =>
    candidates.filter((candidate) => candidate.name === target.name && sameParameters(candidate, target, parameterCompatible));
  const candidates = compatibleWith(type.methods, method);
  const exact = candidates.filter((candidate) => sameParameters(candidate, method, (a, _, b) => a === b));
  const chosen = exact.length > 0 ? exact : candidates;
  const [found] = chosen;
  if (chosen.length > 1) return "ambiguous";
  if (found === undefined || exact.length > 0) return found;
  const rivals = compatibleWith(
    method.owner.methods.filter((rival) => rival !== method),
    found,
  ).filter((rival) => !type.methods.some((other) => other !== found && sameParameters(other, rival, (a, _, b) => a === b)));
  if (rivals.some((rival) => sameParameters(rival, found, (a, _, b) => a === b))) return undefined;
  return rivals.length > 0 ? "ambiguous" : found;
}

function sameParameters(
  first: MethodDecl,
  second: MethodDecl,
  matches: (a: string, aVariables: ReadonlySet<string>, b: string, bVariables: ReadonlySet<string>) => boolean,
): boolean {
  return (
    first.parameterTypes.length === second.parameterTypes.length &&
    first.parameterTypes.every((parameter, index) => matches(parameter, first.typeVariables, second.parameterTypes[index] ?? "", second.typeVariables))
  );
}

function parameterCompatible(a: string, aVariables: ReadonlySet<string>, b: string, bVariables: ReadonlySet<string>): boolean {
  if (a === b) return true;
  const [elementA = "", dimensionsA = ""] = /^(.*?)((?:\[\])*)$/.exec(a)?.slice(1) ?? [];
  const [elementB = "", dimensionsB = ""] = /^(.*?)((?:\[\])*)$/.exec(b)?.slice(1) ?? [];
  return dimensionsA === dimensionsB && (aVariables.has(elementA) || bVariables.has(elementB));
}

/** Declares the types of a file and their members; a nested type waits on a stack, since nesting depth is the file's. */
function declareTypes(file: JavaFile, types: TypeDecl[]): void {
  const pending = namedChildren(file.root).map((node) => ({ node, outer: undefined as TypeDecl | undefined }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const type = describeType(file, next.node, next.outer);
    if (type === undefined) continue;
    types.push(type);
    next.outer?.members.set(type.name, type);
    const body = next.node.childForFieldName("body");
    const declarations = body === null ? [] : namedChildren(body).flatMap((child) => (child.type === "enum_body_declarations" ? namedChildren(child) : [child]));
    for (const declaration of declarations) {
      if (declaration.type === "field_declaration" || declaration.type === "constant_declaration") declareConstants(type, declaration);
      else if (declaration.type === "method_declaration") type.methods.push(describeMethod(type, declaration));
      else pending.push({ node: declaration, outer: type });
    }
  }
}

function describeType(file: JavaFile, node: Node, outer: TypeDecl | undefined): TypeDecl | undefined {
  const kind = TYPE_KINDS[node.type];
  const name = node.childForFieldName("name")?.text;
  if (kind === undefined || name === undefined) return undefined;
  const qualifiedName = outer === undefined ? name : `${outer.qualifiedName}.${name}`;
  return {
    fqn: file.packageName === "" ? qualifiedName : `${file.packageName}.${qualifiedName}`,
    qualifiedName,
    name,
    kind,
    file,
    node,
    isAbstract: modifierWords(node).includes("abstract"),
    typeVariables: new Set(typeVariablesOf(node)),
    outer,
    members: new Map(),
    constants: new Map(),
    methods: [],
  };
}

/** A `constant_declaration` is an interface field, which is implicitly static and final. */
function declareConstants(type: TypeDecl, field: Node): void {
  const modifiers = modifierWords(field);
  if (field.type === "field_declaration" && !(modifiers.includes("static") && modifiers.includes("final"))) return;
  const declaredType = field.childForFieldName("type")?.text ?? "";
  for (const declarator of field.childrenForFieldName("declarator")) {
    const name = declarator.childForFieldName("name")?.text;
    const value = declarator.childForFieldName("value");
    if (name !== undefined && value !== null) type.constants.set(name, { node: value, scope: scopeOf(type), declaredType });
  }
}

function describeMethod(owner: TypeDecl, node: Node): MethodDecl {
  const parameters = node.childForFieldName("parameters");
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  return {
    name: node.childForFieldName("name")?.text ?? "",
    node,
    owner,
    parameterTypes: (parameters === null ? [] : namedChildren(parameters)).map(parameterType),
    typeVariables: new Set([...owner.typeVariables, ...typeVariablesOf(node)]),
    modifiers: modifierWords(node),
    overrides: modifiers?.namedChildren.some((child) => child.type === "marker_annotation" && child.childForFieldName("name")?.text.endsWith("Override")) ?? false,
    hasBody: node.childForFieldName("body") !== null,
  };
}

function typeVariablesOf(declaration: Node): string[] {
  const parameters = declaration.childForFieldName("type_parameters");
  return (parameters?.namedChildren ?? []).flatMap((parameter) => parameter.namedChildren[0]?.text ?? []);
}

function parameterType(parameter: Node): string {
  const type = parameter.childForFieldName("type") ?? parameter.namedChildren.find((child) => child.type.endsWith("type") || child.type.endsWith("identifier"));
  let text = type?.text ?? "";
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/<[^<>]*>/g, "");
  }
  const erased = text.replace(/\s+/g, "").split(".").pop() ?? "";
  return parameter.type === "spread_parameter" ? `${erased}[]` : erased;
}

function modifierWords(declaration: Node): string[] {
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  return modifiers === undefined ? [] : modifiers.children.filter((child) => !child.isNamed).map((child) => child.text);
}
