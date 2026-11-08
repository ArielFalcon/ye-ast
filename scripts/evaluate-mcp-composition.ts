/**
 * Evaluation of `ye_ast_compose` against the seven original tools.
 *
 *   --prepare <out-dir>    Runs the real composition fixture, calls the original tools and the composition over the same
 *                          queries, and writes inputs, outputs, measurements, prompts and an answer key. No external call.
 *   --score <run-dir> --responses <responses.jsonl> --judgments <judgments.json>
 *                          Validates consumer responses and adjudications against the prepared run. Claim truth comes
 *                          from the closed corpus and from recorded human/model judgments, never from reading prose.
 *
 * Statuses are pass, fail and not_evaluated; absent data is never a pass.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../src/core/domain/shared/canonical-json.ts";
import { createMcpServer, RESULT_JSON_LABEL, type McpDeps } from "../src/mcp/server.ts";
import { openSession, type Session, type ToolResult } from "../src/mcp/test-session.testing.ts";
import { repositoryCatalog } from "../src/mcp/repository-targeting.ts";
import { runComposition } from "../src/mcp/compose-request.ts";
import { composeFull, composeReceipt, renderComposition } from "../src/mcp/render-composition.ts";
import { familyOf, type ComposeQuery } from "../src/mcp/query-schema.ts";
import type { ResponseMode } from "../src/mcp/presentation.ts";
import type { QueryFamily } from "../src/core/ports/evidence-composition.port.ts";

export const CATEGORIES = [
  "fabricated-causal-link", "reach-as-breakage", "import-as-call", "unknown-as-empty", "cross-snapshot", "invented-decision-option",
] as const;
export type Category = (typeof CATEGORIES)[number];
export const GRAPH_TABLES = ["sources", "snapshots", "reads", "files", "anchors", "evidence", "parts", "entities", "relations", "connections"] as const;
export type GraphTable = (typeof GRAPH_TABLES)[number];
const ID_PREFIX: Record<string, GraphTable> = {
  s1: "sources", v1: "snapshots", r1: "reads", f1: "files", a1: "anchors", e1: "evidence", p1: "parts", n1: "entities", l1: "relations", c1: "connections",
};
const FAMILIES: readonly QueryFamily[] = ["entrypoints", "impact", "callers", "importers", "outline", "workspace", "decisions"];
const COUNTERS = ["unknownFindings", "unknownComponents", "uncertain"] as const;
type Counter = (typeof COUNTERS)[number];

export type Proposition = {
  id: string;
  kind: "required" | "forbidden" | "uncertainty";
  text: string;
  category?: Category;
  /** Tables of the composed graph whose ids may support this proposition. */
  composed?: readonly GraphTable[];
  /** Families of the baseline responses whose pointers may support it. */
  baseline?: readonly QueryFamily[];
  applicableWhen?: { counter: Counter; min: number };
};
export type QuerySelector = { family: QueryFamily; branch?: "local" | "workspace"; revision?: "base" | "head" };
export type CorpusCase = { id: string; overlap: "deliberate" | "partial" | "none" | "mismatch"; question: string; queries: readonly QuerySelector[]; propositions: readonly Proposition[] };
export type Corpus = { schema: "ye-ast-composition-cases/1"; cases: readonly CorpusCase[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function fail(message: string): never {
  throw new EvaluationInputError(message);
}
export class EvaluationInputError extends Error {}

/** Validates the corpus as a closed schema: unknown fields, families, tables, categories or duplicate ids are rejected. */
export function parseCorpus(value: unknown): Corpus {
  if (!isRecord(value) || value.schema !== "ye-ast-composition-cases/1" || !Array.isArray(value.cases)) fail("corpus: wrong schema");
  const seen = new Set<string>();
  const cases = value.cases.map((entry, index): CorpusCase => {
    const at = `corpus.cases[${index}]`;
    if (!isRecord(entry) || !isString(entry.id) || !isString(entry.question) || !Array.isArray(entry.queries) || !Array.isArray(entry.propositions)) fail(`${at}: malformed`);
    if (seen.has(entry.id)) fail(`${at}: duplicate id ${entry.id}`);
    seen.add(entry.id);
    if (!["deliberate", "partial", "none", "mismatch"].includes(entry.overlap as string)) fail(`${at}: overlap`);
    if (entry.queries.length === 0) fail(`${at}: no queries`);
    const queries = entry.queries.map((selector, q): QuerySelector => {
      if (!isRecord(selector) || !FAMILIES.includes(selector.family as QueryFamily)) fail(`${at}.queries[${q}]: family`);
      if (selector.branch !== undefined && selector.branch !== "local" && selector.branch !== "workspace") fail(`${at}.queries[${q}]: branch`);
      if (selector.revision !== undefined && (!["base", "head"].includes(selector.revision as string) || selector.family === "impact")) fail(`${at}.queries[${q}]: revision`);
      return selector as QuerySelector;
    });
    const ids = new Set<string>();
    const propositions = entry.propositions.map((raw, p): Proposition => {
      const where = `${at}.propositions[${p}]`;
      if (!isRecord(raw) || !isString(raw.id) || !/^p\d+$/.test(raw.id) || !isString(raw.text)) fail(`${where}: malformed`);
      if (ids.has(raw.id)) fail(`${where}: duplicate id`);
      ids.add(raw.id);
      if (!["required", "forbidden", "uncertainty"].includes(raw.kind as string)) fail(`${where}: kind`);
      if ((raw.kind === "forbidden") !== (raw.category !== undefined)) fail(`${where}: category is required exactly for forbidden propositions`);
      if (raw.category !== undefined && !CATEGORIES.includes(raw.category as Category)) fail(`${where}: category`);
      if (raw.kind !== "forbidden" && (!Array.isArray(raw.composed) || !Array.isArray(raw.baseline))) fail(`${where}: supported propositions name admissible tables and families`);
      if (raw.composed !== undefined && !(raw.composed as unknown[]).every(t => GRAPH_TABLES.includes(t as GraphTable))) fail(`${where}: table`);
      if (raw.baseline !== undefined && !(raw.baseline as unknown[]).every(f => FAMILIES.includes(f as QueryFamily))) fail(`${where}: family`);
      if (raw.applicableWhen !== undefined) {
        const when = raw.applicableWhen;
        if (!isRecord(when) || !COUNTERS.includes(when.counter as Counter) || !Number.isInteger(when.min)) fail(`${where}: applicableWhen`);
      }
      const known = new Set(["id", "kind", "text", "category", "composed", "baseline", "applicableWhen"]);
      for (const key of Object.keys(raw)) if (!known.has(key)) fail(`${where}: unknown field ${key}`);
      return raw as unknown as Proposition;
    });
    return { id: entry.id, overlap: entry.overlap as CorpusCase["overlap"], question: entry.question, queries, propositions };
  });
  return { schema: "ye-ast-composition-cases/1", cases };
}

export type OrderName = "original" | "reversed" | "interleaved";
const repoOf = (query: ComposeQuery): string => (query.arguments as { repo?: string }).repo ?? "";

/** Distinct presentation orders of the case's query indices: as listed, reversed, and round-robin by repository. */
export function orderVariants(queries: readonly ComposeQuery[]): { name: OrderName; indices: number[] }[] {
  const original = queries.map((_, index) => index);
  const groups = new Map<string, number[]>();
  for (const index of original) groups.set(repoOf(queries[index]!), [...(groups.get(repoOf(queries[index]!)) ?? []), index]);
  const interleaved: number[] = [];
  const lanes = [...groups.values()];
  for (let round = 0; interleaved.length < original.length; round += 1) for (const lane of lanes) if (round < lane.length) interleaved.push(lane[round]!);
  const variants: { name: OrderName; indices: number[] }[] = [
    { name: "original", indices: original }, { name: "reversed", indices: [...original].reverse() }, { name: "interleaved", indices: interleaved },
  ];
  return variants.filter((variant, index) => variants.findIndex(other => other.indices.join() === variant.indices.join()) === index);
}

type FixtureView = { queries: readonly ComposeQuery[]; base: string; head: string };
const isWorkspaceQuery = (query: ComposeQuery) => (query.arguments as { workspace?: unknown }).workspace !== undefined;

/** Picks the fixture's query for each selector; a missing family is reported, never synthesized. */
export function selectQueries(selectors: readonly QuerySelector[], fixture: FixtureView): { ok: true; queries: ComposeQuery[] } | { ok: false; reason: string } {
  const queries: ComposeQuery[] = [];
  for (const selector of selectors) {
    const found = fixture.queries.find(query => familyOf(query.name) === selector.family
      && (selector.branch === undefined || (selector.branch === "workspace") === isWorkspaceQuery(query)));
    if (found === undefined) return { ok: false, reason: `fixture has no ${selector.family}${selector.branch ? `/${selector.branch}` : ""} query` };
    queries.push(selector.revision === undefined ? found : { ...found, arguments: { ...found.arguments, revision: fixture[selector.revision] } } as ComposeQuery);
  }
  return { ok: true, queries };
}

export type ConditionName = "baseline" | "composed";
export const CONDITIONS: readonly ConditionName[] = ["baseline", "composed"];
export const REPLICATES = 2;
/** Prompts carry full responses: citations need the result JSON ids (composed) or pointers (baseline). */
export const PROMPT_MODE: ResponseMode = "full";
const MODES: readonly ResponseMode[] = ["summary", "details", "full"];

type Fixture = FixtureView & { deps: McpDeps; root: string; coldDeps(): McpDeps; dispose(): void };
/** A response as its presentation text and its result fields; a fault has only text. */
type Channels = { text: string; structured: unknown; isError: boolean };
type CallMeasure = { requestBytes: number; textBytes: number; structuredBytes: number; totalBytes: number; wallMs: number; heapUsedAfter: number; sequence: number; cache: string };
type ComposeSurface = "public-tool" | "coordinator-direct";

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const textOf = (result: ToolResult) => result.content.map(part => part.text).join("\n");
/** The content block as delivered: presentation, then the result JSON line when there are result fields. */
const wireOf = (channels: Channels) => channels.structured === undefined ? channels.text : `${channels.text}\n${RESULT_JSON_LABEL}${JSON.stringify(channels.structured)}`;

/** Splits a successful content block at the server's result JSON label into presentation and result fields. */
function channelsOf(result: ToolResult): Channels {
  const text = textOf(result);
  if (result.isError === true) return { text, structured: undefined, isError: true };
  const at = text.lastIndexOf(`\n${RESULT_JSON_LABEL}`);
  if (at === -1) throw new Error("A successful result carries no result JSON line");
  return { text: text.slice(0, at), structured: JSON.parse(text.slice(at + 1 + RESULT_JSON_LABEL.length)), isError: false };
}

/** Replaces private machine paths in stored artifacts; measurements are taken before this. */
export function redactEnvironment(serialized: string, paths: readonly string[]): string {
  let out = serialized;
  for (const [path, label] of [...paths.map(path => [path, "<fixture-root>"] as const), [homedir(), "<home>"] as const].sort((a, b) => b[0].length - a[0].length)) {
    if (path.length > 1) out = out.split(path).join(label);
  }
  return out;
}

type PrepareOptions = { casesPath?: string; loadFixture?: () => Promise<Fixture> };

const defaultCasesPath = () => join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "evaluations", "mcp-composition", "cases.json");

async function defaultFixture(): Promise<Fixture> {
  const { createCompositionFixture } = await import("../src/composition/mcp-evidence-fixture.testing.ts");
  return createCompositionFixture();
}

export async function prepare(outDir: string, options: PrepareOptions = {}): Promise<{ manifest: unknown }> {
  const corpus = parseCorpus(JSON.parse(readFileSync(options.casesPath ?? defaultCasesPath(), "utf8")));
  const started = performance.now();
  const fixture = await (options.loadFixture ?? defaultFixture)();
  const fixtureMs = performance.now() - started;
  const store = (path: string, value: unknown) => {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, redactEnvironment(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, [fixture.root]));
  };
  let session: Session | undefined;
  try {
    session = await openSession(createMcpServer(fixture.deps));
    const tools = await session.listTools();
    const surface: ComposeSurface = tools.some(tool => tool.name === "ye_ast_compose") ? "public-tool" : "coordinator-direct";
    const catalogue = {
      tools: tools.length,
      catalogueBytes: bytes(JSON.stringify({ tools })),
      instructionBytes: bytes(session.instructions ?? ""),
      perTool: tools.map(tool => ({ name: tool.name, bytes: bytes(JSON.stringify(tool)) })),
      composeToolBytes: tools.filter(tool => tool.name === "ye_ast_compose").map(tool => bytes(JSON.stringify(tool)))[0] ?? null,
    };
    let sequence = 0;
    const measure = async (request: unknown, call: () => Promise<Channels>, cache: string): Promise<{ channels: Channels; measure: CallMeasure }> => {
      const t0 = performance.now();
      const channels = await call();
      const wallMs = performance.now() - t0;
      const totalBytes = bytes(wireOf(channels));
      sequence += 1;
      return {
        channels,
        measure: {
          requestBytes: bytes(JSON.stringify(request)), textBytes: bytes(channels.text), structuredBytes: totalBytes - bytes(channels.text),
          totalBytes, wallMs: Math.round(wallMs * 10) / 10,
          heapUsedAfter: process.memoryUsage().heapUsed, sequence, cache,
        },
      };
    };
    const callOriginal = (s: Session, query: ComposeQuery, mode: ResponseMode) => {
      const args = { ...query.arguments, ...(query.expect === undefined ? {} : { expect: query.expect }), mode };
      return { args, call: async (): Promise<Channels> => channelsOf(await s.callTool(query.name, args)) };
    };
    const callCompose = (s: Session, deps: McpDeps, queries: readonly ComposeQuery[], mode: ResponseMode) => {
      const args = { queries, mode };
      return {
        args,
        call: async (): Promise<Channels> => {
          if (surface === "public-tool") return channelsOf(await s.callTool("ye_ast_compose", args));
          const run = await runComposition(args, { deps, catalog: repositoryCatalog(deps.repository, deps.repositories) });
          if (!run.ok) return { text: run.fault.detail, structured: undefined, isError: true };
          return { text: renderComposition(run.value, mode), structured: mode === "full" ? composeFull(run.value) : composeReceipt(run.value, mode), isError: false };
        },
      };
    };

    const cases: unknown[] = [];
    const measurements: unknown[] = [];
    const answerKey: Record<string, unknown> = {};
    const schedule: unknown[] = [];
    for (const entry of corpus.cases) {
      const selected = selectQueries(entry.queries, fixture);
      if (!selected.ok) { cases.push({ id: entry.id, status: "unavailable", reason: selected.reason }); continue; }
      const queries = selected.queries;
      const families = queries.map(query => familyOf(query.name));
      const orders = orderVariants(queries);
      store(`inputs/${entry.id}.json`, { queries: queries.map((query, index) => ({ index, family: families[index], query })), orders });

      const baselineCalls: unknown[] = [];
      const baselineFull: Channels[] = [];
      for (const [index, query] of queries.entries()) {
        for (const mode of MODES) {
          const { args, call } = callOriginal(session, query, mode);
          const result = await measure({ name: query.name, arguments: args }, call, "warm: shared session after earlier calls");
          baselineCalls.push({ queryIndex: index, tool: query.name, mode, isError: result.channels.isError, ...result.measure });
          store(`outputs/${entry.id}/baseline/q${index}.${mode}.json`, result.channels);
          if (mode === "full") baselineFull[index] = result.channels;
        }
      }
      const composedCalls: unknown[] = [];
      let composedFull: Channels | undefined;
      for (const mode of MODES) {
        const { args, call } = callCompose(session, fixture.deps, queries, mode);
        const result = await measure({ name: "ye_ast_compose", arguments: args }, call, "warm: shared session after earlier calls");
        composedCalls.push({ mode, order: "original", isError: result.channels.isError, ...result.measure });
        store(`outputs/${entry.id}/composed/${mode}.json`, result.channels);
        if (mode === "full") composedFull = result.channels;
      }
      // Order variants of the composition request: only digests are kept unless the canonical output differs.
      const variants: unknown[] = [];
      for (const order of orders) {
        const { call } = callCompose(session, fixture.deps, order.indices.map(index => queries[index]!), "full");
        const channels = await call();
        const structuredDigest = digest(canonicalJson(channels.structured ?? null));
        const same = structuredDigest === digest(canonicalJson(composedFull?.structured ?? null));
        if (!same) store(`outputs/${entry.id}/composed/full.${order.name}.json`, channels);
        variants.push({ order: order.name, indices: order.indices, structuredDigest, textDigest: digest(channels.text), identicalToOriginal: same });
      }
      // One cold composition: fresh ports over new index/cache/scratch directories, a new MCP session.
      const coldDeps = fixture.coldDeps();
      const coldSession = await openSession(createMcpServer(coldDeps));
      let cold: unknown;
      try {
        const { args, call } = callCompose(coldSession, coldDeps, queries, "details");
        const result = await measure({ name: "ye_ast_compose", arguments: args }, call, "cold: new ports and directories, new session");
        cold = { mode: "details", isError: result.channels.isError, ...result.measure };
      } finally { await coldSession.close(); }

      const available = composedFull !== undefined && !composedFull.isError && baselineFull.every(channels => !channels.isError);
      const counts = available ? countersOf(composedFull!.structured) : undefined;
      answerKey[entry.id] = {
        families,
        propositions: entry.propositions.map(proposition => ({
          ...proposition,
          applicable: proposition.applicableWhen === undefined ? true : counts === undefined ? "unknown" : counts[proposition.applicableWhen.counter] >= proposition.applicableWhen.min,
        })),
      };
      const sum = (calls: unknown[], mode: ResponseMode, key: keyof CallMeasure) => (calls as (CallMeasure & { mode: ResponseMode })[]).filter(c => c.mode === mode).reduce((total, c) => total + (c[key] as number), 0);
      measurements.push({
        caseId: entry.id,
        overlap: entry.overlap,
        baseline: { calls: baselineCalls, totals: Object.fromEntries(MODES.map(mode => [mode, { requests: queries.length, requestBytes: sum(baselineCalls, mode, "requestBytes"), textBytes: sum(baselineCalls, mode, "textBytes"), structuredBytes: sum(baselineCalls, mode, "structuredBytes"), totalBytes: sum(baselineCalls, mode, "totalBytes") }])) },
        composed: { surface, calls: composedCalls, cold, orderVariants: variants, orderInvariant: variants.every(v => (v as { identicalToOriginal: boolean }).identicalToOriginal), requests: 1, sourceExecutions: new Set(queries.map(q => canonicalJson([q.name, q.arguments]))).size, counts: counts ?? null },
        reexecution: "Composition re-runs every unique query; when the consumer already holds the original responses, the investigation cost is the baseline plus the composition, not the composition alone.",
        tokens: "not-measured: no tokenizer of the consumer model is available",
      });
      if (!available) { cases.push({ id: entry.id, status: "source-error", reason: "an original or composed full call returned an error; see outputs" }); continue; }

      for (const order of orders) {
        for (const condition of CONDITIONS) {
          const prompt = condition === "baseline"
            ? promptFor(entry, condition, order, families, order.indices.map(index => ({ label: `q${index} — ${queries[index]!.name}`, request: callOriginal(session!, queries[index]!, PROMPT_MODE).args, channels: baselineFull[index]! })))
            : promptFor(entry, condition, order, families, [{ label: `ye_ast_compose (${surface})`, request: { queries: order.indices.map(index => queries[index]), mode: PROMPT_MODE }, channels: composedFull! }]);
          store(`prompts/${entry.id}.${condition}.${order.name}.md`, prompt);
        }
      }
      cases.push({ id: entry.id, status: "prepared", overlap: entry.overlap, families, orders: orders.map(order => order.name) });
      const prepared = orders.flatMap(order => Array.from({ length: REPLICATES }, (_, r) => ({ order: order.name, replicate: r + 1 })));
      for (const [index, run] of prepared.entries()) {
        const sequenceOfConditions = index % 2 === 0 ? CONDITIONS : [...CONDITIONS].reverse();
        for (const condition of sequenceOfConditions) schedule.push({ caseId: entry.id, condition, order: run.order, replicate: run.replicate, prompt: `prompts/${entry.id}.${condition}.${run.order}.md` });
      }
    }

    const manifest = {
      schema: "ye-ast-composition-run/1",
      createdAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      acquisition: {
        fixture: "src/composition/mcp-evidence-fixture.testing.ts createCompositionFixture(): two temporary Git repositories (shop, web), base/head commits, isolated index/cache/scratch/trust",
        base: fixture.base, head: fixture.head, fixtureSetupMs: Math.round(fixtureMs),
        baseline: "original tools over an in-memory MCP session of createMcpServer(fixture.deps)",
        composed: surface === "public-tool" ? "ye_ast_compose over the same MCP session" : "runComposition + composeReceipt/composeFull + renderComposition over the same deps (ye_ast_compose was not registered: not the MCP transport)",
      },
      promptMode: PROMPT_MODE,
      consumerReady: surface === "public-tool",
      conditions: CONDITIONS,
      replicates: REPLICATES,
      cases,
      schedule,
      expectedResponses: schedule.map(item => { const { prompt: _prompt, ...key } = item as Record<string, unknown>; return key; }),
      synthesis: { status: "not_evaluated", reason: "no consumer responses yet" },
      memory: { maxRssKiB: process.resourceUsage().maxRSS, label: "process peak RSS since start, includes fixture creation and indexing" },
    };
    store("manifest.json", manifest);
    store("measurements.json", { catalogue, cases: measurements });
    store("answer-key.json", { note: "Do not show to the consumer.", cases: answerKey });
    return { manifest };
  } finally {
    await session?.close();
    fixture.dispose();
  }
}

