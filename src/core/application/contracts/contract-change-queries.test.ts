import assert from "node:assert/strict";
import test from "node:test";
import type { KnownShape, OperationShape, Shape, ShapeProperty, ValueSet } from "../../domain/contracts/payload-shape.ts";
import type { Cut, FactBase, Finding } from "../../domain/shared/fact.ts";
import type { ConsumerSession, ConsumerSources, ServingWorkspace, ServingOperation } from "../../ports/consumer-sources.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PayloadShapes } from "../../ports/payload-shapes.port.ts";
import type { WorkspaceRequest } from "../../ports/workspace-queries.port.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import { createContractChange, planChange } from "./contract-change-queries.ts";
import { createContractConsequencesQueries } from "./contract-consequences-queries.ts";

const set = (overrides: Partial<ValueSet> = {}): ValueSet => ({ literals: { boolean: [], number: [], string: [] }, array: false, object: false, null: false, absent: false, ...overrides });
const TEXT: KnownShape = { kind: "known", values: set({ literals: { boolean: [], number: [], string: "every" } }) };
const NULLABLE_TEXT: KnownShape = { kind: "known", values: set({ literals: { boolean: [], number: [], string: "every" }, null: true }) };
const property = (name: string, shape: Shape): ShapeProperty => ({ name, required: true, shape });
const object = (...properties: ShapeProperty[]): KnownShape => ({ kind: "known", values: set({ object: true }), object: { properties, open: false } });
const literals = (string: KnownShape["values"]["literals"]["string"], number: KnownShape["values"]["literals"]["number"] = []): KnownShape => ({ kind: "known", values: set({ literals: { boolean: [], number, string } }) });
const keyed = (shape: KnownShape, keywords: Record<string, unknown>): KnownShape => ({ ...shape, keywords });
const optional = (name: string, shape: Shape): ShapeProperty => ({ name, required: false, shape });

/** A file whose content is the JSON of the operations it declares; `unreadable` makes the reader fail on it. */
interface Declared {
  method?: string;
  path: string;
  shape?: Shape;
  basePath?: string | null;
  files?: string[];
  /** What the reader states beyond the success body; `null` for a reader that states none. */
  digests?: { request: string; errors: string; envelope: string } | null;
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
          value: { operationId: undefined, method: (operation.method ?? "GET") as OperationShape["method"], path: operation.path, basePath: operation.basePath === null ? undefined : (operation.basePath ?? ""), shape: operation.shape ?? TEXT, files: [file.path, ...(operation.files ?? [])], ...(operation.digests === null ? {} : { digests: operation.digests ?? DIGESTS }) },
          evidence: [{ path: file.path, line: index + 1, via: name }],
        }));
      });
    },
  };
}

const DIGESTS = { request: "r", errors: "e", envelope: "s" };

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
  assert.deepEqual(operationDifferences(plan), [["POST /owners", "operation-added", "compatible"]]);
  assert.deepEqual(plan.differences.find(({ target }) => target === "operation")!.places, { head: { path: "api/openapi.json", line: 2, via: "declared" } });
});

const operationDifferences = (plan: ReturnType<typeof changeOf>) => plan.differences.filter(({ target }) => target === "operation").map(({ operation, rule }) => [operation, rule.id, rule.level]);

/** The workspace serves each path of the table, naming it as its route does; anything else is served by `others`. */
const servedAs = (table: Record<string, string>, others: ServingOperation = { kind: "unserved" }): ServingWorkspace["serving"] => ({ method, path }) => (table[path] === undefined ? others : { kind: "served", method, path: table[path] });

