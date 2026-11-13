import type { Node } from "web-tree-sitter";
import type { LibraryMember, LibrarySignatures } from "../../ports/library-signatures.port.ts";
import { typeVariableAround } from "../tree-sitter/java-declared-variables.ts";
import { fieldsOf } from "../tree-sitter/java-function-value-calls.ts";
import { COMMENT_NODES, resolve, TYPE_NAMES } from "./java-declared-types.ts";
import { classHead, parseTypeText, typeParameterName, type TypeText } from "./java-library-type-text.ts";
import { enclosingType, thisType } from "./java-project.ts";
import { OBJECT_METHODS } from "./java-receiver-methods.ts";
import type { JavaFile, JavaProject, TypeDecl } from "./java-symbols.ts";

export { classHead };

/** What a library call reads from the sources it stands in, and the signatures of the JDK declared for its file. */
export interface LibraryCallSources {
  project: JavaProject;
  signatures: LibrarySignatures;
  /** The type and every repository type above it, or `undefined` when one of its supertypes is not a repository type. */
  ancestors(type: TypeDecl): readonly TypeDecl[] | undefined;
  /** The type and every repository type above it, whatever else its supertypes include. */
  above(type: TypeDecl): readonly TypeDecl[];
}

/**
 * The class an expression is an instance of, as a declaration states it: a library class (`typeName` when the
 * expression names the class; `args` the type arguments its declaration states, `undefined` where one is not settled) or
 * a repository type.
 */
type Receiver = { kind: "library"; fqn: string; typeName: boolean; args?: readonly (Receiver | undefined)[] } | { kind: "repository"; type: TypeDecl };

type Environment = ReadonlyMap<string, Receiver | undefined>;

const TYPE_BODIES: ReadonlySet<string> = new Set(["class_body", "interface_body", "enum_body"]);
const QUALIFIED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const PACKAGE_SEGMENT = /^[a-z]/;
const OBJECT = "java.lang.Object";
/** Nodes under which an identifier other than a pattern's first operand binds a variable. */
const PATTERNS: ReadonlySet<string> = new Set(["instanceof_expression", "type_pattern", "record_pattern_component", "record_pattern"]);

/**
 * The library classes the value at `position` of a call of `count` arguments may be converted to (ADR-0044 decision 5,
 * ADR-0063): the raw class of the parameter at that position of every member of the receiver's class and its
 * supertypes that the name and arity may select. `undefined` unless the receiver, every candidate and each parameter
 * are settled: a parameter that is a type variable, an array or a primitive, a receiver that is not a library class
 * the declared JDK holds, or a type above it that it does not hold, leaves the value unsettled.
 */
export function libraryParameterClasses(invocation: Node, position: number, file: JavaFile, sources: LibraryCallSources): readonly string[] | undefined {
  const name = invocation.childForFieldName("name")?.text;
  const object = invocation.childForFieldName("object");
  if (name === undefined || object === null) return undefined;
  const receiver = receiverOf(object, file, sources);
  if (receiver?.kind !== "library") return undefined;
  const candidates = candidatesOf(receiver, name, argumentsOf(invocation), file, sources);
  if (candidates === undefined || candidates.length === 0) return undefined;
  const classes = new Set<string>();
  for (const { member } of candidates) {
    const head = classHead(parameterTypeAt(member, position));
    if (head === undefined) return undefined;
    classes.add(head);
  }
  return [...classes].sort();
}

/**
 * The library class a written type or a name denotes, when the declared JDK holds it: a qualified name, a single-type
 * import, `java.lang` or an on-demand import. A name no declaration of the repository binds is assumed not to be
 * redefined by a supertype outside the repository (ADR-0064), and an on-demand name is the one type exactly one package
 * offers (ADR-0062 decision 1). Any other name is not read.
 */
export function libraryClassOf(type: Node, file: JavaFile, sources: LibraryCallSources): string | undefined {
  if (!TYPE_NAMES.has(type.type) && type.type !== "identifier") return undefined;
  const { project, signatures } = sources;
  const written = (type.type === "generic_type" ? type.namedChildren[0] : type)?.text.replace(/\s+/g, "") ?? "";
  if (!QUALIFIED.test(written)) return undefined;
  const [head = "", ...rest] = written.split(".");
  if (head === "var" || typeVariableAround(type, head) !== undefined) return undefined;
  const scope = enclosingType(type, file, project);
  if (PACKAGE_SEGMENT.test(head)) {
    const resolved = resolve(type, file, project, scope, type, true);
    return resolved === undefined || resolved.kind === "repository" || signatures.typeOf(resolved.fqn) === undefined ? undefined : resolved.fqn;
  }
  const origin = project.importedTypeSources(head, { file, type: scope, at: type });
  if (origin === undefined) return undefined;
  const named = "imported" in origin ? [[origin.imported, ...rest].join(".")] : [...new Set(origin.containers)].map((container) => [container, head, ...rest].join("."));
  const held = named.filter((fqn) => signatures.typeOf(fqn) !== undefined);
  return held.length === 1 ? held[0] : undefined;
}

