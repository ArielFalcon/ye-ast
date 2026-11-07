import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContractOperation } from "../../ports/contract-routes.port.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { createContractRoutes, missingReferences } from "./contract-document.adapter.ts";

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

test("an operation with no operationId, or with an empty one, is read with no name, placed at its verb", () => {
  const document = ["openapi: 3.0.0", "paths:", "  /orders:", "    get:", "      summary: no id here", "    post:", '      operationId: ""'].join("\n");

  const findings = routes.operations([{ path: "openapi/api.yaml", content: document }]);

  assert.deepEqual(
    findings.flatMap((finding) => (finding.status === "complete" ? [[finding.value.operationId, finding.value.method, finding.value.line]] : [])),
    [[undefined, "GET", 4], [undefined, "POST", 6]],
  );
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

const DATA_CONTRACT = "openapi/api.yaml";

/** The data of each operation of the contract, by operationId, read from the contract and the other sources given. */
function dataByOperation(content: unknown, others: Readonly<Record<string, unknown>> = {}): Record<string, ContractOperation["data"]> {
  const files = [DATA_CONTRACT, ...Object.keys(others)].map((path) => ({ path, content: JSON.stringify(path === DATA_CONTRACT ? content : others[path]) }));
  return Object.fromEntries(routes.operations(files).flatMap((finding) => (finding.status === "complete" ? [[finding.value.operationId ?? "", finding.value.data]] : [])));
}

function shop(orders: object, items: object = { type: "array", items: { type: "string" } }, body: object = { type: "object" }): object {
  const json = (schema: object) => ({ content: { "application/json": { schema } } });
  return {
    openapi: "3.0.3",
    paths: {
      "/orders": {
        get: { operationId: "getOrders", responses: { 200: json({ $ref: "#/components/schemas/Orders" }) } },
        post: { operationId: "createOrder", requestBody: json(body), responses: { 201: json({ $ref: "#/components/schemas/Orders" }) } },
      },
      "/items": { get: { operationId: "getItems", responses: { 200: json({ $ref: "#/components/schemas/Items" }) } } },
    },
    components: { schemas: { Orders: orders, Items: items } },
  };
}

const ORDERS = { type: "object", properties: { total: { type: "number" } } };

test("a schema the response references is part of the data of exactly the operations that reference it", () => {
  const before = dataByOperation(shop(ORDERS));
  const after = dataByOperation(shop({ ...ORDERS, properties: { total: { type: "string" } } }));

  assert.notEqual(after.getOrders?.response, before.getOrders?.response);
  assert.notEqual(after.createOrder?.response, before.createOrder?.response);
  assert.equal(after.getItems?.response, before.getItems?.response);
});

test("a request body change alters the request data and leaves the response data as it was", () => {
  const before = dataByOperation(shop(ORDERS));
  const after = dataByOperation(shop(ORDERS, undefined, { type: "object", required: ["id"] }));

  assert.notEqual(after.createOrder?.request, before.createOrder?.request);
  assert.equal(after.createOrder?.response, before.createOrder?.response);
});

test("documentation is not data, but a property named like documentation is", () => {
  const before = dataByOperation(shop({ ...ORDERS, description: "Orders", properties: { ...ORDERS.properties, summary: { type: "string" } } }));
  const described = dataByOperation(shop({ ...ORDERS, description: "All the orders", properties: { ...ORDERS.properties, summary: { type: "string" } } }));
  const retyped = dataByOperation(shop({ ...ORDERS, description: "Orders", properties: { ...ORDERS.properties, summary: { type: "integer" } } }));

  assert.deepEqual(described.getOrders, before.getOrders);
  assert.notEqual(retyped.getOrders?.response, before.getOrders?.response);
});

test("a reference into another source is followed, and one the sources cannot answer is unresolved with the file it names", () => {
  const contract = (ref: string) => shop({ type: "object", properties: { total: { $ref: ref } } });
  const other = (type: string) => ({ "openapi/schemas/money.yaml": { Money: { type } } });

  const before = dataByOperation(contract("schemas/money.yaml#/Money"), other("number"));
  const after = dataByOperation(contract("schemas/money.yaml#/Money"), other("string"));
  const missing = dataByOperation(contract("schemas/money.yaml#/Cash"), other("number"));
  const absent = dataByOperation(contract("../shared/money.yaml#/Money"));
  const remote = dataByOperation(contract("https://example.com/money.yaml#/Money"));

  assert.notEqual(after.getOrders?.response, before.getOrders?.response);
  assert.deepEqual([before.getOrders?.files, before.getOrders?.unresolved], [["openapi/schemas/money.yaml"], []]);
  assert.deepEqual(missing.getOrders?.unresolved, [{ ref: "schemas/money.yaml#/Cash", file: "openapi/schemas/money.yaml" }]);
  assert.deepEqual(absent.getOrders?.unresolved, [{ ref: "../shared/money.yaml#/Money", file: "shared/money.yaml" }]);
  assert.deepEqual(remote.getOrders?.unresolved, [{ ref: "https://example.com/money.yaml#/Money" }]);
});

test("a schema that references itself is read once and still decides the data", () => {
  const tree = (type: string) => ({ type: "object", properties: { label: { type }, children: { type: "array", items: { $ref: "#/components/schemas/Orders" } } } });

  assert.notEqual(dataByOperation(shop(tree("string"))).getOrders?.response, dataByOperation(shop(tree("integer"))).getOrders?.response);
  assert.deepEqual(dataByOperation(shop(tree("string"))).getOrders?.unresolved, []);
});

test("a literal value is data, documentation-named keys inside it included", () => {
  const literal = (key: string, value: unknown) => dataByOperation(shop({ ...ORDERS, [key]: value })).getOrders?.response;

  assert.notEqual(literal("default", { description: "a" }), literal("default", { description: "b" }));
  assert.notEqual(literal("enum", [{ summary: "a" }]), literal("enum", [{ summary: "b" }]));
  assert.notEqual(literal("const", { example: "a" }), literal("const", { example: "b" }));
});

test("a reference by absolute path names no source of the repository: it is unresolved", () => {
  const read = dataByOperation(shop({ type: "object", properties: { total: { $ref: "/schemas/money.yaml#/Money" } } }), { "openapi/schemas/money.yaml": { Money: { type: "number" } } });

  assert.deepEqual([read.getOrders?.files, read.getOrders?.unresolved], [[], [{ ref: "/schemas/money.yaml#/Money" }]]);
});

test("the files the contract documents reference, directly or through the files they reference, that the sources do not hold are the ones still to read", () => {
  const source = (path: string, content: unknown) => ({ path, content: JSON.stringify(content) });
  const document = source("openapi/api.json", { openapi: "3.0.3", paths: {}, components: { schemas: { A: { $ref: "../schemas/a.json" }, B: { $ref: "#/components/schemas/A" }, C: { $ref: "https://example.com/c.json" }, D: { $ref: "/abs/d.json" }, E: { $ref: "../../../escape.json" } } } });
  const outside = source("schemas/a.json", { properties: { next: { $ref: "b.json#/Next" }, self: { $ref: "#/properties/next" }, back: { $ref: "../openapi/api.json" } } });
  const unrelated = source("schemas/unrelated.json", { $ref: "never.json" });
  assert.deepEqual(missingReferences([document]), ["schemas/a.json"]);
  assert.deepEqual(missingReferences([document, outside, unrelated]), ["schemas/b.json"]);
  assert.deepEqual(missingReferences([document, outside, source("schemas/b.json", {})]), []);
});
