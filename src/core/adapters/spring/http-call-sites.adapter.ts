import type { Node } from "web-tree-sitter";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { isJavaSource, isJvmTestFile } from "../../domain/languages/java.ts";
import { isSpringConfigFile, resourcesOfSource } from "../../domain/languages/spring-config.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CallSite, CallSiteReader, HttpTarget } from "../../domain/topology/call-site.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { configurationOf, type Configuration } from "./application-config.ts";
import { spanOf } from "./findings.ts";
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
import { argumentsOf, assignmentsOf, descendants, isMember, localBindings, memberNodes, type Binding } from "./java-members.ts";
import { createJavaProject, describeFile, externalNames, isPlatformName, namedChildren, scopeOf, type Expr, type JavaFile, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { stringLiteralValue } from "./java-literals.ts";
import { annotationUses, createSpringAnnotations, pathExpressions, type SpringAnnotations } from "./request-mapping.ts";
import { isAnnotation, PLACEHOLDER, UrlText, type UrlScope } from "./url-text.ts";

const UNDECIDED = Symbol("undecided");
const LIBRARY_ROOT = "(library)";
const ORIGIN = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)([\s\S]*)$/;
const NO_VARIABLES: ReadonlyMap<string, Binding> = new Map();

type Declared = string | typeof UNDECIDED | undefined;

/** One method call, with the type and member it is written in and the names that member declares. */
interface Invocation {
  node: Node;
  type: TypeDecl;
  member: Node | undefined;
  locals: ReadonlyMap<string, Binding>;
}

/** A call of a standard client: the method and URL expressions it is given and the base URL its client declares. */
interface Request {
  invocation: Invocation;
  method: Node | HttpMethod | undefined;
  url: Node | undefined;
  base: Declared;
}

interface Wrapper {
  request: Request;
  parameters: readonly string[];
  called: boolean;
}

type Resolved = { decl: TypeDecl } | { fqn: string };

export function createJavaHttpCallSites(parser: JavaParser): CallSiteReader {
  return { of: async (files, repo, libraries = []) => readAll(parser, files, libraries, repo) };
}

function readAll(parser: JavaParser, files: readonly SourceFile[], libraries: readonly SourceFile[], repo: string): CallSite[] {
  const trees: JavaSyntaxTree[] = [];
  const parse = (sources: readonly SourceFile[]): JavaFile[] =>
    sources
      .filter((source) => isJavaSource(source.path) && !isJvmTestFile(source.path))
      .flatMap((source) => {
        try {
          const result = parser.parse(source.content);
          if (!result.ok) return [];
          trees.push(result.value);
          return [describeFile(source.path, result.value.root)];
        } catch {
          return [];
        }
      });
  try {
    const owned = parse(files);
    const foreign = parse(libraries.map((source, index) => ({ ...source, path: `${LIBRARY_ROOT}/${index}/${source.path}` })));
    return new JavaReader(createJavaProject([...owned, ...foreign]), files.filter((file) => isSpringConfigFile(file.path)), new Set(owned)).sites(repo);
  } finally {
    for (const tree of trees) tree.dispose();
  }
}

class JavaReader {
  private readonly annotations: SpringAnnotations;
  private readonly text: UrlText;
  private readonly configurations = new Map<string, Configuration>();
  private readonly wrappers = new Map<TypeDecl, Map<string, Wrapper>>();

  constructor(
    private readonly project: JavaProject,
    private readonly configs: readonly SourceFile[],
    private readonly owned: ReadonlySet<JavaFile>,
  ) {
    this.annotations = createSpringAnnotations(project);
    this.text = new UrlText(project, (file) => this.configurationFor(file));
  }

