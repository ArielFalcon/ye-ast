import { readFileSync } from "node:fs";
import { dirname, posix, resolve, sep } from "node:path";
import ts from "typescript";
import type { ReferenceSite, ResolvedTarget } from "../../domain/relations/resolved-reference.ts";
import { nameTail } from "../../domain/impact/impact-cuts.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { TypeResolution } from "../../ports/type-resolution.port.ts";

/** A source the snapshot holds, repository-relative and without a leading slash. */
export interface SnapshotSource {
  path: string;
  text: string;
}

export interface TypeResolutionRequest {
  sources: readonly SnapshotSource[];
  /** The directory holding the dependencies' declarations, laid out like a `node_modules` tree. */
  typeRoot: string;
  /** The configuration that decides module resolution; the caller derives it from the snapshot's own configuration. */
  options?: ts.CompilerOptions;
}

/** The process boundary: the two directories a Program may read from, and the lib file this `typescript` build asks for. */
export interface TypeResolutionDeps {
  readModule(relative: string): string | undefined;
  readLib(name: string): string | undefined;
  defaultLib(): string;
}

const SNAPSHOT = "/snapshot";
const MODULES = `${SNAPSHOT}/node_modules`;
const LIB = "/typescript/lib";
const MAX_ASCENT = 12;

export function defaultTypeResolutionDeps(typeRoot: string): TypeResolutionDeps {
  const read = (root: string, relative: string): string | undefined => {
    const base = resolve(root);
    const target = resolve(base, relative);
    if (target !== base && !target.startsWith(`${base}${sep}`)) return undefined;
    try {
      return readFileSync(target, "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    readModule: (relative) => read(typeRoot, relative),
    readLib: (name) => read(dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 })), name),
    defaultLib: () => posix.basename(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 })),
  };
}

export function createTypeResolution(
  request: TypeResolutionRequest,
  deps: TypeResolutionDeps = defaultTypeResolutionDeps(request.typeRoot),
): TypeResolution {
  const options = compilerOptions(request.options);
  const sources = new Map(request.sources.map((source) => [source.path, source.text]));
  const read = reader(sources, deps);
  const host = compilerHost(read, deps, options);
  const program = ts.createProgram({ rootNames: [...sources.keys()].map((path) => `${SNAPSHOT}/${path}`), options, host });
  const checker = program.getTypeChecker();

  return {
    resolve(sites) {
      return sites.map((site) => resolveSite(checker, program, site));
    },
  };
}

/**
 * A repository's `types` list names packages to include by name, so it is emptied: only what a source imports is read,
 * and a snapshot cannot make the compiler open a package nobody names. `createProgram` never loads `tsconfig` `plugins`
 * either; that vector exists only in a language server.
 */
function compilerOptions(given: ts.CompilerOptions | undefined): ts.CompilerOptions {
  return {
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...given,
    types: [],
  };
}

function reader(sources: ReadonlyMap<string, string>, deps: TypeResolutionDeps) {
  return (file: string): string | undefined => {
    const absolute = posix.normalize(file.startsWith("/") ? file : `/${file}`);
    if (absolute.startsWith(`${MODULES}/`)) return deps.readModule(absolute.slice(MODULES.length + 1));
    if (absolute.startsWith(`${LIB}/`)) return deps.readLib(absolute.slice(LIB.length + 1));
    if (absolute.startsWith(`${SNAPSHOT}/`)) return sources.get(absolute.slice(SNAPSHOT.length + 1));
    return undefined;
  };
}

function compilerHost(
  read: (file: string) => string | undefined,
  deps: TypeResolutionDeps,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  return {
    fileExists: (file) => read(file) !== undefined,
    readFile: (file) => read(file),
    directoryExists: () => true,
    getDirectories: () => [],
    getCurrentDirectory: () => SNAPSHOT,
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    writeFile: () => {},
    getDefaultLibFileName: () => `${LIB}/${deps.defaultLib()}`,
    getSourceFile: (file, languageVersion) => {
      const text = read(file);
      return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
    },
  };
}

