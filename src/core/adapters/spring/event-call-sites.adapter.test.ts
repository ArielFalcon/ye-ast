import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { CallSite, CallSiteReader } from "../../domain/topology/call-site.ts";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaEventCallSites } from "./java-call-sites.adapter.ts";

const SERVICE = "org.springframework.stereotype.Service";

let reader: CallSiteReader;

test("Java event sites carry their actual named AST ancestors", async () => {
  const client = java("Orders", ["class Orders {", "  KafkaTemplate<String, String> kafka;", "  void send() {", "    kafka.send(\"orders\", \"x\");", "  }", "}"].join("\n"), ["org.springframework.kafka.core.KafkaTemplate"]);
  const [site] = await reader.of([client], "orders-svc");
  assert.deepEqual(site?.ancestors, [{ symbol: "send", line: 5, endLine: 7 }, { symbol: "Orders", line: 3, endLine: 8 }]);
});

before(async () => {
  reader = createJavaEventCallSites(await createJavaParser());
});

function file(path: string, content: string): { path: string; content: string } {
  return { path, content };
}

/** A class of package `app`; the body starts at line 3 + the number of imports. */
function java(name: string, body: string, imports: readonly string[]): { path: string; content: string } {
  return file(`src/main/java/app/${name}.java`, ["package app;", ...imports.map((entry) => `import ${entry};`), body].join("\n"));
}

function describe(sites: readonly CallSite[]): string[] {
  return sites.map((site) => {
    const where = `${site.symbol}@${site.file.split("/").pop()}:${site.line}`;
    if (site.target.status === "unknown") return `unknown ${where}${site.target.evidence[0]?.via === undefined ? "" : ` via ${site.target.evidence[0].via}`}`;
    const target = site.target.value;
    return "protocol" in target ? `${target.protocol} ${target.destination} ${where}` : `http ${target.method} ${target.path} ${where}`;
  });
}

async function read(files: readonly { path: string; content: string }[], libraries: readonly { path: string; content: string }[] = []): Promise<string[]> {
  return describe(await reader.of(files, "orders-svc", libraries));
}

test("a Kafka send names its topic in the first argument, whatever the key and value that follow", async () => {
  const orders = java(
    "Orders",
    ["@Service class Orders {", "  private final KafkaTemplate<String, String> kafka;", "  void created(String id) { kafka.send(\"orders.created\", id); }", "  void paid() { kafka.send(\"orders.paid\", \"1\", \"body\"); }", "}"].join("\n"),
    ["org.springframework.kafka.core.KafkaTemplate", SERVICE],
  );

  assert.deepEqual(await read([orders]), ["kafka orders.created Orders.created@Orders.java:6", "kafka orders.paid Orders.paid@Orders.java:7"]);
});

test("a Rabbit convertAndSend names the routing key: the first argument alone, the second when an exchange leads", async () => {
  const payments = java(
    "Payments",
    ["@Service class Payments {", "  private final RabbitTemplate rabbit;", "  void sent() { rabbit.convertAndSend(\"payments.sent\", body); }", "  void routed() { rabbit.convertAndSend(\"events\", \"payments.routed\", body); }", "}"].join("\n"),
    ["org.springframework.amqp.rabbit.core.RabbitTemplate", SERVICE],
  );

  assert.deepEqual(await read([payments]), ["rabbit payments.sent Payments.sent@Payments.java:6", "rabbit payments.routed Payments.routed@Payments.java:7"]);
});

test("a JMS convertAndSend and send both name the destination in the first argument", async () => {
  const audit = java(
    "Audit",
    ["@Service class Audit {", "  private final JmsTemplate jms;", "  void converted() { jms.convertAndSend(\"audit.log\", body); }", "  void sent() { jms.send(\"audit.log\", body); }", "}"].join("\n"),
    ["org.springframework.jms.core.JmsTemplate", SERVICE],
  );

  assert.deepEqual(await read([audit]), ["jms audit.log Audit.converted@Audit.java:6", "jms audit.log Audit.sent@Audit.java:7"]);
});

test("a Spring application event names its destination by the event type an instantiation or a declared name states", async () => {
  const events = java(
    "Events",
    ["@Service class Events {", "  private final ApplicationEventPublisher publisher;", "  void created() { publisher.publishEvent(new OrderCreated(\"1\")); }", "  void imported(OrderImported event) { publisher.publishEvent(event); }", "}"].join("\n"),
    ["org.springframework.context.ApplicationEventPublisher", SERVICE],
  );

  assert.deepEqual(await read([events, java("OrderCreated", "public class OrderCreated {}", []), java("OrderImported", "public class OrderImported {}", [])]), [
    "event app.OrderCreated Events.created@Events.java:6",
    "event app.OrderImported Events.imported@Events.java:7",
  ]);
});

test("a NATS publish names its subject in the first argument, with or without headers", async () => {
  const notifier = java(
    "Notifier",
    ["@Service class Notifier {", "  private final Connection connection;", "  void created() { connection.publish(\"orders.created\", body); }", "  void full() { connection.publish(\"orders.created\", headers, body); }", "}"].join("\n"),
    ["io.nats.client.Connection", SERVICE],
  );

  assert.deepEqual(await read([notifier]), ["nats orders.created Notifier.created@Notifier.java:6", "nats orders.created Notifier.full@Notifier.java:7"]);
});

