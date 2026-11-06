import ts from "typescript";
import { compareText } from "../../domain/shared/code-node.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { DeclaredMemberNames, DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import { sourceTree } from "./source-tree.ts";

const NONE: DeclaredMemberNames = { names: [] };

/**
 * The member names a TypeScript source declares where a value can live: object-literal keys, properties assigned through
 * a dot or a literal index, class members and constructor parameter properties, and enum members. A type, an interface
 * or a type literal holds none of these, and an ambient (`declare`) declaration is skipped whole, as the type-only rule
 * skips types in the index.
 */
export function createTypeScriptMemberNames(): DeclaredMemberNamesReader {
  return {
    memberNames: async (file) => {
      if (!isTypeScriptSource(file.path)) return NONE;
      const tree = sourceTree(file, ts.ScriptTarget.Latest, true);
      const names = new Set<string>();
      const add = (name: ts.PropertyName | ts.BindingName | undefined): void => {
        if (name === undefined || ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return;
        if (!ts.isComputedPropertyName(name)) return void names.add(name.text);
        if (ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression)) names.add(name.expression.text);
      };
      const visit = (node: ts.Node): void => {
        if (isDeclareOnly(node)) return;
        if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) if (!ts.isSpreadAssignment(property)) add(property.name);
        if (ts.isClassLike(node)) for (const member of node.members) if (!isDeclareOnly(member)) add(member.name);
        if (ts.isConstructorDeclaration(node)) for (const parameter of node.parameters) if (ts.isParameterPropertyDeclaration(parameter, node)) add(parameter.name);
        if (ts.isEnumDeclaration(node)) for (const member of node.members) add(member.name);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (ts.isPropertyAccessExpression(node.left)) names.add(node.left.name.text);
          else if (ts.isElementAccessExpression(node.left)) {
            const index = node.left.argumentExpression;
            if (ts.isStringLiteralLike(index) || ts.isNumericLiteral(index)) names.add(index.text);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
      return { names: [...names].sort(compareText) };
    },
  };
}

function isDeclareOnly(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}
