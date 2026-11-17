import type { Node } from "web-tree-sitter";
import { isUncoveredJvmSource } from "../../domain/languages/path-class.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DispatchSite, DispatchTargets, ImplementingSite, ImportOrigins, OutsideSupertypes } from "../../ports/import-origins.port.ts";
import { placeAt } from "../../domain/impact/impact-cuts.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import { FUNCTION_VALUE_AWAITS_JDK, type CutCause, type DispatchUnknownReason } from "../../domain/shared/fact.ts";
import type { LibraryReading } from "../../ports/library-signatures.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { questions } from "./java-declaration-questions.ts";
import type { KeptReads } from "./java-kept-reads.ts";
import { enclosingType, heldJavaProject, withJavaSources, type UnparsedSource } from "./java-project.ts";
import { methodsByPlace, provesBinding } from "./java-receiver-methods.ts";
import { FUNCTION_VALUES, isAnonymous, isAspect, namesDynamicImplementation, resolve, supertypesOf } from "./java-declared-types.ts";
import { awaitsDeclaredJdk, targetsOfFunctionValue, type FunctionTargets, type FunctionValue, type FunctionValueSources } from "./java-function-values.ts";
import { createJavaProject, isTypeDeclaration, MEMBERLESS_PLATFORM_INTERFACES, readSignature, sameSignature, type Signature, type JavaFile, type JavaProject, type MethodDecl, type ProjectBuild, type TypeDecl } from "./java-symbols.ts";

const UNKNOWN: DispatchTargets = { kind: "unknown", reason: "dispatch not proven" };
const UNKNOWN_OUTSIDE: OutsideSupertypes = { kind: "unknown" };
const OUTSIDE_SUPERTYPES_SLOT = "java-outside-supertypes";
/** The class every Java class extends when it writes no superclass (JLS 8.1.4). */
const ROOT_TYPE = "java.lang.Object";
const ASPECT_REASON = "aspect may replace the body" satisfies DispatchUnknownReason;
/** The one advice kind that receives the join point and decides whether the body runs; the other kinds run beside it (ADR-0091). */
const BODY_REPLACING_ADVICE = "Around";
/** Aspect members that make a type implement more than its declarations state. */
const INTRODUCTIONS: ReadonlySet<string> = new Set(["DeclareParents", "DeclareMixin"]);
const PARAMETERS: ReadonlySet<string> = new Set(["formal_parameter", "spread_parameter"]);
/** Annotations the language itself defines, which no generator or proxy reads to implement a type. */
const LANGUAGE_ANNOTATIONS: ReadonlySet<string> = new Set(["Override", "Deprecated", "SuppressWarnings", "FunctionalInterface"]);
/** The public methods of `Object` by name and arity, which do not count against a functional interface's one abstract method (JLS 9.8). */
const OBJECT_METHODS: ReadonlySet<string> = new Set(["equals/1", "hashCode/0", "toString/0"]);

/** A refusal to name the bodies of a call: its reason and the sorted places that blocked the proof, each with the construct standing there. */
interface Veto {
  reason: DispatchUnknownReason;
  cause: readonly string[];
}

const veto = (reason: DispatchUnknownReason, cause: readonly string[]): Veto => ({ reason, cause: sortedUnique(cause) });

/** A place of `Cut.cause`: the line of a node and the construct that stands there. */
const causeAt = (file: string, node: Node, cause: CutCause): string => placeAt(file, node.startPosition.row + 1, cause);

/** A type's declaration, at the line of its name. */
const causeOfType = (type: TypeDecl, cause: CutCause): string => causeAt(type.file.path, type.node.childForFieldName("name") ?? type.node, cause);

/** A class's superclass as the strict reading settles it: a repository type, none written, or one outside the repository or unsettled. */
export type Superclass = TypeDecl | "none" | "outside";

/** A function value's targets and its place; `awaitsJdk` when its context is a library call that a declared JDK would settle. */
export interface ReadFunctionValue {
  targets: FunctionTargets;
  file: string;
  line: number;
  awaitsJdk: boolean;
}

/** The declared hierarchy of the sources, by the strict reading of every supertype a declaration writes. */
export interface Hierarchy {
  subtypes: ReadonlyMap<TypeDecl, readonly TypeDecl[]>;
  /** The repository types each type extends or implements directly. */
  supertypes: ReadonlyMap<TypeDecl, readonly TypeDecl[]>;
  superclasses: ReadonlyMap<TypeDecl, Superclass>;
  /** Types with a supertype that is not a repository type: a platform or dependency type, or one the reading leaves unsettled. */
  outside: ReadonlySet<TypeDecl>;
  /** The simple names of supertypes the strict reading leaves unsettled, anywhere in the sources, with the clauses that write each. */
  unsettled: ReadonlyMap<string, readonly string[]>;
  invokedSupertypes: ReadonlyMap<string, readonly TypeDecl[]>;
  unsettledSupertypes: ReadonlyMap<TypeDecl, readonly string[]>;
  /** Anonymous and local classes, which the project does not place: the repository types they extend or implement and the unsettled names. */
  unplaced: readonly { file: JavaFile; node: Node; types: readonly TypeDecl[]; names: readonly string[]; fqns: readonly string[] }[];
  /** What each lambda and method reference of the sources may implement: a functional interface no declaration names (ADR-0044 decision 5). */
  functionValues(): readonly ReadFunctionValue[];
  /** A method's parameter types as the strict reading settles them; `undefined` when one of them is not settled. */
  signatureOf(method: MethodDecl): Signature | undefined;
}