test("an operation a document declares is named as the route that serves it names it, in the hypothesis and an operation no route serves keeps the path the document writes in the lists of added and removed operations", () => {
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE, basePath: "/api" }, { path: "/gone", shape: PET_BASE, basePath: "/api" }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD, basePath: "/api" }, { path: "/new", shape: PET_HEAD, basePath: "/api" }])];
  const plan = changeOf(base, head, [reader("declared")], servedAs({ "/api/pets": "/pets" }));
  assert.deepEqual(plan.hypotheses.map(({ hypothesis, operation }) => [hypothesis.method, hypothesis.path, operation]), [["GET", "/pets", "GET /pets"], ["GET", "/pets", "GET /pets"]]);
  assert.deepEqual(operationDifferences(plan), [["GET /api/gone", "operation-removed", "breaking"], ["GET /api/new", "operation-added", "compatible"]]);
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
  assert.deepEqual(changeOf(same, same, [reader("declared", calls)]), { hypotheses: [], differences: [], frontiers: [] });
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

const RESPONSE_RULES: readonly [string, Shape, Shape, string, string][] = [
  ["response-property-removed", object(property("a", TEXT)), object(), "a", "breaking"],
  ["response-property-became-optional", object(property("a", TEXT)), object(optional("a", TEXT)), "a", "breaking"],
  ["response-property-became-nullable", object(property("a", TEXT)), object(property("a", NULLABLE_TEXT)), "a", "breaking"],
  ["response-property-type-changed", object(property("a", TEXT)), object(property("a", literals("every", "every"))), "a", "breaking"],
  ["response-property-enum-value-added", object(property("a", literals(["A"]))), object(property("a", literals(["A", "B"]))), "a", "review"],
  ["response-property-enum-value-removed", object(property("a", literals(["A", "B"]))), object(property("a", literals(["A"]))), "a", "compatible"],
  ["response-property-became-required", object(optional("a", TEXT)), object(property("a", TEXT)), "a", "compatible"],
  ["response-property-became-non-nullable", object(property("a", NULLABLE_TEXT)), object(property("a", TEXT)), "a", "compatible"],
  ["response-property-type-narrowed", object(property("a", literals("every", "every"))), object(property("a", TEXT)), "a", "compatible"],
  ["response-required-property-added", object(), object(property("a", TEXT)), "a", "compatible"],
  ["response-optional-property-added", object(), object(optional("a", TEXT)), "a", "compatible"],
  ["response-property-constraint-narrowed", object(property("a", TEXT)), object(property("a", keyed(TEXT, { maxLength: 3 }))), "a", "compatible"],
  ["response-property-constraint-widened", object(property("a", keyed(TEXT, { maxLength: 3 }))), object(property("a", TEXT)), "a", "review"],
  ["response-property-constraint-changed", object(property("a", keyed(TEXT, { pattern: "^a" }))), object(property("a", keyed(TEXT, { pattern: "^b" }))), "a", "review"],
  ["response-property-annotation-changed", object(property("a", TEXT)), object(property("a", keyed(TEXT, { deprecated: true }))), "a", "compatible"],
];

for (const [rule, baseShape, headShape, at, level] of RESPONSE_RULES) {
  test(`a change the derivation names is classified by the rule ${rule}, with its level, operation, property and places`, () => {
    const plan = changeOf([fileOf("api/openapi.json", [{ path: "/pets", shape: baseShape }])], [fileOf("api/openapi.json", [{ path: "/pets", shape: headShape }])], [reader("declared")]);
    assert.deepEqual(plan.differences.map(({ rule: { id, level: classified }, target, operation, property: changed }) => [id, classified, target, operation, changed]), [[rule, level, "response", "GET /pets", at]]);
    assert.deepEqual(plan.differences[0]!.places, { base: { path: "api/openapi.json", line: 1, via: "declared" }, head: { path: "api/openapi.json", line: 1, via: "declared" } });
  });
}

test("non-success responses that differ are a review difference, and success responses that differ beyond their schema are another", () => {
  const plan = changeOf([fileOf("api/openapi.json", [{ path: "/pets", digests: DIGESTS }])], [fileOf("api/openapi.json", [{ path: "/pets", digests: { ...DIGESTS, errors: "e2", envelope: "s2" } }])], [reader("declared")]);
  assert.deepEqual(plan.differences.map(({ rule, target, operation, property: at, delta }) => [rule.id, rule.level, target, operation, at, delta]), [
    ["response-error-changed", "review", "response", "GET /pets", undefined, "errors-changed"],
    ["response-success-envelope-changed", "review", "response", "GET /pets", undefined, "envelope-changed"],
  ]);
  assert.deepEqual(plan.frontiers, []);
});

