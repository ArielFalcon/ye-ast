import type { Node } from "web-tree-sitter";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins, ReceiverMethod } from "../../ports/import-origins.port.ts";
import { enclosingBody, fieldsOf, localBinding } from "../tree-sitter/java-function-value-calls.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { javaReceiverBindings } from "../tree-sitter/java-receiver-bindings.ts";
import { annotationAt, namesDynamicImplementation, resolve, UNREAD_JVM_SOURCE } from "./java-declared-types.ts";
import { enclosingType } from "./java-root-bindings.ts";
import { ancestorsOf, hierarchyOf, type Hierarchy, type Superclass } from "./java-dispatch-targets.ts";
import { createJavaProject, describeFile, sameSignature, type JavaFile, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";

const UNKNOWN: ReceiverMethod = { kind: "unknown" };
const UNPROVEN: ReceiverMethod = { kind: "unproven" };
/** Methods every class inherits from `Object` (JLS 4.3.2): a call of one of these names may resolve to `Object`'s. */
const OBJECT_METHODS: ReadonlySet<string> = new Set(["clone", "equals", "finalize", "getClass", "hashCode", "notify", "notifyAll", "toString", "wait"]);
/** Nodes the grammar places among a call's arguments that are no argument. */
const NOT_ARGUMENTS: ReadonlySet<string> = new Set(["line_comment", "block_comment"]);
/**
 * Annotations by which a processor changes what a call names without a declaration the sources hold: Lombok's
 * `@Delegate` adds a type's methods to a class, an overload of any signature, and `@ExtensionMethod` makes a call that
 * no member accepts run a static method of another class.
 */
const CALL_REWRITING_ANNOTATIONS: ReadonlySet<string> = new Set(["Delegate", "ExtensionMethod"]);

/** One Java source as the resolver reads it: its description, and its receiver bindings by the call's place, member and receiver. */
interface ReadFile {
  file: JavaFile;
  bindings: ReadonlyMap<string, ReceiverBinding>;
  /** Method invocations by the place they start and the member they call: one place may start several (`a.f().f()`). */
  invocations: ReadonlyMap<string, readonly Node[]>;
}

/**
 * `ImportOrigins.receiverMethods` for Java sources. Java types nominally, so a value a declaration states the type of is
 * an instance of that type or of a type below it, and the call names the type's method of the call's signature; dispatch
 * then decides the body (RFC-0013 R7). The receiver's type is the repository type a parameter, a local or a private field
 * states, as the receiver bindings read it (ADR-0029 decision 9), or the declared return type of the repository method
 * that a receiver call names in the same way, the enclosing class's for `f()` and `this.f()` (R5): an overriding method
 * may only return a subtype, which dispatch covers. No method, beyond what `dispatchTargets` refuses, when the type is a
 * type variable, an enum or an annotation type; when a type at or above it is outside the repository, whose members the
 * sources do not state; when its members of the name, its own and inherited, are not exactly one signature of the call's
 * arity with no varargs and no private declaration, or the name is one of `Object`'s methods; when the call sits in an
 * anonymous or a local class; when a source holds an annotation by which a processor adds overloads or rewrites calls
 * (`CALL_REWRITING_ANNOTATIONS`); and when the declared hierarchy does not settle the member. Dispatch is a separate trace obligation. `unproven` only when a source may make a value of a declared type run code no source shows (a source
 * that does not parse, a JVM language no extractor reads, a JDK API that implements an interface at run time) and the
 * call's receiver is a value it reads; otherwise the call is `unknown`.
 */
export function createJavaReceiverMethods(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[]): ImportOrigins["receiverMethods"] {
  const java = sources.filter(({ path }) => isJavaSource(path));
  const unreadJvm = paths.some((path) => UNREAD_JVM_SOURCE.test(path));
  return async (sites, signal) => {
    const results: ReceiverMethod[] = sites.map(() => UNKNOWN);
    if (!sites.some(({ file }) => isJavaSource(file))) return results;
    const read = await parser();
    const trees: JavaSyntaxTree[] = [];
    try {
      const files: JavaFile[] = [];
      let parsedAll = true;
      for (const source of java) {
        const parsed = read.parse(source.content);
        if (!parsed.ok) {
          parsedAll = false;
          continue;
        }
        trees.push(parsed.value);
        files.push(describeFile(source.path, parsed.value.root));
      }
      const project = createJavaProject(files);
      const falsified = !parsedAll || unreadJvm || project.unreadable.length > 0 || files.some((file) => namesAnyDynamicImplementation(file, project));
      const hierarchy = falsified ? undefined : hierarchyOf(files, project);
      const proves = hierarchy !== undefined && !files.some(({ root }) => rewritesCalls(root));
      const byPath = new Map(files.map((file) => [file.path, file]));
      const readFiles = new Map<string, ReadFile>();
      const readFile = (path: string): ReadFile | undefined => {
        const file = byPath.get(path);
        if (file === undefined) return undefined;
        let known = readFiles.get(path);
        if (known === undefined) {
          known = { file, bindings: new Map(javaReceiverBindings(file.root).map((binding) => [callKey(binding.line, binding.column, binding.member), binding])), invocations: invocationsOf(file.root) };
          readFiles.set(path, known);
        }
        return known;
      };
      const resolver = createResolver(project, hierarchy);
      for (const [index, site] of sites.entries()) {
        if (signal?.aborted) break;
        const source = readFile(site.file);
        const invocations = source?.invocations.get(callKey(site.line, site.column, site.member)) ?? [];
        if (source === undefined || invocations.length !== 1) continue;
        const method = proves ? resolver.methodOf(invocations[0]!, source) : undefined;
        if (method !== undefined) {
          results[index] = { kind: "method", file: method.owner.file.path, start: method.node.startPosition.row + 1, nameLine: (method.node.childForFieldName("name") ?? method.node).startPosition.row + 1 };
        } else if (resolver.hasDeclaredReceiver(invocations[0]!, source) || (falsified && resolver.holdsValue(invocations[0]!, source.file))) results[index] = UNPROVEN;
      }
      return results;
    } finally {
      for (const tree of trees) tree.dispose();
    }
  };
}

function createResolver(project: JavaProject, hierarchy: Hierarchy | undefined) {
  const placed = new Map(project.types.map((type) => [type.node.id, type]));

  /** The repository type the receiver of an invocation is declared to hold; none when nothing proves one. */
  const receiverOf = (invocation: Node, source: ReadFile): TypeDecl | undefined => {
    const object = invocation.childForFieldName("object");
    if (object === null || object.type === "this") return enclosingClassOf(invocation);
    if (object.type === "method_invocation") {
      const called = methodNamed(object, source);
      return called === undefined ? undefined : returnTypeOf(called);
    }
    const binding = source.bindings.get(callKey(invocation.startPosition.row + 1, invocation.startPosition.column + 1, invocation.childForFieldName("name")?.text ?? ""));
    const receiver = object.type === "identifier" ? object.text : object.type === "field_access" ? object.childForFieldName("field")?.text : undefined;
    if (binding === undefined || binding.receiver !== receiver || binding.holds.kind !== "annotated") return undefined;
    const name = annotationAt(source.file.root, binding.holds.line, binding.holds.column, binding.holds.type);
    return name === undefined ? undefined : repositoryType(name, source.file, name);
  };

  /** The class a bare or `this` call inside it names a member of: the type whose body holds the call, when the project places it. */
  const enclosingClassOf = (node: Node): TypeDecl | undefined => {
    const body = enclosingBody(node);
    return body?.parent === null || body?.parent === undefined ? undefined : placed.get(body.parent.id);
  };

  /** The one method of the name that the receiver's declared type offers for the call's arity. */
  const methodNamed = (invocation: Node, source: ReadFile): MethodDecl | undefined => {
    const type = receiverOf(invocation, source);
    const name = invocation.childForFieldName("name")?.text;
    return type === undefined || name === undefined ? undefined : memberOf(type, name, argumentCount(invocation));
  };

  /** The repository type a method declares it returns: none for a type variable, an array, a primitive or a type outside the repository. */
  const returnTypeOf = (method: MethodDecl): TypeDecl | undefined => {
    const type = method.node.childForFieldName("type");
    return type === null ? undefined : repositoryType(type, method.owner.file, type);
  };

  const repositoryType = (name: Node, file: JavaFile, at: Node): TypeDecl | undefined => {
    const resolved = resolve(name, file, project, enclosingType(at, file, project), at);
    return resolved?.kind === "repository" && resolved.type !== undefined && (resolved.type.kind === "class" || resolved.type.kind === "interface") ? resolved.type : undefined;
  };

  /**
   * The declaration a call of `name` with `arity` arguments on a value of `type` is resolved to: the members of the name,
   * declared and inherited, must be one signature, so overload resolution has one candidate; the type's own, else the
   * nearest up its class chain, else the only one.
   */
  const memberOf = (type: TypeDecl, name: string, arity: number): MethodDecl | undefined => {
    if (hierarchy === undefined || OBJECT_METHODS.has(name)) return undefined;
    const above = ancestorsOf(type, hierarchy);
    if (above.some((ancestor) => hierarchy.outside.has(ancestor))) return undefined;
    const named = above.flatMap((ancestor) => ancestor.methods.filter((method) => method.name === name));
    if (named.some(hasVarargs)) return undefined;
    const candidates = named.filter((method) => method.parameterTypes.length === arity);
    const [first] = candidates;
    if (first === undefined) return undefined;
    if (candidates.some((method) => (method.modifiers.includes("private") && method.owner !== type) || hasVarargs(method) || (method !== first && !sameStatedSignature(method, first)))) return undefined;
    for (let current: Superclass = type; typeof current === "object"; current = hierarchy.superclasses.get(current) ?? "outside") {
      const own = candidates.find((method) => method.owner === current);
      if (own !== undefined) return own;
    }
    return candidates.length === 1 ? first : undefined;
  };

  /** Whether two members certainly state the same parameter types, each as the strict reading settles them. */
  const sameStatedSignature = (method: MethodDecl, other: MethodDecl): boolean => {
    const own = hierarchy?.signatureOf(method);
    const others = hierarchy?.signatureOf(other);
    return own !== undefined && others !== undefined && sameSignature(own, others);
  };

  return {
    hasDeclaredReceiver: (invocation: Node, source: ReadFile): boolean => receiverOf(invocation, source) !== undefined,
    /** The method the call names through its declared receiver and one settled signature; dispatch decides its body separately. */
    methodOf: (invocation: Node, source: ReadFile): MethodDecl | undefined => {
      const type = receiverOf(invocation, source);
      const name = invocation.childForFieldName("name")?.text;
      const method = type === undefined || name === undefined ? undefined : memberOf(type, name, argumentCount(invocation));
      return method;
    },
    /**
     * Whether the call's receiver is a value the call reads, whose class the call's own place does not state: a variable
     * (a parameter, a local or a field, `this.f` included), a member read through another value (`a.b`), or what another
     * call returns. A bare call, a call on `this` or `super`, and a call on a name that denotes a type are not.
     */
    holdsValue: (invocation: Node, file: JavaFile): boolean => {
      const object = invocation.childForFieldName("object");
      if (object === null) return false;
      if (object.type === "method_invocation" || object.type === "field_access") return true;
      if (object.type !== "identifier") return false;
      if (localBinding(object) !== undefined || fieldAround(object)) return true;
      const named = resolve(object, file, project, enclosingType(object, file, project), object);
      return named === undefined;
    },
  };
}

/** Whether a source names a JDK API that implements an interface at run time, whose value may stand for any declared type. */
function namesAnyDynamicImplementation(file: JavaFile, project: JavaProject): boolean {
  const pending: Node[] = [file.root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (namesDynamicImplementation(node, file, project)) return true;
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return false;
}

/** Whether a type body around the identifier declares a field of its name. */
function fieldAround(identifier: Node): boolean {
  for (let body = enclosingBody(identifier); body !== undefined; body = enclosingBody(body)) if (fieldsOf(body).some((declarator) => declarator.childForFieldName("name")?.text === identifier.text)) return true;
  return false;
}

function rewritesCalls(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if ((node.type === "marker_annotation" || node.type === "annotation") && CALL_REWRITING_ANNOTATIONS.has(node.childForFieldName("name")?.text.split(".").at(-1) ?? "")) return true;
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return false;
}

function invocationsOf(root: Node): ReadonlyMap<string, readonly Node[]> {
  const found = new Map<string, Node[]>();
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === "method_invocation") {
      const key = callKey(node.startPosition.row + 1, node.startPosition.column + 1, node.childForFieldName("name")?.text ?? "");
      found.set(key, [...(found.get(key) ?? []), node]);
    }
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return found;
}

function argumentCount(invocation: Node): number {
  return (invocation.childForFieldName("arguments")?.namedChildren ?? []).filter((argument) => argument !== null && !NOT_ARGUMENTS.has(argument.type)).length;
}

function hasVarargs(method: MethodDecl): boolean {
  return (method.node.childForFieldName("parameters")?.namedChildren ?? []).some((parameter) => parameter?.type === "spread_parameter");
}

function callKey(line: number, column: number, member: string): string {
  return `${line}:${column}:${member}`;
}
