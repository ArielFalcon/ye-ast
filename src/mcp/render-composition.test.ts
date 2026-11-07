import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { callersValue, entrypointsValue, factOf, importersValue, inputsOf, liveRef, outlineValue, shaRef, SHA_A, SHA_B, sourceFixture, workspaceImpactValue, workspaceValue } from "./composition-fixtures.testing.ts";
import { normalizeSource } from "./composition-normalize.ts";
import { consequencesSource, FRONTIER_PLACE, TEMPLATE_FILE } from "./composition-consequences-fixture.testing.ts";
import { mergeEvidence, materializeEvidence } from "./compose-evidence.ts";
import { compositionIdentity } from "./composition-identity.ts";
import { readFileSync, readdirSync } from "node:fs";
import { composeReceipt, renderComposition } from "./render-composition.ts";
import { COMPOSE_OUTPUT } from "./composition-schema.ts";
import { RESULT_JSON_LABEL } from "./server.ts";
import { renderEntrypointMap, renderImpact, renderOutline } from "./render.ts";
import { blockBytes } from "./presentation-sharing.ts";
import type { ComposeFull, CompositionResult, CoverageSummary, RepeatRequest, ReadOwner } from "./composition-contract.ts";
import type { ExecutedSource } from "./query-runner.ts";
import type { CutOwner } from "./select-evidence.ts";

const digest = { of: (text: string) => createHash("sha256").update(text).digest("hex") };
const ownerOf = (owner: ReadOwner): CutOwner => (owner.kind === "read" ? { kind: "read", repo: owner.repo, index: owner.index } : owner);

/** A coordinator-shaped result over actual normalized and materialized fixtures; requests follow input order. */
function resultOf(sources: readonly ExecutedSource[], requests?: readonly RepeatRequest[]): CompositionResult {
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
      connections: graph.connections.length, unknownFindings: graph.parts.filter((part) => part.kind === "unknown-finding").length, unknownComponents: 1,
    },
    verification: { status: "available", identity: compositionIdentity(digest, graph.sources.map((source) => source.id)) },
    requests: requests ?? sources.map((source) => ({ status: "available", query: source.query, strategy: "fresh-read" })),
  };
}

/** The outline without its duplicated `one` declaration, so the handler binds one unique declaration. */
function uniqueOutline(snapshot = shaRef("shop")): ExecutedSource {
  const value = outlineValue();
  const [controller, ...rest] = value.files;
  assert.ok(controller);
  const files = [{ ...controller, declarations: controller.declarations.filter((_, index) => index !== 2) }, ...rest];
  return sourceFixture("outline", { fact: factOf({ ...value, files }, { snapshot, inputs: inputsOf({ declaredConfig: { files: ["src/OrderController.java"] } }) }) });
}

/** Callers of the one `OrderService.find` declaration the diff seeds, so its `via` resolves exactly as impact's does. */
function singleTargetCallers(): ExecutedSource {
  const value = callersValue();
  return sourceFixture("callers-local", { value: { ...value, seeds: value.seeds.slice(0, 1) } });
}

const overlap = [sourceFixture("entrypoints"), uniqueOutline(), sourceFixture("impact-local"), singleTargetCallers()];
const overlapResult = resultOf(overlap);
const LABEL = /\b([SVNLC])(\d+)\b/g;
const lines = (text: string) => text.split("\n");
const definition = (text: string, label: string) => lines(text).filter((line) => line.trimStart().startsWith(`${label} = `));
const labelOf = (text: string, includes: string[]) => {
  const found = lines(text).filter((line) => / = /.test(line) && includes.every((part) => line.includes(part)));
  assert.equal(found.length, 1, `one definition containing ${includes.join(", ")}:\n${text}`);
  return found[0]!.trim().split(" = ")[0]!;
};

for (const mode of ["summary", "details"] as const) {
  test(`${mode}: every cited label is declared exactly once in the same text`, () => {
    const text = renderComposition(overlapResult, mode);
    const cited = new Set([...text.matchAll(LABEL)].map((match) => match[0]));
    assert.ok(cited.size > 3);
    for (const label of cited) assert.equal(definition(text, label).length, 1, `${label} declared once in:\n${text}`);
    assert.doesNotMatch(text, /[0-9a-f]{64}/, "no repeated 64-hex ids in compact text");
  });
}

