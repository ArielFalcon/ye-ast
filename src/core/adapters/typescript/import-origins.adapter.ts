import ts from "typescript";
import { matchesReferenceKind, syntaxName } from "./reference-occurrence.ts";
import { declaredName, declaredNames } from "./syntax-names.ts";
import { sourceTree } from "./source-tree.ts";
import { isPackageManifest, isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOriginSite, ImportOrigins } from "../../ports/import-origins.port.ts";
import { createModuleResolver, manifestDependencies, packageOf } from "./module-resolver.ts";
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
  const dependencies = new Set(sources.filter((file) => isPackageManifest(file.path)).flatMap((file) => [...manifestDependencies(file.content)]));
  const modules = createModuleResolver(async (file) => texts.get(file), dependencies);
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
   * The names the snapshot declares globally: a `.d.ts` anywhere, or a file that augments the global scope. A repository
   * may spell a lib name itself, and retiring that name would hide a real declaration, so those names stay `unknown`.
   */
  let globals: ReadonlySet<string> | undefined;
  const repositoryGlobals = (): ReadonlySet<string> => {
    if (globals !== undefined) return globals;
    const names = new Set<string>();
    for (const [path, text] of texts) {
      if (!path.endsWith(".d.ts") && !text.includes("declare global")) continue;
      for (const name of declaredNames(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false))) names.add(name);
    }
    globals = names;
    return names;
  };

  const originOf = async (site: ImportOriginSite, syntax: "valid" | "local" | "unknown"): Promise<Finding<ImportOrigin>> => {
    const evidence: Evidence[] = [{ path: site.file, line: site.line }];
    if (syntax === "unknown") return { status: "unknown", reason: "unresolved", evidence };
    if (syntax === "local") return { status: "complete", value: { kind: "local-parameter", name: site.name }, evidence };
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
      const checks = checked?.matches ?? new Map<number, "valid" | "local">();
      for (const { site, index } of group) {
        const syntax = checks.get(index) ?? "unknown";
        const finding = await originOf(site, syntax);
        results[index] = syntax === "unknown" ? finding : { ...finding, occurrence: true };
      }
    }
    return results;
  } };
}

/** Check each graph spelling at its exact 1-based UTF-16 position in one temporary tree. */
function checkSites(file: string, text: string, group: readonly { site: ImportOriginSite; index: number }[]): { matches: Map<number, "valid" | "local">; shape: FileShape } {
  const result = new Map<number, "valid" | "local">();
  let tree: ts.SourceFile | undefined;
  const diagnostics = ts.transpileModule(text, { fileName: file, reportDiagnostics: true, compilerOptions: { noResolve: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.Preserve }, transformers: { before: [() => (source) => { tree = source; return source; }] } }).diagnostics ?? [];
  if (tree === undefined || diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return { matches: result, shape: { bindings: new Map(), declared: new Set() } };
  const source = tree;
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
  const visit = (node: ts.Node): void => {
    const candidates = wanted.get(node.getStart(source));
    if (candidates !== undefined) for (const { site, index } of candidates) {
      const expr = site.kind === "calls" && ts.isCallExpression(node) ? node.expression : site.kind === "instantiates" && ts.isNewExpression(node) ? node.expression : undefined;
      if (expr !== undefined && syntaxName(expr, source) === site.fullName) {
        const found = matches.get(index) ?? []; found.push(expr); matches.set(index, found);
      } else if (matchesReferenceKind(node, site.kind) && syntaxName(node, source) === site.fullName) {
        const found = matches.get(index) ?? []; found.push(node); matches.set(index, found);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  const scopes = new WeakMap<ts.Node, { unsafe: boolean; names: ReadonlySet<string> }>();
  for (const { site, index } of group) {
    const found = matches.get(index);
    if (found?.length !== 1) continue;
    const node = found[0]!;
    result.set(index, site.kind === "calls" && ts.isIdentifier(node) && node.text === site.name && localParameter(node, site.name, scopes) ? "local" : "valid");
  }
  return { matches: result, shape };
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

function describeTree(tree: ts.SourceFile): FileShape {
  const bindings = new Map<string, string>();
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) bind(statement.importClause, statement.moduleSpecifier.text, bindings);
  }
  return { bindings, declared: declaredNames(tree) };
}

/** The local name each binding of one import clause takes, and the specifier it came from. */
function bind(clause: ts.ImportClause | undefined, specifier: string, into: Map<string, string>): void {
  if (clause === undefined) return;
  if (clause.name !== undefined) into.set(clause.name.text, specifier);
  const named = clause.namedBindings;
  if (named === undefined) return;
  if (ts.isNamespaceImport(named)) into.set(named.name.text, specifier);
  else for (const element of named.elements) into.set(element.name.text, specifier);
}
