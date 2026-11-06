import { isJsonModuleResource } from "../../domain/languages/typescript.ts";
import { NOT_DECLARED_KINDS, sortedUnique, unresolvedNamersOf, type ImportedFile } from "../../domain/impact/importers-fact.ts";
import type { UnresolvedUse } from "../../domain/impact/impact-cuts.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { EdgeTargets } from "./edge-targets.ts";

export interface ImportersRead {
  /** One entry per requested file the index holds, in path order. */
  files: ImportedFile[];
  /** The requested files the index holds no node of. */
  unheld: string[];
}

/** Containment is structure, not use; every other edge into a file's nodes makes its source file a user. */
const CONTAINMENT = "contains";
const IMPORT = "imports";

/** With `targets`, an edge they judge to reach another declaration than the file's, or none, makes no user. */
export async function readImporters(store: CodeGraphReader, requested: readonly string[], references: readonly UnresolvedUse[], modules?: ModuleDependencies, targets?: EdgeTargets, signal?: AbortSignal): Promise<ImportersRead> {
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
    const edges = targets === undefined ? read : await reaching(targets, file, read, sources, new Map(nodes.map((node) => [node.id, node])), signal);
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
    files.push({
      file,
      importers: sortedUnique([...from((edge) => edge.kind === IMPORT).filter((source) => !(reexports.has(source) || dynamic.has(source) || types.has(source)) || imports.has(source)), ...imports].filter((source) => source !== file)),
      ...(modules === undefined ? {} : { reexporters: sortedUnique([...reexports].filter((source) => source !== file)) }),
      ...(modules === undefined ? {} : { dynamicImporters: sortedUnique([...dynamic].filter((source) => source !== file)), typeImporters: sortedUnique([...types].filter((source) => source !== file)) }),
      users: sortedUnique([...from((edge) => edge.kind !== CONTAINMENT), ...imports, ...reexports, ...dynamic, ...types].filter((source) => source !== file)),
      unresolvedNamers: unresolvedNamersOf(file, declared, qualified, references),
    });
  }
  return { files, unheld };
}

/** The edges into the file's nodes that still reach the file once `targets` judged them; structure and imports are not uses to judge. */
async function reaching(targets: EdgeTargets, file: string, edges: readonly GraphEdge[], sources: ReadonlyMap<GraphNodeId, GraphSymbol>, nodes: ReadonlyMap<GraphNodeId, GraphSymbol>, signal?: AbortSignal): Promise<readonly GraphEdge[]> {
  const judged = edges.flatMap((edge) => {
    const source = sources.get(edge.source);
    const target = nodes.get(edge.target);
    return edge.kind === CONTAINMENT || edge.kind === IMPORT || source === undefined || target === undefined ? [] : [{ edge, source, target }];
  });
  const verdicts = await targets.verdictsOf(judged, signal);
  const away = new Set(judged.filter((_, index) => { const verdict = verdicts[index]!; return verdict.kind === "drop" || (verdict.kind === "redirect" && verdict.to.file !== file); }).map(({ edge }) => edge));
  return edges.filter((edge) => !away.has(edge));
}
