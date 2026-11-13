import type { Token, SourceReading } from "../../domain/change/source-tokens.ts";
import { topLevelOf, isSeedable } from "../../domain/change/seeds.ts";
import { FOLLOWED_EDGE_KINDS, followsEdge } from "../../domain/impact/edge-policy.ts";
import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import { DECLARING_KEYWORDS, readsWrittenUses } from "../../domain/impact/written-uses.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames } from "../../ports/declared-member-names.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins, RootBinding, UseSite } from "../../ports/import-origins.port.ts";

/** A place a source writes a name bound to `node`, held by `from`, which the edge policy lets depend on `node` through it. */
export interface HeldUse {
  node: GraphSymbol;
  from: GraphSymbol;
  file: string;
  line: number;
  name: string;
}

/**
 * What the sources write of reached declarations the index records no edge for. `held`: the uses a declaration writes.
 * `read`: by node, the files where every place that writes the name it is bound to is settled: a held use, or a binding of
 * another declaration. A file with a use no declaration the edge policy admits holds (a top-level statement), or a place
 * whose binding is unknown, is not read and keeps the index's importer fallback.
 */
export interface WrittenUseReading {
  read: ReadonlyMap<GraphNodeId, ReadonlySet<string>>;
  held: readonly HeldUse[];
}

export interface WrittenUses {
  into(nodes: readonly GraphSymbol[], signal?: AbortSignal): Promise<WrittenUseReading>;
}

export interface WrittenUsesDeps {
  store: CodeGraphReader;
  sources: readonly SourceFile[];
  tokensOf(file: SourceFile): Promise<SourceReading>;
  /** B1, for the span a declaration's syntax covers beyond the index's (a class's decorators); absent without a syntax reader. */
  syntaxOf?: ((path: string) => Promise<DeclaredMemberNames>) | undefined;
  origins: Pick<ImportOrigins, "rootBindings">;
  /** Per file, the declaration each local name its imports bind reaches, when the join proves exactly one. */
  importedDeclarations(file: string): Promise<ReadonlyMap<string, GraphSymbol>>;
}

/** No declaration owns the place: it is bound at the file's level. */
const FILE_LEVEL: UseSite["owner"] = { name: "", line: 0, endLine: 0 };
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

interface Site {
  node: GraphSymbol;
  file: string;
  /** The name the file binds the node to: an import's local name, or the node's own in its file. */
  local: string;
  own: boolean;
  line: number;
  /** 0-based, as the index counts columns. */
  column: number;
  owner?: GraphSymbol;
}

/**
 * Reads, for each reached declaration of a language whose index records no edge for a read of a value
 * (`readsWrittenUses`), every place its own file and the files that import it write the name they bind it to, and keeps
 * those the file's own scoping binds to it.
 */
