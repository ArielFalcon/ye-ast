import ts from "typescript";
import { matchesReferenceKind, syntaxName } from "./reference-occurrence.ts";
import { declarationCounts, declaredName, declaredNames, scriptGlobalNames } from "./syntax-names.ts";
import { moduleStatement } from "./import-bindings.ts";
import { sourceTree } from "./source-tree.ts";
import { isPackageManifest, isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOriginSite, ImportOrigins, ResolvedNameSite } from "../../ports/import-origins.port.ts";
import { createModuleResolver, manifestPackages, packageOf } from "./module-resolver.ts";
import { TYPESCRIPT_LIB_GLOBALS } from "./typescript-lib-globals.ts";

/** The names the pinned `typescript` declares, held once for the process rather than rebuilt per query. */
const LIB_GLOBALS = new Set(TYPESCRIPT_LIB_GLOBALS);

/** What one file's imports bind, and the names the file declares for itself. */
interface FileShape {
  bindings: ReadonlyMap<string, string>;
  declared: ReadonlySet<string>;
}

/**
 * Reads, per file, the name each import binds to the specifier it came from, and resolves that specifier through the
 * snapshot's own module configuration (`module-resolver.ts`): a relative or aliased specifier names a file of the
 * repository, a package the manifest declares is outside it.
 *
 * Nothing is built and no dependency is opened: the import clause is syntax, and the resolver reads the configuration
 * files the snapshot already holds. A file that declares a name it also imports is `unknown` for that name, because the
 * declaration may shadow the import at the place the reference sits.
 */
export function createImportOrigins(sources: readonly SourceFile[]): ImportOrigins {
  const texts = new Map(sources.map((file) => [file.path, file.content]));
  const files = new Map(sources.map((file) => [file.path, file]));
  const modules = createModuleResolver(async (file) => texts.get(file), manifestPackages(sources.filter((file) => isPackageManifest(file.path)).map((file) => file.content)));
  const shapes = new Map<string, FileShape>();

  /**
   * A file is read when a site asks about it; its imports and declarations are held as a shape.
   */
  const shapeOf = (file: string): FileShape => {
    let held = shapes.get(file);
    if (held === undefined) {
      const text = texts.get(file);
      held = text === undefined || !isTypeScriptSource(file) ? { bindings: new Map<string, string>(), declared: new Set<string>() } : describe(files.get(file)!);
      shapes.set(file, held);
    }
    return held;
  };

  /**
   * The names the snapshot declares globally: a `.d.ts` anywhere, a file that augments the global scope, and the top
   * level of a script (a source with no import or export, whose declarations are global). A repository may spell a lib
   * name itself, and retiring that name would hide a real declaration, so those names stay `unknown`.
   */
  let globals: ReadonlySet<string> | undefined;
  const repositoryGlobals = (): ReadonlySet<string> => {
    if (globals !== undefined) return globals;
    const names = new Set<string>();
    for (const [path, text] of texts) {
      const augments = path.endsWith(".d.ts") || text.includes("declare global");
      if (!augments && !isTypeScriptSource(path)) continue;
      const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
      const declared = augments ? declaredNames(tree) : ts.isExternalModule(tree) ? [] : scriptGlobalNames(tree);
      for (const name of declared) names.add(name);
    }
    globals = names;
    return names;
  };

  const originOf = async (site: ImportOriginSite, syntax: SiteSyntax | "unknown"): Promise<Finding<ImportOrigin>> => {
    const evidence: Evidence[] = [{ path: site.file, line: site.line }];
    if (syntax === "unknown") return { status: "unknown", reason: "unresolved", evidence };
    if (syntax === "local") return { status: "complete", value: { kind: "local-parameter", name: site.name }, evidence };
    if (syntax === "this-member") return { status: "complete", value: { kind: "this-member", name: site.name }, evidence };
    const { bindings, declared: names } = shapeOf(site.file);
    /** A declaration of the file may shadow an import or a global at the place the reference sits, so it wins. */
    if (names.has(site.name)) return { status: "unknown", reason: "unresolved", evidence };
    const specifier = bindings.get(site.name);
    if (specifier === undefined) {
      /** Nothing binds the name here: it is in scope only if the language's own libraries declare it. */
      if (LIB_GLOBALS.has(site.name) && !repositoryGlobals().has(site.name)) return { status: "complete", value: { kind: "ambient", name: site.name }, evidence };
      return { status: "unknown", reason: "unresolved", evidence };
    }
    const resolved = await modules.resolve(site.file, specifier);
    if ("file" in resolved) return { status: "complete", value: { kind: "repository", file: resolved.file }, evidence };
    const module = packageOf(specifier);
    if ("external" in resolved && module !== undefined) return { status: "complete", value: { kind: "external", module }, evidence };
    return { status: "unknown", reason: "unresolved", evidence };
  };

  return { origins: async (sites, signal) => {
    const results: (Finding<ImportOrigin> & { occurrence?: true })[] = sites.map((site) => ({ status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] }));
    const grouped = Map.groupBy(sites.map((site, index) => ({ site, index })), ({ site }) => site.file);
    for (const [file, group] of grouped) {
      if (signal?.aborted) break;
      const text = texts.get(file);
      const checked = text === undefined || !isTypeScriptSource(file) ? undefined : checkSites(file, text, group);
      if (checked !== undefined) shapes.set(file, checked.shape);
      const checks = checked?.matches ?? new Map<number, SiteSyntax>();
      for (const { site, index } of group) {
        const syntax = checks.get(index) ?? "unknown";
        const finding = await originOf(site, syntax);
        results[index] = syntax === "unknown" ? finding : { ...finding, occurrence: true };
      }
    }
    return results;
  }, rootOrigins: async (sites, signal) => {
    const results: Finding<ImportOrigin>[] = sites.map((site) => ({ status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] }));
    for (const [file, group] of Map.groupBy(sites.map((site, index) => ({ site, index })), ({ site }) => site.file)) {
      if (signal?.aborted) break;
      const text = texts.get(file);
      const read = text === undefined || !isTypeScriptSource(file) ? undefined : rootsAt(file, text, group);
      if (read === undefined) continue;
      shapes.set(file, read.shape);
      for (const [index, root] of read.roots) results[index] = await originOf({ ...sites[index]!, name: root }, "valid");
    }
    return results;
  } };
}