test("a request that differs is an unclassified difference at the operation, never silence, and equal digests report nothing", () => {
  const plan = changeOf([fileOf("api/openapi.json", [{ path: "/pets", digests: DIGESTS }])], [fileOf("api/openapi.json", [{ path: "/pets", digests: { ...DIGESTS, request: "r2" } }])], [reader("declared")]);
  assert.deepEqual([plan.differences, plan.frontiers.map(({ kind, operation, detail, evidence }) => [kind, operation, detail, evidence.length])], [[], [["unclassified-difference", "GET /pets", "request", 2]]]);
  const same = changeOf([fileOf("api/openapi.json", [{ path: "/pets", digests: DIGESTS }])], [fileOf("api/openapi.json", [{ path: "/pets", digests: DIGESTS, files: ["api/other.json"] }])], [reader("declared")]);
  assert.deepEqual([same.differences, same.frontiers], [[], []]);
});

test("changed operations whose reader states no request are one request-unread frontier for the whole change, with each one's place", () => {
  const base = [fileOf("api/code.json", [{ path: "/vets", digests: null }, { path: "/owners", shape: PET_BASE, digests: null }, { path: "/pets", shape: PET_BASE, digests: null }])];
  const head = [fileOf("api/code.json", [{ path: "/pets", shape: PET_HEAD, digests: null }, { path: "/owners", shape: PET_HEAD, digests: null }, { path: "/vets", digests: null }])];
  const plan = changeOf(base, head, [reader("code")]);
  assert.deepEqual(plan.frontiers.map(({ kind, operation, reason, evidence }) => [kind, operation, reason, evidence.map(({ line }) => line)]), [["request-unread", undefined, "no-extractor", [2, 1, 3]]]);
});

test("a derived hypothesis names the rules of every difference it answers, and a keyword difference keeps both values", () => {
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("a", keyed(TEXT, { maxLength: 4 }))) }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(optional("a", keyed(NULLABLE_TEXT, { maxLength: 2 }))) }])];
  const plan = changeOf(base, head, [reader("declared")]);
  assert.deepEqual(plan.hypotheses.map(({ property: at, rules }) => [at, rules]), [["a", ["response-property-became-nullable", "response-property-became-optional"]]]);
  assert.deepEqual(plan.differences.map(({ rule, subject, base: was, head: now }) => [rule.id, subject, was, now]), [
    ["response-property-became-optional", undefined, undefined, undefined],
    ["response-property-became-nullable", undefined, undefined, undefined],
    ["response-property-constraint-narrowed", "maxLength", 4, 2],
  ]);
});

test("a place the derivation stopped at is a frontier carrying its operation and property", () => {
  const unknown: Shape = { kind: "unknown", reason: "unresolved", evidence: [{ path: "api/openapi.json", line: 1, via: "oneOf" }] };
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", NULLABLE_TEXT), property("owner", TEXT)) }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", TEXT), property("owner", unknown)) }])];
  const plan = changeOf(base, head, [reader("declared")]);
  assert.deepEqual(plan.frontiers.map(({ kind, operation, property: at, side, reason }) => [kind, operation, at, side, reason]), [["unknown-shape", "GET /pets", "owner", "head", "unresolved"]]);
  assert.deepEqual(plan.frontiers[0]!.evidence, unknown.evidence);
});

const BASE: FactBase = {
  schema: "0.21.0",
  snapshot: { repo: "web", kind: "sha", sha: "a".repeat(40) },
  producer: { name: "ye-ast", version: "0.0.0" },
  inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
  evidence: [],
};
const SNAPSHOTS = [{ repo: "web", snapshot: BASE.snapshot }];
const REQUEST = { repo: { repo: "web", path: "/work/web" } as WorkspaceRequest["repo"] } as WorkspaceRequest;

