import assert from "node:assert/strict";
import test from "node:test";
import type { KnownShape, OperationShape, Shape, ShapeProperty, ValueSet } from "../../domain/contracts/payload-shape.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { ConsumerSession, ConsumerSources } from "../../ports/consumer-sources.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PayloadShapes } from "../../ports/payload-shapes.port.ts";
import type { WorkspaceRequest } from "../../ports/workspace-queries.port.ts";
import { createContractChangeQueries, planChange, type RevisionSources } from "./contract-change-queries.ts";

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

const PET_BASE = object(property("city", TEXT), property("zip", TEXT));
const PET_HEAD = object(property("city", NULLABLE_TEXT), property("zip", NULLABLE_TEXT));

test("every operation whose sources changed derives its hypotheses, sorted by operation then property, each with its places in the contract at both revisions", () => {
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }, { path: "/owners", shape: PET_BASE }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD }, { path: "/owners", shape: PET_HEAD, method: "POST" }, { path: "/owners", shape: PET_HEAD }])];
  const plan = planChange(base, head, [reader("declared")]);
  assert.deepEqual(plan.hypotheses.map(({ operation, property: at }) => `${operation} ${at}`), ["GET /owners city", "GET /owners zip", "GET /pets city", "GET /pets zip"]);
  assert.deepEqual(plan.hypotheses[2]!.places, { base: { path: "api/openapi.json", line: 1, via: "declared" }, head: { path: "api/openapi.json", line: 1, via: "declared" } });
  assert.deepEqual(plan.hypotheses[0]!.hypothesis, { method: "GET", path: "/owners", target: "response", property: ["city"], change: plan.hypotheses[0]!.hypothesis.change });
  assert.deepEqual(plan.operations, { added: ["POST /owners"], removed: [] });
});

test("an operation whose sources are the same at both revisions derives nothing and reports nothing, even when its place is unknown", () => {
  const unknown: Shape = { kind: "unknown", reason: "unresolved", evidence: [{ path: "api/untouched.json", line: 1, via: "oneOf" }] };
  const untouched = fileOf("api/untouched.json", [{ path: "/stable", shape: unknown }]);
  const base = [untouched, fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])];
  const head = [untouched, fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD }])];
  const plan = planChange(base, head, [reader("declared")]);
  assert.deepEqual(new Set(plan.hypotheses.map(({ operation }) => operation)), new Set(["GET /pets"]));
  assert.deepEqual(plan.frontiers, []);
});

test("a file a shape was read through that changed makes the operation changed, though its own document did not", () => {
  const document = fileOf("api/openapi.json", [{ path: "/pets" }]);
  const throughTypes: PayloadShapes = {
    responses: (files) => [{ status: "complete", value: { operationId: undefined, method: "GET", path: "/pets", basePath: "", shape: files.some((file) => file.path === "api/types.json" && file.content === "[ ]") ? PET_HEAD : PET_BASE, files: ["api/openapi.json", "api/types.json"] }, evidence: [{ path: "api/openapi.json", line: 1 }] }],
  };
  const types = (content: string): SourceFile => ({ path: "api/types.json", content });
  assert.equal(planChange([document, types("[]")], [document, types("[ ]")], [throughTypes]).hypotheses.length, 2);
  assert.equal(planChange([document, types("[]")], [document, types("[]")], [throughTypes]).hypotheses.length, 0);
});

test("the shape a reader states wins over a later reader's for the same operation, which still serves the operations the first does not state", () => {
  const declared = reader("declared");
  const code = reader("code");
  const base = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }, { path: "/b", shape: PET_BASE }])];
  const head = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_HEAD }, { path: "/b", shape: PET_BASE }])];
  const onlyDeclaredA: PayloadShapes = { responses: (files) => declared.responses(files).filter((finding) => finding.status === "complete" && finding.value.path === "/a") };
  const plan = planChange(base, head, [onlyDeclaredA, code]);
  assert.deepEqual([...new Set(plan.hypotheses.flatMap(({ places }) => [places.base.via, places.head.via]))], ["declared"]);
  const unchanged = planChange(base, base, [onlyDeclaredA, code]);
  assert.deepEqual(unchanged.hypotheses, []);
  const codeB = planChange(base, [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }, { path: "/b", shape: PET_HEAD }])], [onlyDeclaredA, code]);
  assert.deepEqual(new Set(codeB.hypotheses.map(({ operation, places }) => `${operation} ${places.head.via}`)), new Set(["GET /b code"]));
});

