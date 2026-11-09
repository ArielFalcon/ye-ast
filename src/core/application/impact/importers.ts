import { isJsonModuleResource } from "../../domain/languages/typescript.ts";
import { NOT_DECLARED_KINDS, sortedUnique, unresolvedNamersOf, type ImportedFile } from "../../domain/impact/importers-fact.ts";
import type { UnresolvedUse } from "../../domain/impact/impact-cuts.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { EdgeTargets, FollowedEdge } from "../navigation/edge-targets.ts";
import type { AttributedCall } from "../navigation/reverse-calls.ts";

export interface ImportersRead {
  /** One entry per requested file the index holds, in path order. */
  files: ImportedFile[];
  /** The requested files the index holds no node of. */
  unheld: string[];
}

/** Containment is structure, not use; every other edge into a file's nodes makes its source file a user. */
const CONTAINMENT = "contains";
const IMPORT = "imports";

/**
 * What the base binds into declarations beyond the index's edges into them (ADR-0041 U5): the edges it moves there and
 * the written calls the index does not record, bound or attributed to them.
 */
export type BoundInto = (nodes: readonly GraphSymbol[], signal?: AbortSignal) => Promise<{ edges: readonly FollowedEdge[]; attributed: readonly AttributedCall[] }>;

/**
 * With `targets`, an edge they judge to reach another declaration than the file's, or none, makes no user, and a file
 * whose only edges into the file are name matches is one of its `unresolvedNamers`.
 */
export async function readImporters(store: CodeGraphReader, requested: readonly string[], references: readonly UnresolvedUse[], modules?: ModuleDependencies, targets?: EdgeTargets, into?: BoundInto, signal?: AbortSignal): Promise<ImportersRead> {
  const files: ImportedFile[] = [];
  const unheld: string[] = [];
  const parsed = new Set(modules?.files.map(({ file }) => file));
  const resources = new Set(modules?.files.filter((entry) => entry.resource === true).map(({ file }) => file));
  const direct = new Map<string, { imports: Set<string>; reexports: Set<string>; dynamic: Set<string>; types: Set<string> }>();
  for (const edge of modules?.dependencies ?? []) {
    if (edge.target.kind !== "repository") continue;
    const held = direct.get(edge.target.file) ?? { imports: new Set<string>(), reexports: new Set<string>(), dynamic: new Set<string>(), types: new Set<string>() };
    if (edge.kind === "reexport") held.reexports.add(edge.file);
    else if (edge.form === "dynamic-import") held.dynamic.add(edge.file);
    else if (edge.form === "type-query") held.types.add(edge.file);
    else held.imports.add(edge.file);
    direct.set(edge.target.file, held);
  }
  for (const file of sortedUnique(requested)) {
    const nodes = store.symbolsInFiles([file]);
    if ((isJsonModuleResource(file) && !resources.has(file)) || (nodes.length === 0 && !parsed.has(file))) {
      unheld.push(file);
      continue;
    }
    const read = store.incomingEdges(nodes.map((node) => node.id));
    const sources = new Map(store.symbolsByIds([...new Set(read.map((edge) => edge.source))]).map((symbol) => [symbol.id, symbol]));
    const { edges, matched } = targets === undefined ? { edges: read, matched: new Set<GraphEdge>() } : await reaching(targets, file, read, sources, new Map(nodes.map((node) => [node.id, node])), signal);
    const sourceFiles = new Map([...sources.values()].map((symbol) => [symbol.id, symbol.file]));
    const from = (accept: (edge: GraphEdge) => boolean): string[] =>
      sortedUnique(edges.filter(accept).flatMap((edge) => sourceFiles.get(edge.source) ?? []).filter((other) => other !== file));
    const declared = new Set(nodes.filter((node) => !NOT_DECLARED_KINDS.includes(node.kind)).map((node) => node.name));
    const qualified = new Set(nodes.map((node) => node.qualifiedName));
    const consumers = direct.get(file);
    const imports = consumers?.imports ?? new Set<string>();
    const reexports = consumers?.reexports ?? new Set<string>();
    const dynamic = consumers?.dynamic ?? new Set<string>();
    const types = consumers?.types ?? new Set<string>();
    const bound = into === undefined ? { edges: [], attributed: [] } : await into(nodes, signal);
    const boundUsers = bound.edges.flatMap(({ source, target }) => (target.file === file ? [source.file] : []));
    const users = sortedUnique([...from((edge) => edge.kind !== CONTAINMENT && !matched.has(edge)), ...boundUsers, ...imports, ...reexports, ...dynamic, ...types].filter((source) => source !== file));
    const matchers = [...from((edge) => matched.has(edge)), ...bound.attributed.map(({ call }) => call.reference.file)].filter((source) => source !== file && !users.includes(source));
    files.push({
      file,
      importers: sortedUnique([...from((edge) => edge.kind === IMPORT).filter((source) => !(reexports.has(source) || dynamic.has(source) || types.has(source)) || imports.has(source)), ...imports].filter((source) => source !== file)),
      ...(modules === undefined ? {} : { reexporters: sortedUnique([...reexports].filter((source) => source !== file)) }),
      ...(modules === undefined ? {} : { dynamicImporters: sortedUnique([...dynamic].filter((source) => source !== file)), typeImporters: sortedUnique([...types].filter((source) => source !== file)) }),
      users,
      unresolvedNamers: sortedUnique([...unresolvedNamersOf(file, declared, qualified, references), ...matchers]),
    });
  }
  return { files, unheld };
}

/**
 * The edges into the file's nodes that still reach the file once `targets` judged them, and those of them the index
 * matched by name alone (ADR-0036). Structure, imports and the file's own edges are not judged: none of them makes a user.
 */
async function reaching(targets: EdgeTargets, file: string, edges: readonly GraphEdge[], sources: ReadonlyMap<GraphNodeId, GraphSymbol>, nodes: ReadonlyMap<GraphNodeId, GraphSymbol>, signal?: AbortSignal): Promise<{ edges: readonly GraphEdge[]; matched: ReadonlySet<GraphEdge> }> {
  const judged = edges.flatMap((edge) => {
    const source = sources.get(edge.source);
    const target = nodes.get(edge.target);
    return edge.kind === CONTAINMENT || edge.kind === IMPORT || source === undefined || source.file === file || target === undefined ? [] : [{ edge, source, target }];
  });
  const verdicts = await targets.verdictsOf(judged, signal);
  const away = new Set(judged.filter((_, index) => { const verdict = verdicts[index]!; return verdict.kind === "drop" || (verdict.kind === "redirect" && verdict.to.file !== file); }).map(({ edge }) => edge));
  const matched = new Set(judged.filter((_, index) => { const verdict = verdicts[index]!; return verdict.kind === "keep" && verdict.derivation === "name-match"; }).map(({ edge }) => edge));
  return { edges: edges.filter((edge) => !away.has(edge)), matched };
}
