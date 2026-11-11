import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAccessPath } from "../../domain/contracts/access-path.ts";
import { formatOriginValue, type Origin } from "../../domain/contracts/request-origin.ts";
import type { RequestOriginReader } from "../../ports/request-origins.port.ts";
import { createRequestOriginReader } from "./request-origins.adapter.ts";
import { createRequestCallLookup } from "./http-call-sites.adapter.ts";

const COMMON = "import { HttpClient } from '@angular/common/http'\nimport { FormGroup } from '@angular/forms'\n";
const HEADER_LINES = COMMON.split("\n").length - 1;

/** A source whose body starts at line `HEADER_LINES + 1`. */
const source = (path: string, lines: readonly string[]) => ({ path, content: COMMON + lines.join("\n") });
const at = (line: number) => line + HEADER_LINES;

const readerOf = (files: readonly { path: string; content: string }[]): RequestOriginReader => createRequestOriginReader(files);

/** The body of the request made at `line` of a.ts, written inside `Page.save` unless a symbol is given. */
async function body(lines: readonly string[], line: number, path: string, symbol = "Page.save"): Promise<Origin[]> {
  return [...(await readerOf([source("a.ts", lines)]).ofBody({ file: "a.ts", line: at(line), symbol }, parseAccessPath(path)!))];
}

const show = (origins: readonly Origin[]) =>
  origins.map((origin) => {
    const line = origin.at.line - HEADER_LINES;
    if (origin.kind === "exact") return `${formatOriginValue(origin.value)}@${line}`;
    if (origin.kind === "approximate") return `~${origin.class}@${line}`;
    if (origin.kind === "frontier") return `frontier ${origin.reason}@${line}`;
    return `parameter ${origin.parameter.symbol}#${origin.parameter.index} ${origin.parameter.path.join(".")}@${line}`;
  });

const PAGE = (...statements: string[]) => ["class Page {", "  constructor(private http: HttpClient) {}", "  save() {", ...statements.map((statement) => `    ${statement}`), "  }", "}"];
const POST_AT = 4;

test("request origins recognize the Angular resource import alias but reject a foreign import", async () => {
  const unit = (module: string) => ({ path: "alias.ts", content: `import { httpResource as resource } from '${module}';\nfunction load() { return resource(() => '/items') }` });
  const selected: string[] = [];
  const lookupOf: typeof createRequestCallLookup = async (files) => {
    const lookup = await createRequestCallLookup(files);
    return { ...lookup, at(site) { const call = lookup.at(site); if (call !== undefined) selected.push(call.getText()); return call; } };
  };
  for (const module of ["@angular/common/http", "foreign"]) await createRequestOriginReader([unit(module)], undefined, lookupOf).ofBody({ file: "alias.ts", line: 2, symbol: "load" }, []);
  assert.deepEqual(selected, ["resource(() => '/items')"]);
});

test("an object literal writes the property at the end of the path, and a property it does not write is absent", async () => {
  const lines = PAGE("this.http.post('/vets', { id: null, name: 'x', age: 3, ok: false })");
  assert.deepEqual(show(await body(lines, POST_AT, "id")), ["null@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "name")), ['"x"@4']);
  assert.deepEqual(show(await body(lines, POST_AT, "age")), ["3@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "ok")), ["false@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "other")), ["absent@4"]);
});

test("a later definite write replaces earlier ones, a written undefined included, and a spread proven to lack the property keeps them", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { id: 1, id: null })"), POST_AT, "id")), ["null@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { x: 'OK', ...{ x: undefined } })"), POST_AT, "x")), ["absent@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { x: 'OK', ...{ y: 1 } })"), POST_AT, "x")), ['"OK"@4']);
});

test("a spread whose presence is unknown may overwrite the earlier write, so only the frontier remains", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { id: null, ...load() })"), POST_AT, "id")), ["frontier call-result@4"]);
  assert.deepEqual(show(await body(PAGE("const overrides = () => ({ id: 1 })", "this.http.post('/v', { id: null, ...overrides() })"), 5, "id")), ["frontier call-result@5"]);
});

test("a spread proven to lack the property on one branch keeps the earlier write beside the other branch's frontier", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { id: null, ...(flag ? {} : load()) })"), POST_AT, "id")), ["null@4", "frontier call-result@4"]);
});

