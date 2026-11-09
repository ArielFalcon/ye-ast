import { joinsFact, type CodeNode } from "../shared/code-node.ts";
import type { BlastRadius } from "./blast-radius.ts";
import { kindOfChangedFile } from "./changed-file.ts";
import type { LineRange } from "./diff-reader.ts";

export type SeedBasis = "lines" | "top-level" | "resource" | "requested";

export interface SeedSymbol extends CodeNode {
  kind: string;
}

export interface SelectedSeed<S extends SeedSymbol> {
  symbol: S;
  basis: SeedBasis;
}

/** A component class and where it is declared; the line is any line of its declaration. */
export interface ComponentRef {
  file: string;
  name: string;
  line: number;
}

export interface SeedSelection<S extends SeedSymbol> {
  seeds: SelectedSeed<S>[];
  /** Changed source files with added lines and no symbol a walk could start from. */
  withoutSymbols: string[];
  /** The names the removed lines declared, whether or not a symbol held the removal: a seed never walks to their users. */
  removed: RemovedDeclaration[];
}

export interface RemovedDeclaration {
  file: string;
  name: string;
}

/** The declarations whose users a change can break; fields, parameters, imports and containers of files are parts of them. */
const SEEDABLE_KINDS: ReadonlySet<string> = new Set(["function", "method", "class", "component", "interface", "type_alias", "enum", "constant", "variable"]);

const CONTAINER_KINDS: ReadonlySet<string> = new Set(["class", "component", "interface"]);
const WHOLE_FILE: LineRange = { start: 1, end: Number.MAX_SAFE_INTEGER };
const BASIS_ORDER: readonly SeedBasis[] = ["lines", "resource", "top-level"];

export function isSeedable(symbol: SeedSymbol): boolean {
  return SEEDABLE_KINDS.has(symbol.kind);
}

/** The symbols not nested in another one of the list, in the order they come. */
export function topLevelOf<S extends SeedSymbol>(symbols: readonly S[]): S[] {
  return symbols.filter((symbol) => !symbols.some((other) => nests(symbol, other)));
}

export function selectSeeds<S extends SeedSymbol>(
  radius: Pick<BlastRadius, "files">,
  symbolsByFile: ReadonlyMap<string, readonly S[]>,
  componentsByResource: ReadonlyMap<string, readonly ComponentRef[]>,
  isRoot: (symbol: S) => boolean = isSeedable,
): SeedSelection<S> {
  const chosen = new Map<S, SeedBasis>();
  const withoutSymbols: string[] = [];
  const removed: RemovedDeclaration[] = [];
  const take = (symbol: S, basis: SeedBasis): void => {
    const held = chosen.get(symbol);
    if (held === undefined || BASIS_ORDER.indexOf(basis) < BASIS_ORDER.indexOf(held)) chosen.set(symbol, basis);
  };
  for (const change of radius.files) {
    for (const component of componentsByResource.get(change.path) ?? []) {
      const owner = (symbolsByFile.get(component.file) ?? []).find((symbol) => isRoot(symbol) && joinsFact(symbol, { path: component.file, line: component.line, symbol: component.name }));
      if (owner !== undefined) take(owner, "resource");
    }
    if (kindOfChangedFile(change.path) !== "source") continue;
    const symbols = (symbolsByFile.get(change.path) ?? []).filter(isRoot);
    for (const removal of change.removals) {
      const holder = innermostHolding(symbols, removal.after, removal.after + 1);
      if (holder !== undefined) {
        take(holder, "lines");
        continue;
      }
      const place: LineRange = { start: removal.after + 1, end: removal.after + 1 };
      const owners = symbols.filter((symbol) => intersects(ownLines(symbol, symbols), [place]));
      if (owners.length > 0) for (const symbol of owners) take(symbol, "lines");
      else for (const symbol of topLevelOf(symbols)) take(symbol, "top-level");
    }
    removed.push(...change.removedNames.map((name): RemovedDeclaration => ({ file: change.path, name })));
    const touched = change.binary ? [WHOLE_FILE] : change.added;
    if (symbols.length === 0) {
      if (touched.length > 0) withoutSymbols.push(change.path);
      continue;
    }
    for (const symbol of symbols) if (intersects(ownLines(symbol, symbols), touched)) take(symbol, "lines");
    const top = topLevelOf(symbols);
    if (subtract(touched, top.map(spanOf)).length > 0) for (const symbol of top) take(symbol, "top-level");
  }
  return { seeds: [...chosen].map(([symbol, basis]) => ({ symbol, basis })), withoutSymbols: withoutSymbols.toSorted(), removed };
}

function spanOf(symbol: SeedSymbol): LineRange {
  return { start: symbol.startLine, end: symbol.endLine };
}

function nests(child: SeedSymbol, parent: SeedSymbol): boolean {
  if (child === parent || child.startLine < parent.startLine || child.endLine > parent.endLine) return false;
  const sameSpan = child.startLine === parent.startLine && child.endLine === parent.endLine;
  return !sameSpan || (CONTAINER_KINDS.has(parent.kind) && !CONTAINER_KINDS.has(child.kind));
}

/** The lines of the symbol that no symbol nested in it holds. */
function ownLines(symbol: SeedSymbol, symbols: readonly SeedSymbol[]): LineRange[] {
  return subtract([spanOf(symbol)], symbols.filter((other) => nests(other, symbol)).map(spanOf));
}

function innermostHolding<S extends SeedSymbol>(symbols: readonly S[], first: number, second: number): S | undefined {
  const holders = symbols.filter((symbol) => symbol.startLine <= first && second <= symbol.endLine);
  return holders.find((symbol) => !holders.some((other) => nests(other, symbol)));
}

function intersects(ranges: readonly LineRange[], others: readonly LineRange[]): boolean {
  return ranges.some((range) => others.some((other) => range.start <= other.end && other.start <= range.end));
}

/** The parts of `ranges` that `holes` do not cover. */
function subtract(ranges: readonly LineRange[], holes: readonly LineRange[]): LineRange[] {
  const sorted = holes.toSorted((a, b) => a.start - b.start);
  return ranges.flatMap((range) => {
    const left: LineRange[] = [];
    let next = range.start;
    for (const hole of sorted) {
      if (hole.end < next || hole.start > range.end) continue;
      if (hole.start > next) left.push({ start: next, end: hole.start - 1 });
      next = Math.max(next, hole.end + 1);
    }
    if (next <= range.end) left.push({ start: next, end: range.end });
    return left;
  });
}
