import type { Node } from "web-tree-sitter";
import type { LibraryMember, LibrarySignatures } from "../../ports/library-signatures.port.ts";
import { typeVariableAround } from "../tree-sitter/java-declared-variables.ts";
import { fieldsOf } from "../tree-sitter/java-function-value-calls.ts";
import { resolve } from "./java-declared-types.ts";
import { enclosingType, thisType } from "./java-project.ts";
import type { JavaFile, JavaProject, TypeDecl } from "./java-symbols.ts";

/** What a library call reads from the sources it stands in, and the signatures of the JDK declared for its file. */
export interface LibraryCallSources {
  project: JavaProject;
  signatures: LibrarySignatures;
  /** The type and every repository type above it, or `undefined` when one of its supertypes is not a repository type. */
  ancestors(type: TypeDecl): readonly TypeDecl[] | undefined;
}

/** The class an expression is an instance of, as a declaration states it: a library class (`typeName` when the expression names the class) or a repository type. */
type Receiver = { kind: "library"; fqn: string; typeName: boolean } | { kind: "repository"; type: TypeDecl };

const TYPE_NAMES: ReadonlySet<string> = new Set(["type_identifier", "scoped_type_identifier", "generic_type"]);
const TYPE_BODIES: ReadonlySet<string> = new Set(["class_body", "interface_body", "enum_body"]);
const QUALIFIED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const PACKAGE_SEGMENT = /^[a-z]/;
/** The members `Object` gives every type; a repository method of one of these names may be an overload of it. */
const OBJECT_METHODS: ReadonlySet<string> = new Set(["clone", "equals", "finalize", "getClass", "hashCode", "notify", "notifyAll", "toString", "wait"]);
const OBJECT = "java.lang.Object";
/** Nodes the grammar places among a call's arguments that are no argument. */
const COMMENTS: ReadonlySet<string> = new Set(["line_comment", "block_comment"]);
const PATTERNS: ReadonlySet<string> = new Set(["type_pattern", "record_pattern_component", "record_pattern"]);

/**
 * The library classes the value at `position` of a call of `count` arguments may be converted to (ADR-0044 decision 5,
 * ADR-0063): the raw class of the parameter at that position of every member of the receiver's class and its
 * supertypes that the name and arity may select. `undefined` unless the receiver, every candidate and each parameter
 * are settled: a parameter that is a type variable, an array or a primitive, a receiver that is not a library class
 * the declared JDK holds, or a type above it that it does not hold, leaves the value unsettled.
 */
export function libraryParameterClasses(invocation: Node, position: number, count: number, file: JavaFile, sources: LibraryCallSources): readonly string[] | undefined {
  const name = invocation.childForFieldName("name")?.text;
  const object = invocation.childForFieldName("object");
  if (name === undefined || object === null) return undefined;
  const receiver = receiverOf(object, file, sources);
  if (receiver?.kind !== "library") return undefined;
  const members = membersOf(receiver, name, count, sources.signatures);
  if (members === undefined || members.length === 0) return undefined;
  const classes = new Set<string>();
  for (const member of members) {
    const head = classHead(parameterAt(member, position));
    if (head === undefined) return undefined;
    classes.add(head);
  }
  return [...classes].sort();
}

/** The library class a written type or a name denotes, when the declared JDK holds it: through the strict resolver, then the on-demand imports and `java.lang` (ADR-0062 decision 1). */
export function libraryClassOf(type: Node, file: JavaFile, sources: LibraryCallSources): string | undefined {
  if (!TYPE_NAMES.has(type.type) && type.type !== "identifier") return undefined;
  const { project, signatures } = sources;
  const scope = enclosingType(type, file, project);
  const resolved = resolve(type, file, project, scope, type, true);
  if (resolved !== undefined) return resolved.kind === "repository" || signatures.typeOf(resolved.fqn) === undefined ? undefined : resolved.fqn;
  const written = (type.type === "generic_type" ? type.namedChildren[0] : type)?.text.replace(/\s+/g, "") ?? "";
  if (!QUALIFIED.test(written)) return undefined;
  const [head = "", ...rest] = written.split(".");
  if (head === "var" || PACKAGE_SEGMENT.test(head) || typeVariableAround(type, head) !== undefined) return undefined;
  const containers = project.unboundTypeSources(head, { file, type: scope, at: type });
  const held = [...new Set(containers ?? [])].map((container) => [container, head, ...rest].join(".")).filter((fqn) => signatures.typeOf(fqn) !== undefined);
  return held.length === 1 ? held[0] : undefined;
}