test("a spread of a parameter is a frontier, since the callers may or may not carry the property", async () => {
  const lines = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(extra: Vet) {", "    return this.http.post('/v', { id: null, ...extra })", "  }", "}"];
  assert.deepEqual(show(await body(lines, 4, "id", "Page.add")), ["frontier untracked@4"]);
});

test("a computed key, a getter, a method and a prototype make the property uncertain, and a toJSON makes the whole value a frontier", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { id: 1, [key()]: 2 })"), POST_AT, "id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { __proto__: proto })"), POST_AT, "id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { get id() { return 1 } })"), POST_AT, "id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { id: null, toJSON() { return {} } })"), POST_AT, "id")), ["frontier untracked@4"]);
});

test("a serializer the walk can see applies to the whole serialized object, so no later write erases it", async () => {
  const serving = "{ toJSON() { return { id: 1 } } }";
  assert.deepEqual(show(await body(PAGE(`this.http.post('/v', { __proto__: ${serving}, id: null })`), POST_AT, "id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE(`this.http.post('/v', { ...${serving}, id: null })`), POST_AT, "id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE(`const base = ${serving}`, "this.http.post('/v', { ...base, id: null })"), 5, "id")), ["frontier untracked@5"]);
  assert.deepEqual(show(await body(PAGE(`this.http.post('/v', { inner: { __proto__: ${serving}, id: null } })`), POST_AT, "inner.id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { ...{ y: 1 }, id: null })"), POST_AT, "id")), ["null@4"]);
});

test("a nested path follows the object it names, an array element path follows every element, and a value that is no object ends in a frontier", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { owner: { id: null } })"), POST_AT, "owner.id")), ["null@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { items: [{ id: 1 }, { id: null }, {}] })"), POST_AT, "items[].id")), ["1@4", "null@4", "absent@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { owner: 'x' })"), POST_AT, "owner.id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { items: [] })"), POST_AT, "items[].id")), []);
});

test("the end of a path at an array or object literal is its class, and a template literal is exact only with literal substitutions", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { a: [1], o: {}, t: `x${1}y${'z'}`, s: `x${name}` })"), POST_AT, "a")), ["array@4"]);
  const lines = PAGE("this.http.post('/v', { o: {}, t: `x${1}y${'z'}`, s: `x${name}` })");
  assert.deepEqual(show(await body(lines, POST_AT, "o")), ["object@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "t")), ['"x1yz"@4']);
  assert.deepEqual(show(await body(lines, POST_AT, "s")), ["~string@4"]);
});

