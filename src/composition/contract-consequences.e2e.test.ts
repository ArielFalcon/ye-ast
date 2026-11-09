import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HypothesisAnswer } from "../core/domain/contracts/consequence-fact.ts";
import { composeQueries } from "./compose.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const BOOT = `package shop;

import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
class Main {}
`;

const CONTROLLER = `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
class OrdersController {
  @GetMapping("/{id}")
  public String find(@PathVariable long id) { return ""; }
}
`;

const SERVICE = `import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable } from "rxjs";

export interface Order {
  id: number;
  customer: { name: string };
}

@Injectable({ providedIn: "root" })
export class OrderService {
  private http = inject(HttpClient);

  find(id: number): Observable<Order> {
    return this.http.get<Order>(\`/api/orders/\${id}\`);
  }
}
`;

const COMPONENT = `import { Component } from "@angular/core";
import { Order, OrderService } from "./order.service";

@Component({ selector: "app-order", standalone: true, templateUrl: "./order.component.html" })
export class OrderComponent {
  order?: Order;

  constructor(private service: OrderService) {}

  load(id: number): void {
    this.service.find(id).subscribe((order) => {
      this.order = order;
    });
  }

  describe(value: unknown): string {
    return String(value);
  }
}
`;

const TEMPLATE = `<p>{{ order.customer.name }}</p>
<p>{{ order.customer?.name }}</p>
<p>{{ describe(order) }}</p>
`;

const WEB = {
  "package.json": JSON.stringify({ dependencies: { "@angular/core": "^21.0.0", "@angular/common": "^21.0.0" } }),
  "src/app/order.service.ts": SERVICE,
  "src/app/order.component.ts": COMPONENT,
  "src/app/order.component.html": TEMPLATE,
};

const SERVICE_FILE = "src/app/order.service.ts";
const TEMPLATE_FILE = "src/app/order.component.html";

let root: string;
let scratchRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ye-ast-"));
  scratchRoot = join(root, "scratch");
  mkdirSync(scratchRoot);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function commit(repo: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, repo, path)), { recursive: true });
    writeFileSync(join(root, repo, path), content);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: join(root, repo), env: GIT_ENV });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
}

const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((line) => line.includes(needle)) + 1;

