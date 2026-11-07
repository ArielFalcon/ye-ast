import assert from "node:assert/strict";
import test from "node:test";
import type { KnownShape, OperationShape, Shape, ShapeProperty, ValueSet } from "../../domain/contracts/payload-shape.ts";
import type { Cut, Finding } from "../../domain/shared/fact.ts";
import type { ConsumerSession, ConsumerSources, ServingWorkspace, ServingOperation } from "../../ports/consumer-sources.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PayloadShapes } from "../../ports/payload-shapes.port.ts";
import type { WorkspaceRequest } from "../../ports/workspace-queries.port.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import { createContractChangeQueries, planChange } from "./contract-change-queries.ts";

const set = (overrides: Partial<ValueSet> = {}): ValueSet => ({ literals: { boolean: [], number: [], string: [] }, array: false, object: false, null: false, absent: false, ...overrides });
const TEXT: KnownShape = { kind: "known", values: set({ literals: { boolean: [], number: [], string: "every" } }) };
const NULLABLE_TEXT: KnownShape = { kind: "known", values: set({ literals: { boolean: [], number: [], string: "every" }, null: true }) };
const property = (name: string, shape: Shape): ShapeProperty => ({ name, required: true, shape });
const object = (...properties: ShapeProperty[]): KnownShape => ({ kind: "known", values: set({ object: true }), object: { properties, open: false } });

/** A file whose content is the JSON of the operations it declares; `unreadable` makes the reader fail on it. */
interface Declared {
  method?: string;
  path: string;
  shape?: Shape;
  basePath?: string | null;
  files?: string[];
}

function fileOf(path: string, operations: Declared[] | "unreadable"): SourceFile {
  return { path, content: JSON.stringify(operations) };
}

function reader(name: string, calls: string[] = []): PayloadShapes {
  return {
    responses: (files) => {
      calls.push(name);
      return files.flatMap((file): Finding<OperationShape>[] => {
        const declared = JSON.parse(file.content) as Declared[] | "unreadable";
        if (declared === "unreadable") return [{ status: "unknown", reason: "source-unreadable", evidence: [{ path: file.path, line: 1 }] }];
        return declared.map((operation, index) => ({
          status: "complete",
          value: { operationId: undefined, method: (operation.method ?? "GET") as OperationShape["method"], path: operation.path, basePath: operation.basePath === null ? undefined : (operation.basePath ?? ""), shape: operation.shape ?? TEXT, files: [file.path, ...(operation.files ?? [])] },
          evidence: [{ path: file.path, line: index + 1, via: name }],
        }));
      });
    },
  };
}

/** Every declared operation is served as it is written. */
const asWritten: ServingWorkspace["serving"] = ({ method, path }) => ({ kind: "served", method, path });
const changeOf = (base: readonly SourceFile[], head: readonly SourceFile[], shapes: readonly PayloadShapes[], serving: ServingWorkspace["serving"] = asWritten) => planChange(base, head, shapes, serving);

const PET_BASE = object(property("city", TEXT), property("zip", TEXT));
const PET_HEAD = object(property("city", NULLABLE_TEXT), property("zip", NULLABLE_TEXT));

test("every operation whose sources changed derives its hypotheses, sorted by operation then property, each with its places in the contract at both revisions", () => {
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }, { path: "/owners", shape: PET_BASE }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD }, { path: "/owners", shape: PET_HEAD, method: "POST" }, { path: "/owners", shape: PET_HEAD }])];
  const plan = changeOf(base, head, [reader("declared")]);
  assert.deepEqual(plan.hypotheses.map(({ operation, property: at }) => `${operation} ${at}`), ["GET /owners city", "GET /owners zip", "GET /pets city", "GET /pets zip"]);
  assert.deepEqual(plan.hypotheses[2]!.places, { base: { path: "api/openapi.json", line: 1, via: "declared" }, head: { path: "api/openapi.json", line: 1, via: "declared" } });
  assert.deepEqual(plan.hypotheses[0]!.hypothesis, { method: "GET", path: "/owners", target: "response", property: ["city"], change: plan.hypotheses[0]!.hypothesis.change });
  assert.deepEqual(plan.operations, { added: ["POST /owners"], removed: [] });
});

/** The workspace serves each path of the table, naming it as its route does; anything else is served by `others`. */
const servedAs = (table: Record<string, string>, others: ServingOperation = { kind: "unserved" }): ServingWorkspace["serving"] => ({ method, path }) => (table[path] === undefined ? others : { kind: "served", method, path: table[path] });

