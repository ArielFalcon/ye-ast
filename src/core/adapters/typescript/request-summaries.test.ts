import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { requestCallOf, requestFileShapeOf, summariesOf, type RequestCall, type SummaryResolver } from "./request-summaries.ts";

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

test("cycle projection excludes the caller's own unread gap and retains known requests", async () => {
  const a = file("a.ts", ["class A {", " a() { this.dep.b();", "  this.dep.missing();", "  this.http.get('/known');", " }", "}"]);
  const b = file("b.ts", ["class B {", " b() { this.dep.a();", "  this.http.get(unknown);", " }", "}"]);
  const up = file("up.ts", ["class Up {", " up() {", "  this.dep.a();", " }", "}"]);
  const self = file("self.ts", ["class Self {", " self() { this.dep.self();", "  this.dep.missing();", " }", "}"]);
  const isolated = file("isolated.ts", ["class Isolated { empty() {} }"]);
  const summaries = await summariesOf([a, b, up, self, isolated], resolverOf({
    paths: { "'/known'": "/known" }, clients: ["this.http"],
    callees: { a: "a.ts\0A.a", b: "b.ts\0B.b", self: "self.ts\0Self.self", missing: "missing.ts\0Missing.missing" },
    unreadable: ["missing.ts\0Missing.missing"],
  }));
  assert.deepEqual(summaries.get("a.ts\0A.a"), {
    shapes: [{ transport: "http", method: "GET", path: "/known", holes: [], body: { kind: "none" }, hops: [] }],
    result: { kind: "none" },
    gaps: [
      { cause: "destination-undecidable", evidence: [{ path: "a.ts", line: 2 }] },
      { cause: "recursive", evidence: [{ path: "a.ts", line: 2 }] },
      { cause: "source-not-read", evidence: [{ path: "a.ts", line: 3 }] },
    ],
  });
  assert.deepEqual(summaries.get("b.ts\0B.b")?.gaps, [
    { cause: "recursive", evidence: [{ path: "b.ts", line: 2 }] },
    { cause: "source-not-read", evidence: [{ path: "b.ts", line: 2 }] },
    { cause: "destination-undecidable", evidence: [{ path: "b.ts", line: 3 }] },
  ]);
  assert.deepEqual(summaries.get("up.ts\0Up.up")?.gaps, [
    { cause: "destination-undecidable", evidence: [{ path: "up.ts", line: 3 }] },
    { cause: "recursive", evidence: [{ path: "up.ts", line: 3 }] },
    { cause: "source-not-read", evidence: [{ path: "up.ts", line: 3 }] },
  ]);
  assert.deepEqual(summaries.get("self.ts\0Self.self")?.gaps, [
    { cause: "recursive", evidence: [{ path: "self.ts", line: 2 }] },
    { cause: "source-not-read", evidence: [{ path: "self.ts", line: 3 }] },
  ]);
  assert.deepEqual(summaries.get("isolated.ts\0Isolated.empty"), { shapes: [], result: { kind: "none" }, gaps: [] });
});

test("duplicate call places deduplicate projected causes while own multi-place evidence remains ordered", async () => {
  const dup = file("dup.ts", ["class Dup {", " go() {} go() {}", "}"]);
  const caller = file("caller.ts", ["class Caller {", " run() { this.dep.go(); this.dep.go(); this.http.get(unknown); }", "}"]);
  const summaries = await summariesOf([dup, caller], resolverOf({ clients: ["this.http"], callees: { go: "dup.ts\0Dup.go" } }));
  assert.deepEqual(summaries.get("dup.ts\0Dup.go")?.gaps, [{ cause: "dispatch-disagreement", evidence: [{ path: "dup.ts", line: 2 }, { path: "dup.ts", line: 2 }] }]);
  assert.deepEqual(summaries.get("caller.ts\0Caller.run")?.gaps, [
    { cause: "destination-undecidable", evidence: [{ path: "caller.ts", line: 2 }] },
    { cause: "dispatch-disagreement", evidence: [{ path: "caller.ts", line: 2 }] },
  ]);
});

