import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Finding } from "../../domain/shared/fact.ts";
import type { ContractOperation, ContractRoutes } from "../../ports/contract-routes.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { rememberingFacts } from "./remembering-facts.testing.ts";
import { createSpringRoutesExtractor } from "./spring-routes.adapter.ts";

const WEB = "import org.springframework.web.bind.annotation.*;";
const source = (name: string, body: string): SourceFile => ({ path: `src/main/java/app/${name}.java`, content: `package app;\n${WEB}\n${body}\n` });

const MAIN = source("Main", "@org.springframework.boot.autoconfigure.SpringBootApplication public class Main {}");
const BASE = source("Base", `@RequestMapping("/v1") abstract class Base {}`);
const ORDERS = source("Orders", `@RestController class Orders extends Base { @GetMapping("/orders") void list() {} }`);
const ITEMS = source("Items", `@RestController @RequestMapping("/items") class Items { @GetMapping("/{id}") void one() {} }`);
const LOST = source("Lost", `@RestController class Lost extends Missing { @GetMapping("/lost") void lost() {} }`);
const PLAIN = source("Plain", `class Plain { int count; }`);
const CONFIG = { path: "src/main/resources/application.yml", content: "server.servlet.context-path: /shop\n" };
const KEPT = [MAIN, BASE, ORDERS, ITEMS, LOST, PLAIN, CONFIG];
const JAVA = KEPT.filter(({ path }) => path.endsWith(".java"));

const operation = (operationId: string, path: string, basePath: string | null = ""): Finding<ContractOperation> => ({
  status: "complete",
  value: { operationId, method: "POST", path, basePath: basePath ?? undefined, document: "api/openapi.yaml", line: 3, data: { request: "", response: "", files: [], unresolved: [] } },
  evidence: [{ path: "api/openapi.yaml", line: 3 }],
});
const contractOf = (operations: readonly Finding<ContractOperation>[]): ContractRoutes => ({ operations: () => operations });
const HANDLER = source("Handler", `@RestController class Handler implements OrdersApi { @Override public void createOrder() {} }`);

async function readKept(facts: ReturnType<typeof rememberingFacts>, files: readonly SourceFile[], contracts?: ContractRoutes) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return (await createSpringRoutesExtractor(await createJavaParser(holds), contracts).extract(files, [], { hold, facts })).findings;
  } finally {
    hold.release();
  }
}

const cold = async (files: readonly SourceFile[], contracts?: ContractRoutes) => (await createSpringRoutesExtractor(await createJavaParser(), contracts).extract(files)).findings;
const plain = (findings: unknown): unknown => JSON.parse(JSON.stringify(findings));
const edited = (file: SourceFile, replace: [string, string]): SourceFile => ({ ...file, content: file.content.replace(...replace) });
const turn = (facts: ReturnType<typeof rememberingFacts>) => facts.readsOf("java-entrypoints");
const routesOf = (findings: readonly Finding<unknown>[]) => findings.flatMap((finding) => (finding.status === "complete" && (finding.value as { kind: string }).kind === "http-route" ? [(finding.value as { path: string }).path] : [])).sort();

test("the entrypoints kept per file answer the bytes a cold read gives, and a second read of the same sources derives none", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, KEPT);
  assert.deepEqual(plain(first), plain(await cold(KEPT)));
  assert.deepEqual(routesOf(first), ["/items/{id}", "/v1/orders"]);
  assert.ok(first.some((finding) => finding.status === "unknown"));
  assert.deepEqual(turn(facts), { hits: 0, misses: JAVA.length });
  assert.deepEqual(plain(await readKept(facts, KEPT)), plain(first));
  assert.deepEqual(turn(facts), { hits: JAVA.length, misses: JAVA.length });
});

test("an edit to a file no derivation read derives that file alone", async () => {
  const facts = rememberingFacts();
  await readKept(facts, KEPT);
  const sources = KEPT.map((file) => (file === ITEMS ? edited(ITEMS, ["void one() {}", "void one() { int sum = 1; }"]) : file));
  assert.deepEqual(plain(await readKept(facts, sources)), plain(await cold(sources)));
  assert.deepEqual(turn(facts), { hits: JAVA.length - 1, misses: JAVA.length + 1 });
});

