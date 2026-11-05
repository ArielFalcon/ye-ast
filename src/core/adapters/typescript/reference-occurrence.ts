import ts from "typescript";
import type { ReferenceSite } from "../../domain/relations/resolved-reference.ts";

/** One anchored expression with matching spelling and role, never a neighboring name. */
export function findReferenceOccurrence(source: ts.SourceFile, site: ReferenceSite): ts.Node | undefined {
  if (!site.fullName || !site.kind || !Number.isInteger(site.line) || !Number.isInteger(site.column) || site.line < 1 || site.column < 1) return undefined;
  const starts = source.getLineStarts();
  const start = starts[site.line - 1];
  if (start === undefined) return undefined;
  const point = start + site.column - 1;
  if (point >= (starts[site.line] ?? source.text.length)) return undefined;
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (node.getStart(source) === point) {
      const expr = site.kind === "calls" && ts.isCallExpression(node) ? node.expression
        : site.kind === "instantiates" && ts.isNewExpression(node) ? node.expression
        : undefined;
      if (expr !== undefined && syntaxName(expr, source) === site.fullName) found.push(expr);
      else if (matchesReferenceKind(node, site.kind) && syntaxName(node, source) === site.fullName) found.push(node);
    }
    node.forEachChild(visit);
  };
  visit(source);
  let node = found[0];
  if (found.length !== 1 || node === undefined) return undefined;
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) node = node.expression;
  return ts.isPropertyAccessExpression(node) ? node.name : ts.isIdentifier(node) ? node : undefined;
}

/** Check the syntax role as well as spelling and position; a declaration is not a use. */
export function matchesReferenceKind(node: ts.Node, kind: string | undefined): boolean {
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return false;
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)) return false;
  if ("name" in parent && parent.name === node && !ts.isPropertyAccessExpression(parent) && !ts.isShorthandPropertyAssignment(parent)) return false;
  if (kind === "references") return true;
  if (kind === "function_ref") return !ts.isPartOfTypeNode(node);
  if (kind === "extends" || kind === "implements") {
    return ts.isExpressionWithTypeArguments(parent) && parent.expression === node && ts.isHeritageClause(parent.parent) && parent.parent.token === (kind === "extends" ? ts.SyntaxKind.ExtendsKeyword : ts.SyntaxKind.ImplementsKeyword);
  }
  if (kind === "decorates") return ts.isDecorator(parent) || (ts.isCallExpression(parent) && parent.expression === node && ts.isDecorator(parent.parent));
  return false;
}

/** Match the graph's spelling, which omits the arguments of a nested call. */
export function syntaxName(node: ts.Node, tree: ts.SourceFile): string {
  if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return syntaxName(node.expression, tree);
  if (ts.isPropertyAccessExpression(node)) return `${syntaxName(node.expression, tree)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${syntaxName(node.expression, tree)}()`;
  return node.getText(tree);
}
