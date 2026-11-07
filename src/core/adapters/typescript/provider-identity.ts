import ts from "typescript";
import type { ModuleShape } from "./module-shape.ts";
import { unwrapped } from "./syntax.ts";

export interface ProviderIdentityEvidence {
  tokens: ReadonlySet<string>;
  exportedTokens: ReadonlySet<string>;
  imports: ReadonlyMap<string, { module: string; imported: string }>;
  writes: ReadonlySet<string>;
}

/** Syntax evidence only. External module authentication is supplied by the caller. */
export function providerIdentityEvidence(sf: ts.SourceFile, shape: Pick<ModuleShape, "imports" | "reimported">, coreExternal: boolean, counts: ReadonlyMap<string, number>): ProviderIdentityEvidence {
  const imports = new Map<string, { module: string; imported: string }>();
  for (const [name, { module, imported, typeOnly }] of shape.imports) if (imported !== "default" && typeOnly !== true && !shape.reimported.has(name)) imports.set(name, { module, imported });
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
    if (ts.isExpression(node) && unwrapped(node) !== node) { target(unwrapped(node)); return; }
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