function argumentsOf(invocation: Node): Node[] {
  return (invocation.childForFieldName("arguments")?.namedChildren ?? []).filter((child): child is Node => child !== null && !COMMENT_NODES.has(child.type));
}

/** The type of the parameter a value at `position` is passed as; a variable-arity method passes the rest as its element type. */
function parameterTypeAt(member: LibraryMember, position: number): string {
  const last = member.parameters.length - 1;
  return member.varargs && position >= last ? (member.parameters[last] ?? "").replace(/\[\]$/, "") : (member.parameters[position] ?? "");
}

interface Candidate {
  member: LibraryMember;
  /** The type variables in scope at the member: the declaring type's, as the receiver's type arguments give them, and the member's own. */
  environment: Environment;
}

/**
 * Every member named `name` that a call with these arguments may select in the class and the types above it (JLS
 * 15.12.2.1): fixed arity, or variable arity from one argument fewer than the parameters. A class is inherited through
 * its superclasses and interfaces, an interface's static members only by the interface itself (JLS 8.4.8, 9.4.1), and a
 * class name selects static members only. The type variables of each declaring type are substituted from the receiver's
 * type arguments through the supertypes' (JLS 4.5.2), and a member's own from its arguments when a parameter is
 * exactly that variable. `undefined` when a type of the closure is not held.
 */
function candidatesOf(receiver: Extract<Receiver, { kind: "library" }>, name: string, args: readonly Node[], file: JavaFile, sources: LibraryCallSources): Candidate[] | undefined {
  const { signatures } = sources;
  const found: Candidate[] = [];
  const seen = new Set<string>();
  const pending: { fqn: string; environment: Environment }[] = [{ fqn: receiver.fqn, environment: environmentOf(receiver.fqn, receiver.args, signatures) }, { fqn: OBJECT, environment: new Map() }];
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const key = `${next.fqn}|${[...next.environment].map(([variable, bound]) => `${variable}=${keyOf(bound)}`).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const type = signatures.typeOf(next.fqn);
    if (type === undefined) return undefined;
    const inherited = next.fqn !== receiver.fqn && (type.kind === "interface" || type.kind === "annotation");
    for (const member of type.members) {
      const applies = member.parameters.length === args.length || (member.varargs && args.length >= member.parameters.length - 1);
      if (member.name === name && applies && (member.static || !receiver.typeName) && !(member.static && inherited)) {
        found.push({ member, environment: withMemberVariables(member, next.environment, args, file, sources) });
      }
    }
    for (const supertype of type.supertypes) {
      const parsed = parseTypeText(supertype);
      if (parsed.kind !== "class") return undefined;
      pending.push({ fqn: parsed.name, environment: environmentOf(parsed.name, parsed.args.map((argument) => receiverFromText(argument, next.environment)), signatures) });
    }
  }
  return found;
}

/** The type variables of a type bound to the arguments a use of it states; every one unknown unless there is one argument per variable. */
function environmentOf(fqn: string, args: readonly (Receiver | undefined)[] | undefined, signatures: LibrarySignatures): Environment {
  const names = (signatures.typeOf(fqn)?.typeParameters ?? []).map(typeParameterName);
  return new Map(names.map((variable, index) => [variable, args?.length === names.length ? args[index] : undefined]));
}

/** A member's own type variables, each the type of the arguments passed as a parameter of exactly that variable, and unknown where those disagree or there is none. */
function withMemberVariables(member: LibraryMember, environment: Environment, args: readonly Node[], file: JavaFile, sources: LibraryCallSources): Environment {
  const own = new Set(member.typeParameters.map(typeParameterName));
  const inferred = new Map<string, Receiver | undefined>();
  const conflicting = new Set<string>();
  member.parameters.forEach((parameter, index) => {
    const parsed = parseTypeText(parameter);
    const argument = args[index];
    if (parsed.kind !== "variable" || !own.has(parsed.name) || argument === undefined || (member.varargs && index === member.parameters.length - 1)) return;
    const typed = receiverOf(argument, file, sources);
    const stated = typed?.kind === "library" && typed.typeName ? undefined : typed;
    if (!inferred.has(parsed.name)) inferred.set(parsed.name, stated);
    else if (keyOf(inferred.get(parsed.name)) !== keyOf(stated)) conflicting.add(parsed.name);
  });
  const merged = new Map(environment);
  for (const variable of own) merged.set(variable, conflicting.has(variable) ? undefined : inferred.get(variable));
  return merged;
}

function receiverFromText(text: TypeText | "wildcard", environment: Environment): Receiver | undefined {
  if (text === "wildcard" || text.kind === "other") return undefined;
  if (text.kind === "variable") return environment.get(text.name);
  return { kind: "library", fqn: text.name, typeName: false, ...(text.args.length === 0 ? {} : { args: text.args.map((argument) => receiverFromText(argument, environment)) }) };
}

function keyOf(receiver: Receiver | undefined): string {
  if (receiver === undefined) return "?";
  if (receiver.kind === "repository") return `#${receiver.type.file.path}:${receiver.type.fqn}`;
  return `${receiver.fqn}${receiver.args === undefined ? "" : `<${receiver.args.map(keyOf).join(",")}>`}`;
}

