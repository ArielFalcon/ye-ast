import { test } from "node:test";
import assert from "node:assert/strict";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createHash } from "node:crypto";
import { sourceFixture, type FixtureSource } from "../core/application/composition/composition-fixtures.testing.ts";
import { consequencesSource } from "../core/application/composition/composition-consequences-fixture.testing.ts";
import { normalizeSource } from "../core/application/composition/composition-normalize.ts";
import { mergeEvidence, materializeEvidence } from "../core/application/composition/compose-evidence.ts";
import { compositionIdentity } from "../core/application/composition/composition-identity.ts";
import { composeOutput } from "../mcp/composition-schema.ts";
import { createEvidenceComposition } from "../core/application/composition/evidence-composition.ts";
import type { ComposeQuery } from "../mcp/query-schema.ts";
import { composeFull, composeReceipt } from "../mcp/render-composition.ts";
import type { CompositionResult, CoverageSummary } from "../mcp/composition-contract.ts";
import type { PartKind, ReadOwner } from "../core/ports/evidence-composition.port.ts";
import type { CutOwner } from "../core/domain/composition/source-read.ts";
import { CUT_SUB_REASONS } from "../core/domain/shared/fact.ts";

const digest = { of: (text: string) => createHash("sha256").update(text).digest("hex") };
const COMPOSE_OUTPUT = composeOutput(createEvidenceComposition(digest));
const ALL = [
  sourceFixture("entrypoints"), sourceFixture("impact-local"), sourceFixture("callers-local"), sourceFixture("importers"),
  sourceFixture("outline"), sourceFixture("workspace"), sourceFixture("decisions"), sourceFixture("impact-workspace"),
  sourceFixture("callers-workspace"), sourceFixture("trace"), consequencesSource(),
];

const ownerOf = (owner: ReadOwner): CutOwner => (owner.kind === "read" ? { kind: "read", repo: owner.repo, index: owner.index } : owner);

/** A coordinator-shaped result over actual normalized and materialized fixtures; requests follow input order. */
function resultOf(sources: readonly FixtureSource[]): CompositionResult {
  const sets = sources.map((source) => normalizeSource(source, digest));
  const order = sets.map((set) => set.sources[0]?.id);
  const { graph, issues } = materializeEvidence(sets.slice(1).reduce(mergeEvidence, sets[0]!), digest);
  const coverage: CoverageSummary = {
    reads: {
      complete: graph.reads.filter((read) => read.analysis.status === "complete").length,
      partial: graph.reads.filter((read) => read.analysis.status === "partial").length,
      unknown: graph.reads.filter((read) => read.analysis.status === "unknown").length,
    },
    unknowns: graph.reads.flatMap((read) => (read.analysis.status === "unknown" ? [{ source: read.source, owner: ownerOf(read.owner), reason: read.analysis.reason }] : [])),
    limits: graph.reads.flatMap((read) => (read.analysis.status === "partial"
      ? [...Map.groupBy(read.analysis.cuts, (cut) => cut.kind)].map(([kind, cuts]) => ({ source: read.source, owner: ownerOf(read.owner), kind, cuts: cuts.length, places: cuts.reduce((total, cut) => total + cut.at.length, 0) }))
      : [])),
    issues,
  };
  return {
    graph: { ...graph, sources: graph.sources.map((source) => ({ ...source, requestIndex: order.indexOf(source.id) })) },
    coverage,
    counts: {
      sources: graph.sources.length, reads: graph.reads.length, files: graph.files.length, anchors: graph.anchors.length,
      entities: graph.entities.length, evidence: graph.evidence.length, parts: graph.parts.length, relations: graph.relations.length,
      connections: graph.connections.length, unknownFindings: graph.parts.filter((part) => part.kind === "unknown-finding").length, unknownComponents: 0,
    },
    verification: { status: "available", identity: compositionIdentity(digest, graph.sources.map((source) => source.id)) },
    requests: sources.map((source) => ({ status: "available", query: source.query as ComposeQuery, strategy: "fresh-read" })),
  };
}

const result = resultOf(ALL);
const full = composeFull(result);
const receipt = composeReceipt(result, "details");
const ajv = new AjvJsonSchemaValidator().getValidator(COMPOSE_OUTPUT["~standard"].jsonSchema.output({ target: "draft-07" }));
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const runtime = (value: unknown) => COMPOSE_OUTPUT.safeParse(value).success;

