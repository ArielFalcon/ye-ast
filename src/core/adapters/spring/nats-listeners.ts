import type { Node } from "web-tree-sitter";
import type { Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { Handler } from "../../domain/entrypoints/http-route.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { CREATE_DISPATCHER, NATS_SUBSCRIBE_TYPES, SUBSCRIBE } from "./event-vocabulary.ts";
import { spanOf, subjectOf, unknown } from "./findings.ts";
import { argumentsOf } from "./java-members.ts";
import { invocationsOf, receiverOf, symbolOf, type Invocation } from "./java-invocations.ts";
import { isLibraryPath, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import type { JavaValueEvaluator } from "./java-value-evaluator.ts";

/**
 * The subjects a class consumes with the NATS client's own API, one listener per subscription, in a method or in a
 * constructor, which names the class itself. A listener a class inherits from a base type no source declares is not
 * read: the base holds the subject and its source is absent. A subscription a library base class holds is placed at the
 * concrete class, the one place of the repository that owns it.
 */
export function natsListenersOf(type: TypeDecl, project: JavaProject, text: JavaValueEvaluator): Finding<Listener>[] {
  return project.classChain(type).flatMap(invocationsOf).flatMap((invocation): Finding<Listener>[] => {
    const member = invocation.member;
    const subscriber = member === undefined ? undefined : subscriberOf(invocation, project, text);
    if (member === undefined || subscriber === undefined) return [];
    const inherited = isLibraryPath(invocation.type.file.path);
    const span = inherited ? spanOf(type.file.path, type.node) : spanOf(invocation.type.file.path, member);
    const handler: Handler = { path: span.path, symbol: symbolOf({ ...invocation, type }), line: span.line };
    const argument = argumentsOf(invocation.node)[0];
    const destination = argument === undefined ? undefined : text.of(argument, { type: invocation.type, receiver: type, configurationFile: type.file, locals: invocation.locals, env: new Map() });
    if (destination === undefined) return [unknown("unresolved", [span, ...(argument === undefined || inherited ? [] : [spanOf(invocation.type.file.path, argument)])], subjectOf("listener", handler.symbol, `${subscriber}.${SUBSCRIBE}`))];
    return [{ status: "complete" as const, value: { kind: "listener" as const, name: `nats ${destination}`, protocol: "nats" as const, destination, handler }, evidence: [span] }];
  });
}

/** The NATS client type a `subscribe` call is made on; none when the call is no subscription. */
function subscriberOf(invocation: Invocation, project: JavaProject, text: JavaValueEvaluator): string | undefined {
  if (invocation.node.childForFieldName("name")?.text !== SUBSCRIBE) return undefined;
  const object = invocation.node.childForFieldName("object");
  const subscriber = object === null ? undefined : typeOf(object, invocation, project, text);
  return subscriber !== undefined && NATS_SUBSCRIBE_TYPES.has(subscriber) ? subscriber : undefined;
}

/** The qualified type of a receiver: a field or a local, or the dispatcher a connection creates in place. */
function typeOf(object: Node, invocation: Invocation, project: JavaProject, text: JavaValueEvaluator): string | undefined {
  if (object.type === "method_invocation") {
    const owner = object.childForFieldName("object");
    const created = object.childForFieldName("name")?.text === CREATE_DISPATCHER.method && owner !== null && typeOf(owner, invocation, project, text) === CREATE_DISPATCHER.owner;
    return created ? CREATE_DISPATCHER.creates : undefined;
  }
  const receiver = receiverOf(object, invocation, project, text);
  return receiver !== undefined && "fqn" in receiver.resolved ? receiver.resolved.fqn : undefined;
}
