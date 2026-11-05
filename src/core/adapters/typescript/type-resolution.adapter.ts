import { readFileSync } from "node:fs";
import { dirname, posix, resolve, sep } from "node:path";
import ts from "typescript";
import { findReferenceOccurrence } from "./reference-occurrence.ts";
import type { ReferenceSite, ResolvedTarget } from "../../domain/relations/resolved-reference.ts";
import { nameTail } from "../../domain/impact/impact-cuts.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { DecoratorSourceOwner, TypeResolutionFinding, TypeResolution } from "../../ports/type-resolution.port.ts";
import { declaredOptionsOf } from "./module-resolver.ts";

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
  const sources = new Map(request.sources.map((source) => [source.path, source.text]));
  /** The snapshot's own configuration decides how its import specifiers resolve; without one the defaults hold. */
  const options = compilerOptions(request.options ?? declaredOptionsOf(sources, ".", SNAPSHOT));
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
 * either; that vector exists only in a language server. `noEmit` and `composite` are forced last: a resolution reads,
 * it never writes a program or a project reference.
 */
function compilerOptions(given: ts.CompilerOptions | undefined): ts.CompilerOptions {
  return {
    skipLibCheck: true,
    allowJs: true,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...given,
    types: [],
    plugins: [],
    noEmit: true,
    composite: false,
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

function resolveSite(checker: ts.TypeChecker, program: ts.Program, site: ReferenceSite): TypeResolutionFinding {
  const evidence: Evidence[] = [{ path: site.file, line: site.line }];
  const source = program.getSourceFile(`${SNAPSHOT}/${site.file}`);
  if (source === undefined) return unknown("source-unreadable", evidence);
  const position = positionOf(source, site);
  if (position === undefined) return unknown("source-unreadable", evidence);
  const named = site.fullName !== undefined || site.kind !== undefined
    ? findReferenceOccurrence(source, site)
    : nameNodeAt(source, position);
  /**
   * The index does not promise that `column` lands on the name of the reference. When it lands elsewhere, answering about
   * that other name would be worse than not answering: it hides a dependence with the confidence of a resolved one.
   */
  if (named === undefined || (site.symbol !== undefined && named.getText(source) !== nameTail(site.symbol))) return unknown("unresolved", evidence);
  const symbol = checker.getSymbolAtLocation(named);
  if (symbol === undefined) return unknown("unresolved", evidence);
  const declaration = callDeclaration(checker, program, named, symbol);
  if (declaration === undefined) return unknown("unresolved", evidence);
  const sourceOwner = decoratorOwner(named, source);
  return { status: "complete", value: targetOf(declaration, symbol), evidence, ...(sourceOwner === undefined ? {} : { sourceOwner }) };
}

/** Only a syntactic class decorator supplies this witness; ordinary enclosing scopes do not. */
function decoratorOwner(named: ts.Node, source: ts.SourceFile): DecoratorSourceOwner | undefined {
  let ancestor: ts.Node | undefined = named;
  while (ancestor !== undefined && !ts.isDecorator(ancestor)) {
    if (ts.isClassLike(ancestor) || ts.isFunctionLike(ancestor)) return undefined;
    ancestor = ancestor.parent;
  }
  const owner = ancestor?.parent;
  if (owner === undefined || !ts.isClassDeclaration(owner) || owner.name === undefined) return undefined;
  const name = owner.name;
  const position = source.getLineAndCharacterOfPosition(name.getStart(source));
  // The graph exposes lines but no declaration-name columns: same-line homonyms cannot be joined safely.
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === name.text && source.getLineAndCharacterOfPosition(node.name.getStart(source)).line === position.line) count++;
    node.forEachChild(visit);
  };
  visit(source);
  return count === 1 ? { file: source.fileName.slice(SNAPSHOT.length + 1), symbol: name.text, line: position.line + 1, column: position.character + 1 } : undefined;
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

/** A checker recovery signature is not proof of an admitted invocation. */
function callDeclaration(checker: ts.TypeChecker, program: ts.Program, named: ts.Node, symbol: ts.Symbol): ts.Declaration | undefined {
  let expression = named;
  if (ts.isPropertyAccessExpression(named.parent) && named.parent.name === named) expression = named.parent;
  while (ts.isParenthesizedExpression(expression.parent) || ts.isNonNullExpression(expression.parent) || ts.isAsExpression(expression.parent)) expression = expression.parent;
  const call = expression.parent;
  if (!ts.isCallExpression(call) || call.expression !== expression) return declarationOf(checker, symbol);
  const bound = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = bound.getDeclarations() ?? [];
  const signature = checker.getResolvedSignature(call);
  const selected = signature?.getDeclaration();
  if (selected === undefined || !declarations.includes(selected)) return undefined;
  const source = call.getSourceFile();
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  if (diagnostics.some(d => d.category === ts.DiagnosticCategory.Error && d.start !== undefined
    && d.start < call.end && d.start + (d.length ?? 0) > call.getStart(source))) return undefined;
  const signatures = checker.getTypeAtLocation(expression).getCallSignatures();
  if (signatures.length > 1 && (call.arguments ?? []).some(arg => {
    const type = checker.getTypeAtLocation(arg);
    return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union)) !== 0;
  })) return undefined;
  return selected;
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
  const { line } = file.getLineAndCharacterOfPosition((ts.getNameOfDeclaration(declaration) ?? declaration).getStart(file));
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