test("full and receipt of every family and workspace branch pass the runtime schema and its draft-7 JSON Schema", () => {
  for (const value of [full, receipt, composeReceipt(result, "summary")]) {
    assert.equal(runtime(value), true, JSON.stringify(COMPOSE_OUTPUT.safeParse(value).error?.issues.slice(0, 3)));
    assert.equal(ajv(json(value)).valid, true);
  }
  for (const source of ALL) assert.equal(runtime(composeFull(resultOf([source]))), true, source.family);
});

test("full keeps every table and all 31 part kinds; graph.sources appears once with request indices", () => {
  const kinds: readonly PartKind[] = [
    "entrypoint", "unknown-finding", "seed", "symbol-reach", "entrypoint-reach", "entrypoint-change", "contract-change", "module-origin", "module-reach",
    "file-dependency", "file-query", "outline-declaration", "outline-file", "unheld-file", "outward-name", "name-candidate", "call-site",
    "unresolved-call-site", "unlinked-call-site", "workspace-link", "workspace-context", "decision", "impact-context", "walk-cost",
    "trace-step", "trace-root", "reading-range", "trace-totals", "consequence-use", "consequence-producer", "derived-contract-change",
  ];
  const parsed = COMPOSE_OUTPUT.parse(full);
  assert.equal(parsed.kind, "composition");
  if (parsed.kind !== "composition") return;
  assert.deepEqual(new Set(parsed.graph.parts.map((part) => part.kind)), new Set(kinds));
  assert.deepEqual(Object.keys(parsed.graph).sort(), ["anchors", "bindings", "connections", "entities", "evidence", "files", "parts", "reads", "relations", "snapshots", "sources"]);
  assert.equal("sources" in parsed, false);
  assert.deepEqual(parsed.graph.sources.map((source) => source.requestIndex).sort((a, b) => a - b), ALL.map((_, index) => index));
  const decision = parsed.graph.parts.find((part) => part.kind === "decision");
  assert.ok(decision?.kind === "decision" && decision.decisionId.length > 0 && decision.decisionId !== decision.id);
  assert.ok(parsed.graph.parts.some((part) => part.kind === "impact-context" && part.mergeBase !== undefined && part.changedEntrypoints.state === "present"));
  assert.ok(parsed.graph.reads.some((read) => read.owner.kind === "read" && read.owner.readKind === "trigger"));
});

test("a receipt is not a Fact and carries no graph tables", () => {
  assert.equal(receipt.kind, "composition-receipt");
  for (const forbidden of [{ graph: full.graph }, { status: "complete" }, { value: {} }, { snapshot: { repo: "shop", kind: "sha", sha: "a" } }]) {
    const extended = { ...receipt, ...forbidden };
    assert.equal(runtime(extended), false, Object.keys(forbidden)[0]);
    assert.equal(ajv(json(extended)).valid, false, Object.keys(forbidden)[0]);
  }
});

type Mutable = { graph: Record<string, Record<string, unknown>[]> } & Record<string, unknown>;
function mutated(change: (copy: Mutable) => void): unknown {
  const copy = json(full) as unknown as Mutable;
  change(copy);
  return copy;
}
function first(copy: Mutable, table: string, where: (record: Record<string, unknown>) => boolean): Record<string, unknown> {
  const found = copy.graph[table]?.find(where);
  assert.ok(found, `fixture lacks a ${table} record`);
  return found;
}