/**
 * `ImportOrigins.dispatchTargets` for Java sources: the body each concrete class below the method's owner runs, its own
 * declaration or the nearest one up its class chain, found through the project's one resolver in its strict reading.
 * Unknown when a value the sources do not place may implement the owner: a source that does not parse, a JVM language
 * no extractor reads, an aspect whose `@Around` advice may select a body, or a JDK API that implements an interface at
 * run time anywhere; an annotation on the owner or the method other than the language's own (a generator or a proxy may
 * implement it); an owner whose
 * hierarchy reaches a type outside the repository; a supertype the strict reading leaves unsettled under the name of
 * the owner or a type below it; an anonymous or local class below it; a lambda or method reference while the owner is a
 * functional interface, unless every function value's context proves a type that is neither a functional interface of
 * the owner's closure nor below one; an enum below it; or a class whose chain reaches no single body of the method's signature.
 * The candidates and the closure verdict are read apart (`closureOf`), and the port's answer is derived from them.
 */
export function createJavaDispatchTargets(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[], hold?: ParseHold, build: ProjectBuild = {}, libraries?: LibraryReading): ImportOrigins["dispatchTargets"] {
  const unreadJvm = paths.some(isUncoveredJvmSource);
  return async (sites, signal) => {
    if (sites.length === 0) return [];
    const read = await parser();
    const held = hold === undefined ? undefined : await heldJavaProject(hold, () => Promise.resolve(read), sources, [], build);
    if (held !== undefined) return dispatchAnswersOf(sites, held.files.map(({ file }) => file), held.project, held.unparsed, unreadJvm, signal, libraries);
    return withJavaSources(read, (parse) => {
      const { files, unparsed } = parse(sources);
      return dispatchAnswersOf(sites, files, createJavaProject(files, build), unparsed, unreadJvm, signal, libraries);
    });
  };
}

/**
 * What the port answers for one read's parsed files, every veto it applies included; the call-site flow reads this same
 * derivation for the proof of the body it would select, so the advice of an aspect and the closure cannot disagree.
 */
export function dispatchAnswersOf(sites: readonly DispatchSite[], files: readonly JavaFile[], project: JavaProject, unparsed: readonly UnparsedSource[], unreadJvm: boolean, signal?: AbortSignal, libraries?: LibraryReading): DispatchTargets[] {
  return dispatchReadingOf(files, project, unparsed, unreadJvm, libraries).of(sites, signal);
}

/** The port's answer over one read's parsed files, with the vetoes and hierarchy it reads once. */
export interface DispatchReading {
  of(sites: readonly DispatchSite[], signal?: AbortSignal): DispatchTargets[];
}

interface PreparedDispatch {
  veto?: Veto;
  advice?: readonly Advice[];
  hierarchy?: Hierarchy;
}

export function dispatchReadingOf(files: readonly JavaFile[], project: JavaProject, unparsed: readonly UnparsedSource[], unreadJvm: boolean, libraries?: LibraryReading): DispatchReading {
  const unread = (): boolean => unreadJvm || unparsed.length > 0 || project.unreadable.length > 0;
  let reading: PreparedDispatch | undefined;
  const read = (): PreparedDispatch => {
    if (reading !== undefined) return reading;
    const wide = globalVeto(files, project);
    const held: PreparedDispatch = "reason" in wide ? { veto: wide } : { advice: wide.advice, hierarchy: readHierarchy(files, project, libraries) };
    reading = held;
    return held;
  };
  return {
    of(sites, signal) {
      const results: DispatchTargets[] = sites.map(() => UNKNOWN);
      if (unread() || sites.length === 0) return results;
      const held = read();
      if (held.veto !== undefined) return sites.map(() => ({ kind: "unknown", ...held.veto }));
      const hierarchy = held.hierarchy!;
      const advice = held.advice!;
      for (const [index, site] of sites.entries()) {
        if (signal?.aborted) break;
        const method = project.types.flatMap((type) => (type.file.path === site.file ? type.methods : [])).find((candidate) => candidate.name === site.name && !candidate.hasBody && spansLine(candidate.node, site.line));
        if (method === undefined) continue;
        const targets = targetsOf(method, hierarchy);
        const selecting = targets.kind === "bodies" ? advisedBy(method, hierarchy, advice) : [];
        results[index] = selecting.length > 0 ? { kind: "unknown", ...veto(ASPECT_REASON, selecting) } : targets;
      }
      return results;
    },
  };
}

/** One body a value of the owner may run, and the class whose value runs it. */
export interface DispatchCandidate {
  method: MethodDecl;
  receiver: TypeDecl;
}

/**
 * The bodies a call of `method` may run, before and after every veto (ADR-0044 decision 1). `candidates` is every
 * concrete class of the owner and below it, sorted by file then first line; `veto` names the first veto that fired,
 * in the order `targetsOf` applies them today.
 */
export type DispatchClosure =
  | { kind: "closed"; candidates: readonly DispatchCandidate[] }
  | ({ kind: "vetoed"; candidates: readonly DispatchCandidate[] } & Veto);

/**
 * The closure a call of `method` on a value of `owner` has, as ADR-0044 decision 1 reads it: `closed` when every
 * concrete class below the owner runs one body of the method's signature, `vetoed` with the first veto otherwise.
 * The candidates are stated apart from the verdict so a reader below the port can name a body a veto hides.
 */