test("handler and outline declaration are one subject with aliases, its routes and recorded basePath limits", () => {
  const text = renderComposition(overlapResult, "details");
  const subject = labelOf(text, ["= 6-9 ", "OrderController.one", "one"]);
  const all = lines(text);
  const row = all.findIndex((line) => line.trimStart().startsWith(`${subject} = `));
  const heading = all.slice(0, row).findLast((line) => !line.startsWith(" "));
  assert.ok(heading?.startsWith("src/OrderController.java"), `the subject row belongs to its file block:\n${text}`);
  const route = labelOf(text, ["http GET /orders,"]);
  const served = all.find((line) => line.startsWith(`L`) && line.includes(` = ${route} `) && line.includes(" served by "));
  assert.ok(served?.includes(subject), served);
  assert.match(text, /basePath unknown \(unresolved\)/);
  assert.match(text, /POST \/orders v2[^\n]*basePath default contextPath=\/api; prod servletPath=\/v/);
  assert.match(text, /handler-declaration/);
});

test("a dependence attested by impact and callers is one relation with both supports and its sites", () => {
  const text = renderComposition(overlapResult, "details");
  const relations = overlapResult.graph.relations.filter((relation) => relation.value.kind === "symbol-dependence");
  const rendered = lines(text).filter((line) => line.includes("symbol-dependence"));
  assert.equal(rendered.length, relations.length, text);
  const line = rendered.find((candidate) => candidate.includes("basis call"));
  assert.ok(line);
  assert.match(line, /S3[^\n]*sites 7,8/);
  assert.match(line, /S4[^\n]*sites 7/);
  assert.match(line, /no breakage claim/);
});

test("imports, uses and unresolved names stay distinct from symbol dependences and keep their categories", () => {
  const text = renderComposition(resultOf([sourceFixture("importers"), uniqueOutline(), sourceFixture("callers-local"), sourceFixture("impact-local")]), "details");
  const imports = lines(text).filter((line) => line.includes("file-import"));
  assert.ok(imports.length > 0);
  for (const line of imports) {
    assert.match(line, /categor(y|ies) /);
    assert.doesNotMatch(line, /\bcalls?\b/);
  }
  assert.ok(imports.some((line) => line.includes("type-importer")));
  assert.ok(lines(text).some((line) => line.includes("unresolved-file-name") && line.includes("not a dependency")));
  assert.ok(lines(text).some((line) => line.includes("file-use") && line.includes("not an import")));
  assert.match(text, /reached N\d+(?: \S+)? class[^\n]*via fmt in src\/Util\.java[^\n]* basis reference/);
  assert.match(text, /unresolved-endpoint reached N\d+(?: \S+)? → fmt in src\/Util\.java[^\n]*\(no edge fabricated\)/);
  assert.match(text, /not static\/runtime evidence nor a symbol use/);
});

test("different snapshots and live states stay separate contexts and are declared incompatible", () => {
  const sha = renderComposition(resultOf([sourceFixture("impact-local"), uniqueOutline(shaRef("shop", SHA_B))]), "summary");
  assert.match(sha, new RegExp(`V\\d+ = shop @ ${SHA_A}`));
  assert.match(sha, new RegExp(`V\\d+ = shop @ ${SHA_B}`));
  assert.match(sha, /snapshot-difference shop: V\d+, V\d+/);
  const live = renderComposition(resultOf([sourceFixture("outline", { fact: factOf(outlineValue(), { snapshot: liveRef("shop", "y") }) }), uniqueOutline(liveRef("shop", "x"))]), "summary");
  assert.match(live, new RegExp(`shop live head ${SHA_A} state x`));
  assert.match(live, new RegExp(`shop live head ${SHA_A} state y`));
  assert.match(live, /snapshot-difference shop/);
  assert.doesNotMatch(live, /handler-declaration/);
});

test("partial, unknown, cuts and unknown findings are explicit in every compact mode", () => {
  const all = resultOf([sourceFixture("entrypoints"), sourceFixture("impact-local"), sourceFixture("impact-workspace")]);
  for (const mode of ["summary", "details"] as const) {
    const text = renderComposition(all, mode);
    assert.match(text, /S2 = impact\/local[^\n]*partial/);
    assert.match(text, /depth cut[^\n]*limit 2/);
    assert.match(text, /no-extractor cut/);
    assert.match(text, /unknown \(revision-unavailable\)/);
    assert.match(text, /unknown entrypoint finding \(unresolved\)/);
    assert.match(text, /component unknown/);
    assert.match(text, /missing-link-reference[^\n]*link-missing/);
  }
  assert.match(renderComposition(all, "details"), /src\/Root\.java, src\/Report\.java/);
});

