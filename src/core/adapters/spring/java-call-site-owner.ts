/**
 * The call-site flow's staging reading of the Java owner, until V3: ADR-0044 decision 1's "the owner's binding where it
 * proves one, the lenient binding where it does not, and every candidate of an unproven closure", read as the flow's own
 * lenient selection marked with the owner's proof. V3 deletes this form when the flow reads only proven bindings and
 * proven closures.
 */
import type { JavaFile, JavaProject, MethodDecl, TypeDecl } from "./java-symbols.ts";
import { scopeOf } from "./java-symbols.ts";
import type { LibrarySource } from "../../domain/topology/library-source.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DispatchTargets } from "../../ports/import-origins.port.ts";
import type { FieldLookup, Invocation } from "./java-invocations.ts";
import { receiverOf } from "./java-invocations.ts";
import { argumentsOf, descendants, typeNameOf } from "./java-members.ts";
import { javaReceiverBindings } from "../tree-sitter/java-receiver-bindings.ts";
import { callKey, createResolver, provesBinding, type ReceiverSource } from "./java-receiver-methods.ts";
import { dispatchReadingOf, type DispatchReading } from "./java-dispatch-targets.ts";
import { UNREAD_JVM_SOURCE } from "./java-declared-types.ts";
import type { UnparsedSource } from "./java-project.ts";
import { annotationUses, isAnnotation } from "./request-mapping.ts";
import { BEAN, NAMED_COMPONENTS, PRIMARY, QUALIFIER } from "./java-value-vocabulary.ts";

/**
 * The declarations a call may select and the bodies each may run, as ADR-0044 decision 1's staging form states them
 * until V3: the flow's lenient selection, marked `proven` when the owner's strict binding names the declaration and
 * `dispatchTargets` proves its closure. Deleted in V3.
 */
export interface StagedSelection {
  method: MethodDecl;
  receiver: TypeDecl;
  /** Proven when the owner's `receiverMethods` names the declaration and `dispatchTargets` proves its closure; read lazily, so a consumer that never asks pays no proof. */
  proven: boolean;
}

/** The read's own inputs the owner's proof needs beyond the project: what it left unparsed and whether a JVM source no extractor reads is in its universe. */
export interface CallSiteProof {
  unparsed: readonly UnparsedSource[];
  unreadJvm: boolean;
}

/** The proof of a read that handed the flow only its parsed sources. */
export const NO_PROOF: CallSiteProof = { unparsed: [], unreadJvm: false };

/**
 * The owner's proof over the call-site flow's own inputs: every source the parse left unread, its own and the libraries
 * it reads, and every JVM source no extractor reads in the universe it was handed.
 */
export function callSiteProofOf(files: readonly SourceFile[], libraries: readonly LibrarySource[], unparsed: readonly UnparsedSource[], unreadableLibraries: readonly UnparsedSource[]): CallSiteProof {
  return { unparsed: [...unparsed, ...unreadableLibraries], unreadJvm: [...files, ...libraries].some(({ path }) => UNREAD_JVM_SOURCE.test(path)) };
}

interface ProjectReading {
  resolver: ReturnType<typeof createResolver>;
  files: readonly JavaFile[];
  sources: Map<string, ReceiverSource>;
}

const readings = new WeakMap<JavaProject, ProjectReading>();

/** The owner's one resolver, its files and its receiver bindings, read once per project. */
function readingOf(project: JavaProject): ProjectReading {
  let reading = readings.get(project);
  if (reading === undefined) {
    reading = { resolver: createResolver(project), files: [...new Set(project.types.map((type) => type.file))], sources: new Map() };
    readings.set(project, reading);
  }
  return reading;
}

function sourceOf(file: JavaFile, reading: ProjectReading): ReceiverSource {
  let source = reading.sources.get(file.path);
  if (source === undefined) {
    source = { file, bindings: new Map(javaReceiverBindings(file.root, { declaredFields: true }).map((binding) => [callKey(binding.line, binding.column, binding.member), binding])) };
    reading.sources.set(file.path, source);
  }
  return source;
}

