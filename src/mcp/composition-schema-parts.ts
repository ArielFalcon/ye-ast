import { dependencyDiagnostic } from "./dependency-schema.ts";
/**
 * Closed runtime schemas of the domain values a composition carries: shared fact fields, snapshot and
 * read owners, and every `Part` variant. Private to composition-schema.ts; every object is strict and every optional
 * field exact, so an unknown key or an `undefined` member is rejected instead of passed through.
 */
import { z } from "zod";
import { CALL_SITE_CAUSES } from "../core/domain/topology/call-site.ts";
import { TRUST_MODES } from "../core/domain/shared/fact.ts";
import type { Part } from "./composition-contract.ts";
import { compositionIdSchema as idOf } from "./composition-id-schema.ts";

export const ids = {
  source: idOf("s1"), read: idOf("r1"), snapshot: idOf("v1"), file: idOf("f1"), anchor: idOf("a1"), evidence: idOf("e1"),
  part: idOf("p1"), entity: idOf("n1"), relation: idOf("l1"), connection: idOf("c1"), composition: idOf("mcp-c1"),
  recovery: idOf("mcp-r1"),
};

const int = z.int();
const count = z.int().min(0);
const strings = z.array(z.string());
const recordedCollectionState = z.discriminatedUnion("state", [z.strictObject({ state: z.literal("absent") }), z.strictObject({ state: z.literal("present"), count })]);

export const unknownReason = z.enum(["no-extractor", "no-project", "out-of-scope", "index-unavailable", "source-unreadable", "unresolved", "revision-unavailable", "deadline"]);
export const cut = z.strictObject({
  kind: z.enum(["depth", "hub", "caller-budget", "node-cap", "unresolved-link", "deadline", "section", "not-exported", "no-extractor"]),
  at: strings,
  reason: unknownReason.exactOptional(),
  dependency: dependencyDiagnostic.exactOptional(),
  limit: z.number().exactOptional(),
});
export const snapshotRef = z.discriminatedUnion("kind", [
  z.strictObject({ repo: z.string(), kind: z.literal("sha"), sha: z.string() }),
  z.strictObject({ repo: z.string(), kind: z.literal("live"), head: z.string(), stateId: z.string() }),
]);
export const evidenceValue = z.strictObject({
  path: z.string(), line: int, endLine: int.exactOptional(), via: z.string().exactOptional(), confidence: z.number().exactOptional(),
});
export const producer = z.strictObject({ name: z.string(), version: z.string() });
export const schemaVersion = z.templateLiteral([z.int().min(0), ".", z.int().min(0), ".", z.int().min(0)]);
export const factInputs = z.strictObject({
  trust: z.enum(TRUST_MODES),
  scope: z.string(),
  declaredScope: z.strictObject({
    languages: strings, frameworks: strings, include: strings, exclude: strings, ignored: z.literal("git").exactOptional(),
  }),
  content: z.string(),
  config: z.string(),
  declaredConfig: z.strictObject({
    walk: z.strictObject({ depth: z.number().exactOptional(), hubFanIn: z.number().exactOptional(), expansions: z.number().exactOptional() }).exactOptional(),
    targets: strings.exactOptional(),
    files: strings.exactOptional(),
    changed: strings.exactOptional(),
    exportBudget: z.strictObject({ maxEntries: z.number(), maxBytes: z.number() }).exactOptional(),
  }),
  origin: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("full") }), z.strictObject({ kind: z.literal("sync"), base: z.string() })]).exactOptional(),
  engines: z.record(z.string(), z.string()),
});

const ownerBase = [
  z.strictObject({ kind: z.literal("fact") }),
  z.strictObject({ kind: z.literal("entrypoints") }),
  z.strictObject({ kind: z.literal("section"), repo: z.string() }),
] as const;
export const recordedReadKind = z.enum(["discovery", "trigger", "upstream", "downstream"]);
/** A coverage or issue owner: never carries the recorded read kind. */
export const cutOwner = z.discriminatedUnion("kind", [...ownerBase, z.strictObject({ kind: z.literal("read"), repo: z.string(), index: count })]);
/** A read record's owner: a `read` owner keeps the kind its section recorded. */
export const readOwner = z.discriminatedUnion("kind", [...ownerBase, z.strictObject({ kind: z.literal("read"), repo: z.string(), index: count, readKind: recordedReadKind })]);