test("opaque and represented targets retain resolver evidence without creating auxiliary summaries", async () => {
  const caller = file("caller.ts", ["class Caller {", " unread() { this.dep.missing(); }", " provided() { this.dep.providedBody(); }", " external() { this.dep.external(); }", " represented() { this.dep.target(); }", "}"]);
  const target = file("target.ts", ["class Target {", " target() { this.dep.deep(); }", "}"]);
  const deep = file("deep.ts", ["class Deep {", " deep() { this.http.get(unknown); }", "}"]);
  const up = file("up.ts", ["class Up {", " up() {", "  this.dep.unread();", " }", "}"]);
  const summaries = await summariesOf([caller, target, deep, up], resolverOf({
    clients: ["this.http"],
    callees: { missing: "absent.ts\0Missing.missing", providedBody: "absent.ts\0Provided.body", target: "target.ts\0Target.target", deep: "deep.ts\0Deep.deep", unread: "caller.ts\0Caller.unread" },
    unreadable: ["absent.ts\0Missing.missing", "target.ts\0Target.target"],
  }));
  assert.deepEqual(summaries.get("caller.ts\0Caller.unread"), { shapes: [], result: { kind: "none" }, gaps: [{ cause: "source-not-read", evidence: [{ path: "caller.ts", line: 2 }] }] });
  assert.deepEqual(summaries.get("caller.ts\0Caller.provided"), { shapes: [], result: { kind: "none" }, gaps: [] });
  assert.deepEqual(summaries.get("caller.ts\0Caller.external"), { shapes: [], result: { kind: "none" }, gaps: [] });
  assert.deepEqual(summaries.get("caller.ts\0Caller.represented")?.gaps, [
    { cause: "destination-undecidable", evidence: [{ path: "caller.ts", line: 5 }] },
    { cause: "source-not-read", evidence: [{ path: "caller.ts", line: 5 }] },
  ]);
  assert.deepEqual(summaries.get("up.ts\0Up.up")?.gaps, [{ cause: "source-not-read", evidence: [{ path: "up.ts", line: 3 }] }]);
  assert.equal(summaries.has("absent.ts\0Missing.missing"), false);
  assert.equal(summaries.has("absent.ts\0Provided.body"), false);
  assert.equal(summaries.size, 7);
});

test("a wrapper's parameter is substituted into its callee's path, the prefix is kept and the argument's own holes flow", async () => {
  const crud = file("crud.ts", ["class Crud {", "  constructor(private http: HttpClient) {}", "  get(", "    path,", "  ) {", "    return this.http.get(this.url + path)", "  }", "}"]);
  const svc = file("svc.ts", ["class Svc {", "  constructor(private crud: Crud) {}", "  item(", "    id,", "  ) {", "    return this.crud.get('/v1/items/' + id)", "  }", "}"]);
  const summaries = await summariesOf(
    [crud, svc],
    resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [0] }, "'/v1/items/' + id": { text: "/v1/items/{}", holes: [0] } }, clients: ["this.http"], callees: { get: "crud.ts\0Crud.get" } }),
  );
  assert.deepEqual(summaries.get("crud.ts\0Crud.get")?.shapes, [{ transport: "http", method: "GET", path: "H/api{}", holes: [0], body: { kind: "none" }, hops: [] }]);
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.shapes.map((shape) => [shape.path, shape.holes]), [["H/api/v1/items/{}", [0]]]);
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.shapes[0]?.hops, [
    { function: { path: "svc.ts", line: 3 }, call: { path: "svc.ts", line: 6 }, forwarded: { path: "crud.ts", line: 6 } },
  ]);
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
  const summaries = await summariesOf([svc], resolverOf({ paths: { "'/v1/items/' + id": { text: "/v1/items/{}", holes: [0] } }, callees: { get: "crud.ts\0Crud.get" }, unreadable: ["crud.ts\0Crud.get"] }));
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.gaps, [{ cause: "source-not-read", evidence: [{ path: "svc.ts", line: 2 }] }]);
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.result, { kind: "unknown", cause: "source-not-read", evidence: [{ path: "svc.ts", line: 2 }] });
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

test("an options argument the snapshot does not read does not assert how the response is observed", async () => {
  const api = file("api.ts", ["class Api { constructor(private http: HttpClient) {}", "  load(path, opts) { return this.http.get(this.url + path, opts) } }"]);
  const summaries = await summariesOf([api], resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [0] } }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("api.ts\0Api.load")?.result, { kind: "unknown", cause: "destination-undecidable", evidence: [{ path: "api.ts", line: 2 }] });
});

