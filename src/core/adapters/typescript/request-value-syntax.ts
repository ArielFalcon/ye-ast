import ts from "typescript";
import { ABSENT_VALUE, UNKNOWN_VALUE, valueMayBeObject, valueUnknown, type RequestValue } from "./request-values.ts";
import { unwrapped } from "./syntax.ts";

interface ValueSyntaxDeps {
  binding(node: ts.Identifier): { parameter: number; stable: Promise<boolean>; initializer?: ts.Expression } | { expression: ts.Expression; stable: () => Promise<boolean> } | { unsafe: true } | undefined;
  callee(node: ts.CallExpression): Promise<readonly (ts.Node | undefined)[] | undefined>;
  constant(node: ts.Expression): Promise<RequestValue>;
  initializer(node: ts.Identifier): Promise<ts.Expression | undefined>;
  builtin(node: ts.Identifier): boolean;
  propertiesSafe: boolean;
  stringsSafe: boolean;
  encoderSafe: boolean;
}

/** Compiles declaration-local value facts; applying them never visits syntax again. */
export function requestValueSyntax(deps: ValueSyntaxDeps): (node: ts.Expression) => Promise<RequestValue> {
  const expressions = new WeakMap<ts.Expression, Promise<RequestValue>>();
  const declarations = new WeakMap<ts.Node, Promise<RequestValue>>();
  const unknownAt = (node: ts.Node, recursive = false): RequestValue => valueUnknown([{ path: node.getSourceFile().fileName, line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 }], recursive ? "recursive" : "destination-undecidable");
  const operation = (operator: Extract<RequestValue, { kind: "operation" }>["operator"], ...operands: RequestValue[]): RequestValue => ({ kind: "operation", operator, operands });
  const expression = (node: ts.Expression, trail: ReadonlySet<ts.Node>): Promise<RequestValue> => {
    if (trail.has(node)) return Promise.resolve(unknownAt(node, true));
    const cached = expressions.get(node);
    if (cached !== undefined) return cached;
    const result = compile(node, new Set(trail).add(node));
    expressions.set(node, result);
    return result;
  };
  const body = (node: ts.Node, trail: ReadonlySet<ts.Node>): Promise<RequestValue> => {
    if (trail.has(node)) return Promise.resolve(unknownAt(node, true));
    const cached = declarations.get(node);
    if (cached !== undefined) return cached;
    const nested = new Set(trail).add(node);
    const result = ts.isBlock(node) ? statements(node.statements, unknownAt(node), nested) : ts.isExpression(node) ? expression(node, nested) : Promise.resolve(unknownAt(node));
    declarations.set(node, result);
    return result;
  };
  const hasReturn = (node: ts.Node): boolean => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
    return ts.isReturnStatement(node) || (ts.forEachChild(node, (child) => hasReturn(child) || undefined) ?? false);
  };
  const statement = async (node: ts.Statement, rest: RequestValue, trail: ReadonlySet<ts.Node>): Promise<RequestValue> => {
    if (ts.isReturnStatement(node)) return node.expression === undefined ? ABSENT_VALUE : expression(node.expression, trail);
    if (ts.isBlock(node)) return statements(node.statements, rest, trail);
    if (ts.isIfStatement(node)) {
      if (!hasReturn(node)) return rest;
      return { kind: "choose", condition: await expression(node.expression, trail), yes: await statement(node.thenStatement, rest, trail), no: node.elseStatement === undefined ? rest : await statement(node.elseStatement, rest, trail) };
    }
    if (ts.isVariableStatement(node) || ts.isExpressionStatement(node) || ts.isFunctionDeclaration(node) || ts.isEmptyStatement(node)) return rest;
    return unknownAt(node);
  };
  const statements = async (nodes: readonly ts.Statement[], rest: RequestValue, trail: ReadonlySet<ts.Node>): Promise<RequestValue> => {
    let value = rest;
    for (let index = nodes.length - 1; index >= 0; index--) value = await statement(nodes[index]!, value, trail);
    return value;
  };
  const compile = async (written: ts.Expression, trail: ReadonlySet<ts.Node>): Promise<RequestValue> => {
    const node = unwrapped(written);
    if (node !== written) return expression(node, trail);
    if (ts.isStringLiteralLike(node)) return { kind: "literal", value: node.text };
    if (ts.isNumericLiteral(node)) return { kind: "literal", value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: node.kind === ts.SyntaxKind.TrueKeyword };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "literal", value: null };
    if (ts.isIdentifier(node)) {
      const binding = deps.binding(node);
      if (binding !== undefined && "unsafe" in binding) return unknownAt(node);
      if (binding !== undefined && "parameter" in binding) return { kind: "parameter", index: binding.parameter, propertiesSafe: await binding.stable, ...(binding.initializer === undefined ? {} : { fallback: await expression(binding.initializer, trail) }) };
      if (binding !== undefined && "expression" in binding) {
        const value = await expression(binding.expression, trail);
        return valueMayBeObject(value) && !(await binding.stable()) ? { kind: "opaque", value, gap: { cause: "destination-undecidable", evidence: [{ path: node.getSourceFile().fileName, line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 }] } } : value;
      }
      if (node.text === "undefined" && deps.builtin(node)) return ABSENT_VALUE;
      const initializer = await deps.initializer(node);
      return initializer === undefined ? deps.constant(node) : expression(initializer, trail);
    }
    if (ts.isObjectLiteralExpression(node)) {
      if (!deps.propertiesSafe) return unknownAt(node);
      const fields = new Map<string, RequestValue>();
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property) || !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name) || property.name.text === "__proto__") return unknownAt(node);
        fields.set(property.name.text, await expression(property.initializer, trail));
      }
      return { kind: "object", fields };
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) return deps.constant(node);
      const binding = ts.isIdentifier(node.expression) ? deps.binding(node.expression) : undefined;
      if (!deps.propertiesSafe || binding !== undefined && "parameter" in binding && !(await binding.stable)) return unknownAt(node);
      return { kind: "property", owner: await expression(node.expression, trail), name: node.name.text, optional: node.questionDotToken !== undefined };
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return operation("!", await expression(node.operand, trail));
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      const name = operator === ts.SyntaxKind.PlusToken ? "+" : operator === ts.SyntaxKind.BarBarToken ? "||" : operator === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : operator === ts.SyntaxKind.QuestionQuestionToken ? "??" : undefined;
      if (name !== undefined) return operation(name, await expression(node.left, trail), await expression(node.right, trail));
    }
    if (ts.isConditionalExpression(node)) return { kind: "choose", condition: await expression(node.condition, trail), yes: await expression(node.whenTrue, trail), no: await expression(node.whenFalse, trail) };
    if (ts.isTemplateExpression(node)) {
      let value: RequestValue = { kind: "literal", value: node.head.text };
      for (const span of node.templateSpans) value = operation("+", operation("+", value, await expression(span.expression, trail)), { kind: "literal", value: span.literal.text });
      return value;
    }
    if (ts.isCallExpression(node)) {
      if (node.arguments.some(ts.isSpreadElement)) return unknownAt(node);
      if (ts.isIdentifier(node.expression) && node.expression.text === "encodeURIComponent" && deps.builtin(node.expression) && deps.encoderSafe && node.arguments.length === 1) return operation("encode", await expression(node.arguments[0]!, trail));
      if (ts.isPropertyAccessExpression(node.expression) && deps.stringsSafe) {
        const receiver = node.expression.expression;
        if (node.expression.name.text === "startsWith" && node.arguments.length === 1) return operation("startsWith", await expression(receiver, trail), await expression(node.arguments[0]!, trail));
        if (node.expression.name.text === "replace" && node.arguments.length === 2 && ts.isStringLiteralLike(node.arguments[1]!) && node.arguments[1]!.text === "") {
          const writtenPattern = node.arguments[0]!;
          const pattern = ts.isIdentifier(writtenPattern) ? await deps.initializer(writtenPattern) : writtenPattern;
          const spelling = pattern !== undefined && ts.isRegularExpressionLiteral(pattern) ? pattern.text : undefined;
          if (spelling === "/^\\/+/" || spelling === "/\\/+$/") return operation(spelling === "/^\\/+/" ? "trim-start" : "trim-end", await expression(receiver, trail));
        }
      }
      const targets = await deps.callee(node);
      if (targets === undefined || targets.length === 0) return unknownAt(node);
      const args = await Promise.all(node.arguments.map((arg) => expression(arg, trail)));
      const alternatives = await Promise.all(targets.map((target) => target === undefined ? Promise.resolve(unknownAt(node)) : body(target, trail)));
      let value = alternatives[0] ?? UNKNOWN_VALUE;
      for (const other of alternatives.slice(1)) value = { kind: "choose", condition: UNKNOWN_VALUE, yes: value, no: other };
      return { kind: "apply", body: value, arguments: args };
    }
    return deps.constant(node);
  };
  return (node) => expression(node, new Set());
}