  sites(repo: string): CallSite[] {
    const found: CallSite[] = [];
    const invocations = this.project.types.flatMap((type) => invocationsOf(type));
    for (const invocation of invocations) {
      const request = this.requestOf(invocation);
      if (request === undefined) continue;
      const wrapper = this.wrapperOf(request);
      if (wrapper) this.wrappers.set(invocation.type, new Map(this.wrappers.get(invocation.type)).set(wrapper.key, wrapper.wrapper));
      else if (this.owned.has(invocation.type.file)) found.push(this.siteOf(repo, invocation, this.target(request, this.scopeOf(invocation, new Map())), invocation.node));
    }
    for (const invocation of invocations.filter(({ type }) => this.owned.has(type.file))) {
      const called = this.callOfWrapper(invocation);
      if (called !== undefined) found.push(this.siteOf(repo, invocation, called, invocation.node));
      else {
        const library = this.libraryOf(invocation);
        if (library !== undefined) found.push(this.siteOf(repo, invocation, unknownAt(invocation.type.file.path, invocation.node, library), invocation.node));
      }
    }
    for (const wrappers of this.wrappers.values()) {
      for (const wrapper of wrappers.values()) {
        const { invocation } = wrapper.request;
        if (!wrapper.called && this.owned.has(invocation.type.file)) found.push(this.siteOf(repo, invocation, unknownAt(invocation.type.file.path, invocation.node), invocation.node));
      }
    }
    for (const type of this.project.types.filter((candidate) => this.owned.has(candidate.file))) found.push(...this.declarations(repo, type));
    return found.sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol) || compareText(a.target.status, b.target.status));
  }

  private configurationFor(file: JavaFile): Configuration {
    const resources = resourcesOfSource(file.path);
    const key = resources ?? "";
    const known = this.configurations.get(key);
    if (known !== undefined) return known;
    const own = this.configs.filter((config) => resources !== undefined && config.path.startsWith(resources) && /^(config\/)?[^/]+$/.test(config.path.slice(resources.length)));
    const configuration = configurationOf(own.length > 0 ? own : this.configs);
    this.configurations.set(key, configuration);
    return configuration;
  }

  private scopeOf(invocation: Invocation, env: UrlScope["env"]): UrlScope {
    return { type: invocation.type, locals: invocation.locals, env };
  }

  private siteOf(repo: string, invocation: Invocation, target: Finding<HttpTarget>, at: Node): CallSite {
    const span = spanOf(invocation.type.file.path, at);
    return { repo, file: span.path, line: span.line, ...(span.endLine === span.line ? {} : { endLine: span.endLine }), symbol: symbolOf(invocation), transport: "http", target: withEvidence(target, span) };
  }

  /** The type a receiver expression is an instance of, through the field, parameter or variable that holds it. */
  private receiverOf(object: Node, invocation: Invocation): { binding: Binding; owner: TypeDecl | undefined; resolved: Resolved } | undefined {
    const name = object.type === "identifier" ? object.text : object.type === "field_access" && object.childForFieldName("object")?.type === "this" ? object.childForFieldName("field")?.text : undefined;
    if (name === undefined) return undefined;
    const local = object.type === "identifier" ? invocation.locals.get(name) : undefined;
    const field = local === undefined ? this.text.fieldOf(invocation.type, name) : undefined;
    const binding = local ?? field?.binding;
    const owner = field?.owner ?? invocation.type;
    const resolved = binding === undefined ? undefined : this.resolve(binding.typeName, owner);
    return binding === undefined || resolved === undefined ? undefined : { binding, owner: field?.owner, resolved };
  }

  private resolve(name: string, from: TypeDecl): Resolved | undefined {
    const found = this.project.lookupType(name, scopeOf(from));
    if (found === "ambiguous") return undefined;
    if (found !== undefined) return { decl: found };
    const [fqn] = externalNames(name, from.file, false);
    return fqn === undefined ? undefined : { fqn };
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
    const undecided = text === undefined || targetOf(text, request.base) === undefined || (typeof request.method === "object" && this.methodOf(request.method, scope) === undefined);
    if (!undecided || !expressions.some((node) => referencesParameter(node, invocation))) return undefined;
    const parameters = parametersOf(member);
    return { key: `${member.childForFieldName("name")?.text}/${parameters.length}`, wrapper: { request, parameters, called: false } };
  }

  /** The target of a call to a wrapper, read with its parameters bound to the call's arguments. */
  private callOfWrapper(invocation: Invocation): Finding<HttpTarget> | undefined {
    const { node } = invocation;
    const name = node.childForFieldName("name")?.text ?? "";
    const object = node.childForFieldName("object");
    const args = argumentsOf(node);
    const holders = this.holdersOf(object, invocation);
    for (const holder of holders) {
      const wrapper = this.wrappers.get(holder)?.get(`${name}/${args.length}`);
      if (wrapper === undefined) continue;
      wrapper.called = true;
      const env = new Map(wrapper.parameters.flatMap((parameter, index) => (args[index] === undefined ? [] : [[parameter, { node: args[index] as Node, scope: this.scopeOf(invocation, new Map()) }] as const])));
      const target = this.target(wrapper.request, this.scopeOf(wrapper.request.invocation, env));
      const declaring = wrapper.request.invocation.type;
      return target.status === "unknown" && !this.owned.has(declaring.file) ? unknownAt(declaring.file.path, node, declaring.fqn) : target;
    }
    return undefined;
  }

  private holdersOf(object: Node | null, invocation: Invocation): TypeDecl[] {
    if (object === null || object.type === "this") return [...this.project.classChain(invocation.type)];
    const receiver = this.receiverOf(object, invocation);
    return receiver !== undefined && "decl" in receiver.resolved ? [...this.project.classChain(receiver.resolved.decl)] : [];
  }

  /** The library a call goes through when the sources of its client type are not read to the request. */
  private libraryOf(invocation: Invocation): string | undefined {
    const object = invocation.node.childForFieldName("object");
    const receiver = object === null ? undefined : this.receiverOf(object, invocation);
    if (receiver === undefined) return undefined;
    const { resolved } = receiver;
    if ("decl" in resolved) return !this.owned.has(resolved.decl.file) && HTTP_CLIENT_NAME.test(resolved.decl.name) ? resolved.decl.fqn : undefined;
    return !isPlatformName(resolved.fqn) && HTTP_CLIENT_NAME.test(resolved.fqn) ? resolved.fqn : undefined;
  }

  private target(request: Request, scope: UrlScope): Finding<HttpTarget> {
    const method = typeof request.method === "string" ? request.method : request.method === undefined ? undefined : this.methodOf(request.method, scope);
    const text = request.url === undefined ? undefined : this.text.of(request.url, scope);
    const target = text === undefined || method === undefined ? undefined : targetOf(text, request.base);
    return target === undefined || method === undefined ? unknownAt(request.invocation.type.file.path, request.invocation.node) : complete({ method, ...target });
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
      const declared = feign === undefined ? this.exchangeOf(uses, scope, exchange) : this.feignOf(uses, scope, feign);
      return declared.map((target) => {
        const span = spanOf(type.file.path, method.node);
        return { repo, file: span.path, line: span.line, ...(span.endLine === span.line ? {} : { endLine: span.endLine }), symbol: `${type.qualifiedName}.${method.name}`, transport: "http" as const, target: withEvidence(target, span) };
      });
    });
  }

  private feignOf(uses: Parameters<SpringAnnotations["mappingIn"]>[0], scope: UrlScope, feign: Parameters<typeof isAnnotation>[0]): Finding<HttpTarget>[] {
    const lookup = this.annotations.mappingIn(uses);
    if (lookup === undefined) return [];
    const at = unknownAt(scope.type.file.path, feign.node);
    if ("gap" in lookup) return [at];
    const verb = lookup.mapping.verb ?? this.firstMethod(lookup.mapping.attributes.get("method"), scope);
    const url = feign.attributes.get("url")?.[0];
    const service = (feign.attributes.get("name") ?? feign.attributes.get("value"))?.[0];
    const head = this.text.attribute((url ?? service)?.node ?? feign.node, scope);
    const prefix = this.attributeText(feign.attributes.get("path")?.[0], scope);
    if (verb === undefined || (url ?? service) === undefined || head === undefined || prefix === undefined) return [at];
    const origin = url === undefined ? { origin: head, rest: "" } : splitOrigin(head);
    return (pathExpressions(lookup.mapping.attributes) ?? [undefined]).map((expression) => {
      const path = this.attributeText(expression, scope);
      return path === undefined || origin.origin === undefined ? at : complete({ method: verb, base: origin.origin, path: joinPath(origin.rest, prefix, path) });
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
        if (verb === undefined || path === undefined || prefix === undefined) return unknownAt(scope.type.file.path, use.node);
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

function invocationsOf(type: TypeDecl): Invocation[] {
  return memberNodes(type).flatMap((member) => {
    const locals = isMember(member) ? localBindings(member) : NO_VARIABLES;
    return descendants(member)
      .filter((node) => node.type === "method_invocation")
      .map((node): Invocation => ({ node, type, member: isMember(member) ? member : undefined, locals }));
  });
}

function symbolOf({ type, member }: Invocation): string {
  const name = member?.type === "method_declaration" ? member.childForFieldName("name")?.text : undefined;
  return name === undefined ? type.qualifiedName : `${type.qualifiedName}.${name}`;
}

function parametersOf(member: Node): string[] {
  const list = member.childForFieldName("parameters");
  return (list === null ? [] : namedChildren(list)).map((parameter) => parameter.childForFieldName("name")?.text ?? "");
}

/** Whether an expression reads a parameter of the method it is written in, directly or through a local variable. */
function referencesParameter(expression: Node, invocation: Invocation, trail: ReadonlySet<string> = new Set()): boolean {
  return [expression, ...descendants(expression)].some((node) => {
    if (node.type !== "identifier") return false;
    const binding = invocation.locals.get(node.text);
    if (binding === undefined || trail.has(node.text)) return false;
    return binding.node.type.endsWith("parameter") || (binding.initializer !== undefined && referencesParameter(binding.initializer, invocation, new Set(trail).add(node.text)));
  });
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

/** The base and path a URL text comes down to; a path that only the code fills at run time is not decided. */
function targetOf(text: string, client: Declared): { base?: string; path: string } | undefined {
  if (text.startsWith(PLACEHOLDER)) return undefined;
  const absolute = splitOrigin(text);
  if (absolute.origin === undefined && client === UNDECIDED) return undefined;
  const declared = client === undefined || client === UNDECIDED ? { rest: "" } : splitOrigin(client);
  const base = absolute.origin ?? declared.origin ?? (typeof client === "string" ? client : undefined);
  const path = absolute.origin === undefined ? joinPath(declared.rest, text) : pathOf(absolute.rest);
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length > 0 && segments.every((segment) => segment === PLACEHOLDER) ? undefined : { ...(base === undefined ? {} : { base }), path };
}

function complete(value: HttpTarget): Finding<HttpTarget> {
  return { status: "complete", value, evidence: [] };
}

function unknownAt(path: string, node: Node, via?: string): Finding<HttpTarget> {
  const span = spanOf(path, node);
  return { status: "unknown", reason: "unresolved", evidence: [via === undefined ? span : { ...span, via }] };
}

function withEvidence(target: Finding<HttpTarget>, span: Evidence): Finding<HttpTarget> {
  if (target.status === "unknown") {
    const via = target.evidence[0]?.via;
    return { ...target, evidence: [via === undefined ? span : { ...span, via }] };
  }
  return { ...target, evidence: [{ path: span.path, line: span.line }] };
}