function receiverOf(expression: Node, file: JavaFile, sources: LibraryCallSources): Receiver | undefined {
  switch (expression.type) {
    case "parenthesized_expression":
      return expression.namedChildren[0] === null || expression.namedChildren[0] === undefined ? undefined : receiverOf(expression.namedChildren[0], file, sources);
    case "cast_expression": {
      const types = expression.childrenForFieldName("type");
      return types.length === 1 ? writtenType(types[0]!, file, sources) : undefined;
    }
    case "object_creation_expression": {
      const type = expression.childForFieldName("type");
      return type === null || expression.namedChildren.some((child) => child?.type === "class_body") || expression.childForFieldName("object") !== null ? undefined : writtenType(type, file, sources);
    }
    case "identifier":
      return variableOrTypeName(expression, file, sources);
    case "field_access":
      return expression.childForFieldName("object")?.type === "this" ? fieldReceiver(expression, expression.childForFieldName("field")?.text, file, sources) : undefined;
    case "method_invocation":
      return chainOf(expression, file, sources);
    default:
      return undefined;
  }
}

function writtenType(type: Node, file: JavaFile, sources: LibraryCallSources): Receiver | undefined {
  if (!TYPE_NAMES.has(type.type)) return undefined;
  const { project, signatures } = sources;
  const resolved = resolve(type, file, project, enclosingType(type, file, project), type, true);
  if (resolved?.kind === "repository") return resolved.type === undefined ? undefined : { kind: "repository", type: resolved.type };
  const fqn = libraryClassOf(type, file, sources);
  if (fqn === undefined) return undefined;
  const stated = type.type === "generic_type" ? type.namedChildren.find((child) => child?.type === "type_arguments")?.namedChildren : undefined;
  const variables = signatures.typeOf(fqn)?.typeParameters.length;
  const args = stated === undefined || stated.length !== variables ? undefined : stated.map((argument) => (argument === null ? undefined : writtenType(argument, file, sources)));
  return { kind: "library", fqn, typeName: false, ...(args === undefined ? {} : { args }) };
}

function agreed(receivers: readonly (Receiver | undefined)[]): Receiver | undefined {
  const [first] = receivers;
  if (first === undefined) return undefined;
  if (receivers.every((receiver) => keyOf(receiver) === keyOf(first))) return first;
  const raw = receivers.every((receiver) => receiver?.kind === "library" && first.kind === "library" && receiver.fqn === first.fqn);
  return raw && first.kind === "library" ? { kind: "library", fqn: first.fqn, typeName: false } : undefined;
}

/** A variable the name denotes at its use, by the declarations whose scope holds the use; the class a bare name that no variable can denote names. */
function variableOrTypeName(identifier: Node, file: JavaFile, sources: LibraryCallSources): Receiver | undefined {
  const member = memberAround(identifier);
  if (member === undefined) return undefined;
  const declared = declarationsOf(member, identifier.text);
  const visible = declared.filter(({ scope, end }) => scope.startIndex <= identifier.startIndex && identifier.endIndex <= scope.endIndex && end <= identifier.startIndex);
  if (visible.some(({ type }) => type === undefined)) return undefined;
  if (visible.length > 0) return agreed(visible.map(({ type }) => writtenType(type!, file, sources)));
  const field = fieldReceiver(identifier, identifier.text, file, sources);
  if (field !== undefined) return field;
  if (declared.length > 0 || declaresFieldAround(identifier, file, sources)) return undefined;
  const fqn = libraryClassOf(identifier, file, sources);
  return fqn === undefined ? undefined : { kind: "library", fqn, typeName: true };
}

