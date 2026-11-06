import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConsequencesValue } from "../core/domain/contracts/consequence-fact.ts";
import type { Finding } from "../core/domain/shared/fact.ts";
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
  return composeQueries({ scratchRoot }).consumers.consequences({
    repo: { path: join(root, bound), id: bound },
    repos: repos.map((id) => ({ path: join(root, id), id })),
    hypothesis: { method: "GET", path, target: "response", property: "customer", change },
  });
}

async function consequences(change: string, repos: readonly string[] = ["web"], path = "/api/orders/{id}", bound = "api") {
  const result = await ask(change, repos, path, bound);
  assert.ok(result.ok, JSON.stringify(result));
  assert.notEqual(result.value.status, "unknown");
  if (result.value.status === "unknown") throw new Error("unknown");  return result.value;
}

const used = (value: ConsequencesValue, line: number) => {
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

test("the answer declares the hypothesis in its config and leaves no scratch behind", async () => {
  workspace();

  const nullable = await consequences("nullable");
  const removed = await consequences("removed");

  assert.equal(nullable.inputs.declaredConfig.hypothesis, "GET /api/orders/{id} response customer nullable");
  assert.notEqual(nullable.inputs.config, removed.inputs.config);
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

test("an operation no repository of the workspace serves is a typed fault, not an empty fact", async () => {
  workspace();

  const result = await ask("nullable", ["web"], "/api/customers/{id}");

  assert.ok(!result.ok);
  assert.equal(result.fault.kind, "unknown-operation");
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

  assert.equal(fact.value.findings.length, 1);
  const [item] = fact.value.findings;
  assert.ok(item?.status === "unknown");
  assert.deepEqual(item.evidence.map((place) => [place.path, place.line, place.via, "repo" in place && place.repo]), [
    [SERVICE_FILE, lineOf(dynamic, "this.http.get"), "unresolved-call-site", "web"],
    ["src/main/java/shop/OrdersController.java", lineOf(CONTROLLER, "@GetMapping("), "no-call-site", "api"],
  ]);
});
