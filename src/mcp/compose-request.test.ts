import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { EntrypointMapFact } from "../core/domain/map/entrypoint-map.ts";
import type { OutlineValue } from "../core/domain/outline/outline-fact.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import type { WorkspaceFault } from "../core/ports/workspace-repos.port.ts";
import type { FactRead } from "../core/ports/workspace-queries.port.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import { repositoryCatalog } from "./repository-targeting.ts";
import type { QueryExecutionDeps } from "./query-runner.ts";
import type { ComposeInput, CompositionResult, ComposeFault } from "./composition-contract.ts";
import { compositionIdentity } from "./composition-identity.ts";
import { COMPOSE_LIMITS, COMPOSE_QUERY } from "./composition-input.ts";
import { runComposition } from "./compose-request.ts";
import {
  SHA_A, callersValue, decisionsValue, entrypointsValue, factOf, impactValue, importersValue, inputsOf, outlineValue,
  unknownFactOf, workspaceValue,
} from "./composition-fixtures.ts";

const SECRET = /secret-[a-z]+/g;
const digest = { of: (text: string) => createHash("sha256").update(text).digest("hex") };
const redaction: Redaction = {
  redact: (text) => text.replace(SECRET, REDACTED),
  redactValue: (value) => JSON.parse(JSON.stringify(value).replace(SECRET, REDACTED)) as unknown,
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: (error) => String(error instanceof Error ? error.message : error).replace(SECRET, REDACTED),
  containsSecret: (text) => /secret-[a-z]+/.test(text),
};

type Port = "map" | "ofChange" | "callers" | "importers" | "outline" | "outwardNames" | "decisions" | "workspaceCallers" | "workspaceOfChange";
type Hooks = Partial<{
  outline: (signal: AbortSignal | undefined) => Promise<Result<Fact<OutlineValue>, never>>;
  decisions: () => Promise<Result<FactRead<DecisionValue>, WorkspaceFault>>;
}>;

function mapFact(): EntrypointMapFact {
  const fact = factOf(entrypointsValue());
  if (fact.status === "unknown") assert.fail("the fixture is known");
  return fact;
}

function spies(hooks: Hooks = {}) {
  const calls: Port[] = [];
  const deps: QueryExecutionDeps = {
    entrypoints: { map: async () => (calls.push("map"), { ok: true, value: mapFact() }) },
    impact: {
      ofChange: async () => (calls.push("ofChange"), { ok: true, value: factOf(impactValue(), { inputs: inputsOf({ declaredConfig: { walk: { depth: 2 } } }) }) }),
      callers: async () => (calls.push("callers"), { ok: true, value: factOf(callersValue(), { inputs: inputsOf({ declaredConfig: { targets: ["src/OrderService.java#find"] } }) }) }),
      importers: async () => (calls.push("importers"), { ok: true, value: factOf(importersValue()) }),
    },
    outline: { outline: async (r) => (calls.push("outline"), hooks.outline ? hooks.outline(r.signal) : { ok: true, value: factOf(outlineValue()) }) },
    workspace: { outwardNames: async () => (calls.push("outwardNames"), { ok: true, value: { fact: factOf({ ...workspaceValue(), repositories: [] }), repositoryRoots: [{ repo: "shop", path: "/work/shop" }] } }) },
    workspaceImpact: {
      callers: async () => assert.fail("workspace callers not expected"),
      ofChange: async () => assert.fail("workspace impact not expected"),
    },
    decisions: { decisions: async () => (calls.push("decisions"), hooks.decisions ? hooks.decisions() : { ok: true, value: { fact: factOf(decisionsValue()) } }) },
    redaction,
    digest,
  };
  return { deps, calls, ctx: (signal?: AbortSignal) => ({ deps, catalog: repositoryCatalog({ path: "/work/shop", repoId: "shop" }), ...(signal === undefined ? {} : { signal }) }) };
}

const Q = {
  entrypoints: { name: "ye_ast_entrypoints", arguments: { repo: "shop", revision: SHA_A } },
  impact: { name: "ye_ast_impact", arguments: { repo: "shop", base: "main", head: SHA_A } },
  callers: { name: "ye_ast_callers", arguments: { repo: "shop", revision: SHA_A, targets: [{ file: "src/OrderService.java", symbol: "find" }] } },
  importers: { name: "ye_ast_importers", arguments: { repo: "shop", revision: SHA_A, files: ["src/service.ts"] } },
  outline: { name: "ye_ast_outline", arguments: { repo: "shop", revision: SHA_A, files: ["src/OrderController.java"] } },
  workspace: { name: "ye_ast_workspace", arguments: { repo: "shop", revision: SHA_A, offline: true } },
  decisions: { name: "ye_ast_decisions", arguments: { repo: "shop" } },
} as const satisfies Record<string, ComposeInput["queries"][number]>;
const ALL = Object.values(Q);

