import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const CONTROLLER = (returns: string): string => `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
class OrdersController {
  @GetMapping("/{id}")
  public ${returns} find(@PathVariable long id) { return null; }
}
`;

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
}
`;

const TEMPLATE = `<p>{{ order.customer.name }}</p>
`;

const WEB = {
  "package.json": JSON.stringify({ dependencies: { "@angular/core": "^21.0.0", "@angular/common": "^21.0.0" } }),
  "src/app/order.service.ts": SERVICE,
  "src/app/order.component.ts": COMPONENT,
  "src/app/order.component.html": TEMPLATE,
};

const TEMPLATE_FILE = "src/app/order.component.html";

let root: string;
let scratchRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ye-ast-"));
  scratchRoot = join(root, "scratch");
  mkdirSync(scratchRoot);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const git = (repo: string, ...args: string[]): string => execFileSync("git", args, { cwd: join(root, repo), env: GIT_ENV, encoding: "utf8" }).trim();

function write(repo: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, repo, path)), { recursive: true });
    writeFileSync(join(root, repo, path), content);
  }
}

/** Commits the files and answers the commit's sha. */
function commit(repo: string, files: Readonly<Record<string, string>>): string {
  write(repo, files);
  if (!existsSync(join(root, repo, ".git"))) git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  return git(repo, "rev-parse", "HEAD");
}

async function changeOfOrders(base: string, head: string) {
  const answer = await composeQueries({ scratchRoot }).contractChanges.consequencesOfChange({
    workspace: { repo: { path: join(root, "api"), id: "api" }, repos: [{ path: join(root, "web"), id: "web" }] },
    base,
    head,
  });
  assert.ok(answer.ok, JSON.stringify(answer));
  return answer.value;
}

const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((line) => line.includes(needle)) + 1;

test("an OpenAPI schema that makes a property nullable derives the hypothesis between the two commits and answers it against the consumer that reads through it", async () => {
  const base = commit("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER("String"), [DOCUMENT_FILE]: DOCUMENT(CUSTOMER) });
  const head = commit("api", { [DOCUMENT_FILE]: DOCUMENT({ ...CUSTOMER, nullable: true }) });
  commit("web", WEB);

  const change = await changeOfOrders(base, head);

  assert.deepEqual(change.snapshots, { base, head });
  assert.deepEqual(change.derived.map(({ operation, property, change: kind }) => [operation, property, kind]), [["GET /api/orders/{id}", "customer", "nullable"]]);
  assert.deepEqual(change.derived[0]!.places.head.path, DOCUMENT_FILE);
  const answer = change.derived[0]!.consequences;
  assert.ok(answer.ok && answer.value.status !== "unknown", JSON.stringify(answer));
  const unguarded = answer.value.value.findings.find((finding) => finding.status === "complete" && finding.evidence[0]?.line === lineOf(TEMPLATE, "order.customer.name"));
  assert.equal(unguarded?.status === "complete" && unguarded.value.verdict.kind, "incompatible");
  assert.deepEqual([change.frontiers, change.cuts], [[], []]);
  assert.deepEqual(readdirSync(scratchRoot), []);
});

test("a Spring DTO that stops serializing a property derives the hypothesis when the repository declares no document", async () => {
  const files = (annotation: string) => ({ "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER("Order"), "src/main/java/shop/Order.java": ORDER(annotation), "src/main/java/shop/Customer.java": CUSTOMER_CLASS });
  const base = commit("api", files(""));
  const head = commit("api", files("@JsonIgnore"));
  commit("web", WEB);

  const change = await changeOfOrders(base, head);

  assert.deepEqual(change.derived.map(({ operation, property, change: kind }) => [operation, property, kind]), [["GET /api/orders/{id}", "customer", "removed"]]);
  assert.deepEqual(change.derived[0]!.places.head.path, "src/main/java/shop/OrdersController.java");
  const answer = change.derived[0]!.consequences;
  assert.ok(answer.ok && answer.value.status !== "unknown", JSON.stringify(answer));
  const unguarded = answer.value.value.findings.find((finding) => finding.status === "complete" && finding.evidence[0]?.line === lineOf(TEMPLATE, "order.customer.name"));
  assert.equal(unguarded?.status === "complete" && unguarded.value.verdict.kind, "incompatible");
});

test("an untrusted repository is read from its commits: an uncommitted edit of the working tree changes nothing", async () => {
  const base = commit("api", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER("String"), [DOCUMENT_FILE]: DOCUMENT(CUSTOMER) });
  const head = commit("api", { [DOCUMENT_FILE]: DOCUMENT({ ...CUSTOMER, nullable: true }) });
  commit("web", WEB);
  write("api", { [DOCUMENT_FILE]: DOCUMENT({ type: "string" }) });

  const change = await changeOfOrders(base, head);

  assert.deepEqual(change.derived.map(({ property, change: kind }) => [property, kind]), [["customer", "nullable"]]);
});
