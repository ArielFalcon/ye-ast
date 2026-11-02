import type { Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { Handler } from "../../domain/entrypoints/http-route.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { NATS_SUBSCRIBE_TYPES, SUBSCRIBE } from "./event-vocabulary.ts";
import { spanOf, unknown } from "./findings.ts";
import { argumentsOf } from "./java-members.ts";
import { invocationsOf, receiverOf, type Invocation } from "./java-invocations.ts";
import type { JavaProject, TypeDecl } from "./java-symbols.ts";
import type { UrlText } from "./url-text.ts";

/**
 * The subjects a class consumes with the NATS client's own API, one listener per subscription. A listener a class inherits
 * from a base type no source declares is not read: the base holds the subject and its source is absent.
 */
export function natsListenersOf(type: TypeDecl, project: JavaProject, text: UrlText): Finding<Listener>[] {
  return invocationsOf(type).flatMap((invocation): Finding<Listener>[] => {
    const method = invocation.member;
    if (method?.type !== "method_declaration" || !isSubscription(invocation, project, text)) return [];
    const span = spanOf(type.file.path, method);
    const handler: Handler = { path: span.path, symbol: `${type.qualifiedName}.${method.childForFieldName("name")?.text ?? ""}`, line: span.line };
    const argument = argumentsOf(invocation.node)[0];
    const destination = argument === undefined ? undefined : text.of(argument, { type, locals: invocation.locals, env: new Map() });
    if (destination === undefined) return [unknown("unresolved", [span, ...(argument === undefined ? [] : [spanOf(type.file.path, argument)])])];
    return [{ status: "complete" as const, value: { kind: "listener" as const, name: `nats ${destination}`, protocol: "nats" as const, destination, handler }, evidence: [span] }];
  });
}

function isSubscription(invocation: Invocation, project: JavaProject, text: UrlText): boolean {
  if (invocation.node.childForFieldName("name")?.text !== SUBSCRIBE) return false;
  const object = invocation.node.childForFieldName("object");
  const receiver = object === null ? undefined : receiverOf(object, invocation, project, text);
  return receiver !== undefined && "fqn" in receiver.resolved && NATS_SUBSCRIBE_TYPES.has(receiver.resolved.fqn);
}