/** Whether a type around the use, or a repository type above it, declares a field of the name. Fields a supertype outside the repository declares are not read (ADR-0064). */
function declaresFieldAround(identifier: Node, file: JavaFile, sources: LibraryCallSources): boolean {
  const first = thisType(identifier, file, sources.project);
  if (first === undefined) return true;
  for (let type: TypeDecl | undefined = first; type !== undefined; type = type.outer) if (sources.above(type).some((ancestor) => declaredField(ancestor, identifier.text) !== undefined)) return true;
  return false;
}

/** The field of the innermost enclosing type that declares or inherits the name, through the types around the use. */
function fieldReceiver(at: Node, name: string | undefined, file: JavaFile, sources: LibraryCallSources): Receiver | undefined {
  if (name === undefined) return undefined;
  for (let type = thisType(at, file, sources.project); type !== undefined; type = type.outer) {
    const own = declaredField(type, name);
    if (own !== undefined) return own === "untyped" ? undefined : writtenType(own, type.file, sources);
    const above = sources.ancestors(type);
    if (above === undefined || above.some((ancestor) => declaredField(ancestor, name) !== undefined)) return undefined;
  }
  return undefined;
}

/** The written type of a record's component of the name. */
function componentOf(type: TypeDecl, name: string): Node | undefined {
  const components = type.node.childForFieldName("parameters")?.namedChildren ?? [];
  return components.find((component) => component?.childForFieldName("name")?.text === name)?.childForFieldName("type") ?? undefined;
}

/** The written type of the field or record component a type declares under the name; `untyped` for a declaration that states none. */
function declaredField(type: TypeDecl, name: string): Node | "untyped" | undefined {
  const body = type.node.childForFieldName("body");
  const component = componentOf(type, name);
  if (component !== undefined) return component;
  if ((type.node.childForFieldName("parameters")?.namedChildren ?? []).some((candidate) => candidate?.childForFieldName("name")?.text === name)) return "untyped";
  for (const field of body === null ? [] : fieldsOf(body)) {
    if (field.childForFieldName("name")?.text !== name) continue;
    const written = field.parent?.childForFieldName("type");
    return written === null || written === undefined || field.childForFieldName("dimensions") !== null ? "untyped" : written;
  }
  return undefined;
}

/** The member of the enclosing type body that holds the node. */
function memberAround(node: Node): Node | undefined {
  for (let scope: Node | null = node; scope?.parent != null; scope = scope.parent) if (TYPE_BODIES.has(scope.parent.type)) return scope;
  return undefined;
}

interface Declaration {
  /** The written type, or `undefined` when the declaration states none (`var`, an inferred lambda parameter, a pattern). */
  type: Node | undefined;
  /** The node in which the declared name is in scope. */
  scope: Node;
  /** Where the declaration ends: a name is in scope after it. */
  end: number;
}

/**
 * Every declaration of the name in the member, outside the member's own fields, with the node its scope is (JLS 6.3):
 * a local (the rest of its block, and of the whole switch block for a local of a switch group), a parameter (its
 * method, constructor or lambda), a `for` or enhanced-`for` variable, a resource, a catch parameter and a lambda
 * parameter. A pattern variable's scope follows the flow of the conditions around it, so any pattern binding of the name
 * (an `instanceof` binding is a bare identifier in the grammar, a switch or record pattern a `type_pattern` or
 * `record_pattern_component`) holds the whole member and states no type.
 */
