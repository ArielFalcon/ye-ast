import type { Token, SourceReading } from "../../domain/change/source-tokens.ts";
import type { ModuleDependencies, ModuleDependency } from "../../domain/impact/module-dependency.ts";
import { topLevelOf, isSeedable } from "../../domain/change/seeds.ts";
import { FOLLOWED_EDGE_KINDS, followsEdge, isFileDependent } from "../../domain/impact/edge-policy.ts";
import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import { DECLARING_KEYWORDS, readsWrittenUses } from "../../domain/impact/written-uses.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames } from "../../ports/declared-member-names.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins, RootBinding, UseSite } from "../../ports/import-origins.port.ts";

/**
 * A place a source writes a name bound to `node`, held by `from`: the declaration the edge policy lets depend on `node`
 * through it, or the node of the file for a statement outside every declaration (ADR-0082).
 */
export interface HeldUse {
  node: GraphSymbol;
  from: GraphSymbol;
  file: string;
  line: number;
  name: string;
}

/**
 * What the sources write of reached declarations the index records no edge for. `held`: the uses a declaration or a
 * file's top-level statements write. `read`: by node, the files where every place that writes the name it is bound to is
 * settled: a held use, an export statement, or a binding of another declaration. A file with a use inside a declaration
 * the edge policy does not admit, or a place whose binding is unknown, is not read and keeps the index's importer fallback.
 * `unsettled`: the places a namespace that may hold a node is written where the sources do not settle which declaration
 * the place reads (`ns[key]`, `use(ns)`, `export { ns }`); no importer fallback stands for them.
 */