export function createWrittenUses({ store, sources, tokensOf, syntaxOf, origins, importedDeclarations }: WrittenUsesDeps): WrittenUses {
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const readings = new Map<string, Promise<SourceReading>>();
  const reading = (source: SourceFile): Promise<SourceReading> => {
    let held = readings.get(source.path);
    if (held === undefined) {
      held = tokensOf(source);
      readings.set(source.path, held);
    }
    return held;
  };
  const declared = new Map<string, readonly GraphSymbol[]>();
  const declarationsIn = (file: string): readonly GraphSymbol[] => {
    let held = declared.get(file);
    if (held === undefined) {
      held = store.symbolsInFiles([file]).filter(({ kind }) => !NOT_DECLARED_KINDS.includes(kind));
      declared.set(file, held);
    }
    return held;
  };

  /** The files that may write `node`'s name, each with the local names binding it there: its own, and those the join proves an import binds to it. */
  async function filesOf(node: GraphSymbol): Promise<Map<string, { locals: ReadonlySet<string>; own: boolean }>> {
    const files = new Map<string, { locals: ReadonlySet<string>; own: boolean }>();
    if (topLevelOf(declarationsIn(node.file).filter(isSeedable)).some(({ id }) => id === node.id)) files.set(node.file, { locals: new Set([node.name]), own: true });
    const importing = store.symbolsByIds([...new Set(store.incomingEdges([node.id], ["imports"]).map((edge) => edge.source))]);
    for (const file of new Set(importing.filter(({ kind }) => kind === "file").map((symbol) => symbol.file))) {
      if (file === node.file || !readsWrittenUses(file)) continue;
      const locals = new Set([...(await importedDeclarations(file))].filter(([, declaration]) => declaration.id === node.id).map(([local]) => local));
      if (locals.size > 0) files.set(file, { locals, own: false });
    }
    return files;
  }

  /** The lines of `file` where the index already records a dependence of a declaration on `node`: a use it placed itself. */
  function indexedLines(node: GraphSymbol, file: string): ReadonlySet<number> {
    const edges = store.incomingEdges([node.id], FOLLOWED_EDGE_KINDS).filter((edge) => edge.line !== null);
    const sources = new Map(store.symbolsByIds([...new Set(edges.map((edge) => edge.source))]).map((symbol) => [symbol.id, symbol]));
    return new Set(edges.flatMap((edge) => {
      const source = sources.get(edge.source);
      return source !== undefined && source.file === file && source.kind !== "file" ? [edge.line!] : [];
    }));
  }

  function sitesIn(node: GraphSymbol, file: string, content: string, tokens: readonly Token[], imports: readonly { start: number; end: number }[], locals: ReadonlySet<string>, own: boolean): Site[] {
    const sites: Site[] = [];
    const indexed = indexedLines(node, file);
    const code = tokens.filter(({ text }) => text !== "\n");
    for (const [index, token] of code.entries()) {
      if (!locals.has(token.text) || !IDENTIFIER.test(token.text)) continue;
      if (imports.some(({ start, end }) => start <= token.startOffset && token.endOffset <= end)) continue;
      const previous = code[index - 1]?.text;
      if (previous !== undefined && DECLARING_KEYWORDS.has(previous)) continue;
      const column = token.startOffset - (content.lastIndexOf("\n", token.startOffset - 1) + 1);
      const at = { line: token.start, column };
      if ((own && contains(node, at)) || indexed.has(token.start)) continue;
      const owner = innermost(declarationsIn(file), at);
      sites.push({ node, file, local: token.text, own, line: token.start, column, ...(owner === undefined ? {} : { owner }) });
    }
    return sites;
  }

  function binds(site: Site, binding: RootBinding | undefined): boolean {
    if (binding === undefined || ("root" in binding && binding.root !== site.local)) return false;
    if (site.own) return (binding.kind === "declared" || binding.kind === "local") && binding.lines.some((line) => site.node.startLine <= line && line <= site.node.endLine);
    return binding.kind === "import" && binding.origin.kind === "repository";
  }

  /** The declaration that holds a place and may depend on `node` through it: the innermost the policy admits, or the class a decorator there belongs to. */
  async function holderOf(site: Site): Promise<GraphSymbol | undefined> {
    const at = { line: site.line, column: site.column };
    const admits = (from: GraphSymbol): boolean => from.id !== site.node.id && followsEdge({ kind: "references", sourceKind: from.kind, targetKind: site.node.kind });
    const around = declarationsIn(site.file).filter((symbol) => contains(symbol, at)).sort(bySpan);
    if (around.length > 0 || syntaxOf === undefined) return around.find(admits);
    const written = (await syntaxOf(site.file)).declarations.filter(({ kind, span }) => kind === "class" && before(span.start, { line: site.line, column: site.column + 1 }) && before({ line: site.line, column: site.column + 1 }, span.end));
    const classes = written.flatMap(({ name, span }) => declarationsIn(site.file).filter((symbol) => symbol.name === name && span.start.line <= symbol.startLine && symbol.endLine <= span.end.line && admits(symbol)));
    return classes.length === 1 ? classes[0] : undefined;
  }

  return {
    async into(nodes, signal) {
      const read = new Map<GraphNodeId, Set<string>>();
      const sites: Site[] = [];
      for (const node of new Map(nodes.map((node) => [node.id, node])).values()) {
        if (!readsWrittenUses(node.file)) continue;
        for (const [file, { locals, own }] of await filesOf(node)) {
          const source = byPath.get(file);
          if (source === undefined) continue;
          const tokens = await reading(source);
          if (tokens.status !== "read") continue;
          sites.push(...sitesIn(node, file, source.content, tokens.tokens, tokens.imports, locals, own));
          read.set(node.id, (read.get(node.id) ?? new Set()).add(file));
        }
      }
      const bindings = sites.length === 0 ? [] : await origins.rootBindings(sites.map(({ file, line, column, local, owner }): UseSite => ({ file, line, column: column + 1, spelled: local, owner: owner === undefined ? FILE_LEVEL : { name: owner.name, line: owner.startLine, endLine: owner.endLine } })), signal);
      const held: HeldUse[] = [];
      for (const [index, site] of sites.entries()) {
        const binding = bindings[index];
        const from = binds(site, binding) ? await holderOf(site) : undefined;
        if (from !== undefined) held.push({ node: site.node, file: site.file, line: site.line, name: site.local, from });
        else if (binding === undefined || binding.kind === "unknown" || binds(site, binding)) read.get(site.node.id)?.delete(site.file);
      }
      return { read, held };
    },
  };
}

function before(a: { line: number; column: number }, b: { line: number; column: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.column <= b.column);
}

/** Whether `symbol`'s span, in the index's 0-based columns with an exclusive end, holds the place. */
function contains(symbol: GraphSymbol, at: { line: number; column: number }): boolean {
  return before({ line: symbol.startLine, column: symbol.startColumn }, at) && !before({ line: symbol.endLine, column: symbol.endColumn }, at);
}

function innermost(symbols: readonly GraphSymbol[], at: { line: number; column: number }): GraphSymbol | undefined {
  return symbols.filter((symbol) => contains(symbol, at)).sort(bySpan)[0];
}

function bySpan(a: GraphSymbol, b: GraphSymbol): number {
  return b.startLine - a.startLine || b.startColumn - a.startColumn || a.endLine - b.endLine || a.endColumn - b.endColumn;
}