test("an edit to the class mapping a subclass inherits derives the subclass, and no other file", async () => {
  const facts = rememberingFacts();
  await readKept(facts, KEPT);
  const sources = KEPT.map((file) => (file === BASE ? edited(BASE, ["/v1", "/v2"]) : file));
  const after = await readKept(facts, sources);
  assert.deepEqual(plain(after), plain(await cold(sources)));
  assert.deepEqual(routesOf(after), ["/items/{id}", "/v2/orders"]);
  assert.deepEqual(turn(facts), { hits: JAVA.length - 2, misses: JAVA.length + 2 });
});

test("a file that appears and declares a supertype a derivation asked about and found nowhere derives that file", async () => {
  const facts = rememberingFacts();
  const before = await readKept(facts, KEPT);
  assert.ok(!routesOf(before).includes("/m/lost"));
  const sources = [...KEPT, source("Missing", `@RequestMapping("/m") abstract class Missing {}`)];
  const after = await readKept(facts, sources);
  assert.deepEqual(plain(after), plain(await cold(sources)));
  assert.ok(routesOf(after).includes("/m/lost"));
  assert.deepEqual(turn(facts), { hits: JAVA.length - 1, misses: JAVA.length + 2 });
});

test("a source that does not parse answers its unreadable item alone and derives no file", async () => {
  const facts = rememberingFacts();
  const before = await readKept(facts, KEPT);
  const sources = [...KEPT, source("Broken", "class {")];
  const after = await readKept(facts, sources);
  assert.deepEqual(plain(after), plain(await cold(sources)));
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(turn(facts), { hits: JAVA.length, misses: JAVA.length });
});

test("a file that may set a path prefix or a base path reaches every route through the merge, and the other files hit", async () => {
  const facts = rememberingFacts();
  await readKept(facts, KEPT);
  const prefix = source("Prefix", `class Prefix { void configure(PathMatchConfigurer configurer) { configurer.addPathPrefix("/api", type -> true); } }`);
  const prefixed = [...KEPT, prefix];
  const unknownPrefixed = await readKept(facts, prefixed);
  assert.deepEqual(plain(unknownPrefixed), plain(await cold(prefixed)));
  assert.deepEqual(routesOf(unknownPrefixed), []);
  assert.deepEqual(turn(facts), { hits: JAVA.length, misses: JAVA.length + 1 });
  const base = source("Context", `class Context { void run(Object app) { setContextPath("/x"); } }`);
  const based = [...KEPT, base];
  assert.deepEqual(plain(await readKept(facts, based)), plain(await cold(based)));
  assert.deepEqual(turn(facts), { hits: JAVA.length * 2, misses: JAVA.length + 2 });
});

test("the contract operations a file joined are part of what keeps it: an edit to them derives every file", async () => {
  const facts = rememberingFacts();
  const sources = [MAIN, HANDLER, ITEMS];
  const joined = contractOf([operation("createOrder", "/orders")]);
  const first = await readKept(facts, sources, joined);
  assert.deepEqual(routesOf(first), ["/items/{id}", "/orders"]);
  const moved = contractOf([operation("createOrder", "/purchases")]);
  const second = await readKept(facts, sources, moved);
  assert.deepEqual(plain(second), plain(await cold(sources, moved)));
  assert.deepEqual(routesOf(second), ["/items/{id}", "/purchases"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: 6 });
});

const GENERATED = source("Pets", `@org.springframework.stereotype.Service class Pets implements com.acme.gen.PetsApi { public void list() {} }`);
const pom = (plugin: string): SourceFile => ({ path: "pom.xml", content: `<project>\n  <build>\n    <plugins>\n      <plugin>\n        <groupId>org.openapitools</groupId>\n        <artifactId>${plugin}</artifactId>\n      </plugin>\n    </plugins>\n  </build>\n</project>` });

test("the source generator a build file declares is part of what keeps a file: an edit to the build derives the files it reaches", async () => {
  const facts = rememberingFacts();
  const without = [MAIN, GENERATED, pom("spring-boot-maven-plugin")];
  const before = await readKept(facts, without);
  const generating = [MAIN, GENERATED, pom("openapi-generator-maven-plugin")];
  const after = await readKept(facts, generating);
  assert.deepEqual(plain(after), plain(await cold(generating)));
  assert.notDeepEqual(plain(after), plain(before));
  assert.deepEqual(turn(facts), { hits: 0, misses: 4 });
});

