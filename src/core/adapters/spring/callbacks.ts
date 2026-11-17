import type { Node } from "web-tree-sitter";
import { callbackName, type FrameworkCallback } from "../../domain/entrypoints/entrypoint.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Finding, UnknownSubject } from "../../domain/shared/fact.ts";
import { methodSite, spanOf, subjectOf, unknown } from "./findings.ts";
import { FUNCTION_VALUES, isAnonymous, resolve, supertypesOf } from "./java-declared-types.ts";
import { enclosingType } from "./java-project.ts";
import { supertypeClausesOf } from "./java-dispatch-targets.ts";
import { isTypeDeclaration, scopeOf, type JavaFile, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { annotationUses, isScannedBean, type SpringAnnotations, type AnnotationUse } from "./request-mapping.ts";
import type { InvokedContract, Registration } from "./invoked-contracts.ts";

function contractSubject(row: InvokedContract, symbol: string | undefined): UnknownSubject {
  return subjectOf("callback", symbol, row.type);
}

function registered(type: TypeDecl, registration: Registration, annotations: SpringAnnotations): boolean {
  if (registration === "none") return true;
  if (registration === "scanned-bean") return isScannedBean(type, annotations);
  return annotationUses(type.node, scopeOf(type)).some((use) => annotations.keyOf(use) === registration.annotation);
}

/** What the clauses of one declaration say about its supertypes, read through the recording project. */
interface SupertypeEdges {
  supertypes: readonly TypeDecl[];
  superclass: TypeDecl | "none" | "outside";
  /** A clause names something that is not a repository type. */
  outside: boolean;
  /** The platform and library types the clauses name. */
  invoked: readonly string[];
  /** The simple names of the clauses the strict reading leaves unsettled. */
  unsettled: readonly string[];
}

function edgesOf(type: TypeDecl, project: JavaProject): SupertypeEdges {
  const clauses = supertypeClausesOf(type.node, type.file, project);
  const written = type.node.type === "class_declaration" ? type.node.childForFieldName("superclass")?.namedChildren[0] : undefined;
  const superclass = written === undefined ? undefined : clauses.find(({ node }) => node.id === written.id);
  return {
    supertypes: clauses.flatMap(({ type: declared }) => declared ?? []),
    superclass: superclass === undefined ? "none" : (superclass.type ?? "outside"),
    outside: clauses.some(({ type: declared }) => declared === undefined),
    invoked: clauses.flatMap(({ resolved }) => (resolved?.kind === "platform" || resolved?.kind === "library" ? [resolved.fqn] : [])),
    unsettled: clauses.flatMap(({ resolved, type: declared, name }) => (resolved === undefined || (resolved.kind === "repository" && declared === undefined) ? [name] : [])),
  };
}

/** The supertype edges of the declarations one derivation reaches: each read once, upward from the declarations of its file, and shared with no other derivation. */
function supertypeEdges(project: JavaProject): { of(type: TypeDecl): SupertypeEdges; invokes(type: TypeDecl, contract: string): boolean } {
  const read = new Map<TypeDecl, SupertypeEdges>();
  const of = (type: TypeDecl): SupertypeEdges => {
    const known = read.get(type) ?? edgesOf(type, project);
    read.set(type, known);
    return known;
  };
  const invokes = (type: TypeDecl, contract: string): boolean => {
    const visited = new Set<TypeDecl>();
    for (let pending = [type], current = pending.pop(); current !== undefined; current = pending.pop()) {
      if (visited.has(current)) continue;
      visited.add(current);
      if (of(current).invoked.includes(contract)) return true;
      pending.push(...of(current).supertypes);
    }
    return false;
  };
  return { of, invokes };
}

type Edges = ReturnType<typeof supertypeEdges>;

function memberOf(type: TypeDecl, name: string, arity: number, edges: Edges): { methods: MethodDecl[]; outside: boolean } {
  const classes = new Set<TypeDecl>();
  let current: TypeDecl | "none" | "outside" = type;
  while (typeof current === "object") {
    if (classes.has(current)) return { methods: [], outside: true };
    classes.add(current);
    const methods = current.methods.filter((m) => m.name === name && m.parameterTypes.length === arity);
    if (methods.length > 0) return { methods, outside: false };
    current = edges.of(current).superclass;
  }
  if (current === "outside") return { methods: [], outside: true };

  let frontier = [type];
  const visited = new Set<TypeDecl>();
  let outside = false;
  while (frontier.length > 0) {
    const level = [...new Set(frontier)].filter((t) => !visited.has(t));
    if (level.length === 0) break;
    level.forEach((t) => visited.add(t));
    outside ||= level.some((t) => edges.of(t).outside);
    const methods = level.filter((t) => t.kind === "interface").flatMap((t) => t.methods.filter((m) => m.name === name && m.parameterTypes.length === arity));
    if (methods.length > 0) return { methods, outside };
    frontier = level.flatMap((t) => edges.of(t).supertypes);
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

/** What one Java file contributes to the callbacks of its project, per invoked contract: plain data, which a read of the project merges. */
export interface FileCallbacks {
  rows: { findings: Finding<FrameworkCallback>[]; found: { value: FrameworkCallback; evidence: Evidence[] }[] }[];
}

/** The type declarations and anonymous classes of a file, in the order its syntax tree is walked; `declared` is the project's type for a declaration it places. */
function declarationsIn(file: JavaFile, project: JavaProject): { node: Node; declared: TypeDecl | undefined }[] {
  const placed = new Map(project.typesOf(file).map((type) => [type.node.id, type]));
  const found: { node: Node; declared: TypeDecl | undefined }[] = [];
  const pending: Node[] = [file.root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeDeclaration(node) || isAnonymous(node)) found.push({ node, declared: placed.get(node.id) });
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return found;
}

/** The callbacks the declarations of one file register; every read of another file goes through the project's recorded questions, and no state is shared with the derivation of another file. */
export function callbacksOfFile(file: JavaFile, project: JavaProject, contracts: readonly InvokedContract[], annotations: SpringAnnotations): FileCallbacks {
  const edges = supertypeEdges(project);
  const types = project.typesOf(file);
  const declarations = declarationsIn(file, project);
  const rows = contracts.map((row) => {
    const findings: Finding<FrameworkCallback>[] = [];
    const found: { value: FrameworkCallback; evidence: Evidence[] }[] = [];
    if (row.by === "annotation") {
      const includes = (use: AnnotationUse, visiting: ReadonlySet<TypeDecl>): boolean => {
        if (annotations.keyOf(use) === row.type) return true;
        const declared = project.lookupType(use.name, use.scope);
        if (typeof declared !== "object" || declared.kind !== "annotation" || visiting.has(declared)) return false;
        const inner = new Set(visiting).add(declared);
        return annotationUses(declared.node, scopeOf(declared)).some((meta) => includes(meta, inner));
      };
      for (const type of types) {
        try {
          const at = (node: TypeDecl["node"]) => ({ ...spanOf(type.file.path, node), via: row.type });
          for (const use of annotationUses(type.node, scopeOf(type))) {
            if (includes(use, new Set())) findings.push(unknown("no-extractor", [at(use.node)], contractSubject(row, type.qualifiedName)));
          }
          for (const method of type.methods) {
            for (const use of annotationUses(method.node, scopeOf(type))) {
              if (!includes(use, new Set())) continue;
              if (annotations.keyOf(use) !== row.type || !method.hasBody || type.kind !== "class" || type.isAbstract) {
                findings.push(unknown("no-extractor", [at(use.node)], contractSubject(row, `${type.qualifiedName}.${method.name}`)));
              } else if (!registered(type, row.registration, annotations)) {
                findings.push(unknown("no-extractor", [at(type.node)], contractSubject(row, type.qualifiedName)));
              } else {
                const value: FrameworkCallback = { kind: "callback", name: callbackName(row.type), contract: { type: row.type }, handler: methodSite(method).handler };
                found.push({ value, evidence: [spanOf(type.file.path, use.node)] });
              }
            }
          }
        } catch {
          findings.push(unknown("unresolved", [spanOf(type.file.path, type.node)]));
        }
      }
      return { findings, found };
    }
    for (const { node, declared } of declarations) {
      if (declared !== undefined || !isAnonymous(node)) continue;
      const names = supertypeClausesOf(node, file, project).flatMap(({ resolved }) => (resolved?.kind === "platform" || resolved?.kind === "library" ? [resolved.fqn] : []));
      if (names.includes(row.type)) findings.push(unknown("no-extractor", [{ ...spanOf(file.path, node), via: row.type }], contractSubject(row, enclosingType(node, file, project)?.qualifiedName)));
    }
    for (const type of types) {
      for (const method of type.methods) {
        if (!annotationUses(method.node, scopeOf(type)).some((use) => annotations.keyOf(use) === "org.springframework.context.annotation.Bean")) continue;
        const written = method.node.childForFieldName("type");
        if (written === null) continue;
        const resolved = resolve(written, type.file, project, type, written, true);
        if ((resolved?.kind !== "platform" && resolved?.kind !== "library") || resolved.fqn !== row.type) continue;
        for (const value of returnedValues(method)) findings.push(unknown("no-extractor", [{ ...spanOf(type.file.path, value), via: row.type }], contractSubject(row, `${type.qualifiedName}.${method.name}`)));
      }
    }
    const simple = row.type.split(".").at(-1);
    for (const { declared: type } of declarations) {
      if (type === undefined || !edges.of(type).unsettled.includes(simple ?? "")) continue;
      const nodes = supertypesOf(type.node).filter((node) => (node.type === "generic_type" ? node.namedChildren[0]?.text : node.text)?.split(".").at(-1) === simple);
      findings.push({ status: "unknown", reason: "unresolved", evidence: [{ ...spanOf(type.file.path, type.node), via: row.type }, ...nodes.map((node) => ({ ...spanOf(type.file.path, node), via: row.type }))], subject: contractSubject(row, type.qualifiedName) });
    }
    for (const type of types.filter((candidate) => edges.invokes(candidate, row.type)).sort((a, b) => a.node.startPosition.row - b.node.startPosition.row)) {
      if (type.kind !== "class" || type.isAbstract) continue;
      const at = { ...spanOf(type.file.path, type.node), via: row.type };
      if (!registered(type, row.registration, annotations)) {
        findings.push(unknown("no-extractor", [at], contractSubject(row, type.qualifiedName)));
        continue;
      }
      const { methods, outside } = memberOf(type, row.member.name, row.member.arity, edges);
      if (methods.length !== 1 || !methods[0]?.hasBody) {
        const reason = methods.length > 1 || !outside ? "unresolved" : "no-extractor";
        findings.push({ status: "unknown", reason, evidence: [at, ...methods.map((method) => ({ ...spanOf(method.owner.file.path, method.node), via: row.type }))], subject: contractSubject(row, type.qualifiedName) });
        continue;
      }
      const handler = methodSite(methods[0]).handler;
      const value: FrameworkCallback = { kind: "callback", name: callbackName(row.type, row.member.name), contract: { type: row.type, member: row.member.name }, handler };
      const scope = enclosingType(type.node.parent ?? type.node, type.file, project);
      const evidence = supertypesOf(type.node).filter((node) => {
        const resolved = resolve(node, type.file, project, scope, node, true);
        return resolved?.kind === "repository" ? resolved.type !== undefined && edges.invokes(resolved.type, row.type) : (resolved?.kind === "library" || resolved?.kind === "platform") && resolved.fqn === row.type;
      }).map((node) => spanOf(type.file.path, node));
      found.push({ value, evidence: evidence.length ? evidence : [spanOf(type.file.path, type.node)] });
    }
    return { findings, found };
  });
  return { rows };
}

/** The callbacks of the project: each contract's findings in the order of the files, and the callbacks of equal value grouped across files. */
export function mergeCallbacks(reads: readonly FileCallbacks[], contracts: readonly InvokedContract[]): Finding<FrameworkCallback>[] {
  const findings: Finding<FrameworkCallback>[] = [];
  const grouped = new Map<string, { value: FrameworkCallback; evidence: Evidence[] }>();
  contracts.forEach((_, index) => {
    for (const { rows } of reads) {
      findings.push(...rows[index]!.findings);
      for (const { value, evidence } of rows[index]!.found) {
        const key = JSON.stringify(value);
        const candidate = grouped.get(key) ?? { value, evidence: [] };
        candidate.evidence.push(...evidence);
        grouped.set(key, candidate);
      }
    }
  });
  for (const { value, evidence } of grouped.values()) {
    const unique = [...new Map(evidence.map((span) => [JSON.stringify(span), span])).values()].sort((a, b) => compareText(a.path, b.path) || a.line - b.line || (a.endLine ?? a.line) - (b.endLine ?? b.line));
    findings.push({ status: "complete", value, evidence: unique });
  }
  return sortFindings(findings);
}
