import type { Node } from "web-tree-sitter";
import { isUncoveredJvmSource } from "../../domain/languages/path-class.ts";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { ConstructedClassSite, DeclaredSupertype, DeclaredSupertypes, ImplementedDeclarations, ImplementingSite, ImplicitChain, ImportOrigins, MethodPlace, ReceiverCallSite, ReceiverMethod } from "../../ports/import-origins.port.ts";
import { enclosingBody, fieldsOf, localBinding } from "../tree-sitter/java-function-value-calls.ts";
import { typeVariableAround } from "../tree-sitter/java-declared-variables.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { declarationsProject, enclosingType, heldJavaProject, thisType, withJavaSources, type UnparsedSource } from "./java-project.ts";
import { javaReceiverBindings } from "../tree-sitter/java-receiver-bindings.ts";
import { annotationAt, namesDynamicImplementation, resolve } from "./java-declared-types.ts";
import { builderMember, generatedMember, type GeneratedMember } from "./java-generated-members.ts";
import { REPOSITORY_FRAGMENTS, REPOSITORY_MEMBER_NAMES, REPOSITORY_OPERATIONS, REPOSITORY_TYPES } from "./data-vocabulary.ts";
import { createJavaProject, MEMBERLESS_PLATFORM_INTERFACES, namedChildren, readArgumentSignature, readSignature, sameSignature, scopeOf, supertypeClauses, typeNodeName, type JavaFile, type JavaProject, type MethodDecl, type ProjectBuild, type Scope, type Signature, type TypeDecl } from "./java-symbols.ts";
import { PLATFORM_TYPE_NAMES } from "./java-platform-type-names.ts";

const SLOT = "java-receiver-methods";
const UNKNOWN: ReceiverMethod = { kind: "unknown" };
const UNPROVEN: ReceiverMethod = { kind: "unproven" };
const GENERATED: ReceiverMethod = { kind: "generated" };
const UNKNOWN_CHAIN: ImplicitChain = { kind: "unknown" };
const NO_CHAIN: ImplicitChain = { kind: "none" };
const PROXIED: GeneratedMember = { kind: "proxied" };
const LOMBOK_CONFIG = /(^|\/)lombok\.config$/;
const UNKNOWN_DECLARATIONS: ImplementedDeclarations = { kind: "unknown" };
const UNKNOWN_SUPERTYPES: DeclaredSupertypes = { kind: "unknown" };
/** Methods every class inherits from `Object` (JLS 4.3.2): a call of one of these names may resolve to `Object`'s. */
export const OBJECT_METHODS: ReadonlySet<string> = new Set(["clone", "equals", "finalize", "getClass", "hashCode", "notify", "notifyAll", "toString", "wait"]);
/** Nodes the grammar places among a call's arguments that are no argument. */
const NOT_ARGUMENTS: ReadonlySet<string> = new Set(["line_comment", "block_comment"]);
/**
 * Annotations by which a processor changes what a call names without a declaration the sources hold: Lombok's
 * `@Delegate` adds a type's methods to a class, an overload of any signature, and `@ExtensionMethod` makes a call that
 * no member accepts run a static method of another class.
 */
const CALL_REWRITING_ANNOTATIONS: ReadonlySet<string> = new Set(["Delegate", "ExtensionMethod"]);
const PRIMITIVES: ReadonlySet<string> = new Set(["boolean", "byte", "char", "short", "int", "long", "float", "double"]);
/** Platform classes a signature names that declare no type parameter, so a value of one is never raw. */
const PLAIN_PLATFORM_TYPES: ReadonlySet<string> = new Set(["java.lang.Object", "java.lang.String"]);

/** One Java source as the resolver reads it: its description, and its receiver bindings by the call's place, member and receiver. */
export interface ReceiverSource {
  file: JavaFile;
  bindings: ReadonlyMap<string, ReceiverBinding>;
}

interface ReadFile extends ReceiverSource {
  /** Method invocations by the place they start and the member they call: one place may start several (`a.f().f()`). */
  invocations: ReadonlyMap<string, readonly Node[]>;
}

/**
 * `ImportOrigins.receiverMethods` for Java sources. Java types nominally, so a value a declaration states the type of is
 * an instance of that type or of a type below it, and the call names the type's method of the call's signature; dispatch
 * then decides the body (RFC-0013 R7). The receiver's type is the repository type a parameter, a local or a private field
 * states, as the receiver bindings read it (ADR-0029 decision 9), or the declared return type of the repository method
 * that a receiver call names in the same way, the enclosing class's for `f()` and `this.f()` (R5): an overriding method
 * may only return a subtype, which dispatch covers. A type variable with one bound the repository declares as a class or
 * an interface types the receiver as that bound (JLS 4.4): the method is its bound's, marked `bound`, a dependence whose
 * execution any type below the bound may replace. No method, beyond what `dispatchTargets` refuses, when the type is a
 * type variable with no bound or several, an enum or an annotation type; when a type at or above it is outside the repository, whose members the
 * sources do not state, unless it is a platform interface that declares none (`MEMBERLESS_PLATFORM_INTERFACES`); when its
 * members of the name, its own and inherited, offer no single signature for the call — a member whose stated parameter
 * types equal the arguments' settled signature binds it, since an exact match is the most specific applicable method
 * (JLS 15.12.2.5), and otherwise every member of the call's arity must state the same signature, with no varargs and no
 * inaccessible private declaration, a `protected` member of another package withholds the selection (JLS 6.6), and a
 * static call names no instance method — or the name is one of `Object`'s methods; when the call sits in an
 * anonymous or a local class; when a source holds an annotation by which a processor adds overloads or rewrites calls
 * (`CALL_REWRITING_ANNOTATIONS`); or when the declared hierarchy does not settle the member. Declaration selection and
 * runtime dispatch are separate obligations. An unproven value receiver or declared repository member remains a cut,
 * naming the declarations of the call's arity its type offers where the whole hierarchy was read; no name-only index
 * target proves it. Non-Java and non-invocation sites remain unknown.
 */
