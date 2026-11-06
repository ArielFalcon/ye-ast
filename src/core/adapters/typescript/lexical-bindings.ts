import ts from "typescript";

/** What a name binds at one place: the symbol and its declarations, nothing the file declares (the binder answers so inside `with` too), or a scope a sloppy direct `eval` can extend at run time. */
export type LexicalBinding = { kind: "declared"; symbol: ts.Symbol; declarations: readonly ts.Declaration[] } | { kind: "none" } | { kind: "dynamic" };

export interface BoundFile {
  /** The file's own tree, bound; `bindingOf` answers for its identifiers. */
  tree: ts.SourceFile;
  bindingOf(identifier: ts.Identifier): LexicalBinding;
  /** The identifier spelled `name` that starts at `start`, an offset into the file's text. */
  identifierAt(start: number, name: string): ts.Identifier | undefined;
}

/** One file alone: no library, no module resolution, no configuration; the binder sees nothing but the file (ADR-0026). */
const OPTIONS: ts.CompilerOptions = { noLib: true, noResolve: true, types: [], allowJs: true, noEmit: true, target: ts.ScriptTarget.Latest };
const NONE: LexicalBinding = { kind: "none" };
const DYNAMIC: LexicalBinding = { kind: "dynamic" };

/**
 * Binds one source through a program over that file alone, with the compiler's own scoping (ADR-0026). The caller asks
 * the names it needs and drops the result; nothing here asks for a type.
 */
export function bindFile(path: string, content: string): BoundFile {
  const fileName = `/${path}`;
  const tree = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? tree : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? content : undefined),
  };
  const checker = ts.createProgram({ rootNames: [fileName], options: OPTIONS, host }).getTypeChecker();
  const dynamicScopes = evalScopes(tree);
  let starting: Map<number, ts.Identifier[]> | undefined;

  const isDynamic = (identifier: ts.Identifier): boolean => {
    for (let node: ts.Node | undefined = identifier.parent; node !== undefined; node = node.parent) if (dynamicScopes.has(node)) return true;
    return false;
  };

  return {
    tree,
    bindingOf(identifier) {
      if (isDynamic(identifier)) return DYNAMIC;
      const parent = identifier.parent;
      const symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === identifier ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(identifier);
      const declarations = symbol?.declarations ?? [];
      return symbol === undefined || declarations.length === 0 ? NONE : { kind: "declared", symbol, declarations };
    },
    identifierAt(start, name) {
      if (starting === undefined) {
        const index = new Map<number, ts.Identifier[]>();
        const visit = (node: ts.Node): void => {
          if (ts.isIdentifier(node)) index.set(node.getStart(tree), [...(index.get(node.getStart(tree)) ?? []), node]);
          node.forEachChild(visit);
        };
        visit(tree);
        starting = index;
      }
      return starting.get(start)?.find((identifier) => identifier.text === name);
    },
  };
}

/** The function bodies and the file whose own code, outside strict mode, calls `eval` directly: a `var` it evaluates joins that scope at run time. */
function evalScopes(tree: ts.SourceFile): ReadonlySet<ts.Node> {
  const scopes = new Set<ts.Node>();
  const visit = (node: ts.Node, scope: ts.Node, strict: boolean): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval" && !strict) scopes.add(scope);
    if (ts.isClassLike(node)) return node.forEachChild((child) => visit(child, scope, true));
    if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
      const inner = strict || (ts.isBlock(node.body) && declaresStrict(node.body.statements));
      return node.forEachChild((child) => visit(child, node, inner));
    }
    node.forEachChild((child) => visit(child, scope, strict));
  };
  const strict = ts.isExternalModule(tree) || declaresStrict(tree.statements);
  tree.forEachChild((child) => visit(child, tree, strict));
  return scopes;
}

function declaresStrict(statements: readonly ts.Statement[]): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === "use strict") return true;
  }
  return false;
}