function ok(result: Result<CompositionResult, ComposeFault>): CompositionResult {
  if (!result.ok) assert.fail(`unexpected fault ${JSON.stringify(result.fault)}`);
  return result.value;
}
function fault(result: Result<CompositionResult, ComposeFault>): ComposeFault {
  if (result.ok) assert.fail("expected a fault");
  return result.fault;
}
/** Direct callers that bypass the SDK still pass through the runtime schema; the cast only feeds invalid shapes to it. */
const unchecked = (value: unknown) => value as ComposeInput;

test("invalid input fails as SDK invalid params before any dispatch", async () => {
  const { calls, ctx } = spies();
  const invalid: unknown[] = [
    {},
    { queries: [] },
    { queries: Array.from({ length: 17 }, () => Q.outline) },
    { queries: [{ ...Q.outline, arguments: { ...Q.outline.arguments, mode: "full" } }] },
    { queries: [{ ...Q.entrypoints, select: { kind: "entrypoint-evidence", findingIndex: 0 }, page: { limit: 1 } }] },
    { queries: [Q.outline], page: { limit: 1 } },
    { queries: [{ name: "ye_ast_compose", arguments: { queries: [Q.outline] } }] },
    { queries: [{ name: "ye_ast_nope", arguments: {} }] },
    { queries: [{ ...Q.outline, expect: `mcp-r1:${"a".repeat(64)}` }] },
    { queries: [Q.outline], deadlineMs: 0 },
    { queries: [Q.outline], deadlineMs: 2147483648 },
    { queries: [Q.outline], expect: `mcp-r1:${"a".repeat(64)}` },
  ];
  for (const input of invalid) {
    await assert.rejects(runComposition(unchecked(input), ctx()), (error: unknown) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test("request bytes are UTF-8 of canonical JSON, limit inclusive, rejected before dispatch", async () => {
  const sized = (filler: string): ComposeInput => ({ queries: [{ name: "ye_ast_outline", arguments: { repo: "shop", revision: SHA_A, files: [`src/${filler}`] } }] });
  const bytes = (input: ComposeInput) => Buffer.byteLength(canonicalJson(input), "utf8");
  const base = bytes(sized(""));
  const room = COMPOSE_LIMITS.maxRequestBytes - base;
  const multibyte = "é".repeat(Math.floor(room / 2)) + "a".repeat(room % 2);
  const atLimit = sized(multibyte);
  assert.equal(bytes(atLimit), COMPOSE_LIMITS.maxRequestBytes);
  assert.ok(canonicalJson(atLimit).length < COMPOSE_LIMITS.maxRequestBytes, "the boundary is in bytes, not characters");

  const under = spies();
  ok(await runComposition(sized(multibyte.slice(1)), under.ctx()));
  const exact = spies();
  ok(await runComposition(atLimit, exact.ctx()));
  assert.deepEqual(exact.calls, ["outline"]);

  const over = spies();
  const result = fault(await runComposition(sized(`${multibyte}a`), over.ctx()));
  assert.deepEqual(over.calls, []);
  assert.equal(result.kind, "composition-request-too-large");
  if (result.kind !== "composition-request-too-large") return;
  assert.equal(result.bytes, COMPOSE_LIMITS.maxRequestBytes + 1);
  assert.equal(result.limit, COMPOSE_LIMITS.maxRequestBytes);
  assert.ok(!result.detail.includes("é"), "no echo of arguments");
});

test("conflicting source expectations fail before any dispatch with an opaque query key", async () => {
  const { calls, ctx } = spies();
  const result = fault(await runComposition({ queries: [Q.outline, { ...Q.entrypoints, expect: `mcp-r1:${"a".repeat(64)}` }, { ...Q.entrypoints, expect: `mcp-r1:${"b".repeat(64)}` }] }, ctx()));
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { kind: "composition-conflicting-expectations", detail: result.detail, queryKey: "q1:0", requestIndices: [1, 2] });
});

test("an undeclared repository fails before any dispatch", async () => {
  const { calls, ctx } = spies();
  // The undeclared query sorts after a valid one, so only a preflight keeps the valid one from being dispatched.
  const result = fault(await runComposition({ queries: [Q.importers, { ...Q.outline, arguments: { ...Q.outline.arguments, repo: "ghost" } }] }, ctx()));
  assert.deepEqual(calls, []);
  assert.equal(result.kind, "composition-source-fault");
  if (result.kind !== "composition-source-fault") return;
  assert.equal(result.family, "outline");
  assert.equal(result.queryKey, "q1:1");
  assert.equal(result.cause.kind, "unknown-repository");
  assert.deepEqual(result.requestIndices, [1]);
});

test("duplicate queries execute once and keep their assertion", async () => {
  const first = ok(await runComposition({ queries: [Q.entrypoints] }, spies().ctx()));
  const pinned = first.requests[0];
  assert.ok(pinned?.status === "available" && pinned.query.name === "ye_ast_entrypoints" && pinned.query.expect !== undefined);
  const expect = pinned.query.expect;

  const repeated = spies();
  const again = ok(await runComposition({ queries: [Q.entrypoints, { ...Q.entrypoints, expect }, Q.entrypoints] }, repeated.ctx()));
  assert.deepEqual(repeated.calls, ["map"]);
  assert.deepEqual(again, first);

  const changed = fault(await runComposition({ queries: [Q.entrypoints, { ...Q.entrypoints, expect: `mcp-r1:${"f".repeat(64)}` }] }, spies().ctx()));
  assert.equal(changed.kind, "composition-source-fault");
  if (changed.kind !== "composition-source-fault") return;
  assert.deepEqual(changed.cause, { kind: "result-changed", detail: changed.cause.detail, stage: "source-identity", expected: `mcp-r1:${"f".repeat(64)}`, actual: expect });
  assert.deepEqual(changed.requestIndices, [0, 1]);
});

test("input order changes neither dispatch order nor the result", async () => {
  const forward = spies();
  const a = ok(await runComposition({ queries: ALL, mode: "details" }, forward.ctx()));
  const backward = spies();
  const b = ok(await runComposition({ queries: [...ALL].reverse() }, backward.ctx()));
  assert.deepEqual(forward.calls, backward.calls);
  assert.deepEqual(canonicalJson(a), canonicalJson(b));
  assert.deepEqual(a, b);
});

test("every invocation re-executes the ports; no state survives a call", async () => {
  const { calls, ctx } = spies();
  const first = ok(await runComposition({ queries: [Q.outline, Q.decisions] }, ctx()));
  const second = ok(await runComposition({ queries: [Q.outline, Q.decisions] }, ctx()));
  assert.deepEqual(calls, ["decisions", "outline", "decisions", "outline"]);
  assert.deepEqual(first, second);
});

test("sources, requests and verification: pinned for the recoverable three, fresh for the other four", async () => {
  const result = ok(await runComposition({ queries: ALL }, spies().ctx()));
  const ids = result.graph.sources.map((source) => source.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(result.requests.length, result.graph.sources.length);
  result.graph.sources.forEach((source, index) => assert.equal(source.requestIndex, index));
  for (const source of result.graph.sources) {
    const request = result.requests[source.requestIndex];
    assert.ok(request?.status === "available", source.family);
    assert.equal(request.query.name, `ye_ast_${source.family}`);
    assert.equal(COMPOSE_QUERY.safeParse(request.query).success, true);
    if (source.family === "entrypoints" || source.family === "impact" || source.family === "callers") {
      assert.equal(request.strategy, "pinned-replay");
      assert.match(request.query.expect ?? "", /^mcp-r1:[0-9a-f]{64}$/);
    } else {
      assert.equal(request.strategy, "fresh-read");
      assert.equal(request.query.expect, undefined);
      assert.deepEqual(request.query.arguments, Q[source.family].arguments);
    }
  }
  assert.deepEqual(result.verification, { status: "available", identity: compositionIdentity(digest, ids) });
  assert.equal(result.counts.sources, 7);
  assert.equal(result.counts.unknownFindings, 2, "one unknown entrypoint finding and one unknown basePath");
  assert.equal(result.counts.unknownComponents, 1);
  assert.equal(result.counts.parts, result.graph.parts.length);
  assert.equal(result.coverage.reads.complete + result.coverage.reads.partial + result.coverage.reads.unknown, result.graph.reads.length);
  assert.ok(result.coverage.limits.some((limit) => limit.kind === "no-extractor" && limit.cuts === 1));
  assert.ok(result.coverage.unknowns.some((unknown) => unknown.reason === "index-unavailable" && unknown.owner.kind === "section"));
  for (const unknown of result.coverage.unknowns) assert.equal("readKind" in unknown.owner, false);
  assert.deepEqual(result.delivery?.map((entry) => entry.source), [...new Set(result.delivery?.map((entry) => entry.source))].sort());

  // The receipt is enough to repeat and verify the whole composition statelessly.
  const queries = result.requests.flatMap((request) => request.status === "available" ? [request.query] : []);
  if (result.verification.status !== "available") return;
  ok(await runComposition({ queries, expect: result.verification.identity }, spies().ctx()));
});

test("a changed external decision changes the identity and fails the composition expectation", async () => {
  const first = ok(await runComposition({ queries: [Q.decisions] }, spies().ctx()));
  assert.equal(first.verification.status, "available");
  if (first.verification.status !== "available") return;
  const altered = decisionsValue();
  const changed = { ...altered, decisions: altered.decisions.map((decision) => decision.kind === "membership" ? { ...decision, options: decision.options.map((option) => ({ ...option, recommended: !option.recommended })) } : decision) };
  const second = spies({ decisions: async () => ({ ok: true, value: { fact: factOf(changed) } }) });
  const result = fault(await runComposition({ queries: [Q.decisions], expect: first.verification.identity }, second.ctx()));
  assert.equal(result.kind, "result-changed");
  if (result.kind !== "result-changed") return;
  assert.equal(result.stage, "composition");
  assert.equal(result.expected, first.verification.identity);
  assert.ok(result.actual !== undefined && result.actual !== result.expected);
});

test("unknown facts are delivered with their reason, never as empty values", async () => {
  const { ctx } = spies({ outline: async () => ({ ok: true, value: unknownFactOf<OutlineValue>("index-unavailable") }) });
  const result = ok(await runComposition({ queries: [Q.outline] }, ctx()));
  assert.deepEqual(result.coverage.reads, { complete: 0, partial: 0, unknown: 1 });
  assert.deepEqual(result.coverage.unknowns.map((u) => [u.owner, u.reason]), [[{ kind: "fact" }, "index-unavailable"]]);
  assert.equal(result.graph.parts.some((part) => part.kind === "outline-file"), false);
});

test("a source fault fails the whole batch and stops dispatch", async () => {
  const { calls, ctx } = spies({ outline: async () => { throw new Error("boom secret-alpha"); } });
  const result = fault(await runComposition({ queries: [Q.workspace, Q.outline, Q.decisions, Q.entrypoints] }, ctx()));
  assert.deepEqual(calls, ["decisions", "map", "outline"], "workspace sorts after outline and is never dispatched");
  assert.equal(result.kind, "composition-source-fault");
  if (result.kind !== "composition-source-fault") return;
  assert.equal(result.family, "outline");
  assert.equal(result.cause.kind, "internal-fault");
  assert.equal(result.queryKey, "q1:2");
  assert.deepEqual(result.requestIndices, [1]);
  assert.ok(!JSON.stringify(result).includes("secret-alpha"));
  assert.equal("graph" in result, false);
});

test("cancellation during a blocked query aborts the batch, skips later queries and releases the listener", async () => {
  const parent = new AbortController();
  const listeners = { added: 0, removed: 0 };
  const add = parent.signal.addEventListener.bind(parent.signal);
  const remove = parent.signal.removeEventListener.bind(parent.signal);
  parent.signal.addEventListener = ((...args: Parameters<typeof add>) => { listeners.added++; add(...args); }) as typeof add;
  parent.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { listeners.removed++; remove(...args); }) as typeof remove;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => (reached = resolve));
  const { calls, ctx } = spies({ outline: (signal) => { reached(); return new Promise(() => void signal); } });
  const running = runComposition({ queries: [Q.outline, Q.workspace] }, ctx(parent.signal));
  await blocked;
  parent.abort();
  const result = fault(await running);
  assert.equal(result.kind, "aborted");
  assert.deepEqual(calls, ["outline"]);
  assert.ok(listeners.added >= 1);
  assert.equal(listeners.removed, listeners.added);

  const pre = new AbortController();
  pre.abort();
  const early = spies();
  assert.equal(fault(await runComposition({ queries: [Q.outline] }, early.ctx(pre.signal))).kind, "aborted");
  assert.deepEqual(early.calls, []);
});

test("the batch deadline aborts a blocked query, and its timer is always cleared", async (t) => {
  const setTimer = t.mock.method(globalThis, "setTimeout");
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  let seen: AbortSignal | undefined;
  const { calls, ctx } = spies({ outline: (signal) => { seen = signal; return new Promise(() => undefined); } });
  const result = fault(await runComposition({ queries: [Q.outline, Q.workspace], deadlineMs: 10 }, ctx()));
  assert.equal(result.kind, "deadline");
  assert.deepEqual(calls, ["outline"]);
  assert.equal(seen?.aborted, true, "the port's signal is linked to the deadline");
  const handles = setTimer.mock.calls.filter((call) => call.arguments[1] === 10).map((call) => call.result);
  assert.equal(handles.length, 1);
  assert.ok(clearTimer.mock.calls.some((call) => call.arguments[0] === handles[0]));

  const success = spies();
  ok(await runComposition({ queries: [Q.outline], deadlineMs: COMPOSE_LIMITS.maxDeadlineMs }, success.ctx()));
  const long = setTimer.mock.calls.filter((call) => call.arguments[1] === COMPOSE_LIMITS.maxDeadlineMs).map((call) => call.result);
  assert.equal(long.length, 1);
  assert.ok(clearTimer.mock.calls.some((call) => call.arguments[0] === long[0]));
});

test("time spent synchronously past the deadline prevents delivery", async () => {
  const { ctx } = spies({ outline: async () => { const until = performance.now() + 40; while (performance.now() < until); return { ok: true, value: factOf(outlineValue()) }; } });
  assert.equal(fault(await runComposition({ queries: [Q.outline], deadlineMs: 5 }, ctx())).kind, "deadline");
});

test("a deadline cut inside a source is delivered unasserted; a composition expectation then fails", async () => {
  const cut = () => spies({ outline: async () => ({ ok: true, value: factOf(outlineValue(), { cuts: [{ kind: "deadline", at: ["src/OrderController.java"] }] }) }) });
  const result = ok(await runComposition({ queries: [Q.outline] }, cut().ctx()));
  assert.deepEqual(result.verification, { status: "unavailable", reason: "deadline" });
  assert.deepEqual(result.coverage.limits.map((limit) => limit.kind), ["deadline"]);
  const expected = fault(await runComposition({ queries: [Q.outline], expect: `mcp-c1:${"a".repeat(64)}` }, cut().ctx()));
  assert.deepEqual(expected, { kind: "replay-unavailable", detail: expected.detail, stage: "composition", reason: "deadline" });
});

test("queries that collide after redaction stay separate sources, unverifiable, without leaking secrets", async () => {
  const query = (secret: string) => ({ name: "ye_ast_outline" as const, arguments: { repo: "shop", revision: SHA_A, files: [`src/${secret}.java`] } });
  const result = ok(await runComposition({ queries: [query("secret-alpha"), query("secret-beta")] }, spies().ctx()));
  assert.equal(result.graph.sources.length, 2);
  assert.deepEqual(result.verification, { status: "unavailable", reason: "redacted-context" });
  assert.deepEqual(result.requests, [{ status: "unavailable", reason: "redacted-context" }, { status: "unavailable", reason: "redacted-context" }]);
  const wire = JSON.stringify(result);
  for (const secret of ["secret-alpha", "secret-beta"]) {
    assert.ok(!wire.includes(secret));
    for (const text of [secret, `src/${secret}.java`, canonicalJson(query(secret))]) assert.ok(!wire.includes(digest.of(text)));
  }
  const expected = fault(await runComposition({ queries: [query("secret-alpha")], expect: `mcp-c1:${"a".repeat(64)}` }, spies().ctx()));
  assert.equal(expected.kind, "replay-unavailable");
});

test("the same source reached by two distinct queries is delivered once with its smallest recipe", async () => {
  // HEAD and the pinned SHA resolve to the same public fact and context: one SourceId.
  const result = ok(await runComposition({ queries: [Q.outline, { ...Q.outline, arguments: { repo: "shop", files: ["src/OrderController.java"] } }] }, spies().ctx()));
  assert.equal(result.graph.sources.length, 1);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0];
  assert.ok(request?.status === "available");
  // Smallest canonical JSON of the public recipe, independent of input order: "," sorts before "}".
  assert.deepEqual(request.query.arguments, Q.outline.arguments);
  const reversed = ok(await runComposition({ queries: [{ ...Q.outline, arguments: { repo: "shop", files: ["src/OrderController.java"] } }, Q.outline] }, spies().ctx()));
  assert.deepEqual(reversed, result);
});