test("the wire writes undefined as absence, a non-finite number as null and an undefined array slot as null", async () => {
  const lines = PAGE("this.http.post('/v', { u: undefined, n: NaN, v: void 0, list: [1, undefined] })");
  assert.deepEqual(show(await body(lines, POST_AT, "u")), ["absent@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "n")), ["null@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "v")), ["absent@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "list[]")), ["1@4", "null@4"]);
});

test("a function or a symbol is dropped from an object and is null in an array slot", async () => {
  const lines = PAGE("this.http.post('/v', { a: () => 1, b: Symbol('b'), c: function () {}, list: [() => 1, Symbol('x'), 1] })");
  assert.deepEqual(show(await body(lines, POST_AT, "a")), ["absent@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "b")), ["absent@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "c")), ["absent@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "list[]")), ["null@4", "null@4", "1@4"]);
});

test("a function or a symbol stays what it is through ?? and ||, and only the wire drops it", async () => {
  const lines = PAGE("this.http.post('/v', { a: (() => 1) ?? 1, b: Symbol('s') || 1, c: (function () {}) || 1, d: null ?? (() => 1), list: [(() => 1) ?? 1, Symbol('s') || 1] })");
  for (const name of ["a", "b", "c", "d"]) assert.deepEqual(show(await body(lines, POST_AT, name)), ["absent@4"], name);
  assert.deepEqual(show(await body(lines, POST_AT, "list[]")), ["null@4", "null@4"]);
});

test("the operator selects on the JavaScript value and the wire serializes the selected one", async () => {
  const lines = PAGE("this.http.post('/v', { a: NaN ?? 1, b: Infinity || 1, c: ({ n: NaN }).n ?? 1, d: 0 || NaN })");
  assert.deepEqual(show(await body(lines, POST_AT, "a")), ["null@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "b")), ["null@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "c")), ["null@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "d")), ["null@4"]);
});

test("parentheses, as, ! and satisfies are transparent", async () => {
  const lines = PAGE("this.http.post('/v', ({ a: ({ id: null } as Vet)!, b: { id: 1 } satisfies Vet }))");
  assert.deepEqual(show(await body(lines, POST_AT, "a.id")), ["null@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "b.id")), ["1@4"]);
});

test("a conditional follows each branch under its condition", async () => {
  const origins = await body(PAGE("this.http.post('/v', { id: flag ? null : 1 })"), POST_AT, "id");
  assert.deepEqual(show(origins), ["null@4", "1@4"]);
  assert.deepEqual(
    origins.map((origin) => origin.conditions.map((condition) => `${condition.expression}:${condition.holds}`)),
    [["flag:true"], ["flag:false"]],
  );
});

test("?? and || keep the left values that pass the operator and take the right only when the left can fail it", async () => {
  const lines = PAGE("this.http.post('/v', { keep: 'OK' ?? 'OLD', take: null ?? 'NEW', zero: 0 ?? 7, falsy: 0 || 7, unknown: load() ?? null })");
  assert.deepEqual(show(await body(lines, POST_AT, "keep")), ['"OK"@4']);
  assert.deepEqual(show(await body(lines, POST_AT, "take")), ['"NEW"@4']);
  assert.deepEqual(show(await body(lines, POST_AT, "zero")), ["0@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "falsy")), ["7@4"]);
  assert.deepEqual(show(await body(lines, POST_AT, "unknown")), ["frontier call-result@4"]);
});

test("a ?? or || over objects follows the left object when it passes", async () => {
  const lines = PAGE("this.http.post('/v', { a: { id: 1 } ?? { id: 2 } })");
  assert.deepEqual(show(await body(lines, POST_AT, "a.id")), ["1@4"]);
});

test("a local binding is followed when it reaches the read unchanged", async () => {
  assert.deepEqual(show(await body(PAGE("const vet = { id: null }", "this.http.post('/v', vet)"), 5, "id")), ["null@4"]);
  assert.deepEqual(show(await body(PAGE("const id = null", "this.http.post('/v', { id })"), 5, "id")), ["null@4"]);
});

test("a name destructured from an object is that property of the object, and only without a default, a rest or a nested pattern", async () => {
  assert.deepEqual(show(await body(PAGE("const { id } = { id: null }", "this.http.post('/v', { id })"), 5, "id")), ["null@4"]);
  assert.deepEqual(show(await body(PAGE("const { code: id } = { code: 7 }", "this.http.post('/v', { id })"), 5, "id")), ["7@4"]);
  assert.deepEqual(show(await body(PAGE("const { id } = this.form.getRawValue()", "this.http.post('/v', { id })"), 5, "id")), ["frontier form-value@4"]);
  assert.deepEqual(show(await body(PAGE("const { id = 1 } = load()", "this.http.post('/v', { id })"), 5, "id")), ["frontier untracked@5"]);
  assert.deepEqual(show(await body(PAGE("const { owner: { id } } = load()", "this.http.post('/v', { id })"), 5, "id")), ["frontier untracked@5"]);
});

test("a binding that is reassigned, written, aliased or handed to a call is a frontier, never an origin", async () => {
  const reassigned = PAGE("let vet = { id: null }", "if (x) vet = { id: 1 }", "this.http.post('/v', vet)");
  assert.deepEqual(show(await body(reassigned, 6, "id")), ["frontier mutated@6"]);
  const written = PAGE("const vet = { id: null }", "vet.id = 5", "this.http.post('/v', vet)");
  assert.deepEqual(show(await body(written, 6, "id")), ["frontier mutated@6"]);
  const assigned = PAGE("const vet = { id: null }", "Object.assign(vet, extra)", "this.http.post('/v', vet)");
  assert.deepEqual(show(await body(assigned, 6, "id")), ["frontier mutated@6"]);
  const aliased = PAGE("const vet = { id: null }", "const other = vet", "this.http.post('/v', vet)");
  assert.deepEqual(show(await body(aliased, 6, "id")), ["frontier mutated@6"]);
  const escaped = PAGE("const vet = { id: null }", "touch(vet)", "this.http.post('/v', vet)");
  assert.deepEqual(show(await body(escaped, 6, "id")), ["frontier mutated@6"]);
});

test("a parameter is a continuation at the callers of its function, with the path in the parameter's coordinates", async () => {
  const lines = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(vet: Vet, extra = 1) {", "    return this.http.post('/v', { owner: vet })", "  }", "}"];
  const [origin] = await body(lines, 4, "owner.id", "Page.add");
  assert.equal(origin?.kind, "parameter");
  assert.deepEqual(origin?.kind === "parameter" && [origin.parameter.symbol, origin.parameter.index, origin.parameter.path, origin.parameter.body, show(origin.parameter.omitted)], ["add", 0, ["id"], false, ["frontier untracked@3"]]);
});

test("a parameter's default stands for an omitted or undefined argument, and is never taken for null", async () => {
  const lines = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(vet = { id: null }) {", "    return this.http.post('/v', vet)", "  }", "}"];
  const [origin] = await body(lines, 4, "id", "Page.add");
  assert.deepEqual(origin?.kind === "parameter" && show(origin.parameter.omitted), ["null@3"]);
});

test("a parameter handed to another call, or aliased, is no longer what the callers passed", async () => {
  const escaped = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(vet: Vet) {", "    normalize(vet)", "    return this.http.post('/v', vet)", "  }", "}"];
  assert.deepEqual(show(await body(escaped, 5, "id", "Page.add")), ["frontier mutated@5"]);
  const aliased = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(vet: Vet) {", "    const other = vet", "    return this.http.post('/v', vet)", "  }", "}"];
  assert.deepEqual(show(await body(aliased, 5, "id", "Page.add")), ["frontier mutated@5"]);
});

const withHandler = (handler: string, extra: readonly string[] = []) => [
  "class Page {",
  "  constructor(private http: HttpClient) {}",
  "  add(vet: Vet) {",
  "    return this.http.post('/v', vet).pipe(catchError(this.handle('add', vet)))",
  "  }",
  "  handle(operation: string, result: Vet) {",
  `    ${handler}`,
  "  }",
  ...extra,
  "}",
];
const withLocalHandler = (handler: string, extra: readonly string[] = []) => [
  "class Page {",
  "  constructor(private http: HttpClient) {}",
  "  save() {",
  "    const vet = { id: null }",
  "    return this.http.post('/v', vet).pipe(catchError(this.handle('add', vet)))",
  "  }",
  "  handle(operation: string, result: Vet) {",
  `    ${handler}`,
  "  }",
  ...extra,
  "}",
];
const DEFERRED = "return (error: unknown) => of(result)";

test("a call that receives the value before the request is sent keeps it exact only when its resolved body neither writes, aliases nor passes it on", async () => {
  const [kept] = await body(withHandler(DEFERRED), 4, "id", "Page.add");
  assert.equal(kept?.kind, "parameter");
  assert.deepEqual(show(await body(withLocalHandler(DEFERRED), 5, "id")), ["null@4"]);
  const passesOn = ["  pass(inner: Vet) {", "    return (error: unknown) => of(inner)", "  }"];
  assert.equal((await body(withHandler("return this.pass(result)", passesOn), 4, "id", "Page.add"))[0]?.kind, "parameter");
  assert.deepEqual(show(await body(withLocalHandler("return this.pass(result)", passesOn), 5, "id")), ["null@4"]);
});

test("a call that receives the value is a mutation when its body writes, aliases or passes it to code the reader cannot resolve, or when it cannot be resolved", async () => {
  const writing = ["  write(inner: Vet) {", "    inner.id = 1", "    return inner", "  }"];
  for (const [handler, extra] of [
    ["result.id = 1; return (error: unknown) => of(result)", []],
    ["this.last = result; return (error: unknown) => of(result)", []],
    ["delete result.id; return (error: unknown) => of(result)", []],
    ["result.count += 1; return (error: unknown) => of(result)", []],
    ["const copy = result; return (error: unknown) => of(copy)", []],
    ["audit(result); return (error: unknown) => of(result)", []],
    ["return of(result)", []],
    ["return this.write(result)", writing],
  ] as const) {
    assert.deepEqual(show(await body(withHandler(handler, extra), 4, "id", "Page.add")), ["frontier mutated@4"], handler);
    assert.deepEqual(show(await body(withLocalHandler(handler, extra), 5, "id")), ["frontier mutated@5"], handler);
  }
  const unresolved = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(vet: Vet) {", "    return this.http.post('/v', vet).pipe(catchError(handle('add', vet)))", "  }", "}"];
  assert.deepEqual(show(await body(unresolved, 4, "id", "Page.add")), ["frontier mutated@4"]);
});

test("a use of the value before the request, or in code after it, is told apart", async () => {
  const later = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(vet: Vet) {", "    const sent = this.http.post('/v', vet)", "    normalize(vet)", "    return sent", "  }", "}"];
  assert.deepEqual(show(await body(later, 4, "id", "Page.add")), ["frontier mutated@4"]);
  const before = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(vet: Vet) {", "    return this.http.post(normalize(vet), vet)", "  }", "}"];
  assert.deepEqual(show(await body(before, 4, "id", "Page.add")), ["frontier mutated@4"]);
});