/** Counters used by `applicableWhen`, read from the composed full structured result (text-mode receipts contain only actions). */
export function countersOf(structured: unknown): Record<Counter, number> {
  const value = structured as { counts: { unknownFindings: number; unknownComponents: number }; coverage: { reads: { partial: number; unknown: number } } };
  const { unknownFindings, unknownComponents } = value.counts;
  return { unknownFindings, unknownComponents, uncertain: unknownFindings + unknownComponents + value.coverage.reads.partial + value.coverage.reads.unknown };
}

function promptFor(entry: CorpusCase, condition: ConditionName, order: { name: OrderName }, families: readonly QueryFamily[], responses: { label: string; request: unknown; channels: Channels }[]): string {
  const citation = condition === "baseline"
    ? "Cite a baseline response as `q<N>:<JSON pointer>`, where N is the number in the response heading and the RFC 6901 pointer (starting with `/`) selects the supporting value inside that response's result JSON. Example: `q0:/value/routes/0`."
    : "Cite composed evidence by a full wire id that appears in the result JSON's `graph` tables (for example a `p1:…` part, `l1:…` relation, `c1:…` connection, `e1:…` evidence or `r1:…` read).";
  return [
    `# ye-ast composition evaluation — ${entry.id} / ${condition} / ${order.name}`,
    "",
    "You receive evidence returned by a read-only code-analysis MCP server. Use only the responses below: no outside knowledge, no tools, no assumptions about code that is not shown.",
    "",
    "## Question", "", entry.question, "",
    "## Proposition catalogue", "",
    "Assert a proposition only when the responses support it; omit any proposition you reject or cannot support. You may add your own claims.",
    "",
    ...entry.propositions.map(proposition => `- ${proposition.id}: ${proposition.text}`),
    "",
    "## Citations", "", citation, "Every claim and every uncertainty needs at least one citation that supports it. A shared location alone does not prove a call, a dependency or a breakage.", "",
    "## Answer format", "",
    "Reply with exactly one JSON object and nothing else:",
    "",
    "```json",
    '{"answer":"<your prose answer to the question>","claims":[{"id":"p1","text":"<your wording>","citations":["<citation>"]}],"uncertainties":[{"id":"extra:1","text":"<limitation you assert>","citations":["<citation>"]}]}',
    "```",
    "",
    "- `claims`: catalogue propositions you assert (their catalogue id) and your own factual claims (`extra:<n>`).",
    "- `uncertainties`: unknown, partial, limited or unresolved points you assert, with a catalogue id or `extra:<n>`.",
    "",
    `## Responses (${responses.length}; families: ${[...new Set(families)].join(", ")})`,
    "",
    ...responses.flatMap(response => [
      `### ${response.label}`, "", "Request:", "", "```json", JSON.stringify(response.request), "```", "",
      "Presentation:", "", "```text", response.channels.text, "```", "",
      "Result JSON:", "", "```json", JSON.stringify(response.channels.structured), "```", "",
    ]),
  ].join("\n");
}

