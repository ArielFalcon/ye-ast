import ts from "typescript";
import { compareText } from "../../domain/shared/code-node.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { DeclaredCallable, DeclaredMemberNames, DeclaredMemberNamesReader, SyntaxCall } from "../../ports/declared-member-names.port.ts";
import { annotated, isFunctionValueNode, localReceivers } from "./function-value-calls.ts";
import type { SourcePosition, SourceSpan } from "../../domain/trace/owning-body.ts";
import { isStatic } from "./syntax-names.ts";
import { lineOf, unwrapped } from "./syntax.ts";
import { sourceTree } from "./source-tree.ts";

const NONE: DeclaredMemberNames = { names: [], functionValueCalls: [], callables: [], receiverBindings: [], functionValues: [] };

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
      const calls: SyntaxCall[] = [];
      const owners: SyntaxCall["owners"][number][] = [];
      const callable = (node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature, overridable: boolean): void => {
        if (node.name === undefined) return;
        const body = !ts.isMethodSignature(node) && node.body !== undefined;
        const returns = annotated(node.type, tree);
        callables.push({ name: node.name.getText(tree), start: lineOf(tree, node), nameLine: lineOf(tree, node.name), body, overridable, ...(returns === undefined ? {} : { returns }) });
      };
      const add = (name: ts.PropertyName | ts.BindingName | undefined): void => {
        if (name === undefined || ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return;
        if (!ts.isComputedPropertyName(name)) return void names.add(name.text);
        if (ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression)) names.add(name.expression.text);
      };
      const functionValues: SourceSpan[] = [];
      const positionOf = (at: number): SourcePosition => {
        const { line, character } = tree.getLineAndCharacterOfPosition(at);
        return { line: line + 1, column: character };
      };
      const visit = (node: ts.Node): void => {
        if (isFunctionValueNode(node)) functionValues.push({ start: positionOf(node.getStart(tree)), end: positionOf(node.getEnd()) });
        if (ts.isDecorator(node)) {
          let scope: ts.Node | undefined = node.parent;
          while (scope !== undefined && !ts.isClassLike(scope)) scope = scope.parent;
          const owner = scope !== undefined && ts.isClassLike(scope) ? scope : undefined;
          const index = owner === undefined ? -1 : owners.findLastIndex((place) => place.name === owner.name?.text && place.start === lineOf(tree, owner));
          const held = owners.splice(index + 1);
          ts.forEachChild(node, visit);
          owners.push(...held);
          return;
        }
        const name = (ts.isFunctionDeclaration(node) || ts.isClassLike(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isPropertyDeclaration(node)) ? node.name
          : (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) ? node.parent.name : undefined;
        const constructor = ts.isConstructorDeclaration(node);
        const owns = ts.isFunctionLike(node) || constructor || (name !== undefined && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)));
        if (owns) {
          const start = positionOf(node.getStart(tree));
          const named = positionOf((name ?? node).getStart(tree));
          const end = positionOf(node.getEnd());
          owners.push({ name: constructor ? "constructor" : (name?.getText(tree) ?? "").replace(/^['"]|['"]$/g, ""), start: start.line, nameLine: named.line, nameColumn: named.column, startColumn: start.column, endLine: end.line, endColumn: end.column });
        }
        if (ts.isFunctionDeclaration(node)) callable(node, false);
        if (isDeclareOnly(node)) { if (owns) owners.pop(); return; }
        if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
          const point = positionOf(node.getStart(tree));
          const written = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
          const expression = unwrapped(written);
          const callee = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
          const anchors = [];
          let at: ts.Node | undefined = node;
          while (at !== undefined && !ts.isFunctionLike(at) && !ts.isClassLike(at) && !ts.isBlock(at) && !ts.isSourceFile(at)) {
            const position = positionOf(at.getStart(tree));
            anchors.push({ line: position.line, column: position.column + 1 });
            at = at.parent;
          }
          const namePosition = positionOf((ts.isPropertyAccessExpression(expression) ? expression.name : written).getStart(tree));
          anchors.push({ line: namePosition.line, column: namePosition.column + 1 });
          calls.push({ anchors, kind: ts.isNewExpression(node) ? "instantiates" : "calls", line: point.line, column: point.column + 1, name: written.getText(tree), ...(callee === undefined ? {} : { callee }), owners: [...owners] });
        }
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
        ts.forEachChild(node, (child) => {
          if (owns && child === name) {
            const held = owners.pop()!;
            visit(child);
            owners.push(held);
          } else visit(child);
        });
        if (owns) owners.pop();
      };
      visit(tree);
      return { names: [...names].sort(compareText), ...localReceivers(tree), callables, calls, functionValues };
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