export const support = z.strictObject({ source: ids.source, read: ids.read, pointer: z.string().regex(/^(\/([^~/]|~[01])*)*$/) });
export const supports = z.array(support).min(1);
export const evidenceOrigin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot"), snapshot: ids.snapshot }),
  z.strictObject({ kind: z.literal("query-context"), read: ids.read }),
]);
export const snapshotVectorEntry = z.strictObject({ repo: z.string(), snapshot: ids.snapshot });

const evidenceList = z.array(ids.evidence);
function evidenceFinding<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("complete"), value, evidence: evidenceList }),
    z.strictObject({ status: z.literal("unknown"), reason: unknownReason, evidence: evidenceList }),
  ]);
}

const httpMethod = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "ANY"]);
const changedOperation = {
  change: z.enum(["added", "removed", "altered"]), method: httpMethod, path: z.string(), operationId: z.string().exactOptional(),
  document: z.string(), line: int, parts: z.array(z.enum(["request", "response"])).exactOptional(),
};
const protocol = z.enum(["kafka", "rabbit", "jms", "event", "nats"]);
export const entrypointKind = z.enum(["http-route", "ui-route", "listener", "job"]);
const basePathKeys = z.strictObject({ contextPath: z.string().exactOptional(), servletPath: z.string().exactOptional(), webfluxBasePath: z.string().exactOptional() });
const entryData = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("http-route"), name: z.string(), method: httpMethod, path: z.string(), version: z.string().exactOptional(),
    handler: ids.anchor, basePath: evidenceFinding(z.strictObject({ default: basePathKeys, profiles: z.record(z.string(), basePathKeys) })),
  }),
  z.strictObject({
    kind: z.literal("ui-route"), name: z.string(), path: z.string(), outlet: z.string().exactOptional(),
    component: z.union([ids.anchor, z.literal("unknown")]),
    guards: z.array(z.strictObject({ name: z.string(), path: z.string().exactOptional(), external: z.literal(true).exactOptional() })),
  }),
  z.strictObject({ kind: z.literal("listener"), name: z.string(), protocol, destination: z.string(), handler: ids.anchor }),
  z.strictObject({ kind: z.literal("job"), name: z.string(), trigger: z.strictObject({ attribute: z.string(), value: z.string() }), handler: ids.anchor }),
]);
export const comparisonRef = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), value: z.strictObject({ repo: z.string(), mergeBase: z.string(), head: ids.snapshot }) }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.literal("missing-provenance"), read: ids.read }),
]);
export const symbolNameRef = z.strictObject({ file: ids.file, symbol: z.string() });
export const dependenceBasis = z.enum(["call", "reference", "contains", "dispatch", "relation", "import"]);
const originReference = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("present"), index: count, part: ids.part }),
  z.strictObject({ status: z.literal("missing"), index: int }),
]);
export const moduleVia = z.strictObject({
  file: z.string(), line: int, specifier: z.string(), kind: z.enum(["import", "reexport"]), typeOnly: z.boolean(),
  form: z.enum(["dynamic-import", "type-query"]).exactOptional(),
});
export const callLocation = z.strictObject({ file: ids.file, line: int, endLine: int.exactOptional() });
const stated = z.strictObject({ method: httpMethod, path: z.string() });
const transport = z.enum(["http", "event"]);
export const callSiteDiagnostic = z.strictObject({
  cause: z.enum(CALL_SITE_CAUSES),
  source: z.enum(["not-read", "read"]).exactOptional(),
  unreadableSources: z.array(evidenceValue).exactOptional(),
  alternatives: z.array(z.string()).exactOptional(),
});
export const unresolvedCallSiteSchema = z.strictObject({
  path: z.string(), line: int, endLine: int.exactOptional(), symbol: z.string(), transport,
  reason: unknownReason, evidence: z.array(evidenceValue), diagnostic: callSiteDiagnostic.exactOptional(),
  via: z.string().exactOptional(), stated: stated.exactOptional(),
});