export function closureOf(method: MethodDecl, hierarchy: Hierarchy, owner: TypeDecl = method.owner): DispatchClosure {
  const refused = vetoOf(method, hierarchy, owner);
  if (refused !== undefined) return { kind: "vetoed", candidates: candidatesOf(method, hierarchy, owner), ...refused };
  const closed: DispatchCandidate[] = [];
  const unproven: TypeDecl[] = [];
  for (const type of [owner, ...belowOf(owner, hierarchy)]) {
    if (type.kind !== "class" || type.isAbstract) continue;
    const body = bodyIn(type, method, hierarchy);
    if (body === undefined) unproven.push(type);
    else closed.push({ method: body, receiver: type });
  }
  if (unproven.length > 0) return { kind: "vetoed", candidates: candidatesOf(method, hierarchy, owner), ...veto("dispatch not proven", unproven.map((type) => causeOfType(type, "no-single-body"))) };
  return { kind: "closed", candidates: sortCandidates(closed) };
}

/** The function values that may implement one of the functional interfaces: their context leaves a target unsettled, or proves one that is an interface or below one. */
function functionValuesImplementing(functional: readonly TypeDecl[], hierarchy: Hierarchy): readonly ReadFunctionValue[] {
  if (functional.length === 0) return [];
  const reached = new Set(functional.flatMap((type) => [type, ...belowOf(type, hierarchy)]));
  return hierarchy.functionValues().filter(({ targets }) => targets === "unsettled" || targets.some((target) => target !== "library" && reached.has(target)));
}

/** The first veto `targetsOf` applies, in its order, with the places it rests on; none means every concrete class below the owner may be walked for a body. */
function vetoOf(method: MethodDecl, hierarchy: Hierarchy, owner: TypeDecl): Veto | undefined {
  const annotations = [...annotationsOfGenerators(owner.node).map((node) => causeAt(owner.file.path, node, "annotation")), ...annotationsOfGenerators(method.node).map((node) => causeAt(method.owner.file.path, node, "annotation"))];
  if (annotations.length > 0) return veto("generated implementation", annotations);
  const outside = ancestorsOf(owner, hierarchy).filter((type) => hierarchy.outside.has(type));
  if (outside.length > 0) return veto("generated implementation", outside.map((type) => causeOfType(type, "outside-supertype")));
  const below = belowOf(owner, hierarchy);
  const names = new Set([owner, ...below].map((type) => type.name));
  const unsettled = [...hierarchy.unsettled].filter(([name]) => names.has(name)).flatMap(([, clauses]) => clauses);
  if (unsettled.length > 0) return veto("dispatch not proven", unsettled);
  const unplaced = hierarchy.unplaced.filter(({ types, names: unsettledNames }) => types.some((type) => type === owner || below.has(type)) || unsettledNames.some((name) => names.has(name)));
  if (unplaced.length > 0) return veto("dispatch not proven", unplaced.map(({ file, node }) => causeAt(file.path, node, "unplaced-class")));
  const values = functionValuesImplementing([owner, ...below].filter((type) => type.kind === "interface" && isFunctional(type, hierarchy)), hierarchy);
  if (values.length > 0) return veto("dispatch not proven", values.map(({ file, line, awaitsJdk }) => placeAt(file, line, awaitsJdk ? FUNCTION_VALUE_AWAITS_JDK : "function-value")));
  const others = [...below].filter((type) => type.kind === "other");
  if (others.length > 0) return veto("dispatch not proven", others.map((type) => causeOfType(type, "other-type")));
  return undefined;
}

/**
 * `ImportOrigins.outsideSupertypes` for Java sources: a static method takes no receiver; otherwise the supertypes outside
 * the repository of its owner and every type below it, read from the dispatch reading's hierarchy.
 * `unknown` where the strict binding proves nothing (`provesBinding`, which a JDK API that implements an interface at run
 * time fails), a build file declares a source generator, an aspect introduces a supertype (`INTRODUCTIONS`), or the
 * method is not placed. An annotation and an aspect's advice leave the answer as read: a proxy or a generated subclass
 * of a type adds no supertype the type's own methods run under (ADR-0079 decision 5).
 */
export function createJavaOutsideSupertypes(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[], hold?: ParseHold, build: ProjectBuild = {}, reads?: KeptReads): NonNullable<ImportOrigins["outsideSupertypes"]> {
  const unreadJvm = paths.some(isUncoveredJvmSource);
  /** Per project, its hierarchy and its methods by place, read once for every site asked of it; `unknown` where the reading proves nothing. */
  const readings = new WeakMap<JavaProject, { hierarchy: Hierarchy; methods: ReadonlyMap<string, readonly MethodDecl[]> } | "unknown">();
  const readingOf = (files: readonly JavaFile[], unparsed: readonly UnparsedSource[], project: JavaProject) => {
    let reading = readings.get(project);
    if (reading === undefined) {
      const proves = build.generatesInterfaces !== true && provesBinding(files, project, unparsed, unreadJvm) && !introducesSupertypes(files);
      reading = proves ? { hierarchy: readHierarchy(files, project), methods: methodsByPlace(project) } : "unknown";
      readings.set(project, reading);
    }
    return reading;
  };
  const analyze = (sites: readonly ImplementingSite[], files: readonly JavaFile[], unparsed: readonly UnparsedSource[], project: JavaProject): readonly OutsideSupertypes[] => {
    const reading = readingOf(files, unparsed, project);
    if (reading === "unknown") return sites.map(() => UNKNOWN_OUTSIDE);
    return sites.map((site) => {
      const named = reading.methods.get(`${site.file}:${site.start}:${site.name}`) ?? [];
      const method = named.length === 1 ? named[0] : undefined;
      if (method === undefined) return UNKNOWN_OUTSIDE;
      if (method.modifiers.includes("static")) return { kind: "types", types: [], root: ROOT_TYPE, static: true };
      const types = outsideSupertypesOf(method, reading.hierarchy);
      return types === undefined ? UNKNOWN_OUTSIDE : { kind: "types", types, root: ROOT_TYPE };
    });
  };
  return async (sites) => {
    if (sites.length === 0) return [];
    if (reads !== undefined) {
      const index = await reads.index();
      return reads.facts.ofReads(OUTSIDE_SUPERTYPES_SLOT, { sites, generatesInterfaces: build.generatesInterfaces === true }, index.answerIfKnown, async (record) => {
        for (const question of [questions.listing(), questions.unread()]) record(question, index.answer(question));
        const held = await heldJavaProject(reads.hold, parser, sources, [], build);
        return analyze(sites, held.files.map(({ file }) => file), held.unparsed, held.project);
      });
    }
    const read = await parser();
    const held = hold === undefined ? undefined : await heldJavaProject(hold, () => Promise.resolve(read), sources, [], build);
    if (held !== undefined) return analyze(sites, held.files.map(({ file }) => file), held.unparsed, held.project);
    return withJavaSources(read, (parse) => {
      const { files, unparsed } = parse(sources);
      return analyze(sites, files, unparsed, createJavaProject(files, build));
    });
  };
}

