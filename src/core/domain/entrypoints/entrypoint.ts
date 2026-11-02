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

export type Entrypoint = HttpRoute | UiRoute | Listener | Job;
