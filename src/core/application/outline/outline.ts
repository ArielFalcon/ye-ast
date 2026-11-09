import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import type { ModuleBinding, ModuleDependencies, ModuleDependency, UntraversedReference } from "../../domain/impact/module-dependency.ts";
import type { OutlineBinding, OutlineDeclaration, OutlineFile, OutlineFocus, OutlineFocusValue, OutlineImport, OutlineListing, OutlineUse } from "../../domain/outline/outline-fact.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import { unresolvedPlaceCuts } from "../../domain/impact/impact-cuts.ts";
import { fileReach } from "../../domain/languages/call-targets.ts";
import { containmentTree } from "../navigation/containment-tree.ts";
import { importBindings } from "../navigation/import-bindings.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { branchesOf, declarationPath, innermostAt, selectedBySymbol, type DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { UnknownSymbolFault } from "../../ports/impact-queries.port.ts";
import type { OutlineSelector, TopLevelLineFault } from "../../ports/outline-queries.port.ts";
import { outlineUses, unprovedUseCuts } from "../../domain/outline/outline-uses.ts";
import { usesOf } from "../navigation/declaration-uses.ts";
import { unmatchedCalls } from "../navigation/reverse-calls.ts";
import type { BaseReading } from "../snapshot/base-reading.ts";
import type { TypeTarget } from "../../ports/type-bindings.port.ts";
import { createGraphNavigation } from "../navigation/graph-navigation.ts";

export interface ListingRead {
  value: OutlineListing;
  /** A repository binding the join did not prove, and a requested file whose module statements no reader read whole. */
  cuts: Cut[];
}

/** The shape of every requested file: declarations from the graph, imports from the module statements of its sources. */
export function readOutline(store: CodeGraphReader, requested: readonly string[], modules: ModuleDependencies): ListingRead {
  const files: OutlineFile[] = [];
  const unheld: string[] = [];
  const cuts: Cut[] = [];
  const unproved: ReturnType<typeof unprovedBindings> = [];
  const statements = Map.groupBy(modules.dependencies, (dependency) => dependency.file);
  const references = Map.groupBy(modules.untraversed ?? [], (reference) => reference.file);
  const unread = new Set(modules.unread.map(({ file }) => file));
  const read = new Set(modules.files.map(({ file }) => file));
  for (const file of sortedUnique(requested)) {
    const nodes = store.symbolsInFiles([file]);
    if (nodes.length === 0) {
      unheld.push(file);
      continue;
    }
    if (unread.has(file) || !read.has(file)) cuts.push({ kind: "no-extractor", at: [file], reason: "module-unread", reach: fileReach(file) });
    const dependencies = statements.get(file) ?? [];
    const reached = importBindings(store, file, dependencies);
    unproved.push(...unprovedBindings(dependencies, reached));
    const placed = [...dependencies.map((dependency) => ({ ...dependency, entry: imported(dependency, reached) })), ...(references.get(file) ?? []).map((reference) => ({ ...reference, entry: referenced(reference) }))];
    files.push({
      file,
      declarations: containmentTree(store, nodes).map(outlined),
      imports: placed.toSorted((left, right) => left.line - right.line || (left.offset ?? 0) - (right.offset ?? 0)).map(({ entry }) => entry),
    });
  }
  return { value: { files, unheld }, cuts: [...cuts, ...unresolvedPlaceCuts(unproved, "use-unproven")] };
}

function unprovedBindings(dependencies: readonly ModuleDependency[], reached: ReadonlyMap<ModuleBinding, GraphSymbol>) {
  return dependencies.flatMap((dependency) =>
    dependency.target.kind === "repository"
      ? dependency.bindings.filter((binding) => !reached.has(binding) && binding.imported !== "*").map((binding) => ({ file: dependency.file, line: binding.line, reason: binding.local ?? binding.imported }))
      : [],
  );
}

function imported(dependency: ModuleDependency, reached: ReadonlyMap<ModuleBinding, GraphSymbol>): OutlineImport {
  const bindings = dependency.bindings.map((binding): OutlineBinding => {
    const declaration = reached.get(binding);
    return {
      ...(binding.local === undefined ? {} : { local: binding.local }),
      imported: binding.imported,
      ...(binding.typeOnly ? { typeOnly: true as const } : {}),
      ...(declaration === undefined ? {} : { declaration: { file: declaration.file, name: declaration.name, kind: declaration.kind, line: declaration.startLine, endLine: declaration.endLine } }),
    };
  });
  const { line, endLine, specifier, kind, form, typeOnly, target } = dependency;
  return { line, endLine, specifier, kind, ...(form === undefined ? {} : { form }), typeOnly, target, bindings };
}

/** A runtime module reference module traversal does not follow: listed with where it leads, or explicitly unresolved. */
function referenced(reference: UntraversedReference): OutlineImport {
  const { line, endLine = line, specifier, form, target = { kind: "unresolved", reason: COMPUTED_SPECIFIER } } = reference;
  return { line, endLine, ...(specifier === undefined ? {} : { specifier }), kind: "import", form, typeOnly: form === "type-query", target, bindings: [] };
}