interface Options {
  /** A server of the operations is in the workspace, so a hypothesis is answered instead of unknown. */
  served?: boolean;
  /** The commits whose sources cannot be read. */
  unreadable?: readonly string[];
  workspaceCuts?: readonly Cut[];
}

/** `refs` names the commit a revision resolves to (itself when absent); `files` holds the sources per commit. */
function setup(files: Record<string, readonly SourceFile[]>, refs: Record<string, string> = {}, cuts: Record<string, readonly Cut[]> = {}, options: Options = {}) {
  const events: string[] = [];
  const opened: WorkspaceRequest[] = [];
  const shaOf = (revision: string): string => refs[revision] ?? revision;
  const revisions: RevisionSources = {
    resolve: async (_, revision) => (files[shaOf(revision)] === undefined ? { ok: false, fault: { kind: "unknown-revision", detail: revision } } : { ok: true, value: shaOf(revision) }),
    filesAt: async (request, sha) => (events.push(`read ${sha} at ${request.repo.revision}`), options.unreadable?.includes(sha) === true ? { ok: false, fault: { kind: "git-failed", detail: sha } } : { ok: true, value: { files: files[sha]!, cuts: cuts[sha] ?? [] } }),
  };
  const session = { serving: options.served === true ? [{ repo: "api", handler: { path: "Pets.java", symbol: "list", line: 3 } }] : [], links: [], unresolvedCalls: [], ambiguousCalls: [] } as unknown as ConsumerSession;
  const sources: ConsumerSources = {
    withWorkspace: async (request, run) => {
      events.push("open");
      opened.push(request);
      const value = await run({
        base: (declared) => ({ ...BASE, inputs: { ...BASE.inputs, declaredConfig: declared } }),
        repositorySnapshots: SNAPSHOTS,
        cuts: options.workspaceCuts ?? [],
        serving: asWritten,
        session: async (hypothesis) => (events.push(`session ${hypothesis.method} ${hypothesis.path} ${hypothesis.property.join(".")}`), { ok: true, value: session }),
      });
      events.push("close");
      return { ok: true, value };
    },
  };
  const queries = createContractConsequencesQueries({ sources, ofChange: createContractChange({ sources, revisions, shapes: [reader("declared")] }) });
  const ask = async (request: WorkspaceRequest = REQUEST, base = "base", head = "head") => queries.ofChange({ ...request, base, head });
  return { events, opened, queries, ask };
}

/** The composite a change answers, which is never a global unknown while the workspace is read. */
async function composite(answered: ReturnType<ReturnType<typeof setup>["ask"]>) {
  const answer = await answered;
  assert.ok(answer.ok && answer.value.status !== "unknown");
  const { change } = answer.value.value;
  assert.ok(change !== undefined);
  return { fact: answer.value, value: answer.value.value, change };
}

const sectionCuts = (fact: { status: string; cuts?: readonly Cut[] }) => (fact.status === "partial" ? fact.cuts!.map((cut) => cut.at.join()) : []);

const CHANGED = { base: [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])], head: [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD }])] };