/** Whether an annotation of the sources makes a type implement more than its declarations state (`INTRODUCTIONS`). */
function introducesSupertypes(files: readonly JavaFile[]): boolean {
  for (const file of files) {
    const pending: Node[] = [file.root];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if ((node.type === "marker_annotation" || node.type === "annotation") && INTRODUCTIONS.has(simpleName(node.childForFieldName("name") ?? node))) return true;
      for (const child of node.namedChildren) if (child !== null) pending.push(child);
    }
  }
  return false;
}

/** The superclass the language gives an enum or a record, which no clause writes (JLS 8.9, 8.10). */
const IMPLICIT_SUPERCLASSES: ReadonlyMap<string, string> = new Map([["enum_declaration", "java.lang.Enum"], ["record_declaration", "java.lang.Record"]]);

/**
 * The qualified names of the supertypes outside the repository of `owner` and every type below it, sorted, the platform
 * interfaces that declare no member left out and an enum's or a record's implicit superclass included (ADR-0079 decision
 * 6). `undefined` when a type of that closure may not be read in full: a supertype the strict reading leaves unsettled
 * at or above a type of the closure or under the name of one, an anonymous or local class below the owner, or a function
 * value that may implement a functional interface of the closure.
 */
export function outsideSupertypesOf(method: MethodDecl, hierarchy: Hierarchy): readonly string[] | undefined {
  const owner = method.owner;
  const closure = new Set([owner, ...belowOf(owner, hierarchy)]);
  const names = new Set([...closure].map((type) => type.name));
  if ([...hierarchy.unsettled.keys()].some((name) => names.has(name))) return undefined;
  if ([...closure].some((type) => ancestorsOf(type, hierarchy).some((ancestor) => hierarchy.unsettledSupertypes.has(ancestor)))) return undefined;
  if (hierarchy.unplaced.some(({ types, names: unsettled }) => types.some((type) => closure.has(type)) || unsettled.some((name) => names.has(name)))) return undefined;
  if (functionValuesImplementing([...closure].filter((type) => type.kind === "interface" && isFunctional(type, hierarchy)), hierarchy).length > 0) return undefined;
  const outside = new Set([...closure].flatMap((type) => IMPLICIT_SUPERCLASSES.get(type.node.type) ?? []));
  for (const [fqn, holders] of hierarchy.invokedSupertypes) if (!MEMBERLESS_PLATFORM_INTERFACES.has(fqn) && holders.some((holder) => closure.has(holder))) outside.add(fqn);
  return [...outside].sort();
}

/** The bodies a call of `method` runs on a value of `owner`, the method's own owner unless a declared type below it states the value. */
export function targetsOf(method: MethodDecl, hierarchy: Hierarchy, owner: TypeDecl = method.owner): DispatchTargets {
  const closure = closureOf(method, hierarchy, owner);
  if (closure.kind === "vetoed") return { kind: "unknown", reason: closure.reason, cause: closure.cause };
  return { kind: "bodies", bodies: bodiesOf(closure.candidates) };
}

/** One candidate per concrete class of the owner and below it, resolved by the nearest declaration of the name and arity, without proving a body. */
function candidatesOf(method: MethodDecl, hierarchy: Hierarchy, owner: TypeDecl): DispatchCandidate[] {
  const candidates: DispatchCandidate[] = [];
  for (const type of [owner, ...belowOf(owner, hierarchy)]) {
    if (type.kind !== "class" || type.isAbstract) continue;
    const declaration = declarationIn(type, method, hierarchy);
    if (declaration !== undefined) candidates.push({ method: declaration, receiver: type });
  }
  return sortCandidates(candidates);
}

function sortCandidates(candidates: readonly DispatchCandidate[]): DispatchCandidate[] {
  return [...candidates].sort((a, b) => comparePlaces(a.method, b.method) || comparePlaces(a.receiver, b.receiver));
}

function comparePlaces(a: MethodDecl | TypeDecl, b: MethodDecl | TypeDecl): number {
  const ownerOf = (value: MethodDecl | TypeDecl): TypeDecl => ("owner" in value ? value.owner : value);
  const fileOf = (value: MethodDecl | TypeDecl): string => ownerOf(value).file.path;
  return fileOf(a) < fileOf(b) ? -1 : fileOf(a) > fileOf(b) ? 1 : a.node.startPosition.row - b.node.startPosition.row;
}