export type Status = "pass" | "fail" | "not_evaluated";
export type FailureCode = Category | "invalid-response" | "duplicate-response" | "unknown-proposition" | "uncited-claim" | "unresolved-citation" | "inadmissible-citation" | "unsupported-claim";
type Assertion = { id: string; text: string; citations: string[] };
export type ResponseLine = { caseId: string; condition: ConditionName; order: OrderName; replicate: number; model: string; answer: string; claims: Assertion[]; uncertainties: Assertion[] };
export type Judgment = { caseId: string; condition: ConditionName; order: OrderName; replicate: number; claimId: string; verdict: "supported" | "unsupported" | "consistent" | "violates"; reason: string; supports: string[]; categories?: Category[] };
type KeyedProposition = Proposition & { applicable: boolean | "unknown" };

const keyOf = (value: { caseId: string; condition: string; order: string; replicate: number }) => `${value.caseId}|${value.condition}|${value.order}|${value.replicate}`;

function parseAssertion(value: unknown): Assertion | undefined {
  if (!isRecord(value) || !isString(value.id) || typeof value.text !== "string" || !stringArray(value.citations)) return undefined;
  return { id: value.id, text: value.text, citations: value.citations };
}

export function parseResponse(value: unknown): ResponseLine | undefined {
  if (!isRecord(value) || !isString(value.caseId) || !CONDITIONS.includes(value.condition as ConditionName) || !isString(value.order)) return undefined;
  if (!Number.isInteger(value.replicate) || !isString(value.model) || typeof value.answer !== "string" || !Array.isArray(value.claims) || !Array.isArray(value.uncertainties)) return undefined;
  const claims = value.claims.map(parseAssertion);
  const uncertainties = value.uncertainties.map(parseAssertion);
  if (claims.some(c => c === undefined) || uncertainties.some(c => c === undefined)) return undefined;
  return { ...(value as unknown as ResponseLine), claims: claims as Assertion[], uncertainties: uncertainties as Assertion[] };
}

