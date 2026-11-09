import { LIBRARY_ROOT } from "../../domain/topology/library-source.ts";
import { isFunctionValueNode } from "../tree-sitter/java-function-value-calls.ts";
import type { Node } from "web-tree-sitter";
import { argumentsOf, localBindings } from "./java-members.ts";
import { invocationsOf, parametersOf, type Invocation, type FieldLookup } from "./java-invocations.ts";
import { type JavaFile, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import type { UrlScope } from "./java-values.ts";
import type { CallSiteDiagnostic, StatedRequest } from "../../domain/topology/call-site.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { reachedDiagnostic } from "../../domain/topology/evaluated.ts";
import { spanOf, unknown } from "./findings.ts";
import { stagedSelections } from "./java-call-site-owner.ts";

export interface MethodSelection {
  method: MethodDecl;
  receiver: TypeDecl;
}

export function methodsOf(call: Invocation, project: JavaProject, text: FieldLookup, concrete = call.type): MethodSelection[] {
  return stagedSelections(call, project, text, concrete).map(({ method, receiver }) => ({ method, receiver }));
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
