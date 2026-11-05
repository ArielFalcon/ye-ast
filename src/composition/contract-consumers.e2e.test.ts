import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ImpactedLink } from "../core/domain/topology/link.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
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

const DOCUMENT = "src/main/resources/openapi/api.yaml";

const CONTRACT = (orders: { total?: string; description?: string; ref?: string } = {}, itemsType = "string"): string => `openapi: 3.0.3
info: {title: Shop, version: '1'}
paths:
  /orders:
    get:
      operationId: getOrders
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '${orders.ref ?? "#/components/schemas/Orders"}'
  /items:
    get:
      operationId: getItems
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Items'
components:
  schemas:
    Orders:
      description: ${orders.description ?? "Orders"}
      type: object
      properties:
        total:
          type: ${orders.total ?? "number"}
    Items:
      type: array
      items:
        type: ${itemsType}
`;

const CONTROLLER = (body = '""'): string => `package shop;

import org.springframework.web.bind.annotation.RestController;

@RestController
class OrdersController implements OrdersApi {
  @Override public String getOrders() { return ${body}; }
  @Override public String getItems() { return ""; }
}
`;

const BOOT = `package shop;

import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
class Main {}
`;

const CONSUMER = `import { HttpClient } from "@angular/common/http";
export class OrderApi {
  constructor(private http: HttpClient) {}
  load() {
    return this.http.get("/orders");
  }
}
`;

const WEB = { "package.json": JSON.stringify({ dependencies: { "@angular/core": "^21.0.0", "@angular/common": "^21.0.0", "@angular/router": "^21.0.0" } }), "src/app/order.api.ts": CONSUMER };

const COPY = `package copy;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class CopyController {
  @GetMapping("/orders") public String all() { return ""; }
}
`;

let root: string;
let scratchRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ye-ast-"));
  scratchRoot = join(root, "scratch");
  mkdirSync(scratchRoot);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function commit(repo: string, files: Readonly<Record<string, string>>, message = "change"): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, repo, path)), { recursive: true });
    writeFileSync(join(root, repo, path), content);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: join(root, repo), env: GIT_ENV });
  if (message === "base") git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

function provider(base: string, head: string, controller = CONTROLLER()): void {
  commit("orders", { "src/main/java/shop/Main.java": BOOT, "src/main/java/shop/OrdersController.java": CONTROLLER(), [DOCUMENT]: base }, "base");
  commit("orders", { "src/main/java/shop/OrdersController.java": controller, [DOCUMENT]: head });
}

interface Answer {
  status: string;
  cuts: readonly Cut[];
  links: readonly ImpactedLink[];
  sections: Record<string, { status: string; cuts?: readonly Cut[] }>;
}

async function changeOfOrders(others: readonly string[] = ["web"]): Promise<Answer> {
  const result = await composeQueries({ scratchRoot }).workspaceImpact.ofChange({
    repo: { path: join(root, "orders"), id: "orders" },
    repos: others.map((id) => ({ path: join(root, id), id })),
    base: "HEAD~1",
  });
  assert.ok(result.ok, JSON.stringify(result));
  const fact = result.value.fact;
  assert.notEqual(fact.status, "unknown");
  if (fact.status === "unknown") throw new Error("unknown");
  return {
    status: fact.status,
    cuts: fact.status === "partial" ? fact.cuts : [],
    links: fact.value.links,
    sections: Object.fromEntries(Object.entries(fact.value.sections).map(([repo, section]) => [repo, { status: section.status, ...(section.status === "partial" ? { cuts: section.cuts } : {}) }])),
  };
}

const callers = (links: readonly ImpactedLink[]) =>
  links.map(({ link, direction, operations }) => ({ from: `${link.from.repo}:${link.from.file}:${link.from.symbol}`, to: `${link.to.repo} ${link.to.name} ${link.to.handler.symbol}`, direction, confidence: link.confidence, ...(operations === undefined ? {} : { operations }) }));