function workspace(): void {
  commit("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER });
  commit("web", WEB);
}

function ask(change: string, repos: readonly string[] = ["web"], path = "/api/orders/{id}", bound = "api") {
  return composeQueries({ scratchRoot }).contractConsequences.ofHypotheses({
    repo: { path: join(root, bound), id: bound },
    repos: repos.map((id) => ({ path: join(root, id), id })),
    hypotheses: [{ method: "GET", path, target: "response", property: "customer", change }],
  });
}

async function consequences(change: string, repos: readonly string[] = ["web"], path = "/api/orders/{id}", bound = "api") {
  const result = await ask(change, repos, path, bound);
  assert.ok(result.ok, JSON.stringify(result));
  if (result.value.status === "unknown") throw new Error("unknown");
  const [answer] = result.value.value.answers;
  assert.ok(answer !== undefined);
  return { status: result.value.status, inputs: result.value.inputs, snapshots: result.value.value.repositorySnapshots, value: answer };
}

const used = (value: HypothesisAnswer, line: number) => {
  const found = value.findings.find((finding) => finding.status === "complete" && finding.evidence[0]?.line === line);
  return found?.status === "complete" ? found.value : undefined;
};

test("a response property that becomes nullable is incompatible where a template reads through it unguarded, admitted where it is guarded, and a frontier where the response is handed on", async () => {
  workspace();

  const fact = await consequences("nullable");

  assert.deepEqual(fact.value.hypothesis, { method: "GET", path: "/api/orders/{id}", target: "response", property: "customer", change: "nullable" });
  const unguarded = used(fact.value, lineOf(TEMPLATE, "order.customer.name"));
  assert.equal(unguarded?.verdict.kind, "incompatible");
  assert.deepEqual(unguarded?.chain.map(({ step, evidence }) => [step, evidence.path, evidence.line]), [
    ["http-call", SERVICE_FILE, lineOf(SERVICE, "this.http.get")],
    ["return", SERVICE_FILE, lineOf(SERVICE, "return this.http.get")],
    ["caller", "src/app/order.component.ts", lineOf(COMPONENT, "this.service.find")],
    ["subscribe", "src/app/order.component.ts", lineOf(COMPONENT, "subscribe(")],
    ["assign", "src/app/order.component.ts", lineOf(COMPONENT, "this.order = order")],
    ["template-read", TEMPLATE_FILE, lineOf(TEMPLATE, "order.customer.name")],
  ]);

  const guarded = used(fact.value, lineOf(TEMPLATE, "order.customer?.name"));
  assert.equal(guarded?.verdict.kind, "admits");

  const handedOn = fact.value.findings.filter((finding) => finding.status === "unknown" && finding.evidence.some(({ path, line }) => path === TEMPLATE_FILE && line === lineOf(TEMPLATE, "describe(order)")));
  assert.equal(handedOn.length, 1);
});

test("the same flow under a removed property sends the guarded read to review, because a guard no longer proves absence away", async () => {
  workspace();

  const fact = await consequences("removed");

  assert.deepEqual(used(fact.value, lineOf(TEMPLATE, "order.customer?.name"))?.verdict, { kind: "review", reason: "removed-behind-guard" });
  assert.equal(used(fact.value, lineOf(TEMPLATE, "order.customer.name"))?.verdict.kind, "incompatible");
});

test("the answer declares the hypothesis in its config, names the snapshot of every repository it read and leaves no scratch behind", async () => {
  workspace();

  const nullable = await consequences("nullable");
  const removed = await consequences("removed");

  assert.deepEqual(nullable.inputs.declaredConfig.hypotheses, ["GET /api/orders/{id} response customer nullable"]);
  assert.notEqual(nullable.inputs.config, removed.inputs.config);
  assert.deepEqual(nullable.snapshots.map(({ repo }) => repo), ["api", "web"]);
  assert.deepEqual(readdirSync(scratchRoot), []);
});

const INJECTED_COMPONENT = COMPONENT.replace("  constructor(private service: OrderService) {}\n", "  private service = inject(OrderService);\n").replace('import { Component } from', 'import { Component, inject } from');

test("a service the component reaches through inject() is a caller: the chain continues to the template", async () => {
  commit("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER });
  commit("web", { ...WEB, "src/app/order.component.ts": INJECTED_COMPONENT });

  const fact = await consequences("nullable");

  assert.equal(used(fact.value, lineOf(TEMPLATE, "order.customer.name"))?.verdict.kind, "incompatible");
  assert.deepEqual(fact.value.findings.filter((finding) => finding.status === "unknown" && finding.evidence.at(-1)?.via === "no-caller"), []);
});

test("a frontend and its backend in one repository are linked: the repository's own calls reach its own routes", async () => {
  const webapp = Object.fromEntries(Object.entries(WEB).map(([path, content]) => [`src/main/webapp/${path}`, content]));
  commit("app", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER, ...webapp });

  const fact = await consequences("nullable", [], "/api/orders/{id}", "app");

  assert.equal(used(fact.value, lineOf(TEMPLATE, "order.customer.name"))?.verdict.kind, "incompatible");
});

test("an operation served but with no call site linked to it is one unknown item, never an empty answer", async () => {
  commit("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER });

  const fact = await consequences("nullable", []);

  assert.equal(fact.value.findings.length, 1);
  const [item] = fact.value.findings;
  assert.ok(item?.status === "unknown");
  assert.deepEqual(item.evidence.map(({ path, line, via }) => [path, line, via]), [["src/main/java/shop/OrdersController.java", lineOf(CONTROLLER, "@GetMapping("), "no-call-site"]]);
});

test("an operation no repository of the workspace serves is an unknown answer in a partial composite, not a fault and not an empty fact", async () => {
  workspace();

  const result = await ask("nullable", ["web"], "/api/customers/{id}");

  assert.ok(result.ok && result.value.status === "partial");
  assert.deepEqual(result.value.value.answers.map((answer) => answer.status), ["unknown"]);
});

test("a value kept in a service field is not followed into a template: a class that is not a component has none", async () => {
  const keeping = SERVICE.replace("  find(", "  last?: Order;\n\n  load(id: number): void {\n    this.http.get<Order>(`/api/orders/${id}`).subscribe((order) => {\n      this.last = order;\n    });\n  }\n\n  find(");
  commit("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER });
  commit("web", { ...WEB, [SERVICE_FILE]: keeping });

  const fact = await consequences("nullable");

  assert.deepEqual(fact.value.findings.filter((finding) => finding.status === "unknown" && finding.evidence.at(-1)?.via === "template-unreadable"), []);
});

test("a call site two repositories serve equally is never linked to its own repository: the answer says it is ambiguous", async () => {
  const webapp = Object.fromEntries(Object.entries(WEB).map(([path, content]) => [`src/main/webapp/${path}`, content]));
  commit("app", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER, ...webapp });
  commit("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER });

  const fact = await consequences("nullable", ["api"], "/api/orders/{id}", "app");

  assert.deepEqual(fact.value.findings.filter((finding) => finding.status === "complete"), []);
  const ambiguous = fact.value.findings.filter((finding) => finding.status === "unknown" && finding.evidence.at(-1)?.via === "link-basis:ambiguous:api|app");
  assert.equal(ambiguous.length, 1);
});

test("the answer records the engines the analysis read with, beside those of the workspace read", async () => {
  workspace();

  const fact = await consequences("nullable");

  for (const engine of ["@angular/compiler", "@colbymchenry/codegraph", "typescript"]) assert.ok(Object.hasOwn(fact.inputs.engines, engine), engine);
});

test("a call site whose URL no read can evaluate is listed beside the missing linkage, so an empty linkage is not proof", async () => {
  const dynamic = SERVICE.replace("find(id: number)", "find(url: string)").replace("this.http.get<Order>(`/api/orders/${id}`)", "this.http.get<Order>(url)");
  commit("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER });
  commit("web", { ...WEB, [SERVICE_FILE]: dynamic });

  const fact = await consequences("nullable");

  assert.deepEqual([fact.status, fact.value.status], ["complete", "complete"]);
  assert.equal(fact.value.findings.length, 1);
  const [item] = fact.value.findings;
  assert.ok(item?.status === "unknown");
  assert.deepEqual(item.evidence.map((place) => [place.path, place.line, place.via, "repo" in place && place.repo]), [
    [SERVICE_FILE, lineOf(dynamic, "this.http.get"), "unresolved-call-site", "web"],
    ["src/main/java/shop/OrdersController.java", lineOf(CONTROLLER, "@GetMapping("), "no-call-site", "api"],
  ]);
});

test("a publish whose destination no read can decide cannot carry an HTTP operation: the answer stays complete and lists no item for it (ADR-0042 fixture 6)", async () => {
  const events = `package shop;

import org.springframework.kafka.core.KafkaTemplate;

class Events {
  private final KafkaTemplate<String, String> kafka;
  Events(KafkaTemplate<String, String> kafka) { this.kafka = kafka; }
  void publish(String topic) { kafka.send(topic, "v"); }
}
`;
  commit("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER, "src/main/java/shop/Events.java": events });
  commit("web", WEB);

  const fact = await consequences("nullable");

  assert.deepEqual([fact.status, fact.value.status], ["complete", "complete"]);
  assert.equal(fact.value.findings.some((finding) => finding.evidence.some((place) => place.path === "src/main/java/shop/Events.java")), false);
});

// A change between two revisions.

const DOCUMENT_FILE = "src/main/resources/openapi/api.json";

const DOCUMENT = (customer: Record<string, unknown>): string => JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Shop", version: "1" },
  servers: [{ url: "http://localhost:8080/api" }],
  paths: { "/orders/{id}": { get: { operationId: "findOrder", responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } } } } },
  components: { schemas: { Order: { type: "object", required: ["id", "customer"], properties: { id: { type: "integer" }, customer } } } },
}, null, 2);

const CUSTOMER = { type: "object", required: ["name"], properties: { name: { type: "string" } } };

const ORDER = (annotation: string): string => `package shop;

import com.fasterxml.jackson.annotation.JsonIgnore;

public class Order {
  private long id;
  private Customer customer;

  public long getId() { return id; }
  ${annotation}
  public Customer getCustomer() { return customer; }
}
`;

const CUSTOMER_CLASS = `package shop;

public class Customer {
  private String name;

  public String getName() { return name; }
}
`;


const CONTROLLER_RETURNING = (returns: string): string => CONTROLLER.replace('public String find(@PathVariable long id) { return ""; }', `public ${returns} find(@PathVariable long id) { return null; }`);

const git = (repo: string, ...args: string[]): string => execFileSync("git", args, { cwd: join(root, repo), env: GIT_ENV, encoding: "utf8" }).trim();

function writeFiles(repo: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, repo, path)), { recursive: true });
    writeFileSync(join(root, repo, path), content);
  }
}

