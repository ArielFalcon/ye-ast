import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { summariesOf, type SummaryResolver } from "./request-summaries.ts";

/** A resolver that answers the three questions the rule asks, from the text of each expression, with no evaluator of its own. */
function resolverOf(options: { paths?: Record<string, string>; clients?: readonly string[]; callees?: Record<string, string> } = {}): SummaryResolver {
  const paths = options.paths ?? {};
  const clients = new Set(options.clients ?? []);
  const declaredCallees = options.callees ?? {};
  return {
    evaluate: async (_file, expression) => {
      const text = expression.getText();
      const known = paths[text];
      return known === undefined ? { status: "undecided", cause: "destination-undecidable", evidence: [] } : { status: "known", text: known };
    },
    calleeOf: async (file, call) => {
      if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
      const owner = declaredCallees[call.expression.name.text];
      return owner === undefined ? undefined : { key: owner, file: owner.split("\0")[0] ?? file, body: undefined };
    },
    clientReceiver: async (_file, call) => {
      if (!ts.isPropertyAccessExpression(call.expression)) return false;
      return clients.has(call.expression.expression.getText());
    },
  };
}

function file(path: string, lines: readonly string[]): SourceFile {
  return { path, content: lines.join("\n") };
}

test("a wrapper's parameter is substituted into its callee's path, and the callee's prefix is kept", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  get(path) { return this.http.get(this.url + path) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id) { return this.crud.get('/v1/items/' + id) } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "this.url + path": "H/api{}", "'/v1/items/' + id": "/v1/items/{}" }, clients: ["this.http"], callees: { get: "crud.ts\0Crud.get" } }));
  const item = summaries.get("svc.ts\0Svc.item");
  assert.ok(item !== undefined);
  assert.deepEqual(item.shapes.map((shape) => shape.path), ["H/api/v1/items/{}"]);
  assert.equal(item.shapes[0]?.hops.length, 1);
});

test("a call whose receiver is an HttpClient is a leaf, and the same verb on a custom service is not", async () => {
  const client = file("client.ts", ["class Client { constructor(private http: HttpClient) {}", "  load() { return this.http.get('/orders') } }"]);
  const custom = file("custom.ts", ["class Custom { constructor(private store: Store) {}", "  load() { return this.store.get('/orders') } }"]);
  const summaries = await summariesOf([client, custom], resolverOf({ paths: { "'/orders'": "/orders" }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("client.ts\0Client.load")?.shapes.map((shape) => shape.path), ["/orders"]);
  assert.deepEqual(summaries.get("custom.ts\0Custom.load")?.shapes, []);
});

test("a receiver the reader cannot type is not a leaf, so a method that only calls it states no request", async () => {
  const other = file("other.ts", ["class Other { load() { return this.unknown.get('/x') } }"]);
  const summaries = await summariesOf([other], resolverOf({ paths: { "'/x'": "/x" }, clients: [] }));
  assert.deepEqual(summaries.get("other.ts\0Other.load")?.shapes, []);
});