export function createJavaReceiverMethods(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[], facts?: DerivedFacts, hold?: ParseHold, build: ProjectBuild = {}): ImportOrigins["receiverMethods"] {
  const unreadJvm = paths.some(isUncoveredJvmSource);
  let layout: string | undefined;
  const resolved = async (sites: readonly ReceiverCallSite[], signal?: AbortSignal): Promise<readonly ReceiverMethod[]> => {
    const results: ReceiverMethod[] = sites.map(() => UNKNOWN);
    const analyze = (files: readonly JavaFile[], unparsed: readonly UnparsedSource[], project: JavaProject): readonly ReceiverMethod[] => {
      const proves = provesBinding(files, project, unparsed, unreadJvm);
      const byPath = new Map(files.map((file) => [file.path, file]));
      const readFiles = new Map<string, ReadFile>();
      const readFile = (path: string): ReadFile | undefined => {
        const file = byPath.get(path);
        if (file === undefined) return undefined;
        let known = readFiles.get(path);
        if (known === undefined) {
          known = { file, bindings: new Map(javaReceiverBindings(file.root, { declaredFields: true }).map((binding) => [callKey(binding.line, binding.column, binding.member), binding])), invocations: invocationsOf(file.root) };
          readFiles.set(path, known);
        }
        return known;
      };
      const resolver = createResolver(project, !paths.some((path) => LOMBOK_CONFIG.test(path)));
      for (const [index, site] of sites.entries()) {
        if (signal?.aborted) break;
        const source = readFile(site.file);
        const invocations = source?.invocations.get(callKey(site.line, site.column, site.member)) ?? [];
        if (source === undefined || invocations.length !== 1) continue;
        const invocation = invocations[0]!;
        if (invocation.type === "object_creation_expression") {
          results[index] = (proves ? resolver.creationOf(invocation, source.file) : undefined) ?? UNKNOWN;
          continue;
        }
        const supplied = proves && invocation.type === "method_reference" ? resolver.suppliedReference(invocation, source.file) : undefined;
        if (supplied !== undefined) {
          results[index] = supplied;
          continue;
        }
        if (invocation.type === "method_reference") {
          const named = proves ? resolver.referenceOf(invocation, source.file) : undefined;
          results[index] = named === undefined ? UNPROVEN : "method" in named ? placedAt(named.method) : { kind: "unproven", candidates: named.candidates.map(placeOf).sort(byPlace) };
          continue;
        }
        if (invocation.type === "explicit_constructor_invocation") {
          const chained = resolver.constructorOf(invocation, source.file);
          results[index] = chained === undefined ? UNKNOWN : chained === "unproven" || !proves ? UNPROVEN : placedAt(chained);
          continue;
        }
        const named = proves ? resolver.methodOf(invocation, source) : undefined;
        if (named !== undefined && "method" in named) results[index] = { ...placedAt(named.method), ...(named.bound ? { bound: true as const } : {}) };
        else if (named !== undefined && "generated" in named) results[index] = GENERATED;
        else if (named !== undefined) results[index] = { kind: "unproven", candidates: named.candidates };
        else if (resolver.hasDeclaredReceiver(invocation, source) || resolver.holdsValue(invocation, source.file)) results[index] = UNPROVEN;
      }
      return results;
    };
    const read = await parser();
    const held = hold === undefined ? undefined : await heldJavaProject(hold, () => Promise.resolve(read), sources, [], build);
    if (held !== undefined) return analyze(held.files.map(({ file }) => file), held.unparsed, held.project);
    return withJavaSources(read, (parse) => {
      const { files, unparsed } = parse(sources);
      return analyze(files, unparsed, createJavaProject(files, build));
    });
  };
  return async (sites, signal) => {
    if (sites.length === 0) return [];
    if (facts === undefined) return resolved(sites, signal);
    layout ??= facts.fingerprint({ java: sources.map(({ path, content }) => [path, content]), paths, generatesInterfaces: build.generatesInterfaces === true });
    try {
      return await facts.ofInputs(SLOT, { layout, sites }, async () => {
        const results = await resolved(sites, signal);
        if (signal?.aborted) throw new DeadlineCut(results);
        return results;
      });
    } catch (error) {
      if (error instanceof DeadlineCut) return error.results;
      throw error;
    }
  };
}

/**
 * `ImportOrigins.implementedDeclarations` for Java sources: a method implements or overrides the methods of the supertypes
 * in the repository that declare the same parameter types (JLS 8.4.8.1), read from the declared hierarchy. A signature the
 * sources do not settle answers `unknown`, so the by-name bridge keeps its reach: a type variable on either side, an unread
 * parameter type, a source the reader does not place, and any supertype the sources do not declare exactly once (a
 * platform type aside), since such a supertype may declare the contract. `declarations`, possibly empty, is therefore
 * established only from a hierarchy the reader read in full.
 */
export function createJavaImplementedDeclarations(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[], hold?: ParseHold, build: ProjectBuild = {}): ImportOrigins["implementedDeclarations"] {
  const unreadJvm = paths.some(isUncoveredJvmSource);
  const analyze = (sites: readonly ImplementingSite[], files: readonly JavaFile[], unparsed: readonly UnparsedSource[], project: JavaProject): readonly ImplementedDeclarations[] => {
    if (!provesBinding(files, project, unparsed, unreadJvm)) return sites.map(() => UNKNOWN_DECLARATIONS);
    const methods = methodsByPlace(project);
    const hierarchies = new Map<TypeDecl, ReturnType<JavaProject["hierarchy"]>>();
    const signatures = new Map<MethodDecl, Signature | undefined>();
    const hierarchyOf = (type: TypeDecl) => {
      if (!hierarchies.has(type)) hierarchies.set(type, project.hierarchy(type));
      return hierarchies.get(type)!;
    };
    const signatureOf = (method: MethodDecl) => {
      if (!signatures.has(method)) signatures.set(method, readSignature(method, project));
      return signatures.get(method);
    };
    return sites.map((site) => {
      const named = methods.get(`${site.file}:${site.start}:${site.name}`) ?? [];
      const method = named.length === 1 ? named[0] : undefined;
      if (method === undefined) return UNKNOWN_DECLARATIONS;
      const signature = signatureOf(method);
      if (signature === undefined || signature.some(isVariable)) return UNKNOWN_DECLARATIONS;
      const { types, gaps } = hierarchyOf(method.owner);
      if (gaps.length > 0) return UNKNOWN_DECLARATIONS;
      const found: MethodPlace[] = [];
      for (const type of types) {
        if (type === method.owner) continue;
        for (const candidate of type.methods) {
          if (candidate.name !== method.name) continue;
          const other = signatureOf(candidate);
          if (other === undefined || other.some(isVariable)) return UNKNOWN_DECLARATIONS;
          if (sameSignature(signature, other)) found.push(placeOf(candidate));
        }
      }
      return { kind: "declarations", declarations: found.toSorted(byPlace) };
    });
  };
  return async (sites) => {
    if (sites.length === 0) return [];
    const read = await parser();
    const held = hold === undefined ? undefined : await heldJavaProject(hold, () => Promise.resolve(read), sources, [], build);
    if (held !== undefined) return analyze(sites, held.files.map(({ file }) => file), held.unparsed, held.project);
    return withJavaSources(read, (parse) => {
      const { files, unparsed } = parse(sources);
      return analyze(sites, files, unparsed, createJavaProject(files, build));
    });
  };
}

