import type { Node } from "web-tree-sitter";
import { resolve } from "./java-declared-types.ts";
import { enclosingType, thisType } from "./java-project.ts";
import type { JavaFile, JavaProject, MethodDecl, TypeDecl } from "./java-symbols.ts";

/**
 * The types a function value may be converted to (ADR-0044 decision 5): a repository type, or `library` for a type the
 * repository does not declare, which is never below a repository type. `unsettled` when its context does not prove them.
 */
export type FunctionTargets = readonly (TypeDecl | "library")[] | "unsettled";

const UNSETTLED = "unsettled";
/** A function value as the parser names it, and the file whose names it is read in. */
export interface FunctionValue {
  file: JavaFile;
  node: Node;
}

/** What the reading takes from the hierarchy and the functional interfaces of the sources. */
export interface FunctionValueSources {
  project: JavaProject;
  /** The type and every repository type above it, or `undefined` when one of its supertypes is not a repository type. */
  ancestors(type: TypeDecl): readonly TypeDecl[] | undefined;
  /** The one abstract method of a functional repository interface; `undefined` when the sources do not settle it. */
  functionalMethod(type: TypeDecl): MethodDecl | undefined;
}

const COMMENTS: ReadonlySet<string> = new Set(["line_comment", "block_comment"]);
const TYPE_NAMES: ReadonlySet<string> = new Set(["type_identifier", "scoped_type_identifier", "generic_type"]);

/**
 * The target types of a function value from the context it stands in. Repository contexts only: a written declaration
 * type, a cast, a `return`, the arms of a conditional or switch, a value that is the result of another, and an argument
 * of a call of a repository method. Every other context, a library call included, is unsettled.
 */
export function targetsOfFunctionValue(value: FunctionValue, sources: FunctionValueSources): FunctionTargets {
  return targetsIn(value.node, value.file, sources);
}

function targetsIn(expression: Node, file: JavaFile, sources: FunctionValueSources): FunctionTargets {
  const parent = expression.parent;
  if (parent === null) return UNSETTLED;
  switch (parent.type) {
    case "parenthesized_expression":
      return targetsIn(parent, file, sources);
    case "ternary_expression":
      return targetsIn(parent, file, sources);
    case "expression_statement":
      return parent.parent?.type === "switch_rule" ? switchContext(parent, file, sources) : UNSETTLED;
    case "yield_statement":
      return switchContext(parent, file, sources);
    case "cast_expression":
      return parent.childForFieldName("value")?.id === expression.id ? union(parent.childrenForFieldName("type").map((type) => typeTargets(type, file, sources))) : UNSETTLED;
    case "variable_declarator":
      return declared(parent, expression, file, sources);
    case "return_statement":
      return returned(parent, file, sources);
    case "lambda_expression":
      return parent.childForFieldName("body")?.id === expression.id ? resultOf(targetsIn(parent, file, sources), sources) : UNSETTLED;
    case "argument_list":
      return argumentTargets(parent, expression, file, sources);
    default:
      return UNSETTLED;
  }
}

function switchContext(arm: Node, file: JavaFile, sources: FunctionValueSources): FunctionTargets {
  for (let scope = arm.parent; scope !== null; scope = scope.parent) if (scope.type === "switch_expression") return targetsIn(scope, file, sources);
  return UNSETTLED;
}

/** An initializer whose declaration writes its type; `var` writes none, which no name resolves. */
function declared(declarator: Node, expression: Node, file: JavaFile, sources: FunctionValueSources): FunctionTargets {
  const type = declarator.parent?.childForFieldName("type");
  if (declarator.childForFieldName("value")?.id !== expression.id || type === null || type === undefined) return UNSETTLED;
  return typeTargets(type, file, sources);
}

/** The written return type of the enclosing method, or the result type of the enclosing function value's target. */
function returned(statement: Node, file: JavaFile, sources: FunctionValueSources): FunctionTargets {
  for (let scope = statement.parent; scope !== null; scope = scope.parent) {
    if (scope.type === "lambda_expression") return resultOf(targetsIn(scope, file, sources), sources);
    if (scope.type === "method_declaration") {
      const type = scope.childForFieldName("type");
      return type === null ? UNSETTLED : typeTargets(type, file, sources);
    }
    if (scope.type === "constructor_declaration" || scope.type === "class_body" || scope.type === "interface_body") return UNSETTLED;
  }
  return UNSETTLED;
}

