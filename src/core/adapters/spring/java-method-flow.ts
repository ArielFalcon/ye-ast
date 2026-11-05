import type { Node } from "web-tree-sitter";
import { argumentsOf, descendants, localBindings, typeNameOf } from "./java-members.ts";
import { invocationsOf, parametersOf, receiverOf, type Invocation, type FieldLookup } from "./java-invocations.ts";
import { scopeOf, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { annotationUses, isAnnotation } from "./request-mapping.ts";
import type { UrlScope } from "./java-values.ts";

export interface MethodSelection {
  method: MethodDecl;
  receiver: TypeDecl;
}

export function methodsOf(call: Invocation, project: JavaProject, text: FieldLookup, concrete = call.type): MethodSelection[] {
  const object = call.node.childForFieldName("object");
  const held = object === null || object.type === "this" ? undefined : receiverOf(object, call, project, text);
  let declared = object === null || object.type === "this" ? concrete : held !== undefined && "decl" in held.resolved ? held.resolved.decl : undefined;
  if (declared === undefined && object?.type === "identifier") {
    const found = project.lookupType(object.text, scopeOf(call.type));
    if (typeof found === "object") declared = found;
  }
  if (declared === undefined) return [];
  let candidates = declared.kind === "interface" || declared.isAbstract
    ? project.types.filter((type) => type.kind === "class" && !type.isAbstract && project.hierarchy(type).types.includes(declared))
    : [declared];
  const qualifier = held === undefined ? undefined : annotationUses(held.binding.node, scopeOf(call.type)).find((use) => isAnnotation(use, "org.springframework.beans.factory.annotation.Qualifier"));
  const expression = qualifier?.attributes.get("value")?.[0];
  const selected = expression === undefined ? undefined : project.evaluate(expression);
  if (selected !== undefined && "value" in selected) {
    const constructed = project.types.flatMap((owner) => owner.methods.flatMap((method) => {
      const beans = annotationUses(method.node, scopeOf(owner)).filter((use) => isAnnotation(use, "org.springframework.context.annotation.Bean"));
      const matches = beans.some((bean) => (bean.attributes.get("name") ?? bean.attributes.get("value") ?? []).some((value) => {
        const evaluated = project.evaluate(value);
        return "value" in evaluated && evaluated.value === selected.value;
      }) || (bean.attributes.size === 0 && method.name === selected.value));
      if (!matches) return [];
      const returns = descendants(method.node).filter((node) => node.type === "return_statement");
      const value = returns.length === 1 ? returns[0]?.namedChildren[0] : undefined;
      if (value?.type !== "object_creation_expression") return [];
      const type = project.lookupType(typeNameOf(value.childForFieldName("type")), scopeOf(owner));
      return typeof type === "object" ? [type] : [];
    }));
    candidates = candidates.filter((type) => constructed.includes(type) || annotationUses(type.node, scopeOf(type)).some((use) => isAnnotation(use, new Set(["org.springframework.stereotype.Component", "org.springframework.stereotype.Service", "org.springframework.beans.factory.annotation.Qualifier"])) && [...use.attributes.values()].flat().some((value) => {
      const evaluated = project.evaluate(value);
      return "value" in evaluated && evaluated.value === selected.value;
    })));

  } else {
    const primary = candidates.filter((type) => annotationUses(type.node, scopeOf(type)).some((use) => isAnnotation(use, "org.springframework.context.annotation.Primary")));
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

export function bindMethod(selection: MethodSelection, call: Node, scope: UrlScope): UrlScope {
  const args = argumentsOf(call);
  return {
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

  expand(call: Invocation, scope: UrlScope): { leaf: T; scope: UrlScope }[][] | undefined {
    const selections = methodsOf(call, this.project, this.text, scope.receiver ?? scope.type);
    if (!selections.some(({ method }) => (this.reachable.get(method.node.id)?.size ?? 0) > 0)) return undefined;
    return selections.flatMap((selection) => this.read(selection, bindMethod(selection, call.node, scope), new Set()));
  }

  private read(selection: MethodSelection, scope: UrlScope, active: ReadonlySet<number>): { leaf: T; scope: UrlScope }[][] {
    const method = selection.method.node.id;
    if (active.has(method)) return [[...(this.reachable.get(method) ?? [])].map((leaf) => ({ leaf, scope: { ...scope, undecided: true } }))];
    const next = new Set(active).add(method);
    let alternatives = [(this.leaves.get(method) ?? []).map((leaf) => ({ leaf, scope: { ...scope, locals: leaf.invocation.locals } }))];
    for (const { call } of this.edges.get(method) ?? []) {
      const caller = { ...scope, locals: call.locals };
      const selections = methodsOf(call, this.project, this.text, scope.receiver ?? scope.type);
      if (!selections.some((target) => (this.reachable.get(target.method.node.id)?.size ?? 0) > 0)) continue;
      const branches = selections.flatMap((target) => this.read(target, bindMethod(target, call.node, caller), next));
      alternatives = alternatives.flatMap((before) => branches.map((after) => [...before, ...after]));
    }
    return alternatives;
  }
}