/**
 * `ImportOrigins.implicitChains` for Java sources: the implicit `super()` of a class's construction (JLS 8.8.7) passes no
 * arguments, so it names the superclass's constructor of no arguments, or the default constructor the language supplies a
 * superclass that writes none (JLS 8.8.9). A record or an enum chains to the platform, and so does a class whose
 * superclass the sources do not declare. `unknown` when the strict reading proves no binding, the class is not placed, the
 * strict lexical and import rules do not settle its superclass, or that superclass holds an annotation by which a processor may add constructors, declares a
 * varargs constructor, or writes constructors and none of no arguments.
 */
export function createJavaImplicitChains(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[], hold?: ParseHold, build: ProjectBuild = {}): NonNullable<ImportOrigins["implicitChains"]> {
  return perPlacedType(parser, sources, paths, hold, build, UNKNOWN_CHAIN, implicitChainOf);
}

/**
 * `ImportOrigins.declaredSupertypes` for Java sources: each entry of a type's clauses bound by the project's one resolver
 * in its strict reading, from the scope around the type, since a clause is outside the type's body (JLS 6.3, 8.1.4). A
 * name the strict reading leaves unsettled, ambiguous or bound to a local type is `unknown`; a platform type, or a name an
 * import or a package qualifier proves outside the repository, is `outside`. A written name binds at compile time, so
 * only a declaration the reader does not read leaves it unproven: a dynamic implementation or a call-rewriting
 * annotation changes what runs, never which type a name denotes, and a body that does not parse declares only types
 * local to it, which no clause outside it can name. The class body of an enum constant extends its enum (JLS 8.9.1),
 * which its own file settles.
 */
export function createJavaDeclaredSupertypes(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[], hold?: ParseHold, build: ProjectBuild = {}): NonNullable<ImportOrigins["declaredSupertypes"]> {
  return perPlacedType(parser, sources, paths, hold, build, UNKNOWN_SUPERTYPES, declaredSupertypesOf, "declarations", enumConstantSupertypes);
}

/**
 * One answer per site from the one type the site places, `unknown` where none or several are placed or the reading proves
 * no binding: `bindings` holds where `provesBinding` does, over the read sources; `declarations` where every declaration
 * is read (`readsEveryDeclaration`), over the project that holds the declarations of the sources whose syntax errors lie
 * in member bodies, since a type such a body declares is local to it and no site places one. `settled` answers first a
 * site its own file settles.
 */
function perPlacedType<A>(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[], hold: ParseHold | undefined, build: ProjectBuild, unknown: A, answer: (type: TypeDecl, project: JavaProject) => A, reading: "bindings" | "declarations" = "bindings", settled?: (site: ConstructedClassSite, project: JavaProject) => A | undefined): (sites: readonly ConstructedClassSite[]) => Promise<readonly A[]> {
  const unreadJvm = paths.some(isUncoveredJvmSource);
  const analyze = (sites: readonly ConstructedClassSite[], files: readonly JavaFile[], unparsed: readonly UnparsedSource[], declared: readonly JavaFile[], project: JavaProject, declarations: JavaProject): readonly A[] => {
    const proves = reading === "declarations" ? readsEveryDeclaration(declarations, unparsed, declared, unreadJvm) : provesBinding(files, project, unparsed, unreadJvm);
    const read = reading === "declarations" ? declarations : project;
    if (!proves) return sites.map((site) => settled?.(site, read) ?? unknown);
    return sites.map((site) => {
      const own = settled?.(site, read);
      if (own !== undefined) return own;
      const placed = read.types.filter((type) => type.file.path === site.file && type.name === site.name && typePlace(type).start <= site.line && site.line <= typePlace(type).nameLine);
      return placed.length === 1 ? answer(placed[0]!, read) : unknown;
    });
  };
  return async (sites) => {
    if (sites.length === 0) return [];
    const read = await parser();
    const held = hold === undefined ? undefined : await heldJavaProject(hold, () => Promise.resolve(read), sources, [], build);
    if (held !== undefined) return analyze(sites, held.files.map(({ file }) => file), held.unparsed, held.declared, held.project, held.declarations);
    return withJavaSources(read, (parse) => {
      const parsed = parse(sources);
      const project = createJavaProject(parsed.files, build);
      return analyze(sites, parsed.files, parsed.unparsed, parsed.declared, project, declarationsProject(parsed, project, build));
    });
  };
}

/** The enum an enum constant with a class body at the site extends, by the enum's name; none for any other site. */
function enumConstantSupertypes(site: ConstructedClassSite, project: JavaProject): DeclaredSupertypes | undefined {
  const isBodiedAtSite = (constant: Node): boolean => {
    const name = constant.childForFieldName("name");
    return constant.type === "enum_constant" && constant.childForFieldName("body") !== null && name?.text === site.name && constant.startPosition.row + 1 <= site.line && site.line <= name.startPosition.row + 1;
  };
  const enums = project.types.filter((type) => type.file.path === site.file && type.node.type === "enum_declaration" && namedChildren(type.node.childForFieldName("body") ?? type.node).some(isBodiedAtSite));
  if (enums.length !== 1) return undefined;
  const { name } = enums[0]!;
  return { kind: "supertypes", supertypes: [{ relation: "extends", written: name, kind: "placed", name, ...typePlace(enums[0]!) }] };
}

function declaredSupertypesOf(type: TypeDecl, project: JavaProject): DeclaredSupertypes {
  const scope = enclosingType(type.node.parent ?? type.node, type.file, project);
  const supertypes = supertypeClauses(type).map(({ node, isInterface }): DeclaredSupertype => {
    const clause = { relation: isInterface && type.kind !== "interface" ? "implements" : "extends", written: typeNodeName(node).replace(/\s+/g, "") } as const;
    const found = resolve(node, type.file, project, scope, node, true);
    if (found?.kind === "repository") return found.type === undefined ? { ...clause, kind: "unknown" } : { ...clause, kind: "placed", name: found.type.name, ...typePlace(found.type) };
    if (found !== undefined) return { ...clause, kind: "outside", qualifiedName: found.fqn };
    const outside = onDemandOutside(clause.written, { file: type.file, type: scope, at: node }, project);
    return outside === undefined ? { ...clause, kind: "unknown" } : { ...clause, kind: "outside", ...outside };
  });
  return { kind: "supertypes", supertypes };
}

