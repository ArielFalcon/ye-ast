import type { Node } from "web-tree-sitter";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DispatchTargets, ImportOrigins } from "../../ports/import-origins.port.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { enclosingType } from "./java-root-bindings.ts";
import { FUNCTION_VALUES, isAnonymous, isAspect, namesDynamicImplementation, resolve, supertypesOf, TYPE_DECLARATIONS, UNREAD_JVM_SOURCE } from "./java-declared-types.ts";
import { createJavaProject, describeFile, parameterCompatible, sameParameters, type JavaFile, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";

const UNKNOWN: DispatchTargets = { kind: "unknown" };
/** Annotations the language itself defines, which no generator or proxy reads to implement a type. */
const LANGUAGE_ANNOTATIONS: ReadonlySet<string> = new Set(["Override", "Deprecated", "SuppressWarnings", "FunctionalInterface"]);
/** The public methods of `Object` by name and arity, which do not count against a functional interface's one abstract method (JLS 9.8). */
const OBJECT_METHODS: ReadonlySet<string> = new Set(["equals/1", "hashCode/0", "toString/0"]);

/** A class's superclass as the strict reading settles it: a repository type, none written, or one outside the repository or unsettled. */
type Superclass = TypeDecl | "none" | "outside";

/** The declared hierarchy of the sources, by the strict reading of every supertype a declaration writes. */
interface Hierarchy {
  subtypes: ReadonlyMap<TypeDecl, readonly TypeDecl[]>;
  /** The repository types each type extends or implements directly. */
  supertypes: ReadonlyMap<TypeDecl, readonly TypeDecl[]>;
  superclasses: ReadonlyMap<TypeDecl, Superclass>;
  /** Types with a supertype that is not a repository type: a platform or dependency type, or one the reading leaves unsettled. */
  outside: ReadonlySet<TypeDecl>;
  /** The simple names of supertypes the strict reading leaves unsettled, anywhere in the sources. */
  unsettled: ReadonlySet<string>;
  /** Anonymous and local classes, which the project does not place: the repository types they extend or implement and the unsettled names. */
  unplaced: readonly { types: readonly TypeDecl[]; names: readonly string[] }[];
  /** Whether a source holds a lambda or a method reference, which implements a functional interface no declaration names. */
  functionValues: boolean;
}

/**
 * `ImportOrigins.dispatchTargets` for Java sources: the body each concrete class below the method's owner runs, its own
 * declaration or the nearest one up its class chain, found through the project's one resolver in its strict reading.
 * Unknown when a value the sources do not place may implement the owner: a source that does not parse, a JVM language
 * no extractor reads, an aspect or a JDK API that implements an interface at run time anywhere; an annotation on the
 * owner or the method other than the language's own (a generator or a proxy may implement it); an owner whose
 * hierarchy reaches a type outside the repository; a supertype the strict reading leaves unsettled under the name of
 * the owner or a type below it; an anonymous or local class below it; a lambda or method reference while the owner is a
 * functional interface; an enum below it; or a class whose chain reaches no single body of the method's signature.
 */
export function createJavaDispatchTargets(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[]): ImportOrigins["dispatchTargets"] {
  const java = sources.filter(({ path }) => isJavaSource(path));
  const unreadJvm = paths.some((path) => UNREAD_JVM_SOURCE.test(path));
  return async (sites, signal) => {
    const results: DispatchTargets[] = sites.map(() => UNKNOWN);
    if (unreadJvm || !sites.some(({ file }) => isJavaSource(file))) return results;
    const read = await parser();
    const trees: JavaSyntaxTree[] = [];
    try {
      const files: JavaFile[] = [];
      for (const source of java) {
        const parsed = read.parse(source.content);
        if (!parsed.ok) return results;
        trees.push(parsed.value);
        files.push(describeFile(source.path, parsed.value.root));
      }
      const project = createJavaProject(files);
      if (project.unreadable.length > 0) return results;
      const hierarchy = hierarchyOf(files, project);
      if (hierarchy === undefined) return results;
      for (const [index, site] of sites.entries()) {
        if (signal?.aborted) break;
        const method = project.types.flatMap((type) => (type.file.path === site.file ? type.methods : [])).find((candidate) => candidate.name === site.name && !candidate.hasBody && spansLine(candidate.node, site.line));
        if (method !== undefined) results[index] = targetsOf(method, hierarchy);
      }
      return results;
    } finally {
      for (const tree of trees) tree.dispose();
    }
  };
}

function targetsOf(method: MethodDecl, hierarchy: Hierarchy): DispatchTargets {
  const owner = method.owner;
  if (isAnnotated(owner.node) || isAnnotated(method.node)) return UNKNOWN;
  if (ancestorsOf(owner, hierarchy).some((type) => hierarchy.outside.has(type))) return UNKNOWN;
  const below = belowOf(owner, hierarchy);
  const names = new Set([owner, ...below].map((type) => type.name));
  if ([...hierarchy.unsettled].some((name) => names.has(name))) return UNKNOWN;
  if (hierarchy.unplaced.some(({ types, names: unsettled }) => types.some((type) => type === owner || below.has(type)) || unsettled.some((name) => names.has(name)))) return UNKNOWN;
  if (hierarchy.functionValues && [owner, ...below].some((type) => type.kind === "interface" && isFunctional(type, hierarchy))) return UNKNOWN;
  if ([...below].some((type) => type.kind === "other")) return UNKNOWN;
  const bodies = new Map<Node, MethodDecl>();
  for (const type of [owner, ...below]) {
    if (type.kind !== "class" || type.isAbstract) continue;
    const body = bodyIn(type, method, hierarchy);
    if (body === undefined) return UNKNOWN;
    bodies.set(body.node, body);
  }
  return {
    kind: "bodies",
    bodies: [...bodies.values()]
      .map((body) => ({ file: body.owner.file.path, start: body.node.startPosition.row + 1, nameLine: (body.node.childForFieldName("name") ?? body.node).startPosition.row + 1 }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start)),
  };
}

/** The body a value of `type` runs for `method`: the nearest class up its chain that declares a method of that name and arity, when it declares exactly one with a body and the same signature. */
function bodyIn(type: TypeDecl, method: MethodDecl, hierarchy: Hierarchy): MethodDecl | undefined {
  for (let current: Superclass = type; typeof current === "object"; current = hierarchy.superclasses.get(current) ?? "outside") {
    const declared = current.methods.filter((candidate) => candidate.name === method.name && candidate.parameterTypes.length === method.parameterTypes.length);
    if (declared.length > 0) return declared.length === 1 && declared[0]!.hasBody && sameParameters(declared[0]!, method, parameterCompatible) ? declared[0] : undefined;
  }
  return undefined;
}

/** A method an interface has under one signature: abstract or with a body, and the interface that declares it. */
interface Member {
  abstract: boolean;
  from: TypeDecl;
  /** A parameter type is or holds a type variable of the declaring interface, which a type argument may make any type. */
  generic: boolean;
}

/**
 * Whether a lambda or a method reference could implement the interface: of the methods it declares or inherits, at most
 * one is abstract beside `Object`'s, or the sources do not settle which are.
 */
function isFunctional(type: TypeDecl, hierarchy: Hierarchy): boolean {
  const members = membersOf(type, hierarchy, new Map());
  if (members === undefined) return true;
  const abstract = [...members].filter(([, member]) => member.abstract).map(([signature]) => signature).filter((signature) => !OBJECT_METHODS.has(arityOf(signature)));
  return abstract.length <= 1;
}

/**
 * The methods an interface declares or inherits (JLS 9.4.1), by name and parameter types: its own declaration overrides
 * every inherited method of the same signature, and an inherited one overrides those of the interfaces above the one
 * that declares it; abstract methods of one signature from unrelated interfaces merge into one. `undefined` when the
 * sources do not settle it: a supertype outside the repository, a cycle, or two methods of one name and arity that
 * different interfaces spell with different parameter types, or of which one has a parameter type that is or holds a type
 * variable of its interface, which a type argument or a qualified name may make the same signature.
 */
function membersOf(type: TypeDecl, hierarchy: Hierarchy, known: Map<TypeDecl, ReadonlyMap<string, Member> | undefined>): ReadonlyMap<string, Member> | undefined {
  if (known.has(type)) return known.get(type);
  known.set(type, undefined);
  if (hierarchy.outside.has(type)) return undefined;
  const members = new Map<string, Member>();
  for (const method of type.methods) {
    if (!method.modifiers.includes("static") && !method.modifiers.includes("private")) members.set(signatureOf(method), { abstract: !method.hasBody, from: type, generic: method.parameterTypes.some((parameter) => (parameter.match(/[A-Za-z_$][\w$]*/g) ?? []).some((name) => type.typeVariables.has(name))) });
  }
  const inherited = new Map<string, Member[]>();
  for (const supertype of hierarchy.supertypes.get(type) ?? []) {
    const above = membersOf(supertype, hierarchy, known);
    if (above === undefined) return undefined;
    for (const [signature, member] of above) if (!members.has(signature)) inherited.set(signature, [...(inherited.get(signature) ?? []), member]);
  }
  for (const [signature, candidates] of inherited) {
    const kept = candidates.filter((candidate) => !candidates.some((other) => other.from !== candidate.from && ancestorsOf(other.from, hierarchy).includes(candidate.from)));
    const abstract = kept.every((candidate) => candidate.abstract);
    members.set(signature, { ...kept[0]!, abstract });
  }
  const entries = [...members];
  if (entries.some(([signature, member], index) => entries.some(([other, rival], later) => later > index && (rival.from !== member.from || rival.generic || member.generic) && arityOf(other) === arityOf(signature)))) return undefined;
  known.set(type, members);
  return members;
}

function signatureOf(method: MethodDecl): string {
  return `${method.name}/${method.parameterTypes.length}(${method.parameterTypes.join(",")})`;
}

/** `name/arity` of a signature. */
function arityOf(signature: string): string {
  return signature.slice(0, signature.indexOf("("));
}

/** The type and every repository type above it. */
function ancestorsOf(type: TypeDecl, hierarchy: Hierarchy): TypeDecl[] {
  const above = new Set<TypeDecl>([type]);
  for (const current of above) for (const parent of hierarchy.supertypes.get(current) ?? []) above.add(parent);
  return [...above];
}

/** Every repository type below `type`, through any number of supertypes. */
function belowOf(type: TypeDecl, hierarchy: Hierarchy): ReadonlySet<TypeDecl> {
  const below = new Set<TypeDecl>();
  for (let frontier = [type]; frontier.length > 0; ) {
    frontier = frontier.flatMap((current) => hierarchy.subtypes.get(current) ?? []).filter((next) => next !== type && !below.has(next));
    for (const next of frontier) below.add(next);
  }
  return below;
}

/** Reads every declaration's supertypes; `undefined` when an aspect or a JDK API that implements an interface at run time may run code behind any type. */
function hierarchyOf(files: readonly JavaFile[], project: JavaProject): Hierarchy | undefined {
  const placed = new Map(project.types.map((type) => [type.node.id, type]));
  const subtypes = new Map<TypeDecl, TypeDecl[]>();
  const supertypes = new Map<TypeDecl, TypeDecl[]>();
  const superclasses = new Map<TypeDecl, Superclass>();
  const outside = new Set<TypeDecl>();
  const unsettled = new Set<string>();
  const unplaced: { types: TypeDecl[]; names: string[] }[] = [];
  let functionValues = false;
  for (const file of files) {
    const pending: Node[] = [file.root];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (isAspect(node) || namesDynamicImplementation(node, file, project)) return undefined;
      if (FUNCTION_VALUES.has(node.type)) functionValues = true;
      if (TYPE_DECLARATIONS.has(node.type) || isAnonymous(node)) {
        const scope = enclosingType(node.parent ?? node, file, project);
        const declared = placed.get(node.id);
        const superclass = node.type === "class_declaration" ? node.childForFieldName("superclass")?.namedChildren[0] : undefined;
        const types: TypeDecl[] = [];
        const names: string[] = [];
        for (const supertype of supertypesOf(node)) {
          const resolved = resolve(supertype, file, project, scope, supertype);
          const type = resolved?.kind === "repository" ? resolved.type : undefined;
          if (type !== undefined) types.push(type);
          else if (resolved?.kind !== "platform") names.push(simpleName(supertype));
          if (declared !== undefined && supertype.id === superclass?.id) superclasses.set(declared, type ?? "outside");
          if (declared !== undefined && type === undefined) outside.add(declared);
        }
        if (declared === undefined) unplaced.push({ types, names });
        else {
          if (!superclasses.has(declared)) superclasses.set(declared, "none");
          for (const type of types) subtypes.set(type, [...(subtypes.get(type) ?? []), declared]);
          supertypes.set(declared, types);
          for (const name of names) unsettled.add(name);
        }
      }
      for (const child of node.namedChildren) if (child !== null) pending.push(child);
    }
  }
  return { subtypes, supertypes, superclasses, outside, unsettled, unplaced, functionValues };
}

function isAnnotated(declaration: Node): boolean {
  const modifiers = declaration.namedChildren.find((child) => child?.type === "modifiers");
  return (modifiers?.namedChildren ?? []).some((child) => (child?.type === "marker_annotation" || child?.type === "annotation") && !LANGUAGE_ANNOTATIONS.has(child.childForFieldName("name")?.text.split(".").at(-1) ?? ""));
}

function simpleName(type: Node): string {
  return ((type.type === "generic_type" ? type.namedChildren[0] : type)?.text ?? "").replace(/\s+/g, "").split(".").at(-1) ?? "";
}

/** Whether the line lies between a declaration's first token and its name. */
function spansLine(declaration: Node, line: number): boolean {
  return declaration.startPosition.row + 1 <= line && line <= (declaration.childForFieldName("name") ?? declaration).startPosition.row + 1;
}