type SiteSyntax = "valid" | "local" | "this-member";

/** The root of the plain chain of names each site spells and ends in its name, read in one temporary tree. */
function rootsAt(file: string, text: string, group: readonly { site: ResolvedNameSite; index: number }[]): { roots: Map<number, string>; shape: FileShape } | undefined {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return undefined;
  const starts = source.getLineStarts();
  const wanted = new Map<number, { site: ResolvedNameSite; index: number }[]>();
  for (const item of group) {
    const { line, column } = item.site;
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1 || line > starts.length) continue;
    const point = starts[line - 1]! + column - 1;
    if (point >= (line < starts.length ? starts[line]! : text.length)) continue;
    wanted.set(point, [...(wanted.get(point) ?? []), item]);
  }
  /** Chains that start at one point share their root, so the first that ends in the name settles it. */
  const roots = new Map<number, string>();
  const visit = (node: ts.Node): void => {
    for (const { site, index } of wanted.get(node.getStart(source)) ?? []) {
      const spelled = spelledAt(node, site.kind);
      const names = spelled === undefined ? undefined : plainChain(spelled);
      if (names !== undefined && names.at(-1) === site.name && !roots.has(index)) roots.set(index, names[0]!);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return { roots, shape: describeTree(source) };
}

/** What a node starting at an edge's column spells for the edge's kind: a call's callee, an instantiation's class, or a name up to the whole qualified name it ends. */
function spelledAt(node: ts.Node, kind: string): ts.Node | undefined {
  if (kind === "calls") return ts.isCallExpression(node) ? node.expression : undefined;
  if (kind === "instantiates") return ts.isNewExpression(node) ? node.expression : undefined;
  if (!ts.isIdentifier(node)) return undefined;
  let spelled: ts.Node = node;
  while ((ts.isQualifiedName(spelled.parent) && spelled.parent.right === spelled) || (ts.isPropertyAccessExpression(spelled.parent) && spelled.parent.name === spelled)) spelled = spelled.parent;
  return spelled;
}

/** The names of `a.b.c` from its root, or none when any link is not a plain name. */
function plainChain(node: ts.Node): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isQualifiedName(node)) return plainChain(node.left)?.concat(node.right.text);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return plainChain(node.expression)?.concat(node.name.text);
  return undefined;
}

