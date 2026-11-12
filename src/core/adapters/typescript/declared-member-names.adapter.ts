import ts from "typescript";
import { compareText } from "../../domain/shared/code-node.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DeclaredCallable, DeclaredDeclaration, DeclaredMemberNames, DeclaredMemberNamesReader, SyntaxCall } from "../../ports/declared-member-names.port.ts";
import { annotated, isFunctionValueNode, localReceivers } from "./function-value-calls.ts";
import type { SourcePosition, SourceSpan } from "../../domain/shared/owning-body.ts";
import { hasModifier, isStatic, lineOf, unwrapped, propertyNameText } from "./syntax.ts";
import { sourceTree } from "./source-tree.ts";
import { defaultExportOf } from "./import-bindings.ts";


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
    memberNames: async (file, facts) => {
      return facts === undefined ? derive(file) : facts.ofFile("ts-member-names", file, () => derive(file));
    },
  };
}

function derive(file: SourceFile): DeclaredMemberNames {
  const tree = sourceTree(file, ts.ScriptTarget.Latest);
  const names = new Set<string>();
  const callables: DeclaredCallable[] = [];
  const declarations: DeclaredDeclaration[] = [];
  const calls: SyntaxCall[] = [];
  const initializedFields: NonNullable<DeclaredMemberNames["initializedFields"]>[number][] = [];
  const owners: SyntaxCall["owners"][number][] = [];
  const literalHolders = new Map<ts.ObjectLiteralExpression, ts.VariableDeclaration | ts.PropertyDeclaration | ts.PropertyAssignment>();
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
  const declare = (node: ts.Node, name: string, kind: DeclaredDeclaration["kind"], literal?: ts.ObjectLiteralExpression, bound = true, placementOnly = false): void => {
    const holder = literal === undefined || !bound ? undefined : literalHolders.get(literal);
    let parent: ts.Node | undefined = node.parent;
    let anonymous: ts.Node | undefined;
    let container: ts.Node | undefined;
    while (parent !== undefined && !ts.isSourceFile(parent)) {
      if (ts.isObjectLiteralExpression(parent)) {
        const namedHolder = literalHolders.get(parent);
        if (namedHolder !== undefined && namedHolder !== node) { container = namedHolder; break; }
        anonymous ??= parent;
      } else if (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent) || ts.isFunctionLike(parent)) {
        if ("name" in parent && parent.name !== undefined) { container = parent; break; }
        anonymous ??= parent;
      }
      parent = parent.parent;
    }
    const placement: NonNullable<DeclaredDeclaration["placement"]> = container !== undefined
      ? { kind: "nested", container: positionOf(container.getStart(tree)) }
      : anonymous !== undefined ? { kind: "unplaced", at: positionOf(anonymous.getStart(tree)) } : { kind: "file" };
    declarations.push({ name, kind, invoked: kind !== "object", ...(placementOnly ? { placementOnly: true as const } : {}), span: { start: positionOf(node.getStart(tree)), end: positionOf(node.getEnd()) }, placement, ...(container === undefined ? {} : { container: positionOf(container.getStart(tree)) }), ...(holder === undefined ? {} : { binding: positionOf(holder.getStart(tree)) }) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let value: ts.Node = node;
      while (ts.isExpression(value.parent) && unwrapped(value.parent) === node) value = value.parent;
      const holder = value.parent;
      if ((ts.isVariableDeclaration(holder) || ts.isPropertyDeclaration(holder) || ts.isPropertyAssignment(holder)) && holder.initializer === value && propertyName(holder.name) !== undefined) {
        literalHolders.set(node, holder);
        const outer = ts.isPropertyAssignment(holder) && ts.isObjectLiteralExpression(holder.parent) ? holder.parent : undefined;
        declare(holder, propertyName(holder.name)!, "object", outer);
      }
    }
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
    if (ts.isClassDeclaration(node) && node.name !== undefined) declare(node, node.name.text, "class", undefined, true, true);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && (node.initializer === undefined || !ts.isObjectLiteralExpression(unwrapped(node.initializer)))) declare(node, node.name.text, "value", undefined, true, true);
    if (ts.isFunctionDeclaration(node)) {
      callable(node, false);
      if (node.name !== undefined) declare(node, node.name.text, "function");
    }
    if (ts.isConstructorDeclaration(node)) {
      callables.push({ construction: true, name: "constructor", start: lineOf(tree, node), nameLine: lineOf(tree, node), body: node.body !== undefined, overridable: false });
      declare(node, "constructor", "method");
    }
    if (ts.isPropertyDeclaration(node) && node.initializer !== undefined && !isDeclareOnly(node)) initializedFields.push({ name: node.name.getText(tree), start: lineOf(tree, node), nameLine: lineOf(tree, node.name) });
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
    if (ts.isMethodDeclaration(node) && ts.isClassLike(node.parent)) {
      callable(node, isOverridable(node));
      declare(node, node.name.getText(tree), "method");
    }
    if (ts.isMethodSignature(node) && ts.isInterfaceDeclaration(node.parent)) {
      callable(node, true);
      declare(node, node.name.getText(tree), "method");
    }
    if ((ts.isGetAccessor(node) || ts.isSetAccessor(node)) && ts.isClassLike(node.parent)) declare(node, node.name.getText(tree), "accessor");
    const property = ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) ? node :
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isPropertyAssignment(node.parent) ? node.parent : undefined;
    if (property !== undefined && ts.isObjectLiteralExpression(property.parent)) {
      const name = propertyName(property.name);
      declare(node, name ?? property.name.getText(tree), ts.isGetAccessor(node) || ts.isSetAccessor(node) ? "accessor" : "method", property.parent, name !== undefined);
    }
    if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) if (!ts.isSpreadAssignment(property)) add(property.name);
    if (ts.isClassLike(node)) for (const member of node.members) if (!isDeclareOnly(member)) add(member.name);
    if (ts.isConstructorDeclaration(node)) for (const parameter of node.parameters) if (ts.isParameterPropertyDeclaration(parameter, node)) add(parameter.name);
    if (ts.isEnumDeclaration(node)) for (const member of node.members) add(member.name);
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) for (const name of exportedValueNames(node)) names.add(name);
    if (defaultExportOf(node) !== undefined) names.add("default");
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
  return { names: [...names].sort(compareText), ...localReceivers(tree), callables, declarations, calls, functionValues, initializedFields };
}

function propertyName(name: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name) ? undefined : propertyNameText(name);
}

/** The names a module re-exports or exports under another name, without the ones marked type-only. */
function exportedValueNames(declaration: ts.ExportDeclaration): string[] {
  const clause = declaration.exportClause;
  if (clause === undefined) return [];
  if (ts.isNamespaceExport(clause)) return [clause.name.text];
  return clause.elements.filter((specifier) => !specifier.isTypeOnly).map((specifier) => specifier.name.text);
}

function isOverridable(method: ts.MethodDeclaration): boolean {
  return !ts.isPrivateIdentifier(method.name) && !hasModifier(method, ts.SyntaxKind.PrivateKeyword) && !isStatic(method);
}

function isDeclareOnly(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DeclareKeyword);
}
