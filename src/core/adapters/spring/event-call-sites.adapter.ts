import type { UrlScope } from "./java-values.ts";
import { JavaMethodFlow, reachedTarget, type Reading } from "./java-method-flow.ts";
import type { Node } from "web-tree-sitter";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import { compareCallSites, type CallSite, type CallSiteDiagnostic, type EventTarget } from "../../domain/topology/call-site.ts";
import type { Configuration } from "./application-config.ts";
import { EVENT_CLIENT_NAME, PUBLISH_CLIENTS, PUBLISH_METHOD_NAME, type PublishClient } from "./event-vocabulary.ts";
import { complete, placed, spanOf, unknown, withEvidence } from "./findings.ts";
import { argumentsOf, typeNameOf } from "./java-members.ts";
import { ancestorsOf, receiverOf, symbolOf, type Invocation } from "./java-invocations.ts";
import { qualifiedTypeName, scopeOf, type JavaFile, type JavaProject } from "./java-symbols.ts";
import { JavaValueEvaluator } from "./java-value-evaluator.ts";
import { RUN_TIME_HOLE } from "../../domain/topology/path-template.ts";
import { undecidedTarget } from "../../domain/topology/evaluated.ts";
import { statesDestination } from "../../domain/topology/event-destination.ts";

/** One publish call: where it is written, the client that publishes, the argument that names the destination and the one that names the exchange. */
interface Publish {
  invocation: Invocation;
  client: PublishClient;
  argument: Node;
  exchange?: Node;
}

/** The exchange the broker routes through when the code names none, or names it empty. */
const DEFAULT_EXCHANGE = "";

/** The messages a Java snapshot publishes: one call site per publish of a client the vocabulary knows. */
export class JavaEventReader {
  private readonly text: JavaValueEvaluator;

  constructor(
    private readonly project: JavaProject,
    configuration: (file: JavaFile) => Configuration,
    private readonly owned: ReadonlySet<JavaFile>,
  ) {
    this.text = new JavaValueEvaluator(project, configuration);
  }

  sites(repo: string): CallSite[] {
    const found: CallSite[] = [];
    const flow = new JavaMethodFlow<Publish>(this.project, this.text, (call) => this.publishOf(call));
    for (const invocation of flow.invocations.filter((call) => this.owned.has(call.type.file))) {
      if (flow.nested(invocation)) continue;
      const scope = this.scopeOf(invocation, new Map());
      const direct = this.publishOf(invocation);
      if (direct !== undefined) {
        const read = this.target(direct, scope);
        found.push(this.siteOf(repo, invocation, read.target, read.diagnostic));
        continue;
      }
      const expanded = flow.expand(invocation, scope);
      if (expanded !== undefined) {
        for (const group of expanded) {
          const reached = reachedTarget(invocation, group, group.map(({ leaf, scope }) => this.target(leaf, scope)), this.owned);
          found.push(this.siteOf(repo, invocation, reached.target, reached.diagnostic));
        }
      } else {
        const library = this.libraryOf(invocation);
        if (library !== undefined) found.push(this.siteOf(repo, invocation, unknown("unresolved", [{ ...spanOf(invocation.type.file.path, invocation.node), via: library.via }, ...library.evidence]), { cause: library.source === "read" ? "request-not-found" : "source-not-read", source: library.source }));
      }
    }
    return found.sort(compareCallSites);
  }

  private scopeOf(invocation: Invocation, env: UrlScope["env"]): UrlScope {
    return { type: invocation.type, locals: invocation.locals, env };
  }

  private siteOf(repo: string, invocation: Invocation, target: Finding<EventTarget>, diagnostic?: CallSiteDiagnostic): CallSite {
    const span = spanOf(invocation.type.file.path, invocation.node);
    return placed({ repo, file: span.path, line: span.line, ...(span.endLine === span.line ? {} : { endLine: span.endLine }), symbol: symbolOf(invocation), ancestors: ancestorsOf(invocation.node), transport: "event", target: withEvidence(target, span), ...(target.status === "unknown" ? { diagnostic: diagnostic ?? { cause: "destination-undecidable" } } : {}) }, invocation.node);
  }