test("decisions keep every option, basis, recommendation and evidence count; a recommendation is not a choice", () => {
  const result = resultOf([sourceFixture("decisions")]);
  const text = renderComposition(result, "summary");
  const decisions = result.graph.parts.flatMap((part) => (part.kind === "decision" ? [part] : []));
  assert.ok(decisions.length > 0);
  for (const decision of decisions) {
    assert.ok(text.includes(decision.subject), decision.subject);
    for (const option of decision.options) {
      const line = lines(text).find((candidate) => candidate.includes(`option ${JSON.stringify(option.value)}`));
      assert.ok(line, option.value);
      if (option.recommended) assert.match(line, /recommended/);
      else assert.doesNotMatch(line, /recommended/);
      if (option.basis !== undefined) assert.ok(line.includes(`basis ${option.basis}`));
    }
  }
  assert.match(text, /recommendations are not user decisions/);
});

test("summary counts omitted evidence and complete recovery controls stay in the receipt", () => {
  const sources = [sourceFixture("entrypoints"), uniqueOutline(), sourceFixture("decisions")];
  const entrypointQuery = { name: "ye_ast_entrypoints" as const, arguments: { repo: "shop", revision: SHA_A }, expect: `mcp-r1:${"1".repeat(64)}` as const };
  const result = resultOf(sources, [
    { status: "available", query: entrypointQuery, strategy: "pinned-replay" },
    { status: "available", query: sources[1]!.query, strategy: "fresh-read" },
    { status: "unavailable", reason: "redacted-context" },
  ]);
  const summary = renderComposition(result, "summary");
  assert.match(summary, new RegExp(`evidence coordinates: ${result.graph.evidence.length}\\b`));
  const navigation = lines(summary).filter((line) => /select\/page/.test(line));
  assert.equal(navigation.length, 0, "navigation strategy is already in the receipt");
  assert.deepEqual(composeReceipt(result, "summary").requests, result.requests);
  assert.equal(result.requests[0]?.status === "available" && result.requests[0].strategy, "pinned-replay");
  assert.match(summary, /S3[^\n]*unavailable \(redacted-context\)/);
  assert.doesNotMatch(summary, /ye_ast_outline[^\n]*select/);
  const details = renderComposition(result, "details");
  assert.ok(blockBytes(lines(details)) >= blockBytes(lines(summary)));
  assert.ok(result.graph.evidence.every((record) => details.includes(`${record.value.path}:${record.value.line}`)));
});

test("deliberate overlap: details is smaller than the concatenated original details and keeps the required facts", () => {
  const details = renderComposition(overlapResult, "details");
  const facts = overlap.map((source) => source.read.fact);
  const originals = [
    renderEntrypointMap(facts[0] as Parameters<typeof renderEntrypointMap>[0], "details"),
    renderOutline(facts[1] as Parameters<typeof renderOutline>[0], "details"),
    renderImpact(facts[2] as Parameters<typeof renderImpact>[0], "details"),
    renderImpact(facts[3] as Parameters<typeof renderImpact>[0], "details"),
  ].join("\n");
  assert.ok(blockBytes(lines(details)) < blockBytes(lines(originals)), `${blockBytes(lines(details))} >= ${blockBytes(lines(originals))}`);
  for (const required of ["GET /orders", "POST /orders v2", "kafka orders", "OrderService.find", "DELETE /orders", "src/gone.ts", "partial", "depth cut", "no-extractor cut", "basePath unknown (unresolved)", "src/Missing.java"]) {
    assert.ok(details.includes(required), required);
  }
});

/**
 * The prepared evaluation run keeps each case's real `full` composition (whose result JSON is the coordinator's whole
 * result) next to the original tools' own details responses over the same fixture. Re-rendering that result measures
 * the current presentation against what a client receives from the original tools: the whole content block, UTF-8.
 */