/** The bodies a set of candidates runs, each body once, in file then first-line order: the port's answer. */
function bodiesOf(candidates: readonly DispatchCandidate[]): { file: string; start: number; nameLine: number }[] {
  const bodies = new Map<Node, MethodDecl>();
  for (const { method } of candidates) bodies.set(method.node, method);
  return [...bodies.values()]
    .map((body) => ({ file: body.owner.file.path, start: body.node.startPosition.row + 1, nameLine: (body.node.childForFieldName("name") ?? body.node).startPosition.row + 1 }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start));
}

/** The nearest declaration of the method's name and arity up `type`'s class chain, which a vetoed closure states without proving a body. */
function declarationIn(type: TypeDecl, method: MethodDecl, hierarchy: Hierarchy): MethodDecl | undefined {
  for (let current: Superclass = type; typeof current === "object"; current = hierarchy.superclasses.get(current) ?? "outside") {
    const declared = current.methods.filter((candidate) => candidate.name === method.name && candidate.parameterTypes.length === method.parameterTypes.length);
    if (declared.length > 0) return declared.length === 1 ? declared[0] : undefined;
  }
  return undefined;
}

/** The body a value of `type` runs for `method`: the nearest class up its chain that declares a method of that name and arity, when it declares exactly one with a body and the same signature. */
function bodyIn(type: TypeDecl, method: MethodDecl, hierarchy: Hierarchy): MethodDecl | undefined {
  for (let current: Superclass = type; typeof current === "object"; current = hierarchy.superclasses.get(current) ?? "outside") {
    const declared = current.methods.filter((candidate) => candidate.name === method.name && candidate.parameterTypes.length === method.parameterTypes.length);
    if (declared.length > 0) return declared.length === 1 && declared[0]!.hasBody && overrides(declared[0]!, method, hierarchy) ? declared[0] : undefined;
  }
  return undefined;
}

