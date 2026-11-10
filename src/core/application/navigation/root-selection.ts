import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import { isSeedable, selectSeeds, topLevelOf, type ComponentRef, type SeedSelection, type SelectedSeed } from "../../domain/change/seeds.ts";
import { triviaLinesOf } from "../../domain/change/token-lines.ts";
import { comparePosition, compareText } from "../../domain/shared/code-node.ts";
import type { SettledRangeChange } from "../../domain/impact/impact-fact.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import { branchesOf, declarationPath, selectedBySymbol, type DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import type { Evidence } from "../../domain/shared/fact.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";
import type { CallersTarget } from "../../ports/impact-queries.port.ts";
import { containmentTree } from "./containment-tree.ts";
import type { RawUnknownEntry, SnapshotFiles } from "./snapshot-files.ts";

export interface RootSelection extends SeedSelection<GraphSymbol> {
  /** In position order. */
  seeds: SelectedSeed<GraphSymbol>[];
  /** The requested symbols that name no node, with what their file declares; nothing is selected when there is one. */
  missing: RawUnknownEntry[];
  /** The ranges whose every line holds no token: they select nothing and answer successfully (ADR-0043 decision 3). */
  settled: RawUnknownEntry[];
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
    .map(([path, inFile]): FileChange => ({
      path,
      deleted: false,
      binary: false,
      added: inFile.map(({ start, end }) => ({ start, end })),
      removals: [],
      removedNames: [],
      hunks: inFile.map(({ start, end }) => ({ head: { start, end }, removedNames: [] })),
    }))
    .sort((a, b) => compareText(a.path, b.path));
}

export interface RequestedRanges {
  changes: FileChange[];
  /** The ranges that kept no line: past the end of their file, or a file no snapshot holds. */
  uncovered: RawUnknownEntry[];
  /** The ranges whose every line holds no token: they select nothing and answer successfully (ADR-0043 decision 3). */
  settled: RawUnknownEntry[];
}

/**
 * The requested ranges without their lines no token touches: such a line selects nothing, wherever it lies. A range left
 * with no line because every line is trivia is `settled`, never a fault; a range wholly past the end of its file is
 * `uncovered`, and so is every range of a file the snapshot does not hold. A file the snapshot holds but the sources do
 * not, one that declares nothing, and one no pack tokenizes keep today's line rules.
 */
export async function requestedRanges(store: CodeGraphReader, changes: readonly FileChange[], sources: readonly SourceFile[], tokens: SourceTokens, snapshot: SnapshotFiles): Promise<RequestedRanges> {
  const files = new Map(sources.map((file) => [file.path, file]));
  const symbolsByFile = Map.groupBy(store.symbolsInFiles(changes.map(({ path }) => path)).filter(isSeedable), (symbol) => symbol.file);
  const narrowed = await Promise.all(changes.map(async (change) => {
    const file = files.get(change.path);
    const symbols = symbolsByFile.get(change.path) ?? [];
    const top = topLevelOf(symbols);
    if (file === undefined) {
      const absent = snapshot.holds(change.path) ? [] : change.added.map(({ start, end }): RawUnknownEntry => ({ file: change.path, start, end, candidates: [] }));
      return { change: absent.length === 0 ? change : undefined, uncovered: absent, settled: [] };
    }
    if (top.length === 0) return { change, uncovered: [], settled: [] };
    const reading = await tokens.tokensOf(file);
    const quiet = reading.status === "read" ? triviaLinesOf(reading, file.content.split("\n").length) : new Set<number>();
    const lastLine = file.content.split("\n").length;
    const selects = (line: number): boolean => !quiet.has(line) || (reading.status !== "read" && top.some((symbol) => symbol.startLine <= line && line <= symbol.endLine));
    const ranges = change.added.map(({ start, end }) => ({ start, end, runs: runsOf(start, Math.min(end, lastLine), selects) }));
    const candidates = candidatesOf(containmentTree(store, store.symbolsInFiles([change.path])));
    const entries = (left: readonly { start: number; end: number }[]): RawUnknownEntry[] => left.map(({ start, end }) => ({ file: change.path, start, end, candidates }));
    return {
      change: { ...change, added: ranges.flatMap(({ runs }) => runs) },
      uncovered: entries(ranges.filter(({ runs, start }) => runs.length === 0 && start > lastLine)),
      settled: reading.status === "read" ? entries(ranges.filter(({ runs, start }) => runs.length === 0 && start <= lastLine)) : [],
    };
  }));
  return { changes: narrowed.flatMap(({ change }) => (change === undefined ? [] : [change])), uncovered: narrowed.flatMap(({ uncovered }) => uncovered), settled: narrowed.flatMap(({ settled }) => settled) };
}

/** The settled ranges as the answer carries them, sorted by file and position. */
export function settledRangeChanges(entries: readonly RawUnknownEntry[]): SettledRangeChange[] {
  return entries
    .flatMap((entry): SettledRangeChange[] => ("start" in entry ? [{ basis: "range", file: entry.file, start: entry.start, end: entry.end, reason: "no-token", candidates: entry.candidates }] : []))
    .sort((a, b) => compareText(a.file, b.file) || a.start - b.start);
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
  settled: RawUnknownEntry[] = [],
): RootSelection {
  const sourceChanges = changes.filter((file) => kindOfChangedFile(file.path) === "source" && !file.deleted).map((file) => file.path);
  const componentFiles = changes.flatMap((file) => (componentsByResource.get(file.path) ?? []).map((component) => component.file));
  const symbols = store.symbolsInFiles([...new Set([...sourceChanges, ...componentFiles, ...requested.map(({ file }) => file)])]);
  const symbolsByFile = Map.groupBy(symbols, (symbol) => symbol.file);
  const missing = [...missingTargets(store, requested, isRoot), ...uncovered];
  if (missing.length > 0) return { seeds: [], withoutSymbols: [], removed: [], removalHolders: [], missing, settled };

  const trees = new Map([...new Set(requested.map(({ file }) => file))].map((file) => [file, containmentTree(store, symbolsByFile.get(file) ?? [])]));
  const selection = selectSeeds({ files: changes }, symbolsByFile, componentsByResource, isRoot);
  const requestedSymbols = new Set(requested.flatMap((target) => selectedBySymbol(trees.get(target.file) ?? [], target.symbol).map(({ declaration }) => declaration).filter(isRoot)));
  const chosen = [...[...requestedSymbols].map((symbol): SelectedSeed<GraphSymbol> => ({ symbol, basis: "requested" })), ...selection.seeds.filter(({ symbol }) => !requestedSymbols.has(symbol))];
  return { ...selection, seeds: chosen.toSorted((a, b) => comparePosition(a.symbol, b.symbol)), missing: [], settled };
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