const RUN = new URL("../../docs/evaluations/mcp-composition/runs/2026-11-05-integrated/outputs/", import.meta.url);
type Channels = { text: string; structured?: unknown };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, RUN), "utf8")) as T;
const channelBytes = (channels: Channels) => Buffer.byteLength(channels.structured === undefined ? channels.text : `${channels.text}\n${RESULT_JSON_LABEL}${JSON.stringify(channels.structured)}`, "utf8");
function realCase(id: string): { result: CompositionResult; baseline: number } {
  const full = readJson<{ structured: ComposeFull }>(`${id}/composed/full.json`).structured;
  const baseline = readdirSync(new URL(`${id}/baseline/`, RUN)).filter((name) => name.endsWith(".details.json"))
    .reduce((total, name) => total + channelBytes(readJson<Channels>(`${id}/baseline/${name}`)), 0);
  const { graph, coverage, counts, verification, requests, delivery } = full;
  return { result: { graph, coverage, counts, verification, requests, ...(delivery === undefined ? {} : { delivery }) }, baseline };
}

/**
 * Every overlap acceptance measures both channels and retains complete safe replay recipes.
 */
for (const id of ["handler-outline", "change-duplicate-dependence", "seven-families"]) {
  test(`real deliberate overlap ${id}: details text plus receipt is smaller than the original details and keeps every limit`, () => {
    const { result, baseline } = realCase(id);
    const receipt = composeReceipt(result, "details");
    const text = renderComposition(result, "details");
    const composed = channelBytes({ text, structured: receipt });
    assert.ok(composed < baseline, `${id}: composed ${composed} >= original ${baseline}`);
    assert.equal(COMPOSE_OUTPUT.safeParse(receipt).success, true);
    assert.deepEqual(receipt.requests, result.requests, "every repeat recipe stays complete in the receipt");
    assert.deepEqual(receipt.verification, result.verification);
    const graph = result.graph;
    for (const snapshot of graph.snapshots) assert.ok(text.includes(snapshot.value.kind === "sha" ? snapshot.value.sha : snapshot.value.stateId), "every snapshot");
    for (const record of graph.evidence) assert.ok(text.includes(`${record.value.line}`) && text.includes(record.value.path), "every evidence coordinate");
    for (const anchor of graph.anchors) assert.ok(text.includes(anchor.symbol) && text.includes(`${anchor.line}`), `anchor ${anchor.symbol}`);
    for (const read of graph.reads) {
      if (read.analysis.status === "partial") for (const cut of read.analysis.cuts) for (const place of cut.at) assert.ok(text.includes(place), `cut place ${place}`);
      if (read.analysis.status === "unknown") assert.ok(text.includes(`unknown (${read.analysis.reason})`));
    }
    for (const issue of result.coverage.issues) assert.ok(text.includes(issue.kind), issue.kind);
    for (const relation of graph.relations) assert.ok(text.includes(relation.value.kind === "serves-entrypoint" ? "served by" : relation.value.kind), relation.value.kind);
    for (const connection of graph.connections) assert.ok(text.includes(connection.rule), connection.rule);
    for (const root of (result.delivery ?? []).flatMap((delivery) => delivery.repositoryRoots ?? [])) assert.ok(text.includes(`${root.repo}=${root.path}`));
    for (const source of graph.sources) {
      const status = source.analysis.status === "unknown" ? `unknown (${source.analysis.reason})` : source.analysis.status;
      assert.match(text, new RegExp(`S${source.requestIndex + 1} = ${source.family}[^\\n]*: ${status.replace(/[()]/g, "\\$&")}`));
    }
  });
}

test("the receipt contains verification and complete repeat requests without duplicating findings or coverage", () => {
  const { result } = realCase("seven-families");
  const receipt = composeReceipt(result, "summary");
  assert.deepEqual(Object.keys(receipt).sort(), ["compositionSchema", "kind", "mode", "requests", "verification"]);
  assert.deepEqual(receipt.requests, result.requests);
  assert.deepEqual(receipt.verification, result.verification);
  assert.ok(result.coverage.limits.length > 0 && result.coverage.issues.length > 0);
});

test("every recorded declaration is stated by exactly one row, whatever sections cite it", () => {
  for (const result of [overlapResult, realCase("seven-families").result, realCase("handler-outline").result]) {
    const text = renderComposition(result, "details");
    for (const entity of result.graph.entities) {
      if (entity.kind !== "declaration") continue;
      const anchor = result.graph.anchors.find((candidate) => candidate.id === entity.anchors[0]);
      assert.ok(anchor);
      const coordinate = `${anchor.line}${anchor.endLine === undefined ? "" : `-${anchor.endLine}`} ${anchor.symbol}`;
      const rows = lines(text).filter((line) => line.replace(/^\s+(N\d+ = )?/, "").startsWith(coordinate));
      assert.equal(rows.length, 1, `${coordinate} stated once:\n${text}`);
    }
    assert.doesNotMatch(text, /outline declaration N\d+/, "an outline declaration is its subject row, never a second finding");
  }
});