test("an operation a document declares is named as the route that serves it names it, in the hypothesis and an operation no route serves keeps the path the document writes in the lists of added and removed operations", () => {
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE, basePath: "/api" }, { path: "/gone", shape: PET_BASE, basePath: "/api" }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD, basePath: "/api" }, { path: "/new", shape: PET_HEAD, basePath: "/api" }])];
  const plan = changeOf(base, head, [reader("declared")], servedAs({ "/api/pets": "/pets" }));
  assert.deepEqual(plan.hypotheses.map(({ hypothesis, operation }) => [hypothesis.method, hypothesis.path, operation]), [["GET", "/pets", "GET /pets"], ["GET", "/pets", "GET /pets"]]);
  assert.deepEqual(plan.operations, { added: ["GET /api/new"], removed: ["GET /api/gone"] });
});

test("an operation no route serves, or several repositories serve, is a frontier with its places and derives nothing; one whose sources did not change is not reported", () => {
  const base = [fileOf("api/openapi.json", [{ path: "/lost", shape: PET_BASE }, { path: "/twin", shape: PET_BASE }, { path: "/still", shape: PET_BASE }])];
  const head = [fileOf("api/openapi.json", [{ path: "/lost", shape: PET_HEAD }, { path: "/twin", shape: PET_HEAD }, { path: "/still", shape: PET_BASE }])];
  const serving: ServingWorkspace["serving"] = ({ method, path }) => (path === "/twin" ? { kind: "ambiguous", repos: ["a", "b"] } : path === "/still" ? { kind: "served", method, path } : { kind: "unserved" });
  const plan = changeOf(base, head, [reader("declared")], serving);
  assert.deepEqual(plan.hypotheses, []);
  assert.deepEqual(plan.frontiers.map(({ kind, operation, detail, evidence }) => [kind, operation, detail, evidence.length]), [
    ["unserved-operation", "GET /lost", "no route of the workspace serves it", 2],
    ["ambiguous-operation", "GET /twin", "served by several repositories: a, b", 2],
  ]);
});

test("two readers that write one operation with different paths agree on it once the workspace names it, and the first reader's shape wins", () => {
  const declared = reader("declared");
  const code = reader("code");
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE, basePath: "/api" }]), fileOf("api/code.json", [{ path: "/pets", shape: PET_BASE }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD, basePath: "/api" }]), fileOf("api/code.json", [{ path: "/pets", shape: PET_HEAD }])];
  const onlyOpenApi: PayloadShapes = { responses: (files) => declared.responses(files.filter((file) => file.path.endsWith("openapi.json"))) };
  const onlyCode: PayloadShapes = { responses: (files) => code.responses(files.filter((file) => file.path.endsWith("code.json"))) };
  const plan = changeOf(base, head, [onlyOpenApi, onlyCode], servedAs({ "/api/pets": "/pets", "/pets": "/pets" }));
  assert.deepEqual(new Set(plan.hypotheses.map(({ operation, places }) => `${operation} ${places.head.via}`)), new Set(["GET /pets declared"]));
});

test("sources that are the same at both revisions are not read by any reader", () => {
  const calls: string[] = [];
  const same = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])];
  assert.deepEqual(changeOf(same, same, [reader("declared", calls)]), { hypotheses: [], gained: [], frontiers: [], operations: { added: [], removed: [] } });
  assert.deepEqual(calls, []);
});

test("an operation whose sources are the same at both revisions derives nothing and reports nothing, even when its place is unknown", () => {
  const unknown: Shape = { kind: "unknown", reason: "unresolved", evidence: [{ path: "api/untouched.json", line: 1, via: "oneOf" }] };
  const untouched = fileOf("api/untouched.json", [{ path: "/stable", shape: unknown }]);
  const base = [untouched, fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])];
  const head = [untouched, fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD }])];
  const plan = changeOf(base, head, [reader("declared")]);
  assert.deepEqual(new Set(plan.hypotheses.map(({ operation }) => operation)), new Set(["GET /pets"]));
  assert.deepEqual(plan.frontiers, []);
});

test("a file a shape was read through that changed makes the operation changed, though its own document did not", () => {
  const document = fileOf("api/openapi.json", [{ path: "/pets" }]);
  const throughTypes: PayloadShapes = {
    responses: (files) => [{ status: "complete", value: { operationId: undefined, method: "GET", path: "/pets", basePath: "", shape: files.some((file) => file.path === "api/types.json" && file.content === "[ ]") ? PET_HEAD : PET_BASE, files: ["api/openapi.json", "api/types.json"] }, evidence: [{ path: "api/openapi.json", line: 1 }] }],
  };
  const types = (content: string): SourceFile => ({ path: "api/types.json", content });
  assert.equal(changeOf([document, types("[]")], [document, types("[ ]")], [throughTypes]).hypotheses.length, 2);
  assert.equal(changeOf([document, types("[]")], [document, types("[]")], [throughTypes]).hypotheses.length, 0);
});

