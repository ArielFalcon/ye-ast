import ts from "typescript";
import type { DeclarationEvidenceReader } from "../../ports/declaration-evidence.port.ts";

/** Syntactic evidence only. An ambiguous scope or malformed file proves nothing. */
export function createDeclarationEvidenceReader(): DeclarationEvidenceReader {
  return { validate({ path, base, head, names, deleted }) {
    if (!/\.[cm]?[jt]sx?$/.test(path) || base === undefined || (!deleted && head === undefined)) return names;
    const before = declarations(path, base);
    const after = deleted ? new Map<string, number>() : head === base ? before : declarations(path, head!);
    if (before === undefined || after === undefined) return names;
    const retained = new Set<string>();
    for (const [key, count] of before) {
      if (key.includes("<anonymous>") || (after.get(key) ?? 0) < count) retained.add(key.slice(0, key.indexOf("\0")));
    }
    return names.filter((name) => retained.has(name));
  } };
}

function declarations(path: string, text: string): Map<string, number> | undefined {
  let tree: ts.SourceFile | undefined;
  const result = ts.transpileModule(text, { fileName: path, reportDiagnostics: true, compilerOptions: { noResolve: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.Preserve }, transformers: { before: [() => (source) => { tree = source; return source; }] } });
  if (tree === undefined || result.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) return undefined;
  const counts = new Map<string, number>();
  let ambiguous = false;
  const ownerKeys = new Set<string>();
  const visit = (node: ts.Node, owners: readonly string[]): void => {
    const named = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node) || ts.isTypeParameterDeclaration(node) || ts.isImportEqualsDeclaration(node);
    let owner = owners;
    if (ts.isConstructorDeclaration(node)) {
      const key = `constructor\0${JSON.stringify(owners)}\0${node.kind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (ownerKeys.has(key)) ambiguous = true;
      ownerKeys.add(key);
      owner = [...owners, `${node.kind}:constructor`];
    }
    if (named) {
      const name = node.name;
      if (name !== undefined && ts.isIdentifier(name)) {
        const key = `${name.text}\0${JSON.stringify(owners)}\0${node.kind}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isModuleDeclaration(node)) {
          if (ownerKeys.has(key)) ambiguous = true;
          ownerKeys.add(key);
          owner = [...owners, `${node.kind}:${name.text}`];
        }
      } else if (name !== undefined && !ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name)) ambiguous = true;
    }
    if (ts.isBlock(node) || ts.isObjectLiteralExpression(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCatchClause(node) || ts.isCaseBlock(node) || ts.isArrowFunction(node) || (ts.isFunctionExpression(node) && node.name === undefined) || (ts.isClassExpression(node) && node.name === undefined)) owner = [...owners, "<anonymous>"];
    node.forEachChild((child) => visit(child, owner));
  };
  visit(tree, []);
  return ambiguous ? undefined : counts;
}