/** Commits the files and answers the commit's sha. */
function commitAt(repo: string, files: Readonly<Record<string, string>>): string {
  writeFiles(repo, files);
  if (!existsSync(join(root, repo, ".git"))) git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  return git(repo, "rev-parse", "HEAD");
}

async function changeOfOrders(base: string, head: string) {
  const answer = await composeQueries({ scratchRoot }).contractConsequences.ofChange({
    repo: { path: join(root, "api"), id: "api" },
    repos: [{ path: join(root, "web"), id: "web" }],
    base,
    head,
  });
  assert.ok(answer.ok, JSON.stringify(answer));
  assert.notEqual(answer.value.status, "unknown");
  if (answer.value.status === "unknown") throw new Error("unknown");
  const { change } = answer.value.value;
  assert.ok(change !== undefined && change.derivation.status !== "unknown");
  const { derivation } = change;
  const derived = answer.value.value.answers.map((one) => ({ operation: one.derivedFrom!.operation, property: one.derivedFrom!.property, change: one.hypothesis.change, places: one.derivedFrom!.places, answer: one }));
  return { fact: answer.value, snapshots: change.snapshots, derived, derivation };
}

test("an OpenAPI schema that makes a property nullable derives the hypothesis between the two commits and answers it against the consumer that reads through it", async () => {
  const base = commitAt("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER_RETURNING("String"), [DOCUMENT_FILE]: DOCUMENT(CUSTOMER) });
  const head = commitAt("api", { [DOCUMENT_FILE]: DOCUMENT({ ...CUSTOMER, nullable: true }) });
  commit("web", WEB);

  const change = await changeOfOrders(base, head);

  assert.deepEqual(change.snapshots, { base, head });
  assert.deepEqual(change.derived.map(({ operation, property, change: kind }) => [operation, property, kind]), [["GET /api/orders/{id}", "customer", "nullable"]]);
  assert.deepEqual(change.derived[0]!.places.head.path, DOCUMENT_FILE);
  const unguarded = change.derived[0]!.answer.findings.find((finding) => finding.status === "complete" && finding.evidence[0]?.line === lineOf(TEMPLATE, "order.customer.name"));
  assert.equal(unguarded?.status === "complete" && unguarded.value.verdict.kind, "incompatible");
  assert.deepEqual([change.derivation.value.frontiers, change.derivation.status, change.fact.status], [[], "complete", "complete"]);
  assert.deepEqual(readdirSync(scratchRoot), []);
});

test("a Spring DTO that stops serializing a property derives the hypothesis when the repository declares no document", async () => {
  const files = (annotation: string) => ({ "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER_RETURNING("Order"), "src/main/java/shop/Order.java": ORDER(annotation), "src/main/java/shop/Customer.java": CUSTOMER_CLASS });
  const base = commitAt("api", files(""));
  const head = commitAt("api", files("@JsonIgnore"));
  commit("web", WEB);

  const change = await changeOfOrders(base, head);

  assert.deepEqual(change.derived.map(({ operation, property, change: kind }) => [operation, property, kind]), [["GET /api/orders/{id}", "customer", "removed"]]);
  assert.deepEqual(change.derived[0]!.places.head.path, "src/main/java/shop/OrdersController.java");
  const unguarded = change.derived[0]!.answer.findings.find((finding) => finding.status === "complete" && finding.evidence[0]?.line === lineOf(TEMPLATE, "order.customer.name"));
  assert.equal(unguarded?.status === "complete" && unguarded.value.verdict.kind, "incompatible");
});

test("an untrusted repository is read from its commits: an uncommitted edit of the working tree changes nothing", async () => {
  const base = commitAt("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER_RETURNING("String"), [DOCUMENT_FILE]: DOCUMENT(CUSTOMER) });
  const head = commitAt("api", { [DOCUMENT_FILE]: DOCUMENT({ ...CUSTOMER, nullable: true }) });
  commit("web", WEB);
  writeFiles("api", { [DOCUMENT_FILE]: DOCUMENT({ type: "string" }) });

  const change = await changeOfOrders(base, head);

  assert.deepEqual(change.derived.map(({ property, change: kind }) => [property, kind]), [["customer", "nullable"]]);
});

test("a schema a document references from outside the contract directory is part of the revision, so changing only that schema derives the hypothesis", async () => {
  const document = JSON.parse(DOCUMENT(CUSTOMER));
  document.paths["/orders/{id}"].get.responses[200].content["application/json"].schema = { $ref: "../../schemas/order.json" };
  const schema = (customer: Record<string, unknown>) => JSON.stringify({ type: "object", required: ["customer"], properties: { customer } });
  const base = commitAt("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER_RETURNING("String"), [DOCUMENT_FILE]: JSON.stringify(document), "src/main/schemas/order.json": schema(CUSTOMER) });
  const head = commitAt("api", { "src/main/schemas/order.json": schema({ ...CUSTOMER, nullable: true }) });
  commit("web", WEB);

  const change = await changeOfOrders(base, head);

  assert.deepEqual(change.derived.map(({ operation, property, change: kind }) => [operation, property, kind]), [["GET /api/orders/{id}", "customer", "nullable"]]);
});

test("a referenced schema the base revision does not hold is a frontier of the operation, never an unchanged one", async () => {
  const document = JSON.parse(DOCUMENT(CUSTOMER));
  document.paths["/orders/{id}"].get.responses[200].content["application/json"].schema = { $ref: "../../schemas/order.json" };
  const base = commitAt("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER_RETURNING("String"), [DOCUMENT_FILE]: JSON.stringify(document) });
  const head = commitAt("api", { "src/main/schemas/order.json": JSON.stringify({ type: "object", properties: { customer: CUSTOMER } }) });
  commit("web", WEB);

  const change = await changeOfOrders(base, head);

  assert.deepEqual(change.derived, []);
  assert.deepEqual(change.derivation.value.frontiers.map(({ kind, operation, side, reason }) => [kind, operation, side, reason]), [["unknown-shape", "GET /api/orders/{id}", "base", "unresolved"]]);
  assert.deepEqual(change.derivation.value.frontiers[0]!.evidence[0], { path: DOCUMENT_FILE, line: 1, via: "unresolved reference ../../schemas/order.json", repo: "api" });
});

test("a document operation is named as the handler that serves it names it: a configured context path is not part of the hypothesis", async () => {
  const handler = CONTROLLER_RETURNING("String").replace("/api/orders", "/orders");
  const base = commitAt("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": handler, "src/main/resources/application.properties": "server.servlet.context-path=/api\n", [DOCUMENT_FILE]: DOCUMENT(CUSTOMER) });
  const head = commitAt("api", { [DOCUMENT_FILE]: DOCUMENT({ ...CUSTOMER, nullable: true }) });
  commit("web", WEB);

  const change = await changeOfOrders(base, head);

  assert.deepEqual(change.derived.map(({ operation, property }) => [operation, property]), [["GET /orders/{id}", "customer"]]);
  assert.notEqual(change.derived[0]!.answer.status, "unknown");
});
