import { JavaMethodFlow } from "./java-method-flow.ts";
import type { Node } from "web-tree-sitter";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { CallSite, EventTarget } from "../../domain/topology/call-site.ts";
import type { Configuration } from "./application-config.ts";
import { EVENT_CLIENT_NAME, PUBLISH_CLIENTS, PUBLISH_METHOD_NAME, type PublishClient } from "./event-vocabulary.ts";
import { complete, spanOf, unknownAtNode, withEvidence } from "./findings.ts";
import { argumentsOf, typeNameOf } from "./java-members.ts";
import { ancestorsOf, receiverOf, symbolOf, type Invocation } from "./java-invocations.ts";
import { qualifiedTypeName, scopeOf, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import { PLACEHOLDER, UrlText, type UrlScope } from "./url-text.ts";

/** One publish call: where it is written, the client that publishes and the argument that names the destination. */
interface Publish {
  invocation: Invocation;
  client: PublishClient;
  argument: Node;
}



const TOKEN_SEPARATOR = ".";

/** The messages a Java snapshot publishes: one call site per publish of a client the vocabulary knows. */
export class JavaEventReader {
  private readonly text: UrlText;

  constructor(
    private readonly project: JavaProject,
    configuration: (file: JavaFile) => Configuration,
    private readonly owned: ReadonlySet<JavaFile>,
  ) {
    this.text = new UrlText(project, configuration);
  }

  sites(repo: string): CallSite[] {
    const found: CallSite[] = [];
    const flow = new JavaMethodFlow<Publish>(this.project, this.text, (call) => this.publishOf(call));
    for (const invocation of flow.invocations.filter((call) => this.owned.has(call.type.file))) {
      if (flow.nested(invocation)) continue;
      const scope = this.scopeOf(invocation, new Map());
      const direct = this.publishOf(invocation);
      if (direct !== undefined) {
        found.push(this.siteOf(repo, invocation, this.target(direct, scope)));
        continue;
      }
      const expanded = flow.expand(invocation, scope);
      if (expanded !== undefined) {
        const values = expanded.map(({ leaf, scope }) => this.target(leaf, scope));
        const signatures = new Set(values.map((value) => JSON.stringify(value.status === "unknown" ? value.status : value.value)));
        const target = signatures.size === 1 ? values[0] : unknownAtNode(invocation.type.file.path, invocation.node);
        if (target !== undefined) found.push(this.siteOf(repo, invocation, target));
      } else {
        const library = this.libraryOf(invocation);
        if (library !== undefined) found.push(this.siteOf(repo, invocation, unknownAtNode(invocation.type.file.path, invocation.node, library)));
      }
    }
    return found.sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol) || compareText(a.target.status, b.target.status));
  }

  private scopeOf(invocation: Invocation, env: UrlScope["env"]): UrlScope {
    return { type: invocation.type, locals: invocation.locals, env };
  }

  private siteOf(repo: string, invocation: Invocation, target: Finding<EventTarget>): CallSite {
    const span = spanOf(invocation.type.file.path, invocation.node);
    return { repo, file: span.path, line: span.line, ...(span.endLine === span.line ? {} : { endLine: span.endLine }), symbol: symbolOf(invocation), ancestors: ancestorsOf(invocation.node), transport: "event", target: withEvidence(target, span) };
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
    return argument === undefined ? undefined : { invocation, client, argument };
  }

  /** The library a publish goes through when the sources of its client type are not read to the destination. */
  private libraryOf(invocation: Invocation): string | undefined {
    if (!PUBLISH_METHOD_NAME.test(invocation.node.childForFieldName("name")?.text ?? "")) return undefined;
    const object = invocation.node.childForFieldName("object");
    const receiver = object === null ? undefined : receiverOf(object, invocation, this.project, this.text);
    if (receiver === undefined) return undefined;
    const { resolved } = receiver;
    if ("decl" in resolved) return !this.owned.has(resolved.decl.file) && EVENT_CLIENT_NAME.test(resolved.decl.name) ? resolved.decl.fqn : undefined;
    return !this.project.isPlatformName(resolved.fqn) && EVENT_CLIENT_NAME.test(simpleNameOf(resolved.fqn)) ? resolved.fqn : undefined;
  }

  private target(publish: Publish, scope: UrlScope): Finding<EventTarget> {
    const destination = this.destination(publish, scope);
    return destination === undefined
      ? unknownAtNode(publish.invocation.type.file.path, publish.invocation.node)
      : complete({ protocol: publish.client.protocol, destination, role: "publish" });
  }

  /** The destination a publish names, `{}` for a part the code fills at run time; undefined when it names none. */
  private destination(publish: Publish, scope: UrlScope): string | undefined {
    if (publish.client.byType === true) return this.eventType(publish.argument, scope);
    const text = this.text.of(publish.argument, scope);
    return text === undefined || text.split(TOKEN_SEPARATOR).every((token) => token === PLACEHOLDER) ? undefined : text;
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
