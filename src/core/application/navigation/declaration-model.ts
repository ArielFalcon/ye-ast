import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { branchesOf, declarationPath, declarationTree, selectedBySymbol, type DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import { comparePositions, containsPosition, declarationSpan, owningBody, type SourcePosition } from "../../domain/shared/owning-body.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { DeclaredDeclaration } from "../../ports/declared-member-names.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { FrameworkMemberBinding } from "../../ports/framework-members.port.ts";
import type { Evidence } from "../../domain/shared/fact.ts";

export interface ModelDeclaration {
  id: string;
  file: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  symbol?: GraphSymbol;
  path?: string;
  invoked?: boolean;
  binding?: SourcePosition;
  bindingEvidence?: readonly Evidence[];
  bindingConflict?: true;
  deferredFactory?: true;
}

export interface DeclarationModel {
  tree(file: string): Promise<readonly DeclarationBranch<ModelDeclaration>[]>;
  select(file: string, symbol: string): Promise<readonly ModelDeclaration[]>;
  list(file: string): Promise<readonly ModelDeclaration[]>;
  ownersOf(file: string, at: SourcePosition): Promise<readonly ModelDeclaration[]>;
}

export function indexedDeclaration(declaration: GraphSymbol | ModelDeclaration): GraphSymbol | undefined {
  if ("symbol" in declaration && declaration.symbol !== undefined) return declaration.symbol;
  return "qualifiedName" in declaration ? declaration : undefined;
}

export class AmbiguousDeclaration extends Error {
  readonly kind = "ambiguous-declaration";
  constructor(readonly file: string, readonly path: string, readonly declarations: readonly ModelDeclaration[]) {
    super(`Ambiguous declaration ${file}:${path}: ${declarations.map(({ startLine, startColumn }) => `${startLine}:${startColumn}`).join(", ")}`);
    this.name = "AmbiguousDeclaration";
  }
}

export interface DeclarationModelDeps {
  store: CodeGraphReader;
  declarationsIn(file: string): Promise<readonly DeclaredDeclaration[]>;
  bindingsIn?(file: string): Promise<readonly FrameworkMemberBinding[]>;
  sources?: readonly SourceFile[];
  facts?: DerivedFacts | undefined;
}

const positioned = (a: ModelDeclaration, b: ModelDeclaration): number => a.startLine - b.startLine || a.startColumn - b.startColumn || compareText(a.name, b.name);
const positionKey = ({ line, column }: SourcePosition): string => `${line}:${column}`;

function compatibleKind(indexed: string, written: DeclaredDeclaration["kind"]): boolean {
  if (indexed === written) return true;
  if (written === "object") return ["variable", "constant", "property", "field"].includes(indexed);
  if (written === "accessor") return ["method", "property", "field"].includes(indexed);
  return ["method", "function"].includes(written) && ["method", "function"].includes(indexed);
}

export function createDeclarationModel({ store, declarationsIn, bindingsIn, sources = [], facts }: DeclarationModelDeps): DeclarationModel {
  const contents = new Map(sources.map(({ path, content }) => [path, content]));
  const files = new Map<string, Promise<{ tree: readonly DeclarationBranch<ModelDeclaration>[]; list: readonly ModelDeclaration[] }>>();
  const read = (file: string) => {
    let held = files.get(file);
    if (held === undefined) {
      held = (async () => {
        const symbols = store.symbolsInFiles([file]).filter(({ kind }) => !NOT_DECLARED_KINDS.includes(kind));
        const containment = store.outgoingEdges(symbols.map(({ id }) => id), ["contains"]).map(({ source, target }) => ({ source: `index:${source}`, target: `index:${target}` }));
        const bindings = await bindingsIn?.(file) ?? [];
        const written = await declarationsIn(file);
        const byPlace = new Map(written.map((node) => [positionKey(node.span.start), node]));
        for (const node of bindings.flatMap(({ declaration }) => declaration ?? [])) if (!byPlace.has(positionKey(node.span.start))) byPlace.set(positionKey(node.span.start), node);
        const syntax = [...byPlace.values()];
        const derive = async () => join(file, symbols, containment, syntax, bindings);
        return facts === undefined ? derive() : facts.ofInputs("declaration-model", { file, content: contents.get(file) ?? null, symbols, containment, syntax, bindings }, derive);
      })();
      files.set(file, held);
    }
    return held;
  };
  return {
    tree: async (file) => (await read(file)).tree,
    list: async (file) => (await read(file)).list,
    async select(file, symbol) {
      const found = selectedBySymbol((await read(file)).tree, symbol).map(({ declaration }) => declaration).filter(({ path }) => path !== undefined).sort(positioned);
      const paths = Map.groupBy(found, ({ path }) => path!);
      for (const [path, declarations] of paths) if (declarations.length > 1 && declarations.some(({ symbol }) => symbol === undefined)) throw new AmbiguousDeclaration(file, path, declarations);
      return found;
    },
    async ownersOf(file, at) {
      return (await read(file)).list.filter((declaration) => containsPosition(declarationSpan(declaration), at))
        .sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn || a.endLine - b.endLine || a.endColumn - b.endColumn);
    },
  };
}

