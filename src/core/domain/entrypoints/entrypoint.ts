import type { Handler, HttpRoute } from "./http-route.ts";
import type { UiRoute } from "./ui-route.ts";

/** A method that consumes messages or events: `kafka <topic>`, `rabbit <queue>`, `jms <destination>`, `event <qualified type name>` or `nats <subject>`. */
export interface Listener {
  kind: "listener";
  name: string;
  protocol: "kafka" | "rabbit" | "jms" | "event" | "nats";
  /** The topic, queue, destination or subject it consumes, or the qualified name of the event type. */
  destination: string;
  handler: Handler;
}

/** A method run on a schedule, named `scheduled <attribute>=<value>` after the attribute that triggers it. */
export interface Job {
  kind: "job";
  name: string;
  trigger: { attribute: string; value: string };
  handler: Handler;
}

/** Code invoked by a framework through a library contract. */
export interface FrameworkCallback {
  kind: "callback";
  name: string;
  contract: { type: string; member?: string };
  handler: Handler;
}

/** The fully qualified contract label, with its member when present. */
export function callbackName(type: string, member?: string): string {
  return member === undefined ? type : `${type}.${member}`;
}

export type Entrypoint = HttpRoute | UiRoute | Listener | Job | FrameworkCallback;
