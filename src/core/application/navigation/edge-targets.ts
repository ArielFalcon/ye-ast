import { edgeVerdict, FOLLOWED_EDGE_KINDS, type EdgeVerdict } from "../../domain/impact/edge-policy.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins } from "../../ports/import-origins.port.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { ModuleDependencies, ModuleDependency } from "../../domain/impact/module-dependency.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { importBindings } from "./import-bindings.ts";

/**
 * What the edges the graph resolved really reach, read from the root of the name each spells at its position through
 * the source file's own bindings (`ImportOrigins.rootOrigins`) and, for a root an import binds, the declaration the
 * module statements and the graph's `imports` edges join it to (`importBindings`). The one owner of that decision for
 * every family that reads graph edges as dependences.
 */
export interface EdgeTargets {
  /** One verdict per edge, in the order received; an edge the graph placed nowhere is kept. */
  verdictsOf(edges: readonly FollowedEdge[], signal?: AbortSignal): Promise<readonly EdgeTarget[]>;
  /** The edges the graph matched elsewhere that an import proves reach `node`, each with `node` as its target. */
  redirectedInto(node: GraphSymbol, signal?: AbortSignal): Promise<readonly FollowedEdge[]>;
  /** Per local name `file`'s imports bind, the declaration the join proves it reaches, when it proves exactly one. */
  importedDeclarations(file: string): Promise<ReadonlyMap<string, GraphSymbol>>;
}

export interface EdgeTargetsDeps {
  origins: ImportOrigins;
  store: CodeGraphReader;
  /**
   * The module statements that bind a root to a declaration: already read, or a reader asked file by file. Without them no
   * edge is redirected.
   */
  modules?: ModuleDependencies | { reader: ModuleDependenciesReader; sources: readonly SourceFile[] } | undefined;
}

/** A graph edge with both of its ends. */
export interface FollowedEdge {
  edge: GraphEdge;
  source: GraphSymbol;
  target: GraphSymbol;
}

/** One edge of the store, for naming it in a set; a handle inside one store, never output. */
export function edgeKey({ source, target, kind, line, column }: GraphEdge): string {
  return JSON.stringify([source, target, kind, line, column]);
}

/** What an edge reaches (`EdgeVerdict`); a dropped one carries the root that binds its name outside the repository's declarations. */
export type EdgeTarget = Exclude<EdgeVerdict<GraphSymbol>, { kind: "drop" }> | { kind: "drop"; root: ImportOrigin };

const KEEP: EdgeTarget = { kind: "keep" };
const IMPORT = "imports";

export function createEdgeTargets({ origins, store, modules }: EdgeTargetsDeps): EdgeTargets {
  const verdicts = new Map<string, EdgeTarget>();
  /** Per file, the declaration each local name its imports bind reaches, when the join proves exactly one. */
  const bound = new Map<string, ReadonlyMap<string, GraphSymbol>>();
  let extracted: ReadonlyMap<string, readonly ModuleDependency[]> | undefined;

  async function bindingsOf(file: string): Promise<ReadonlyMap<string, GraphSymbol>> {
    let held = bound.get(file);
    if (held === undefined) {
      const dependencies = modules === undefined ? [] : "dependencies" in modules ? (extracted ??= Map.groupBy(modules.dependencies, (dependency) => dependency.file)).get(file) ?? [] : (await modules.reader.extract(modules.sources, { files: [file] })).dependencies.filter((dependency) => dependency.file === file);
      const byLocal = new Map<string, GraphSymbol[]>();
      for (const [binding, declaration] of importBindings(store, file, dependencies)) {
        if (binding.local !== undefined) byLocal.set(binding.local, [...(byLocal.get(binding.local) ?? []), declaration]);
      }
      held = new Map([...byLocal].flatMap(([local, declarations]) => (new Set(declarations.map(({ id }) => id)).size === 1 ? [[local, declarations[0]!] as const] : [])));
      bound.set(file, held);
    }
    return held;
  }

  async function verdictsOf(edges: readonly FollowedEdge[], signal?: AbortSignal): Promise<readonly EdgeTarget[]> {
    const fresh = [...new Map(edges.filter(({ edge }) => edge.line !== null && edge.column !== null && !verdicts.has(edgeKey(edge))).map((followed) => [edgeKey(followed.edge), followed])).values()];
    if (fresh.length > 0) {
      const roots = await origins.rootOrigins(fresh.map(({ edge, source, target }) => ({ file: source.file, line: edge.line!, column: edge.column! + 1, kind: edge.kind, name: target.name })), signal);
      for (const [index, { edge, source, target }] of fresh.entries()) {
        const root = roots[index];
        if (root === undefined) continue;
        const proven = root.status === "complete" && root.value.kind === "repository" && root.bare === true ? (await bindingsOf(source.file)).get(target.name) : undefined;
        const verdict = edgeVerdict<GraphNodeId>(root, proven?.id, target.id);
        verdicts.set(edgeKey(edge), verdict.kind === "redirect" ? { kind: "redirect", to: proven! } : verdict.kind === "drop" && root.status === "complete" ? { kind: "drop", root: root.value } : { kind: "keep" });
      }
    }
    return edges.map(({ edge }) => verdicts.get(edgeKey(edge)) ?? KEEP);
  }

  return {
    verdictsOf,
    importedDeclarations: bindingsOf,
    async redirectedInto(node, signal) {
      const importing = store.symbolsByIds([...new Set(store.incomingEdges([node.id], [IMPORT]).map((edge) => edge.source))]);
      const candidates: FollowedEdge[] = [];
      for (const file of new Set(importing.map((symbol) => symbol.file))) {
        const locals = new Set([...(await bindingsOf(file))].filter(([, declaration]) => declaration.id === node.id).map(([local]) => local));
        if (locals.size === 0) continue;
        const sources = store.symbolsInFiles([file]);
        const edges = store.outgoingEdges(sources.map((symbol) => symbol.id), FOLLOWED_EDGE_KINDS).filter((edge) => edge.target !== node.id && edge.line !== null && edge.column !== null);
        const targets = new Map(store.symbolsByIds([...new Set(edges.map((edge) => edge.target))]).map((symbol) => [symbol.id, symbol]));
        const bySource = new Map(sources.map((symbol) => [symbol.id, symbol]));
        for (const edge of edges) {
          const target = targets.get(edge.target);
          const source = bySource.get(edge.source);
          if (target !== undefined && source !== undefined && locals.has(target.name)) candidates.push({ edge, source, target });
        }
      }
      const judged = await verdictsOf(candidates, signal);
      return candidates.flatMap(({ edge, source }, index) => {
        const verdict = judged[index]!;
        return verdict.kind === "redirect" && verdict.to.id === node.id ? [{ edge, source, target: node }] : [];
      });
    },
  };
}
