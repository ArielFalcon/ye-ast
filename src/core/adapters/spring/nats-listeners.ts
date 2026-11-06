import type { Node } from "web-tree-sitter";
import type { Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { Handler } from "../../domain/entrypoints/http-route.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { CREATE_DISPATCHER, NATS_SUBSCRIBE_TYPES, SUBSCRIBE } from "./event-vocabulary.ts";
import { spanOf, unknown } from "./findings.ts";
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
    if (member === undefined || !isSubscription(invocation, project, text)) return [];
    const inherited = isLibraryPath(invocation.type.file.path);
    const span = inherited ? spanOf(type.file.path, type.node) : spanOf(invocation.type.file.path, member);
    const handler: Handler = { path: span.path, symbol: symbolOf({ ...invocation, type }), line: span.line };
    const argument = argumentsOf(invocation.node)[0];
    const destination = argument === undefined ? undefined : text.of(argument, { type: invocation.type, receiver: type, configurationFile: type.file, locals: invocation.locals, env: new Map() });
    if (destination === undefined) return [unknown("unresolved", [span, ...(argument === undefined || inherited ? [] : [spanOf(invocation.type.file.path, argument)])])];
    return [{ status: "complete" as const, value: { kind: "listener" as const, name: `nats ${destination}`, protocol: "nats" as const, destination, handler }, evidence: [span] }];
  });
}

function isSubscription(invocation: Invocation, project: JavaProject, text: JavaValueEvaluator): boolean {
  if (invocation.node.childForFieldName("name")?.text !== SUBSCRIBE) return false;
  const object = invocation.node.childForFieldName("object");
  const subscriber = object === null ? undefined : typeOf(object, invocation, project, text);
  return subscriber !== undefined && NATS_SUBSCRIBE_TYPES.has(subscriber);
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
