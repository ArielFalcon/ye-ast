import type { Node } from "web-tree-sitter";
import type { LibraryMember, LibraryReading, LibrarySignatures } from "../../ports/library-signatures.port.ts";
import { COMMENT_NODES, resolve, TYPE_NAMES } from "./java-declared-types.ts";
import { classHead, libraryClassOf, libraryParameterClasses, type LibraryCallSources } from "./java-library-calls.ts";
import { enclosingType, thisType } from "./java-project.ts";
import type { JavaFile, JavaProject, MethodDecl, TypeDecl } from "./java-symbols.ts";

/**
 * The types a function value may be converted to (ADR-0044 decision 5): a repository type, or `library` for a type the
 * repository does not declare, which is never below a repository type. `unsettled` when its context does not prove them.
 */
export type FunctionTargets = readonly (TypeDecl | "library")[] | "unsettled";

const UNSETTLED = "unsettled";

/** A library class a function value may be converted to; `written` is the generic type of the declaration that states it, whose type arguments substitute the class's type variables. */
interface LibraryTarget {
  library: string;
  written?: { node: Node; file: JavaFile };
}

type Target = TypeDecl | LibraryTarget;
type Targets = readonly Target[] | typeof UNSETTLED;
/** A function value as the parser names it, and the file whose names it is read in. */
export interface FunctionValue {
  file: JavaFile;
  node: Node;
}

/** What the reading takes from the hierarchy and the functional interfaces of the sources. */
export interface FunctionValueSources {
  project: JavaProject;
  /** The library signatures of the JDKs the host declared (ADR-0063); a library call is unsettled without them. */
  libraries?: LibraryReading;
  /** The type and every repository type above it, or `undefined` when one of its supertypes is not a repository type. */
  ancestors(type: TypeDecl): readonly TypeDecl[] | undefined;
  /** The type and every repository type above it, whatever else its supertypes include. */
  above(type: TypeDecl): readonly TypeDecl[];
  /** The one abstract method of a functional repository interface; `undefined` when the sources do not settle it. */
  functionalMethod(type: TypeDecl): MethodDecl | undefined;
}


/**
 * The target types of a function value from the context it stands in: a written declaration type, a cast, a `return`,
 * the arms of a conditional or switch, a value that is the result of another, and an argument of a call of a repository
 * method or, when the host declared a JDK for the file (ADR-0063), of a method of a library class that JDK holds. Every
 * other context is unsettled.
 */
export function targetsOfFunctionValue(value: FunctionValue, sources: FunctionValueSources): FunctionTargets {
  const targets = targetsIn(value.node, value.file, sources);
  return targets === UNSETTLED ? UNSETTLED : [...new Set(targets.map((target) => ("library" in target ? "library" : target)))];
}

function targetsIn(expression: Node, file: JavaFile, sources: FunctionValueSources): Targets {
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
      return parent.childForFieldName("body")?.id === expression.id ? resultOf(targetsIn(parent, file, sources), file, sources) : UNSETTLED;
    case "argument_list":
      return argumentTargets(parent, expression, file, sources);
    default:
      return UNSETTLED;
  }
}

function switchContext(arm: Node, file: JavaFile, sources: FunctionValueSources): Targets {
  for (let scope = arm.parent; scope !== null; scope = scope.parent) if (scope.type === "switch_expression") return targetsIn(scope, file, sources);
  return UNSETTLED;
}

/** An initializer whose declaration writes its type; `var` writes none, which no name resolves. */
function declared(declarator: Node, expression: Node, file: JavaFile, sources: FunctionValueSources): Targets {
  const type = declarator.parent?.childForFieldName("type");
  if (declarator.childForFieldName("value")?.id !== expression.id || type === null || type === undefined) return UNSETTLED;
  return typeTargets(type, file, sources);
}