/**
 * Where a simple name that no declaration of the repository binds is proven to bind a type outside it, through
 * `java.lang`, the on-demand imports and the member types of the types around the scope (JLS 6.4.1, 7.5.2, 8.5); by its
 * qualified name where the sources settle it. A package whose names are listed offers the name by its listing, and a
 * package the sources do not declare may offer any name; under the repository-compiles assumption the name is the one
 * listed package's that offers it, else the one unlisted package's, and several such packages leave it outside without
 * a name; so does a name none of them offers, which a package of the repository gains from sources the snapshot does
 * not hold. A type around the scope with a supertype the sources do not declare may declare a member type of the name
 * outside the repository, which leaves it outside without a name; one the repository declares more than once may declare
 * it inside, and an on-demand import of a type offers its members, so either proves nothing.
 */
function onDemandOutside(name: string, scope: Scope, project: JavaProject): { qualifiedName?: string } | undefined {
  if (name.includes(".")) return undefined;
  let outsideAround = false;
  for (let around = scope.type; around !== undefined; around = around.outer) {
    const { gaps } = project.hierarchy(around, (node, owner) => project.lookupType(typeNodeName(node), scopeOf(owner)));
    if (gaps.some((gap) => gap.kind !== "missing")) return undefined;
    outsideAround ||= gaps.length > 0;
  }
  const sources = project.importedTypeSources(name, scope);
  if (sources === undefined || !("containers" in sources)) return undefined;
  const listed: string[] = [];
  const unlisted: string[] = [];
  for (const container of new Set(sources.containers)) {
    const offered = `${container}.${name}`;
    const names = PLATFORM_TYPE_NAMES.get(container);
    if (names !== undefined && project.isPlatformName(offered)) {
      if (names.has(name)) listed.push(offered);
    } else if (project.lookupType(container, { file: scope.file, type: undefined }) !== undefined) return undefined;
    else if (!project.types.some((type) => type.file.packageName === container)) unlisted.push(offered);
  }
  const offered = listed.length > 0 ? listed : unlisted;
  return offered.length === 1 && !outsideAround ? { qualifiedName: offered[0]! } : {};
}

function implicitChainOf(type: TypeDecl, project: JavaProject): ImplicitChain {
  const written = type.node.type === "class_declaration" ? type.node.childForFieldName("superclass")?.namedChildren[0] : undefined;
  const raw = written?.type === "generic_type" ? written.namedChildren[0] : written;
  if (raw === undefined || raw === null) return NO_CHAIN;
  const above = project.resolveTypeName(raw.text, { file: type.file, type: type.outer });
  if (above === undefined) return NO_CHAIN;
  if (above === "ambiguous" || above === "unsettled" || "local" in above || above.node.type !== "class_declaration" || mayGenerateConstructors(above.node)) return UNKNOWN_CHAIN;
  if (above.constructors.length === 0) return { kind: "supplied", ...typePlace(above) };
  if (above.constructors.some(hasVarargs)) return UNKNOWN_CHAIN;
  const runs = above.constructors.filter((constructor) => constructorArity(constructor) === 0);
  return runs.length === 1 ? { kind: "constructor", ...placeOf(runs[0]!) } : UNKNOWN_CHAIN;
}

/** The methods of a project by file, first line and name, each place with every declaration it names. */
function methodsByPlace(project: JavaProject): ReadonlyMap<string, readonly MethodDecl[]> {
  const methods = new Map<string, MethodDecl[]>();
  for (const type of project.types) {
    for (const method of type.methods) {
      const key = `${type.file.path}:${placeOf(method).start}:${method.name}`;
      const named = methods.get(key) ?? [];
      named.push(method);
      methods.set(key, named);
    }
  }
  return methods;
}

function isVariable(parameter: Signature[number]): boolean {
  return "variable" in parameter;
}

/** An answer a deadline cut, which no derived fact retains. */
class DeadlineCut extends Error {
  constructor(readonly results: readonly ReceiverMethod[]) {
    super("deadline");
  }
}

/**
 * Whether the strict binding may prove anything over these files: the port's own conditions. A source the read left
 * unparsed, a JVM source no extractor reads, a declaration the project could not read, a dynamic implementation or a
 * call-rewriting annotation anywhere leaves every binding unproven.
 */
export function provesBinding(files: readonly JavaFile[], project: JavaProject, unparsed: readonly UnparsedSource[], unreadJvm: boolean): boolean {
  return readsEverySource(project, unparsed, unreadJvm) && !files.some((file) => namesAnyDynamicImplementation(file, project)) && !files.some(({ root }) => rewritesCalls(root));
}

/**
 * Whether the reader read every declaration: each source it left unparsed has its declarations read (`declared`, its
 * syntax errors confined to member bodies), no JVM source no extractor reads, no declaration the project could not read.
 */
function readsEveryDeclaration(declarations: JavaProject, unparsed: readonly UnparsedSource[], declared: readonly JavaFile[], unreadJvm: boolean): boolean {
  const read = new Set(declared.map(({ path }) => path));
  return unparsed.every(({ path }) => read.has(path)) && !unreadJvm && declarations.unreadable.length === 0;
}

/** Whether the reader read every source: none left unparsed, no JVM source no extractor reads, no declaration the project could not read. */
function readsEverySource(project: JavaProject, unparsed: readonly UnparsedSource[], unreadJvm: boolean): boolean {
  return unparsed.length === 0 && !unreadJvm && project.unreadable.length === 0;
}

