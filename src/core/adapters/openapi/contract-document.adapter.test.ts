import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContractOperation } from "../../ports/contract-routes.port.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { createContractRoutes } from "./contract-document.adapter.ts";

const routes = createContractRoutes();

function operations(findings: readonly Finding<ContractOperation>[]): string[] {
  return findings.flatMap((finding) => (finding.status === "complete" ? [`${finding.value.operationId} ${finding.value.method} ${finding.value.path}`] : [])).sort();
}

function reasons(findings: readonly Finding<ContractOperation>[]): string[] {
  return findings.flatMap((finding) => (finding.status === "unknown" ? [`${finding.reason}@${finding.evidence[0]?.line}`] : []));
}

test("an OpenAPI 3 document gives one operation per operationId, with the verb and path it declares", () => {
  const document = [
    "openapi: 3.1.1",
    "paths:",
    "  /orders:",
    "    post:",
    "      operationId: createNewOrder",
    "  /orders/{orderId}:",
    "    get:",
    "      operationId: getOrderDetail",
    "      responses: {}",
  ].join("\n");

  const findings = routes.operations([{ path: "openapi/api-definition.yaml", content: document }]);

  assert.deepEqual(operations(findings), ["createNewOrder POST /orders", "getOrderDetail GET /orders/{orderId}"]);
  assert.deepEqual(findings.map((finding) => finding.evidence[0]?.line).sort((a, b) => (a ?? 0) - (b ?? 0)), [5, 8]);
});

test("an operation with no operationId, or with an empty one, declares no route: nothing in the code can be joined to it", () => {
  const document = ["openapi: 3.0.0", "paths:", "  /orders:", "    get:", "      summary: no id here", "    post:", '      operationId: ""'].join("\n");

  assert.deepEqual(routes.operations([{ path: "swagger/petstore.json", content: JSON.stringify({ openapi: "3.0.0", paths: { "/pets": { get: { summary: "x" } } } }) }]), []);
  assert.deepEqual(routes.operations([{ path: "openapi/api.yaml", content: document }]), []);
});

test("a Swagger 2.0 JSON document is read the same way", () => {
  const document = JSON.stringify({ swagger: "2.0", basePath: "/v2", paths: { "/pet": { post: { operationId: "addPet" } } } });

  assert.deepEqual(operations(routes.operations([{ path: "openapi/swagger.json", content: document }])), ["addPet POST /pet"]);
});

test("a YAML or JSON file that declares no contract is not a contract document", () => {
  const notAContract = ["paths:", "  /orders:", "    get:", "      operationId: listOrders"].join("\n");

  assert.deepEqual(routes.operations([{ path: "openapi/settings.yaml", content: notAContract }]), []);
  assert.deepEqual(routes.operations([{ path: "src/main/resources/application.yaml", content: "openapi: 3.1.1\npaths: {}\n" }]), []);
});

test("a contract document the parser rejects is one unknown item with the place of the error", () => {
  const findings = routes.operations([{ path: "openapi/api-definition.yaml", content: 'openapi: 3.1.1\npaths: {a: [}\n' }]);

  assert.deepEqual(reasons(findings), ["source-unreadable@2"]);
});

function basePaths(findings: readonly Finding<ContractOperation>[]): (string | undefined)[] {
  return findings.flatMap((finding) => (finding.status === "complete" ? [finding.value.basePath] : []));
}

function withServers(servers: unknown): string {
  return JSON.stringify({ openapi: "3.0.3", servers, paths: { "/pets": { get: { operationId: "listPets" } } } });
}

test("a document whose aliases exhaust the resource budget is one unknown item, never a thrown error", () => {
  const level = (name: string, from: string) => `${name}: &${name} [${Array.from({ length: 10 }, () => `*${from}`).join(", ")}]`;
  const document = ['openapi: 3.0.0', 'a: &a ["x", "x", "x", "x", "x", "x", "x", "x", "x", "x"]', level("b", "a"), level("c", "b"), level("d", "c"), "paths: {}"].join("\n");

  const findings = routes.operations([{ path: "openapi/api-definition.yaml", content: document }]);

  assert.deepEqual(reasons(findings), ["source-unreadable@1"]);
});

test("a Swagger 2.0 basePath is the base path of every operation", () => {
  const document = JSON.stringify({ swagger: "2.0", basePath: "/v2/", paths: { "/pet": { post: { operationId: "addPet" } } } });

  assert.deepEqual(basePaths(routes.operations([{ path: "openapi/swagger.json", content: document }])), ["/v2"]);
});

test("the path part of the one OpenAPI server is the base path: scheme and host are ignored, a relative URL is a path", () => {
  const read = (url: string) => basePaths(routes.operations([{ path: "openapi/api.json", content: withServers([{ url }]) }]));

  assert.deepEqual(read("https://api.example.com:8443/v1/?x=1"), ["/v1"]);
  assert.deepEqual(read("/v1"), ["/v1"]);
  assert.deepEqual(read("v1"), ["/v1"]);
  assert.deepEqual(read("https://{region}.example.com/api/{version}"), ["/api/{version}"]);
  assert.deepEqual(read("https://api.example.com"), [""]);
});

test("servers whose path parts agree give that path, and a document with no servers gives no base path", () => {
  const agreeing = withServers([{ url: "https://a.example.com/v1" }, { url: "https://b.example.com/v1/" }]);

  assert.deepEqual(basePaths(routes.operations([{ path: "openapi/api.json", content: agreeing }])), ["/v1"]);
  assert.deepEqual(basePaths(routes.operations([{ path: "openapi/api.json", content: withServers(undefined) }])), [""]);
  assert.deepEqual(basePaths(routes.operations([{ path: "openapi/api.json", content: withServers([]) }])), [""]);
});

test("servers whose path parts differ give no base path: it is undecided", () => {
  const differing = withServers([{ url: "https://a.example.com/v1" }, { url: "https://b.example.com/v2" }]);

  assert.deepEqual(basePaths(routes.operations([{ path: "openapi/api.json", content: differing }])), [undefined]);
});
