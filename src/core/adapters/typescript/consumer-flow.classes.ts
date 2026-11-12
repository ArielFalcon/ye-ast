import ts from "typescript";
import type { Program, Unit } from "./consumer-flow.index.ts";
import { declaringScope, namedFunction, propertyNameText, type NamedFunction } from "./consumer-flow.syntax.ts";
import { injectedClass } from "./angular-injection.ts";
import { constructorParameters, isStatic, thisClass, typeName, unwrapped } from "./syntax.ts";

/** A class of the snapshot with the unit that declares it. */
export interface ClassRef {
  unit: Unit;
  cls: ts.ClassDeclaration;
}

/** The class a name denotes in `unit`: one it declares, or one it imports from a file of the snapshot. */
export function classNamed(program: Program, unit: Unit, name: string): ClassRef | undefined {
  const local = unit.classes.get(name);
  if (local !== undefined) return { unit, cls: local };
  if (!unit.imports.has(name)) return undefined;
  const origin = program.index.origin(unit.file, name);
  if (origin === undefined || origin === "external") return undefined;
  const owner = program.index.units.get(origin.file);
  const cls = owner?.classes.get(origin.name);
  return owner === undefined || cls === undefined ? undefined : { unit: owner, cls };
}

/** The class a class extends, when its clause names a class of the snapshot. */
export function baseOf(program: Program, ref: ClassRef): ClassRef | undefined {
  const clause = ref.cls.heritageClauses?.find((candidate) => candidate.token === ts.SyntaxKind.ExtendsKeyword);
  const base = clause?.types[0]?.expression;
  return base !== undefined && ts.isIdentifier(base) ? classNamed(program, ref.unit, base.text) : undefined;
}

/** The class and the bases above it that resolve, nearest first, each once. */
export function lineage(program: Program, ref: ClassRef): ClassRef[] {
  const found: ClassRef[] = [];
  for (let current: ClassRef | undefined = ref; current !== undefined && !found.some((held) => held.cls === current!.cls); current = baseOf(program, current)) found.push(current);
  return found;
}

/** A key read from `Symbol` (`[Symbol.iterator]`) is a symbol, which no string name ever equals. */
function keyedBySymbol(name: ts.PropertyName): boolean {
  if (!ts.isComputedPropertyName(name)) return false;
  const key = unwrapped(name.expression);
  return ts.isPropertyAccessExpression(key) && ts.isIdentifier(key.expression) && key.expression.text === "Symbol";
}

/**
 * The declaration that may be the member `name` denotes. Names are the language's: `render`, `'render'` and `['render']`
 * are one; a name computed from anything else may denote any, so it is the declaration. Static members live on the
 * constructor: `statics` selects the side, and a member of the other side never answers.
 */
export function memberDeclaration(cls: ts.ClassLikeDeclaration, name: string, statics?: boolean): ts.ClassElement | ts.ParameterDeclaration | undefined {
  const named = cls.members.filter((member) => member.name !== undefined && (statics === undefined || isStatic(member) === statics));
  return (
    named.find((member) => propertyNameText(member.name!) === undefined && !keyedBySymbol(member.name!)) ??
    named.find((member) => propertyNameText(member.name!) === name) ??
    (statics !== true && ts.isClassDeclaration(cls) ? constructorParameters(cls).find((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name) : undefined)
  );
}

/** The method a class declares under `name` on its instances: a method, or a property initialized with a function. */
export function methodDeclared(cls: ts.ClassLikeDeclaration, name: string): NamedFunction | undefined {
  const member = memberDeclaration(cls, name, false);
  if (member === undefined || ts.isParameter(member) || member.name === undefined || propertyNameText(member.name) !== name) return undefined;
  const fn = ts.isMethodDeclaration(member) ? member : ts.isPropertyDeclaration(member) && member.initializer !== undefined && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer)) ? member.initializer : undefined;
  return fn === undefined ? undefined : namedFunction(fn);
}

/** The declared instance a member access reads, using the same receiver proof for local and cross-file flow. */
export function memberReceiver(program: Program, unit: Unit, access: ts.PropertyAccessExpression): ClassRef | undefined {
  const receiver = unwrapped(access.expression);
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return injectedInstance(program, unit, receiver);
  const cls = thisClass(access);
  const declared = cls?.name === undefined ? undefined : unit.classes.get(cls.name.text);
  return declared !== undefined && declared === cls ? { unit, cls: declared } : undefined;
}

/**
 * The class of the instance `receiver` denotes when the framework injects it: a field initialized by `inject(X)`, a
 * parameter property of a decorated class, or a local `const x = inject(X)`. A declared type alone is no provenance.
 */
export function injectedInstance(program: Program, unit: Unit, receiver: ts.Expression): ClassRef | undefined {
  const bare = unwrapped(receiver);
  let name: string | undefined;
  if (ts.isPropertyAccessExpression(bare) && bare.expression.kind === ts.SyntaxKind.ThisKeyword) name = injectedField(unit, thisClass(bare), bare.name.text);
  else if (ts.isIdentifier(bare)) name = injectedLocal(unit, bare);
  return name === undefined ? undefined : classNamed(program, unit, name);
}

function injectedField(unit: Unit, cls: ts.ClassLikeDeclaration | undefined, field: string): string | undefined {
  if (cls === undefined) return undefined;
  const property = cls.members.find((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === field);
  if (property !== undefined) return property.initializer === undefined ? undefined : injectedClass(property.initializer, unit);
  if (!ts.isClassDeclaration(cls) || !(ts.getDecorators(cls)?.length ?? 0)) return undefined;
  const parameter = constructorParameters(cls).find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === field && ts.isParameterPropertyDeclaration(candidate, candidate.parent));
  return parameter?.type === undefined ? undefined : typeName(parameter.type);
}

function injectedLocal(unit: Unit, identifier: ts.Identifier): string | undefined {
  const scope = declaringScope(identifier);
  const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) ? scope.statements : [];
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text && declaration.initializer !== undefined) return injectedClass(declaration.initializer, unit);
    }
  }
  return undefined;
}
