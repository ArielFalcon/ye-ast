import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

/**
 * Every name the pinned `typescript` build declares at the top level of its own `lib.*.d.ts`, sorted. It is the set a
 * reference can name without any file of the repository declaring it, so a cut it disproves is false (`RFC-0016` S10).
 *
 * This module exists so the committed table has one generator: `scripts/lib-globals.ts` writes it and
 * `typescript-lib-globals.test.ts` fails when the committed copy drifts from the installed pin.
 */
export function libGlobalNames(): readonly string[] {
  const directory = dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }));
  const files = readdirSync(directory)
    .filter((file) => /^lib\..*\.d\.ts$/.test(file))
    .sort();
  const names = new Set<string>();
  for (const file of files) {
    const tree = ts.createSourceFile(file, readFileSync(join(directory, file), "utf8"), ts.ScriptTarget.ES2022, false);
    const visit = (node: ts.Node): void => {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
      const name = declarationName(node);
      if (name !== undefined) names.add(name);
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return [...names].sort();
}

/** The name a declaration the libraries write at their top level gives the global scope. */
function declarationName(node: ts.Node): string | undefined {
  const declares = ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node);
  return declares && node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : undefined;
}
