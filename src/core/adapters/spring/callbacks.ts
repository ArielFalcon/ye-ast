import type { Node } from "web-tree-sitter";
import { callbackName, type FrameworkCallback } from "../../domain/entrypoints/entrypoint.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import { methodSite, spanOf, unknown } from "./findings.ts";
import { FUNCTION_VALUES, isAnonymous, resolve, supertypesOf } from "./java-declared-types.ts";
import { enclosingType } from "./java-project.ts";
import type { Hierarchy } from "./java-dispatch-targets.ts";
import { isTypeDeclaration, scopeOf, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { annotationUses, isScannedBean, type SpringAnnotations, type AnnotationUse } from "./request-mapping.ts";
import type { InvokedContract, Registration } from "./invoked-contracts.ts";

function registered(type: TypeDecl, registration: Registration, annotations: SpringAnnotations): boolean {
  if (registration === "none") return true;
  if (registration === "scanned-bean") return isScannedBean(type, annotations);
  return annotationUses(type.node, scopeOf(type)).some((use) => annotations.keyOf(use) === registration.annotation);
}

function memberOf(type: TypeDecl, name: string, arity: number, hierarchy: Hierarchy): { methods: MethodDecl[]; outside: boolean } {
  const classes = new Set<TypeDecl>();
  let current: TypeDecl | "none" | "outside" = type;
  while (typeof current === "object") {
    if (classes.has(current)) return { methods: [], outside: true };
    classes.add(current);
    const methods = current.methods.filter((m) => m.name === name && m.parameterTypes.length === arity);
    if (methods.length > 0) return { methods, outside: false };
    current = hierarchy.superclasses.get(current) ?? "outside";
  }
  if (current === "outside") return { methods: [], outside: true };

  let frontier = [type];
  const visited = new Set<TypeDecl>();
  let outside = false;
  while (frontier.length > 0) {
    const level = [...new Set(frontier)].filter((t) => !visited.has(t));
    if (level.length === 0) break;
    level.forEach((t) => visited.add(t));
    outside ||= level.some((t) => hierarchy.outside.has(t));
    const methods = level.filter((t) => t.kind === "interface").flatMap((t) => t.methods.filter((m) => m.name === name && m.parameterTypes.length === arity));
    if (methods.length > 0) return { methods, outside };
    frontier = level.flatMap((t) => hierarchy.supertypes.get(t) ?? []);
  }
  return { methods: [], outside };
}

function returnedValues(method: MethodDecl): Node[] {
  const body = method.node.childForFieldName("body");
  if (body === null) return [];
  const values: Node[] = [];
  const pending = [body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (FUNCTION_VALUES.has(node.type) || isTypeDeclaration(node) || isAnonymous(node)) continue;
    if (node.type === "return_statement") {
      const value = node.namedChildren[0];
      if (value !== undefined && FUNCTION_VALUES.has(value.type)) values.push(value);
      continue;
    }
    pending.push(...node.namedChildren);
  }
  return values;
}

export function callbacksOf(project: JavaProject, contracts: readonly InvokedContract[], annotations: SpringAnnotations, hierarchy: Hierarchy): Finding<FrameworkCallback>[] {
  const findings: Finding<FrameworkCallback>[] = [];
  const grouped = new Map<string, { value: FrameworkCallback; evidence: Evidence[] }>();
  for (const row of contracts) {
    if (row.by === "annotation") {
      const includes = (use: AnnotationUse, visiting: ReadonlySet<TypeDecl>): boolean => {
        if (annotations.keyOf(use) === row.type) return true;
        const declared = project.lookupType(use.name, use.scope);
        if (typeof declared !== "object" || declared.kind !== "annotation" || visiting.has(declared)) return false;
        const inner = new Set(visiting).add(declared);
        return annotationUses(declared.node, scopeOf(declared)).some((meta) => includes(meta, inner));
      };
      for (const type of project.types) {
        try {
          const at = (node: TypeDecl["node"]) => ({ ...spanOf(type.file.path, node), via: row.type });
          for (const use of annotationUses(type.node, scopeOf(type))) {
            if (includes(use, new Set())) findings.push(unknown("no-extractor", [at(use.node)]));
          }
          for (const method of type.methods) {
            for (const use of annotationUses(method.node, scopeOf(type))) {
              if (!includes(use, new Set())) continue;
              if (annotations.keyOf(use) !== row.type || !method.hasBody || type.kind !== "class" || type.isAbstract) {
                findings.push(unknown("no-extractor", [at(use.node)]));
              } else if (!registered(type, row.registration, annotations)) {
                findings.push(unknown("no-extractor", [at(type.node)]));
              } else {
                const value: FrameworkCallback = { kind: "callback", name: callbackName(row.type), contract: { type: row.type }, handler: methodSite(method).handler };
                const key = JSON.stringify(value);
                const candidate = grouped.get(key) ?? { value, evidence: [] };
                candidate.evidence.push(spanOf(type.file.path, use.node));
                grouped.set(key, candidate);
              }
            }
          }
        } catch {
          findings.push(unknown("unresolved", [spanOf(type.file.path, type.node)]));
        }
      }
      continue;
    }
    for (const { file, node, fqns } of hierarchy.unplaced) {
      if (isAnonymous(node) && fqns.includes(row.type)) findings.push(unknown("no-extractor", [{ ...spanOf(file.path, node), via: row.type }]));
    }
    for (const type of project.types) {
      for (const method of type.methods) {
        if (!annotationUses(method.node, scopeOf(type)).some((use) => annotations.keyOf(use) === "org.springframework.context.annotation.Bean")) continue;
        const written = method.node.childForFieldName("type");
        if (written === null) continue;
        const resolved = resolve(written, type.file, project, type, written, true);
        if ((resolved?.kind !== "platform" && resolved?.kind !== "library") || resolved.fqn !== row.type) continue;
        for (const value of returnedValues(method)) findings.push(unknown("no-extractor", [{ ...spanOf(type.file.path, value), via: row.type }]));
      }
    }
    const simple = row.type.split(".").at(-1);
    for (const [type, names] of hierarchy.unsettledSupertypes) {
      if (!names.includes(simple ?? "")) continue;
      const nodes = supertypesOf(type.node).filter((node) => (node.type === "generic_type" ? node.namedChildren[0]?.text : node.text)?.split(".").at(-1) === simple);
      findings.push({ status: "unknown", reason: "unresolved", evidence: [{ ...spanOf(type.file.path, type.node), via: row.type }, ...nodes.map((node) => ({ ...spanOf(type.file.path, node), via: row.type }))] });
    }
    for (const type of hierarchy.invokedSupertypes.get(row.type) ?? []) {
      if (type.kind !== "class" || type.isAbstract) continue;
      const at = { ...spanOf(type.file.path, type.node), via: row.type };
      if (!registered(type, row.registration, annotations)) {
        findings.push(unknown("no-extractor", [at]));
        continue;
      }
      const { methods, outside } = memberOf(type, row.member.name, row.member.arity, hierarchy);
      if (methods.length !== 1 || !methods[0]?.hasBody) {
        const reason = methods.length > 1 || !outside ? "unresolved" : "no-extractor";
        findings.push({ status: "unknown", reason, evidence: [at, ...methods.map((method) => ({ ...spanOf(method.owner.file.path, method.node), via: row.type }))] });
        continue;
      }
      const handler = methodSite(methods[0]).handler;
      const value: FrameworkCallback = { kind: "callback", name: callbackName(row.type, row.member.name), contract: { type: row.type, member: row.member.name }, handler };
      const key = JSON.stringify(value);
      const scope = enclosingType(type.node.parent ?? type.node, type.file, project);
      const evidence = supertypesOf(type.node).filter((node) => {
        const resolved = resolve(node, type.file, project, scope, node, true);
        return resolved?.kind === "repository" ? resolved.type !== undefined && (hierarchy.invokedSupertypes.get(row.type) ?? []).includes(resolved.type) : (resolved?.kind === "library" || resolved?.kind === "platform") && resolved.fqn === row.type;
      }).map((node) => spanOf(type.file.path, node));
      const candidate = grouped.get(key) ?? { value, evidence: [] };
      candidate.evidence.push(...(evidence.length ? evidence : [spanOf(type.file.path, type.node)]));
      grouped.set(key, candidate);
    }
  }
  for (const { value, evidence } of grouped.values()) {
    const unique = [...new Map(evidence.map((span) => [JSON.stringify(span), span])).values()].sort((a, b) => compareText(a.path, b.path) || a.line - b.line || (a.endLine ?? a.line) - (b.endLine ?? b.line));
    findings.push({ status: "complete", value, evidence: unique });
  }
  return sortFindings(findings);
}
