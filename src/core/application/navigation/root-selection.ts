import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import { isSeedable, selectSeeds, topLevelOf, type ComponentRef, type SeedSelection, type SelectedSeed } from "../../domain/change/seeds.ts";
import { comparePosition, compareText } from "../../domain/shared/code-node.ts";
import { branchesOf, declarationPath, selectedBySymbol, type DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import type { Evidence } from "../../domain/shared/fact.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";
import type { CallersTarget, UnknownSymbolFault } from "../../ports/impact-queries.port.ts";
import { containmentTree } from "../outline/outline.ts";

export interface RootSelection extends SeedSelection<GraphSymbol> {
  /** In position order. */
  seeds: SelectedSeed<GraphSymbol>[];
  /** The requested symbols that name no node, with what their file declares; nothing is selected when there is one. */
  missing: UnknownSymbolFault["entries"];
}

/** The targets once each, in a fixed order, so the same request in any order is the same fact. */
export function distinctTargets(targets: readonly CallersTarget[]): CallersTarget[] {
  const byKey = new Map(targets.map((target) => [JSON.stringify(target), target]));
  return [...byKey].sort(([a], [b]) => compareText(a, b)).map(([, target]) => target);
}

export function targetKey(target: CallersTarget): string {
  return "start" in target ? `${target.file}:${target.start}-${target.end}` : `${target.file}:${target.symbol}`;
}

export function evidenceOfTarget(target: CallersTarget): Evidence {
  return "start" in target ? { path: target.file, line: target.start, endLine: target.end } : { path: target.file, line: 1 };
}

/** The requested line ranges as the added lines of unchanged files, so they seed as changed lines do. */
export function rangeChanges(targets: readonly CallersTarget[]): FileChange[] {
  const ranges = targets.flatMap((target) => ("start" in target ? [target] : []));
  return [...Map.groupBy(ranges, ({ file }) => file)]
    .map(([path, inFile]): FileChange => ({ path, deleted: false, binary: false, added: inFile.map(({ start, end }) => ({ start, end })), removals: [], removedNames: [] }))
    .sort((a, b) => compareText(a.path, b.path));
}

/**
 * The requested ranges without their lines that no top-level declaration holds and the language's tokenizer reads as
 * trivia: such a line selects nothing, where a changed one would select every top-level declaration of its file. A file
 * the sources do not hold, or that declares nothing, keeps its ranges.
 */
export async function requestedRanges(store: CodeGraphReader, changes: readonly FileChange[], sources: readonly SourceFile[], trivia: SourceTrivia): Promise<FileChange[]> {
  const files = new Map(sources.map((file) => [file.path, file]));
  const symbolsByFile = Map.groupBy(store.symbolsInFiles(changes.map(({ path }) => path)).filter(isSeedable), (symbol) => symbol.file);
  return Promise.all(changes.map(async (change) => {
    const file = files.get(change.path);
    const top = topLevelOf(symbolsByFile.get(change.path) ?? []);
    if (file === undefined || top.length === 0) return change;
    const quiet = await trivia.triviaLines(file);
    const lastLine = file.content.split("\n").length;
    const selects = (line: number): boolean => !quiet.has(line) || top.some((symbol) => symbol.startLine <= line && line <= symbol.endLine);
    return { ...change, added: change.added.flatMap(({ start, end }) => runsOf(start, Math.min(end, lastLine), selects)) };
  }));
}

/** Asks for each file's trivia lines once, for the life of one query. */
export function triviaOncePerFile(trivia: SourceTrivia): SourceTrivia {
  const read = new Map<string, Promise<ReadonlySet<number>>>();
  return {
    triviaLines: (file) => {
      let lines = read.get(file.path);
      if (lines === undefined) {
        lines = trivia.triviaLines(file);
        read.set(file.path, lines);
      }
      return lines;
    },
  };
}

function runsOf(start: number, end: number, selects: (line: number) => boolean): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  for (let line = start; line <= end; line += 1) {
    if (!selects(line)) continue;
    const last = runs.at(-1);
    if (last !== undefined && last.end === line - 1) last.end = line;
    else runs.push({ start: line, end: line });
  }
  return runs;
}

/**
 * The declarations a request starts from: each requested symbol selects every declaration its name or dotted path
 * names in its file, and the changes select what their lines, resources or top-level code touch.
 */
export function selectRoots(
  store: CodeGraphReader,
  changes: readonly FileChange[],
  requested: readonly { file: string; symbol: string }[],
  componentsByResource: ReadonlyMap<string, readonly ComponentRef[]>,
): RootSelection {
  const sourceChanges = changes.filter((file) => kindOfChangedFile(file.path) === "source" && !file.deleted).map((file) => file.path);
  const componentFiles = changes.flatMap((file) => (componentsByResource.get(file.path) ?? []).map((component) => component.file));
  const symbols = store.symbolsInFiles([...new Set([...sourceChanges, ...componentFiles, ...requested.map(({ file }) => file)])]);
  const symbolsByFile = Map.groupBy(symbols, (symbol) => symbol.file);
  const trees = new Map([...new Set(requested.map(({ file }) => file))].map((file) => [file, containmentTree(store, symbolsByFile.get(file) ?? [])]));
  const asked = requested.map((target) => ({ target, found: selectedBySymbol(trees.get(target.file) ?? [], target.symbol).map(({ declaration }) => declaration).filter(isSeedable) }));
  const missing = asked.filter(({ found: nodes }) => nodes.length === 0).map(({ target }) => ({ ...target, candidates: candidatesOf(trees.get(target.file) ?? []) }));
  if (missing.length > 0) return { seeds: [], withoutSymbols: [], removed: [], missing };

  const selection = selectSeeds({ files: changes }, symbolsByFile, componentsByResource);
  const requestedSymbols = new Set(asked.flatMap(({ found: nodes }) => nodes));
  const chosen = [...[...requestedSymbols].map((symbol): SelectedSeed<GraphSymbol> => ({ symbol, basis: "requested" })), ...selection.seeds.filter(({ symbol }) => !requestedSymbols.has(symbol))];
  return { ...selection, seeds: chosen.toSorted((a, b) => comparePosition(a.symbol, b.symbol)), missing: [] };
}

/** The dotted paths of what a file declares that a request can seed, so a symbol that names no node tells the caller what does. */
function candidatesOf(tree: readonly DeclarationBranch<GraphSymbol>[]): string[] {
  return [...new Set(branchesOf(tree).filter(({ declaration }) => isSeedable(declaration)).map(declarationPath))].sort(compareText);
}