export const linkBasis = z.enum(["exact", "base-path", "suffix", "operation-id", "event-destination", "gateway-prefix", "route-overlap"]);
export const linkEndpoints = {
  from: z.strictObject({ ...callLocation.shape, repo: z.string(), symbol: z.string() }),
  to: <H extends z.ZodType>(handler: H) => z.strictObject({ repo: z.string(), kind: entrypointKind, name: z.string(), handler }),
};
const outwardKind = z.enum(["http-host", "path-prefix", "configuration-url", "destination", "dependency", "remote", "registry"]);
export const candidateBasis = z.enum(["exact-name", "artifact", "remote", "route-overlap", "event-destination"]);
const workspaceSource = z.enum(["request", "persisted", "none"]);
const gateway = z.strictObject({ prefix: z.string(), repo: z.string(), basis: z.enum(["gateway-prefix", "route-overlap"]) });
const vector = z.array(snapshotVectorEntry);
const workspaceContext = z.union([
  z.strictObject({
    family: z.literal("workspace"),
    workspace: z.strictObject({ repos: strings, gateways: z.array(gateway), source: workspaceSource }),
    repositorySnapshots: vector,
  }),
  z.strictObject({
    family: z.enum(["impact", "callers"]),
    workspace: z.strictObject({
      repos: strings,
      gateways: z.array(gateway),
      unmatchedGateways: z.array(z.strictObject({ prefix: z.string(), repo: z.string() })),
      unserved: strings,
      source: workspaceSource,
    }),
    trigger: z.strictObject({ repo: z.string(), mergeBase: z.string().exactOptional() }),
    repositorySnapshots: vector,
  }),
  z.strictObject({ family: z.literal("decisions"), source: workspaceSource, repositories: vector }),
]);
const decisionOption = z.strictObject({
  value: z.string(),
  basis: z.enum(["exact-name", "artifact", "remote", "route-overlap", "event-destination", "default-branch", "origin"]).exactOptional(),
  evidence: evidenceList,
  recommended: z.boolean(),
});
const fileCategory = z.enum(["importers", "reexporters", "dynamicImporters", "typeImporters", "users", "unresolvedNamers"]);
const fileDependencyCategory = z.enum(["importer", "reexporter", "dynamic-importer", "type-importer", "user", "unresolved-namer", "outline-import"]);

const outlineImport = z.strictObject({
  line: int,
  endLine: int,
  specifier: z.string().exactOptional(),
  kind: z.enum(["import", "reexport"]),
  form: z.enum(["dynamic-import", "type-query", "require", "import-equals"]).exactOptional(),
  typeOnly: z.boolean(),
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("repository"), dependency: ids.part }),
    z.strictObject({ kind: z.literal("external"), module: z.string() }),
    z.strictObject({ kind: z.literal("unresolved"), reason: z.string() }),
  ]),
  bindings: z.array(z.strictObject({
    local: z.string().exactOptional(),
    imported: z.string(),
    typeOnly: z.literal(true).exactOptional(),
    declaration: z.strictObject({ anchor: ids.anchor, kindName: z.string() }).exactOptional(),
  })),
});

const part = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.strictObject({ kind: z.literal(kind), id: ids.part, supports, ...shape });