  /** The publish a call makes, when its receiver is a client the vocabulary knows and its method names a destination. */
  private publishOf(invocation: Invocation): Publish | undefined {
    const { node } = invocation;
    const object = node.childForFieldName("object");
    if (object === null) return undefined;
    const receiver = receiverOf(object, invocation, this.project, this.text);
    if (receiver === undefined || !("fqn" in receiver.resolved)) return undefined;
    const client = PUBLISH_CLIENTS.get(receiver.resolved.fqn);
    const destination = client?.destinations.get(node.childForFieldName("name")?.text ?? "");
    if (client === undefined || destination === undefined) return undefined;
    const args = argumentsOf(node);
    const argument = args[destination(args.length)];
    const exchangeAt = client.exchange?.(args.length);
    const exchange = exchangeAt === undefined ? undefined : args[exchangeAt];
    return argument === undefined ? undefined : { invocation, client, argument, ...(exchange === undefined ? {} : { exchange }) };
  }

  /** The library a publish goes through when the sources of its client type are not read to the destination. */
  private libraryOf(invocation: Invocation): { via: string; source: "read" | "not-read"; evidence: readonly Evidence[] } | undefined {
    if (!PUBLISH_METHOD_NAME.test(invocation.node.childForFieldName("name")?.text ?? "")) return undefined;
    const object = invocation.node.childForFieldName("object");
    const receiver = object === null ? undefined : receiverOf(object, invocation, this.project, this.text);
    if (receiver === undefined) return undefined;
    const { resolved } = receiver;
    if ("decl" in resolved) return !this.owned.has(resolved.decl.file) && EVENT_CLIENT_NAME.test(resolved.decl.name) ? { via: resolved.decl.fqn, source: "read", evidence: [spanOf(resolved.decl.file.path, resolved.decl.node)] } : undefined;
    return !this.project.isPlatformName(resolved.fqn) && EVENT_CLIENT_NAME.test(simpleNameOf(resolved.fqn)) ? { via: resolved.fqn, source: "not-read", evidence: [] } : undefined;
  }

  private target(publish: Publish, scope: UrlScope): Reading<EventTarget> {
    const destination = this.text.evaluated(scope, () => this.destination(publish, scope));
    return destination.status === "undecided"
      ? undecidedTarget(destination, spanOf(publish.invocation.type.file.path, publish.invocation.node))
      : { target: complete({ protocol: publish.client.protocol, destination: destination.value, role: "publish", ...this.exchangeOf(publish, scope) }) };
  }

  /** The exchange a publish names, unless it is the default one; `{}` when the snapshot does not decide it. */
  private exchangeOf(publish: Publish, scope: UrlScope): { exchange?: string } {
    if (publish.exchange === undefined) return {};
    const exchange = this.text.of(publish.exchange, scope) ?? RUN_TIME_HOLE;
    return exchange === DEFAULT_EXCHANGE ? {} : { exchange };
  }

  /** The destination a publish names, `{}` for a part the code fills at run time; undefined when it names none. */
  private destination(publish: Publish, scope: UrlScope): string | undefined {
    if (publish.client.byType === true) return this.eventType(publish.argument, scope);
    const text = this.text.of(publish.argument, scope);
    return text === undefined || !statesDestination(text, publish.client.protocol) ? undefined : text;
  }

  /** The qualified type of an event expression: an instantiation, or a name whose declared type the sources state. */
  private eventType(argument: Node, scope: UrlScope): string | undefined {
    if (argument.type === "object_creation_expression") return qualifiedTypeName(typeNameOf(argument.childForFieldName("type")), scopeOf(scope.type), this.project);
    if (argument.type !== "identifier") return undefined;
    const closure = scope.env.get(argument.text);
    if (closure !== undefined) return this.eventType(closure.node, closure.scope);
    const local = scope.locals.get(argument.text);
    if (local !== undefined) return qualifiedTypeName(local.typeName, scopeOf(scope.type), this.project);
    const field = this.text.fieldOf(scope.type, argument.text);
    return field === undefined ? undefined : qualifiedTypeName(field.binding.typeName, scopeOf(field.owner), this.project);
  }
}

function simpleNameOf(fqn: string): string {
  return fqn.slice(fqn.lastIndexOf(".") + 1);
}
