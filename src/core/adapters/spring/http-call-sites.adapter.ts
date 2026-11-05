import type { Node } from "web-tree-sitter";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CallSite, HttpTarget, StatedRequest } from "../../domain/topology/call-site.ts";
import type { Configuration } from "./application-config.ts";
import { complete, spanOf, unknownAtNode, withEvidence } from "./findings.ts";
import {
  EXCHANGE_VERBS,
  FEIGN_CLIENT,
  FLUENT_CLIENT_TYPES,
  FLUENT_VERBS,
  HTTP_CLIENT_NAME,
  HTTP_EXCHANGE,
  HTTP_METHODS,
  REQUEST_METHOD_TYPES,
  REST_TEMPLATE_TYPES,
  TEMPLATE_EXPLICIT,
  TEMPLATE_VERBS,
} from "./http-client-vocabulary.ts";
import { argumentsOf, assignmentsOf, localBindings, type Binding } from "./java-members.ts";
import { ancestorsOf, holdersOf, invocationsOf, NO_VARIABLES, parametersOf, receiverOf, referencesParameter, symbolOf, type Invocation } from "./java-invocations.ts";
import { externalNames, scopeOf, type Expr, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import { stringLiteralValue } from "./java-literals.ts";
import { annotationUses, createSpringAnnotations, pathExpressions, type SpringAnnotations } from "./request-mapping.ts";
import { isAnnotation, PLACEHOLDER, UrlText, type UrlScope } from "./url-text.ts";

const UNDECIDED = Symbol("undecided");
const ORIGIN = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)([\s\S]*)$/;

type Declared = string | typeof UNDECIDED | undefined;

/** A call of a standard client: the method and URL expressions it is given and the base URL its client declares. */
interface Request {
  invocation: Invocation;
  method: Node | HttpMethod | undefined;
  url: Node | undefined;
  base: Declared;
}

/** A request's target and, when the snapshot decides everything about it but its base, the request the code writes. */
interface ReadTarget {
  target: Finding<HttpTarget>;
  stated?: StatedRequest;
}

interface Wrapper {
  request: Request;
  parameters: readonly string[];
  called: boolean;
}

/** The HTTP requests a Java snapshot makes: one call site per request of a client the vocabulary knows. */
export class JavaHttpReader {
  private readonly annotations: SpringAnnotations;
  private readonly text: UrlText;
  private readonly wrappers = new Map<TypeDecl, Map<string, Wrapper>>();

  constructor(
    private readonly project: JavaProject,
    configuration: (file: JavaFile) => Configuration,
    private readonly owned: ReadonlySet<JavaFile>,
  ) {
    this.annotations = createSpringAnnotations(project);
    this.text = new UrlText(project, configuration);
  }