/** `generated`: whether the members that a record or a Lombok annotation adds are settled (no `lombok.config` may rename them). */
export function createResolver(project: JavaProject, generated = false) {
  const hierarchies = new Map<TypeDecl, ReturnType<JavaProject["hierarchy"]>>();
  /** The supertype clauses, by file and offset, that name a platform interface declaring no members. */
  const memberless = new Set<string>();
  const clauseKey = (file: JavaFile, node: Node): string => `${file.path}:${node.startIndex}`;
  /**
   * Whether a type's hierarchy leaves its members unsettled: a supertype the sources do not declare, but for a platform
   * interface that declares none and a generated interface of operations, which is open to nothing a class of the
   * hierarchy declares (ADR-0062).
   */
  const unsettledGaps = (above: ReturnType<JavaProject["hierarchy"]>) => above.gaps.filter((gap) => !memberless.has(clauseKey(gap.file, gap.node)));
  const hierarchyOpen = (above: ReturnType<JavaProject["hierarchy"]>, declared: readonly MethodDecl[]): boolean => {
    const unsettled = unsettledGaps(above);
    return unsettled.some((gap) => !(gap.kind === "missing" && gap.isInterface && project.isGeneratedInterface(gap.name, gap.file))) || (unsettled.length > 0 && declared.some((method) => method.owner.kind !== "class"));
  };
  /** Whether a supertype gap is a superclass the sources do not declare whose name resolves to one known outside type, by import or qualified name. */
  const isOutsideSuperclass = (gap: ReturnType<JavaProject["hierarchy"]>["gaps"][number]): boolean => {
    if (gap.isInterface || gap.kind !== "missing") return false;
    const owner = enclosingType(gap.node, gap.file, project);
    const found = resolve(gap.node, gap.file, project, owner === undefined ? undefined : enclosingType(owner.node.parent ?? owner.node, gap.file, project), gap.node, true);
    return found?.kind === "library" || found?.kind === "platform";
  };
  /**
   * Whether the hierarchy is open only through superclasses outside the sources that resolve to a known type. A member a
   * class of the sources generates for its own field is declared in that class, so such a supertype can add only an
   * overload whose body is outside the repository.
   */
  const hierarchyOpenOnlyOutsideSuperclasses = (above: ReturnType<JavaProject["hierarchy"]>): boolean =>
    unsettledGaps(above).every((gap) => (gap.kind === "missing" && gap.isInterface && project.isGeneratedInterface(gap.name, gap.file)) || isOutsideSuperclass(gap));
  const declaredHierarchy = (type: TypeDecl) => {
    let known = hierarchies.get(type);
    if (known === undefined) {
      known = project.hierarchy(type, (node, owner) => {
        const found = resolve(node, owner.file, project, enclosingType(owner.node.parent ?? owner.node, owner.file, project), node);
        if (found?.kind === "platform" && MEMBERLESS_PLATFORM_INTERFACES.has(found.fqn)) memberless.add(clauseKey(owner.file, node));
        return found?.kind === "repository" ? found.type : undefined;
      });
      hierarchies.set(type, known);
    }
    return known;
  };
  const signatures = new Map<MethodDecl, ReturnType<typeof readSignature>>();
  const signatureOf = (method: MethodDecl) => {
    if (!signatures.has(method)) signatures.set(method, readSignature(method, project));
    return signatures.get(method);
  };

  /**
   * The repository type the receiver of an invocation is declared to hold; none when nothing proves one. `bound` when a
   * type variable types the receiver, or a receiver up its chain: the type is the variable's one bound (JLS 4.4).
   * `typeName` when the receiver is a name that denotes the type itself, so the call must name a static method. `builder`
   * when the receiver is the generated builder of the type.
   */
  const receiverOf = (invocation: Node, source: ReceiverSource): { type: TypeDecl; bound: boolean; typeName: boolean; builder?: true } | undefined => {
    const object = invocation.childForFieldName("object");
    const declared = (type: TypeDecl | undefined, bound = false, typeName = false) => (type === undefined ? undefined : { type, bound, typeName });
    if (object === null || object.type === "this") return declared(thisType(invocation, source.file, project));
    if (object.type === "method_invocation") {
      const called = methodNamed(object, source);
      if (called !== undefined && "generated" in called) return generatedResult(called.generated);
      return called === undefined || !("method" in called) ? undefined : declared(returnTypeOf(called.method), called.bound);
    }
    const binding = source.bindings.get(callKey(invocation.startPosition.row + 1, invocation.startPosition.column + 1, invocation.childForFieldName("name")?.text ?? ""));
    const receiver = object.type === "identifier" ? object.text : object.type === "field_access" ? object.childForFieldName("field")?.text : undefined;
    if (binding === undefined || binding.receiver !== receiver || binding.holds.kind !== "annotated") {
      return object.type === "identifier" && localBinding(object) === undefined && !fieldAround(object, source.file, project) ? declared(repositoryType(object, source.file, object), false, true) : undefined;
    }
    const name = annotationAt(source.file.root, binding.holds.line, binding.holds.column, binding.holds.type);
    if (name === undefined) return undefined;
    const variable = typeVariableAround(name);
    if (variable === undefined) return declared(repositoryType(name, source.file, name));
    const bounds = variable.namedChildren.find((child) => child?.type === "type_bound")?.namedChildren ?? [];
    return bounds.length === 1 ? declared(repositoryType(bounds[0]!, source.file, bounds[0]!), true) : undefined;
  };

  /**
   * The one method of the name that the receiver's declared type offers for the call's arguments, or the declarations of
   * the call's arity it cannot single one out of.
   */
  const methodNamed = (invocation: Node, source: ReceiverSource): { method: MethodDecl; bound: boolean } | { candidates: readonly MethodPlace[] } | { generated: GeneratedMember } | undefined => {
    const held = receiverOf(invocation, source);
    const name = invocation.childForFieldName("name")?.text;
    if (held === undefined || name === undefined) return undefined;
    if (held.builder === true) {
      const made = generated ? builderMember(held.type, project, name, argumentCount(invocation)) : undefined;
      return made === undefined ? undefined : { generated: made };
    }
    const caller = enclosingType(invocation, source.file, project);
    const supplied = held.bound || held.typeName ? undefined : repositoryMemberOf(held.type, name, invocation, caller);
    if (supplied !== undefined) return "method" in supplied ? { method: supplied.method, bound: false } : { generated: PROXIED };
    const offered = memberOf(held.type, name, invocation, source.file, caller);
    if (offered === undefined) {
      const made = generated && !held.bound ? generatedOf(held, name, argumentCount(invocation)) : undefined;
      return made === undefined ? undefined : { generated: made };
    }
    if ("candidates" in offered) return { candidates: offered.candidates.map(placeOf).sort(byPlace) };
    return held.typeName && !offered.method.modifiers.includes("static") ? undefined : { method: offered.method, bound: held.bound };
  };

  /**
   * The hierarchy of an interface whose every supertype outside the sources is a Spring Data repository interface of the
   * closed vocabulary (ADR-0070): its members are the ones the sources state and the vocabulary's operations.
   */
  const dataRepositoryHierarchy = (type: TypeDecl): ReturnType<JavaProject["hierarchy"]> | undefined => {
    if (type.kind !== "interface") return undefined;
    const above = declaredHierarchy(type);
    const outside = unsettledGaps(above);
    const vocabulary = outside.length > 0 && outside.every((gap) => {
      const owner = enclosingType(gap.node, gap.file, project);
      const found = resolve(gap.node, gap.file, project, owner?.outer, gap.node);
      return found?.kind === "platform" && (REPOSITORY_TYPES.has(found.fqn) || REPOSITORY_FRAGMENTS.has(found.fqn));
    });
    return vocabulary ? above : undefined;
  };

  /**
   * What a call on a repository interface of the vocabulary names: a body-less method the repository hierarchy declares,
   * or an operation of the vocabulary nothing in it declares, is supplied by the Spring proxy; a method with a body is its
   * own. An operation name the repository redeclares, overloads no signature settles and members the hierarchy does not
   * state name nothing.
   */
  const repositoryMemberOf = (type: TypeDecl, name: string, invocation: Node, caller: TypeDecl | undefined): { method: MethodDecl } | GeneratedMember | undefined => {
    const above = dataRepositoryHierarchy(type);
    if (above === undefined || OBJECT_METHODS.has(name)) return undefined;
    const named = above.types.flatMap((ancestor) => ancestor.methods.filter((method) => method.name === name));
    if (named.length === 0) return REPOSITORY_OPERATIONS.has(name) ? PROXIED : undefined;
    if (REPOSITORY_MEMBER_NAMES.has(name) || named.some(hasVarargs)) return undefined;
    const candidates = named.filter((method) => method.parameterTypes.length === argumentCount(invocation));
    const chosen = candidates.length === 1 ? candidates[0] : caller === undefined ? undefined : exactCandidate(candidates, invocation, caller);
    if (chosen === undefined) return undefined;
    return chosen.hasBody ? { method: chosen } : PROXIED;
  };

  /** A member that a record or a Lombok annotation adds, when no type of the closed hierarchy declares the name and a static call names a static member. */
  const generatedOf = (held: { type: TypeDecl; typeName: boolean }, name: string, arity: number): GeneratedMember | undefined => {
    const above = declaredHierarchy(held.type);
    if (OBJECT_METHODS.has(name) || (hierarchyOpen(above, []) && !hierarchyOpenOnlyOutsideSuperclasses(above)) || above.types.some((owner) => owner.methods.some((method) => method.name.toLowerCase() === name.toLowerCase()))) return undefined;
    const made = generatedMember(held.type, project, name, arity);
    return made === undefined || (held.typeName && made.kind !== "builder") ? undefined : made;
  };

  /** The receiver a generated member yields: the field's type for an accessor, the builder or the built type for a builder. */
  const generatedResult = (made: GeneratedMember): { type: TypeDecl; bound: boolean; typeName: boolean; builder?: true } | undefined => {
    if (made.kind === "builder") return { type: made.of, bound: false, typeName: false, builder: true };
    if (made.kind === "built") return { type: made.of, bound: false, typeName: false };
    const type = made.kind === "accessor" && made.type !== undefined ? repositoryType(made.type, made.file, made.type) : undefined;
    return type === undefined ? undefined : { type, bound: false, typeName: false };
  };

  const referenceOf = (reference: Node, file: JavaFile): { method: MethodDecl } | { candidates: readonly MethodDecl[] } | undefined => {
    const object = reference.namedChildren[0];
    if (object === undefined || object === null) return undefined;
    const constructor = reference.children.some((child) => child?.type === "new");
    const name = constructor ? undefined : reference.namedChildren.at(-1)?.text;
    let type: TypeDecl | undefined;
    if (object.type === "this") type = thisType(reference, file, project);
    else {
      const local = object.type === "identifier" ? localBinding(object) : undefined;
      const fieldName = object.type === "field_access" && object.childForFieldName("object")?.type === "this" ? object.childForFieldName("field")?.text : object.type === "identifier" ? object.text : undefined;
      const field = local === undefined && fieldName !== undefined ? fieldsOf(enclosingBody(object) ?? file.root).filter((candidate) => candidate.childForFieldName("name")?.text === fieldName) : [];
      const declaration = local ?? (field.length === 1 ? field[0] : undefined);
      const annotation = declaration?.type === "variable_declarator" ? declaration.parent?.childForFieldName("type") : declaration?.childForFieldName("type");
      type = annotation == null ? (declaration === undefined ? repositoryType(object, file, object) : undefined) : repositoryType(annotation, file, annotation);
    }
    if (type === undefined) return undefined;
    if (!constructor && (name === undefined || OBJECT_METHODS.has(name))) return undefined;
    const above = declaredHierarchy(type);
    const candidates = constructor ? type.constructors : above.types.flatMap((ancestor) => ancestor.methods.filter((method) => method.name === name));
    if (!constructor && hierarchyOpen(above, candidates)) return undefined;
    if (candidates.some((method) => reachability(method, file) === "unknown" || (method.modifiers.includes("private") && method.owner !== enclosingType(reference, file, project)))) return undefined;
    const reachable = candidates.filter((method) => reachability(method, file) === "reachable");
    return reachable.length === 1 ? { method: reachable[0]! } : { candidates: reachable };
  };

  /** The repository type a method declares it returns: none for a type variable, an array, a primitive or a type outside the repository. */
  const returnTypeOf = (method: MethodDecl): TypeDecl | undefined => {
    const type = method.node.childForFieldName("type");
    return type === null ? undefined : repositoryType(type, method.owner.file, type);
  };

  const repositoryType = (name: Node, file: JavaFile, at: Node): TypeDecl | undefined => {
    const resolved = resolve(name, file, project, enclosingType(at, file, project), at);
    return resolved?.kind === "repository" && resolved.type !== undefined && (resolved.type.kind === "class" || resolved.type.kind === "interface") ? resolved.type : undefined;
  };

  /**
   * What a call of `name` with `invocation`'s arguments on a value of `type` is resolved to, among the members the call's
   * file reaches: the member whose stated parameter types equal the arguments' settled signature (JLS 15.12.2.5), else
   * the reachable members of the name, declared and inherited, must be one signature at the call's arity, so overload
   * resolution has one candidate; the type's own, else the nearest up its class chain, else the only one. The
   * declarations of that arity it cannot single one out of are its answer when the selection settles none. A member whose
   * reach is unknown withholds the selection.
   */
  const memberOf = (type: TypeDecl, name: string, invocation: Node, file: JavaFile, caller: TypeDecl | undefined): { method: MethodDecl } | { candidates: readonly MethodDecl[] } | undefined => {
    if (OBJECT_METHODS.has(name)) return undefined;
    const above = declaredHierarchy(type);
    const named = above.types.flatMap((ancestor) => ancestor.methods.filter((method) => method.name === name));
    if (hierarchyOpen(above, named)) return undefined;
    if (named.some(hasVarargs)) return undefined;
    const candidates = named.filter((method) => method.parameterTypes.length === argumentCount(invocation));
    if (candidates.some((method) => method.modifiers.includes("private") && (method.owner !== type || method.owner !== caller))) return undefined;
    const reach = candidates.map((method) => reachability(method, file));
    if (reach.includes("unknown")) return undefined;
    const reachable = candidates.filter((_, index) => reach[index] === "reachable");
    const [first] = reachable;
    if (first === undefined) return undefined;
    const exact = caller === undefined ? undefined : exactCandidate(reachable, invocation, caller);
    if (exact !== undefined) return { method: exact };
    if (reachable.some((method) => method !== first && !sameStatedSignature(method, first))) return { candidates: reachable };
    for (const current of project.classChain(type)) {
      const own = reachable.find((method) => method.owner === current);
      if (own !== undefined) return { method: own };
    }
    return reachable.length === 1 ? { method: first } : { candidates: reachable };
  };

  /**
   * The one member whose stated parameter types equal the arguments' settled signature, the most specific applicable
   * method (JLS 15.12.2.5); none when the arguments or every candidate's signature are not settled, or no single member
   * matches. The erasure a signature keeps drops type arguments, and a raw argument is applicable to a parameterized
   * parameter by unchecked conversion, so when a candidate states type arguments every argument must be plain.
   */
  const exactCandidate = (candidates: readonly MethodDecl[], invocation: Node, caller: TypeDecl): MethodDecl | undefined => {
    const signature = readArgumentSignature(invocation, { file: caller.file, type: caller, at: invocation }, project);
    if (signature === undefined) return undefined;
    if (candidates.some(statesTypeArguments) && !signature.every(isPlainArgument)) return undefined;
    const matching = candidates.filter((candidate) => {
      const stated = signatureOf(candidate);
      return stated !== undefined && sameSignature(stated, signature);
    });
    return matching.length === 1 ? matching[0] : undefined;
  };

  /** Whether an argument's type is certainly not generic: a primitive, a platform type that is not generic, or a repository type with no type variable around it. */
  const isPlainArgument = (argument: Signature[number]): boolean => {
    if ("variable" in argument) return false;
    if (PRIMITIVES.has(argument.name) || PLAIN_PLATFORM_TYPES.has(argument.name)) return true;
    const declared = project.types.find((type) => type.fqn === argument.name);
    return declared !== undefined && !hasTypeVariables(declared);
  };

  /** Whether two members certainly state the same parameter types, each as the strict reading settles them. */
  const sameStatedSignature = (method: MethodDecl, other: MethodDecl): boolean => {
    const own = signatureOf(method);
    const others = signatureOf(other);
    return own !== undefined && others !== undefined && sameSignature(own, others);
  };

  /**
   * The constructor a `super(...)` or `this(...)` names: the one of the superclass, or of the class, with the call's
   * arity, a compact canonical constructor counting the record's components. None when the superclass is outside the
   * repository or the record's canonical constructor is implicit; `unproven` when the type declares no single
   * constructor of that arity, or one with varargs.
   */
  const constructorOf = (invocation: Node, file: JavaFile): MethodDecl | "unproven" | undefined => {
    const type = thisType(invocation, file, project);
    const target = type === undefined ? undefined : invocation.childForFieldName("constructor")?.text === "super" ? project.classChain(type)[1] : type;
    if (target === undefined) return undefined;
    const arity = argumentCount(invocation);
    if (target.constructors.some(hasVarargs)) return "unproven";
    const candidates = target.constructors.filter((constructor) => constructorArity(constructor) === arity);
    if (candidates.length === 1) return candidates[0];
    const implicitCanonical = target.node.type === "record_declaration" && arity === recordComponents(target.node) && candidates.length === 0;
    return implicitCanonical || (target.constructors.length === 0 && arity === 0) ? undefined : "unproven";
  };

  /**
   * What a construction of `type` with `arity` arguments runs where the language supplies its constructor: `generated` for
   * a record's canonical constructor that no source writes, which only assigns the components (JLS 8.10.4), and
   * `supplied`, at `type`'s place, for the default constructor of a concrete class that writes none and holds no
   * annotation by which a processor may add one (JLS 8.8.9); none for any other construction.
   */
  const suppliedConstruction = (type: TypeDecl, arity: number): ReceiverMethod | undefined => {
    if (type.node.type === "record_declaration") return arity === recordComponents(type.node) && !type.constructors.some((constructor) => constructorArity(constructor) === arity) ? GENERATED : undefined;
    return type.node.type === "class_declaration" && !type.isAbstract && arity === 0 && type.constructors.length === 0 && !mayGenerateConstructors(type.node) ? { kind: "supplied", ...typePlace(type) } : undefined;
  };

  /** What `new T(...)` runs where the language supplies `T`'s constructor; none for a class body, a qualified creation or any other type. */
  const creationOf = (creation: Node, file: JavaFile): ReceiverMethod | undefined => {
    const written = creation.childForFieldName("type");
    if (creation.children[0]?.type !== "new" || written === null || creation.namedChildren.some((child) => child?.type === "class_body")) return undefined;
    const type = repositoryType(written, file, written);
    return type === undefined ? undefined : suppliedConstruction(type, argumentCount(creation));
  };

  /** What `T::new` runs where `T` writes no constructor, so the language supplies its only one. */
  const suppliedReference = (reference: Node, file: JavaFile): ReceiverMethod | undefined => {
    const object = reference.namedChildren[0];
    if (!reference.children.some((child) => child?.type === "new") || object === undefined || object === null) return undefined;
    const type = repositoryType(object, file, object);
    if (type === undefined || type.constructors.length > 0) return undefined;
    return suppliedConstruction(type, type.node.type === "record_declaration" ? recordComponents(type.node) : 0);
  };

  return {
    constructorOf,
    creationOf,
    suppliedReference,
    referenceOf,
    /** Whether every supertype of the interface outside the sources is a Spring Data repository interface of the closed vocabulary. */
    isDataRepository: (type: TypeDecl): boolean => dataRepositoryHierarchy(type) !== undefined,
    hasDeclaredReceiver: (invocation: Node, source: ReceiverSource): boolean => receiverOf(invocation, source) !== undefined,
    /** The method the call names through its declared receiver and one settled signature; dispatch decides its body separately. */
    methodOf: methodNamed,
    /**
     * Whether the call's receiver is a value the call reads, whose class the call's own place does not state: a variable
     * (a parameter, a local or a field, `this.f` included), a member read through another value (`a.b`), or what another
     * call returns. A bare call, a call on `this` or `super`, and a call on a name that denotes a type are not.
     */
    holdsValue: (invocation: Node, file: JavaFile): boolean => {
      const object = invocation.childForFieldName("object");
      if (object === null) return false;
      if (object.type === "method_invocation" || object.type === "field_access") return true;
      if (object.type !== "identifier") return false;
      if (localBinding(object) !== undefined || fieldAround(object, file, project)) return true;
      const named = resolve(object, file, project, enclosingType(object, file, project), object);
      return named === undefined;
    },
  };
}