test("a cycle through which a request flows states a recursive gap where the cycle re-enters", async () => {
  const a = file("a.ts", ["class A { constructor(private b: B) {}", "  a() { return this.b.b() } }"]);
  const b = file("b.ts", ["class B { constructor(private http: HttpClient, private a: A) {}", "  b() { this.a.a(); return this.http.get('/x') } }"]);
  const summaries = await summariesOf([a, b], resolverOf({ paths: { "'/x'": "/x" }, clients: ["this.http"], callees: { a: "a.ts\0A.a", b: "b.ts\0B.b" } }));
  const callerOfCycle = summaries.get("a.ts\0A.a");
  assert.deepEqual(callerOfCycle?.shapes.map((shape) => shape.path), ["/x"]);
  assert.deepEqual(callerOfCycle?.gaps.map((gap) => gap.cause), ["recursive"]);
});

test("gaps are ordered by the place they name, not by their cause", async () => {
  const a = file("a.ts", ["class A { constructor(private http: HttpClient) {}", "  go() {", "    this.go()", "    return this.http.get(this.build())", "  }", "}"]);
  const summaries = await summariesOf([a], resolverOf({ paths: {}, clients: ["this.http"], callees: { go: "a.ts\0A.go" } }));
  assert.deepEqual(summaries.get("a.ts\0A.go")?.gaps.map((gap) => [gap.cause, gap.evidence[0]?.line]), [
    ["recursive", 3],
    ["destination-undecidable", 4],
  ]);
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
  assert.deepEqual(load?.result, { kind: "unknown", cause: "dispatch-disagreement", evidence: [{ path: "crud.ts", line: 2 }, { path: "crud.ts", line: 3 }] });
});

test("a path that splits on a parameter's truthiness states one shape per branch, each with its condition", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(all, id) { return this.http.get(all ? '/items' : '/items/' + id) } }"]);
  const summaries = await summariesOf([crud], resolverOf({ paths: { "'/items'": "/items", "'/items/' + id": { text: "/items/{}", holes: [1] } }, clients: ["this.http"] }));
  assert.deepEqual(
    summaries.get("crud.ts\0Crud.load")?.shapes.map(({ path, when }) => ({ path, when })),
    [
      { path: "/items", when: { parameter: 0, test: "truthy" } },
      { path: "/items/{}", when: { parameter: 0, test: "falsy" } },
    ],
  );
});

test("a conditional inside a concatenation splits the path, keeping the text around it", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(all, id) { return this.http.get('/items' + (all ? '' : '/' + id)) } }"]);
  const summaries = await summariesOf([crud], resolverOf({ paths: { "'/' + id": { text: "/{}", holes: [1] } }, clients: ["this.http"] }));
  assert.deepEqual(
    summaries.get("crud.ts\0Crud.load")?.shapes.map(({ path, when }) => ({ path, when })),
    [
      { path: "/items", when: { parameter: 0, test: "truthy" } },
      { path: "/items/{}", when: { parameter: 0, test: "falsy" } },
    ],
  );
});

test("a branch the literal argument of a call decides keeps only the surviving shape, with no condition", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(all, id) { return this.http.get('/items' + (all ? '' : '/' + id)) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id) { return this.crud.load('', id) } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "'/' + id": { text: "/{}", holes: [1] }, "''": "" }, clients: ["this.http"], callees: { load: "crud.ts\0Crud.load" } }));
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.shapes.map(({ path, when }) => ({ path, when })), [{ path: "/items/{}", when: undefined }]);
});

test("a branch the caller's own parameter decides stays a condition on the caller's parameter", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(all, id) { return this.http.get(all ? '/items' : '/items/' + id) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id, all) { return this.crud.load(all, id) } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "'/items'": "/items", "'/items/' + id": { text: "/items/{}", holes: [1] } }, clients: ["this.http"], callees: { load: "crud.ts\0Crud.load" } }));
  assert.deepEqual(
    summaries.get("svc.ts\0Svc.item")?.shapes.map(({ path, when }) => ({ path, when })),
    [
      { path: "/items", when: { parameter: 1, test: "truthy" } },
      { path: "/items/{}", when: { parameter: 1, test: "falsy" } },
    ],
  );
});