test("a context field shared by every read is stated once; a differing one names each value with its reads", () => {
  const { result } = realCase("seven-families");
  const text = renderComposition(result, "details");
  assert.equal(lines(text).filter((line) => line.includes("trust untrusted")).length, 1);
  const producers = [...new Set(result.graph.reads.map((read) => `${read.producer.name} ${read.producer.version}`))];
  assert.ok(producers.length > 1);
  const line = lines(text).find((candidate) => candidate.startsWith("Context producer by read:"));
  for (const producer of producers) assert.ok(line?.includes(`${producer} (`), producer);
  const uniform = renderComposition(realCase("handler-outline").result, "details");
  assert.doesNotMatch(uniform, /producer/, "a uniform provenance field is left to full");
});

test("details states changed contract operations, unresolved workspace call sites and the changed operations a link calls", () => {
  const text = renderComposition(resultOf([sourceFixture("impact-workspace")]), "details");
  for (const required of [
    "contract altered GET /orders/{id} operation getOrder at api/openapi.yaml:12; data changed: response",
    "contract removed DELETE /orders/{id} at api/openapi.yaml:30",
    "contract changes: 2",
    "unresolved call site src/orders.service.ts:52-54 OrdersService.remote",
    "calls changed operations altered GET /orders/{id} (response)",
  ]) assert.ok(text.includes(required), `${required}\n${text}`);
});

test("each relation or connection caveat is stated on the first object of its type", () => {
  const { result } = realCase("seven-families");
  const text = renderComposition(result, "details");
  for (const [needle, kind] of [["no breakage claim", "symbol-dependence"], ["same location, not causality", "shares-evidence"], ["not a call chain", "entrypoint-origin"], ["not a proof of breakage", "change-dependent"]] as const) {
    const carrying = lines(text).filter((line) => line.includes(needle));
    const first = lines(text).find((line) => !line.startsWith("Joined: ") && (line.includes(` ${kind}`) || line.includes(`${kind}:`)));
    assert.equal(carrying.length >= 1 && carrying[0] === first, true, `${kind} caveat on its first line:\n${text}`);
  }
});

test("a used import states once that the dependence is not proven to go through the import", () => {
  const importers = sourceFixture("importers", { value: { files: [{ file: "src/OrderService.java", importers: ["src/OrderController.java"], users: [], unresolvedNamers: [] }] } });
  const text = renderComposition(resultOf([importers, singleTargetCallers()]), "details");
  const carrying = lines(text).filter((line) => line.includes("not proof the dependence goes through this import"));
  assert.deepEqual(carrying, lines(text).filter((line) => /^C\d+ = used-import: /.test(line)), text);
  assert.equal(carrying.length, 1, text);
});

test("an unavailable verification or repeat request is stated in text; an available one is left to the receipt", () => {
  const { result } = realCase("handler-outline");
  assert.doesNotMatch(renderComposition(result, "details"), /Verification|fresh-read|pinned-replay/);
  const unavailable: CompositionResult = { ...result, verification: { status: "unavailable", reason: "redacted-context" }, requests: result.requests.map(() => ({ status: "unavailable", reason: "redacted-context" })) };
  const text = renderComposition(unavailable, "details");
  assert.match(text, /Verification: unavailable \(redacted-context\)/);
  assert.equal(lines(text).filter((line) => /^S\d+ = [^\n]*request unavailable \(redacted-context\)/.test(line)).length, result.graph.sources.length);
  assert.doesNotMatch(text, /Pinned for select\/page/);
});

