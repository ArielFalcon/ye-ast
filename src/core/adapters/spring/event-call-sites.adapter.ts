import type { Node } from "web-tree-sitter";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { CallSite, EventTarget } from "../../domain/topology/call-site.ts";
import type { Configuration } from "./application-config.ts";
import { EVENT_CLIENT_NAME, PUBLISH_CLIENTS, PUBLISH_METHOD_NAME, type PublishClient } from "./event-vocabulary.ts";
import { complete, spanOf, unknownAtNode, withEvidence } from "./findings.ts";
import { argumentsOf, typeNameOf } from "./java-members.ts";
import { ancestorsOf, holdersOf, invocationsOf, parametersOf, receiverOf, referencesParameter, symbolOf, type Invocation } from "./java-invocations.ts";
import { isPlatformName, qualifiedTypeName, scopeOf, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import { PLACEHOLDER, UrlText, type UrlScope } from "./url-text.ts";

/** One publish call: where it is written, the client that publishes and the argument that names the destination. */
interface Publish {
  invocation: Invocation;
  client: PublishClient;
  argument: Node;
}

interface Wrapper {
  publish: Publish;
  parameters: readonly string[];
  called: boolean;
}

const TOKEN_SEPARATOR = ".";

/** The messages a Java snapshot publishes: one call site per publish of a client the vocabulary knows. */
export class JavaEventReader {
  private readonly text: UrlText;
  private readonly wrappers = new Map<TypeDecl, Map<string, Wrapper>>();

  constructor(
    private readonly project: JavaProject,
    configuration: (file: JavaFile) => Configuration,
    private readonly owned: ReadonlySet<JavaFile>,
  ) {
    this.text = new UrlText(project, configuration);
  }

  sites(repo: string): CallSite[] {
    const found: CallSite[] = [];
    const invocations = this.project.types.flatMap((type) => invocationsOf(type));
    for (const invocation of invocations) {
      const publish = this.publishOf(invocation);
      if (publish === undefined) continue;
      const wrapper = this.wrapperOf(publish);
      if (wrapper !== undefined) {
        const held = this.wrappers.get(invocation.type) ?? new Map<string, Wrapper>();
        held.set(wrapper.key, wrapper.wrapper);
        this.wrappers.set(invocation.type, held);
      } else if (this.owned.has(invocation.type.file)) {
        found.push(this.siteOf(repo, invocation, this.target(publish, this.scopeOf(invocation, new Map()))));
      }
    }
    for (const invocation of invocations.filter(({ type }) => this.owned.has(type.file))) {
      const called = this.callOfWrapper(invocation);
      if (called !== undefined) found.push(this.siteOf(repo, invocation, called));
      else {
        const library = this.libraryOf(invocation);
        if (library !== undefined) found.push(this.siteOf(repo, invocation, unknownAtNode(invocation.type.file.path, invocation.node, library)));
      }
    }
    for (const wrappers of this.wrappers.values()) {
      for (const wrapper of wrappers.values()) {
        const { invocation } = wrapper.publish;
        if (!wrapper.called && this.owned.has(invocation.type.file)) found.push(this.siteOf(repo, invocation, unknownAtNode(invocation.type.file.path, invocation.node)));
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

  /** A publish whose destination only a parameter of its own method decides is a wrapper: its callers make the calls. */
  private wrapperOf(publish: Publish): { key: string; wrapper: Wrapper } | undefined {
    const { invocation } = publish;
    const member = invocation.member;
    if (member?.type !== "method_declaration") return undefined;
    if (this.destination(publish, this.scopeOf(invocation, new Map())) !== undefined) return undefined;
    if (!referencesParameter(publish.argument, invocation)) return undefined;
    const parameters = parametersOf(member);
    return { key: `${member.childForFieldName("name")?.text}/${parameters.length}`, wrapper: { publish, parameters, called: false } };
  }

  /** The target of a call to a wrapper, read with its parameters bound to the call's arguments. */
  private callOfWrapper(invocation: Invocation): Finding<EventTarget> | undefined {
    const { node } = invocation;
    const name = node.childForFieldName("name")?.text ?? "";
    const args = argumentsOf(node);
    for (const holder of holdersOf(node.childForFieldName("object"), invocation, this.project, this.text)) {
      const wrapper = this.wrappers.get(holder)?.get(`${name}/${args.length}`);
      if (wrapper === undefined) continue;
      wrapper.called = true;
      const env = new Map(wrapper.parameters.flatMap((parameter, index) => (args[index] === undefined ? [] : [[parameter, { node: args[index] as Node, scope: this.scopeOf(invocation, new Map()) }] as const])));
      const target = this.target(wrapper.publish, this.scopeOf(wrapper.publish.invocation, env));
      const declaring = wrapper.publish.invocation.type;
      return target.status === "unknown" && !this.owned.has(declaring.file) ? unknownAtNode(declaring.file.path, node, declaring.fqn) : target;
    }
    return undefined;
  }

  /** The library a publish goes through when the sources of its client type are not read to the destination. */
  private libraryOf(invocation: Invocation): string | undefined {
    if (!PUBLISH_METHOD_NAME.test(invocation.node.childForFieldName("name")?.text ?? "")) return undefined;
    const object = invocation.node.childForFieldName("object");
    const receiver = object === null ? undefined : receiverOf(object, invocation, this.project, this.text);
    if (receiver === undefined) return undefined;
    const { resolved } = receiver;
    if ("decl" in resolved) return !this.owned.has(resolved.decl.file) && EVENT_CLIENT_NAME.test(resolved.decl.name) ? resolved.decl.fqn : undefined;
    return !isPlatformName(resolved.fqn) && EVENT_CLIENT_NAME.test(simpleNameOf(resolved.fqn)) ? resolved.fqn : undefined;
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