export function stagedSelections(call: Invocation, project: JavaProject, text: FieldLookup, concrete: TypeDecl = call.type, proof: CallSiteProof = NO_PROOF): StagedSelection[] {
  let proven: Set<string> | undefined;
  const prove = (): Set<string> => (proven ??= provenBodies(call, project, proof));
  return lenientSelections(call, project, text, concrete).map(({ method, receiver }) => ({
    method,
    receiver,
    get proven(): boolean {
      return prove().has(`${method.owner.file.path}:${method.node.startPosition.row + 1}`);
    },
  }));
}

/**
 * The bodies the owner proves for the call, read through the port's own derivation: the strict binding's conditions,
 * the strict resolver, and the dispatch answer at the declaration — every veto, the advice of an aspect included.
 * The proof is read once per project and read, and each declaration's dispatch answer once.
 */
function provenBodies(call: Invocation, project: JavaProject, proof: CallSiteProof): Set<string> {
  if (call.node.type !== "method_invocation") return new Set();
  const held = ownerProofOf(project, proof);
  if (!held.proves) return new Set();
  const reading = readingOf(project);
  const named = reading.resolver.methodOf(call.node, sourceOf(call.type.file, reading));
  if (named === undefined || named.bound) return new Set();
  let answer = held.answers.get(named.method.node.id);
  if (answer === undefined) {
    const [site] = held.dispatch?.of([{ file: named.method.owner.file.path, line: named.method.node.startPosition.row + 1, name: named.method.name }]) ?? [];
    answer = site ?? { kind: "unknown" };
    held.answers.set(named.method.node.id, answer);
  }
  return answer.kind === "bodies" ? new Set(answer.bodies.map(({ file, start }) => `${file}:${start}`)) : new Set();
}

interface OwnerProof {
  proves: boolean;
  dispatch: DispatchReading | undefined;
  answers: Map<number, DispatchTargets>;
}

const ownerProofs = new WeakMap<JavaProject, WeakMap<CallSiteProof, OwnerProof>>();

function ownerProofOf(project: JavaProject, proof: CallSiteProof): OwnerProof {
  let byProof = ownerProofs.get(project);
  if (byProof === undefined) {
    byProof = new WeakMap();
    ownerProofs.set(project, byProof);
  }
  let held = byProof.get(proof);
  if (held === undefined) {
    const files = readingOf(project).files;
    const proves = provesBinding(files, project, proof.unparsed, proof.unreadJvm);
    held = { proves, dispatch: proves ? dispatchReadingOf(files, project, proof.unparsed, proof.unreadJvm) : undefined, answers: new Map() };
    byProof.set(proof, held);
  }
  return held;
}

interface DispatchIndex {
  implementations: Map<TypeDecl, TypeDecl[]>;
  named: Map<string, Set<TypeDecl>>;
  primary: Set<TypeDecl>;
}

const dispatchIndexes = new WeakMap<JavaProject, DispatchIndex>();

function dispatchIndex(project: JavaProject): DispatchIndex {
  const cached = dispatchIndexes.get(project);
  if (cached !== undefined) return cached;
  const index: DispatchIndex = { implementations: new Map(), named: new Map(), primary: new Set() };
  const register = (name: string, type: TypeDecl) => {
    const types = index.named.get(name) ?? new Set<TypeDecl>();
    index.named.set(name, types.add(type));
  };
  for (const type of project.types) {
    if (type.kind === "class" && !type.isAbstract) for (const parent of project.hierarchy(type).types) {
      const types = index.implementations.get(parent) ?? [];
      types.push(type);
      index.implementations.set(parent, types);
    }
    for (const use of annotationUses(type.node, scopeOf(type))) {
      if (isAnnotation(use, PRIMARY)) index.primary.add(type);
      if (!isAnnotation(use, NAMED_COMPONENTS)) continue;
      for (const value of [...use.attributes.values()].flat()) {
        const evaluated = project.evaluate(value);
        if ("value" in evaluated) register(evaluated.value, type);
      }
    }
    for (const method of type.methods) indexBean(method, project, register);
  }
  dispatchIndexes.set(project, index);
  return index;
}

