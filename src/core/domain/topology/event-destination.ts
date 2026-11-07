import type { Listener } from "../entrypoints/entrypoint.ts";
import type { EventTarget } from "./call-site.ts";
import { CANNOT_MATCH, COULD_MATCH, destinationSegments, isRunTimeValue, literalText, mayHold, mayShare, unify, type TemplateSegment, type Unification } from "./path-template.ts";

/** How a protocol names its destinations and delivers a message, as data the join reads. */
interface DestinationGrammar {
  /** Where a published message is delivered: in the publishing repository's own process, or to other repositories. */
  reach: "same-repository" | "other-repositories";
  /** The text between a destination's tokens; without one, a destination is a single name. */
  separator?: string;
  /** The listener tokens that stand for exactly one token, and for one or more trailing tokens. */
  wildcards?: { one: string; rest: string };
  /** A token the publisher fills at run time takes any one listener token (RFC-0011 decision 9). */
  runTimeTokenTakesAny?: true;
  /** A message published to a named exchange reaches a queue only through bindings the snapshot does not read. */
  routedByExchange?: true;
}

const GRAMMARS: Readonly<Record<EventTarget["protocol"], DestinationGrammar>> = {
  nats: { reach: "other-repositories", separator: ".", wildcards: { one: "*", rest: ">" }, runTimeTokenTakesAny: true },
  kafka: { reach: "other-repositories" },
  rabbit: { reach: "other-repositories", routedByExchange: true },
  jms: { reach: "other-repositories" },
  event: { reach: "same-repository" },
};

const TAKEN: Unification = { outcome: "matches", literals: 1, parity: false };

/** Whether a protocol delivers what one repository publishes to the listeners of another, or of the same one. */
export function delivers(protocol: EventTarget["protocol"], publishing: string, listening: string): boolean {
  return GRAMMARS[protocol].reach === "same-repository" ? publishing === listening : publishing !== listening;
}

/** Whether a destination states any text of its own: one made only of values the code fills at run time names none. */
export function statesDestination(destination: string, protocol: EventTarget["protocol"]): boolean {
  return destinationSegments(destination, GRAMMARS[protocol].separator).some((segment) => !isRunTimeValue(segment));
}

/** Whether a listener consumes a published message: it does, it could depending on values filled at run time, or it cannot. */
export function consumption(target: EventTarget, listener: Listener): Unification["outcome"] {
  if (listener.protocol !== target.protocol) return "cannot-match";
  const grammar = GRAMMARS[target.protocol];
  if (grammar.routedByExchange === true && target.exchange !== undefined) return "could-match";
  const published = destinationSegments(target.destination, grammar.separator);
  const consumed = destinationSegments(listener.destination, grammar.separator, grammar.wildcards);
  return unify(published, consumed, (own, held) => unifyToken(own, held, grammar)).outcome;
}

/**
 * A published token against a listener's: a wildcard takes any; two texts match when equal; a value the code fills on
 * either side could be the other's text when what it states around the value agrees, and the publisher's whole run-time
 * token takes any text under the protocol's rule.
 */
function unifyToken(own: TemplateSegment, held: TemplateSegment, grammar: DestinationGrammar): Unification {
  if (held.kind !== "parts") return TAKEN;
  const [ownText, heldText] = [literalText(own), literalText(held)];
  if (ownText !== undefined && heldText !== undefined) return ownText === heldText ? TAKEN : CANNOT_MATCH;
  if (heldText !== undefined) return isRunTimeValue(own) && grammar.runTimeTokenTakesAny === true ? TAKEN : mayHold(own, heldText) ? COULD_MATCH : CANNOT_MATCH;
  if (ownText !== undefined) return mayHold(held, ownText) ? COULD_MATCH : CANNOT_MATCH;
  return mayShare(own, held) ? COULD_MATCH : CANNOT_MATCH;
}
