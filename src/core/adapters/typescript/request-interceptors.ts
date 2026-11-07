import ts from "typescript";
import type { Origin } from "../../domain/contracts/request-origin.ts";
import { classNamed, methodDeclared } from "./consumer-flow.classes.ts";
import type { Program, Unit } from "./consumer-flow.index.ts";
import { propertyNameText, unwrap } from "./consumer-flow.syntax.ts";
import { lineOf } from "./http-call-sites.adapter.ts";

const frontierAt = (node: ts.Node, detail: string): Origin => ({
  kind: "frontier",
  reason: "untracked",
  detail,
  at: { path: node.getSourceFile().fileName, line: lineOf(node.getSourceFile(), node) },
  hops: [],
  conditions: [],
});

/**
 * The places where an HTTP interceptor registered by the application may replace the body of a request, each a frontier:
 * a request cloned with a `body`, a request built anew, or an interceptor the reader cannot read. An interceptor that
 * clones only other fields keeps the body and is no frontier.
 */
export function bodyReplacements(program: Program): Origin[] {
  const found: Origin[] = [];
  for (const unit of program.index.units.values()) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node) === "withInterceptors") found.push(...registered(program, unit, node));
      if (ts.isObjectLiteralExpression(node) && provides(node, "HTTP_INTERCEPTORS")) found.push(...registeredClass(program, unit, node));
      node.forEachChild(visit);
    };
    visit(unit.tree);
  }
  return found;
}

function registered(program: Program, unit: Unit, call: ts.CallExpression): Origin[] {
  const list = call.arguments[0] === undefined ? undefined : unwrap(call.arguments[0]);
  if (list === undefined || !ts.isArrayLiteralExpression(list)) return [frontierAt(call, "interceptors")];
  return list.elements.flatMap((element) => {
    const interceptor = ts.isExpression(element) ? functionOf(program, unit, unwrap(element)) : undefined;
    return interceptor === undefined ? [frontierAt(element, "interceptor")] : replacementIn(interceptor);
  });
}

function registeredClass(program: Program, unit: Unit, registration: ts.ObjectLiteralExpression): Origin[] {
  const used = registration.properties.find((member): member is ts.PropertyAssignment => ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === "useClass");
  const initializer = used === undefined ? undefined : unwrap(used.initializer);
  const owner = initializer !== undefined && ts.isIdentifier(initializer) ? classNamed(program, unit, initializer.text) : undefined;
  const method = owner === undefined ? undefined : methodDeclared(owner.cls, "intercept");
  return method === undefined ? [frontierAt(registration, "interceptor")] : replacementIn(method.node);
}

/** The function an expression names or is, in this file or the one it imports from. */
function functionOf(program: Program, unit: Unit, expression: ts.Expression): ts.Node | undefined {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (!ts.isIdentifier(expression)) return undefined;
  const local = unit.functions.get(expression.text);
  if (local !== undefined) return local.node;
  const origin = program.index.origin(unit.file, expression.text);
  return origin === undefined || origin === "external" ? undefined : program.index.units.get(origin.file)?.functions.get(origin.name)?.node;
}

function replacementIn(interceptor: ts.Node): Origin[] {
  const found: Origin[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "HttpRequest") found.push(frontierAt(node, "interceptor"));
    if (ts.isCallExpression(node) && calleeName(node) === "clone" && node.arguments.length > 0 && !keepsBody(node.arguments[0]!)) found.push(frontierAt(node, "interceptor"));
    node.forEachChild(visit);
  };
  visit(interceptor);
  return found;
}

/** A clone whose argument is an object that names neither a `body` nor a spread or computed key leaves the body as it was. */
function keepsBody(argument: ts.Expression): boolean {
  const bare = unwrap(argument);
  return ts.isObjectLiteralExpression(bare) && bare.properties.every((member) => !ts.isSpreadAssignment(member) && member.name !== undefined && propertyNameText(member.name) !== undefined && propertyNameText(member.name) !== "body");
}

function provides(registration: ts.ObjectLiteralExpression, token: string): boolean {
  return registration.properties.some((member) => ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === "provide" && ts.isIdentifier(member.initializer) && member.initializer.text === token);
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}
