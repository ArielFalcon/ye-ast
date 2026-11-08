import { LIBRARY_ROOT, libraryPath, type LibrarySource } from "../../domain/topology/library-source.ts";
import type { Node } from "web-tree-sitter";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { charLiteralValue, integerLiteralValue, stringLiteralValue, type LiteralValue } from "./java-literals.ts";
import { localBinding } from "../tree-sitter/java-function-value-calls.ts";
import { PLATFORM_TYPE_NAMES } from "./java-platform-type-names.ts";

/** The sources of the repositories a snapshot depends on, under a root no repository path can have. */
export function asLibrarySources(sources: readonly LibrarySource[]): SourceFile[] {
  return sources.map(({ repo, path, content }) => ({ path: libraryPath(repo, path), content }));
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
  conflictingSingleImports: ReadonlySet<string>;
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
  /** The place a name is read at, when there is one: a class an enclosing block declares before it is in scope there. */
  at?: Node;
}

/** A class, interface, enum or record a block declares (JLS 14.3), which no project type stands for. */
export interface LocalType {
  local: Node;
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
  constructors: MethodDecl[];
}

export interface JavaProject {
  types: readonly TypeDecl[];
  /** The files whose declarations could not be read; none of their types is in the project. */
  unreadable: readonly JavaFile[];
  lookupType(name: string, scope: Scope): TypeLookup;
  /** Signature identity: a declaration name or an equal unresolved context; no target or external proof. */
  typeIdentity(name: string, scope: Scope): string | undefined;
  /**
   * The type a simple name denotes in a scope, in Java's order (JLS 6.4): a local type an enclosing block declares before
   * the scope's place, a member type of a type around it, declared or inherited, then a single-type import, the scope's
   * package and an on-demand import. `lenient` reads the imports as `lookupType` does; `strict` answers `unsettled`
   * where the snapshot cannot exclude another meaning: a supertype it does not declare may declare a member type of the
   * name, a static import may import one, a member type shadows a single-type import of the name, or no single on-demand
   * import is the only one that can offer it.
   */
  bindName(name: string, scope: Scope, reading: "strict" | "lenient"): TypeLookup | "unsettled" | LocalType;
  /**
   * Whether a name no source declares belongs to the platform: it sits under a platform package, and no package the
   * sources declare claims the segment after that prefix.
   */
  isPlatformName(fqn: string): boolean;
  /** The type, its interfaces and superclass in Spring order; a supplied parent resolver leaves every unread parent as a gap. */
  hierarchy(type: TypeDecl, resolveParent?: (node: Node, owner: TypeDecl) => TypeLookup): Hierarchy;
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
  const conflictingSingleImports = new Set<string>();
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
      else {
        const simple = name.slice(name.lastIndexOf(".") + 1);
        if (singleImports.has(simple) && singleImports.get(simple) !== name) conflictingSingleImports.add(simple);
        singleImports.set(simple, name);
      }
    }
  }
  return { path, root, packageName, singleImports, conflictingSingleImports, onDemandImports, staticImports, staticOnDemandImports };
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

  const packages = new Set<string>();
  for (const name of [...files.map((file) => file.packageName), ...PLATFORM_TYPE_NAMES.keys()]) {
    const parts = name.split(".");
    for (let end = 1; end <= parts.length; end++) if (parts[0] !== "") packages.add(parts.slice(0, end).join("."));
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

  function lexicalType(head: string, scope: Scope, strict: boolean, conflict = true): TypeLookup | "unsettled" | LocalType {
    const inside = scope.at === undefined ? undefined : boundInside(head, scope.at, scope, strict);
    if (inside !== undefined) return inside;
    const { file } = scope;
    for (let type = scope.type; type !== undefined; type = type.outer) {
      const member = type.members.get(head) ?? inheritedMember(type, head, strict);
      if (member !== undefined) return conflict && strict && typeof member === "object" && file.singleImports.has(head) ? "unsettled" : member;
      if (type.name === head) return type;
    }
    return undefined;
  }

  function resolveSimple(head: string, scope: Scope, strict: boolean): TypeLookup | "unsettled" | LocalType {
    if (strict && scope.file.conflictingSingleImports.has(head)) return "unsettled";
    const lexical = lexicalType(head, scope, strict);
    if (lexical !== undefined) return lexical;
    const { file } = scope;
    if (strict && (file.staticImports.some(({ member }) => member === head) || file.staticOnDemandImports.length > 0)) return "unsettled";
    const imported = file.singleImports.get(head);
    if (imported !== undefined) return byFqn(imported);
    const samePackage = byFqn(file.packageName === "" ? head : `${file.packageName}.${head}`);
    if (samePackage !== undefined) return samePackage;
    const offered = file.onDemandImports.map((container) => byFqn(`${container}.${head}`));
    if (!strict) return offered.find((found) => found !== undefined);
    if (offered.length === 0) return undefined;
    if (offered.includes("ambiguous")) return "ambiguous";
    const found = offered.filter((type): type is TypeDecl => type !== undefined);
    const repositoryPackage = (container: string): boolean => types.some((type) => type.file.packageName === container);
    return found.length === 1 && file.onDemandImports.every((container, index) => offered[index] !== undefined || repositoryPackage(container)) ? found[0] : "unsettled";
  }

  function typeIdentity(name: string, scope: Scope): string | undefined {
    const [head = "", ...rest] = name.split(".");
    if (rest.length > 0 && scope.at !== undefined && typeVariableAround(scope.at, head) !== undefined) return undefined;
    const { file } = scope;
    const direct = file.singleImports.get(head);
    if (file.conflictingSingleImports.has(head) || (direct !== undefined && types.some((type) => type.file === file && type.outer === undefined && type.name === head && type.fqn !== direct))) return undefined;
    const lexical = lexicalType(head, scope, true, false);
    if (lexical !== undefined) {
      if (typeof lexical !== "object" || "local" in lexical) return undefined;
      return memberIdentity(lexical, rest);
    }
    const statics = file.staticImports.filter(({ member }) => member === head);
    if (direct !== undefined || statics.length > 0) {
      const unit = types.filter((type) => type.file === file && type.outer === undefined && type.name === head);
      const choices = [
        ...(direct === undefined ? [] : [qualifiedIdentity(direct)]),
        ...statics.map(({ className }) => demandIdentity(className, head, true)),
      ];
      if (unit.some((type) => choices.some((choice) => choice !== type.fqn))) return undefined;
      const identity = uniqueIdentity(choices);
      return identity === undefined || identity === "" ? undefined : extendIdentity(identity, rest);
    }
    const own = byFqn(file.packageName === "" ? head : `${file.packageName}.${head}`);
    if (own !== undefined) return typeof own === "object" ? memberIdentity(own, rest) : undefined;
    const offers = [
      ...[...new Set(["java.lang", ...file.onDemandImports])].map((container) => demandIdentity(container, head, false)),
      ...file.staticOnDemandImports.map((container) => demandIdentity(container, head, true)),
    ];
    if (new Set(offers.filter((offer) => offer !== undefined && offer !== "")).size > 1) return undefined;
    if (offers.includes(undefined)) return rest.length === 0
      ? `context:${file.packageName}|${[...file.onDemandImports].sort().join(",")}|${[...file.staticOnDemandImports].sort().join(",")}|${head}`
      : undefined;
    const identity = uniqueIdentity(offers.filter((offer) => offer !== ""));
    if (identity !== undefined) return extendIdentity(identity, rest);
    return rest.length === 0 ? `context:${file.packageName}|${head}` : qualifiedIdentity(name);
  }

  function uniqueIdentity(identities: readonly (string | undefined)[]): string | undefined {
    return identities.length > 0 && identities[0] !== undefined && identities.every((identity) => identity === identities[0]) ? identities[0] : undefined;
  }

  /** An absolute name: packages until a declared type is reached, then member types only (JLS 6.5.4-5). */
  function qualifiedIdentity(name: string): string | undefined {
    const parts = name.split(".");
    let prefix = "";
    for (const [index, part] of parts.entries()) {
      const qualified = prefix === "" ? part : `${prefix}.${part}`;
      const declared = prefix === "" ? undefined : byFqn(qualified);
      if (declared !== undefined) return typeof declared === "object" && !packages.has(qualified) ? memberIdentity(declared, parts.slice(index + 1)) : undefined;
      if (PLATFORM_TYPE_NAMES.get(prefix)?.has(part) && isPlatformName(qualified)) return index === parts.length - 1 ? qualified : undefined;
      if (!packages.has(qualified)) return undefined;
      prefix = qualified;
    }
    return undefined;
  }

  function extendIdentity(identity: string, rest: readonly string[]): string | undefined {
    const type = byFqn(identity);
    return typeof type === "object" ? memberIdentity(type, rest) : rest.length === 0 ? identity : undefined;
  }

  function memberIdentity(type: TypeDecl, rest: readonly string[]): string | undefined {
    if (rest.length === 0) return type.fqn;
    const [head = "", ...tail] = rest;
    const member = type.members.get(head) ?? inheritedMember(type, head, true);
    return typeof member === "object" ? memberIdentity(member, tail) : undefined;
  }

  /** Empty means a known supplier has no such type; undefined means its declarations are unknown. */
  function demandIdentity(container: string, name: string, onlyStatic: boolean): string | undefined {
    const declaredOwner = byFqn(container);
    const canonical = declaredOwner === undefined ? qualifiedIdentity(container) : undefined;
    const owner = declaredOwner ?? (canonical === undefined ? undefined : byFqn(canonical));
    if (owner !== undefined) {
      if (typeof owner !== "object") return undefined;
      const member = owner.members.get(name) ?? inheritedMember(owner, name, true);
      if (member === undefined) return "";
      if (typeof member !== "object") return undefined;
      const modifiers = modifierWords(member.node);
      if (!modifiers.includes("public") && owner.kind !== "interface") return undefined;
      if (onlyStatic && !modifiers.includes("static") && owner.kind !== "interface" && member.node.type === "class_declaration") return "";
      return member.fqn;
    }
    if (onlyStatic) return undefined;
    const declared = byFqn(`${container}.${name}`);
    if (declared !== undefined) return typeof declared === "object" && modifierWords(declared.node).includes("public") ? declared.fqn : undefined;
    const platform = PLATFORM_TYPE_NAMES.get(container);
    if (platform !== undefined && isPlatformName(`${container}.${name}`)) return platform.has(name) ? `${container}.${name}` : "";
    return types.some((type) => type.file.packageName === container) ? "" : undefined;
  }

  /**
   * What a name read at `at` denotes inside the innermost declared type around it, walking out from `at` (JLS 6.3,
   * 15.9.5): a local type a block declares before it, then, at an anonymous class body, a type the body declares or a
   * member type it inherits from the type it instantiates; `undefined` when none of those scopes declares the name. An
   * instantiated type the sources do not declare leaves a strict reading unsettled, as any supertype they do not declare.
   */
  function boundInside(head: string, at: Node, scope: Scope, strict: boolean): TypeLookup | "unsettled" | LocalType | undefined {
    for (let inner: Node = at, around = at.parent; around !== null && around.id !== scope.type?.node.id; inner = around, around = around.parent) {
      const local = localTypeIn(head, inner, around);
      if (local !== undefined) return { local };
      const creation = around.type === "class_body" ? around.parent : null;
      if (creation?.type !== "object_creation_expression") continue;
      const member = namedChildren(around).find((declaration) => LOCAL_TYPE_DECLARATIONS.has(declaration.type) && declaration.childForFieldName("name")?.text === head);
      if (member !== undefined) return { local: member };
      const written = typeNodeName(creation.childForFieldName("type") ?? creation);
      const instantiated = resolveName(written, { ...scope, at: creation }, strict);
      const inherited = inheritedThrough([instantiated], head, strict, new Set([scope.file.packageName]), new Set());
      if (inherited !== undefined) return inherited;
    }
    return undefined;
  }

  const inherited = { strict: new Map<TypeDecl, Map<string, TypeLookup | "unsettled">>(), lenient: new Map<TypeDecl, Map<string, TypeLookup | "unsettled">>() };

  /**
   * The member type of the name `type` inherits (JLS 8.5): from each supertype the nearest declaration of the name, kept
   * only when it is not private and, package-private, when every class on the way shares its package. Two inherited
   * declarations are ambiguous; a supertype the snapshot does not declare leaves a strict reading unsettled.
   */
  function inheritedMember(type: TypeDecl, head: string, strict: boolean): TypeLookup | "unsettled" {
    const cache = strict ? inherited.strict : inherited.lenient;
    const byName = cache.get(type) ?? new Map<string, TypeLookup | "unsettled">();
    cache.set(type, byName);
    if (byName.has(head)) return byName.get(head);
    const result = inheritedThrough(supertypesOf(type), head, strict, new Set([type.file.packageName]), new Set([type]));
    byName.set(head, result);
    return result;
  }

  function supertypesOf(type: TypeDecl): (TypeLookup | "unsettled" | LocalType)[] {
    return [...interfaceNodes(type), ...[superclassNode(type)].filter((parent) => parent !== undefined)].map((node) => lookupType(typeNodeName(node), { file: type.file, type: type.outer }));
  }

  /** The member type of the name a type whose direct supertypes are `parents` inherits from them (`inheritedMember`). */
  function inheritedThrough(parents: readonly (TypeLookup | "unsettled" | LocalType)[], head: string, strict: boolean, packages: ReadonlySet<string>, visited: Set<TypeDecl>): TypeLookup | "unsettled" {
    const found = new Set<TypeDecl>();
    let unsettled = false;
    const visit = (supertypes: readonly (TypeLookup | "unsettled" | LocalType)[], on: ReadonlySet<string>): void => {
      for (const parent of supertypes) {
        if (typeof parent !== "object" || "local" in parent) {
          unsettled = true;
          continue;
        }
        if (visited.has(parent)) continue;
        visited.add(parent);
        const member = parent.members.get(head);
        if (member === undefined) visit(supertypesOf(parent), new Set([...on, parent.file.packageName]));
        else if (inherits(member, parent, on)) found.add(member);
      }
    };
    visit(parents, packages);
    return found.size > 1 ? "ambiguous" : strict && unsettled ? "unsettled" : found.values().next().value;
  }

  function inherits(member: TypeDecl, declaring: TypeDecl, packages: ReadonlySet<string>): boolean {
    const words = modifierWords(member.node);
    if (words.includes("private")) return false;
    if (declaring.kind === "interface" || declaring.kind === "annotation" || words.includes("public") || words.includes("protected")) return true;
    return [...packages].every((name) => name === member.file.packageName);
  }

  function bindName(name: string, scope: Scope, reading: "strict" | "lenient"): TypeLookup | "unsettled" | LocalType {
    return resolveSimple(name, scope, reading === "strict");
  }

  /**
   * The type a dotted name denotes in a scope: its first name bound as a simple name is (`resolveSimple`, at the scope's
   * place when it has one), then each member type after it; a dotted name that binds no type is read as fully qualified.
   * A first name bound to a local type leads through types no project type stands for, so a longer name is unsettled.
   */
  function resolveName(name: string, scope: Scope, strict: boolean): TypeLookup | "unsettled" | LocalType {
    const [head = "", ...rest] = name.split(".");
    const resolved = resolveSimple(head, scope, strict);
    if (rest.length === 0 || resolved === "ambiguous" || resolved === "unsettled") return resolved;
    if (typeof resolved === "object" && "local" in resolved) return "unsettled";
    let type = resolved;
    for (const part of rest) type = type?.members.get(part);
    return type ?? byFqn(name);
  }

  function lookupType(name: string, scope: Scope): TypeLookup {
    const resolved = resolveName(name, { file: scope.file, type: scope.type }, false);
    return resolved === undefined || resolved === "unsettled" || (typeof resolved === "object" && "local" in resolved) ? byFqn(name) : resolved;
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

  function supertypeGap(found: TypeLookup, node: Node, type: TypeDecl, isInterface: boolean, before: number, strict = false): SupertypeGap | undefined {
    const name = typeNodeName(node);
    const gap = { isInterface, name, before, file: type.file, node };
    if (found === "ambiguous") return { ...gap, kind: "ambiguous" };
    return found === undefined && (strict || !externalNames(name, type.file, true).every(isPlatformName)) ? { ...gap, kind: "missing" } : undefined;
  }

  function hierarchy(root: TypeDecl, resolveParent?: (node: Node, owner: TypeDecl) => TypeLookup): Hierarchy {
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
      const found = resolveParent === undefined ? lookupType(typeNodeName(parent.node), scopeOf(frame.type)) : resolveParent(parent.node, frame.type);
      const gap = supertypeGap(found, parent.node, frame.type, parent.isInterface, members.length, resolveParent !== undefined);
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
    typeIdentity,
    bindName,
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

export function sameParameters(
  first: MethodDecl,
  second: MethodDecl,
  matches: (a: string, aVariables: ReadonlySet<string>, b: string, bVariables: ReadonlySet<string>) => boolean,
): boolean {
  return (
    first.parameterTypes.length === second.parameterTypes.length &&
    first.parameterTypes.every((parameter, index) => matches(parameter, first.typeVariables, second.parameterTypes[index] ?? "", second.typeVariables))
  );
}

export function parameterCompatible(a: string, aVariables: ReadonlySet<string>, b: string, bVariables: ReadonlySet<string>): boolean {
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
      else if (declaration.type === "constructor_declaration" || declaration.type === "compact_constructor_declaration") type.constructors.push(describeMethod(type, declaration));
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
    constructors: [],
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

const LOCAL_TYPE_DECLARATIONS: ReadonlySet<string> = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"]);
const BLOCKS: ReadonlySet<string> = new Set(["block", "constructor_body", "switch_block_statement_group"]);

/**
 * The local type of the name `around` declares in scope at its child `inner` (JLS 6.3): a block's statement before it or
 * around it; one a switch block's earlier group declares is in scope for the rest of that switch block.
 */
function localTypeIn(name: string, inner: Node, around: Node): Node | undefined {
  const statements = around.type === "switch_block" ? around.namedChildren.filter((group) => group.startIndex <= inner.startIndex).flatMap((group) => group.namedChildren) : BLOCKS.has(around.type) ? around.namedChildren : [];
  return statements.find((statement) => statement.startIndex <= inner.startIndex && LOCAL_TYPE_DECLARATIONS.has(statement.type) && statement.childForFieldName("name")?.text === name);
}

function modifierWords(declaration: Node): string[] {
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  return modifiers === undefined ? [] : modifiers.children.filter((child) => !child.isNamed).map((child) => child.text);
}

/**
 * A parameter type by what its erasure names: a type variable of a declaration around it, or the qualified name of the
 * repository or platform type the strict reading settles (a keyword names itself), with its array dimensions.
 */
export type Signature = readonly ({ variable: true; dimensions: number } | { name: string; dimensions: number })[];

/**
 * Whether two signatures certainly declare the same parameter types: equal settled names at equal dimensions. A type
 * variable on either side is never certainly one type (what an implementation binds it to is not read), so two methods
 * not proven the same may still be one, and nothing narrows to either.
 */
export function sameSignature(first: Signature, second: Signature): boolean {
  return first.length === second.length && first.every((parameter, index) => {
    const other = second[index]!;
    return parameter.dimensions === other.dimensions && !("variable" in parameter) && !("variable" in other) && parameter.name === other.name;
  });
}

/** Nodes the grammar places among a method's parameters that declare none. */
const NOT_PARAMETERS: ReadonlySet<string> = new Set(["line_comment", "block_comment"]);
const KEYWORD_TYPES: ReadonlySet<string> = new Set(["integral_type", "floating_point_type", "boolean_type"]);

export function readSignature(method: MethodDecl, project: JavaProject): Signature | undefined {
  const parameters = (method.node.childForFieldName("parameters")?.namedChildren ?? []).filter((parameter): parameter is Node => parameter !== null && !NOT_PARAMETERS.has(parameter.type));
  const signature: Signature[number][] = [];
  for (const parameter of parameters) {
    if (parameter.type !== "formal_parameter" && parameter.type !== "spread_parameter") return undefined;
    const written = parameter.childForFieldName("type") ?? parameter.namedChildren.find((child) => child !== null && child.type !== "modifiers");
    if (written === null || written === undefined) return undefined;
    const element = written.type === "array_type" ? written.childForFieldName("element") : written;
    const dimensions = dimensionsOf(written) + dimensionsOf(parameter) + (parameter.type === "spread_parameter" ? 1 : 0);
    const erased = element?.type === "generic_type" ? element.namedChildren[0] : element;
    if (erased === null || erased === undefined) return undefined;
    if (KEYWORD_TYPES.has(erased.type)) signature.push({ name: erased.text, dimensions });
    else if (erased.type === "type_identifier" && typeVariableAround(erased) !== undefined) signature.push({ variable: true, dimensions });
    else {
      const name = project.typeIdentity(erased.text.replace(/\s+/g, ""), { file: method.owner.file, type: method.owner, at: erased });
      if (name === undefined) return undefined;
      signature.push({ name, dimensions });
    }
  }
  return signature;
}

const INTEGER_LITERALS: ReadonlySet<string> = new Set(["decimal_integer_literal", "hex_integer_literal", "octal_integer_literal", "binary_integer_literal"]);

/** Exact static argument types only; conversions, inference and expressions without a declared type remain unproven. */
export function readArgumentSignature(invocation: Node, scope: Scope, project: JavaProject): Signature | undefined {
  const list = invocation.childForFieldName("arguments");
  const signature: Signature[number][] = [];
  for (const argument of list === null ? [] : namedChildren(list)) {
    let node = unwrapParentheses(argument);
    if (node === undefined) return undefined;
    if (node.type === "unary_expression") {
      const operand = node.childForFieldName("operand");
      if (operand === null || !INTEGER_LITERALS.has(operand.type)) return undefined;
      node = operand;
    }
    if (INTEGER_LITERALS.has(node.type)) {
      signature.push({ name: /[lL]$/.test(node.text) ? "long" : "int", dimensions: 0 });
      continue;
    }
    if (node.type === "string_literal") {
      signature.push({ name: "java.lang.String", dimensions: 0 });
      continue;
    }
    if (node.type === "true" || node.type === "false") {
      signature.push({ name: "boolean", dimensions: 0 });
      continue;
    }
    if (node.type !== "identifier") return undefined;
    const binding = localBinding(node);
    if (binding === undefined || binding.startIndex > node.startIndex) return undefined;
    const declaration = binding.type === "variable_declarator" ? binding.parent : binding;
    const written = declaration?.childForFieldName("type");
    if (written === null || written === undefined || written.type === "generic_type" || written.text === "var") return undefined;
    const element = written.type === "array_type" ? written.childForFieldName("element") : written;
    if (element === null || element.type === "generic_type" || typeVariableAround(element) !== undefined) return undefined;
    const name = KEYWORD_TYPES.has(element.type) ? element.text : project.typeIdentity(element.text.replace(/\s+/g, ""), { ...scope, at: element });
    if (name === undefined || name.startsWith("context:")) return undefined;
    signature.push({ name, dimensions: dimensionsOf(written) + dimensionsOf(binding) });
  }
  return signature;
}

/** The `[]` pairs a node writes directly: an array type's, or a parameter's after its name (`String args[]`). */
function dimensionsOf(node: Node): number {
  const dimensions = node.type === "array_type" ? node.childForFieldName("dimensions") : node.namedChildren.find((child) => child?.type === "dimensions");
  return (dimensions?.text.match(/\[/g) ?? []).length;
}

export function typeVariableAround(name: Node, spelling = name.text): Node | undefined {
  for (let scope = name.parent; scope !== null; scope = scope.parent) {
    const parameters = scope.childForFieldName("type_parameters");
    const found = parameters?.namedChildren.find((parameter) => parameter?.namedChildren[0]?.text === spelling);
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
}