test("destructured, rest and arguments-reading parameters are frontiers", async () => {
  const destructured = ["class Page {", "  constructor(private http: HttpClient) {}", "  add({ id }: Vet) {", "    return this.http.post('/v', { id })", "  }", "}"];
  assert.deepEqual(show(await body(destructured, 4, "id", "Page.add")), ["frontier untracked@4"]);
  const rest = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(...vets: Vet[]) {", "    return this.http.post('/v', vets)", "  }", "}"];
  assert.deepEqual(show(await body(rest, 4, "id", "Page.add")), ["frontier untracked@4"]);
  const reads = ["class Page {", "  constructor(private http: HttpClient) {}", "  add(vet: Vet) {", "    return this.http.post('/v', vet, arguments)", "  }", "}"];
  assert.deepEqual(show(await body(reads, 4, "id", "Page.add")), ["frontier untracked@4"]);
});

test("a function nobody can name has unresolved callers", async () => {
  const lines = PAGE("run((vet) => this.http.post('/v', vet))");
  assert.deepEqual(show(await body(lines, 4, "id", "Page.save")), ["frontier unresolved-callers@4"]);
});

test("the argument a caller passes is followed in the caller, and a missing or undefined one is omitted", async () => {
  const lines = ["class Page {", "  constructor(private svc: Svc) {}", "  a() { this.svc.add({ id: null }) }", "  b() { this.svc.add() }", "  c() { this.svc.add(undefined) }", "  d() { this.svc.add(...all) }", "}"];
  const reader = readerOf([source("a.ts", lines)]);
  const argument = async (line: number) => {
    const result = await reader.ofArgument({ file: "a.ts", line: at(line), callee: "add" }, 0, parseAccessPath("id")!, false);
    return result.kind === "omitted" ? "omitted" : show(result.origins);
  };
  assert.deepEqual(await argument(3), ["null@3"]);
  assert.equal(await argument(4), "omitted");
  assert.equal(await argument(5), "omitted");
  assert.deepEqual(await argument(6), ["frontier untracked@6"]);
});

