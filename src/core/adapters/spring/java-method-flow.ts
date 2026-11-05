import type { Node } from "web-tree-sitter";
import { argumentsOf, localBindings } from "./java-members.ts";
import { invocationsOf, parametersOf, receiverOf, type Invocation } from "./java-invocations.ts";
import { scopeOf, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { annotationUses } from "./request-mapping.ts";
import { isAnnotation, type UrlScope, type UrlText } from "./url-text.ts";

export interface MethodSelection {
  method: MethodDecl;
  receiver: TypeDecl;
}

export function methodsOf(call: Invocation, project: JavaProject, text: UrlText, concrete = call.type): MethodSelection[] {
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
    candidates = candidates.filter((type) => annotationUses(type.node, scopeOf(type)).some((use) => [...use.attributes.values()].flat().some((value) => {
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

  constructor(private readonly project: JavaProject, private readonly text: UrlText, leafOf: (call: Invocation) => T | undefined) {
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
  }

  nested(call: Invocation): boolean {
    return call.member !== undefined && this.called.has(call.member.id);
  }

  expand(call: Invocation, scope: UrlScope): { leaf: T; scope: UrlScope }[] | undefined {
    const selections = methodsOf(call, this.project, this.text, scope.receiver ?? scope.type);
    if (!selections.some(({ method }) => (this.reachable.get(method.node.id)?.size ?? 0) > 0)) return undefined;
    return selections.flatMap((selection) => this.read(selection, bindMethod(selection, call.node, scope), new Set()));
  }

  private read(selection: MethodSelection, scope: UrlScope, active: ReadonlySet<number>): { leaf: T; scope: UrlScope }[] {
    const method = selection.method.node.id;
    if (active.has(method)) return [...(this.reachable.get(method) ?? [])].map((leaf) => ({ leaf, scope: { ...scope, env: new Map() } }));
    const next = new Set(active).add(method);
    const found = (this.leaves.get(method) ?? []).map((leaf) => ({ leaf, scope: { ...scope, locals: leaf.invocation.locals } }));
    for (const { call } of this.edges.get(method) ?? []) {
      const caller = { ...scope, locals: call.locals };
      for (const target of methodsOf(call, this.project, this.text, scope.receiver ?? scope.type)) {
        if ((this.reachable.get(target.method.node.id)?.size ?? 0) > 0) found.push(...this.read(target, bindMethod(target, call.node, caller), next));
      }
    }
    return found;
  }
}