  sites(repo: string): CallSite[] {
    const found: CallSite[] = [];
    const invocations = this.project.types.flatMap((type) => invocationsOf(type));
    for (const invocation of invocations) {
      const request = this.requestOf(invocation);
      if (request === undefined) continue;
      const wrapper = this.wrapperOf(request);
      if (wrapper) this.wrappers.set(invocation.type, new Map(this.wrappers.get(invocation.type)).set(wrapper.key, wrapper.wrapper));
      else if (this.owned.has(invocation.type.file)) found.push(this.siteOf(repo, invocation, this.target(request, this.scopeOf(invocation, new Map()))));
    }
    for (const invocation of invocations.filter(({ type }) => this.owned.has(type.file))) {
      const called = this.callOfWrapper(invocation);
      if (called !== undefined) found.push(this.siteOf(repo, invocation, called));
      else {
        const library = this.libraryOf(invocation);
        if (library !== undefined) found.push(this.siteOf(repo, invocation, { target: unknownAtNode(invocation.type.file.path, invocation.node, library) }));
      }
    }
    for (const wrappers of this.wrappers.values()) {
      for (const wrapper of wrappers.values()) {
        const { invocation } = wrapper.request;
        if (!wrapper.called && this.owned.has(invocation.type.file)) found.push(this.siteOf(repo, invocation, { target: unknownAtNode(invocation.type.file.path, invocation.node) }));
      }
    }
    for (const type of this.project.types.filter((candidate) => this.owned.has(candidate.file))) found.push(...this.declarations(repo, type));
    return found.sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol) || compareText(a.target.status, b.target.status));
  }

  private scopeOf(invocation: Invocation, env: UrlScope["env"]): UrlScope {
    return { type: invocation.type, locals: invocation.locals, env };
  }

  private siteOf(repo: string, invocation: Invocation, { target, stated }: ReadTarget): CallSite {
    const span = spanOf(invocation.type.file.path, invocation.node);
    return { repo, file: span.path, line: span.line, ...(span.endLine === span.line ? {} : { endLine: span.endLine }), symbol: symbolOf(invocation), ancestors: ancestorsOf(invocation.node), transport: "http", target: withEvidence(target, span), ...(stated === undefined ? {} : { stated }) };
  }

  private receiverOf(object: Node, invocation: Invocation) {
    return receiverOf(object, invocation, this.project, this.text);
  }

  private requestOf(invocation: Invocation): Request | undefined {
    const { node } = invocation;
    const name = node.childForFieldName("name")?.text ?? "";
    const object = node.childForFieldName("object");
    const [first, second] = argumentsOf(node);
    if (object === null) return undefined;
    if (name === "uri" && object.type === "method_invocation") {
      const verb = object.childForFieldName("name")?.text ?? "";
      const method = FLUENT_VERBS.get(verb) ?? (verb === "method" ? argumentsOf(object)[0] : undefined);
      const client = method === undefined ? undefined : this.fluentClient(object.childForFieldName("object"), invocation);
      return client === undefined || method === undefined ? undefined : { invocation, method, url: first, base: client.base };
    }
    const receiver = this.receiverOf(object, invocation);
    if (receiver === undefined || !("fqn" in receiver.resolved) || !REST_TEMPLATE_TYPES.has(receiver.resolved.fqn)) return undefined;
    const verb = TEMPLATE_VERBS.get(name);
    if (verb === undefined && !TEMPLATE_EXPLICIT.has(name)) return undefined;
    return { invocation, method: verb ?? second, url: first, base: this.declaredBase(receiver.binding, receiver.owner, invocation) };
  }

  /** The Spring fluent client an expression is: a field or variable of that type, or a call chain that builds one. */
  private fluentClient(expression: Node | null, invocation: Invocation): { base: Declared } | undefined {
    let chainBase: Declared;
    let current = expression;
    while (current?.type === "method_invocation") {
      chainBase ??= this.baseCall(current, invocation);
      current = current.childForFieldName("object");
    }
    if (current === null) return undefined;
    if (current.type === "identifier") {
      const named = externalNames(current.text, invocation.type.file, false);
      if (named.some((candidate) => FLUENT_CLIENT_TYPES.has(candidate))) return { base: chainBase };
    }
    const receiver = this.receiverOf(current, invocation);
    if (receiver === undefined || !("fqn" in receiver.resolved) || !isFluentName(receiver.resolved.fqn)) return undefined;
    return { base: chainBase ?? this.declaredBase(receiver.binding, receiver.owner, invocation) };
  }

  /** The base URL a `baseUrl`, `rootUri` or `create` call of a builder chain sets. */
  private baseCall(call: Node, invocation: Invocation): Declared {
    const name = call.childForFieldName("name")?.text;
    const object = call.childForFieldName("object");
    const argument = argumentsOf(call)[0];
    const sets = name === "baseUrl" || name === "rootUri" || (name === "create" && object?.type === "identifier" && externalNames(object.text, invocation.type.file, false).some((candidate) => FLUENT_CLIENT_TYPES.has(candidate)));
    if (!sets || argument === undefined) return undefined;
    return this.text.of(argument, this.scopeOf(invocation, new Map())) ?? UNDECIDED;
  }

  /** The base URL the expressions a client field or variable is set from declare; two different ones are not decided. */
  private declaredBase(binding: Binding, owner: TypeDecl | undefined, invocation: Invocation): Declared {
    const assigned = owner === undefined ? [] : (assignmentsOf(owner).get(binding.name) ?? []);
    const sources = [...(binding.initializer === undefined ? [] : [{ node: binding.initializer, scope: this.scopeOf(invocation, new Map()) }]), ...assigned.map(({ value, member }) => ({ node: value, scope: { type: owner as TypeDecl, locals: localBindings(member), env: new Map() } }))];
    const bases = sources.flatMap(({ node, scope }): Declared[] => {
      for (let current: Node | null = node; current?.type === "method_invocation"; current = current.childForFieldName("object")) {
        const set = this.baseCall(current, { ...invocation, type: scope.type, locals: scope.locals });
        if (set !== undefined) return [set];
      }
      return [];
    });
    const distinct = new Set(bases);
    const [only] = distinct;
    return distinct.size > 1 ? UNDECIDED : only;
  }

  /** A request whose URL or method only a parameter of its own method decides is a wrapper: its callers make the calls. */
  private wrapperOf(request: Request): { key: string; wrapper: Wrapper } | undefined {
    const { invocation } = request;
    const member = invocation.member;
    if (member?.type !== "method_declaration") return undefined;
    const scope = this.scopeOf(invocation, new Map());
    const expressions = [request.url, typeof request.method === "object" ? request.method : undefined].filter((node): node is Node => node !== undefined);
    const text = request.url === undefined ? undefined : this.text.of(request.url, scope);
    const resolved = text === undefined ? undefined : targetOf(text, request.base);
    const undecided = resolved === undefined || resolved.base === UNDECIDED || (typeof request.method === "object" && this.methodOf(request.method, scope) === undefined);
    if (!undecided || !expressions.some((node) => referencesParameter(node, invocation))) return undefined;
    const parameters = parametersOf(member);
    return { key: `${member.childForFieldName("name")?.text}/${parameters.length}`, wrapper: { request, parameters, called: false } };
  }

  /** The target of a call to a wrapper, read with its parameters bound to the call's arguments. */
  private callOfWrapper(invocation: Invocation): ReadTarget | undefined {
    const { node } = invocation;
    const name = node.childForFieldName("name")?.text ?? "";
    const object = node.childForFieldName("object");
    const args = argumentsOf(node);
    for (const holder of holdersOf(object, invocation, this.project, this.text)) {
      const wrapper = this.wrappers.get(holder)?.get(`${name}/${args.length}`);
      if (wrapper === undefined) continue;
      wrapper.called = true;
      const env = new Map(wrapper.parameters.flatMap((parameter, index) => (args[index] === undefined ? [] : [[parameter, { node: args[index] as Node, scope: this.scopeOf(invocation, new Map()) }] as const])));
      const read = this.target(wrapper.request, this.scopeOf(wrapper.request.invocation, env));
      const declaring = wrapper.request.invocation.type;
      return read.target.status === "unknown" && !this.owned.has(declaring.file) ? { ...read, target: unknownAtNode(declaring.file.path, node, declaring.fqn) } : read;
    }
    return undefined;
  }

  /** The library a call goes through when the sources of its client type are not read to the request. */
  private libraryOf(invocation: Invocation): string | undefined {
    const object = invocation.node.childForFieldName("object");
    const receiver = object === null ? undefined : this.receiverOf(object, invocation);
    if (receiver === undefined) return undefined;
    const { resolved } = receiver;
    if ("decl" in resolved) return !this.owned.has(resolved.decl.file) && HTTP_CLIENT_NAME.test(resolved.decl.name) ? resolved.decl.fqn : undefined;
    return !this.project.isPlatformName(resolved.fqn) && HTTP_CLIENT_NAME.test(resolved.fqn) ? resolved.fqn : undefined;
  }

  private target(request: Request, scope: UrlScope): ReadTarget {
    const method = typeof request.method === "string" ? request.method : request.method === undefined ? undefined : this.methodOf(request.method, scope);
    const text = request.url === undefined ? undefined : this.text.of(request.url, scope);
    const resolved = text === undefined || method === undefined ? undefined : targetOf(text, request.base);
    const unknown = unknownAtNode(request.invocation.type.file.path, request.invocation.node);
    if (resolved === undefined || method === undefined) return { target: unknown };
    const { base, path } = resolved;
    if (base === UNDECIDED) return { target: unknown, stated: { method, path } };
    return { target: complete({ method, ...(base === undefined ? {} : { base }), path }) };
  }

  /** The HTTP method an expression names: `HttpMethod.GET`, `RequestMethod.GET`, `HttpMethod.valueOf("get")` or a string. */
  private methodOf(node: Node, scope: UrlScope): HttpMethod | undefined {
    if (node.type === "identifier") {
      const closure = scope.env.get(node.text);
      return closure === undefined ? undefined : this.methodOf(closure.node, closure.scope);
    }
    const named = node.type === "string_literal" ? stringLiteralValue(node.text) : node.type === "field_access" ? methodField(node) : node.type === "method_invocation" ? methodCall(node) : undefined;
    const upper = named?.toUpperCase();
    return upper !== undefined && HTTP_METHODS.has(upper) ? (upper as HttpMethod) : undefined;
  }

  /** The calls an interface declares with Feign or `@HttpExchange`: one per mapped method. */
  private declarations(repo: string, type: TypeDecl): CallSite[] {
    if (type.kind !== "interface") return [];
    const scope: UrlScope = { type, locals: NO_VARIABLES, env: new Map() };
    const typeUses = annotationUses(type.node, scopeOf(type));
    const feign = typeUses.find((use) => isAnnotation(use, FEIGN_CLIENT));
    const exchange = typeUses.find((use) => isAnnotation(use, HTTP_EXCHANGE));
    return type.methods.flatMap((method) => {
      const uses = annotationUses(method.node, scopeOf(type));
      const declared = feign === undefined ? this.exchangeOf(uses, scope, exchange).map((target): ReadTarget => ({ target })) : this.feignOf(uses, scope, feign);
      return declared.map(({ target, stated }) => {
        const span = spanOf(type.file.path, method.node);
        return { repo, file: span.path, line: span.line, ...(span.endLine === span.line ? {} : { endLine: span.endLine }), symbol: `${type.qualifiedName}.${method.name}`, ancestors: ancestorsOf(method.node), transport: "http" as const, target: withEvidence(target, span), ...(stated === undefined ? {} : { stated }) };
      });
    });
  }

  private feignOf(uses: Parameters<SpringAnnotations["mappingIn"]>[0], scope: UrlScope, feign: Parameters<typeof isAnnotation>[0]): ReadTarget[] {
    const lookup = this.annotations.mappingIn(uses);
    if (lookup === undefined) return [];
    const at = { target: unknownAtNode(scope.type.file.path, feign.node) };
    if ("gap" in lookup) return [at];
    const verb = lookup.mapping.verb ?? this.firstMethod(lookup.mapping.attributes.get("method"), scope);
    const url = feign.attributes.get("url")?.[0];
    const service = (feign.attributes.get("name") ?? feign.attributes.get("value"))?.[0];
    const head = this.text.attribute((url ?? service)?.node ?? feign.node, scope);
    const prefix = this.attributeText(feign.attributes.get("path")?.[0], scope);
    if (verb === undefined || (url ?? service) === undefined || prefix === undefined) return [at];
    const origin = head === undefined ? undefined : url === undefined ? { origin: head, rest: "" } : splitOrigin(head);
    return (pathExpressions(lookup.mapping.attributes) ?? [undefined]).map((expression) => {
      const path = this.attributeText(expression, scope);
      if (path === undefined) return at;
      if (origin === undefined) return { ...at, stated: { method: verb, path: joinPath(prefix, path) } };
      return origin.origin === undefined ? at : { target: complete({ method: verb, base: origin.origin, path: joinPath(origin.rest, prefix, path) }) };
    });
  }

  private exchangeOf(uses: Parameters<SpringAnnotations["mappingIn"]>[0], scope: UrlScope, typeLevel: Parameters<typeof isAnnotation>[0] | undefined): Finding<HttpTarget>[] {
    return uses.flatMap((use) => {
      const names = externalNames(use.name, use.scope.file, false);
      const fixed = names.map((name) => EXCHANGE_VERBS.get(name)).find((verb) => verb !== undefined);
      if (fixed === undefined && !names.includes(HTTP_EXCHANGE)) return [];
      const verb = fixed ?? this.firstMethod(use.attributes.get("method"), scope);
      const prefix = this.attributeText((typeLevel?.attributes.get("url") ?? typeLevel?.attributes.get("value"))?.[0], scope);
      const own = pathExpressions(use.attributes) ?? use.attributes.get("url") ?? [undefined];
      return own.map((expression) => {
        const path = this.attributeText(expression, scope);
        if (verb === undefined || path === undefined || prefix === undefined) return unknownAtNode(scope.type.file.path, use.node);
        const absolute = splitOrigin(joinPath(prefix, path));
        return complete({ method: verb, ...(absolute.origin === undefined ? { path: joinPath(prefix, path) } : { base: absolute.origin, path: pathOf(absolute.rest) }) });
      });
    });
  }

  private firstMethod(expressions: readonly Expr[] | undefined, scope: UrlScope): HttpMethod | undefined {
    const [first] = expressions ?? [];
    const node = first?.node.type === "element_value_array_initializer" ? first.node.namedChildren[0] : first?.node;
    return node === undefined || node === null ? undefined : this.methodOf(node, scope);
  }

  /** An annotation attribute's text; the empty string when it is absent, undefined when the snapshot does not decide it. */
  private attributeText(expression: Expr | undefined, scope: UrlScope): string | undefined {
    return expression === undefined ? "" : this.text.attribute(expression.node, scope);
  }
}

