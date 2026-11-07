import type { UrlScope } from "./java-values.ts";
import { JavaMethodFlow, reachedTarget, type Reading } from "./java-method-flow.ts";
import type { Node } from "web-tree-sitter";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import { compareCallSites, type CallSite, type HttpTarget } from "../../domain/topology/call-site.ts";
import type { Configuration } from "./application-config.ts";
import { complete, placed, spanOf, unknown, unknownAtNode, withEvidence } from "./findings.ts";
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
import { argumentsOf, assignmentsOf, localBindings, typeNameOf, type Binding } from "./java-members.ts";
import { ancestorsOf, NO_VARIABLES, receiverOf, symbolOf, type Invocation } from "./java-invocations.ts";
import { externalNames, scopeOf, type Expr, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import { stringLiteralValue } from "./java-literals.ts";
import { isAnnotation, annotationUses, createSpringAnnotations, pathExpressions, type SpringAnnotations } from "./request-mapping.ts";
import { JavaValueEvaluator } from "./java-value-evaluator.ts";
import { callUrl, joinedCallUrl, RUN_TIME_HOLE } from "../../domain/topology/path-template.ts";
import { known, undecided, undecidedTarget, type Evaluated } from "../../domain/topology/evaluated.ts";

/** The base URL a client declares: undefined when it declares none. */
type Declared = Evaluated<string> | undefined;

/** A call of a standard client: the method and URL expressions it is given and the base URL its client declares. */
interface Request {
  invocation: Invocation;
  method: Node | HttpMethod | undefined;
  url: Node | undefined;
  base: Declared;
}

/** A request's target and, when the snapshot decides everything about it but its base, the request the code writes. */
type ReadTarget = Reading<HttpTarget>;


/** The HTTP requests a Java snapshot makes: one call site per request of a client the vocabulary knows. */
export class JavaHttpReader {
  private readonly annotations: SpringAnnotations;
  private readonly text: JavaValueEvaluator;

  constructor(
    private readonly project: JavaProject,
    configuration: (file: JavaFile) => Configuration,
    private readonly owned: ReadonlySet<JavaFile>,
  ) {
    this.annotations = createSpringAnnotations(project);
    this.text = new JavaValueEvaluator(project, configuration);
  }

  sites(repo: string): CallSite[] {
    const found: CallSite[] = [];
    const flow = new JavaMethodFlow<Request>(this.project, this.text, (call) => this.requestOf(call));
    for (const invocation of flow.invocations.filter((call) => this.owned.has(call.type.file))) {
      if (flow.nested(invocation)) continue;
      const scope = this.scopeOf(invocation, new Map());
      const direct = this.requestOf(invocation);
      if (direct !== undefined) {
        found.push(this.siteOf(repo, invocation, this.target(direct, scope)));
        continue;
      }
      const expanded = flow.expand(invocation, scope);
      if (expanded !== undefined) {
        const targets = expanded.map((group) => reachedTarget(invocation, group, group.map(({ leaf, scope }) => this.target(leaf, scope)), this.owned));
        for (const target of targets) {
          const site = this.siteOf(repo, invocation, target);
          if (site.target.status !== "unknown") site.target = { ...site.target, evidence: [...site.target.evidence, ...expanded.flat().map(({ leaf }) => spanOf(leaf.invocation.type.file.path, leaf.invocation.node))] };
          found.push(site);
        }
      } else {
        const library = this.libraryOf(invocation);
        if (library !== undefined) found.push(this.siteOf(repo, invocation, { target: unknown("unresolved", [{ ...spanOf(invocation.type.file.path, invocation.node), via: library.via }, ...library.evidence]), diagnostic: { cause: library.source === "read" ? "request-not-found" : "source-not-read", source: library.source } }));
      }
    }
    for (const type of this.project.types.filter((candidate) => this.owned.has(candidate.file))) found.push(...this.declarations(repo, type));
    return found.sort(compareCallSites);
  }

  private scopeOf(invocation: Invocation, env: UrlScope["env"]): UrlScope {
    return { type: invocation.type, locals: invocation.locals, env };
  }

  private siteOf(repo: string, invocation: Invocation, { target, stated, diagnostic }: ReadTarget): CallSite {
    const span = spanOf(invocation.type.file.path, invocation.node);
    return placed({ repo, file: span.path, line: span.line, ...(span.endLine === span.line ? {} : { endLine: span.endLine }), symbol: symbolOf(invocation), ancestors: ancestorsOf(invocation.node), transport: "http", target: withEvidence(target, span), ...(diagnostic === undefined ? {} : { diagnostic }), ...(stated === undefined ? {} : { stated }) }, invocation.node);
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
    if (receiver !== undefined && "fqn" in receiver.resolved && receiver.resolved.fqn === "okhttp3.OkHttpClient" && name === "newCall") return this.okHttpRequest(invocation, first);
    if (receiver === undefined || !("fqn" in receiver.resolved) || !REST_TEMPLATE_TYPES.has(receiver.resolved.fqn)) return undefined;
    const verb = TEMPLATE_VERBS.get(name);
    if (verb === undefined && !TEMPLATE_EXPLICIT.has(name)) return undefined;
    return { invocation, method: verb ?? second, url: first, base: this.declaredBase(receiver.binding, receiver.owner, invocation) };
  }

  private okHttpRequest(invocation: Invocation, expression: Node | undefined): Request {
    let current = expression;
    const seen = new Set<number>();
    let url: Node | undefined;
    let method: Node | HttpMethod | undefined;
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.type === "identifier") {
        current = invocation.locals.get(current.text)?.initializer ?? this.text.fieldOf(invocation.type, current.text)?.binding.initializer;
        continue;
      }
      if (current.type === "method_invocation") {
        const name = current.childForFieldName("name")?.text;
        if (name === "url") url ??= argumentsOf(current)[0];
        if (name === "method") method ??= argumentsOf(current)[0];
        if (name !== undefined) method ??= FLUENT_VERBS.get(name);
        current = current.childForFieldName("object") ?? undefined;
        continue;
      }
      if (current.type === "object_creation_expression") {
        const named = typeNameOf(current.childForFieldName("type"));
        const standard = named === "okhttp3.Request.Builder" || (named === "Request.Builder" && externalNames("Request", invocation.type.file, false).includes("okhttp3.Request"));
        if (standard) return { invocation, method: method ?? "GET", url, base: undefined };
      }
      break;
    }
    return { invocation, method: undefined, url: undefined, base: undefined };
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
    const scope = this.scopeOf(invocation, new Map());
    return this.text.evaluated(scope, () => this.text.of(argument, scope));
  }

  /** The base URL the expressions a client field or variable is set from declare; two different ones are not decided. */
  private declaredBase(binding: Binding, owner: TypeDecl | undefined, invocation: Invocation): Declared {
    const assigned = owner === undefined ? [] : (assignmentsOf(owner).get(binding.name) ?? []);
    const sources = [...(binding.initializer === undefined ? [] : [{ node: binding.initializer, scope: this.scopeOf(invocation, new Map()) }]), ...assigned.map(({ value, member }) => ({ node: value, scope: { type: owner as TypeDecl, locals: localBindings(member), env: new Map() } }))];
    const bases = sources.flatMap(({ node, scope }): Evaluated<string>[] => {
      for (let current: Node | null = node; current?.type === "method_invocation"; current = current.childForFieldName("object")) {
        const set = this.baseCall(current, { ...invocation, type: scope.type, locals: scope.locals });
        if (set !== undefined) return [set];
      }
      return [];
    });
    const decided = new Set(bases.map((base) => (base.status === "known" ? base.value : undefined)));
    return decided.size > 1 ? undecided("destination-undecidable") : bases[0];
  }

  /** The library a call goes through when the sources of its client type are not read to the request. */
  private libraryOf(invocation: Invocation): { via: string; source: "read" | "not-read"; evidence: readonly Evidence[] } | undefined {
    const object = invocation.node.childForFieldName("object");
    const receiver = object === null ? undefined : this.receiverOf(object, invocation);
    if (receiver === undefined) return undefined;
    const { resolved } = receiver;
    if ("decl" in resolved) return !this.owned.has(resolved.decl.file) && HTTP_CLIENT_NAME.test(resolved.decl.name) ? { via: resolved.decl.fqn, source: "read", evidence: [spanOf(resolved.decl.file.path, resolved.decl.node)] } : undefined;
    return !this.project.isPlatformName(resolved.fqn) && HTTP_CLIENT_NAME.test(resolved.fqn) ? { via: resolved.fqn, source: "not-read", evidence: [] } : undefined;
  }

  /** A request's target; an undecided base keeps the request the code writes, with the base's own cause. */
  private target(request: Request, scope: UrlScope): ReadTarget {
    const at = spanOf(request.invocation.type.file.path, request.invocation.node);
    const read = this.text.evaluated(scope, () => this.requested(request, scope));
    if (read.status === "undecided") return undecidedTarget(read, at);
    const { method, base, path } = read.value;
    if (base?.status === "undecided") return { ...undecidedTarget(base, at), stated: { method, path } };
    return { target: complete({ method, ...(base === undefined ? {} : { base: base.value }), path }) };
  }

  /** The method and path a request writes, and the base it reaches; undefined when the snapshot does not decide the method or the path. */
  private requested(request: Request, scope: UrlScope): { method: HttpMethod; base?: Evaluated<string>; path: string } | undefined {
    const method = typeof request.method === "string" ? request.method : request.method === undefined ? undefined : this.methodOf(request.method, scope);
    const text = request.url === undefined ? undefined : this.text.of(request.url, scope);
    const resolved = text === undefined || method === undefined ? undefined : targetOf(text, request.base);
    return resolved === undefined || method === undefined ? undefined : { method, ...resolved };
  }

  /** The HTTP method an expression names: `HttpMethod.GET`, `RequestMethod.GET`, `HttpMethod.valueOf("get")` or a string. */
  private methodOf(node: Node, scope: UrlScope): HttpMethod | undefined {
    if (node.type === "identifier") {
      const closure = scope.env.get(node.text);
      if (closure !== undefined) return this.methodOf(closure.node, closure.scope);
    }
    const named = this.text.of(node, scope) ?? (node.type === "string_literal" ? stringLiteralValue(node.text) : node.type === "field_access" ? methodField(node) : node.type === "method_invocation" ? methodCall(node) : undefined);
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
      return declared.map(({ target, stated, diagnostic }) => {
        const span = spanOf(type.file.path, method.node);
        return placed({ repo, file: span.path, line: span.line, ...(span.endLine === span.line ? {} : { endLine: span.endLine }), symbol: `${type.qualifiedName}.${method.name}`, ancestors: ancestorsOf(method.node), transport: "http" as const, target: withEvidence(target, span), ...(diagnostic === undefined ? {} : { diagnostic }), ...(stated === undefined ? {} : { stated }) }, method.node, true);
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
    const origin = head === undefined ? undefined : url === undefined ? { origin: head, path: "/" } : callUrl(head);
    return (pathExpressions(lookup.mapping.attributes) ?? [undefined]).map((expression) => {
      const path = this.attributeText(expression, scope);
      if (path === undefined) return at;
      if (origin === undefined) return { ...at, stated: { method: verb, path: joinedCallUrl(prefix, path).path } };
      return origin.origin === undefined ? at : { target: complete({ method: verb, base: origin.origin, path: joinedCallUrl(origin.path, prefix, path).path }) };
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
        const url = joinedCallUrl(prefix, path);
        return complete({ method: verb, ...(url.origin === undefined ? {} : { base: url.origin }), path: url.path });
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

/**
 * The base and path a URL text comes down to; a path that only the code fills at run time is not decided. A relative
 * path under a client base the snapshot does not decide keeps its path, with that base undecided.
 */
function targetOf(text: string, client: Declared): { base?: Evaluated<string>; path: string } | undefined {
  if (text.startsWith(RUN_TIME_HOLE)) return undefined;
  const absolute = callUrl(text);
  const declared = client?.status === "known" ? callUrl(client.value) : { path: "/" };
  const origin = absolute.origin ?? declared.origin;
  const base = origin === undefined ? client : known(origin);
  const path = absolute.origin === undefined ? joinedCallUrl(declared.path, text).path : absolute.path;
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length > 0 && segments.every((segment) => segment === RUN_TIME_HOLE) ? undefined : { ...(base === undefined ? {} : { base }), path };
}
