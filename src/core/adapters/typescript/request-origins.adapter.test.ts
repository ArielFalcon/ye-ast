import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAccessPath } from "../../domain/contracts/access-path.ts";
import { formatOriginValue, type Origin } from "../../domain/contracts/request-origin.ts";
import type { RequestOriginReader } from "../../ports/request-origins.port.ts";
import { createRequestOriginReader } from "./request-origins.adapter.ts";

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

test("a spread whose presence is unknown keeps the earlier write and adds a frontier", async () => {
  const lines = PAGE("this.http.post('/v', { x: 'OK', ...load() })");
  assert.deepEqual(show(await body(lines, POST_AT, "x")), ['"OK"@4', "frontier call-result@4"]);
});

test("a computed key, a getter and a method make the property uncertain, and a toJSON makes the whole value a frontier", async () => {
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { id: 1, [key()]: 2 })"), POST_AT, "id")), ["1@4", "frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { get id() { return 1 } })"), POST_AT, "id")), ["frontier untracked@4"]);
  assert.deepEqual(show(await body(PAGE("this.http.post('/v', { id: null, toJSON() { return {} } })"), POST_AT, "id")), ["frontier untracked@4"]);
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