function declarationsOf(member: Node, name: string): Declaration[] {
  const found: Declaration[] = [];
  const pending: Node[] = [member];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const parent = node.parent;
    const named = node.childForFieldName("name")?.text === name;
    if (node.type === "variable_declarator" && named && parent !== null) {
      if (parent.type === "local_variable_declaration") found.push({ type: node.childForFieldName("dimensions") === null ? written(parent.childForFieldName("type")) : undefined, scope: localScope(parent, member), end: node.endIndex });
      else if (parent.type === "spread_parameter") found.push({ type: undefined, scope: parent.parent?.parent ?? member, end: node.endIndex });
    } else if (node.type === "formal_parameter" && named && parent?.parent != null) {
      found.push({ type: node.childForFieldName("dimensions") === null ? written(node.childForFieldName("type")) : undefined, scope: parent.parent, end: node.endIndex });
    } else if (node.type === "catch_formal_parameter" && named && parent !== null) {
      found.push({ type: undefined, scope: parent, end: node.endIndex });
    } else if (node.type === "resource" && named && parent?.parent != null) {
      found.push({ type: undefined, scope: parent.parent, end: node.endIndex });
    } else if (node.type === "enhanced_for_statement" && named) {
      found.push({ type: node.childForFieldName("dimensions") === null ? written(node.childForFieldName("type")) : undefined, scope: node, end: node.childForFieldName("value")?.endIndex ?? node.endIndex });
    } else if (node.type === "identifier" && node.text === name && parent !== null) {
      if (parent.type === "inferred_parameters" || (parent.type === "lambda_expression" && parent.childForFieldName("parameters")?.id === node.id)) {
        found.push({ type: undefined, scope: parent.type === "inferred_parameters" ? parent.parent ?? member : parent, end: node.endIndex });
      } else if (PATTERNS.has(parent.type) && !(parent.type === "instanceof_expression" && parent.namedChildren[0]?.id === node.id)) {
        found.push({ type: undefined, scope: member, end: -1 });
      }
    }
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return found;
}

/** The node a local's name is in scope in: its block, and the whole switch block for a local of a switch group (JLS 6.3). */
function localScope(declaration: Node, member: Node): Node {
  const block = declaration.parent;
  return block?.type === "switch_block_statement_group" ? block.parent ?? block : block ?? member;
}

/** A written type, never `var`. */
function written(type: Node | null): Node | undefined {
  return type === null || type.text === "var" ? undefined : type;
}

/** `a.m(..)` and `m(..)`: the class of the one type every candidate declaration of the name and arity returns. */
function chainOf(invocation: Node, file: JavaFile, sources: LibraryCallSources): Receiver | undefined {
  const name = invocation.childForFieldName("name")?.text;
  const object = invocation.childForFieldName("object");
  const args = argumentsOf(invocation);
  if (name === undefined || OBJECT_METHODS.has(name)) return undefined;
  const receiver = object === null || object.type === "this" ? undefined : receiverOf(object, file, sources);
  if (receiver?.kind === "library") {
    const candidates = candidatesOf(receiver, name, args, file, sources);
    if (candidates === undefined || candidates.length === 0) return undefined;
    return agreed(candidates.map(({ member, environment }) => receiverFromText(parseTypeText(member.returns), environment)));
  }
  const returns = receiver?.kind === "repository" ? declared(receiver.type, name, args.length, sources) : object === null || object.type === "this" ? unqualified(invocation, name, args.length, file, sources) : undefined;
  return returns === undefined ? undefined : agreed(returns.map(({ type, file: declaring }) => writtenType(type, declaring, sources)));
}

/** A written return type and the file whose names it is read in. */
interface WrittenReturn {
  type: Node;
  file: JavaFile;
}

/**
 * The return types of the methods of the name and arity of a repository type and the types above it, and of the
 * accessor a record states for a component no method of its name replaces; `undefined` when a supertype is outside the
 * repository, a method of the name is variable-arity, or none is declared.
 */
function declared(type: TypeDecl, name: string, count: number, sources: LibraryCallSources): WrittenReturn[] | undefined {
  const above = sources.ancestors(type);
  if (above === undefined) return undefined;
  const named = above.flatMap((ancestor) => ancestor.methods).filter((method) => method.name === name);
  if (named.some((method) => method.parameterTypes.length !== count && (method.node.childForFieldName("parameters")?.namedChildren ?? []).some((parameter) => parameter?.type === "spread_parameter"))) return undefined;
  const selected = named.filter((method) => method.parameterTypes.length === count);
  if (selected.length > 0) {
    const returns = selected.map((method) => ({ type: method.node.childForFieldName("type"), file: method.owner.file }));
    return returns.every((entry): entry is WrittenReturn => entry.type !== null) ? returns : undefined;
  }
  const component = type.node.type === "record_declaration" && count === 0 && named.length === 0 ? componentOf(type, name) : undefined;
  return component === undefined ? undefined : [{ type: component, file: type.file }];
}

/** A call without a receiver: the return types of the innermost enclosing type that has a member of the name (JLS 15.12.1). */
function unqualified(invocation: Node, name: string, count: number, file: JavaFile, sources: LibraryCallSources): WrittenReturn[] | undefined {
  for (let type = thisType(invocation, file, sources.project); type !== undefined; type = type.outer) {
    const above = sources.ancestors(type);
    if (above === undefined) return undefined;
    if (above.some((ancestor) => ancestor.methods.some((method) => method.name === name))) return declared(type, name, count, sources);
  }
  return undefined;
}