/** The written return type of the enclosing method, or the result type of the enclosing function value's target. */
function returned(statement: Node, file: JavaFile, sources: FunctionValueSources): Targets {
  for (let scope = statement.parent; scope !== null; scope = scope.parent) {
    if (scope.type === "lambda_expression") return resultOf(targetsIn(scope, file, sources), file, sources);
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
 * library target's method is read from the declared JDK's signatures (`libraryResult`); without them it stays unsettled.
 */
function resultOf(outer: Targets, file: JavaFile, sources: FunctionValueSources): Targets {
  if (outer === UNSETTLED) return UNSETTLED;
  const results: Targets[] = [];
  for (const target of outer) {
    if ("library" in target) {
      results.push(libraryResult(target, file, sources));
      continue;
    }
    const method = sources.functionalMethod(target);
    const type = method?.node.childForFieldName("type");
    if (method === undefined || type === null || type === undefined) return UNSETTLED;
    results.push(typeTargets(type, method.owner.file, sources));
  }
  return union(results);
}

/**
 * The result type of the single abstract method a library interface declares itself (JLS 9.8; the default and static
 * members and `Object`'s public methods do not count): the type argument its written declaration states for a bare type
 * variable, or the raw class of any other result. Unsettled where the interface is not held, has another abstract
 * method or a default of the same name and arity, inherits the method, or is written without type arguments.
 */
function libraryResult(target: LibraryTarget, file: JavaFile, sources: FunctionValueSources): Targets {
  const signatures = librariesFor(file, sources)?.signatures;
  const type = signatures?.typeOf(target.library);
  const method = signatures === undefined || type?.kind !== "interface" ? undefined : functionalMember(target.library, signatures);
  if (type === undefined || method === undefined) return UNSETTLED;
  const variable = type.typeParameters.findIndex((parameter) => parameter.split(" ")[0] === method.returns);
  if (variable < 0) {
    const raw = classHead(method.returns);
    return raw === undefined ? UNSETTLED : [{ library: raw }];
  }
  const argument = target.written?.node.namedChildren.find((child) => child?.type === "type_arguments")?.namedChildren;
  const written = argument?.length === type.typeParameters.length ? argument[variable] : undefined;
  return written === null || written === undefined || target.written === undefined ? UNSETTLED : typeTargets(written, target.written.file, sources);
}

const OBJECT_MEMBERS: ReadonlySet<string> = new Set(["equals/1", "hashCode/0", "toString/0"]);

/** The one abstract member, by name and arity, of a library interface and the interfaces above it, when the interface declares it and no other declaration of the name and arity is concrete. */
function functionalMember(fqn: string, signatures: LibrarySignatures): LibraryMember | undefined {
  const declarations: { owner: string; key: string; member: LibraryMember }[] = [];
  const seen = new Set<string>();
  for (const pending = [fqn]; pending.length > 0; ) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const type = signatures.typeOf(current);
    if (type === undefined) return undefined;
    for (const member of type.members) if (!member.static) declarations.push({ owner: current, key: `${member.name}/${member.parameters.length}`, member });
    for (const supertype of type.supertypes) pending.push(classHead(supertype) ?? supertype);
  }
  const abstract = new Set(declarations.filter(({ key, member }) => member.abstract && !OBJECT_MEMBERS.has(key)).map(({ key }) => key));
  const [key] = abstract;
  if (abstract.size !== 1 || key === undefined) return undefined;
  const named = declarations.filter((declaration) => declaration.key === key);
  const own = named.filter(({ owner }) => owner === fqn);
  return named.every(({ member }) => member.abstract) && own.length === 1 ? own[0]!.member : undefined;
}

/** The library signatures of the JDK declared for the file, as the library readers take them. */
function librariesFor(file: JavaFile, sources: FunctionValueSources): LibraryCallSources | undefined {
  const signatures = sources.libraries?.of(file.path);
  return signatures === undefined ? undefined : { project: sources.project, signatures, ancestors: sources.ancestors, above: sources.above };
}

/** A written type: a repository type, a library class, or unsettled for a type variable, a primitive, an array or a name the strict reading does not settle. */
function typeTargets(type: Node, file: JavaFile, sources: FunctionValueSources): Targets {
  if (!TYPE_NAMES.has(type.type)) return UNSETTLED;
  const resolved = resolve(type, file, sources.project, enclosingType(type, file, sources.project), type, true);
  const written = type.type === "generic_type" ? { node: type, file } : undefined;
  if (resolved === undefined) {
    const libraries = librariesFor(file, sources);
    const fqn = libraries === undefined ? undefined : libraryClassOf(type, file, libraries);
    return fqn === undefined ? UNSETTLED : [{ library: fqn, ...(written === undefined ? {} : { written }) }];
  }
  if (resolved.kind !== "repository") return [{ library: resolved.fqn, ...(written === undefined ? {} : { written }) }];
  return resolved.type === undefined ? UNSETTLED : [resolved.type];
}

function union(parts: readonly Targets[]): Targets {
  const targets = new Set<Target>();
  for (const part of parts) {
    if (part === UNSETTLED) return UNSETTLED;
    for (const target of part) targets.add(target);
  }
  return [...targets];
}

/**
 * An argument of a call of a method the enclosing types declare, written without a receiver or on `this`: the parameter
 * type at that position of every declaration of the name that the arity may select (JLS 15.12.2.1), found in the
 * innermost enclosing type that has a member of the name (JLS 15.12.1). A call on another receiver is read in the
 * declared JDK's signatures (`libraryParameterClasses`); without one, or any other call, it is unsettled.
 */
function argumentTargets(list: Node, value: Node, file: JavaFile, sources: FunctionValueSources): Targets {
  const invocation = list.parent;
  const name = invocation?.childForFieldName("name")?.text;
  const object = invocation?.childForFieldName("object");
  if (invocation?.type !== "method_invocation" || name === undefined) return UNSETTLED;
  const arguments_ = list.namedChildren.filter((child): child is Node => child !== null && !COMMENT_NODES.has(child.type));
  const position = arguments_.findIndex((argument) => argument.id === value.id);
  if (object !== null && object?.type !== "this") {
    const libraries = librariesFor(file, sources);
    const classes = libraries === undefined ? undefined : libraryParameterClasses(invocation, position, file, libraries);
    return classes === undefined ? UNSETTLED : classes.map((library) => ({ library }));
  }
  for (let type = thisType(invocation, file, sources.project); type !== undefined; type = type.outer) {
    const above = sources.ancestors(type);
    if (above === undefined) return UNSETTLED;
    const named = above.flatMap((ancestor) => ancestor.methods).filter((method) => method.name === name);
    if (named.length === 0) continue;
    if (named.some((method) => method.modifiers.includes("private") && method.owner !== type)) return UNSETTLED;
    const parameters = named.flatMap((method) => declaredParameterAt(method, position, arguments_.length));
    return parameters.length === 0 ? UNSETTLED : union(parameters.map(({ method, type: written }) => typeTargets(written, method.owner.file, sources)));
  }
  return UNSETTLED;
}

/** The written type a call of `count` arguments passes its argument at `position` as, for a declaration its arity may select; none otherwise. */
function declaredParameterAt(method: MethodDecl, position: number, count: number): { method: MethodDecl; type: Node }[] {
  const parameters = (method.node.childForFieldName("parameters")?.namedChildren ?? []).filter((parameter): parameter is Node => parameter !== null && (parameter.type === "formal_parameter" || parameter.type === "spread_parameter"));
  const last = parameters.at(-1);
  const variable = last?.type === "spread_parameter";
  if (!(variable ? count >= parameters.length - 1 : count === parameters.length)) return [];
  const parameter = variable && position >= parameters.length - 1 ? last : parameters[position];
  const type = parameter?.type === "spread_parameter" ? parameter.namedChildren[0] : parameter?.childForFieldName("type");
  return type === null || type === undefined ? [{ method, type: parameter ?? method.node }] : [{ method, type }];
}