test("an undecided argument that is not the caller's parameter keeps both branches with no condition", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  load(all, id) { return this.http.get(all ? '/items' : '/items/' + id) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id) { return this.crud.load(this.all, id) } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "'/items'": "/items", "'/items/' + id": { text: "/items/{}", holes: [1] } }, clients: ["this.http"], callees: { load: "crud.ts\0Crud.load" } }));
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.shapes.map(({ path, when }) => ({ path, when })), [
    { path: "/items", when: undefined },
    { path: "/items/{}", when: undefined },
  ]);
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

test("the request verb reads a literal method from its argument, and a value leaves it undefined", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  send(method, path) { return this.http.request(method, this.url + path) } }"]);
  const summaries = await summariesOf([crud], resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [1] } }, clients: ["this.http"] }));
  const send = summaries.get("crud.ts\0Crud.send");
  assert.deepEqual(send?.shapes.map(({ method, path }) => [method, path]), [[undefined, "H/api{}"]]);
  assert.deepEqual(send?.gaps, []);
});

test("a request verb an argument fills is resolved from that argument at the call, and is a gap when it states none", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  send(method, path) { return this.http.request(method, this.url + path) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(path) { return this.crud.send('POST', path) } }"]);
  const other = file("other.ts", ["class Other { constructor(private crud: Crud) {}", "  item(path) { return this.crud.send(this.verb, path) } }"]);
  const summaries = await summariesOf([crud, svc, other], resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [1] }, "'POST'": "POST" }, clients: ["this.http"], callees: { send: "crud.ts\0Crud.send" } }));
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.shapes.map(({ method, path, holes }) => [method, path, holes]), [["POST", "H/api{}", [0]]]);
  assert.deepEqual(summaries.get("other.ts\0Other.item")?.gaps.map((gap) => gap.cause), ["destination-undecidable"]);
});