/** Check each graph spelling at its exact 1-based UTF-16 position in one temporary tree. */
function checkSites(file: string, text: string, group: readonly { site: ImportOriginSite; index: number }[]): { matches: Map<number, SiteSyntax>; shape: FileShape } {
  const result = new Map<number, SiteSyntax>();
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return { matches: result, shape: { bindings: new Map(), declared: new Set() } };
  const shape = describeTree(source);
  const starts = source.getLineStarts();
  const wanted = new Map<number, { site: ImportOriginSite; index: number }[]>();
  for (const item of group) {
    const { site } = item;
    if (!Number.isInteger(site.line) || site.line < 1 || !Number.isInteger(site.column) || site.column! < 1 || site.line > starts.length || !site.fullName || !site.kind) continue;
    const start = starts[site.line - 1]!;
    const point = start + site.column! - 1;
    const end = site.line < starts.length ? starts[site.line]! : text.length;
    if (point >= end || point >= text.length) continue;
    const list = wanted.get(point) ?? [];
    list.push(item); wanted.set(point, list);
  }
  const matches = new Map<number, ts.Node[]>();
  const ownCalls = new Map<number, number>();
  const visit = (node: ts.Node): void => {
    const candidates = wanted.get(node.getStart(source));
    if (candidates !== undefined) for (const { site, index } of candidates) {
      const expr = site.kind === "calls" && ts.isCallExpression(node) ? node.expression : site.kind === "instantiates" && ts.isNewExpression(node) ? node.expression : undefined;
      if (expr !== undefined && syntaxName(expr, source) === site.fullName) {
        const found = matches.get(index) ?? []; found.push(expr); matches.set(index, found);
      } else if (matchesReferenceKind(node, site.kind) && syntaxName(node, source) === site.fullName) {
        const found = matches.get(index) ?? []; found.push(node); matches.set(index, found);
      } else if (site.kind === "calls" && ts.isCallExpression(node) && callsOwnMember(node.expression, site.fullName!)) {
        ownCalls.set(index, (ownCalls.get(index) ?? 0) + 1);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  const scopes = new WeakMap<ts.Node, { unsafe: boolean; names: ReadonlySet<string> }>();
  for (const { site, index } of group) {
    const found = matches.get(index);
    if (found === undefined && ownCalls.get(index) === 1) result.set(index, "this-member");
    if (found?.length !== 1) continue;
    const node = found[0]!;
    result.set(index, site.kind === "calls" && ts.isIdentifier(node) && node.text === site.name && localParameter(node, site.name, scopes) ? "local" : "valid");
  }
  return { matches: result, shape };
}

/**
 * `this.name` whose `this` is an instance of the class holding the instance member around it: only an arrow function
 * keeps it. A class declared inside a function or another class is refused, since the graph places its code by lines.
 */
function callsOwnMember(callee: ts.Expression, name: string): boolean {
  if (!ts.isPropertyAccessExpression(callee) || callee.expression.kind !== ts.SyntaxKind.ThisKeyword || callee.name.text !== name) return false;
  for (let node: ts.Node = callee.parent; !ts.isSourceFile(node); node = node.parent) {
    if (ts.isArrowFunction(node)) continue;
    if (ts.isClassStaticBlockDeclaration(node)) return false;
    if (ts.isFunctionLike(node) || ts.isPropertyDeclaration(node)) return ts.isClassLike(node.parent) && !isStatic(node) && !isNested(node.parent);
  }
  return false;
}

function isStatic(member: ts.Node): boolean {
  return ts.canHaveModifiers(member) && (ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false);
}

function isNested(declaration: ts.ClassLikeDeclaration): boolean {
  for (let node = declaration.parent; !ts.isSourceFile(node); node = node.parent) if (ts.isFunctionLike(node) || ts.isClassLike(node)) return true;
  return false;
}

/** Prove only the nearest supported function-expression parameter; all uncertain scopes are refused. */
function localParameter(callee: ts.Identifier, name: string, scopes: WeakMap<ts.Node, { unsafe: boolean; names: ReadonlySet<string> }>): boolean {
  let node: ts.Node | undefined = callee.parent;
  let owner: ts.ArrowFunction | ts.FunctionExpression | undefined;
  while (node !== undefined) {
    if (ts.isWithStatement(node)) return false;
    if (ts.isFunctionLike(node)) {
      if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
      owner = node; break;
    }
    node = node.parent;
  }
  if (owner === undefined || owner.body === undefined || callee.pos < owner.body.pos) return false;
  if (owner.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken !== undefined || parameter.initializer !== undefined)) return false;
  if (owner.parameters.filter((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name).length !== 1) return false;
  let summary = scopes.get(owner);
  if (summary === undefined) {
    let unsafe = false;
    const names = new Set<string>();
    const visit = (current: ts.Node): void => {
      if (ts.isWithStatement(current) || (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "eval")) unsafe = true;
      const declared = declaredName(current);
      if (declared !== undefined) names.add(declared);
      if (ts.isFunctionLike(current) || ts.isClassLike(current) || ts.isModuleDeclaration(current)) return;
      current.forEachChild(visit);
    };
    visit(owner.body);
    summary = { unsafe, names };
    scopes.set(owner, summary);
  }
  return !summary.unsafe && !summary.names.has(name);
}

/** What one file imports and what it binds. */
function describe(file: SourceFile): FileShape {
  /** No parent pointers: the two walks below descend, and a parent on every node doubles what a tree costs. */
  const tree = sourceTree(file, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return describeTree(tree);
}

/**
 * The local names the file's imports bind, read by the one module-statement reader. A name an `import x = require`
 * binds is a declaration only when the file declares it again.
 */
function describeTree(tree: ts.SourceFile): FileShape {
  const bindings = new Map<string, string>();
  const declared = declarationCounts(tree);
  for (const statement of tree.statements) {
    const read = moduleStatement(statement, tree);
    if (read?.kind !== "import" || read.specifier === undefined) continue;
    for (const { local } of read.bindings) {
      bindings.set(local!, read.specifier);
      if (read.form === "import-equals") declared.set(local!, declared.get(local!)! - 1);
    }
  }
  return { bindings, declared: new Set([...declared].filter(([, count]) => count > 0).map(([name]) => name)) };
}