test("malformed variants are rejected by both the runtime schema and the JSON Schema", () => {
  const cases: [string, unknown][] = [
    ["unknown read without reason", mutated((copy) => { first(copy, "reads", () => true).analysis = { status: "unknown" }; })],
    ["partial read without cuts", mutated((copy) => { first(copy, "reads", () => true).analysis = { status: "partial", cuts: [] }; })],
    ["unknown read with a value", mutated((copy) => { first(copy, "reads", () => true).analysis = { status: "unknown", reason: "deadline", value: [] }; })],
    ["evidence without origin", mutated((copy) => { delete first(copy, "evidence", () => true).origin; })],
    ["part without supports", mutated((copy) => { first(copy, "parts", () => true).supports = []; })],
    ["part of an unknown kind", mutated((copy) => { first(copy, "parts", () => true).kind = "summary"; })],
    ["part with a free field", mutated((copy) => { first(copy, "parts", () => true).payload = {}; })],
    ["connection without supports", mutated((copy) => { first(copy, "connections", () => true).supports = []; })],
    ["relation without attestations", mutated((copy) => { first(copy, "relations", () => true).attestations = []; })],
    ["decision option without recommended", mutated((copy) => {
      const decision = first(copy, "parts", (part) => part.kind === "decision" && (part.options as unknown[]).length > 0) as { options: Record<string, unknown>[] };
      delete decision.options[0]!.recommended;
    })],
    ["live snapshot without stateId", mutated((copy) => { first(copy, "snapshots", () => true).value = { repo: "shop", kind: "live", head: "a" }; })],
    ["read owner read without readKind", mutated((copy) => { first(copy, "reads", (read) => (read.owner as { kind: string }).kind === "read").owner = { kind: "read", repo: "web", index: 0 }; })],
    ["short identifier", mutated((copy) => { first(copy, "files", () => true).id = "f1:abc"; })],
    ["impact source without branch", mutated((copy) => { delete first(copy, "sources", (source) => source.family === "impact").branch; })],
    ["outline source with a branch", mutated((copy) => { first(copy, "sources", (source) => source.family === "outline").branch = "local"; })],
    ["verification without identity", { ...full, verification: { status: "available" } }],
    ["fact schema on the composition", { ...full, schema: "0.12.0" }],
  ];
  for (const [name, value] of cases) {
    assert.equal(runtime(value), false, `runtime accepted ${name}`);
    assert.equal(ajv(json(value)).valid, false, `JSON Schema accepted ${name}`);
  }
});

test("cross-id integrity uses the materializer checker: a dangling reference passes JSON Schema but fails runtime", () => {
  const dangling = mutated((copy) => { first(copy, "anchors", () => true).file = `f1:${"0".repeat(64)}`; });
  assert.equal(ajv(json(dangling)).valid, true);
  assert.equal(runtime(dangling), false);
  const outOfRange = { ...full, requests: full.requests.slice(1) };
  assert.equal(runtime(outOfRange), false);
});

test("legal missing-reference and unknown variants stay valid", () => {
  const parts = full.graph.parts;
  assert.ok(parts.some((part) => part.kind === "workspace-link" && (part.reach ?? []).some((reach) => reach.status === "missing")));
  assert.ok(parts.some((part) => part.kind === "entrypoint-reach" && part.seeds.some((seed) => seed.status === "missing")));
  assert.ok(parts.some((part) => part.kind === "entrypoint" && part.entry.kind === "ui-route" && part.entry.component === "unknown"));
  const unavailable = { ...receipt, verification: { status: "unavailable", reason: "redacted-context" }, requests: receipt.requests.map(() => ({ status: "unavailable", reason: "redacted-context" })) };
  assert.equal(runtime(unavailable), true);
  assert.equal(ajv(json(unavailable)).valid, true);
});

test("coverage issues cannot reference sources or parts absent from the full graph", () => {
  const absentSource = `s1:${"0".repeat(64)}`;
  const absentPart = `p1:${"0".repeat(64)}`;
  const source = full.graph.sources[0]!;
  const issueScope = { sources: [source.id], reads: [source.rootRead] };
  for (const broken of [
    { kind: "missing-provenance", sources: [absentSource], reads: [], repo: "shop" },
    { kind: "missing-provenance", ...issueScope, repo: "shop", part: absentPart },
    { kind: "missing-link-reference", ...issueScope, part: absentPart, linkId: "external-link", position: 0 },
  ]) {
    const invalid = { ...full, coverage: { ...full.coverage, issues: [broken] } };
    assert.equal(COMPOSE_OUTPUT.safeParse(invalid).success, false);
  }
});

test("call-site diagnostic causes are closed in both composition schema forms", () => {
  const invalid = json(full);
  const part = invalid.graph.parts.find(p => p.kind === "unresolved-call-site");
  assert.ok(part?.kind === "unresolved-call-site");
  Object.assign(part.site, { diagnostic: { cause: "guess" } });
  assert.equal(runtime(invalid), false);
  assert.equal(ajv(invalid).valid, false);
});