const CRUD = ["class Crud {", "  constructor(private http: HttpClient) {}", "  post(url: string, data: any) { return this.http.post(url, data) }", "  put(url: string, data: any) { return this.http.put(url, { ...data, kind: 'v' }) }", "}"];

test("a call through a wrapper method follows the wrapped call's body with its parameters bound to this call's arguments, each call apart", async () => {
  const lines = [...CRUD, "class Page {", "  constructor(private crud: Crud) {}", "  one() { this.crud.post('/v', { id: null }) }", "  two() { this.crud.post('/v', { id: 2 }) }", "  three() { this.crud.put('/v', { id: 3 }) }", "}"];
  const reader = readerOf([source("a.ts", lines)]);
  const origins = async (line: number, symbol: string, path: string) => show(await reader.ofBody({ file: "a.ts", line: at(line), symbol }, parseAccessPath(path)!));
  assert.deepEqual(await origins(8, "Page.one", "id"), ["null@8"]);
  assert.deepEqual(await origins(9, "Page.two", "id"), ["2@9"]);
  assert.deepEqual(await origins(10, "Page.three", "id"), ["3@10"]);
  assert.deepEqual(await origins(10, "Page.three", "kind"), ['"v"@4']);
});

test("a chain of wrapper methods is followed through every forwarding call down to the HttpClient body", async () => {
  const chain = ["class Crud {", "  constructor(private http: HttpClient) {}", "  post(url: string, data: any) { return this.put(url, data) }", "  put(url: string, data: any) { return this.http.put(url, { ...data, id: 1 }) }", "}"];
  const lines = [...chain, "class Page {", "  constructor(private crud: Crud) {}", "  one() { this.crud.post('/v', { id: null, name: 'n' }) }", "}"];
  const reader = readerOf([source("a.ts", lines)]);
  const origins = async (path: string) => show(await reader.ofBody({ file: "a.ts", line: at(8), symbol: "Page.one" }, parseAccessPath(path)!));
  assert.deepEqual(await origins("id"), ["1@4"]);
  assert.deepEqual(await origins("name"), ['"n"@8']);
});

