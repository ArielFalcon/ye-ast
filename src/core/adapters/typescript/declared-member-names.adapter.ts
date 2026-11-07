import ts from "typescript";
import { compareText } from "../../domain/shared/code-node.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { DeclaredCallable, DeclaredMemberNames, DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import { localReceivers } from "./function-value-calls.ts";
import { isStatic } from "./syntax-names.ts";
import { sourceTree } from "./source-tree.ts";

const NONE: DeclaredMemberNames = { names: [], functionValueCalls: [], callables: [], receiverBindings: [] };

/**
 * The member names a TypeScript source declares where a value can live: object-literal keys, properties assigned through
 * a dot or a literal index, class members and constructor parameter properties, and enum members. A type, an interface
 * or a type literal holds none of these, and an ambient (`declare`) declaration is skipped whole, as the type-only rule
 * skips types in the index. A module's exported value names count too: a renamed or re-exported specifier, a namespace
 * re-export and `default`, never a type-only export. Its callables are its functions, ambient ones and overload
 * signatures included, the methods of its classes, and the method signatures of its interfaces.
 */
export function createTypeScriptMemberNames(): DeclaredMemberNamesReader {
  return {
    memberNames: async (file) => {
      if (!isTypeScriptSource(file.path)) return NONE;
      const tree = sourceTree(file, ts.ScriptTarget.Latest);
      const names = new Set<string>();
      const callables: DeclaredCallable[] = [];
      const lineOf = (node: ts.Node): number => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      const callable = (node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature, overridable: boolean): void => {
        if (node.name === undefined) return;
        const body = !ts.isMethodSignature(node) && node.body !== undefined;
        callables.push({ name: node.name.getText(tree), start: lineOf(node), nameLine: lineOf(node.name), body, overridable });
      };
      const add = (name: ts.PropertyName | ts.BindingName | undefined): void => {
        if (name === undefined || ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return;
        if (!ts.isComputedPropertyName(name)) return void names.add(name.text);
        if (ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression)) names.add(name.expression.text);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node)) callable(node, false);
        if (isDeclareOnly(node)) return;
        if (ts.isMethodDeclaration(node) && ts.isClassLike(node.parent)) callable(node, isOverridable(node));
        if (ts.isMethodSignature(node) && ts.isInterfaceDeclaration(node.parent)) callable(node, true);
        if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) if (!ts.isSpreadAssignment(property)) add(property.name);
        if (ts.isClassLike(node)) for (const member of node.members) if (!isDeclareOnly(member)) add(member.name);
        if (ts.isConstructorDeclaration(node)) for (const parameter of node.parameters) if (ts.isParameterPropertyDeclaration(parameter, node)) add(parameter.name);
        if (ts.isEnumDeclaration(node)) for (const member of node.members) add(member.name);
        if (ts.isExportDeclaration(node) && !node.isTypeOnly) for (const name of exportedValueNames(node)) names.add(name);
        if ((ts.isExportAssignment(node) && !node.isExportEquals) || isDefaultExport(node)) names.add("default");
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
      return { names: [...names].sort(compareText), ...localReceivers(tree), callables };
    },
  };
}

/** The names a module re-exports or exports under another name, without the ones marked type-only. */
function exportedValueNames(declaration: ts.ExportDeclaration): string[] {
  const clause = declaration.exportClause;
  if (clause === undefined) return [];
  if (ts.isNamespaceExport(clause)) return [clause.name.text];
  return clause.elements.filter((specifier) => !specifier.isTypeOnly).map((specifier) => specifier.name.text);
}

function isDefaultExport(node: ts.Node): boolean {
  return (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function isOverridable(method: ts.MethodDeclaration): boolean {
  const isPrivate = (ts.getModifiers(method) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword);
  return !ts.isPrivateIdentifier(method.name) && !isPrivate && !isStatic(method);
}

function isDeclareOnly(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}
