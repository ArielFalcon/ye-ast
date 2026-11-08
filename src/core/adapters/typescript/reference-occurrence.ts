import ts from "typescript";

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