test("the hypotheses a change derives are answered on one preparation in the order of operation then property, each stating what it derived from and where, and the composite names what it read", async () => {
  const base = [fileOf("api/openapi.json", [{ path: "/zoo", shape: PET_BASE }, { path: "/pets", shape: PET_BASE }])];
  const head = [fileOf("api/openapi.json", [{ path: "/zoo", shape: PET_HEAD }, { path: "/pets", shape: PET_HEAD }])];
  const { events, ask } = setup({ base, head });

  const { fact, value, change } = await composite(ask());

  assert.deepEqual(events.filter((event) => !event.startsWith("read")), ["open", "session GET /pets city", "session GET /pets zip", "session GET /zoo city", "session GET /zoo zip", "close"]);
  assert.deepEqual(value.answers.map(({ derivedFrom }) => [derivedFrom?.operation, derivedFrom?.property, derivedFrom?.rules]), [
    ["GET /pets", "city", ["response-property-became-nullable"]],
    ["GET /pets", "zip", ["response-property-became-nullable"]],
    ["GET /zoo", "city", ["response-property-became-nullable"]],
    ["GET /zoo", "zip", ["response-property-became-nullable"]],
  ]);
  assert.deepEqual(value.answers[0]!.derivedFrom!.places, { base: { path: "api/openapi.json", line: 2, via: "declared", repo: "web" }, head: { path: "api/openapi.json", line: 2, via: "declared", repo: "web" } });
  assert.deepEqual(value.answers[0]!.oldContract, TEXT.values);
  assert.deepEqual([change.base, change.head, change.snapshots], ["base", "head", { base: "base", head: "head" }]);
  assert.deepEqual([fact.inputs.declaredConfig.base, fact.inputs.declaredConfig.head, value.repositorySnapshots], ["base", "head", SNAPSHOTS]);
  assert.equal(change.derivation.status, "complete");
  assert.deepEqual([fact.status, sectionCuts(fact)], ["partial", ["answers.0", "answers.1", "answers.2", "answers.3"]]);
});

test("the derivation lists every classified difference with its rule, level and places in the repository; an operation one revision declares has only that revision's place", async () => {
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", NULLABLE_TEXT)) }, { path: "/gone" }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", TEXT), optional("zip", TEXT)) }])];
  const { change } = await composite(setup({ base, head }).ask());
  assert.ok(change.derivation.status === "complete");
  const place = (line: number) => ({ path: "api/openapi.json", line, via: "declared", repo: "web" });
  assert.deepEqual(change.derivation.value.differences, [
    { rule: "operation-removed", level: "breaking", target: "operation", operation: "GET /gone", delta: "removed", places: { base: place(2) } },
    { rule: "response-property-became-non-nullable", level: "compatible", target: "response", operation: "GET /pets", property: "city", delta: "retired-null", places: { base: place(1), head: place(1) } },
    { rule: "response-optional-property-added", level: "compatible", target: "response", operation: "GET /pets", property: "zip", delta: "added-optional", places: { base: place(1), head: place(1) } },
  ]);
});

test("both revisions read and compared with nothing derived is a complete composite that still holds the change, and a frontier it recorded makes it visible without making it partial", async () => {
  const same = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])];
  const nothing = await composite(setup({ base: same, head: same }).ask());
  assert.deepEqual([nothing.fact.status, nothing.value.answers, nothing.change.derivation.status, nothing.change.snapshots], ["complete", [], "complete", { base: "base", head: "head" }]);

  const ambiguous = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }, { path: "/pets", shape: PET_BASE }])];
  const recorded = await composite(setup({ base: ambiguous, head: [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_HEAD }, { path: "/pets", shape: PET_HEAD }])] }).ask());
  assert.deepEqual([recorded.fact.status, recorded.value.answers, recorded.change.derivation.status], ["complete", [], "complete"]);
  assert.ok(recorded.change.derivation.status === "complete");
  assert.deepEqual(recorded.change.derivation.value.frontiers.map(({ kind, operation, evidence }) => [kind, operation, evidence.map((place) => place.repo)]), [["ambiguous-operation", "GET /pets", ["web", "web", "web", "web"]]]);
});

test("complete answers beside a derivation that records frontiers are a complete composite, with the frontiers placed in their repository", async () => {
  const unknown: Shape = { kind: "unknown", reason: "unresolved", evidence: [{ path: "api/openapi.json", line: 1, via: "oneOf" }] };
  const base = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", TEXT), property("owner", TEXT)) }])];
  const head = [fileOf("api/openapi.json", [{ path: "/pets", shape: object(property("city", NULLABLE_TEXT), property("owner", unknown)) }])];

  const { fact, value, change } = await composite(setup({ base, head }, {}, {}, { served: true }).ask());

  assert.deepEqual(value.answers.map((answer) => answer.status), ["complete"]);
  assert.ok(change.derivation.status === "complete");
  assert.deepEqual(change.derivation.value.frontiers.map(({ kind, status, reason, evidence }) => [kind, status, reason, evidence]), [["unknown-shape", "unknown", "unresolved", [{ path: "api/openapi.json", line: 1, via: "oneOf", repo: "web" }]]]);
  assert.equal(fact.status, "complete");
});