test("dependency selection reasons remain closed in runtime and advertised composition schemas", () => {
  const invalid = json(full);
  const read = invalid.graph.reads.find(read => read.analysis.status === "partial" && read.analysis.cuts.some(cut => cut.dependency !== undefined));
  assert.ok(read?.analysis.status === "partial");
  const cut = read.analysis.cuts.find(cut => cut.dependency !== undefined);
  assert.ok(cut?.dependency);
  Object.assign(cut.dependency, { reason: "guess" });
  assert.equal(runtime(invalid), false);
  assert.equal(ajv(invalid).valid, false);
});

test("compose accepts structured data effects with and without an entity and rejects invalid access", () => {
  const source = sourceFixture("trace");
  const built = composeFull(resultOf([source]));
  const step = built.graph.parts.find((part) => part.kind === "trace-step");
  assert.ok(step?.kind === "trace-step");
  step.effects = [
    { kind: "data", line: 11, operation: "save", access: "write", target: { kind: "entity", name: "shop.Order" } },
    { kind: "data", line: 12, operation: "query", access: "read" },
  ];
  assert.equal(COMPOSE_OUTPUT.safeParse(built).success, true);
  const invalid = structuredClone(built);
  const changed = invalid.graph.parts.find((part) => part.kind === "trace-step");
  assert.ok(changed?.kind === "trace-step");
  Object.assign(changed.effects![0]!, { access: "guessed" });
  assert.equal(COMPOSE_OUTPUT.safeParse(invalid).success, false);
});

test("a cut's sub-reason passes both strict composition schemas only from the closed set, and a cut without a reason is rejected", () => {
  for (const subReason of CUT_SUB_REASONS) {
    const value = json(full);
    const read = value.graph.reads.find((read) => read.analysis.status === "partial");
    assert.ok(read?.analysis.status === "partial");
    Object.assign(read.analysis.cuts[0]!, { reason: "dispatch", subReason });
    assert.equal(runtime(value), true);
    assert.equal(ajv(value).valid, true);
    Object.assign(read.analysis.cuts[0]!, { subReason: "unproven guess" });
    assert.equal(runtime(value), false);
    assert.equal(ajv(value).valid, false);
  }
  const reasonless = json(full);
  const read = reasonless.graph.reads.find((read) => read.analysis.status === "partial");
  assert.ok(read?.analysis.status === "partial");
  delete (read.analysis.cuts[0] as { reason?: unknown }).reason;
  assert.equal(runtime(reasonless), false);
  assert.equal(ajv(reasonless).valid, false);
});

test("a read whose fact used a declared build output, and one that names an unread declaration, pass the schema", () => {
  const plain = sourceFixture("callers-local").read.fact;
  const declared = { ...plain, inputs: { ...plain.inputs, buildOutputs: [{ kind: "node-modules" as const, at: "", verified: false, digest: "d" }] } };
  const unread = { ...plain, status: "partial" as const, cuts: [{ kind: "build-output" as const, at: ["node_modules"], reason: "live-tree", reach: { kind: "anything" } }] } as typeof plain;
  for (const fact of [declared, unread]) {
    const value = composeFull(resultOf([sourceFixture("callers-local", { fact })]));
    assert.equal(runtime(value), true, JSON.stringify(COMPOSE_OUTPUT.safeParse(value).error?.issues.slice(0, 3)));
    assert.equal(ajv(json(value)).valid, true);
  }
});

test("a read whose fact used a declared JDK, and one that names an unusable one, pass the schema", () => {
  const plain = sourceFixture("callers-local").read.fact;
  const declared = { ...plain, inputs: { ...plain.inputs, buildOutputs: [{ kind: "jdk" as const, at: "", verified: false, digest: "d", jdk: { vendor: "Acme", version: "25.0.5", feature: 25, release: 25, basis: "declared-jdk" as const } }] } };
  const unread = { ...plain, status: "partial" as const, cuts: [{ kind: "build-output" as const, at: ["."], reason: "jdk-older-than-build", reach: { kind: "anything" } }] } as typeof plain;
  for (const fact of [declared, unread]) {
    const value = composeFull(resultOf([sourceFixture("callers-local", { fact })]));
    assert.equal(runtime(value), true, JSON.stringify(COMPOSE_OUTPUT.safeParse(value).error?.issues.slice(0, 3)));
    assert.equal(ajv(json(value)).valid, true);
  }
});