function isFluentName(fqn: string): boolean {
  return FLUENT_CLIENT_TYPES.has(fqn) || FLUENT_CLIENT_TYPES.has(fqn.replace(/\.Builder$/, ""));
}

function methodField(node: Node): string | undefined {
  const object = node.childForFieldName("object")?.text;
  return object !== undefined && REQUEST_METHOD_TYPES.includes(object) ? node.childForFieldName("field")?.text : undefined;
}

function methodCall(node: Node): string | undefined {
  const object = node.childForFieldName("object")?.text;
  const [argument] = argumentsOf(node);
  return object === "HttpMethod" && node.childForFieldName("name")?.text === "valueOf" && argument?.type === "string_literal" ? stringLiteralValue(argument.text) : undefined;
}

/** The scheme and authority a URL starts with; a part filled at run time ends the authority. */
function splitOrigin(text: string): { origin?: string; rest: string } {
  const match = ORIGIN.exec(text);
  if (match === null) return { rest: text };
  const origin = match[1] ?? "";
  const cut = origin.indexOf(PLACEHOLDER);
  return cut === -1 ? { origin, rest: match[2] ?? "" } : { origin: origin.slice(0, cut), rest: text.slice(text.indexOf(origin) + cut) };
}

/** A path as a call states it: no query, one slash between segments, a leading one. */
function pathOf(text: string): string {
  const path = (text.split(/[?#]/)[0] ?? "").split("/").filter((segment) => segment !== "");
  return `/${path.join("/")}`;
}

function joinPath(...parts: readonly string[]): string {
  return pathOf(parts.join("/"));
}

/**
 * The base and path a URL text comes down to; a path that only the code fills at run time is not decided. A relative
 * path under a client base the snapshot does not decide keeps its path, with the base `UNDECIDED`.
 */
function targetOf(text: string, client: Declared): { base?: string | typeof UNDECIDED; path: string } | undefined {
  if (text.startsWith(PLACEHOLDER)) return undefined;
  const absolute = splitOrigin(text);
  const declared = typeof client === "string" ? splitOrigin(client) : { rest: "" };
  const base = absolute.origin ?? declared.origin ?? client;
  const path = absolute.origin === undefined ? joinPath(declared.rest, text) : pathOf(absolute.rest);
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length > 0 && segments.every((segment) => segment === PLACEHOLDER) ? undefined : { ...(base === undefined ? {} : { base }), path };
}