/** Whether a source names a JDK API that implements an interface at run time, whose value may stand for any declared type. */
function namesAnyDynamicImplementation(file: JavaFile, project: JavaProject): boolean {
  const pending: Node[] = [file.root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (namesDynamicImplementation(node, file, project)) return true;
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return false;
}

/** Whether a lexical type or its hierarchy declares, or may supply, a field of the name. */
function fieldAround(identifier: Node, file: JavaFile, project: JavaProject): boolean {
  for (let body = enclosingBody(identifier); body !== undefined; body = enclosingBody(body)) if (fieldsOf(body).some((declarator) => declarator.childForFieldName("name")?.text === identifier.text)) return true;
  const type = enclosingType(identifier, file, project);
  if (type === undefined) return false;
  const above = project.hierarchy(type);
  return above.gaps.length > 0 || above.types.some((owner) => {
    const body = owner.node.childForFieldName("body");
    return body !== null && fieldsOf(body).some((declarator) => declarator.childForFieldName("name")?.text === identifier.text);
  });
}

function rewritesCalls(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if ((node.type === "marker_annotation" || node.type === "annotation") && CALL_REWRITING_ANNOTATIONS.has(node.childForFieldName("name")?.text.split(".").at(-1) ?? "")) return true;
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return false;
}

/** Method invocations by their member, `super(...)`/`this(...)` by their keyword and `new T(...)` by `T`'s simple name, at the place each starts. */
function invocationsOf(root: Node): ReadonlyMap<string, readonly Node[]> {
  const found = new Map<string, Node[]>();
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === "method_invocation" || node.type === "explicit_constructor_invocation" || node.type === "method_reference" || node.type === "object_creation_expression") {
      const constructor = node.type === "method_reference" && node.children.some((child) => child?.type === "new");
      const member = node.type === "object_creation_expression" ? simpleTypeName(node.childForFieldName("type")) : node.type === "method_reference" ? (constructor ? node.namedChildren[0]?.text.split(".").at(-1) : node.namedChildren.at(-1)?.text) : node.type === "method_invocation" ? node.childForFieldName("name")?.text : node.childForFieldName("constructor")?.text;
      const key = callKey(node.startPosition.row + 1, node.startPosition.column + 1, member ?? "");
      found.set(key, [...(found.get(key) ?? []), node]);
    }
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return found;
}

