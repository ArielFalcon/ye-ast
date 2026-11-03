import ts from "typescript";
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
  const dependencies = new Set(sources.filter((file) => isPackageManifest(file.path)).flatMap((file) => [...manifestDependencies(file.content)]));
  const modules = createModuleResolver(async (file) => texts.get(file), dependencies);
  const shapes = new Map<string, FileShape>();

  /**
   * A file is read when a site asks about it, and its tree is dropped at once: what a file imports and what it declares
   * is all the answer needs. Holding every tree, or every file of a snapshot, would cost the process tens of megabytes
   * for two small maps.
   */
  const shapeOf = (file: string): FileShape => {
    let held = shapes.get(file);
    if (held === undefined) {
      const text = texts.get(file);
      held = text === undefined || !isTypeScriptSource(file) ? { bindings: new Map<string, string>(), declared: new Set<string>() } : describe(file, text);
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

  const originOf = async (site: ImportOriginSite): Promise<Finding<ImportOrigin>> => {
    const evidence: Evidence[] = [{ path: site.file, line: site.line }];
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

  return { origins: (sites) => Promise.all(sites.map(originOf)) };
}

/** What one file imports and what it binds, read from one tree that is dropped when this returns. */
function describe(file: string, text: string): FileShape {
  /** No parent pointers: the two walks below descend, and a parent on every node doubles what a tree costs. */
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
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

/** Every name the file binds in any scope: a variable, a parameter, a function, a class, a type or a destructured key. */
function declaredNames(tree: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    const name = declaredName(node);
    if (name !== undefined) names.add(name);
    node.forEachChild(visit);
  };
  visit(tree);
  return names;
}

function declaredName(node: ts.Node): string | undefined {
  if (
    !ts.isVariableDeclaration(node) &&
    !ts.isParameter(node) &&
    !ts.isBindingElement(node) &&
    !ts.isFunctionDeclaration(node) &&
    !ts.isClassDeclaration(node) &&
    !ts.isInterfaceDeclaration(node) &&
    !ts.isTypeAliasDeclaration(node) &&
    !ts.isEnumDeclaration(node)
  ) {
    return undefined;
  }
  const name = node.name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
}