const COMPUTED_SPECIFIER = "a computed expression names the module";

function outlined({ declaration, children }: DeclarationBranch<GraphSymbol>): OutlineDeclaration {
  const nested = children.map(outlined);
  return { kind: declaration.kind, name: declaration.name, line: declaration.startLine, endLine: declaration.endLine, ...(nested.length > 0 && { children: nested }) };
}

export interface FocusRead {
  value: OutlineFocusValue;
  /** The symbol selectors that match no declaration of their file. */
  unknown: UnknownSymbolFault["entries"];
  /** The line selectors no declaration of their file holds. */
  topLevel: TopLevelLineFault["entries"];
  /** The matched declaration of each entry of `value.focus` with what it contains, in the same order. */
  matched: readonly DeclarationBranch<GraphSymbol>[];
}

/** The declarations the selectors match, each with its containers and the count of its file's declarations left out. */
export function readFocus(store: CodeGraphReader, selectors: readonly OutlineSelector[]): FocusRead {
  const focus: { entry: OutlineFocus; branch: DeclarationBranch<GraphSymbol> }[] = [];
  const unheld: string[] = [];
  const unknown: FocusRead["unknown"][number][] = [];
  const topLevel: FocusRead["topLevel"][number][] = [];
  for (const [file, asked] of [...Map.groupBy(selectors, (selector) => selector.file)].sort(([a], [b]) => compareText(a, b))) {
    const nodes = store.symbolsInFiles([file]);
    if (nodes.length === 0) {
      unheld.push(file);
      continue;
    }
    const tree = containmentTree(store, nodes);
    const declared = branchesOf(tree);
    const candidates = sortedUnique(declared.map(declarationPath));
    for (const selector of asked) {
      const matched = "symbol" in selector ? selectedBySymbol(tree, selector.symbol) : innermostAt(tree, selector.line);
      if (matched.length === 0 && "symbol" in selector) unknown.push({ file, symbol: selector.symbol, candidates });
      if (matched.length === 0 && "line" in selector) topLevel.push({ file, line: selector.line, candidates });
      const text = "symbol" in selector ? selector.symbol : String(selector.line);
      focus.push(...matched.map((branch) => ({ entry: focused(file, text, branch, declared.length), branch })));
    }
  }
  const ordered = focus.toSorted((a, b) => compareText(a.entry.file, b.entry.file) || a.entry.declaration.line - b.entry.declaration.line);
  return { value: { focus: ordered.map(({ entry }) => entry), unheld }, unknown, topLevel, matched: ordered.map(({ branch }) => branch) };
}

function focused(file: string, selector: string, branch: DeclarationBranch<GraphSymbol>, declarations: number): OutlineFocus {
  const ancestors = branch.ancestors.map(({ kind, name, startLine, endLine }) => ({ kind, name, line: startLine, endLine }));
  return { file, selector, path: declarationPath(branch), ancestors, declaration: outlined(branch), omitted: declarations - ancestors.length - branchesOf([branch]).length };
}

/**
 * Each focused declaration with what its own body uses, and one `unresolved-link` cut per name it uses that no binding
 * proves, a call the index matched by name alone included (ADR-0036). A declaration two selectors match is read once.
 */
export async function focusWithUses(store: CodeGraphReader, read: FocusRead, reading: BaseReading, typed: ReadonlyMap<string, TypeTarget> | undefined, signal: AbortSignal | undefined): Promise<{ focus: OutlineFocus[]; cuts: Cut[] } | "aborted"> {
  const origins = reading.origins();
  const targets = reading.edgeTargets(typed);
  if (origins === undefined || targets === undefined) throw new Error("a focus binds its uses through the line's import origins");
  const uses = reading.declarationUses();
  const reconciled = reading.reconciledCalls(targets, uses);
  const writtenCalls = reconciled === undefined ? undefined : async (body: GraphSymbol) => unmatchedCalls(await reconciled.callsOf(body));
  const input = { store, navigation: createGraphNavigation(store, () => false), uses, targets, origins, writtenCalls, ...(signal === undefined ? {} : { signal }) };
  const settled = new Map<GraphSymbol["id"], { uses: readonly OutlineUse[]; cuts: Cut[] }>();
  const focus: OutlineFocus[] = [];
  for (const [index, entry] of read.value.focus.entries()) {
    const branch = read.matched[index]!;
    let answer = settled.get(branch.declaration.id);
    if (answer === undefined) {
      const { found, unproved } = await usesOf(branch, input);
      if (signal?.aborted) return "aborted";
      answer = { uses: outlineUses(found), cuts: unprovedUseCuts(entry.file, entry.path, unproved) };
      settled.set(branch.declaration.id, answer);
    }
    focus.push({ ...entry, uses: answer.uses });
  }
  return { focus, cuts: [...settled.values()].flatMap(({ cuts }) => cuts) };
}