/** The simple name a written type ends with, without its qualifier or type arguments. */
function simpleTypeName(type: Node | null): string | undefined {
  const named = type?.type === "generic_type" ? type.namedChildren[0] : type;
  return named?.text.split(".").at(-1);
}

/** Annotations by which a processor may add constructors to a class the sources write none for. */
const CONSTRUCTOR_GENERATING_ANNOTATIONS: ReadonlySet<string> = new Set(["NoArgsConstructor", "AllArgsConstructor", "RequiredArgsConstructor", "Data", "Value", "Builder", "SuperBuilder"]);

function mayGenerateConstructors(declaration: Node): boolean {
  const modifiers = declaration.namedChildren.find((child) => child?.type === "modifiers");
  return (modifiers?.namedChildren ?? []).some((annotation) => (annotation?.type === "marker_annotation" || annotation?.type === "annotation") && CONSTRUCTOR_GENERATING_ANNOTATIONS.has(annotation.childForFieldName("name")?.text.split(".").at(-1) ?? ""));
}


function argumentCount(invocation: Node): number {
  return (invocation.childForFieldName("arguments")?.namedChildren ?? []).filter((argument) => argument !== null && !NOT_ARGUMENTS.has(argument.type)).length;
}

/** The arguments a constructor takes: a compact canonical one takes the record's components. */
function constructorArity(constructor: MethodDecl): number {
  return constructor.node.type === "compact_constructor_declaration" ? recordComponents(constructor.owner.node) : constructor.parameterTypes.length;
}