test("named function wrapper chains follow the body through each call", async () => {
  const lines = [
    "function post(url: string, data: unknown) { return fetch(url, { method: 'POST', body: JSON.stringify(data) }) }",
    "function relay(url: string, data: unknown) { return post(url, data) }",
    "function first() { return relay('/items', { id: 'known' }) }",
    "function second() { return relay('/items', { id: 17 }) }",
  ];
  const reader = readerOf([source("a.ts", lines)]);
  assert.deepEqual(show(await reader.ofBody({ file: "a.ts", line: at(3), symbol: "first" }, ["id"])), ['"known"@3']);
  assert.deepEqual(show(await reader.ofBody({ file: "a.ts", line: at(4), symbol: "second" }, ["id"])), ["17@4"]);
});

test("agreeing candidates retain both chains through a shared request leaf", async () => {
  const lines = [
    "class Base { constructor(protected http: HttpClient) {}",
    "  shared(url: string, data: any) { return this.http.post(url, data) }",
    "  post(url: string, data: any) { return this.shared(url, data) } }",
    "class Child extends Base {",
    "  override post(url: string, data: any) { return this.shared(url, data) } }",
    "class Page { constructor(private service: Base) {}",
    "  save(data: any, flag: boolean) { return this.service.post('/v', flag ? data : { id: 'other' }) } }",
  ];
  const files = [source("a.ts", lines)];
  const lookup = await createRequestCallLookup(files);
  const call = lookup.at({ file: "a.ts", line: at(7), symbol: "Page.save" });
  assert.ok(call);
  const chains = lookup.bodiesOf(call);
  assert.equal(chains.length, 2);
  assert.equal(chains[0]?.expression, chains[1]?.expression);
  assert.notEqual(chains[0]!.wrappers.at(-1)!.call, chains[1]!.wrappers.at(-1)!.call);
  const origins = await readerOf(files).ofBody({ file: "a.ts", line: at(7), symbol: "Page.save" }, ["id"]);
  assert.ok(origins.some((origin) => origin.kind === "parameter" && origin.parameter.symbol === "save"));
  assert.ok(show(origins).includes('"other"@7'));
  assert.deepEqual([...new Set(origins.flatMap((origin) => origin.conditions.map((condition) => condition.holds)))].sort(), [false, true]);
  assert.deepEqual([...new Set(origins.flatMap((origin) => origin.hops.map((hop) => hop.evidence.line)))].sort((a, b) => a - b), [at(2), at(3), at(5), at(7)]);
});

test("agreeing virtual wrappers preserve origins from each real request body", async () => {
  const lines = [
    "class Base { constructor(protected http: HttpClient) {}",
    "  post(url: string, data: any) { return this.http.post(url, data) } }",
    "class Child extends Base {",
    "  override post(url: string, data: any) { return this.http.post(url, data) } }",
    "class Page { constructor(private service: Base) {}",
    "  save(data: any) { return this.service.post('/v', data) } }",
  ];
  const origins = await readerOf([source("a.ts", lines)]).ofBody({ file: "a.ts", line: at(6), symbol: "Page.save" }, parseAccessPath("id")!);
  assert.ok(origins.length > 0);
  assert.ok(origins.every((origin) => origin.kind === "parameter" && origin.parameter.symbol === "save"));
  assert.deepEqual([...new Set(origins.flatMap((origin) => origin.hops.map((hop) => hop.evidence.line)))].sort(), [at(2), at(4), at(6)]);
});