/** The raw class of a library parameter or return type: dotted, unless it is a type variable, a primitive, `void` or an array. */
export function classHead(type: string): string | undefined {
  if (type.endsWith("[]")) return undefined;
  const raw = type.slice(0, type.includes("<") ? type.indexOf("<") : undefined);
  return raw.includes(".") ? raw : undefined;
}

function parameterAt(member: LibraryMember, position: number): string {
  const last = member.parameters.length - 1;
  return member.varargs && position >= last ? (member.parameters[last] ?? "").replace(/\[\]$/, "") : (member.parameters[position] ?? "");
}

/**
 * Every member named `name` that a call of `count` arguments may select in the class and the types above it (JLS
 * 15.12.2.1): fixed arity, or variable arity from one argument fewer than the parameters. A class is inherited through
 * its superclasses and interfaces, an interface's static members only by the interface itself (JLS 8.4.8, 9.4.1), and a
 * class name selects static members only. `undefined` when a type of the closure is not held.
 */
function membersOf(receiver: Extract<Receiver, { kind: "library" }>, name: string, count: number, signatures: LibrarySignatures): LibraryMember[] | undefined {
  const found: LibraryMember[] = [];
  const seen = new Set<string>();
  const pending = [receiver.fqn, OBJECT];
  for (let fqn = pending.shift(); fqn !== undefined; fqn = pending.shift()) {
    if (seen.has(fqn)) continue;
    seen.add(fqn);
    const type = signatures.typeOf(fqn);
    if (type === undefined) return undefined;
    const inherited = fqn !== receiver.fqn && (type.kind === "interface" || type.kind === "annotation");
    for (const member of type.members) {
      const applies = member.parameters.length === count || (member.varargs && count >= member.parameters.length - 1);
      if (member.name === name && applies && (member.static || !receiver.typeName) && !(member.static && inherited)) found.push(member);
    }
    for (const supertype of type.supertypes) pending.push(classHead(supertype) ?? supertype);
  }
  return found;
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
  const { project } = sources;
  const resolved = resolve(type, file, project, enclosingType(type, file, project), type, true);
  if (resolved?.kind === "repository") return resolved.type === undefined ? undefined : { kind: "repository", type: resolved.type };
  const fqn = libraryClassOf(type, file, sources);
  return fqn === undefined ? undefined : { kind: "library", fqn, typeName: false };
}

function same(a: Receiver | undefined, b: Receiver | undefined): boolean {
  return a !== undefined && b !== undefined && (a.kind === "library" ? b.kind === "library" && a.fqn === b.fqn : b.kind === "repository" && a.type === b.type);
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
  if (declared.length > 0 || !isTypeName(identifier, file, sources)) return undefined;
  const fqn = libraryClassOf(identifier, file, sources);
  return fqn === undefined ? undefined : { kind: "library", fqn, typeName: true };
}

function agreed(receivers: readonly (Receiver | undefined)[]): Receiver | undefined {
  const [first] = receivers;
  return first !== undefined && receivers.every((receiver) => same(first, receiver)) ? first : undefined;
}