test("a client the summary does not state yet is a gap, never a silent absence", async () => {
  const crud = file("crud.ts", ["import { httpResource } from '@angular/common/http'; class Crud {", "  load(path) { return httpResource(() => this.url + path) } }"]);
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

test("a brace the code writes in any literal segment is a gap, a concatenation and a template included", async () => {
  const joined = file("joined.ts", ["class Joined { constructor(private http: HttpClient) {}", "  get(id) { return this.http.get('/x/' + '{' + id) } }"]);
  const templated = file("templated.ts", ["class Templated { constructor(private http: HttpClient) {}", "  get(id) { return this.http.get(`/x/{${id}}`) } }"]);
  const summaries = await summariesOf([joined, templated], resolverOf({ clients: ["this.http"] }));
  assert.deepEqual(summaries.get("joined.ts\0Joined.get")?.gaps, [{ cause: "destination-undecidable", evidence: [{ path: "joined.ts", line: 2, via: "literal {" }] }]);
  assert.deepEqual(summaries.get("templated.ts\0Templated.get")?.gaps, [{ cause: "destination-undecidable", evidence: [{ path: "templated.ts", line: 2, via: "literal /x/{" }] }]);
});

test("an httpResource whose function writes a brace in its literal path is a gap, never a substituted path", async () => {
  const crud = file("crud.ts", ["import { httpResource } from '@angular/common/http'; class Crud {", "  load() { return httpResource(() => '/x/{}') } }"]);
  const summaries = await summariesOf([crud], resolverOf({ clients: ["this.http"] }));
  assert.deepEqual(summaries.get("crud.ts\0Crud.load")?.shapes, []);
  assert.deepEqual(summaries.get("crud.ts\0Crud.load")?.gaps, [{ cause: "destination-undecidable", evidence: [{ path: "crud.ts", line: 2, via: "literal /x/{}" }] }]);
});

test("a request inside a forwarding callback is a request of the declaration, and its result is the callback's body", async () => {
  const api = file("api.ts", ["class Api { constructor(private http: HttpClient) {}", "  load(url) { return defer(() => this.http.get(url)) } }"]);
  const summaries = await summariesOf([api], resolverOf({ paths: { url: { text: "{}", holes: [0] } }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("api.ts\0Api.load")?.shapes.map(({ path, holes }) => [path, holes]), [["{}", [0]]]);
  assert.deepEqual(summaries.get("api.ts\0Api.load")?.result, { kind: "body", container: "observable", observed: "body" });
});

test("the result names the container the client and the forwarding row give it", async () => {
  const api = file("api.ts", [
    "import { httpResource } from '@angular/common/http'; class Api {",
    "  constructor(private http: HttpClient) {}",
    "  resource() { return httpResource(() => '/x') }",
    "  plain() { return firstValueFrom(this.http.get('/x')) }",
    "  fetched() { return fetch('/x') }",
    "}",
  ]);
  const summaries = await summariesOf([api], resolverOf({ paths: { "'/x'": "/x" }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("api.ts\0Api.resource")?.result, { kind: "body", container: "resource", observed: "body" });
  assert.deepEqual(summaries.get("api.ts\0Api.plain")?.result, { kind: "body", container: "plain", observed: "body" });
  assert.deepEqual(summaries.get("api.ts\0Api.fetched")?.result, { kind: "body", container: "promise", observed: "body" });
});

test("a projection maps the body to the access path its callback returns", async () => {
  const api = file("api.ts", ["class Api { constructor(private http: HttpClient) {}", "  load() { return this.http.get('/x').pipe(map((r) => r.data.items)) } }"]);
  const summaries = await summariesOf([api], resolverOf({ paths: { "'/x'": "/x" }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("api.ts\0Api.load")?.result, { kind: "body", container: "observable", observed: "body", projection: ["data", "items"] });
});

test("a projection the rule cannot read is unknown, never the unprojected body", async () => {
  const api = file("api.ts", ["class Api { constructor(private http: HttpClient) {}", "  load() { return this.http.get('/x').pipe(map((r) => build(r))) } }"]);
  const summaries = await summariesOf([api], resolverOf({ paths: { "'/x'": "/x" }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("api.ts\0Api.load")?.result, { kind: "unknown", cause: "destination-undecidable", evidence: [{ path: "api.ts", line: 2 }] });
});

test("returns that disagree make the result unknown, never one of them", async () => {
  const api = file("api.ts", ["class Api { constructor(private http: HttpClient) {}", "  load(flag) { if (flag) { return this.http.get('/a') } return 5 } }"]);
  const summaries = await summariesOf([api], resolverOf({ paths: { "'/a'": "/a" }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("api.ts\0Api.load")?.result, { kind: "unknown", cause: "dispatch-disagreement", evidence: [{ path: "api.ts", line: 2 }, { path: "api.ts", line: 2 }] });
});

test("a decided leaf return stays the result even when another call site in the body is undecided", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  unknown(p) { return this.http.get(this.build(p)) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private http: HttpClient, private crud: Crud) {}", "  load(p) { this.crud.unknown(p); return this.http.get('/x') } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "'/x'": "/x" }, clients: ["this.http"], callees: { unknown: "crud.ts\0Crud.unknown" } }));
  const load = summaries.get("svc.ts\0Svc.load");
  assert.deepEqual(load?.result, { kind: "body", container: "observable", observed: "body" });
  assert.deepEqual(load?.gaps.map((gap) => gap.cause), ["destination-undecidable"]);
});

test("two calls that differ in the hole they state are two shapes, never one", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  get(path) { return this.http.get(this.url + path) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  load(p, q) { this.crud.get(p); this.crud.get(q) } }"]);
  const summaries = await summariesOf([crud, svc], resolverOf({ paths: { "this.url + path": { text: "H/api{}", holes: [0] } }, clients: ["this.http"], callees: { get: "crud.ts\0Crud.get" } }));
  assert.deepEqual(summaries.get("svc.ts\0Svc.load")?.shapes.map(({ path, holes }) => [path, holes]), [
    ["H/api{}", [0]],
    ["H/api{}", [1]],
  ]);
});

test("a class property initialized with a function is a declaration, so a call through it is a request", async () => {
  const client = file("client.ts", ["class Client { constructor(private http: HttpClient) {}", "  readonly get = (id) => this.http.get(this.url + id)", "}"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Client) {}", "  item(id) { return this.crud.get(id) } }"]);
  const summaries = await summariesOf([client, svc], resolverOf({ paths: { "this.url + id": { text: "H/api{}", holes: [0] } }, clients: ["this.http"], callees: { get: "client.ts\0Client.get" } }));
  assert.deepEqual(summaries.get("client.ts\0Client.get")?.shapes.map(({ path, holes }) => [path, holes]), [["H/api{}", [0]]]);
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.shapes.map(({ path, holes }) => [path, holes]), [["H/api{}", [0]]]);
});

test("a wrapper that builds its url through a helper that returns its own parameter is a wrapper", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  resolveUrl(path) { return this.url + path }", "  get(path) { return this.http.get(this.resolveUrl(path)) } }"]);
  const svc = file("svc.ts", ["class Svc { constructor(private crud: Crud) {}", "  item(id) { return this.crud.get('/v1/items/' + id) } }"]);
  const summaries = await summariesOf(
    [crud, svc],
    resolverOf({ paths: { "this.resolveUrl(path)": { text: "H/api{}", holes: [0] }, "'/v1/items/' + id": { text: "/v1/items/{}", holes: [0] } }, clients: ["this.http"], callees: { get: "crud.ts\0Crud.get", resolveUrl: "crud.ts\0Crud.resolveUrl" } }),
  );
  assert.deepEqual(summaries.get("svc.ts\0Svc.item")?.shapes.map(({ path, holes }) => [path, holes]), [["H/api/v1/items/{}", [0]]]);
});

test("an overloaded wrapper yields one shape from the one member with a body", async () => {
  const crud = file("crud.ts", ["class Crud { constructor(private http: HttpClient) {}", "  get(a);", "  get(a, b);", "  get(a, b) { return this.http.get(this.url + a) }", "}"]);
  const summaries = await summariesOf([crud], resolverOf({ paths: { "this.url + a": { text: "H/api{}", holes: [0] } }, clients: ["this.http"] }));
  assert.deepEqual(summaries.get("crud.ts\0Crud.get")?.shapes.map(({ path, holes }) => [path, holes]), [["H/api{}", [0]]]);
});

test("one read states the same summaries for its files and its resolver", async () => {
  const api = file("api.ts", ["class Api { constructor(private http: HttpClient) {}", "  load() { return this.http.get('/x') } }"]);
  const files = [api];
  const resolver = resolverOf({ paths: { "'/x'": "/x" }, clients: ["this.http"] });
  assert.equal(summariesOf(files, resolver), summariesOf(files, resolver));
});

/** What the owner answers for the first call whose callee the source spells as `callee`. */
function requestCallIn(lines: readonly string[], callee: string): RequestCall {
  const tree = ts.createSourceFile("probe.ts", lines.join("\n"), ts.ScriptTarget.Latest, true);
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found === undefined && ts.isCallExpression(node) && node.expression.getText(tree) === callee) found = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(found !== undefined);
  return requestCallOf(requestFileShapeOf(tree), found);
}

test("a fetch whose init states a method and a body is a request with that method established and that body", () => {
  const call = requestCallIn(["function save(x) { return fetch('/orders', { method: 'POST', body: x }) }"], "fetch");
  assert.equal(call.kind, "request");
  assert.deepEqual(call.kind === "request" ? call.method : undefined, { kind: "established", verb: "POST" });
  assert.equal(call.kind === "request" && call.body.kind === "established" ? call.body.expression.getText() : undefined, "x");
});

test("a fetch or an httpResource the file binds itself is not a request, and the global fetch and the imported httpResource are", () => {
  assert.deepEqual(requestCallIn(["function load(fetch) { return fetch('/orders') }"], "fetch"), { kind: "not-request" });
  assert.deepEqual(requestCallIn(["function httpResource(f) { return f }", "const r = httpResource(() => '/orders')"], "httpResource"), { kind: "not-request" });
  assert.deepEqual(requestCallIn(["import { httpResource } from './local'", "const r = httpResource(() => '/orders')"], "httpResource"), { kind: "not-request" });
  const global = requestCallIn(["function load() { return fetch('/orders') }"], "fetch");
  assert.deepEqual(global.kind === "request" ? [global.client, global.method, global.body, global.path?.getText()] : global, ["fetch", { kind: "established", verb: "GET" }, { kind: "none" }, "'/orders'"]);
  assert.equal(requestCallIn(["import { httpResource } from '@angular/common/http'", "const r = httpResource(() => '/orders')"], "httpResource").kind, "request");
});

test("the summary of a fetch states the method and the body its init writes", async () => {
  const api = file("api.ts", ["function save(x) { return fetch('/orders', { method: 'POST', body: x }) }", "function load(fetch) { return fetch('/orders') }"]);
  const summaries = await summariesOf([api], resolverOf({ paths: { "'/orders'": "/orders" } }));
  assert.deepEqual(summaries.get("api.ts\0save")?.shapes.map(({ method, body }) => [method, body]), [["POST", { kind: "parameter", index: 0 }]]);
  assert.deepEqual(summaries.get("api.ts\0load")?.shapes, []);
});
