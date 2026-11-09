import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import { isSeedable, selectSeeds, topLevelOf, type ComponentRef, type SeedSelection, type SelectedSeed } from "../../domain/change/seeds.ts";
import { comparePosition, compareText } from "../../domain/shared/code-node.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import { branchesOf, declarationPath, selectedBySymbol, type DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import type { Evidence } from "../../domain/shared/fact.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";
import type { CallersTarget } from "../../ports/impact-queries.port.ts";
import { containmentTree } from "./containment-tree.ts";
import type { RawUnknownEntry, SnapshotFiles } from "./snapshot-files.ts";

export interface RootSelection extends SeedSelection<GraphSymbol> {
  /** In position order. */
  seeds: SelectedSeed<GraphSymbol>[];
  /** The requested symbols that name no node, with what their file declares; nothing is selected when there is one. */
  missing: RawUnknownEntry[];
}

/** The targets once each, in a fixed order, so the same request in any order is the same fact. */
export function distinctTargets<Target>(targets: readonly Target[]): Target[] {
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

export interface RequestedRanges {
  changes: FileChange[];
  /** The ranges that kept no line: past the end of their file, only trivia outside every declaration, or a file no snapshot holds. */
  uncovered: RawUnknownEntry[];
}

/**
 * The requested ranges without their lines that no top-level declaration holds and the language's tokenizer reads as
 * trivia: such a line selects nothing, where a changed one would select every top-level declaration of its file. A range
 * left with no line selects nothing at all and is `uncovered`, and so is every range of a file the snapshot does not
 * hold. A file the snapshot holds but the sources do not, or that declares nothing, keeps its ranges.
 */
export async function requestedRanges(store: CodeGraphReader, changes: readonly FileChange[], sources: readonly SourceFile[], trivia: SourceTrivia, snapshot: SnapshotFiles): Promise<RequestedRanges> {
  const files = new Map(sources.map((file) => [file.path, file]));
  const symbolsByFile = Map.groupBy(store.symbolsInFiles(changes.map(({ path }) => path)).filter(isSeedable), (symbol) => symbol.file);
  const narrowed = await Promise.all(changes.map(async (change) => {
    const file = files.get(change.path);
    const symbols = symbolsByFile.get(change.path) ?? [];
    const top = topLevelOf(symbols);
    if (file === undefined) {
      const absent = snapshot.holds(change.path) ? [] : change.added.map(({ start, end }): RawUnknownEntry => ({ file: change.path, start, end, candidates: [] }));
      return { change: absent.length === 0 ? change : undefined, uncovered: absent };
    }
    if (top.length === 0) return { change, uncovered: [] };
    const quiet = await trivia.triviaLines(file);
    const lastLine = file.content.split("\n").length;
    const selects = (line: number): boolean => !quiet.has(line) || top.some((symbol) => symbol.startLine <= line && line <= symbol.endLine);
    const ranges = change.added.map(({ start, end }) => ({ start, end, runs: runsOf(start, Math.min(end, lastLine), selects) }));
    return {
      change: { ...change, added: ranges.flatMap(({ runs }) => runs) },
      uncovered: ranges.filter(({ runs }) => runs.length === 0).map(({ start, end }) => ({ file: change.path, start, end, candidates: candidatesOf(containmentTree(store, store.symbolsInFiles([change.path]))) })),
    };
  }));
  return { changes: narrowed.flatMap(({ change }) => (change === undefined ? [] : [change])), uncovered: narrowed.flatMap(({ uncovered }) => uncovered) };
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
 * names in its file, and the changes select what their lines, resources or top-level code touch. A requested symbol
 * that names nothing, or an `uncovered` range, makes it `missing`, and nothing is selected.
 */
export function selectRoots(
  store: CodeGraphReader,
  changes: readonly FileChange[],
  requested: readonly { file: string; symbol: string }[],
  componentsByResource: ReadonlyMap<string, readonly ComponentRef[]>,
  uncovered: readonly RawUnknownEntry[] = [],
  isRoot: (symbol: GraphSymbol) => boolean = isSeedable,
): RootSelection {
  const sourceChanges = changes.filter((file) => kindOfChangedFile(file.path) === "source" && !file.deleted).map((file) => file.path);
  const componentFiles = changes.flatMap((file) => (componentsByResource.get(file.path) ?? []).map((component) => component.file));
  const symbols = store.symbolsInFiles([...new Set([...sourceChanges, ...componentFiles, ...requested.map(({ file }) => file)])]);
  const symbolsByFile = Map.groupBy(symbols, (symbol) => symbol.file);
  const missing = [...missingTargets(store, requested, isRoot), ...uncovered];
  if (missing.length > 0) return { seeds: [], withoutSymbols: [], removed: [], missing };

  const trees = new Map([...new Set(requested.map(({ file }) => file))].map((file) => [file, containmentTree(store, symbolsByFile.get(file) ?? [])]));
  const selection = selectSeeds({ files: changes }, symbolsByFile, componentsByResource, isRoot);
  const requestedSymbols = new Set(requested.flatMap((target) => selectedBySymbol(trees.get(target.file) ?? [], target.symbol).map(({ declaration }) => declaration).filter(isRoot)));
  const chosen = [...[...requestedSymbols].map((symbol): SelectedSeed<GraphSymbol> => ({ symbol, basis: "requested" })), ...selection.seeds.filter(({ symbol }) => !requestedSymbols.has(symbol))];
  return { ...selection, seeds: chosen.toSorted((a, b) => comparePosition(a.symbol, b.symbol)), missing: [] };
}

/**
 * The requested symbols that name no root of their file, each with the file's dotted paths as candidates; read from
 * the store alone, so a wrong name fails before any reader runs over the snapshot.
 */
export function missingTargets(store: CodeGraphReader, requested: readonly { file: string; symbol: string }[], isRoot: (symbol: GraphSymbol) => boolean = isSeedable): RawUnknownEntry[] {
  const files = [...new Set(requested.map(({ file }) => file))];
  const byFile = Map.groupBy(store.symbolsInFiles(files), (symbol) => symbol.file);
  const trees = new Map(files.map((file) => [file, containmentTree(store, byFile.get(file) ?? [])]));
  return requested
    .filter((target) => selectedBySymbol(trees.get(target.file) ?? [], target.symbol).every(({ declaration }) => !isRoot(declaration)))
    .map((target) => ({ ...target, candidates: candidatesOf(trees.get(target.file) ?? [], isRoot) }));
}

/** The dotted paths of what a file declares that a request can seed, so a symbol that names no node tells the caller what does. */
function candidatesOf(tree: readonly DeclarationBranch<GraphSymbol>[], isRoot: (symbol: GraphSymbol) => boolean = isSeedable): string[] {
  return sortedUnique(branchesOf(tree).filter(({ declaration }) => isRoot(declaration)).map(declarationPath));
}