function parseJudgments(value: unknown): { adjudicator: { kind: "human" | "model"; id: string }; judgments: Judgment[] } {
  if (!isRecord(value) || !isRecord(value.adjudicator) || !["human", "model"].includes(value.adjudicator.kind as string) || !isString(value.adjudicator.id) || !Array.isArray(value.judgments)) fail("judgments: expected {adjudicator:{kind,id},judgments:[]}");
  const judgments = value.judgments.map((raw, index): Judgment => {
    if (!isRecord(raw) || !isString(raw.caseId) || !isString(raw.claimId) || !Number.isInteger(raw.replicate) || !isString(raw.reason) || !stringArray(raw.supports)
      || !["supported", "unsupported", "consistent", "violates"].includes(raw.verdict as string)) fail(`judgments[${index}]: malformed`);
    if (raw.categories !== undefined && !(Array.isArray(raw.categories) && raw.categories.every(c => CATEGORIES.includes(c as Category)))) fail(`judgments[${index}]: categories`);
    const answerLevel = raw.claimId === "answer";
    if (answerLevel !== (raw.verdict === "consistent" || raw.verdict === "violates")) fail(`judgments[${index}]: answer judgments use consistent/violates, claim judgments supported/unsupported`);
    if (raw.verdict === "violates" && !(Array.isArray(raw.categories) && raw.categories.length > 0)) fail(`judgments[${index}]: a violation names its categories`);
    return raw as unknown as Judgment;
  });
  return { adjudicator: value.adjudicator as { kind: "human" | "model"; id: string }, judgments };
}