const SUBSCRIBER = source("Subscriber", `@org.springframework.stereotype.Component class Subscriber {
  @org.springframework.beans.factory.annotation.Value("\${orders.subject}") private String subject;
  private final io.nats.client.Connection connection;
  void run() { connection.subscribe(subject, message -> handle(message)); }
  void handle(io.nats.client.Message message) {}
}`);
const subjects = (findings: readonly Finding<unknown>[]) => findings.flatMap((finding) => (finding.status === "complete" && (finding.value as { kind: string }).kind === "listener" ? [(finding.value as { name: string }).name] : []));

test("the configuration a derivation read is part of what keeps a file: an edit to it derives the files it reaches", async () => {
  const facts = rememberingFacts();
  const configured = (subject: string): SourceFile[] => [MAIN, SUBSCRIBER, { path: "src/main/resources/application.yml", content: `orders.subject: ${subject}\n` }];
  const first = await readKept(facts, configured("orders.created"));
  assert.deepEqual(subjects(first), ["nats orders.created"]);
  const moved = configured("orders.shipped");
  const second = await readKept(facts, moved);
  assert.deepEqual(plain(second), plain(await cold(moved)));
  assert.deepEqual(subjects(second), ["nats orders.shipped"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: 4 });
});

test("a route of a contract whose servers disagree on the path keeps its base path unknown after the kept read and after a hit", async () => {
  const facts = rememberingFacts();
  const sources = [MAIN, HANDLER];
  const undecided = contractOf([operation("createOrder", "/orders", null)]);
  const first = await readKept(facts, sources, undecided);
  assert.deepEqual(plain(first), plain(await cold(sources, undecided)));
  const route = first.find((finding) => finding.status === "complete" && (finding.value as { kind: string }).kind === "http-route");
  assert.equal((route as { value: { basePath: { status: string } } }).value.basePath.status, "unknown");
  assert.deepEqual(plain(await readKept(facts, sources, undecided)), plain(first));
  assert.equal(facts.readsOf("java-entrypoints").hits, 2);
});

test("a read with the hold alone derives over the held project, keeps nothing and gives the bytes of a cold read", async () => {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    const held = (await createSpringRoutesExtractor(await createJavaParser(holds)).extract(KEPT, [], { hold })).findings;
    assert.deepEqual(plain(held), plain(await cold(KEPT)));
  } finally {
    hold.release();
  }
});

test("a subscription a base class from the libraries holds is found while the read holds facts: libraries keep the read as it was", async () => {
  const base = { repo: "lib", path: "src/main/java/lib/NatsListener.java", content: "package lib;\nimport io.nats.client.Connection; import io.nats.client.Dispatcher; import io.nats.client.Message;\npublic abstract class NatsListener {\n  protected NatsListener(Connection connection) { Dispatcher dispatcher = connection.createDispatcher(); dispatcher.subscribe(subject(), this::handle); }\n  public abstract void handle(Message message);\n  public abstract String subject();\n}" };
  const inheriting = source("CreatedListener", `@org.springframework.stereotype.Component class CreatedListener extends lib.NatsListener {
  CreatedListener(io.nats.client.Connection connection) { super(connection); }
  public void handle(io.nats.client.Message message) {}
  public String subject() { return "orders.created"; }
}`);
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    const answer = (await createSpringRoutesExtractor(await createJavaParser(holds)).extract([MAIN, inheriting], [base], { hold, facts: rememberingFacts() })).findings;
    assert.deepEqual(subjects(answer), ["nats orders.created"]);
    assert.deepEqual(plain(answer), plain((await createSpringRoutesExtractor(await createJavaParser()).extract([MAIN, inheriting], [base])).findings));
  } finally {
    hold.release();
  }
});

test("the derivation of one file enumerates no type of the project: a read of another file goes through a recorded question", () => {
  const text = readFileSync(new URL("./spring-routes.adapter.ts", import.meta.url), "utf8");
  const derivation = text.slice(text.indexOf("function routesOfFile"), text.indexOf("interface RoutesReading")) + text.slice(text.indexOf("function natsListenersIn"), text.indexOf("function unreadable"));
  assert.ok(derivation.length > 1000);
  assert.doesNotMatch(derivation, /\bproject\.types\b/);
});