test("the shape a reader states wins over a later reader's for the same operation, which still serves the operations the first does not state", () => {
  const declared = reader("declared");
  const code = reader("code");
  const base = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }, { path: "/b", shape: PET_BASE }])];
  const head = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_HEAD }, { path: "/b", shape: PET_BASE }])];
  const onlyDeclaredA: PayloadShapes = { responses: (files) => declared.responses(files).filter((finding) => finding.status === "complete" && finding.value.path === "/a") };
  const plan = changeOf(base, head, [onlyDeclaredA, code]);
  assert.deepEqual([...new Set(plan.hypotheses.flatMap(({ places }) => [places.base.via, places.head.via]))], ["declared"]);
  const unchanged = changeOf(base, base, [onlyDeclaredA, code]);
  assert.deepEqual(unchanged.hypotheses, []);
  const codeB = changeOf(base, [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }, { path: "/b", shape: PET_HEAD }])], [onlyDeclaredA, code]);
  assert.deepEqual(new Set(codeB.hypotheses.map(({ operation, places }) => `${operation} ${places.head.via}`)), new Set(["GET /b code"]));
});

test("a declared source a reader cannot read is a frontier and stops the readers after it: the code never replaces a contract that was not read", () => {
  const calls: string[] = [];
  const base = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }]), fileOf("api/swagger.json", "unreadable")];
  const head = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }]), { path: "api/swagger.json", content: `${JSON.stringify("unreadable")} ` }];
  const later = reader("code", calls);
  const plan = changeOf(base, head, [reader("declared", calls), later]);
  assert.deepEqual(calls.filter((call) => call === "code"), []);
  assert.deepEqual(plan.frontiers.map(({ kind, evidence }) => [kind, evidence[0]!.path]), [["unreadable-contract", "api/swagger.json"]]);
  const unchanged = changeOf(base, base, [reader("declared"), later]);
  assert.deepEqual(unchanged.frontiers, []);
});

test("an operation declared twice by one reader, or whose servers disagree, is ambiguous: a frontier at every place, no hypothesis", () => {
  const twice = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }, { path: "/a", shape: PET_BASE }])];
  const head = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_HEAD }, { path: "/a", shape: PET_HEAD }])];
  const plan = changeOf(twice, head, [reader("declared")]);
  assert.deepEqual([plan.hypotheses, plan.frontiers.map(({ kind, operation, detail, evidence }) => [kind, operation, detail, evidence.length])], [[], [["ambiguous-operation", "GET /a", "declared more than once", 4]]]);
  const disagree = changeOf([fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE, basePath: null }])], [fileOf("api/openapi.json", [{ path: "/a", shape: PET_HEAD, basePath: null }])], [reader("declared")]);
  assert.deepEqual([disagree.hypotheses, disagree.frontiers.map(({ detail }) => detail)], [[], ["servers disagree"]]);
});

test("a gained guarantee is listed with its operation, property and places; a place the derivation stopped at is a frontier carrying its operation and property", () => {
  const unknown: Shape = { kind: "unknown", reason: "unresolved", evidence: [{ path: "api/openapi.json", line: 1, via: "oneOf" }] };
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", NULLABLE_TEXT), property("owner", TEXT)) }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", TEXT), property("owner", unknown)) }])];
  const plan = changeOf(base, head, [reader("declared")]);
  assert.deepEqual(plan.gained.map(({ operation, property: at, retired }) => [operation, at, retired]), [["GET /pets", "city", "null"]]);
  assert.deepEqual(plan.frontiers.map(({ kind, operation, property: at, side, reason }) => [kind, operation, at, side, reason]), [["unknown-shape", "GET /pets", "owner", "head", "unresolved"]]);
  assert.deepEqual(plan.frontiers[0]!.evidence, unknown.evidence);
});

const REQUEST = { repo: { repo: "web", path: "/work/web" } as WorkspaceRequest["repo"] } as WorkspaceRequest;

/** `refs` names the commit a revision resolves to (itself when absent); `files` holds the sources per commit. */
function setup(files: Record<string, readonly SourceFile[]>, refs: Record<string, string> = {}, cuts: Record<string, readonly Cut[]> = {}) {
  const events: string[] = [];
  const opened: WorkspaceRequest[] = [];
  const shaOf = (revision: string): string => refs[revision] ?? revision;
  const revisions: RevisionSources = {
    resolve: async (_, revision) => (files[shaOf(revision)] === undefined ? { ok: false, fault: { kind: "unknown-revision", detail: revision } } : { ok: true, value: shaOf(revision) }),
    filesAt: async (request, sha) => (events.push(`read ${sha} at ${request.repo.revision}`), { ok: true, value: { files: files[sha]!, cuts: cuts[sha] ?? [] } }),
  };
  const session = { serving: [] } as unknown as ConsumerSession;
  const sources: ConsumerSources = {
    withWorkspace: async (request, run) => {
      events.push("open");
      opened.push(request);
      const value = await run({ serving: asWritten, session: async (hypothesis) => (events.push(`session ${hypothesis.method} ${hypothesis.path} ${hypothesis.property.join(".")}`), { ok: true, value: session }) });
      events.push("close");
      return { ok: true, value };
    },
  };
  return { events, opened, queries: createContractChangeQueries({ sources, revisions, shapes: [reader("declared")] }) };
}