test("a part the code fills at run time is a parameter of the destination, and a destination it does not state is unknown", async () => {
  const topics = java(
    "Topics",
    [
      "@Service class Topics {",
      "  private final KafkaTemplate<String, String> kafka;",
      "  private String undecided;",
      "  void created(String id) { kafka.send(\"orders.\" + id + \".created\", id); }",
      "  void other() { kafka.send(undecided, \"x\"); }",
      "  void filled() { kafka.send(String.format(\"%s\", undecided), \"x\"); }",
      "}",
    ].join("\n"),
    ["org.springframework.kafka.core.KafkaTemplate", SERVICE],
  );

  assert.deepEqual(await read([topics]), ["kafka orders.{}.created Topics.created@Topics.java:7", "unknown Topics.other@Topics.java:8", "unknown Topics.filled@Topics.java:9"]);
});

test("a publish through a messenger type from a library whose source is not given is a cut naming the library", async () => {
  const orders = java(
    "Orders",
    ["@Service class Orders {", "  private final AcmeMessenger messenger;", "  private final Cache cache;", "  void a() { messenger.publish(\"orders.created\", \"x\"); cache.get(\"x\"); }", "}"].join("\n"),
    [SERVICE, "com.acme.messaging.AcmeMessenger", "com.acme.util.Cache"],
  );

  assert.deepEqual(await read([orders]), ["unknown Orders.a@Orders.java:8 via com.acme.messaging.AcmeMessenger"]);
});

test("a publish that forwards its parameter into the destination is a wrapper: its callers are the call sites, and its own body is not", async () => {
  const wrapper = java("Messenger", ["@Service class Messenger {", "  private final KafkaTemplate<String, String> kafka;", "  void publish(String topic, String body) { kafka.send(topic, body); }", "}"].join("\n"), [
    "org.springframework.kafka.core.KafkaTemplate",
    SERVICE,
  ]);
  const caller = java("Orders", ["@Service class Orders {", "  private final Messenger messenger;", "  void created() { messenger.publish(\"orders.created\", \"x\"); }", "}"].join("\n"), [SERVICE]);

  assert.deepEqual(await read([wrapper, caller]), ["kafka orders.created Orders.created@Orders.java:5"]);
});

test("a messenger whose source is given is read through its wrapper, its callers making the calls", async () => {
  const library = [
    file(
      "src/main/java/com/acme/messaging/AcmeMessenger.java",
      ["package com.acme.messaging;", "import org.springframework.kafka.core.KafkaTemplate;", "public class AcmeMessenger {", "  private final KafkaTemplate<String, String> kafka;", '  public void announce(String topic) { kafka.send(topic, "x"); }', "}"].join("\n"),
    ),
  ];
  const orders = java("Orders", ["@Service class Orders {", "  private final AcmeMessenger messenger;", '  void a() { messenger.announce("orders.created"); }', "}"].join("\n"), [SERVICE, "com.acme.messaging.AcmeMessenger"]);

  assert.deepEqual(await read([orders], library), ["kafka orders.created Orders.a@Orders.java:6"]);
});

test("a wrapper nothing in the snapshot calls stays a cut at its publish", async () => {
  const wrapper = java("Messenger", ["@Service class Messenger {", "  private final KafkaTemplate<String, String> kafka;", "  void publish(String topic, String body) { kafka.send(topic, body); }", "}"].join("\n"), [
    "org.springframework.kafka.core.KafkaTemplate",
    SERVICE,
  ]);

  assert.deepEqual(await read([wrapper]), ["unknown Messenger.publish@Messenger.java:6"]);
});

test("test sources are not call sites", async () => {
  const test = file("src/test/java/app/OrdersTest.java", 'package app;\nimport org.springframework.kafka.core.KafkaTemplate;\nclass OrdersTest { KafkaTemplate<String, String> kafka; void a() { kafka.send("orders.created", "x"); } }');

  assert.deepEqual(await read([test]), []);
});

test("NATS method summaries read a source event subject through forwarding calls", async () => {
  const source = java("Publisher", `class Event { String getSubject() { return "catalog.created"; } }
    class Publisher { Connection connection;
      void leaf(Event event) { connection.publish(event.getSubject(), null); }
      void forward(Event event) { leaf(event); }
      void send() { forward(new Event()); }
    }`, ["io.nats.client.Connection"]);
  const sites = await reader.of([source], "service");
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.symbol, "Publisher.send");
  assert.deepEqual(sites[0]?.target.status === "complete" && sites[0].target.value, { protocol: "nats", destination: "catalog.created", role: "publish" });
});

test("event diagnostics distinguish unread wrapper sources from expanded destinations", async () => {
  const caller = java("Caller", 'class Caller { AcmeMessenger client; void load() { client.publish(); } }', ["com.acme.AcmeMessenger"]);
  const library = file("src/main/java/com/acme/AcmeMessenger.java", 'package com.acme; import io.nats.client.Connection; public class AcmeMessenger { Connection c; String topic; public void publish() { c.publish(topic, null); } }');
  const [missing] = await reader.of([caller], "app");
  const [read] = await reader.of([caller], "app", [library]);
  assert.deepEqual(missing?.diagnostic, { cause: "source-not-read", source: "not-read" });
  assert.deepEqual(read?.diagnostic, { cause: "destination-undecidable", source: "read" });
  assert.ok(read?.target.evidence.some(e => e.path.includes("(library)")));
});

test("event destinations retain recursion diagnosed inside a source getter", async () => {
  const source = java("Events", `class Events { Connection c;
    String topic() { return topic(); }
    void publish() { c.publish(topic(), null); }
  }`, ["io.nats.client.Connection"]);
  const [site] = await reader.of([source], "app");
  assert.equal(site?.diagnostic?.cause, "recursive");
});