test("full text navigates the structured tables without a second listing", () => {
  const text = renderComposition(overlapResult, "full");
  for (const table of ["snapshots", "sources", "reads", "files", "anchors", "evidence", "parts", "entities", "bindings", "relations", "connections"]) {
    assert.match(text, new RegExp(`graph\\.${table}`));
  }
  assert.match(text, /coverage\.issues/);
  assert.doesNotMatch(text, /src\/OrderController\.java|GET \/orders/);
  assert.ok(blockBytes(lines(text)) < blockBytes(lines(renderComposition(overlapResult, "summary"))));
  for (const id of ["handler-outline", "seven-families"]) {
    const { result } = realCase(id);
    assert.ok(blockBytes(lines(renderComposition(result, "full"))) < blockBytes(lines(renderComposition(result, "summary"))), `${id}: full navigation is not a per-answer manual`);
  }
});

test("rendering is deterministic and independent of the merge order of the same requests", () => {
  const reversed = [...overlap].reverse();
  const sets = reversed.map((source) => normalizeSource(source, digest));
  const merged = materializeEvidence(sets.slice(1).reduce(mergeEvidence, sets[0]!), digest);
  const same = { ...overlapResult, graph: { ...merged.graph, sources: overlapResult.graph.sources } };
  for (const mode of ["summary", "details", "full"] as const) {
    assert.equal(renderComposition(overlapResult, mode), renderComposition(overlapResult, mode));
    assert.equal(renderComposition(same, mode), renderComposition(overlapResult, mode));
  }
});

test("summary lists every declaration of an outline file, children included, as the outline summary does", () => {
  const text = renderComposition(resultOf([uniqueOutline()]), "summary");
  const [file] = outlineValue().files;
  assert.ok(file);
  const listed = file.declarations.filter((_, index) => index !== 2).flatMap((declaration) => [declaration, ...(declaration.children ?? [])]);
  for (const declaration of listed) assert.ok(text.includes(`${declaration.line}-${declaration.endLine} ${declaration.name}`), `${declaration.name}:\n${text}`);
  assert.match(text, new RegExp(`: ${listed.length} declarations,`));
  const reached = file.imports.flatMap(({ bindings }) => bindings.filter(({ declaration }) => declaration !== undefined)).length;
  assert.match(text, new RegExp(`uncited declarations: ${reached};`), "only the declarations imports reach in other files are uncited");
});

test("summary locates an unknown entrypoint finding by its evidence", () => {
  const text = renderComposition(resultOf([sourceFixture("entrypoints")]), "summary");
  assert.match(text, /unknown entrypoint finding \(unresolved\), evidence src\/Dynamic\.java:4/);
});

test("summary names the handler of a reached entrypoint wherever the reach is cited", () => {
  const text = renderComposition(resultOf([singleTargetCallers()]), "summary");
  for (const line of lines(text).filter((candidate) => candidate.includes("reach of http-route GET /orders"))) assert.match(line, /reach of http-route GET \/orders handler \S/);
  assert.ok(lines(text).some((candidate) => candidate.includes("reach of http-route GET /orders")), text);
});

test("summary lists the cut places of an importers read and counts those of other families", () => {
  const importers = sourceFixture("importers", { fact: factOf(importersValue(), { cuts: [{ kind: "unresolved-link", at: ["src/dyn.ts"] }] }) });
  const text = renderComposition(resultOf([importers, sourceFixture("impact-local")]), "summary");
  assert.match(text, /unresolved-link cut ×1, 1 places: src\/dyn\.ts/);
  assert.match(text, /depth cut ×1, 2 places, limit 2(?!:)/);
});

test("summary keeps the evidence an unknown entrypoint finding does not share when a relation cites it", () => {
  const shared = { path: "src/Dynamic.java", line: 4 };
  const entrypoints = factOf([
    { status: "complete", value: { kind: "job", name: "scheduled cron=0 * * * *", trigger: { attribute: "cron", value: "0 * * * *" }, handler: { path: "src/Jobs.java", symbol: "Jobs.tick", line: 20, endLine: 22 } }, evidence: [shared] },
    { status: "unknown", reason: "unresolved", evidence: [shared, { path: "src/Lost.java", line: 9 }] },
  ]) as ReturnType<typeof entrypointsValue>["entrypoints"];
  const text = renderComposition(resultOf([sourceFixture("entrypoints", { value: { entrypoints } })]), "summary");
  assert.match(text, /shares-evidence/);
  assert.match(text, /src\/Lost\.java:9/);
});