function indexBean(method: MethodDecl, project: JavaProject, register: (name: string, type: TypeDecl) => void): void {
  const beans = annotationUses(method.node, scopeOf(method.owner)).filter((use) => isAnnotation(use, BEAN));
  if (beans.length === 0) return;
  const returns = descendants(method.node).filter((node) => node.type === "return_statement");
  const value = returns.length === 1 ? returns[0]?.namedChildren[0] : undefined;
  if (value?.type !== "object_creation_expression") return;
  const type = project.lookupType(typeNameOf(value.childForFieldName("type")), scopeOf(method.owner));
  if (typeof type !== "object") return;
  for (const bean of beans) {
    if (bean.attributes.size === 0) register(method.name, type);
    for (const name of bean.attributes.get("name") ?? bean.attributes.get("value") ?? []) {
      const evaluated = project.evaluate(name);
      if ("value" in evaluated) register(evaluated.value, type);
    }
  }
}

/** The lenient selection the flow keeps until V3: every concrete implementation of the receiver's type, every same-arity method. */
function lenientSelections(call: Invocation, project: JavaProject, text: FieldLookup, concrete: TypeDecl): { method: MethodDecl; receiver: TypeDecl }[] {
  if (call.node.type === "object_creation_expression" || call.node.type === "explicit_constructor_invocation") {
    const found = call.node.type === "object_creation_expression"
      ? project.lookupType(typeNameOf(call.node.childForFieldName("type")), scopeOf(call.type))
      : call.node.childForFieldName("constructor")?.text === "super" ? project.classChain(call.type)[1] : call.type;
    if (typeof found !== "object" || found === null) return [];
    const arity = argumentsOf(call.node).length;
    return found.constructors.filter(method => method.hasBody && method.parameterTypes.length === arity).map(method => ({ method, receiver: found }));
  }
  const object = call.node.childForFieldName("object");
  const held = object === null || object.type === "this" ? undefined : receiverOf(object, call, project, text);
  let declared = object === null || object.type === "this" ? concrete : held !== undefined && "decl" in held.resolved ? held.resolved.decl : undefined;
  if (declared === undefined && object?.type === "identifier") {
    const found = project.lookupType(object.text, scopeOf(call.type));
    if (typeof found === "object") declared = found;
  }
  if (declared === undefined) return [];
  const index = dispatchIndex(project);
  let candidates = declared.kind === "interface" || declared.isAbstract ? index.implementations.get(declared) ?? [] : [declared];
  const qualifier = held === undefined ? undefined : annotationUses(held.binding.node, scopeOf(call.type)).find((use) => isAnnotation(use, QUALIFIER));
  const expression = qualifier?.attributes.get("value")?.[0];
  const selected = expression === undefined ? undefined : project.evaluate(expression);
  if (selected !== undefined && "value" in selected) candidates = candidates.filter((type) => index.named.get(selected.value)?.has(type));
  else {
    const primary = candidates.filter((type) => index.primary.has(type));
    if (primary.length === 1) candidates = primary;
  }
  const name = call.node.childForFieldName("name")?.text;
  const arity = argumentsOf(call.node).length;
  return candidates.flatMap((receiver) => {
    for (const owner of project.classChain(receiver)) {
      const methods = owner.methods.filter((method) => method.name === name && method.parameterTypes.length === arity && method.hasBody);
      if (methods.length > 0) return methods.map((method) => ({ method, receiver }));
    }
    return [];
  });
}
