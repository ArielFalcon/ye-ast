import { callbackName, type FrameworkCallback } from "../../domain/entrypoints/entrypoint.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import { methodSite, spanOf, unknown } from "./findings.ts";
import { resolve, supertypesOf } from "./java-declared-types.ts";
import { enclosingType } from "./java-project.ts";
import type { Hierarchy } from "./java-dispatch-targets.ts";
import { scopeOf, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { annotationUses, isScannedBean, type SpringAnnotations } from "./request-mapping.ts";
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

export function callbacksOf(project: JavaProject, contracts: readonly InvokedContract[], annotations: SpringAnnotations, hierarchy: Hierarchy): Finding<FrameworkCallback>[] {
  const findings: Finding<FrameworkCallback>[] = [];
  const grouped = new Map<string, { value: FrameworkCallback; evidence: Evidence[] }>();
  for (const row of contracts) {
    if (row.by !== "supertype") continue;
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
