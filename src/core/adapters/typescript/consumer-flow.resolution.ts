import ts from "typescript";
import type { Origin, Program, Unit } from "./consumer-flow.index.ts";
import { methodDeclared } from "./consumer-flow.classes.ts";
import { injectedClass } from "./angular-injection.ts";
import { declaringScope, isDynamicName, isFunctionNode, namedFunction, type NamedFunction } from "./consumer-flow.syntax.ts";
import { constructorParameters, thisClass, typeName, unwrapped } from "./syntax.ts";

export type Resolved = { kind: "function"; file: string; named: NamedFunction } | { kind: "external" };

/**
 * The function a call's callee denotes: a function of the file, an imported one, a method of the class around the call
 * or of the class its receiver is an instance of. `external` is a function of a package; undefined is a callee the
 * snapshot does not let the reader tell.
 */
export function resolveFunction(program: Program, unit: Unit, callee: ts.Expression): Resolved | undefined {
  const expression = unwrapped(callee);
  if (ts.isIdentifier(expression)) return functionNamed(program, unit, expression);
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const cls = thisClass(expression);
  const receiver = unwrapped(expression.expression);
  if (cls === undefined) return undefined;
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return methodOf(unit.file, cls, expression.name.text);
  const className = receiverClass(unit, receiver, cls);
  if (className === undefined) return undefined;
  const owner = unit.classes.get(className);
  if (owner !== undefined) return methodOf(unit.file, owner, expression.name.text);
  const origin = unit.imports.has(className) ? program.index.origin(unit.file, className) : undefined;
  return methodFromOrigin(program, origin, expression.name.text);
}

function methodFromOrigin(program: Program, origin: Origin, method: string): Resolved | undefined {
  if (origin === "external") return { kind: "external" };
  const unit = origin === undefined ? undefined : program.index.units.get(origin.file);
  const cls = origin === undefined ? undefined : unit?.classes.get(origin.name);
  return unit === undefined || cls === undefined ? undefined : methodOf(unit.file, cls, method);
}

function functionNamed(program: Program, unit: Unit, identifier: ts.Identifier): Resolved | undefined {
  if (isDynamicName(identifier)) return undefined;
  const name = identifier.text;
  const scope = declaringScope(identifier);
  if (scope !== unit.tree) return localFunction(unit, scope, name);
  const local = unit.functions.get(name);
  if (local !== undefined) return { kind: "function", file: unit.file, named: local };
  if (!unit.imports.has(name)) return undefined;
  const origin = program.index.origin(unit.file, name);
  if (origin === "external") return { kind: "external" };
  const named = origin === undefined ? undefined : program.index.units.get(origin.file)?.functions.get(origin.name);
  return origin === undefined || named === undefined ? undefined : { kind: "function", file: origin.file, named };
}

/** The function a name declares in a block, or undefined when it is a parameter or a variable holding something else. */
function localFunction(unit: Unit, scope: ts.Node, name: string): Resolved | undefined {
  const statements = ts.isCaseBlock(scope) ? scope.clauses.flatMap((clause) => clause.statements) : ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined;
  for (const statement of statements ?? []) {
    const declared = ts.isFunctionDeclaration(statement) ? [statement] : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((declaration) => declaration.initializer) : [];
    for (const candidate of declared) {
      const named = candidate !== undefined && isFunctionNode(candidate) ? namedFunction(candidate) : undefined;
      if (named?.name === name) return { kind: "function", file: unit.file, named };
    }
  }
  return undefined;
}

function methodOf(file: string, cls: ts.ClassLikeDeclaration, name: string): Resolved | undefined {
  const named = methodDeclared(cls, name);
  return named === undefined ? undefined : { kind: "function", file, named };
}

/** The class a receiver is an instance of: a field or constructor parameter of the class that holds it by type or `inject(X)`. */
function receiverClass(unit: Unit, receiver: ts.Expression, cls: ts.ClassLikeDeclaration): string | undefined {
  const name = ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword ? receiver.name.text : ts.isIdentifier(receiver) ? receiver.text : undefined;
  if (name === undefined) return undefined;
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name) {
      const injected = member.initializer === undefined ? undefined : injectedClass(member.initializer, unit);
      return injected ?? (member.type === undefined ? undefined : typeName(member.type));
    }
  }
  if (!ts.isClassDeclaration(cls)) return undefined;
  const parameter = constructorParameters(cls).find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  return parameter?.type === undefined ? undefined : typeName(parameter.type);
}