test("what reading either revision left out stays on the derivation, once and sorted, and makes the composite partial with the derivation as its only cut, with or without a derived hypothesis", async () => {
  const cut = (kind: Cut["kind"], path: string): Cut => ({ kind, at: [path] });
  const cuts = { base: [cut("not-exported", "b.java"), cut("not-exported", "a.java")], head: [cut("not-exported", "a.java"), cut("caller-budget", "z.json")] };
  const expected = [cut("caller-budget", "z.json"), cut("not-exported", "a.java"), cut("not-exported", "b.java")];
  const same = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])];

  for (const files of [{ base: same, head: same }, CHANGED]) {
    const { fact, value, change } = await composite(setup(files, {}, cuts, { served: true }).ask());
    assert.ok(change.derivation.status === "partial");
    assert.deepEqual(change.derivation.cuts, expected);
    assert.deepEqual([fact.status, sectionCuts(fact)], ["partial", ["change.derivation"]]);
    assert.ok(value.answers.every((answer) => answer.status === "complete"));
  }
});

test("a cut of the workspace read reaches the derivation, so a change with nothing derived is not complete over a workspace that was cut", async () => {
  const same = [fileOf("api/openapi.json", [{ path: "/pets", shape: PET_BASE }])];
  const cut: Cut = { kind: "not-exported", at: ["big.java"] };

  const { fact, change } = await composite(setup({ base: same, head: same }, {}, {}, { workspaceCuts: [cut] }).ask());

  assert.ok(change.derivation.status === "partial");
  assert.deepEqual(change.derivation.cuts, [cut]);
  assert.equal(fact.status, "partial");
});

test("a revision whose sources cannot be read leaves the derivation unknown with its reason, the composite partial and the change retained", async () => {
  const { fact, value, change } = await composite(setup({ base: CHANGED.base, head: CHANGED.head }, {}, {}, { unreadable: ["head"] }).ask());

  assert.ok(change.derivation.status === "unknown");
  assert.equal(change.derivation.reason, "revision-unavailable");
  assert.deepEqual([fact.status, sectionCuts(fact), value.answers, change.snapshots], ["partial", ["change.derivation"], [], { base: "base", head: "head" }]);
});

test("both revisions are read at the commits they resolve to, and the consequences are answered on the head commit even when the request names a ref that moves", async () => {
  const { events, opened, ask } = setup({ b1: CHANGED.base, h1: CHANGED.head }, { base: "b1", head: "h1", main: "h1" });

  const { change } = await composite(ask({ ...REQUEST, repo: { ...REQUEST.repo, revision: "main" } } as WorkspaceRequest));

  assert.deepEqual(events.filter((event) => event.startsWith("read")), ["read b1 at h1", "read h1 at h1"]);
  assert.deepEqual(opened.map(({ repo }) => repo.revision), ["h1"]);
  assert.deepEqual(change.snapshots, { base: "b1", head: "h1" });
});

test("a revision that does not resolve, a workspace bound to another commit than the head, or one read live, is refused before anything is read", async () => {
  const { events, ask } = setup({ b1: CHANGED.base, h1: CHANGED.head, h2: CHANGED.head }, { base: "b1", head: "h1", main: "h2" });

  const missing = await ask(REQUEST, "base", "gone");
  const moved = await ask({ ...REQUEST, repo: { ...REQUEST.repo, revision: "main" } } as WorkspaceRequest);
  const live = await ask({ ...REQUEST, repo: { ...REQUEST.repo, live: true } } as WorkspaceRequest);

  assert.deepEqual([missing, moved, live].map((answer) => !answer.ok && answer.fault.kind), ["unknown-revision", "contradictory-revisions", "contradictory-revisions"]);
  assert.deepEqual(events, []);
});