test("a declared source a reader cannot read is a frontier and stops the readers after it: the code never replaces a contract that was not read", () => {
  const calls: string[] = [];
  const base = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }]), fileOf("api/swagger.json", "unreadable")];
  const head = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }]), { path: "api/swagger.json", content: `${JSON.stringify("unreadable")} ` }];
  const later = reader("code", calls);
  const plan = planChange(base, head, [reader("declared", calls), later]);
  assert.deepEqual(calls.filter((call) => call === "code"), []);
  assert.deepEqual(plan.frontiers.map(({ kind, evidence }) => [kind, evidence[0]!.path]), [["unreadable-contract", "api/swagger.json"]]);
  const unchanged = planChange(base, base, [reader("declared"), later]);
  assert.deepEqual(unchanged.frontiers, []);
});

test("an operation declared twice by one reader, or whose servers disagree, is ambiguous: a frontier at every place, no hypothesis", () => {
  const twice = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE }, { path: "/a", shape: PET_BASE }])];
  const head = [fileOf("api/openapi.json", [{ path: "/a", shape: PET_HEAD }, { path: "/a", shape: PET_HEAD }])];
  const plan = planChange(twice, head, [reader("declared")]);
  assert.deepEqual([plan.hypotheses, plan.frontiers.map(({ kind, operation, detail, evidence }) => [kind, operation, detail, evidence.length])], [[], [["ambiguous-operation", "GET /a", "declared more than once", 4]]]);
  const disagree = planChange([fileOf("api/openapi.json", [{ path: "/a", shape: PET_BASE, basePath: null }])], [fileOf("api/openapi.json", [{ path: "/a", shape: PET_HEAD, basePath: null }])], [reader("declared")]);
  assert.deepEqual([disagree.hypotheses, disagree.frontiers.map(({ detail }) => detail)], [[], ["servers disagree"]]);
});

test("a gained guarantee is listed with its operation, property and places; a place the derivation stopped at is a frontier carrying its operation and property", () => {
  const unknown: Shape = { kind: "unknown", reason: "unresolved", evidence: [{ path: "api/openapi.json", line: 1, via: "oneOf" }] };
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", NULLABLE_TEXT), property("owner", TEXT)) }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", TEXT), property("owner", unknown)) }])];
  const plan = planChange(base, head, [reader("declared")]);
  assert.deepEqual(plan.gained.map(({ operation, property: at, retired }) => [operation, at, retired]), [["GET /pets", "city", "null"]]);
  assert.deepEqual(plan.frontiers.map(({ kind, operation, property: at, side, reason }) => [kind, operation, at, side, reason]), [["unknown-shape", "GET /pets", "owner", "head", "unresolved"]]);
  assert.deepEqual(plan.frontiers[0]!.evidence, unknown.evidence);
});

const REQUEST = { repo: { repo: "web", path: "/work/web" } as WorkspaceRequest["repo"] } as WorkspaceRequest;

function setup(files: Record<string, readonly SourceFile[]>) {
  const events: string[] = [];
  const revisions: RevisionSources = {
    filesAt: async (_, revision) => (files[revision] === undefined ? { ok: false, fault: { kind: "git-failed", detail: revision } } : { ok: true, value: files[revision]! }),
  };
  const session = { serving: [] } as unknown as ConsumerSession;
  const sources: ConsumerSources = {
    withWorkspace: async (_, run) => {
      events.push("open");
      const value = await run({ session: async (hypothesis) => (events.push(`session ${hypothesis.method} ${hypothesis.path} ${hypothesis.property.join(".")}`), { ok: true, value: session }) });
      events.push("close");
      return { ok: true, value };
    },
  };
  return { events, queries: createContractChangeQueries({ sources, revisions, shapes: [reader("declared")] }) };
}

test("the consequences of every derived hypothesis are answered on one prepared workspace, in order, and an operation nothing serves stays an answer of its own", async () => {
  const { events, queries } = setup({ base: [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])], head: [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD }])] });
  const answer = await queries.consequencesOfChange({ workspace: REQUEST, base: "base", head: "head" });
  assert.ok(answer.ok);
  assert.deepEqual(events, ["open", "session GET /pets city", "session GET /pets zip", "close"]);
  assert.deepEqual(answer.value.derived.map(({ operation, property: at, change, consequences }) => [operation, at, change, !consequences.ok && consequences.fault.kind]), [["GET /pets", "city", "nullable", "unknown-operation"], ["GET /pets", "zip", "nullable", "unknown-operation"]]);
  assert.deepEqual([answer.value.base, answer.value.head], ["base", "head"]);
});

test("a change that derives no hypothesis never opens the workspace, and an unreadable revision is the fault of the answer", async () => {
  const same = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])];
  const { events, queries } = setup({ base: same, head: same });
  const answer = await queries.consequencesOfChange({ workspace: REQUEST, base: "base", head: "head" });
  assert.deepEqual([answer.ok && answer.value.derived, events], [[], []]);
  const missing = await queries.consequencesOfChange({ workspace: REQUEST, base: "base", head: "gone" });
  assert.deepEqual([missing.ok, !missing.ok && missing.fault.kind, events], [false, "git-failed", []]);
});