test("the consequences of every derived hypothesis are answered on one prepared workspace, in order, and an operation nothing serves stays an answer of its own", async () => {
  const { events, queries } = setup({ base: [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])], head: [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD }])] });
  const answer = await queries.consequencesOfChange({ workspace: REQUEST, base: "base", head: "head" });
  assert.ok(answer.ok);
  assert.deepEqual(events.filter((event) => !event.startsWith("read")), ["open", "session GET /pets city", "session GET /pets zip", "close"]);
  assert.deepEqual(answer.value.derived.map(({ operation, property: at, change, consequences }) => [operation, at, change, !consequences.ok && consequences.fault.kind]), [["GET /pets", "city", "nullable", "unknown-operation"], ["GET /pets", "zip", "nullable", "unknown-operation"]]);
  assert.deepEqual([answer.value.base, answer.value.head, answer.value.snapshots], ["base", "head", { base: "base", head: "head" }]);
});

test("a change that derives no hypothesis never opens the workspace, and an unreadable revision is the fault of the answer", async () => {
  const same = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])];
  const { events, queries } = setup({ base: same, head: same });
  const answer = await queries.consequencesOfChange({ workspace: REQUEST, base: "base", head: "head" });
  assert.deepEqual([answer.ok && answer.value.derived, events.includes("open")], [[], false]);
  const missing = await queries.consequencesOfChange({ workspace: REQUEST, base: "base", head: "gone" });
  assert.deepEqual([missing.ok, !missing.ok && missing.fault.kind, events.includes("open")], [false, "unknown-revision", false]);
});

const CHANGED = { base: [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])], head: [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD }])] };

test("both revisions are read at the commits they resolve to, and the consequences are answered on the head commit even when the request names a ref that moves", async () => {
  const { events, opened, queries } = setup({ b1: CHANGED.base, h1: CHANGED.head }, { base: "b1", head: "h1", main: "h1" });
  const request = { ...REQUEST, repo: { ...REQUEST.repo, revision: "main" } } as WorkspaceRequest;
  const answer = await queries.consequencesOfChange({ workspace: request, base: "base", head: "head" });
  assert.ok(answer.ok);
  assert.deepEqual(events.filter((event) => event.startsWith("read")), ["read b1 at h1", "read h1 at h1"]);
  assert.deepEqual(opened.map(({ repo }) => repo.revision), ["h1"]);
  assert.deepEqual(answer.value.snapshots, { base: "b1", head: "h1" });
});

test("a workspace bound to another commit than the head of the change, or read live, is refused before anything is read", async () => {
  const { events, queries } = setup({ b1: CHANGED.base, h1: CHANGED.head, h2: CHANGED.head }, { base: "b1", head: "h1", main: "h2" });
  const moved = await queries.consequencesOfChange({ workspace: { ...REQUEST, repo: { ...REQUEST.repo, revision: "main" } } as WorkspaceRequest, base: "base", head: "head" });
  const live = await queries.consequencesOfChange({ workspace: { ...REQUEST, repo: { ...REQUEST.repo, live: true } } as WorkspaceRequest, base: "base", head: "head" });
  assert.deepEqual([moved.ok, !moved.ok && moved.fault.kind, live.ok, !live.ok && live.fault.kind], [false, "contradictory-revisions", false, "contradictory-revisions"]);
  assert.deepEqual(events, []);
});

test("what reading either revision left out is carried once, sorted, beside the derivation", async () => {
  const cut = (kind: Cut["kind"], path: string): Cut => ({ kind, at: [path] });
  const { queries } = setup({ base: CHANGED.base, head: CHANGED.head }, {}, { base: [cut("not-exported", "b.java"), cut("not-exported", "a.java")], head: [cut("not-exported", "a.java"), cut("caller-budget", "z.json")] });
  const answer = await queries.consequencesOfChange({ workspace: REQUEST, base: "base", head: "head" });
  assert.ok(answer.ok);
  assert.deepEqual(answer.value.cuts, [cut("caller-budget", "z.json"), cut("not-exported", "a.java"), cut("not-exported", "b.java")]);
});
