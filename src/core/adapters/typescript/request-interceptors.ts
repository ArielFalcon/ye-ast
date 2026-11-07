import ts from "typescript";
import type { Origin } from "../../domain/contracts/request-origin.ts";
import { classNamed, methodDeclared } from "./consumer-flow.classes.ts";
import type { Program, Unit } from "./consumer-flow.index.ts";
import { resolveFunction } from "./consumer-flow.resolution.ts";
import { calleeName, isFunctionNode, propertyNameText, unwrap } from ".\/consumer-flow.syntax.ts";
import { frontier } from "./request-origins.walker.ts";

const frontierAt = (node: ts.Node, detail: string): Origin => frontier(node, "untracked", detail);

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
    return interceptor === undefined ? [frontierAt(element, "interceptor")] : replacementIn(program, interceptor, 0);
  });
}

function registeredClass(program: Program, unit: Unit, registration: ts.ObjectLiteralExpression): Origin[] {
  const used = registration.properties.find((member): member is ts.PropertyAssignment => ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === "useClass");
  const initializer = used === undefined ? undefined : unwrap(used.initializer);
  const owner = initializer !== undefined && ts.isIdentifier(initializer) ? classNamed(program, unit, initializer.text) : undefined;
  const method = owner === undefined ? undefined : methodDeclared(owner.cls, "intercept");
  return method === undefined ? [frontierAt(registration, "interceptor")] : replacementIn(program, method.node, 0);
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

/**
 * Where the code of an interceptor, or of a helper it hands the request to, builds a request or clones one with a body.
 * `request` is the index of the parameter that holds the request; the second parameter of the interceptor forwards it.
 */
function replacementIn(program: Program, interceptor: ts.Node, request: number, followed = new Set<ts.Node>()): Origin[] {
  if (followed.has(interceptor)) return [];
  followed.add(interceptor);
  const parameters = isFunctionNode(interceptor) ? interceptor.parameters.map((parameter) => (ts.isIdentifier(parameter.name) ? parameter.name.text : undefined)) : [];
  const requestName = parameters[request];
  const forwarder = request === 0 ? parameters[1] : undefined;
  const found: Origin[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "HttpRequest") found.push(frontierAt(node, "interceptor"));
    if (ts.isCallExpression(node) && calleeName(node) === "clone" && node.arguments.length > 0 && !keepsBody(node.arguments[0]!)) found.push(frontierAt(node, "interceptor"));
    if (ts.isCallExpression(node)) found.push(...helperReplacement(program, node, requestName, forwarder, followed));
    node.forEachChild(visit);
  };
  visit(interceptor);
  return found;
}

/**
 * A call that receives the request, or whose result is passed on to the next handler, may hand back another request: its
 * declaration is judged the same way, and a call the reader cannot resolve is a frontier.
 */
function helperReplacement(program: Program, call: ts.CallExpression, request: string | undefined, forwarder: string | undefined, followed: Set<ts.Node>): Origin[] {
  if (forwards(call, forwarder) || calleeName(call) === "clone") return [];
  const at = request === undefined ? -1 : call.arguments.findIndex((argument) => unwrap(argument).kind === ts.SyntaxKind.Identifier && (unwrap(argument) as ts.Identifier).text === request);
  const passedOn = ts.isCallExpression(call.parent) && forwards(call.parent, forwarder) && call.parent.arguments.some((argument) => unwrap(argument) === call);
  if (at < 0 && !passedOn) return [];
  const unit = program.index.units.get(call.getSourceFile().fileName);
  const target = unit === undefined ? undefined : resolveFunction(program, unit, call.expression);
  return target?.kind === "function" ? replacementIn(program, target.named.node, Math.max(at, 0), followed) : [frontierAt(call, "interceptor")];
}

/** The call hands the request to the next handler: the forwarding parameter itself, or a method of it. */
function forwards(call: ts.CallExpression, forwarder: string | undefined): boolean {
  if (forwarder === undefined) return false;
  let callee = unwrap(call.expression);
  while (ts.isPropertyAccessExpression(callee)) callee = unwrap(callee.expression);
  return ts.isIdentifier(callee) && callee.text === forwarder;
}

/** A clone whose argument is an object that names neither a `body` nor a spread or computed key leaves the body as it was. */
function keepsBody(argument: ts.Expression): boolean {
  const bare = unwrap(argument);
  return ts.isObjectLiteralExpression(bare) && bare.properties.every((member) => !ts.isSpreadAssignment(member) && member.name !== undefined && propertyNameText(member.name) !== undefined && propertyNameText(member.name) !== "body");
}

function provides(registration: ts.ObjectLiteralExpression, token: string): boolean {
  return registration.properties.some((member) => ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === "provide" && ts.isIdentifier(member.initializer) && member.initializer.text === token);
}