export interface WrittenUseReading {
  read: ReadonlyMap<GraphNodeId, ReadonlySet<string>>;
  held: readonly HeldUse[];
  unsettled: readonly Omit<HeldUse, "from">[];
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
  /**
   * The module statements of every source and the sources whose statements are not read, read when a node is first asked
   * about; without them no namespace use is read.
   */
  modules?: (() => Promise<Pick<ModuleDependencies, "dependencies" | "unread">>) | undefined;
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
  /** The local is a namespace of a module that may export the node: only the binding of the whole chain settles the place. */
  namespace: boolean;
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
export function createWrittenUses({ store, sources, tokensOf, syntaxOf, origins, importedDeclarations, modules }: WrittenUsesDeps): WrittenUses {
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

  let statements: Promise<{ reexports: ReadonlyMap<string, readonly ModuleDependency[]>; imports: ReadonlyMap<string, readonly ModuleDependency[]>; unreadReaching: (module: string) => readonly string[] }> | undefined;
  const statementsByTarget = (read: NonNullable<WrittenUsesDeps["modules"]>) =>
    (statements ??= read().then(({ dependencies, unread }) => {
      const into = dependencies.filter((dependency) => dependency.target.kind === "repository");
      const byTarget = (kind: ModuleDependency["kind"]) => Map.groupBy(into.filter((dependency) => dependency.kind === kind), (dependency) => (dependency.target as { file: string }).file);
      const links = unread.filter(({ file, reason }) => reason === "source-unreadable" && readsWrittenUses(file)).map(({ file, reaches }) => ({ file, reaches: reaches === undefined ? undefined : new Set(reaches) }));
      return { reexports: byTarget("reexport"), imports: byTarget("import"), unreadReaching: (module: string) => links.filter(({ reaches }) => reaches === undefined || reaches.has(module)).map(({ file }) => file) };
    }));

  /**
   * The files that may read `node` through a namespace, each with the local names binding one there and the members such a
   * local may name `node` by. The modules whose namespace may hold it are its file and, by syntax alone, every module that
   * re-exports it from one of them (`export *`, `export { … } from` of a name it has there) or writes an export statement
   * of a name it imports from one; a namespace import of such a module binds one, as does an import of a name such a
   * module exports a namespace under (`export * as ns from`), whose members are not bounded. A source whose module
   * statements are not read joins the chain under any name when a string it writes leads to a module of it (ADR-0085), and
   * every name a file imports from it, or from a module the chain reaches through it, binds one the join does not settle.
   */
  async function namespacesOf(node: GraphSymbol): Promise<{ files: Map<string, Map<string, Names>>; throughUnread: Map<string, "namespace" | "name"> }> {
    const files = new Map<string, Map<string, Names>>();
    const throughUnread = new Map<string, "namespace" | "name">();
    if (modules === undefined || !topLevelOf(declarationsIn(node.file).filter(isSeedable)).some(({ id }) => id === node.id)) return { files, throughUnread };
    const { reexports, imports, unreadReaching } = await statementsByTarget(modules);
    const names = new Map<string, Names>([[node.file, await exposedNames(node.file, new Set([node.name]), true)]]);
    const exported = new Map<string, Set<string>>();
    const unsettledThrough = new Set<string>();
    const pending = [node.file];
    const grow = (module: string, more: Names, unread: boolean): void => {
      const held = names.get(module);
      const covered = held === UNBOUNDED || (more !== UNBOUNDED && held !== undefined && [...more].every((name) => held.has(name)));
      if (covered && (!unread || unsettledThrough.has(module))) return;
      if (unread) unsettledThrough.add(module);
      if (!covered) names.set(module, more === UNBOUNDED ? UNBOUNDED : new Set([...(held ?? []), ...more]));
      pending.push(module);
    };
    const named = (held: Names, name: string): boolean => held === UNBOUNDED || held.has(name);
    for (let module = pending.pop(); module !== undefined; module = pending.pop()) {
      const held = names.get(module)!;
      const unread = unsettledThrough.has(module);
      for (const source of unreadReaching(module)) grow(source, UNBOUNDED, true);
      for (const dependency of reexports.get(module) ?? []) {
        for (const { local, imported } of dependency.bindings) {
          if (imported === "*" && local !== undefined) exported.set(dependency.file, (exported.get(dependency.file) ?? new Set()).add(local));
          else if (local === undefined) grow(dependency.file, held, unread);
          else if (named(held, imported)) grow(dependency.file, new Set([local]), unread);
        }
      }
      for (const dependency of imports.get(module) ?? []) {
        const locals = new Set(dependency.bindings.flatMap(({ local, imported }) => (imported === "*" || local === undefined || !named(held, imported) ? [] : [local])));
        if (locals.size === 0) continue;
        const exposed = await exposedNames(dependency.file, locals, false);
        if (exposed === UNBOUNDED || exposed.size > 0) grow(dependency.file, exposed, unread);
      }
    }
    for (const module of new Set([...names.keys(), ...exported.keys()])) {
      for (const dependency of imports.get(module) ?? []) {
        for (const { local, imported } of dependency.bindings) {
          if (local === undefined) continue;
          const members = imported === "*" ? names.get(module)
            : exported.get(module)?.has(imported) === true || (unsettledThrough.has(module) && named(names.get(module)!, imported)) ? UNBOUNDED : undefined;
          if (members === undefined) continue;
          files.set(dependency.file, (files.get(dependency.file) ?? new Map()).set(local, members));
          if (unsettledThrough.has(module)) throughUnread.set(placeKey(dependency.file, local), imported === "*" ? "namespace" : "name");
        }
      }
    }
    return { files, throughUnread };
  }

  /**
   * The names `file` exports `locals` under through its own export statements (`export { a as b }`, `export default a`),
   * with the locals themselves for the declaring file (`own`), whose declaration of one may be its default export; not
   * bounded when the file's tokens are not read.
   */
  async function exposedNames(file: string, locals: ReadonlySet<string>, own: boolean): Promise<Names> {
    const source = byPath.get(file);
    const tokens = source === undefined ? undefined : await reading(source);
    if (tokens?.status !== "read") return UNBOUNDED;
    const code = tokens.tokens.filter(({ text }) => text !== "\n");
    const exposed = new Set(own ? locals : []);
    for (const [index, token] of code.entries()) {
      if (!locals.has(token.text)) continue;
      if (own && declaresDefault(code, index)) exposed.add("default");
      if (!reexposes(code, index)) continue;
      const alias = code[index + 1]?.text === "as" ? code[index + 2]?.text : undefined;
      if (alias !== undefined && !IDENTIFIER.test(alias)) return UNBOUNDED;
      exposed.add(alias ?? (code[index - 1]?.text === "default" ? "default" : token.text));
    }
    return exposed;
  }

  /**
   * The lines of `file` where the index already records a dependence on `node` from a declaration that may hold a use of
   * it: a use it placed itself. One it records only at a declaration that may not (a property, for its type) leaves the
   * place to the declaration around it that may: the type that declares the property.
   */
  function indexedLines(node: GraphSymbol, file: string): ReadonlySet<number> {
    const edges = store.incomingEdges([node.id], FOLLOWED_EDGE_KINDS).filter((edge) => edge.line !== null);
    const sources = new Map(store.symbolsByIds([...new Set(edges.map((edge) => edge.source))]).map((symbol) => [symbol.id, symbol]));
    return new Set(edges.flatMap((edge) => {
      const source = sources.get(edge.source);
      return source !== undefined && source.file === file && admitted(source, node) ? [edge.line!] : [];
    }));
  }

  /** `followed`: the locals whose re-export statements the chain of modules already follows, so they are no place of a read. */
  function sitesIn(node: GraphSymbol, file: string, content: string, tokens: readonly Token[], imports: readonly { start: number; end: number }[], locals: ReadonlyMap<string, Names | undefined>, own: boolean, namespace: boolean, followed: ReadonlySet<string> = new Set()): Site[] {
    const sites: Site[] = [];
    const indexed = indexedLines(node, file);
    const code = tokens.filter(({ text }) => text !== "\n");
    for (const [index, token] of code.entries()) {
      if (!locals.has(token.text) || !IDENTIFIER.test(token.text)) continue;
      if (imports.some(({ start, end }) => start <= token.startOffset && token.endOffset <= end)) continue;
      const previous = code[index - 1]?.text;
      if ((previous !== undefined && DECLARING_KEYWORDS.has(previous)) || ((!namespace || followed.has(token.text)) && reexposes(code, index))) continue;
      const members = locals.get(token.text);
      if (namespace && (namesProperty(code, index) || (members !== undefined && !namesMember(code, index, members)))) continue;
      const column = token.startOffset - (content.lastIndexOf("\n", token.startOffset - 1) + 1);
      const at = { line: token.start, column };
      if ((own && contains(node, at)) || indexed.has(token.start)) continue;
      const owner = innermost(declarationsIn(file), at);
      sites.push({ node, file, local: token.text, own, namespace, line: token.start, column, ...(owner === undefined ? {} : { owner }) });
    }
    return sites;
  }

  /**
   * What a place that writes a namespace reads: `node`, where the chain names the declaration its module exports under
   * the node's name, followed through re-exports; nothing of it, where another declaration of the file binds the root or
   * the chain names another declaration; and an unsettled place otherwise.
   */
  function namespaceRead(site: Site, binding: RootBinding | undefined): "node" | "other" | "unsettled" {
    if (binding === undefined || !("root" in binding)) return "unsettled";
    if (binding.root !== site.local || binding.kind === "declared" || binding.kind === "local") return "other";
    if (binding.kind !== "located") return "unsettled";
    return binding.file === site.node.file && binding.path === site.node.name ? "node" : "other";
  }

  function binds(site: Site, binding: RootBinding | undefined): boolean {
    if (binding === undefined || ("root" in binding && binding.root !== site.local)) return false;
    if (site.own) return (binding.kind === "declared" || binding.kind === "local") && binding.lines.some((line) => site.node.startLine <= line && line <= site.node.endLine);
    return binding.kind === "import" && binding.origin.kind === "repository";
  }

  /**
   * What holds a place and may depend on `node` through it: the innermost declaration the policy admits, the class a
   * decorator there belongs to, or, where the syntax places it outside every declaration, the file's node.
   */
  async function holderOf(site: Site): Promise<GraphSymbol | undefined> {
    const at = { line: site.line, column: site.column };
    const admits = (from: GraphSymbol): boolean => admitted(from, site.node);
    const around = declarationsIn(site.file).filter((symbol) => contains(symbol, at)).sort(bySpan);
    if (around.length > 0 || syntaxOf === undefined) return around.find(admits);
    const written = (await syntaxOf(site.file)).declarations.filter(({ kind, span }) => kind === "class" && before(span.start, { line: site.line, column: site.column + 1 }) && before({ line: site.line, column: site.column + 1 }, span.end));
    if (written.length === 0) return fileNodeOf(site.file);
    const classes = written.flatMap(({ name, span }) => declarationsIn(site.file).filter((symbol) => symbol.name === name && span.start.line <= symbol.startLine && symbol.endLine <= span.end.line && admits(symbol)));
    return classes.length === 1 ? classes[0] : undefined;
  }

  function fileNodeOf(file: string): GraphSymbol | undefined {
    const nodes = store.symbolsInFiles([file]).filter(({ kind }) => isFileDependent(kind));
    return nodes.length === 1 ? nodes[0] : undefined;
  }

  return {
    async into(nodes, signal) {
      const read = new Map<GraphNodeId, Set<string>>();
      const sites: Site[] = [];
      const throughUnread: Site[] = [];
      const unsettled: Omit<HeldUse, "from">[] = [];
      for (const node of new Map(nodes.map((node) => [node.id, node])).values()) {
        if (!readsWrittenUses(node.file)) continue;
        for (const [file, { locals, own }] of await filesOf(node)) {
          const source = byPath.get(file);
          if (source === undefined) continue;
          const tokens = await reading(source);
          if (tokens.status !== "read") {
            if (tokens.reason === "unparsed") unsettled.push({ node, file, line: 1, name: [...locals].sort().join(",") });
            continue;
          }
          sites.push(...sitesIn(node, file, source.content, tokens.tokens, tokens.imports, new Map([...locals].map((local) => [local, undefined])), own, false));
          read.set(node.id, (read.get(node.id) ?? new Set()).add(file));
        }
        const namespaces = await namespacesOf(node);
        for (const [file, locals] of namespaces.files) {
          const source = byPath.get(file);
          if (source === undefined) continue;
          const tokens = await reading(source);
          if (tokens.status === "read") {
            const followed = new Set([...locals.keys()].filter((local) => namespaces.throughUnread.get(placeKey(file, local)) === "name"));
            for (const site of sitesIn(node, file, source.content, tokens.tokens, tokens.imports, locals, false, true, followed)) {
              (namespaces.throughUnread.has(placeKey(file, site.local)) ? throughUnread : sites).push(site);
            }
          } else unsettled.push({ node, file, line: 1, name: [...locals.keys()].sort().join(",") });
        }
      }
      const firstThroughUnread = sites.length;
      sites.push(...throughUnread);
      const bindings = sites.length === 0 ? [] : await origins.rootBindings(sites.map(({ file, line, column, local, owner }): UseSite => ({ file, line, column: column + 1, spelled: local, owner: owner === undefined ? FILE_LEVEL : { name: owner.name, line: owner.startLine, endLine: owner.endLine } })), signal);
      const held: HeldUse[] = [];
      const unsettledThroughUnread: Omit<HeldUse, "from">[] = [];
      for (const [index, site] of sites.entries()) {
        const binding = bindings[index];
        if (site.namespace) {
          const verdict = namespaceRead(site, binding);
          const from = verdict === "node" ? await holderOf(site) : undefined;
          if (from !== undefined) held.push({ node: site.node, file: site.file, line: site.line, name: site.local, from });
          else if (verdict !== "other") (index < firstThroughUnread ? unsettled : unsettledThroughUnread).push({ node: site.node, file: site.file, line: site.line, name: site.local });
          continue;
        }
        const from = binds(site, binding) ? await holderOf(site) : undefined;
        if (from !== undefined) held.push({ node: site.node, file: site.file, line: site.line, name: site.local, from });
        else if (binding === undefined || binding.kind === "unknown" || binds(site, binding)) read.get(site.node.id)?.delete(site.file);
      }
      const marked = new Set([...held, ...unsettled].map(({ file, line, name }) => placeKey(file, name, line)));
      unsettled.push(...unsettledThroughUnread.filter(({ file, line, name }) => !marked.has(placeKey(file, name, line))));
      return { read, held, unsettled };
    },
  };
}

/** A name a file writes, at one line or, without one, wherever the file writes it. */
function placeKey(file: string, name: string, line?: number): string {
  return JSON.stringify([file, name, line]);
}

/** The names a declaration may have in a module, or `UNBOUNDED` where the statements read do not bound them. */
type Names = ReadonlySet<string> | typeof UNBOUNDED;
const UNBOUNDED = "unbounded";

/** Whether the name at `index` is the key of a property or a label (`{ a: 1 }`, `{ a?: T }`, `a:`), which names no binding. */
function namesProperty(code: readonly Token[], index: number): boolean {
  const before = code[index - 1]?.text;
  const after = code[index + 1]?.text === "?" ? code[index + 2]?.text : code[index + 1]?.text;
  return after === ":" && (before === undefined || before === "{" || before === "," || before === ";");
}

/** Whether the name at `index`, when a plain member follows it (`a.b`), names one of `members`; any other place may. */
function namesMember(code: readonly Token[], index: number, members: Names): boolean {
  const member = code[index + 1]?.text === "." ? code[index + 2]?.text : undefined;
  return members === UNBOUNDED || member === undefined || !IDENTIFIER.test(member) || members.has(member);
}

/** Whether the name at `index` is declared as its file's default export: `export default class a`, `export default async function a`. */
function declaresDefault(code: readonly Token[], index: number): boolean {
  let at = index - 1;
  while (at >= 0 && ["class", "function", "*", "abstract", "async"].includes(code[at]!.text)) at--;
  return at < index - 1 && code[at]?.text === "default" && code[at - 1]?.text === "export";
}

/**
 * Whether the name at `index` is one an export statement only re-exposes: listed in `export { … }` (the form with `from`
 * is an import range), or written alone as `export default X`.
 */
function reexposes(code: readonly Token[], index: number): boolean {
  const token = code[index]!;
  let at = index - 1;
  while (at >= 0 && (IDENTIFIER.test(code[at]!.text) || code[at]!.text === ",") && code[at]!.text !== "export") at--;
  if (code[at]?.text === "{") {
    const opener = code[at - 1]?.text === "type" ? at - 2 : at - 1;
    return code[opener]?.text === "export";
  }
  const next = code[index + 1];
  const alone = next === undefined || next.text === ";" || (next.start > token.end && (IDENTIFIER.test(next.text) || next.text === "@"));
  return alone && code[index - 1]?.text === "default" && code[index - 2]?.text === "export";
}

/** Whether `from` may hold a place that writes `node`: a declaration other than `node` the edge policy lets reference it. */
function admitted(from: GraphSymbol, node: GraphSymbol): boolean {
  return from.id !== node.id && followsEdge({ kind: "references", sourceKind: from.kind, targetKind: node.kind });
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
