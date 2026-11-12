import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import { isSeedable, selectSeeds, topLevelOf, type ComponentRef, type SeedSelection, type SelectedSeed } from "../../domain/change/seeds.ts";
import { triviaLinesOf } from "../../domain/change/token-lines.ts";
import { comparePosition, compareText } from "../../domain/shared/code-node.ts";
import type { SettledRangeChange } from "../../domain/impact/impact-fact.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import { branchesOf, type DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import type { Cut, Evidence } from "../../domain/shared/fact.ts";
import type { GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";
import type { CallersTarget } from "../../ports/impact-queries.port.ts";
import type { DeclarationModel, ModelDeclaration } from "./declaration-model.ts";
import { fileCut } from "../../domain/impact/impact-cuts.ts";
import type { RawUnknownEntry, SnapshotFiles } from "./snapshot-files.ts";

export interface RootSelection extends SeedSelection<GraphSymbol> {
  /** In position order. */
  seeds: SelectedSeed<GraphSymbol>[];
  syntaxSeeds: SelectedSeed<ModelDeclaration>[];
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
export async function requestedRanges(changes: readonly FileChange[], sources: readonly SourceFile[], tokens: SourceTokens, snapshot: SnapshotFiles, declarations: DeclarationModel): Promise<RequestedRanges> {
  const files = new Map(sources.map((file) => [file.path, file]));
  const symbolsByFile = new Map(await Promise.all(changes.map(async ({ path }) => [path, (await declarations.list(path)).filter(isSeedable)] as const)));
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
    const candidates = candidatesOf(await declarations.tree(change.path));
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
export async function selectRoots(
  declarations: DeclarationModel,
  changes: readonly FileChange[],
  requested: readonly { file: string; symbol: string }[],
  componentsByResource: ReadonlyMap<string, readonly ComponentRef[]>,
  uncovered: readonly RawUnknownEntry[] = [],
  isRoot: (symbol: GraphSymbol) => boolean = isSeedable,
  settled: RawUnknownEntry[] = [],
): Promise<RootSelection> {
  const sourceChanges = changes.filter((file) => kindOfChangedFile(file.path) === "source" && !file.deleted).map((file) => file.path);
  const componentFiles = changes.flatMap((file) => (componentsByResource.get(file.path) ?? []).map((component) => component.file));
  const files = [...new Set([...sourceChanges, ...componentFiles, ...requested.map(({ file }) => file)])];
  const symbolsByFile = new Map(await Promise.all(files.map(async (file) => [file, await declarations.list(file)] as const)));
  const missing = [...await missingTargets(declarations, requested, isRoot), ...uncovered];
  if (missing.length > 0) return { seeds: [], syntaxSeeds: [], withoutSymbols: [], removed: [], removalHolders: [], missing, settled };

  const selection = selectSeeds({ files: changes }, symbolsByFile, componentsByResource, (declaration) => isModelRoot(declaration, isRoot));
  const matched = await Promise.all(requested.map(async (target) => (await declarations.select(target.file, target.symbol)).filter((declaration) => isModelRoot(declaration, isRoot))));
  const requestedSymbols = new Map(matched.flat().map((declaration) => [declaration.id, declaration]));
  const chosen = [...[...requestedSymbols.values()].map((symbol): SelectedSeed<ModelDeclaration> => ({ symbol, basis: "requested" })), ...selection.seeds.filter(({ symbol }) => !requestedSymbols.has(symbol.id))];
  const ordered = chosen.toSorted((a, b) => comparePosition(a.symbol, b.symbol));
  return { ...selection,
    seeds: ordered.flatMap(({ symbol, basis }) => symbol.symbol === undefined ? [] : [{ symbol: symbol.symbol, basis }]),
    syntaxSeeds: ordered.filter(({ symbol }) => symbol.symbol === undefined),
    removalHolders: selection.removalHolders.flatMap(({ symbol }) => symbol ?? []),
    missing: [], settled,
  };
}

/**
 * The requested symbols that name no declaration root, with proven paths from the shared population as candidates.
 */
export async function missingTargets(declarations: DeclarationModel, requested: readonly { file: string; symbol: string }[], isRoot: (symbol: GraphSymbol) => boolean = isSeedable): Promise<RawUnknownEntry[]> {
  const files = [...new Set(requested.map(({ file }) => file))];
  const trees = new Map(await Promise.all(files.map(async (file) => [file, await declarations.tree(file)] as const)));
  const matched = await Promise.all(requested.map(async (target) => (await declarations.select(target.file, target.symbol)).some((declaration) => isModelRoot(declaration, isRoot))));
  return requested.filter((_, index) => !matched[index]).map((target) => ({ ...target, candidates: candidatesOf(trees.get(target.file) ?? [], isRoot) }));
}

/** The dotted paths of what a file declares that a request can seed, so a symbol that names no node tells the caller what does. */
function candidatesOf(tree: readonly DeclarationBranch<ModelDeclaration>[], isRoot: (symbol: GraphSymbol) => boolean = isSeedable): string[] {
  return sortedUnique(branchesOf(tree).filter(({ declaration }) => declaration.path !== undefined && isModelRoot(declaration, isRoot)).map(({ declaration }) => declaration.path!));
}

function isModelRoot(declaration: ModelDeclaration, isRoot: (symbol: GraphSymbol) => boolean): boolean {
  return declaration.symbol === undefined ? declaration.invoked === true || isSeedable(declaration) : isRoot(declaration.symbol);
}

export function syntaxRootCuts(seeds: readonly SelectedSeed<ModelDeclaration>[]): Cut[] {
  return seeds.map(({ symbol }) => ({ ...fileCut("no-extractor", symbol.file, "no-symbols"), at: [`${symbol.file}:${symbol.startLine} ${symbol.path ?? symbol.name}`] }));
}