const SECURITY = "org.springframework.security.core.userdetails.UserDetailsService";
const USERS_BASE = source("UsersBase", `abstract class UsersBase { public Object loadUserByUsername(String name) { return null; } }`);
const USERS = source("Users", `@org.springframework.stereotype.Service class Users extends UsersBase implements ${SECURITY} {}`);
const ANONYMOUS = source("Anonymous", `class Anonymous { Object service = new ${SECURITY}() {}; }`);
const CALLBACKS = [MAIN, USERS_BASE, USERS, ANONYMOUS, PLAIN];
const callbacksDerived = (facts: ReturnType<typeof rememberingFacts>) => facts.derived.filter((entry) => entry.startsWith("java-callbacks ")).map((entry) => (JSON.parse(entry.slice("java-callbacks ".length)) as { path: string }).path.split("/").at(-1));
const callbackHandlers = (findings: readonly Finding<unknown>[]) => findings.flatMap((finding) => (finding.status === "complete" && (finding.value as { kind: string }).kind === "callback" ? [(finding.value as { handler: { symbol: string } }).handler.symbol] : []));

test("the callbacks kept per file answer the bytes a cold read gives, and a second read of the same sources derives none", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, CALLBACKS);
  assert.deepEqual(plain(first), plain(await cold(CALLBACKS)));
  assert.deepEqual(callbackHandlers(first), ["UsersBase.loadUserByUsername"]);
  assert.ok(first.some((finding) => finding.status === "unknown" && finding.evidence.some((place) => place.via === SECURITY)));
  assert.deepEqual(callbacksDerived(facts).toSorted(), ["Anonymous.java", "Main.java", "Plain.java", "Users.java", "UsersBase.java"]);
  const derived = facts.derived.length;
  assert.deepEqual(plain(await readKept(facts, CALLBACKS)), plain(first));
  assert.equal(facts.derived.length, derived);
});

test("an edit to a file no callback derivation read derives the callbacks of that file alone", async () => {
  const facts = rememberingFacts();
  await readKept(facts, CALLBACKS);
  const sources = CALLBACKS.map((file) => (file === PLAIN ? edited(PLAIN, ["int count;", "int count = 1;"]) : file));
  facts.derived.length = 0;
  assert.deepEqual(plain(await readKept(facts, sources)), plain(await cold(sources)));
  assert.deepEqual(callbacksDerived(facts), ["Plain.java"]);
});

test("an edit to the base class whose body a registered type inherits derives that type's callbacks and the base, and no other file", async () => {
  const facts = rememberingFacts();
  await readKept(facts, CALLBACKS);
  const sources = CALLBACKS.map((file) => (file === USERS_BASE ? edited(USERS_BASE, ["loadUserByUsername", "loadUser"]) : file));
  facts.derived.length = 0;
  const after = await readKept(facts, sources);
  assert.deepEqual(plain(after), plain(await cold(sources)));
  assert.deepEqual(callbackHandlers(after), []);
  assert.deepEqual(callbacksDerived(facts).toSorted(), ["Users.java", "UsersBase.java"]);
});

test("a supertype that appears and settles a name a registered type left unsettled derives that type's callbacks", async () => {
  const facts = rememberingFacts();
  const unsettled = [MAIN, source("Lonely", `@org.springframework.stereotype.Service class Lonely extends Missing implements ${SECURITY} {}`), PLAIN];
  const before = await readKept(facts, unsettled);
  assert.ok(before.some((finding) => finding.status === "unknown"));
  const sources = [...unsettled, source("Missing", `abstract class Missing { public Object loadUserByUsername(String name) { return null; } }`)];
  facts.derived.length = 0;
  const after = await readKept(facts, sources);
  assert.deepEqual(plain(after), plain(await cold(sources)));
  assert.deepEqual(callbackHandlers(after), ["Missing.loadUserByUsername"]);
  assert.deepEqual(callbacksDerived(facts).toSorted(), ["Lonely.java", "Missing.java"]);
});

test("the callbacks of one file are read over its own declarations and their ancestors, never the whole hierarchy of the project", () => {
  const text = readFileSync(new URL("./callbacks.ts", import.meta.url), "utf8");
  assert.doesNotMatch(text, /\bproject\.types\b|readHierarchy|\bHierarchy\b/);
});