function resolveSite(checker: ts.TypeChecker, program: ts.Program, site: ReferenceSite): Finding<ResolvedTarget> {
  const evidence: Evidence[] = [{ path: site.file, line: site.line }];
  const source = program.getSourceFile(`${SNAPSHOT}/${site.file}`);
  if (source === undefined) return unknown("source-unreadable", evidence);
  const position = positionOf(source, site);
  if (position === undefined) return unknown("source-unreadable", evidence);
  const named = nameNodeAt(source, position);
  /**
   * The index does not promise that `column` lands on the name of the reference. When it lands elsewhere, answering about
   * that other name would be worse than not answering: it hides a dependence with the confidence of a resolved one.
   */
  if (named === undefined || (site.symbol !== undefined && named.getText(source) !== nameTail(site.symbol))) return unknown("unresolved", evidence);
  const symbol = checker.getSymbolAtLocation(named);
  if (symbol === undefined) return unknown("unresolved", evidence);
  const declaration = declarationOf(checker, symbol);
  if (declaration === undefined) return unknown("unresolved", evidence);
  return { status: "complete", value: targetOf(declaration, symbol), evidence };
}

function positionOf(source: ts.SourceFile, site: ReferenceSite): number | undefined {
  const line = site.line - 1;
  const column = site.column - 1;
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0) return undefined;
  const starts = source.getLineStarts();
  if (line >= starts.length) return undefined;
  const start = starts[line];
  if (start === undefined) return undefined;
  const position = start + column;
  return position <= source.getFullStart() + source.getFullWidth() ? position : undefined;
}

/** The deepest node whose span holds `position`, then the name a symbol can be read from. */
function nameNodeAt(source: ts.SourceFile, position: number): ts.Node | undefined {
  let node: ts.Node = source;
  for (;;) {
    const next = childAt(node, position);
    if (next === undefined) break;
    node = next;
  }
  for (let depth = 0; depth < MAX_ASCENT; depth += 1) {
    if (ts.isIdentifier(node)) return node;
    if (ts.isPropertyAccessExpression(node) && holds(node.name, position)) return node.name;
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && holds(node, position)) return calleeName(node.expression);
    if (node.parent === undefined) return undefined;
    node = node.parent;
  }
  return undefined;
}

function calleeName(expression: ts.Expression): ts.Node | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression)) return expression.name;
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression)) {
    return calleeName(expression.expression);
  }
  return ts.isCallExpression(expression) ? calleeName(expression.expression) : undefined;
}

function childAt(node: ts.Node, position: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  node.forEachChild((child) => {
    if (found === undefined && holds(child, position)) found = child;
  });
  return found;
}

function holds(node: ts.Node, position: number): boolean {
  return node.pos <= position && position < node.end;
}

function declarationOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Declaration | undefined {
  let resolved = symbol;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      resolved = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  return resolved.getDeclarations()?.[0];
}

function targetOf(declaration: ts.Declaration, symbol: ts.Symbol): ResolvedTarget {
  const file = declaration.getSourceFile();
  const name = ts.getNameOfDeclaration(declaration)?.getText(file) ?? symbol.getName();
  const { line } = file.getLineAndCharacterOfPosition(declaration.getStart(file));
  const { line: endLine } = file.getLineAndCharacterOfPosition(declaration.getEnd());
  const path = file.fileName;
  if (path.startsWith(`${MODULES}/`)) return { kind: "external", module: moduleOf(path) };
  if (path.startsWith(`${SNAPSHOT}/`)) {
    return { kind: "repository", file: path.slice(SNAPSHOT.length + 1), symbol: name, line: line + 1, endLine: endLine + 1 };
  }
  return { kind: "external", module: moduleOf(path) };
}

function moduleOf(path: string): string {
  if (path.startsWith(`${MODULES}/`)) {
    const parts = path.slice(MODULES.length + 1).split("/");
    return path.startsWith(`${MODULES}/@`) ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  }
  return path.startsWith(`${LIB}/`) ? "global" : "";
}

function unknown(reason: "source-unreadable" | "unresolved", evidence: readonly Evidence[]): Finding<ResolvedTarget> {
  return { status: "unknown", reason, evidence };
}