/**
 * The targets of the value a function value returns: the return type of the one abstract method of each target. A
 * library target has no declaration to read, so its result stays unsettled.
 */
function resultOf(outer: FunctionTargets, sources: FunctionValueSources): FunctionTargets {
  if (outer === UNSETTLED) return UNSETTLED;
  const results: FunctionTargets[] = [];
  for (const target of outer) {
    const method = target === "library" ? undefined : sources.functionalMethod(target);
    const type = method?.node.childForFieldName("type");
    if (method === undefined || type === null || type === undefined) return UNSETTLED;
    results.push(typeTargets(type, method.owner.file, sources));
  }
  return union(results);
}

/** A written type: a repository type, a library type, or unsettled for a type variable, a primitive, an array or a name the strict reading does not settle. */
function typeTargets(type: Node, file: JavaFile, sources: FunctionValueSources): FunctionTargets {
  if (!TYPE_NAMES.has(type.type)) return UNSETTLED;
  const resolved = resolve(type, file, sources.project, enclosingType(type, file, sources.project), type, true);
  if (resolved === undefined) return UNSETTLED;
  if (resolved.kind !== "repository") return ["library"];
  return resolved.type === undefined ? UNSETTLED : [resolved.type];
}

function union(parts: readonly FunctionTargets[]): FunctionTargets {
  const targets = new Set<TypeDecl | "library">();
  for (const part of parts) {
    if (part === UNSETTLED) return UNSETTLED;
    for (const target of part) targets.add(target);
  }
  return [...targets];
}

/**
 * An argument of a call of a method the enclosing types declare, written without a receiver or on `this`: the parameter
 * type at that position of every declaration of the name that the arity may select (JLS 15.12.2.1), found in the
 * innermost enclosing type that has a member of the name (JLS 15.12.1). Any other call is unsettled.
 */
function argumentTargets(list: Node, value: Node, file: JavaFile, sources: FunctionValueSources): FunctionTargets {
  const invocation = list.parent;
  const name = invocation?.childForFieldName("name")?.text;
  const object = invocation?.childForFieldName("object");
  if (invocation?.type !== "method_invocation" || name === undefined || (object !== null && object?.type !== "this")) return UNSETTLED;
  const arguments_ = list.namedChildren.filter((child): child is Node => child !== null && !COMMENTS.has(child.type));
  const position = arguments_.findIndex((argument) => argument.id === value.id);
  for (let type = thisType(invocation, file, sources.project); type !== undefined; type = type.outer) {
    const above = sources.ancestors(type);
    if (above === undefined) return UNSETTLED;
    const named = above.flatMap((ancestor) => ancestor.methods).filter((method) => method.name === name);
    if (named.length === 0) continue;
    if (named.some((method) => method.modifiers.includes("private") && method.owner !== type)) return UNSETTLED;
    const parameters = named.flatMap((method) => parameterAt(method, position, arguments_.length));
    return parameters.length === 0 ? UNSETTLED : union(parameters.map(({ method, type: written }) => typeTargets(written, method.owner.file, sources)));
  }
  return UNSETTLED;
}

/** The written type a call of `count` arguments passes its argument at `position` as, for a declaration its arity may select; none otherwise. */
function parameterAt(method: MethodDecl, position: number, count: number): { method: MethodDecl; type: Node }[] {
  const parameters = (method.node.childForFieldName("parameters")?.namedChildren ?? []).filter((parameter): parameter is Node => parameter !== null && (parameter.type === "formal_parameter" || parameter.type === "spread_parameter"));
  const last = parameters.at(-1);
  const variable = last?.type === "spread_parameter";
  if (!(variable ? count >= parameters.length - 1 : count === parameters.length)) return [];
  const parameter = variable && position >= parameters.length - 1 ? last : parameters[position];
  const type = parameter?.type === "spread_parameter" ? parameter.namedChildren[0] : parameter?.childForFieldName("type");
  return type === null || type === undefined ? [{ method, type: parameter ?? method.node }] : [{ method, type }];
}
