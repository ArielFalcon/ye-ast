import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { summariesOf, type SummaryResolver } from "./request-summaries.ts";

/** A path the fake states: its text, and the parameter index each `{}` reads (undefined when it is not a parameter). */
type FakePath = string | { text: string; holes: readonly (number | undefined)[] };

/** A resolver that answers the three questions the rule asks, from the text of each expression, with no evaluator of its own. */
function resolverOf(options: { paths?: Record<string, FakePath>; clients?: readonly string[]; callees?: Record<string, string>; bodies?: Record<string, ts.Node>; unreadable?: readonly string[] } = {}): SummaryResolver {
  const paths = options.paths ?? {};
  const clients = new Set(options.clients ?? []);
  const declaredCallees = options.callees ?? {};
  const bodies = options.bodies ?? {};
  const unreadable = new Set(options.unreadable ?? []);
  return {
    evaluate: async (_file, expression) => {
      const known = paths[expression.getText()];
      if (known === undefined) return { status: "undecided", cause: "destination-undecidable", evidence: [] };
      return typeof known === "string" ? { status: "known", text: known, holes: known.split("{}").slice(1).map(() => undefined) } : { status: "known", text: known.text, holes: known.holes };
    },
    calleeOf: async (file, call) => {
      if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
      const key = declaredCallees[call.expression.name.text];
      return key === undefined ? undefined : { key, file: key.split("\0")[0] ?? file, body: unreadable.has(key) ? undefined : (bodies[key] ?? call) };
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
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [0] }, "'/v1/items/' + id": "/v1/items/{}" }, clients: ["this.http"], callees: { get: "crud.ts\0Crud.get" } }));
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

test("a caller of a declaration whose body the snapshot does not read is unknown, never none, and carries the gap at its call", async () => {
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id) { return this.crud.get('/v1/items/' + id) } }"]);
  const summaries = await summariesOf([svc], resolverOf({ paths: { "'/v1/items/' + id": "/v1/items/{}" }, callees: { get: "crud.ts\0Crud.get" }, unreadable: ["crud.ts\0Crud.get"] }));
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.gaps, [{ cause: "source-not-read", evidence: [{ path: "svc.ts", line: 2 }] }]);
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.result, { kind: "unknown", cause: "source-not-read", evidence: [] });
});

test("a request the wrapper returns is a body of its container, not none, and a wrapper of it passes that result on", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  get(path) { return this.http.get(this.url + path) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id) { return this.crud.get(id) } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [0] } }, clients: ["this.http"], callees: { get: "crud.ts\0Crud.get" } }));
  assert.deepEqual(summaries.get("crud.ts\0Crud.get")?.result, { kind: "body", container: "observable", observed: "body" });
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.result, { kind: "body", container: "observable", observed: "body" });
});

test("a request observed as its response is a body observed as the response", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  get(path) { return this.http.get(this.url + path, { observe: 'response' }) } }"]);
  const summaries = await summariesOf([crud], resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [0] } }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("crud.ts\0Crud.get")?.result, { kind: "body", container: "observable", observed: "response" });
});

test("a cycle through which a request flows states a recursive gap where the cycle re-enters", async () => {
  const a = file("a.ts", ["class A { constructor(private b: B) {}", "  a() { return this.b.b() } }"]);
  const b = file("b.ts", ["class B { constructor(private http: HttpClient, private a: A) {}", "  b() { this.a.a(); return this.http.get('/x') } }"]);
  const summaries = await summariesOf([a, b], resolverOf({ paths: { "'/x'": "/x" }, clients: ["this.http"], callees: { a: "a.ts\0A.a", b: "b.ts\0B.b" } }));
  const callerOfCycle = summaries.get("a.ts\0A.a");
  assert.deepEqual(callerOfCycle?.shapes.map((shape) => shape.path), ["/x"]);
  assert.deepEqual(callerOfCycle?.gaps.map((gap) => gap.cause), ["recursive"]);
});

test("a request whose path the snapshot does not decide is a gap at the call, not a silent absence", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  get(path) { return this.http.get(this.build(path)) } }"]);
  const summaries = await summariesOf([crud], resolverOf({ clients: ["this.http"] }));
  assert.deepEqual(summaries.get("crud.ts\0Crud.get")?.shapes, []);
  assert.deepEqual(summaries.get("crud.ts\0Crud.get")?.gaps, [{ cause: "destination-undecidable", evidence: [{ path: "crud.ts", line: 2 }] }]);
});