test("a link the workspace map and a workspace callers answer both admit is one workspace-match relation with two attestations, and no link line repeats it", () => {
  const callers = workspaceImpactValue("callers");
  const shared = callers.links[0]!.link;
  const map = sourceFixture("workspace", { value: { ...workspaceValue(), repositorySnapshots: callers.repositorySnapshots, sections: {}, candidates: [], unserved: [], links: [shared], unlinked: [] } });
  const result = resultOf([map, sourceFixture("callers-workspace")]);

  const matches = result.graph.relations.filter((relation) => relation.value.kind === "workspace-match" && relation.value.from.symbol === shared.from.symbol);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.attestations.length, 2);
  const text = renderComposition(result, "details");
  const naming = text.split("\n").filter((line) => line.includes(`${shared.from.symbol} →`));
  assert.equal(naming.filter((line) => /^L\d+ = /.test(line) && line.includes("workspace-match")).length, 1);
  assert.deepEqual(naming.filter((line) => line.startsWith("  link ")), []);
});

test("beside a read that declares a subject, summary counts what only enumerating reads hold and keeps what a connection joins", () => {
  const result = resultOf([sourceFixture("entrypoints"), singleTargetCallers()]);
  const text = renderComposition(result, "summary");
  assert.match(text, /^C\d+ = reached-handler: /m);
  assert.ok(definition(text, labelOf(text, ["http GET /orders,"])).length === 1, text);
  for (const unjoined of ["kafka orders", "Jobs.tick", "shared-support"]) assert.ok(!text.includes(unjoined), `${unjoined}:\n${text}`);
  assert.match(text, /unknown entrypoint finding \(unresolved\)/);
  assert.match(text, /\/orders \(aux\): ui \/orders outlet aux, component unknown/);
  assert.match(text, /Enumeration context not joined \(held only by S1; /);
  const details = renderComposition(result, "details");
  for (const listed of ["kafka orders", "Jobs.tick", "/orders (aux)", "shared-support"]) assert.ok(details.includes(listed), `${listed}:\n${details}`);
});

test("with no read that declares a subject, summary lists every enumerated observation", () => {
  const text = renderComposition(resultOf([sourceFixture("entrypoints")]), "summary");
  for (const listed of ["kafka orders", "Jobs.tick", "/orders (aux)"]) assert.ok(text.includes(listed), `${listed}:\n${text}`);
  assert.doesNotMatch(text, /Enumeration context/);
});

test("summary opens with what was joined: connections per rule, then each source's holdings, then the connections themselves", () => {
  const text = renderComposition(resultOf([sourceFixture("importers"), sourceFixture("entrypoints"), singleTargetCallers()]), "summary");
  const all = lines(text);
  assert.match(all[1] ?? "", /^Joined: reached-handler 1; S1 in no connection\.$/);
  assert.match(text, /^S3 = callers\/local[^\n]*; holds [^\n]*1 entrypoint-reach$/m);
  const firstConnection = all.findIndex((line) => /^C\d+ = /.test(line));
  const firstOther = all.findIndex((line) => /^(N|L)\d+ = |^Context: /.test(line));
  assert.ok(firstConnection > 0 && firstConnection < firstOther, text);
  const alone = renderComposition(resultOf([sourceFixture("importers"), uniqueOutline()]), "summary");
  assert.match(lines(alone)[1] ?? "", /^Joined: no connection; each source answers alone below\.$/);
  const counted = renderComposition(resultOf([sourceFixture("importers"), sourceFixture("entrypoints")]), "summary");
  assert.match(lines(counted)[1] ?? "", /^Joined: no connection with a read that declares a subject; each source answers alone below\.$/);
});

test("the first reference to a subject names it; later references use its label", () => {
  const text = renderComposition(overlapResult, "details");
  const route = labelOf(text, ["http GET /orders,"]);
  const citing = lines(text).filter((line) => !line.trimStart().startsWith(`${route} = `) && new RegExp(`\\b${route}\\b`).test(line));
  assert.ok(citing.length > 1, text);
  assert.ok(citing[0]?.includes(`${route} GET /orders`), citing[0]);
  for (const line of citing.slice(1)) assert.ok(!line.includes(`${route} GET /orders`), line);
});

test("a source the lead names in no connection supports no connection, listed or counted", () => {
  for (const id of ["seven-families", "workspace-link-cut", "imports-vs-symbols"]) {
    const { result } = realCase(id);
    const lead = lines(renderComposition(result, "summary"))[1] ?? "";
    const alone = /; (S[\d, S]+) in no connection\.$/.exec(lead)?.[1]?.split(", ") ?? [];
    for (const label of alone) {
      const source = result.graph.sources.find((candidate) => `S${candidate.requestIndex + 1}` === label);
      assert.ok(source, label);
      assert.equal(result.graph.connections.some((connection) => connection.supports.some((support) => support.source === source.id)), false, `${id}: ${label} in ${lead}`);
    }
  }
});

test("composed unresolved rows retain the diagnostic and causal evidence", () => {
  const text = renderComposition(resultOf([sourceFixture("impact-workspace")]), "details");
  assert.match(text, /unresolved call site.*OrdersService.remote.*destination-undecidable.*read/);
  assert.match(text, /\(library\)\/lib\/Client.java.*17/);
});

test("composition text retains dependency selection diagnostics next to their cuts", () => {
  const value = workspaceValue();
  const section = value.sections.web;
  assert.ok(section && section.status !== "unknown");
  const cut = { kind: "unresolved-link" as const, reason: "unresolved" as const, at: ["pom.xml", "pom.xml:4"], dependency: { name: "com.acme:clients", reason: "unproven-coordinates" as const, candidates: ["clients"] } };
  const result = resultOf([sourceFixture("workspace", { value: { ...value, sections: { ...value.sections, web: { ...section, status: "partial", cuts: [cut] } } } })]);
  for (const mode of ["summary", "details"] as const) assert.match(renderComposition(result, mode), /com.acme:clients.*unproven-coordinates.*clients/);
});

test("details states a trace step's effects with their targets and lines", () => {
  const text = renderComposition(resultOf([sourceFixture("trace")]), "details");
  assert.match(text, /trace step #1 .*; effects http GET \/stock\/\{\} at line 34; message kafka orders\.found at line 36/);
});

test("consequences: an unknown finding is named a consequence finding, and a use and a derived change state their place and handler", () => {
  const result = resultOf([consequencesSource()]);
  const summary = renderComposition(result, "summary");
  assert.match(summary, new RegExp(`unknown consequence finding \\(unresolved\\), evidence ${FRONTIER_PLACE.path.replaceAll(".", "\\.")}:${FRONTIER_PLACE.line}`));
  assert.doesNotMatch(summary, /unknown entrypoint finding/);
  const details = renderComposition(result, "details");
  assert.match(details, new RegExp(`consequence use GET /api/orders/\\{id\\} response customer: incompatible in web at evidence ${TEMPLATE_FILE.replaceAll(".", "\\.")}:1`));
  assert.match(details, /derived from the contract change GET \/api\/orders\/\{id\} customer/);
});

test("trace effects share call-place evidence with links across compatible sources", () => {
  const workspace = workspaceValue();
  const from = workspace.links[0]!.from;
  const snapshot = workspace.repositorySnapshots.find(s => s.repo === from.repo)!.snapshot;
  const trace = sourceFixture("trace", {
    value: { roots: [{ target: `${from.file}:run`, steps: [0] }], steps: [{ id: 0, depth: 0, file: from.file, symbol: "run", kind: "method", line: 1, endLine: 40, effects: [{ kind: "http", line: from.line, target: { method: "GET", path: "/orders" } }] }], readingPlan: { ranges: [], lines: 0 }, cost: { expanded: 1 } },
  });
  trace.read.fact.snapshot = snapshot;
  const result = resultOf([trace, sourceFixture("workspace", { value: workspace })]);
  const shared = result.graph.connections.filter(c => c.rule === "shared-support" && new Set(c.supports.map(s => s.source)).size === 2);
  assert.ok(shared.some(c => c.parts.some(id => result.graph.parts.find(p => p.id === id)?.kind === "trace-step") && c.parts.some(id => result.graph.parts.find(p => p.id === id)?.kind === "workspace-link")));
  assert.match(renderComposition(resultOf([trace]), "summary"), /effects \(1\)/);
  if (trace.read.fact.status !== "unknown") trace.read.fact.value.steps[0]!.effects![0]!.line += 1;
  const shifted = resultOf([trace, sourceFixture("workspace", { value: workspace })]);
  assert.equal(shifted.graph.connections.some(c => c.rule === "shared-support" && c.parts.some(id => shifted.graph.parts.find(p => p.id === id)?.kind === "trace-step") && c.parts.some(id => shifted.graph.parts.find(p => p.id === id)?.kind === "workspace-link")), false);
});