/** Whether no variable can obscure the name: no field of an enclosing type, declared or possibly inherited from a type outside the repository. */
function isTypeName(identifier: Node, file: JavaFile, sources: LibraryCallSources): boolean {
  for (let type = thisType(identifier, file, sources.project); ; type = type.outer) {
    if (type === undefined) return false;
    const above = sources.ancestors(type);
    if (above === undefined || above.some((ancestor) => declaredField(ancestor, identifier.text) !== undefined)) return false;
    if (type.outer === undefined) return true;
  }
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
    const type_ = field.parent?.childForFieldName("type");
    return type_ === null || type_ === undefined || field.childForFieldName("dimensions") !== null ? "untyped" : type_;
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

/** Every declaration of the name in the member, outside the member's own fields: a local, a parameter, a loop or catch variable, a lambda parameter, a pattern variable. */
function declarationsOf(member: Node, name: string): Declaration[] {
  const found: Declaration[] = [];
  const everywhere = { scope: member, end: -1 };
  const pending: Node[] = [member];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const parent = node.parent;
    const named = node.childForFieldName("name")?.text === name;
    if (node.type === "variable_declarator" && named && parent?.type === "local_variable_declaration") {
      found.push({ type: node.childForFieldName("dimensions") === null ? written(parent.childForFieldName("type")) : undefined, scope: parent.parent ?? member, end: node.endIndex });
    } else if (node.type === "formal_parameter" && named && parent?.parent != null) {
      found.push({ type: node.childForFieldName("dimensions") === null ? node.childForFieldName("type") ?? undefined : undefined, scope: parent.parent, end: node.endIndex });
    } else if (node.type === "spread_parameter" && node.namedChildren.some((child) => child?.childForFieldName("name")?.text === name) && parent?.parent != null) {
      found.push({ type: undefined, scope: parent.parent, end: node.endIndex });
    } else if ((node.type === "catch_formal_parameter" || node.type === "resource") && named && parent?.parent != null) {
      found.push({ type: undefined, scope: node.type === "resource" ? parent.parent : parent, end: node.endIndex });
    } else if (node.type === "enhanced_for_statement" && named) {
      found.push({ type: written(node.childForFieldName("type")), scope: node, end: node.childForFieldName("value")?.endIndex ?? node.endIndex });
    } else if (node.type === "identifier" && node.text === name && parent !== null && isInferredDeclaration(node, parent)) {
      found.push({ type: undefined, scope: parent.type === "inferred_parameters" ? parent.parent ?? member : parent.type === "lambda_expression" ? parent : member, end: node.endIndex });
    } else if (node.type === "identifier" && node.text === name && parent !== null && PATTERNS.has(parent.type)) {
      found.push({ type: undefined, ...everywhere });
    }
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return found;
}

/** A written type, never `var`. */
function written(type: Node | null): Node | undefined {
  return type === null || type.text === "var" ? undefined : type;
}

function isInferredDeclaration(identifier: Node, parent: Node): boolean {
  return parent.type === "inferred_parameters" || (parent.type === "lambda_expression" && parent.childForFieldName("parameters")?.id === identifier.id);
}

/** `a.m(..)` and `m(..)`: the class of the one type every candidate declaration of the name and arity returns. */
function chainOf(invocation: Node, file: JavaFile, sources: LibraryCallSources): Receiver | undefined {
  const name = invocation.childForFieldName("name")?.text;
  const object = invocation.childForFieldName("object");
  const count = (invocation.childForFieldName("arguments")?.namedChildren ?? []).filter((child) => child !== null && !COMMENTS.has(child.type)).length;
  if (name === undefined || OBJECT_METHODS.has(name)) return undefined;
  const receiver = object === null || object.type === "this" ? undefined : receiverOf(object, file, sources);
  if (receiver?.kind === "library") {
    const members = membersOf(receiver, name, count, sources.signatures);
    if (members === undefined || members.length === 0) return undefined;
    const heads = new Set(members.map((member) => classHead(member.returns)));
    const [head] = heads;
    return heads.size === 1 && head !== undefined && sources.signatures.typeOf(head) !== undefined ? { kind: "library", fqn: head, typeName: false } : undefined;
  }
  const returns = receiver?.kind === "repository" ? declared(receiver.type, name, count, sources) : object === null || object.type === "this" ? unqualified(invocation, name, count, file, sources) : undefined;
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