/** Resolves an RFC 6901 pointer; `undefined` when any segment is absent. */
export function resolvePointer(document: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(segment) && Number(segment) < current.length) current = current[Number(segment)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

type CaseArtifacts = { families: readonly QueryFamily[]; baseline: readonly unknown[]; graph: Map<GraphTable, Set<string>> };

function loadCaseArtifacts(runDir: string, caseId: string, families: readonly QueryFamily[]): CaseArtifacts {
  const read = (path: string) => JSON.parse(readFileSync(join(runDir, path), "utf8")) as Channels;
  const baseline = families.map((_, index) => read(`outputs/${caseId}/baseline/q${index}.${PROMPT_MODE}.json`).structured);
  const structured = read(`outputs/${caseId}/composed/${PROMPT_MODE}.json`).structured as { graph?: Record<string, { id?: string }[]> };
  const graph = new Map<GraphTable, Set<string>>();
  for (const table of GRAPH_TABLES) graph.set(table, new Set((structured.graph?.[table] ?? []).map(record => record.id).filter(isString)));
  return { families, baseline, graph };
}

/** Where a citation lands, or why it does not resolve. Existence is checked against the prepared artifacts. */
export function resolveCitation(citation: string, condition: ConditionName, artifacts: CaseArtifacts): { ok: true; table?: GraphTable; family?: QueryFamily } | { ok: false } {
  if (condition === "baseline") {
    const match = /^q(\d+):(\/.*)$/.exec(citation);
    if (match === null) return { ok: false };
    const index = Number(match[1]);
    if (index >= artifacts.baseline.length || resolvePointer(artifacts.baseline[index], match[2]!) === undefined) return { ok: false };
    return { ok: true, family: artifacts.families[index]! };
  }
  const table = ID_PREFIX[citation.slice(0, 2)];
  if (table === undefined || citation[2] !== ":" || !artifacts.graph.get(table)!.has(citation)) return { ok: false };
  return { ok: true, table };
}

export type ResponseScore = {
  key: string; status: Status; model?: string;
  failures: { code: FailureCode; claimId?: string; citation?: string }[];
  recall: { requiredApplicable: string[]; requiredAsserted: string[]; uncertaintiesApplicable: string[]; uncertaintiesAsserted: string[] };
  pending: string[];
  rejectedJudgments: { claimId: string; reason: string }[];
};

/** Consumer-local ids may repeat across collections; use exact structural positions instead of dropping claims. */
export function assertionEntries(response: Pick<ResponseLine, "claims" | "uncertainties">): { key: string; assertion: Assertion }[] {
  const rows = [...response.claims.map((assertion, index) => ({ assertion, pointer: `/claims/${index}` })), ...response.uncertainties.map((assertion, index) => ({ assertion, pointer: `/uncertainties/${index}` }))];
  const counts = new Map<string, number>();
  for (const { assertion } of rows) counts.set(assertion.id, (counts.get(assertion.id) ?? 0) + 1);
  return rows.map(({ assertion, pointer }) => ({ key: counts.get(assertion.id) === 1 ? assertion.id : pointer, assertion }));
}

export function scoreRun(runDir: string, responsesText: string | undefined, judgmentsValue: unknown | undefined) {
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as { expectedResponses: { caseId: string; condition: ConditionName; order: OrderName; replicate: number }[] };
  const key = JSON.parse(readFileSync(join(runDir, "answer-key.json"), "utf8")) as { cases: Record<string, { families: QueryFamily[]; propositions: KeyedProposition[] }> };
  const expected = new Map(manifest.expectedResponses.map(item => [keyOf(item), item]));
  const lines = (responsesText ?? "").split("\n").map(line => line.trim()).filter(line => line.length > 0);
  const byKey = new Map<string, ResponseLine | "invalid" | "duplicate">();
  const unexpected: string[] = [];
  const invalidLines: number[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: ResponseLine | undefined;
    try { parsed = parseResponse(JSON.parse(line)); } catch { parsed = undefined; }
    if (parsed === undefined) {
      // A line that names an expected key but is malformed still fails that key.
      let named: string | undefined;
      try { const raw = JSON.parse(line); named = isRecord(raw) ? keyOf(raw as never) : undefined; } catch { named = undefined; }
      if (named !== undefined && expected.has(named)) byKey.set(named, "invalid"); else invalidLines.push(index + 1);
      continue;
    }
    const k = keyOf(parsed);
    if (!expected.has(k)) { unexpected.push(k); continue; }
    byKey.set(k, byKey.has(k) ? "duplicate" : parsed);
  }
  const adjudication = judgmentsValue === undefined ? undefined : parseJudgments(judgmentsValue);
  const judgmentsByKey = new Map<string, Judgment[]>();
  for (const judgment of adjudication?.judgments ?? []) judgmentsByKey.set(keyOf(judgment), [...(judgmentsByKey.get(keyOf(judgment)) ?? []), judgment]);

  const artifacts = new Map<string, CaseArtifacts>();
  const responses: ResponseScore[] = [];
  for (const [k, item] of expected) {
    const caseKey = key.cases[item.caseId];
    const entry = byKey.get(k);
    const score: ResponseScore = { key: k, status: "not_evaluated", failures: [], recall: { requiredApplicable: [], requiredAsserted: [], uncertaintiesApplicable: [], uncertaintiesAsserted: [] }, pending: [], rejectedJudgments: [] };
    responses.push(score);
    if (caseKey === undefined) { score.pending.push("case missing from answer key"); continue; }
    score.recall.requiredApplicable = caseKey.propositions.filter(p => p.kind === "required" && p.applicable !== false).map(p => p.id);
    score.recall.uncertaintiesApplicable = caseKey.propositions.filter(p => p.kind === "uncertainty" && p.applicable !== false).map(p => p.id);
    if (entry === undefined) { score.pending.push("no response"); continue; }
    if (entry === "invalid" || entry === "duplicate") { score.status = "fail"; score.failures.push({ code: entry === "invalid" ? "invalid-response" : "duplicate-response" }); continue; }
    score.model = entry.model;
    if (!artifacts.has(item.caseId)) artifacts.set(item.caseId, loadCaseArtifacts(runDir, item.caseId, caseKey.families));
    const caseArtifacts = artifacts.get(item.caseId)!;
    const propositions = new Map(caseKey.propositions.map(p => [p.id, p]));
    const asserted = new Map<string, Assertion>();
    for (const { key: claimKey, assertion } of assertionEntries(entry)) {
      const proposition = propositions.get(assertion.id);
      if (proposition === undefined && !/^extra:\S+$/.test(assertion.id)) { score.failures.push({ code: "unknown-proposition", claimId: claimKey }); continue; }
      asserted.set(claimKey, assertion);
      if (proposition?.kind === "forbidden" && proposition.applicable === true) score.failures.push({ code: proposition.category!, claimId: claimKey });
      if (assertion.citations.length === 0) score.failures.push({ code: "uncited-claim", claimId: claimKey });
      const resolved: string[] = [];
      let pertinent = proposition === undefined || proposition.kind === "forbidden";
      for (const citation of assertion.citations) {
        const landed = resolveCitation(citation, item.condition, caseArtifacts);
        if (!landed.ok) { score.failures.push({ code: "unresolved-citation", claimId: claimKey, citation }); continue; }
        resolved.push(citation);
        if (landed.table !== undefined ? proposition?.composed?.includes(landed.table) : proposition?.baseline?.includes(landed.family!)) pertinent = true;
      }
      // Required evidence must be present. Additional resolvable context is assessed semantically by adjudication.
      if (!pertinent && resolved.length > 0) score.failures.push({ code: "inadmissible-citation", claimId: claimKey, citation: resolved[0]! });
    }
    const assertedIds = new Set([...asserted.values()].map(assertion => assertion.id));
    score.recall.requiredAsserted = score.recall.requiredApplicable.filter(id => assertedIds.has(id));
    score.recall.uncertaintiesAsserted = score.recall.uncertaintiesApplicable.filter(id => assertedIds.has(id));

    // Adjudications: accepted only when every confirmed support is a resolvable citation the response itself made.
    const judgments = judgmentsByKey.get(k) ?? [];
    const accepted = new Map<string, Judgment>();
    for (const judgment of judgments) {
      if (judgment.claimId === "answer") { accepted.set("answer", judgment); continue; }
      const assertion = asserted.get(judgment.claimId);
      if (assertion === undefined) { score.rejectedJudgments.push({ claimId: judgment.claimId, reason: "judges a claim the response did not make" }); continue; }
      if (judgment.verdict === "supported" && (judgment.supports.length === 0
        || !judgment.supports.every(support => assertion.citations.includes(support) && resolveCitation(support, item.condition, caseArtifacts).ok))) {
        score.rejectedJudgments.push({ claimId: judgment.claimId, reason: "supported verdict without a resolvable support cited by the response" });
        continue;
      }
      accepted.set(judgment.claimId, judgment);
    }
    for (const id of asserted.keys()) {
      const proposition = propositions.get(asserted.get(id)!.id);
      if (proposition?.kind === "forbidden" && proposition.applicable === true) continue;
      const judgment = accepted.get(id);
      if (judgment === undefined) { score.pending.push(`judgment for ${id}`); continue; }
      if (judgment.verdict === "unsupported") {
        for (const category of judgment.categories ?? []) score.failures.push({ code: category, claimId: id });
        score.failures.push({ code: "unsupported-claim", claimId: id });
      }
    }
    const answer = accepted.get("answer");
    if (answer === undefined) score.pending.push("judgment for answer");
    else if (answer.verdict === "violates") for (const category of answer.categories ?? []) score.failures.push({ code: category, claimId: "answer" });
    score.status = score.failures.length > 0 ? "fail" : score.pending.length > 0 ? "not_evaluated" : "pass";
  }

  const groups = new Map<string, Record<Status, number>>();
  for (const response of responses) {
    const [caseId, condition] = response.key.split("|");
    const group = groups.get(`${caseId}|${condition}`) ?? { pass: 0, fail: 0, not_evaluated: 0 };
    group[response.status] += 1;
    groups.set(`${caseId}|${condition}`, group);
  }
  const overall: Status = responses.some(r => r.status === "fail") ? "fail" : responses.length === 0 || responses.some(r => r.status === "not_evaluated") ? "not_evaluated" : "pass";
  return {
    schema: "ye-ast-composition-score/1",
    overall,
    adjudicator: adjudication?.adjudicator ?? null,
    byCaseCondition: Object.fromEntries(groups),
    responses,
    unexpectedResponses: unexpected,
    unparsableLines: invalidLines,
    note: "Per-response results only; no aggregate quality score, no claim about prose identity or general optimality.",
  };
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export async function main(args: readonly string[]): Promise<number> {
  const prepareDir = argument(args, "--prepare");
  const scoreDir = argument(args, "--score");
  try {
    if (prepareDir !== undefined) {
      const { manifest } = await prepare(resolve(prepareDir));
      const m = manifest as { cases: { id: string; status: string }[]; consumerReady: boolean };
      console.log(JSON.stringify({ outDir: resolve(prepareDir), consumerReady: m.consumerReady, cases: m.cases.map(c => `${c.id}:${c.status}`) }, null, 2));
      return 0;
    }
    if (scoreDir !== undefined) {
      const responsesPath = argument(args, "--responses");
      const judgmentsPath = argument(args, "--judgments");
      if (responsesPath === undefined || judgmentsPath === undefined) fail("--score needs --responses and --judgments");
      const responses = existsSync(responsesPath) ? readFileSync(responsesPath, "utf8") : undefined;
      const judgments = existsSync(judgmentsPath) ? JSON.parse(readFileSync(judgmentsPath, "utf8")) : undefined;
      console.log(JSON.stringify(scoreRun(resolve(scoreDir), responses, judgments), null, 2));
      return 0;
    }
    fail("usage: --prepare <out-dir> | --score <run-dir> --responses <responses.jsonl> --judgments <judgments.json>");
  } catch (error) {
    if (error instanceof EvaluationInputError) { console.error(error.message); return 2; }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
