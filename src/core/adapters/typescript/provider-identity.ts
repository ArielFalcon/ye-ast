import ts from "typescript";
import { bare } from "./angular-router.extractor.ts";

export interface ProviderIdentityEvidence {
  tokens: ReadonlySet<string>;
  exportedTokens: ReadonlySet<string>;
  imports: ReadonlyMap<string, { module: string; imported: string }>;
  writes: ReadonlySet<string>;
}

/** Syntax evidence only. External module authentication is supplied by the caller. */
export function providerIdentityEvidence(sf: ts.SourceFile, coreExternal: boolean, counts: ReadonlyMap<string, number>): ProviderIdentityEvidence {
  const imports = new Map<string, { module: string; imported: string }>();
  const importCounts = new Map<string, number>();
  const noteImport = (name: string): void => { importCounts.set(name, (importCounts.get(name) ?? 0) + 1); };
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    if (s.importClause?.name) noteImport(s.importClause.name.text);
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) {
      noteImport(b.name.text);
      if (!s.importClause?.isTypeOnly) imports.set(b.name.text, { module: s.moduleSpecifier.text, imported: "*" });
    }
    if (b && ts.isNamedImports(b)) for (const e of b.elements) {
      noteImport(e.name.text);
      if (!s.importClause?.isTypeOnly && !e.isTypeOnly) imports.set(e.name.text, { module: s.moduleSpecifier.text, imported: (e.propertyName ?? e.name).text });
    }
  }
  for (const [name, count] of importCounts) if (count !== 1) imports.delete(name);
  const tokens = new Set<string>();
  const exportedTokens = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s) || !(s.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || counts.get(d.name.text) !== 1 || !d.initializer || !ts.isNewExpression(d.initializer)) continue;
      const e = d.initializer.expression;
      const root = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.name.text === "InjectionToken" ? e.expression.text : undefined;
      const binding = root === undefined ? undefined : imports.get(root);
      if (!coreExternal || root === undefined || counts.has(root) || binding?.module !== "@angular/core" || (ts.isIdentifier(e) ? binding.imported !== "InjectionToken" : binding.imported !== "*")) continue;
      tokens.add(d.name.text);
      if (s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) exportedTokens.add(d.name.text);
    }
  }
  for (const s of sf.statements) {
    if (!ts.isExportDeclaration(s)) continue;
    if (s.exportClause === undefined) exportedTokens.clear();
    else if (ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) exportedTokens.delete(e.name.text);
  }
  const writes = new Set<string>();
  const target = (node: ts.Node): void => {
    if (ts.isNonNullExpression(node)) { target(node.expression); return; }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) { target(bare(node)); return; }
    if (ts.isIdentifier(node)) { writes.add(node.text); return; }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return;
    if (ts.isPropertyAssignment(node)) { target(node.initializer); return; }
    if (ts.isShorthandPropertyAssignment(node)) { target(node.name); return; }
    if (ts.isBinaryExpression(node)) { target(node.left); return; }
    node.forEachChild(target);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) target(node.operand);
    if (ts.isDeleteExpression(node)) target(node.expression);
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) target(node.initializer);
    node.forEachChild(visit);
  };
  visit(sf);
  return { tokens, exportedTokens, imports, writes };
}
