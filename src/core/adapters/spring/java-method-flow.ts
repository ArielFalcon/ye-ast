import { LIBRARY_ROOT } from "../../domain/topology/library-source.ts";
import { isFunctionValueNode } from "../tree-sitter/java-function-value-calls.ts";
import { BEAN, NAMED_COMPONENTS, PRIMARY, QUALIFIER } from "./java-value-vocabulary.ts";
import type { Node } from "web-tree-sitter";
import { argumentsOf, descendants, localBindings, typeNameOf } from "./java-members.ts";
import { invocationsOf, parametersOf, receiverOf, type Invocation, type FieldLookup } from "./java-invocations.ts";
import { scopeOf, type JavaFile, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { annotationUses, isAnnotation } from "./request-mapping.ts";
import type { UrlScope } from "./java-values.ts";
import type { CallSiteDiagnostic, StatedRequest } from "../../domain/topology/call-site.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { reachedDiagnostic } from "../../domain/topology/evaluated.ts";
import { spanOf, unknown } from "./findings.ts";

export interface MethodSelection {
  method: MethodDecl;
  receiver: TypeDecl;
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

export function methodsOf(call: Invocation, project: JavaProject, text: FieldLookup, concrete = call.type): MethodSelection[] {
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

/** The one value every alternative agrees on; undefined when alternatives disagree. */
function agreed<V>(alternatives: readonly V[], identity: (value: V) => unknown): V | undefined {
  return new Set(alternatives.map((value) => JSON.stringify(identity(value)))).size === 1 ? alternatives[0] : undefined;
}

/** A call site's target as one reading of the code states it, with why it is unknown and what the code writes. */
export interface Reading<T> {
  target: Finding<T>;
  diagnostic?: CallSiteDiagnostic;
  stated?: StatedRequest;
}

/**
 * What a call that reaches requests or publishes through other methods comes to for one group of them: the decided target
 * every reading agrees on, or an unknown at the call naming the library it goes through, with each reading's evidence,
 * the reached calls and the prevailing cause.
 */
export function reachedTarget<T>(call: Invocation, group: readonly { leaf: { invocation: Invocation } }[], readings: readonly Reading<T>[], owned: ReadonlySet<JavaFile>): Reading<T> {
  const agreedReading = agreed(readings, ({ target }) => (target.status === "unknown" ? target.status : target.value));
  if (agreedReading !== undefined && agreedReading.target.status !== "unknown") return agreedReading;
  const library = group.find(({ leaf }) => !owned.has(leaf.invocation.type.file))?.leaf.invocation.type.fqn;
  const span = spanOf(call.type.file.path, call.node);
  return {
    ...agreedReading,
    target: unknown(agreedReading?.target.status === "unknown" ? agreedReading.target.reason : "unresolved", [library === undefined ? span : { ...span, via: library }, ...readings.flatMap(({ target }) => target.evidence), ...group.map(({ leaf }) => spanOf(leaf.invocation.type.file.path, leaf.invocation.node))]),
    diagnostic: reachedDiagnostic(readings.map(({ diagnostic }) => diagnostic), agreedReading !== undefined, library !== undefined),
  };
}

export function bindMethod(selection: MethodSelection, call: Node, scope: UrlScope): UrlScope {
  const args = argumentsOf(call);
  return {
    deferred: scope.deferred === true || deferredLibraryCall(call, scope.type.file.path),
    type: selection.method.owner,
    receiver: selection.receiver,
    configurationFile: scope.configurationFile ?? scope.type.file,
    locals: localBindings(selection.method.node),
    env: new Map(parametersOf(selection.method.node).flatMap((name, index) => {
      const node = args[index];
      return node === undefined ? [] : [[name, { node, scope }] as const];
    })),
  };
}

/** Reachable leaves grow monotonically over source methods; substitution stops at active methods. */
export class JavaMethodFlow<T extends { invocation: Invocation }> {
  readonly invocations: Invocation[];
  private readonly leaves = new Map<number, T[]>();
  private readonly reachable = new Map<number, Set<T>>();
  private readonly edges = new Map<number, { call: Invocation; selections: MethodSelection[] }[]>();
  private readonly called = new Set<number>();
  private readonly roots = new Set<number>();

  constructor(private readonly project: JavaProject, private readonly text: FieldLookup, leafOf: (call: Invocation) => T | undefined) {
    this.invocations = project.types.flatMap(invocationsOf);
    for (const call of this.invocations) {
      const leaf = leafOf(call);
      if (leaf !== undefined && call.member !== undefined) this.leaves.set(call.member.id, [...(this.leaves.get(call.member.id) ?? []), leaf]);
      if (call.member === undefined) continue;
      const selections = methodsOf(call, project, text);
      this.edges.set(call.member.id, [...(this.edges.get(call.member.id) ?? []), { call, selections }]);
    }
    for (const [method, leaves] of this.leaves) this.reachable.set(method, new Set(leaves));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [method, edges] of this.edges) {
        const summary = this.reachable.get(method) ?? new Set<T>();
        for (const { selections } of edges) for (const { method: target } of selections) {
          for (const leaf of this.reachable.get(target.node.id) ?? []) if (!summary.has(leaf)) { summary.add(leaf); changed = true; }
        }
        this.reachable.set(method, summary);
      }
    }
    for (const edges of this.edges.values()) for (const { selections } of edges) for (const { method } of selections) {
      if ((this.reachable.get(method.node.id)?.size ?? 0) > 0) this.called.add(method.node.id);
    }
    const covered = new Set<number>();
    const cover = (root: number) => {
      const pending = [root];
      for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
        if (covered.has(current)) continue;
        covered.add(current);
        for (const edge of this.edges.get(current) ?? []) for (const target of edge.selections) pending.push(target.method.node.id);
      }
    };
    for (const method of this.reachable.keys()) if (!this.called.has(method)) { this.roots.add(method); cover(method); }
    for (const [method, leaves] of this.reachable) if (leaves.size > 0 && !covered.has(method)) { this.roots.add(method); cover(method); }
  }

  nested(call: Invocation): boolean {
    return call.member !== undefined && this.called.has(call.member.id) && !this.roots.has(call.member.id);
  }

  expand(call: Invocation, scope: UrlScope): { leaf: T; scope: UrlScope; bodies: ReadonlySet<MethodDecl> }[][] | undefined {
    type Group = { leaf: T; scope: UrlScope; bodies: Set<MethodDecl> }[];
    type Frame = { groups: Group[]; edges: Group[][][] };
    type Done = (groups: Group[]) => void;
    const cache = new Map<string, Group[]>();
    const scopeIds = new WeakMap<UrlScope, number>();
    let serial = 0;
    const closureKey = (node: Node, bound: UrlScope): string => {
      const seen = new Set<UrlScope>();
      while (node.type === "identifier" && !seen.has(bound)) {
        seen.add(bound);
        const closed = bound.env.get(node.text);
        if (closed === undefined) break;
        node = closed.node; bound = closed.scope;
      }
      if (!scopeIds.has(bound)) scopeIds.set(bound, ++serial);
      return `${node.id}:${scopeIds.get(bound)}`;
    };
    const merge = (branches: Group[][]): Group[] => {
      const length = Math.max(0, ...branches.map((branch) => branch.length));
      return Array.from({ length }, (_, index) => {
        const present = [...new Set(branches.flatMap((branch) => branch[index] ?? []))];
        return branches.some((branch) => branch[index] === undefined)
          ? present.map(({ leaf, scope, bodies }) => ({ leaf, bodies, scope: { ...scope, undecided: scope.undecided ?? "dispatch-disagreement" } })) : present;
      });
    };
    const selections = methodsOf(call, this.project, this.text, scope.receiver ?? scope.type);
    if (!selections.some(({ method }) => (this.reachable.get(method.node.id)?.size ?? 0) > 0)) return undefined;
    const roots: Group[][] = [];
    const pending: (() => void)[] = [];
    const schedule = (selection: MethodSelection, bound: UrlScope, active: ReadonlySet<number>, done: Done) => {
      pending.push(() => {
        const method = selection.method.node.id;
        if (active.has(method)) {
          done([...(this.reachable.get(method) ?? [])].map((leaf) => [{ leaf, bodies: new Set([selection.method]), scope: { ...bound, undecided: "recursive" } }]));
          return;
        }
        const key = `${method}:${bound.deferred === true}:${selection.receiver.node.id}:${bound.configurationFile?.path}:${[...bound.env].map(([name, value]) => `${name}=${closureKey(value.node, value.scope)}`).join(";")}`;
        const cached = cache.get(key);
        if (cached !== undefined) { done(cached); return; }
        const frame: Frame = { groups: (this.leaves.get(method) ?? []).map((leaf) => [{ leaf, bodies: new Set<MethodDecl>(), scope: { ...bound, deferred: bound.deferred === true || deferredLibraryCall(leaf.invocation.node, leaf.invocation.type.file.path), locals: leaf.invocation.locals } }]), edges: [] };
        pending.push(() => {
          const groups = [...frame.groups, ...frame.edges.flatMap(merge)];
          for (const group of groups) for (const item of group) item.bodies.add(selection.method);
          cache.set(key, groups); done(groups);
        });
        const next = new Set(active).add(method);
        for (const { call } of this.edges.get(method) ?? []) {
          const targets = methodsOf(call, this.project, this.text, bound.receiver ?? bound.type);
          if (!targets.some((target) => (this.reachable.get(target.method.node.id)?.size ?? 0) > 0)) continue;
          const branches: Group[][] = [];
          frame.edges.push(branches);
          targets.forEach((target, index) => schedule(target, bindMethod(target, call.node, { ...bound, locals: call.locals }), next, (groups) => { branches[index] = groups; }));
        }
      });
    };
    selections.forEach((selection, index) => schedule(selection, bindMethod(selection, call.node, scope), new Set(), (groups) => { roots[index] = groups; }));
    for (let task = pending.pop(); task !== undefined; task = pending.pop()) task();
    return merge(roots);
  }
}

function deferredLibraryCall(call: Node, file: string): boolean {
  if (!file.startsWith(`${LIBRARY_ROOT}/`)) return false;
  for (let node = call.parent; node !== null; node = node.parent) {
    if (isFunctionValueNode(node) || (node.type === "class_body" && node.parent?.type === "object_creation_expression")) return true;
  }
  return false;
}
