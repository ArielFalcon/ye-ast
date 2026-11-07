import type { Node } from "web-tree-sitter";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DispatchTargets, ImportOrigins } from "../../ports/import-origins.port.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { enclosingType, typeVariableAround } from "./java-root-bindings.ts";
import { FUNCTION_VALUES, isAnonymous, isAspect, namesDynamicImplementation, resolve, supertypesOf, TYPE_DECLARATIONS, UNREAD_JVM_SOURCE } from "./java-declared-types.ts";
import { createJavaProject, describeFile, type JavaFile, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";

const UNKNOWN: DispatchTargets = { kind: "unknown" };
/** Annotations the language itself defines, which no generator or proxy reads to implement a type. */
const LANGUAGE_ANNOTATIONS: ReadonlySet<string> = new Set(["Override", "Deprecated", "SuppressWarnings", "FunctionalInterface"]);
/** Methods every interface inherits from `Object`, which do not count against a functional interface's one abstract method (JLS 9.8). */
const OBJECT_METHODS: ReadonlySet<string> = new Set(["equals", "hashCode", "toString"]);

/** A class's superclass as the strict reading settles it: a repository type, none written, or one outside the repository or unsettled. */
export type Superclass = TypeDecl | "none" | "outside";

/** The declared hierarchy of the sources, by the strict reading of every supertype a declaration writes. */
export interface Hierarchy {
  subtypes: ReadonlyMap<TypeDecl, readonly TypeDecl[]>;
  superclasses: ReadonlyMap<TypeDecl, Superclass>;
  /** Types with a supertype that is not a repository type: a platform or dependency type, or one the reading leaves unsettled. */
  outside: ReadonlySet<TypeDecl>;
  /** The simple names of supertypes the strict reading leaves unsettled, anywhere in the sources. */
  unsettled: ReadonlySet<string>;
  /** Anonymous and local classes, which the project does not place: the repository types they extend or implement and the unsettled names. */
  unplaced: readonly { types: readonly TypeDecl[]; names: readonly string[] }[];
  /** Whether a source holds a lambda or a method reference, which implements a functional interface no declaration names. */
  functionValues: boolean;
  /** A method's parameter types as the strict reading settles them; `undefined` when one of them is not settled. */
  signatureOf(method: MethodDecl): Signature | undefined;
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

/** The bodies a call of `method` runs on a value of `owner`, the method's own owner unless a declared type below it states the value. */
export function targetsOf(method: MethodDecl, hierarchy: Hierarchy, owner: TypeDecl = method.owner): DispatchTargets {
  if (isAnnotated(owner.node) || isAnnotated(method.node)) return UNKNOWN;
  if (ancestorsOf(owner, hierarchy).some((type) => hierarchy.outside.has(type))) return UNKNOWN;
  const below = belowOf(owner, hierarchy);
  const names = new Set([owner, ...below].map((type) => type.name));
  if ([...hierarchy.unsettled].some((name) => names.has(name))) return UNKNOWN;
  if (hierarchy.unplaced.some(({ types, names: unsettled }) => types.some((type) => type === owner || below.has(type)) || unsettled.some((name) => names.has(name)))) return UNKNOWN;
  if (owner.kind === "interface" && hierarchy.functionValues && isFunctional(owner, hierarchy)) return UNKNOWN;
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
    if (declared.length > 0) return declared.length === 1 && declared[0]!.hasBody && overrides(declared[0]!, method, hierarchy) ? declared[0] : undefined;
  }
  return undefined;
}

/** Whether `declared` certainly states the parameter types of `method`, each signature as the strict reading settles it. */
function overrides(declared: MethodDecl, method: MethodDecl, hierarchy: Hierarchy): boolean {
  const own = hierarchy.signatureOf(declared);
  const overridden = hierarchy.signatureOf(method);
  return own !== undefined && overridden !== undefined && sameSignature(own, overridden);
}

/** Whether a lambda could implement the interface: its hierarchy declares at most one abstract method beside `Object`'s, by name and arity, or reaches a type the sources do not hold. */
function isFunctional(owner: TypeDecl, hierarchy: Hierarchy): boolean {
  const abstract = new Set(
    ancestorsOf(owner, hierarchy)
      .flatMap((type) => type.methods)
      .filter((method) => !method.hasBody && !method.modifiers.includes("static") && !OBJECT_METHODS.has(method.name))
      .map((method) => `${method.name}/${method.parameterTypes.length}`),
  );
  return abstract.size <= 1;
}

/** The type and every repository type above it. */
export function ancestorsOf(type: TypeDecl, hierarchy: Hierarchy): TypeDecl[] {
  const above = new Set<TypeDecl>([type]);
  const parents = new Map<TypeDecl, TypeDecl[]>();
  for (const [supertype, subtypes] of hierarchy.subtypes) for (const subtype of subtypes) parents.set(subtype, [...(parents.get(subtype) ?? []), supertype]);
  for (const current of above) for (const parent of parents.get(current) ?? []) above.add(parent);
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
export function hierarchyOf(files: readonly JavaFile[], project: JavaProject): Hierarchy | undefined {
  const placed = new Map(project.types.map((type) => [type.node.id, type]));
  const subtypes = new Map<TypeDecl, TypeDecl[]>();
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
          for (const name of names) unsettled.add(name);
        }
      }
      for (const child of node.namedChildren) if (child !== null) pending.push(child);
    }
  }
  const signatures = new Map<MethodDecl, Signature | undefined>();
  const signatureOf = (method: MethodDecl): Signature | undefined => {
    if (!signatures.has(method)) signatures.set(method, readSignature(method, project));
    return signatures.get(method);
  };
  return { subtypes, superclasses, outside, unsettled, unplaced, functionValues, signatureOf };
}

/** Nodes the grammar places among a method's parameters that declare none. */
const NOT_PARAMETERS: ReadonlySet<string> = new Set(["line_comment", "block_comment"]);
const KEYWORD_TYPES: ReadonlySet<string> = new Set(["integral_type", "floating_point_type", "boolean_type"]);

function readSignature(method: MethodDecl, project: JavaProject): Signature | undefined {
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
      const file = method.owner.file;
      const scope = enclosingType(erased, file, project);
      const resolved = resolve(erased, file, project, scope, erased);
      const name = resolved?.kind === "platform" ? resolved.fqn : resolved?.kind === "repository" ? resolved.type?.fqn : unboundName(erased, file, project, scope);
      if (name === undefined) return undefined;
      signature.push({ name, dimensions });
    }
  }
  return signature;
}

/**
 * A simple type name nothing in the repository binds and no single import names, by what decides its meaning: the file's
 * package and on-demand imports (JLS 6.4.1), so two such names are one type only when both files read it from the same
 * places. `undefined` when the strict reading binds it, leaves it unsettled or finds it ambiguous.
 */
function unboundName(name: Node, file: JavaFile, project: JavaProject, scope: TypeDecl | undefined): string | undefined {
  if (name.type !== "type_identifier" || file.singleImports.has(name.text)) return undefined;
  if (project.bindName(name.text, { file, type: scope, at: name }, "strict") !== undefined) return undefined;
  return `${file.packageName}|${[...file.onDemandImports].sort().join(",")}|${name.text}`;
}

/** The `[]` pairs a node writes directly: an array type's, or a parameter's after its name (`String args[]`). */
function dimensionsOf(node: Node): number {
  const dimensions = node.type === "array_type" ? node.childForFieldName("dimensions") : node.namedChildren.find((child) => child?.type === "dimensions");
  return (dimensions?.text.match(/\[/g) ?? []).length;
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