function join(file: string, symbols: readonly GraphSymbol[], containment: { source: string; target: string }[], syntax: readonly DeclaredDeclaration[], bindings: readonly FrameworkMemberBinding[]) {
  const pairs = [...containment];
  const indexed = symbols.map((symbol): ModelDeclaration => ({ ...symbol, id: `index:${symbol.id}`, symbol }));
  const named = Map.groupBy(indexed, ({ name }) => name);
  const declarations = [...indexed];
  const joined = new Map<DeclaredDeclaration, ModelDeclaration>();
  for (const written of syntax) {
    const candidates = (named.get(written.name) ?? []).filter(({ kind }) => compatibleKind(kind, written.kind)).map((declaration) => ({ ...declarationSpan(declaration), declaration }));
    const aligned = candidates.filter(({ start, end }) => containsPosition(written.span, start) && comparePositions(end, written.span.end) === 0);
    const existing = owningBody(candidates, written.span.start)?.declaration ?? (aligned.length === 1 ? aligned[0]!.declaration : undefined);
    const declaration: ModelDeclaration = existing ?? { id: `syntax:${file}:${written.span.start.line}:${written.span.start.column}`, file, name: written.name, kind: written.kind, startLine: written.span.start.line, startColumn: written.span.start.column, endLine: written.span.end.line, endColumn: written.span.end.column };
    declaration.invoked = written.invoked;
    if (written.binding !== undefined) declaration.binding = written.binding;
    if (existing === undefined) declarations.push(declaration);
    joined.set(written, declaration);
  }
  const unplaced = new Set<string>();
  const at = Map.groupBy(declarations, ({ startLine, startColumn }) => positionKey({ line: startLine, column: startColumn }));
  const onLine = Map.groupBy(declarations, ({ startLine }) => startLine);
  for (const [written, declaration] of joined) {
    const container = written.binding ?? written.container;
    if (declaration.symbol !== undefined || container === undefined) continue;
    const parents = (at.get(positionKey(container)) ?? []).filter(({ id }) => id !== declaration.id);
    const headers = parents.length === 0 ? (onLine.get(container.line) ?? []).filter((parent) => parent.id !== declaration.id && parent.startColumn >= container.column && containsPosition(declarationSpan(parent), written.span.start)) : parents;
    const parent = headers.length === 1 ? headers[0] : undefined;
    if (parent === undefined) unplaced.add(declaration.id);
    else pairs.push({ source: parent.id, target: declaration.id });
  }
  for (const [member, claims] of Map.groupBy(bindings, ({ member }) => positionKey(member))) {
    const members = at.get(member) ?? [];
    if (members.length !== 1) continue;
    const declaration = members[0]!;
    declaration.bindingEvidence = claims.map(({ evidence }) => ({ path: evidence.file, line: evidence.line, via: evidence.framework }));
    if (claims.some(({ deferredFactory }) => deferredFactory)) declaration.deferredFactory = true;
    const holders = claims.map(({ holder }) => holder.path === file ? declarations.filter((node) => node.id !== declaration.id && node.name === holder.symbol && (holder.line === undefined || node.startLine <= holder.line && holder.line <= node.endLine)) : []);
    const ids = new Set(holders.flatMap((group) => group.map(({ id }) => id)));
    if (holders.some((group) => group.length !== 1) || ids.size !== 1) {
      unplaced.add(declaration.id);
      declaration.bindingConflict = true;
      continue;
    }
    const parent = holders[0]![0]!;
    if (!containsPosition(declarationSpan(parent), { line: declaration.startLine, column: declaration.startColumn })) {
      unplaced.add(declaration.id);
      declaration.bindingConflict = true;
      continue;
    }
    unplaced.delete(declaration.id);
    for (let index = pairs.length - 1; index >= 0; index--) if (pairs[index]!.target === declaration.id) pairs.splice(index, 1);
    pairs.push({ source: parent.id, target: declaration.id });
  }
  const sort = (branches: readonly DeclarationBranch<ModelDeclaration>[]): DeclarationBranch<ModelDeclaration>[] => branches.toSorted((a, b) => positioned(a.declaration, b.declaration)).map((branch) => ({ ...branch, children: sort(branch.children) }));
  const tree = sort(declarationTree(declarations, pairs));
  for (const branch of branchesOf(tree)) if (![...branch.ancestors, branch.declaration].some(({ id }) => unplaced.has(id))) branch.declaration.path = declarationPath(branch);
  return { tree, list: declarations.sort(positioned) };
}
