import type { EventTarget } from "../../domain/topology/call-site.ts";

/** A client that publishes a message: the protocol it speaks and the argument each method names the destination in. */
export interface PublishClient {
  protocol: EventTarget["protocol"];
  /** The index of the destination argument, from the call's arity. */
  destinations: ReadonlyMap<string, (arity: number) => number>;
  /** The index of the argument that names the exchange, from the call's arity; none when the call names no exchange. */
  exchange?: (arity: number) => number | undefined;
  /** The destination is the qualified type of the argument, not the text it holds. */
  byType?: true;
}

const FIRST = (): number => 0;
/** Rabbit's two forms: `convertAndSend(routingKey, object)` and `convertAndSend(exchange, routingKey, object)`. */
const ROUTING_KEY = (arity: number): number => (arity >= 3 ? 1 : 0);
const EXCHANGE = (arity: number): number | undefined => (arity >= 3 ? 0 : undefined);

export const PUBLISH_CLIENTS: ReadonlyMap<string, PublishClient> = new Map([
  ["org.springframework.kafka.core.KafkaTemplate", { protocol: "kafka", destinations: new Map([["send", FIRST]]) }],
  ["org.springframework.kafka.core.KafkaOperations", { protocol: "kafka", destinations: new Map([["send", FIRST]]) }],
  ["org.springframework.amqp.rabbit.core.RabbitTemplate", { protocol: "rabbit", destinations: new Map([["convertAndSend", ROUTING_KEY]]), exchange: EXCHANGE }],
  ["org.springframework.amqp.core.AmqpTemplate", { protocol: "rabbit", destinations: new Map([["convertAndSend", ROUTING_KEY]]), exchange: EXCHANGE }],
  [
    "org.springframework.jms.core.JmsTemplate",
    {
      protocol: "jms",
      destinations: new Map([
        ["convertAndSend", FIRST],
        ["send", FIRST],
      ]),
    },
  ],
  ["org.springframework.jms.core.JmsMessagingTemplate", { protocol: "jms", destinations: new Map([["convertAndSend", FIRST]]) }],
  ["org.springframework.context.ApplicationEventPublisher", { protocol: "event", destinations: new Map([["publishEvent", FIRST]]), byType: true }],
  ["io.nats.client.Connection", { protocol: "nats", destinations: new Map([["publish", FIRST]]) }],
  ["io.nats.client.JetStream", { protocol: "nats", destinations: new Map([["publish", FIRST]]) }],
  ["io.nats.client.JetStreamContext", { protocol: "nats", destinations: new Map([["publish", FIRST]]) }],
]);

/** The clients whose `subscribe` consumes a subject, which their first argument names; a `Dispatcher` delivers asynchronously. */
export const NATS_SUBSCRIBE_TYPES: ReadonlySet<string> = new Set(["io.nats.client.Connection", "io.nats.client.Dispatcher", "io.nats.client.JetStream", "io.nats.client.JetStreamContext"]);

export const SUBSCRIBE = "subscribe";

/** The connection method that creates a `Dispatcher` in place: `connection.createDispatcher().subscribe(subject)`. */
export const CREATE_DISPATCHER = { owner: "io.nats.client.Connection", method: "createDispatcher", creates: "io.nats.client.Dispatcher" } as const;

/** The method names a messenger publishes with; a call through a type whose source is unknown is a cut naming it. */
export const PUBLISH_METHOD_NAME = /^(publish|send|emit|dispatch|produce)/;

/** The names a type that publishes messages carries: a messenger, a bus, a publisher, a broker's own client. */
export const EVENT_CLIENT_NAME = /(Messenger|EventBus|EventPublisher|Publisher|Producer|Broker|Nats|Kafka|Rabbit|Jms)/;