function recordComponents(record: Node): number {
  return (record.childForFieldName("parameters")?.namedChildren ?? []).filter((component) => component?.type === "formal_parameter").length;
}

/** How a file reaches a method (JLS 6.6): `unknown` when a protected member of another package depends on the receiver's type. */
type Reach = "reachable" | "hidden" | "unknown";

function reachability(method: MethodDecl, file: JavaFile): Reach {
  if (method.modifiers.some((modifier) => modifier === "public" || modifier === "private") || method.owner.kind === "interface" || method.owner.kind === "annotation") return "reachable";
  if (method.owner.file.packageName === file.packageName) return "reachable";
  return method.modifiers.includes("protected") ? "unknown" : "hidden";
}

/** Whether a method's parameters state type arguments, which the erasure its signature keeps drops. */
function statesTypeArguments(method: MethodDecl): boolean {
  return (method.node.childForFieldName("parameters")?.descendantsOfType("type_arguments") ?? []).length > 0;
}

/** Whether a type or a type around it declares a type variable, so its raw use is possible. */
function hasTypeVariables(type: TypeDecl): boolean {
  for (let current: TypeDecl | undefined = type; current !== undefined; current = current.outer) if (current.typeVariables.size > 0) return true;
  return false;
}

/** A method the index places by its file and the lines from its first token to its name (a compact constructor's first line). */
function placeOf(method: MethodDecl): MethodPlace {
  return { file: method.owner.file.path, start: method.node.startPosition.row + 1, nameLine: (method.node.childForFieldName("name") ?? method.node).startPosition.row + 1 };
}

/** A type by its file and the lines from its first token to its name. */
function typePlace(type: TypeDecl): MethodPlace {
  return { file: type.file.path, start: type.node.startPosition.row + 1, nameLine: (type.node.childForFieldName("name") ?? type.node).startPosition.row + 1 };
}

function placedAt(method: MethodDecl): Extract<ReceiverMethod, { kind: "method" }> {
  return { kind: "method", ...placeOf(method) };
}

/** The order a cut names candidates in: by file, then by the lines each declaration spans. */
function byPlace(first: MethodPlace, second: MethodPlace): number {
  return first.file < second.file ? -1 : first.file > second.file ? 1 : first.start - second.start || first.nameLine - second.nameLine;
}

export function hasVarargs(method: MethodDecl): boolean {
  return (method.node.childForFieldName("parameters")?.namedChildren ?? []).some((parameter) => parameter?.type === "spread_parameter");
}

export function callKey(line: number, column: number, member: string): string {
  return `${line}:${column}:${member}`;
}