test("a wrapper's parameter bound to a caller's own parameter continues at the callers of that function", async () => {
  const lines = [...CRUD, "class Page {", "  constructor(private crud: Crud) {}", "  save(vet: Vet) { this.crud.post('/v', vet) }", "}"];
  const reader = readerOf([source("a.ts", lines)]);
  const [origin] = await reader.ofBody({ file: "a.ts", line: at(8), symbol: "Page.save" }, parseAccessPath("id")!);
  assert.deepEqual(origin?.kind === "parameter" && [origin.parameter.symbol, origin.parameter.index, origin.parameter.body], ["save", 0, true]);
});

test("JSON.stringify of a value without extra arguments is that value serialized, and anything else a string body is a frontier", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', JSON.stringify({ id: null }))"), POST_AT, "id")), ["null@4"]);
  assert.deepEqual(show(await body(PAGE("const text = JSON.stringify({ id: null })", "this.http.post('/v', text)"), 5, "id")), ["null@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', JSON.stringify({ id: null }, replacer))"), POST_AT, "id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', 'raw')"), POST_AT, "id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { data: JSON.stringify({ id: null }) })"), POST_AT, "data")), ["~string@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { data: JSON.stringify({ id: null }) })"), POST_AT, "data.id")), ["frontier untracked@4"]);
});

test("a body that is not plain JSON, such as FormData, is a frontier", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', new FormData())"), POST_AT, "id")), ["frontier construction@4"]);
});

test("each place the walk cannot follow ends with the frontier that names why", async () => {
  const frontier = async (expression: string, extra: string[] = []) => show(await body([...PAGE(`this.http.post('/v', ${expression})`), ...extra], POST_AT, "id"));
  assert.deepEqual(await frontier("this.form.value"), ["frontier member@4"]);
  assert.deepEqual(await frontier("build()"), ["frontier call-result@4"]);
  assert.deepEqual(await frontier("this.model"), ["frontier member@4"]);
  assert.deepEqual(await frontier("new Vet()"), ["frontier construction@4"]);
  assert.deepEqual(await frontier("window"), ["frontier untracked@4"]);
  assert.deepEqual(await frontier("this.form.getRawValue()"), ["frontier form-value@4"]);
});

test("the value of a typed form model is a form-value frontier", async () => {
  const lines = ["class Page {", "  form = new FormGroup({})", "  constructor(private http: HttpClient) {}", "  save() {", "    this.http.post('/v', this.form.value)", "  }", "}"];
  assert.deepEqual(show(await body(lines, 5, "id")), ["frontier form-value@5"]);
});

test("a call that is no POST, PUT or PATCH of the project has no body to follow", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.get('/v')"), POST_AT, "id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("fetch('/v', { method: 'POST' })"), POST_AT, "id")), ["frontier untracked@4"]);
});

test("a call site the file does not hold is a frontier", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', {})"), 99, "id")), ["frontier untracked@99"]);
});

const PAGE_FILE = source("a.ts", PAGE("this.http.post('/v', { id: null })"));
const withInterceptors = async (extra: readonly { path: string; content: string }[], path = "id") => show(await readerOf([PAGE_FILE, ...extra]).ofBody({ file: "a.ts", line: at(POST_AT), symbol: "Page.save" }, parseAccessPath(path)!));

test("a registered interceptor that replaces the body makes every body a frontier at the interceptor", async () => {
  const swap = source("i.ts", ["export const swap = (req, next) => {", "  return next(req.clone({ body: { id: 1 } }))", "}"]);
  const config = source("c.ts", ["import { swap } from './i'", "export const providers = [provideHttpClient(withInterceptors([swap]))]"]);
  assert.deepEqual(await withInterceptors([swap, config]), ["frontier untracked@2"]);
});