test("two bodies for one member are a dispatch disagreement, never one of them", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(p) { return this.http.get('/a') }", "  load(p) { return this.http.get('/b') } }"]);
  const summaries = await summariesOf([crud], resolverOf({ paths: { "'/a'": "/a", "'/b'": "/b" }, clients: ["this.http"] }));
  const load = summaries.get("crud.ts\0Crud.load");
  assert.deepEqual(load?.shapes, []);
  assert.deepEqual(load?.gaps.map((gap) => gap.cause), ["dispatch-disagreement"]);
  assert.equal(load?.result.kind, "unknown");
});

test("a path that splits on a parameter's truthiness states one shape per branch, each with its condition", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(all, id) { return this.http.get(all ? '/items' : '/items/' + id) } }"]);
  const summaries = await summariesOf([crud], resolverOf({ paths: { "'/items'": "/items", "'/items/' + id": "/items/{}" }, clients: ["this.http"] }));
  assert.deepEqual(
    summaries.get("crud.ts\0Crud.load")?.shapes.map(({ path, when }) => ({ path, when })),
    [
      { path: "/items", when: { parameter: 0, test: "truthy" } },
      { path: "/items/{}", when: { parameter: 0, test: "falsy" } },
    ],
  );
});

test("a branch the literal argument of a call decides keeps only the surviving shape, with no condition", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(all, id) { return this.http.get(all ? '/items' : '/items/' + id) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id) { return this.crud.load('', id) } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "'/items'": "/items", "'/items/' + id": "/items/{}", "''": "" }, clients: ["this.http"], callees: { load: "crud.ts\0Crud.load" } }));
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.shapes.map(({ path, when }) => ({ path, when })), [{ path: "/items/{}", when: undefined }]);
});

test("a branch the caller's own parameter decides stays a condition on the caller's parameter", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(all, id) { return this.http.get(all ? '/items' : '/items/' + id) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id, all) { return this.crud.load(all, id) } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "'/items'": "/items", "'/items/' + id": "/items/{}" }, clients: ["this.http"], callees: { load: "crud.ts\0Crud.load" } }));
  assert.deepEqual(
    summaries.get("svc.ts\0Svc.item")?.shapes.map(({ path, when }) => ({ path, when })),
    [
      { path: "/items", when: { parameter: 1, test: "truthy" } },
      { path: "/items/{}", when: { parameter: 1, test: "falsy" } },
    ],
  );
});

test("a parameter the path reads out of order is bound to the argument it came from, not to its position", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  get(path, id) { return this.http.get(this.url + id + path) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  load(p) { return this.crud.get(p, '7') } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "this.url + id + path": { text: "H/api{}{}", holes: [1, 0] }, "'7'": "7" }, clients: ["this.http"], callees: { get: "crud.ts\0Crud.get" } }));
  assert.deepEqual(summaries.get("svc.ts\0Svc.load")?.shapes.map((shape) => shape.path), ["H/api7{}"]);
});

test("a request body the callee takes from its parameter is that parameter of the caller that passes it", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  save(path, body) { return this.http.post(this.url + path, body) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  store(data) { return this.crud.save('/x', data) } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [0] }, "'/x'": "/x" }, clients: ["this.http"], callees: { save: "crud.ts\0Crud.save" } }));
  assert.deepEqual(summaries.get("crud.ts\0Crud.save")?.shapes.map((shape) => shape.body), [{ kind: "parameter", index: 1 }]);
  assert.deepEqual(summaries.get("svc.ts\0Svc.store")?.shapes.map((shape) => shape.body), [{ kind: "parameter", index: 0 }]);
});

test("the request verb reads its method and path from the arguments the verb takes", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(path) { return this.http.request('GET', this.url + path) } }"]);
  const summaries = await summariesOf([crud], resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [0] } }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("crud.ts\0Crud.load")?.shapes.map((shape) => [shape.method, shape.path]), [["GET", "H/api{}"]]);
});

test("a client the summary does not state yet is a gap, never a silent absence", async () => {
  const crud = file("crud.ts", ["class Crud {", "  load(path) { return httpResource(() => this.url + path) } }"]);
  const summaries = await summariesOf([crud], resolverOf({}));
  assert.deepEqual(summaries.get("crud.ts\0Crud.load")?.shapes, []);
  assert.deepEqual(summaries.get("crud.ts\0Crud.load")?.gaps.map((gap) => gap.cause), ["destination-undecidable"]);
});

test("a literal path that writes a brace is a gap at the call, never substituted through its brace", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  get(path) { return this.http.get('/x/{}') } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id) { return this.crud.get('7') } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "'/x/{}'": "/x/{}", "'7'": "7" }, clients: ["this.http"], callees: { get: "crud.ts\0Crud.get" } }));
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.shapes, []);
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.gaps.map((gap) => gap.cause), ["destination-undecidable"]);
});