/** A method an interface has under one signature: abstract or with a body, and the interface that declares it. */
interface Member {
  abstract: boolean;
  from: TypeDecl;
  method: MethodDecl;
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
 * The one abstract method of a functional interface, when no other declaration of its name and arity sits in the
 * interface or above it, so no return type of an overridden or merged declaration can differ from it.
 */
function functionalMethodOf(type: TypeDecl, hierarchy: Hierarchy): MethodDecl | undefined {
  const members = type.kind === "interface" ? membersOf(type, hierarchy, new Map()) : undefined;
  const abstract = [...(members ?? [])].filter(([signature, member]) => member.abstract && !OBJECT_METHODS.has(arityOf(signature)));
  const only = abstract.length === 1 ? abstract[0]![1].method : undefined;
  if (only === undefined) return undefined;
  const same = ancestorsOf(type, hierarchy).flatMap((ancestor) => ancestor.methods).filter((method) => method.name === only.name && method.parameterTypes.length === only.parameterTypes.length && !method.modifiers.includes("static"));
  return same.length === 1 ? only : undefined;
}

/**
 * The methods an interface declares or inherits (JLS 9.4.1), by name and parameter types: its own declaration overrides
 * every inherited method of the same signature, and an inherited one overrides those of the interfaces above the one
 * that declares it; abstract methods of one signature from unrelated interfaces merge into one. `undefined` when the
 * sources do not settle it: a supertype outside the repository, a cycle, or two methods of one name and arity that are not
 * proven distinct, which a type argument may make one signature.
 */
function membersOf(type: TypeDecl, hierarchy: Hierarchy, known: Map<TypeDecl, ReadonlyMap<string, Member> | undefined>): ReadonlyMap<string, Member> | undefined {
  if (known.has(type)) return known.get(type);
  known.set(type, undefined);
  if (hierarchy.outside.has(type)) return undefined;
  const members = new Map<string, Member>();
  for (const method of type.methods) {
    if (!method.modifiers.includes("static") && !method.modifiers.includes("private")) members.set(signatureOf(method), { abstract: !method.hasBody, from: type, method });
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
  if (entries.some(([signature, member], index) => entries.some(([other, rival], later) => later > index && arityOf(other) === arityOf(signature) && !provenDistinct(member.method, rival.method)))) return undefined;
  known.set(type, members);
  return members;
}

/**
 * Whether two methods of one name and arity are distinct signatures whatever the type arguments: every parameter type of
 * both, as written, is concrete (no type variable of the method or its type, no wildcard, no type arguments). Members are
 * keyed by their erased parameter types, so two of them always differ there.
 */
function provenDistinct(first: MethodDecl, second: MethodDecl): boolean {
  const concrete = (method: MethodDecl) => writtenParameterTypes(method).every((parameter) => !/[<?]/.test(parameter) && !(parameter.match(/[A-Za-z_$][\w$]*/g) ?? []).some((name) => method.typeVariables.has(name)));
  return concrete(first) && concrete(second);
}

/** The parameter types as the declaration writes them, type arguments included. */
function writtenParameterTypes(method: MethodDecl): string[] {
  const parameters = method.node.childForFieldName("parameters")?.namedChildren ?? [];
  return parameters.flatMap((parameter) => (parameter !== null && PARAMETERS.has(parameter.type) ? [(parameter.childForFieldName("type") ?? parameter.namedChildren.find((child) => child?.type.endsWith("type")))?.text ?? "?"] : []));
}

function signatureOf(method: MethodDecl): string {
  return `${method.name}/${method.parameterTypes.length}(${method.parameterTypes.join(",")})`;
}

/** `name/arity` of a signature. */
function arityOf(signature: string): string {
  return signature.slice(0, signature.indexOf("("));
}

/** Whether `declared` certainly states the parameter types of `method`, each signature as the strict reading settles it. */
function overrides(declared: MethodDecl, method: MethodDecl, hierarchy: Hierarchy): boolean {
  const own = hierarchy.signatureOf(declared);
  const overridden = hierarchy.signatureOf(method);
  return own !== undefined && overridden !== undefined && sameSignature(own, overridden);
}

/** The type and every repository type above it. */
export function ancestorsOf(type: TypeDecl, hierarchy: Hierarchy): TypeDecl[] {
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
export function hierarchyOf(files: readonly JavaFile[], project: JavaProject): Hierarchy | undefined {
  return "reason" in globalVeto(files, project) ? undefined : readHierarchy(files, project);
}

/** One supertype clause of a declaration, resolved by the strict reading; `type` is set when it names a repository type. */
export interface SupertypeClause {
  node: Node;
  name: string;
  resolved: ReturnType<typeof resolve>;
  type: TypeDecl | undefined;
}

export function supertypeClausesOf(declaration: Node, file: JavaFile, project: JavaProject): SupertypeClause[] {
  const scope = enclosingType(declaration.parent ?? declaration, file, project);
  return supertypesOf(declaration).map((node) => {
    const resolved = resolve(node, file, project, scope, node, true);
    return { node, name: simpleName(node), resolved, type: resolved?.kind === "repository" ? resolved.type : undefined };
  });
}

export function readHierarchy(files: readonly JavaFile[], project: JavaProject, libraries?: LibraryReading): Hierarchy {
  const placed = new Map(project.types.map((type) => [type.node.id, type]));
  const subtypes = new Map<TypeDecl, TypeDecl[]>();
  const supertypes = new Map<TypeDecl, TypeDecl[]>();
  const superclasses = new Map<TypeDecl, Superclass>();
  const outside = new Set<TypeDecl>();
  const unsettled = new Map<string, string[]>();
  const unplaced: { file: JavaFile; node: Node; types: TypeDecl[]; names: string[]; fqns: string[] }[] = [];
  const invokedSupertypes = new Map<string, TypeDecl[]>();
  const unsettledSupertypes = new Map<TypeDecl, string[]>();
  const values: FunctionValue[] = [];
  for (const file of files) {
    const pending: Node[] = [file.root];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (FUNCTION_VALUES.has(node.type)) values.push({ file, node });
      if (isTypeDeclaration(node) || isAnonymous(node)) {
        const declared = placed.get(node.id);
        const superclass = node.type === "class_declaration" ? node.childForFieldName("superclass")?.namedChildren[0] : undefined;
        const types: TypeDecl[] = [];
        const names: string[] = [];
        const clauses: { name: string; place: string }[] = [];
        const fqns: string[] = [];
        const unresolved: string[] = [];
        for (const { node: supertype, name, resolved, type } of supertypeClausesOf(node, file, project)) {
          if (type !== undefined) types.push(type);
          else if (resolved?.kind !== "platform") {
            names.push(name);
            clauses.push({ name, place: causeAt(file.path, supertype, "unsettled-supertype") });
          }
          if (resolved?.kind === "platform" || resolved?.kind === "library") fqns.push(resolved.fqn);
          else if (resolved === undefined || (resolved.kind === "repository" && type === undefined)) unresolved.push(name);
          if (declared !== undefined && supertype.id === superclass?.id) superclasses.set(declared, type ?? "outside");
          if (declared !== undefined && type === undefined) outside.add(declared);
        }
        if (declared === undefined) unplaced.push({ file, node, types, names, fqns });
        else {
          for (const fqn of fqns) {
            const holders = invokedSupertypes.get(fqn) ?? [];
            holders.push(declared);
            invokedSupertypes.set(fqn, holders);
          }
          if (unresolved.length > 0) unsettledSupertypes.set(declared, unresolved);
          if (!superclasses.has(declared)) superclasses.set(declared, "none");
          for (const type of types) subtypes.set(type, [...(subtypes.get(type) ?? []), declared]);
          supertypes.set(declared, types);
          for (const { name, place } of clauses) unsettled.set(name, [...(unsettled.get(name) ?? []), place]);
        }
      }
      for (const child of node.namedChildren) if (child !== null) pending.push(child);
    }
  }
  for (const [fqn, types] of invokedSupertypes) {
    const all = new Set(types);
    for (const type of all) for (const below of subtypes.get(type) ?? []) all.add(below);
    invokedSupertypes.set(fqn, [...all].sort(comparePlaces));
  }
  const signatures = new Map<MethodDecl, Signature | undefined>();
  const signatureOf = (method: MethodDecl): Signature | undefined => {
    if (!signatures.has(method)) signatures.set(method, readSignature(method, project));
    return signatures.get(method);
  };
  let read: ReadFunctionValue[] | undefined;
  const hierarchy: Hierarchy = {
    subtypes, supertypes, superclasses, outside, unsettled, unplaced, invokedSupertypes, unsettledSupertypes, signatureOf,
    functionValues: () => (read ??= values.map((value) => {
      const targets = targetsOfFunctionValue(value, sources);
      return { targets, file: value.file.path, line: value.node.startPosition.row + 1, awaitsJdk: targets === "unsettled" && awaitsDeclaredJdk(value, sources) };
    })),
  };
  const sources: FunctionValueSources = {
    project,
    ...(libraries === undefined ? {} : { libraries }),
    above: (type) => ancestorsOf(type, hierarchy),
    ancestors: (type) => { const above = ancestorsOf(type, hierarchy); return above.some((ancestor) => outside.has(ancestor)) ? undefined : above; },
    functionalMethod: (type) => functionalMethodOf(type, hierarchy),
  };
  return hierarchy;
}

/** The annotations of a declaration other than the language's own, which a generator or a proxy may read to implement it. */
function annotationsOfGenerators(declaration: Node): Node[] {
  return annotationsOf(declaration).filter((annotation) => !LANGUAGE_ANNOTATIONS.has(annotation.childForFieldName("name")?.text.split(".").at(-1) ?? ""));
}

function simpleName(type: Node): string {
  return ((type.type === "generic_type" ? type.namedChildren[0] : type)?.text ?? "").replace(/\s+/g, "").split(".").at(-1) ?? "";
}

/** Whether the line lies between a declaration's first token and its name. */
function spansLine(declaration: Node, line: number): boolean {
  return declaration.startPosition.row + 1 <= line && line <= (declaration.childForFieldName("name") ?? declaration).startPosition.row + 1;
}

/**
 * What may run code behind any type: an aspect whose `@Around` advice or introduction the closed pointcut subset does not
 * bound, then a JDK API that implements an interface at run time; otherwise the bounded `@Around` advice of every aspect.
 */
function globalVeto(files: readonly JavaFile[], project: JavaProject): Veto | { advice: readonly Advice[] } {
  const dynamic: string[] = [];
  const unbounded: string[] = [];
  const advice: Advice[] = [];
  for (const file of files) {
    const pending: Node[] = [file.root];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (isAspect(node)) {
        const read = adviceOf(node, file);
        if ("escapes" in read) unbounded.push(read.escapes);
        else advice.push(...read.advice);
      }
      if (namesDynamicImplementation(node, file, project)) dynamic.push(causeAt(file.path, node, "dynamic-implementation"));
      for (const child of node.namedChildren) if (child !== null) pending.push(child);
    }
  }
  if (unbounded.length > 0) return veto(ASPECT_REASON, unbounded);
  return dynamic.length > 0 ? veto("generated implementation", dynamic) : { advice };
}

/**
 * The call a dispatch site stands for: its method, every repository type a value may have at run time (the owner, the
 * types below it and every type above those), and whether one of those has a supertype outside the repository.
 */
interface AdvisedCall {
  method: MethodDecl;
  types: readonly TypeDecl[];
  outside: boolean;
}

/** Whether an advice's pointcut may select the execution of a body the call dispatches to. */
type JoinPoints = (call: AdvisedCall) => boolean;

/** One `@Around` advice: the place of its annotation and its join points. */
interface Advice {
  place: string;
  joinPoints: JoinPoints;
}

/** The places of the advice whose pointcut may select a body the call dispatches to. */
function advisedBy(method: MethodDecl, hierarchy: Hierarchy, advice: readonly Advice[]): string[] {
  if (advice.length === 0) return [];
  const types = new Set([method.owner, ...belowOf(method.owner, hierarchy)]);
  for (let frontier = [...types]; frontier.length > 0; ) {
    frontier = frontier.flatMap((type) => hierarchy.supertypes.get(type) ?? []).filter((above) => !types.has(above));
    for (const above of frontier) types.add(above);
  }
  const call = { method, types: [...types], outside: [...types].some((type) => hierarchy.outside.has(type)) };
  return advice.filter(({ joinPoints }) => joinPoints(call)).map(({ place }) => place);
}

/**
 * The join points of each `@Around` advice of the aspect an `@Aspect` annotation marks, the only advice that can replace
 * a body, read from string pointcuts of a closed subset: `within` of a type name pattern or of `@Annotation *`,
 * `@within`, `@annotation` and `execution` with a type name pattern, combined with `&&` and `||`. The place of the first
 * `@Around` advice or introduction that escapes that subset otherwise, or of the aspect when its body is not read.
 */
function adviceOf(annotation: Node, file: JavaFile): { advice: readonly Advice[] } | { escapes: string } {
  const declaration = annotation.parent?.parent;
  const body = declaration?.type === "class_declaration" ? declaration.childForFieldName("body") : null;
  if (body === null || body === undefined) return { escapes: causeAt(file.path, annotation, "advice") };
  const advice: Advice[] = [];
  for (const member of body.namedChildren) {
    for (const annotated of annotationsOf(member)) {
      const name = simpleName(annotated.childForFieldName("name") ?? annotated);
      const place = causeAt(file.path, annotated, "advice");
      if (INTRODUCTIONS.has(name)) return { escapes: place };
      if (name !== BODY_REPLACING_ADVICE) continue;
      const pointcut = pointcutText(annotated);
      const joinPoints = pointcut === undefined ? undefined : parsePointcut(pointcut);
      if (joinPoints === undefined) return { escapes: place };
      advice.push({ place, joinPoints });
    }
  }
  return { advice };
}

function annotationsOf(declaration: Node | null): Node[] {
  const modifiers = declaration?.namedChildren.find((child) => child?.type === "modifiers");
  return (modifiers?.namedChildren ?? []).filter((child): child is Node => child?.type === "marker_annotation" || child?.type === "annotation");
}

/** The pointcut an advice annotation states as one plain string literal, its sole argument or its `value` or `pointcut` element. */
function pointcutText(annotation: Node): string | undefined {
  const values = (annotation.childForFieldName("arguments")?.namedChildren ?? []).flatMap((argument) => {
    if (argument === null) return [];
    if (argument.type !== "element_value_pair") return [argument];
    const key = argument.childForFieldName("key")?.text;
    return key === "value" || key === "pointcut" ? [argument.childForFieldName("value")] : [];
  });
  const [literal] = values;
  return values.length === 1 && literal?.type === "string_literal" && !literal.text.includes("\\") ? literal.text.slice(1, -1) : undefined;
}

/** A pointcut of the closed subset as a test; `undefined` for any other designator, a negation or a named pointcut. */
function parsePointcut(text: string): JoinPoints | undefined {
  let at = 0;
  const skip = (): void => { while (/\s/.test(text[at] ?? "")) at++; };
  const take = (...tokens: string[]): boolean => {
    skip();
    const token = tokens.find((candidate) => text.startsWith(candidate, at));
    if (token === undefined) return false;
    at += token.length;
    return true;
  };
  const either = (): JoinPoints | undefined => {
    const parts: JoinPoints[] = [];
    do {
      const part = both();
      if (part === undefined) return undefined;
      parts.push(part);
    } while (take("||"));
    return (call) => parts.some((part) => part(call));
  };
  const both = (): JoinPoints | undefined => {
    const parts: JoinPoints[] = [];
    do {
      const part = primary();
      if (part === undefined) return undefined;
      parts.push(part);
    } while (take("&&"));
    return (call) => parts.every((part) => part(call));
  };
  const primary = (): JoinPoints | undefined => {
    if (take("(")) {
      const inner = either();
      return inner !== undefined && take(")") ? inner : undefined;
    }
    skip();
    const designator = /^@?[A-Za-z]+/.exec(text.slice(at))?.[0];
    if (designator === undefined) return undefined;
    at += designator.length;
    if (!take("(")) return undefined;
    const start = at;
    for (let depth = 1; depth > 0; at++) {
      if (at >= text.length) return undefined;
      if (text[at] === "(") depth++;
      else if (text[at] === ")") depth--;
    }
    return designatorOf(designator, text.slice(start, at - 1).trim());
  };
  const joinPoints = either();
  skip();
  return at === text.length ? joinPoints : undefined;
}

function designatorOf(designator: string, argument: string): JoinPoints | undefined {
  if (designator === "within") {
    const annotation = /^@(\S+)\s+\*$/.exec(argument)?.[1];
    if (annotation !== undefined) return annotationName(annotation, (name) => (call) => call.outside || call.types.some((type) => annotatedWith(type.node, name)));
    const pattern = typePattern(argument);
    return pattern === undefined ? undefined : (call) => call.types.some((type) => pattern.test(type.fqn));
  }
  if (designator === "@within") return annotationName(argument, (name) => (call) => call.outside || call.types.some((type) => annotatedWith(type.node, name)));
  if (designator === "@annotation") return annotationName(argument, (name) => (call) => call.types.some((type) => type.methods.some((method) => method.name === call.method.name && annotatedWith(method.node, name))));
  return designator === "execution" ? executionOf(argument) : undefined;
}

/** An annotation type's simple name, for a written type name; a bound advice parameter (`@annotation(timed)`) is not one. */
function annotationName(written: string, test: (name: string) => JoinPoints): JoinPoints | undefined {
  const name = /^(?:[a-z_$][\w$]*\.)*([A-Z][\w$]*)$/.exec(written)?.[1];
  return name === undefined ? undefined : test(name);
}

/** `execution([modifiers] <return> [<declaring type pattern>.]<name pattern>(<parameters>))`, read without modifiers, return or parameters. */
function executionOf(argument: string): JoinPoints | undefined {
  const parameters = argument.lastIndexOf("(");
  if (parameters < 0 || !argument.endsWith(")") || /@|\bthrows\b|&&|\|\||!/.test(argument)) return undefined;
  const words = argument.slice(0, parameters).trim().split(/\s+/);
  const named = words.at(-1) ?? "";
  if (words.length < 2) return undefined;
  const cut = named.lastIndexOf(".");
  const name = named.slice(cut + 1);
  if (!/^[\w$*]+$/.test(name)) return undefined;
  const declaring = cut < 0 ? undefined : typePattern(named.slice(0, cut).endsWith(".") ? `${named.slice(0, cut)}.*` : named.slice(0, cut));
  if (cut >= 0 && declaring === undefined) return undefined;
  const method = globOf(name);
  return (call) => method.test(call.method.name) && (declaring === undefined || call.outside || call.types.some((type) => declaring.test(type.fqn)));
}

/** A qualified type name pattern with `*` and `..`; a simple name, `+`, an array or a type argument is outside the subset. */
function typePattern(pattern: string): RegExp | undefined {
  if (pattern === "*") return /^/;
  return /^[\w$*]+(?:\.\.?[\w$*]+)+$/.test(pattern) ? globOf(pattern) : undefined;
}

/** `*` stands for any characters but a dot, `..` for any run of packages. */
function globOf(pattern: string): RegExp {
  const words = pattern.split("..").map((part) => part.split("*").map((text) => text.replace(/[.$]/g, "\\$&")).join("[^.]*"));
  return new RegExp(`^${words.join("(?:\\.[^.]+)*\\.")}$`);
}

function annotatedWith(declaration: Node, name: string): boolean {
  return annotationsOf(declaration).some((annotation) => simpleName(annotation.childForFieldName("name") ?? annotation) === name);
}