/** Every one of the 24 `Part` variants, discriminated by `kind`. */
export const partSchema = z.discriminatedUnion("kind", [
  part("entrypoint", { entry: entryData, evidence: evidenceList }),
  part("unknown-finding", { reason: unknownReason, evidence: evidenceList }),
  part("seed", { anchor: ids.anchor, basis: z.enum(["lines", "top-level", "resource", "requested"]), comparison: comparisonRef.exactOptional() }),
  part("symbol-reach", {
    anchor: ids.anchor, kindName: z.string(), depth: count, confidence: z.number(), fanIn: count,
    via: z.strictObject({ target: symbolNameRef, lines: z.array(int).exactOptional(), basis: dependenceBasis }).exactOptional(),
  }),
  part("entrypoint-reach", {
    kindName: z.enum([...entrypointKind.options, "unknown"]), name: z.string().exactOptional(), handler: ids.anchor,
    depth: count, confidence: z.number(), seeds: z.array(originReference),
  }),
  part("entrypoint-change", { change: z.enum(["added", "removed", "altered"]), kindName: entrypointKind, name: z.string(), handler: ids.anchor, comparison: comparisonRef }),
  part("contract-change", { contract: z.strictObject({ ...changedOperation, handlers: z.array(ids.anchor).exactOptional() }), comparison: comparisonRef }),
  part("module-origin", { comparison: comparisonRef, file: z.string(), change: z.enum(["added", "modified", "deleted"]) }),
  part("module-reach", { file: ids.file, side: z.enum(["base", "head"]), depth: count, origins: z.array(originReference), via: moduleVia.exactOptional() }),
  part("file-dependency", { from: ids.file, to: ids.file, category: fileDependencyCategory }),
  part("file-query", { file: ids.file, categories: z.array(z.strictObject({ name: fileCategory, collection: recordedCollectionState })) }),
  part("outline-declaration", { anchor: ids.anchor, kindName: z.string(), children: z.array(ids.part).exactOptional() }),
  part("outline-file", { file: ids.file, declarations: z.array(ids.part), imports: z.array(outlineImport) }),
  part("unheld-file", { file: ids.file }),
  part("trace-step", {
    anchor: ids.anchor, kindName: z.string(), step: count, depth: count, parent: count.exactOptional(), seen: count.exactOptional(),
    at: z.strictObject({ line: count, column: count.exactOptional() }).exactOptional(),
    via: z.enum(["call", "own-member", "reference"]).exactOptional(),
    deferred: z.literal(true).exactOptional(),
    leaves: z.array(z.strictObject({ anchor: ids.anchor, deferred: z.literal(true).exactOptional() })).exactOptional(),
    external: z.array(z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("import"), module: z.string(), names: strings }),
      z.strictObject({ kind: z.enum(["global", "unnamed"]), names: strings }),
    ])).exactOptional(),
  }),
  part("trace-root", { target: z.string(), steps: z.array(count) }),
  part("reading-range", { file: ids.file, start: count, end: count, steps: z.array(count) }),
  part("outward-name", { origin: evidenceOrigin, name: z.string(), kindName: outwardKind, evidence: evidenceList, disposition: z.enum(["stated", "unserved"]) }),
  part("name-candidate", { context: ids.read, name: z.string(), repo: z.string(), basis: candidateBasis, evidence: evidenceList }),
  part("call-site", {
    site: z.strictObject({
      repo: z.string(), symbol: z.string(),
      ancestors: z.array(z.strictObject({ symbol: z.string(), line: int, endLine: int })).exactOptional(),
      transport, diagnostic: callSiteDiagnostic.exactOptional(), stated: stated.exactOptional(), location: callLocation,
      target: evidenceFinding(z.union([
        z.strictObject({ method: httpMethod, path: z.string(), base: z.string().exactOptional(), operationId: z.string().exactOptional() }),
        z.strictObject({ protocol, destination: z.string(), role: z.literal("publish") }),
      ])),
    }),
    disposition: z.enum(["matched", "unmatched", "external"]),
  }),
  part("unresolved-call-site", {
    site: unresolvedCallSiteSchema,
  }),
  part("unlinked-call-site", {
    site: z.strictObject({ from: linkEndpoints.from, transport, outcome: z.enum(["unmatched", "ambiguous"]), name: z.string(), repos: strings.exactOptional() }),
  }),
  part("workspace-link", {
    link: z.strictObject({
      id: z.string(), from: linkEndpoints.from, to: linkEndpoints.to(ids.anchor), transport, basis: linkBasis,
      profiles: strings.exactOptional(), confidence: z.number(),
    }),
    direction: z.enum(["upstream", "downstream"]).exactOptional(),
    reach: z.array(z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("present"), part: ids.part }),
      z.strictObject({ status: z.literal("missing"), linkId: z.string() }),
    ])).exactOptional(),
    operations: z.array(z.strictObject(changedOperation)).exactOptional(),
  }),
  part("workspace-context", { context: workspaceContext }),
  part("decision", {
    context: ids.read, decisionId: z.string(), kindName: z.enum(["membership", "repository", "library", "gateway", "revision", "remote", "trust"]),
    subject: z.string(), outwardKinds: z.array(outwardKind).exactOptional(), allowsFreeText: z.boolean(), required: z.boolean(),
    evidence: evidenceList, options: z.array(decisionOption),
  }),
  part("impact-context", { owner: ids.read, mergeBase: z.string().exactOptional(), changedEntrypoints: recordedCollectionState, changedContracts: recordedCollectionState }),
  part("walk-cost", { owner: ids.read, walk: z.enum(["symbols", "modules"]), expansionsUsed: count }),
  part("trace-totals", { owner: ids.read, lines: count, expanded: count }),
]);

/** Compile-time guard: whatever a schema accepts is its contract shape. */
export type Accepts<Contract, Parsed extends Contract> = Parsed;
export type PartSchemaMatchesContract = Accepts<Part, z.output<typeof partSchema>>;