test("a consumer calling an operation whose response schema changed under the same method and path is named, with the link's confidence", async () => {
  provider(CONTRACT(), CONTRACT({ total: "string" }));
  commit("web", WEB, "base");

  const answer = await changeOfOrders();

  assert.equal(answer.status, "complete");
  assert.deepEqual(callers(answer.links), [{
    from: "web:src/app/order.api.ts:OrderApi.load",
    to: "orders GET /orders OrdersController.getOrders",
    direction: "upstream",
    confidence: 1,
    operations: [{ change: "altered", method: "GET", path: "/orders", operationId: "getOrders", document: DOCUMENT, line: 6, parts: ["response"] }],
  }]);
});

test("a consumer of an operation the change removed is named as calling the removed operation", async () => {
  const withoutOrders = CONTRACT().replace(/  \/orders:\n[\s\S]*?(?=  \/items:)/, "");
  provider(CONTRACT(), withoutOrders, CONTROLLER().replace(/  @Override public String getOrders.*\n/, ""));
  commit("web", WEB, "base");

  const answer = await changeOfOrders();

  assert.deepEqual(callers(answer.links).map(({ from, operations }) => ({ from, operations })), [{
    from: "web:src/app/order.api.ts:OrderApi.load",
    operations: [{ change: "removed", method: "GET", path: "/orders", operationId: "getOrders", document: DOCUMENT, line: 6 }],
  }]);
});

test("a contract edit that only changes documentation names no consumer", async () => {
  provider(CONTRACT(), CONTRACT({ description: "All orders" }));
  commit("web", WEB, "base");

  const answer = await changeOfOrders();

  assert.equal(answer.status, "complete");
  assert.deepEqual(answer.links, []);
});

test("an altered operation that no consumer calls names no consumer", async () => {
  provider(CONTRACT(), CONTRACT({}, "integer"));
  commit("web", WEB, "base");

  const answer = await changeOfOrders();

  assert.equal(answer.status, "complete");
  assert.deepEqual(answer.links, []);
});

test("a consumer call two repositories serve equally stays a cut, never a named caller of the altered operation", async () => {
  provider(CONTRACT(), CONTRACT({ total: "string" }));
  commit("web", WEB, "base");
  commit("copy", { "src/main/java/copy/Main.java": BOOT.replace("package shop;", "package copy;"), "src/main/java/copy/CopyController.java": COPY }, "base");

  const answer = await changeOfOrders(["web", "copy"]);

  assert.deepEqual(answer.links, []);
  assert.equal(answer.status, "partial");
  assert.deepEqual(answer.sections.web?.cuts, [{ kind: "unresolved-link", at: ["src/app/order.api.ts", "src/app/order.api.ts:5"] }]);
});

test("a changed contract whose reference the snapshot cannot follow keeps the provider section partial", async () => {
  const external = { ref: "https://example.com/orders.yaml#/Orders" };
  provider(CONTRACT({ ...external }), CONTRACT({ ...external, total: "string" }));
  commit("web", WEB, "base");

  const answer = await changeOfOrders();

  assert.equal(answer.status, "partial");
  assert.deepEqual(answer.sections.orders?.cuts, [{ kind: "unresolved-link", at: [`${DOCUMENT}:6 https://example.com/orders.yaml#/Orders`] }]);
});

test("a changed handler body still names its consumer through the changed route, with no other altered operation attached", async () => {
  provider(CONTRACT(), CONTRACT({}, "integer"), CONTROLLER('"x"'));
  commit("web", WEB, "base");

  const answer = await changeOfOrders();

  assert.equal(answer.status, "complete");
  assert.deepEqual(callers(answer.links).map(({ from, to, direction }) => ({ from, to, direction })), [{ from: "web:src/app/order.api.ts:OrderApi.load", to: "orders GET /orders OrdersController.getOrders", direction: "upstream" }]);
  assert.equal(answer.links[0]?.operations, undefined);
});