test("a class-based interceptor registered for HTTP_INTERCEPTORS is read the same way", async () => {
  const swap = source("i.ts", ["export class Swap {", "  intercept(req, next) { return next(new HttpRequest('POST', req.url, { id: 1 })) }", "}"]);
  const config = source("c.ts", ["import { Swap } from './i'", "export const providers = [{ provide: HTTP_INTERCEPTORS, useClass: Swap, multi: true }]"]);
  assert.deepEqual(await withInterceptors([swap, config]), ["frontier untracked@2"]);
});

test("an interceptor that clones only headers, params or the url keeps the body", async () => {
  const headers = source("i.ts", ["export const auth = (req, next) => {", "  req = req.clone({ setHeaders: { A: 'b' }, url: 'x' })", "  return next(req)", "}"]);
  const config = source("c.ts", ["import { auth } from './i'", "export const providers = [provideHttpClient(withInterceptors([auth]))]"]);
  assert.deepEqual(await withInterceptors([headers, config]), ["null@4"]);
});

test("an interceptor the reader cannot read is a frontier at its registration", async () => {
  const config = source("c.ts", ["import { external } from 'some-library'", "export const providers = [provideHttpClient(withInterceptors([external]))]"]);
  assert.deepEqual(await withInterceptors([config]), ["frontier untracked@2"]);
});

test("a class-based interceptor the reader cannot resolve is a frontier at its registration", async () => {
  const config = source("c.ts", ["import { External } from 'some-library'", "export const providers = [{ provide: HTTP_INTERCEPTORS, useClass: External, multi: true }]"]);
  assert.deepEqual(await withInterceptors([config]), ["frontier untracked@2"]);
});

test("a helper that receives the request, or whose result is passed on, is followed into its declaration and judged like a clone", async () => {
  const config = source("c.ts", ["import { swap } from './i'", "export const providers = [provideHttpClient(withInterceptors([swap]))]"]);
  const replacing = source("i.ts", ["const rewrite = (req) => req.clone({ body: { id: 1 } })", "export const swap = (req, next) => next(rewrite(req))"]);
  assert.deepEqual(await withInterceptors([replacing, config]), ["frontier untracked@1"]);
  const keeping = source("i.ts", ["const tag = (req) => req.clone({ setHeaders: { A: 'b' } })", "export const swap = (req, next) => next(tag(req))"]);
  assert.deepEqual(await withInterceptors([keeping, config]), ["null@4"]);
  const nested = source("i.ts", ["const inner = (request) => new HttpRequest('POST', request.url, { id: 1 })", "const outer = (value) => inner(value)", "export const swap = (req, next) => next(outer(req))"]);
  assert.deepEqual(await withInterceptors([nested, config]), ["frontier untracked@1"]);
  const built = source("i.ts", ["const build = () => new HttpRequest('POST', '/x', { id: 1 })", "export const swap = (req, next) => next(build())"]);
  assert.deepEqual(await withInterceptors([built, config]), ["frontier untracked@1"]);
  const imported = source("i.ts", ["import { rewrite } from './h'", "export const swap = (req, next) => next(rewrite(req))"]);
  const helper = source("h.ts", ["export function rewrite(req) {", "  return req.clone({ body: { id: 1 } })", "}"]);
  assert.deepEqual(await withInterceptors([imported, helper, config]), ["frontier untracked@2"]);
});

test("a helper of a class-based interceptor is resolved as a method", async () => {
  const swap = source("i.ts", ["export class Swap {", "  intercept(req, next) { return next.handle(this.rewrite(req)) }", "  rewrite(req) { return req.clone({ body: { id: 1 } }) }", "}"]);
  const config = source("c.ts", ["import { Swap } from './i'", "export const providers = [{ provide: HTTP_INTERCEPTORS, useClass: Swap, multi: true }]"]);
  assert.deepEqual(await withInterceptors([swap, config]), ["frontier untracked@3"]);
});

test("a call that receives the request and cannot be resolved is a frontier at the call", async () => {
  const config = source("c.ts", ["import { swap } from './i'", "export const providers = [provideHttpClient(withInterceptors([swap]))]"]);
  const unknown = source("i.ts", ["import { wrap } from 'some-library'", "export const swap = (req, next) => next(wrap(req))"]);
  assert.deepEqual(await withInterceptors([unknown, config]), ["frontier untracked@2"]);
});
