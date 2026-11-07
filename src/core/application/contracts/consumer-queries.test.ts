import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessPath } from "../../domain/contracts/access-path.ts";
import { carrierKey, NO_FLOW, type Carrier, type FlowResult, type FlowUse } from "../../domain/contracts/consumer-flow.ts";
import { derivedChange } from "../../domain/contracts/change.ts";
import { formatHypothesis, parseHypothesis, type HypothesisInput } from "../../domain/contracts/hypothesis.ts";
import type { ValueSet } from "../../domain/contracts/payload-shape.ts";
import type { Predicate } from "../../domain/contracts/use-operation.ts";
import type { TestedGuard, UseOperation } from "../../domain/contracts/verdict.ts";
import type { FactBase } from "../../domain/shared/fact.ts";
import type { Link } from "../../domain/topology/link.ts";
import type { ConsequencesRequest, ConsumerQueries } from "../../ports/consumer-queries.port.ts";
import type { ConsumerCaller, ConsumerCallers, ConsumerMemberOccurrences, ConsumerSession, PreparedWorkspace, ServingWorkspace } from "../../ports/consumer-sources.port.ts";
import type { Origin } from "../../domain/contracts/request-origin.ts";
import type { ArgumentOrigins, RequestOriginReader } from "../../ports/request-origins.port.ts";
import { consequencesOn, createConsumerQueries } from "./consumer-queries.ts";

const path = (text: string) => parseAccessPath(text)!;
const OPERATION = "GET /owners/{id}";

const BASE: FactBase = {
  schema: "0.21.0",
  snapshot: { repo: "web", kind: "sha", sha: "a".repeat(40) },
  producer: { name: "ye-ast", version: "0.0.0" },
  inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
  evidence: [],
};

function link(overrides: { file?: string; line?: number; basis?: Link["basis"]; name?: string; repo?: string } = {}): Link {
  const { file = "src/owner.service.ts", line = 10, basis = "exact", name = OPERATION, repo = "web" } = overrides;
  const from = { repo, file, line, symbol: "find" };
  return { id: `${repo}:${file}:${line}:${name}:${basis}`, from, to: { repo: "api", kind: "http-route", name, handler: { path: "Owners.java", symbol: "get", line: 5 } }, transport: "http", basis, confidence: 1 };
}

const siteOf = (file = "src/owner.service.ts", line = 10) => ({ kind: "call-site" as const, repo: "web", file, line, symbol: "find" });
const returnOf = (symbol = "find", line = 8, file = "src/owner.service.ts") => ({ kind: "return" as const, repo: "web", file, symbol, line });

const NOT_NULL: Predicate = { kind: "absence", operator: "!==", absence: "null" };
const NOT_UNDEFINED: Predicate = { kind: "absence", operator: "!==", absence: "undefined" };

function guard(overrides: Partial<TestedGuard> = {}): TestedGuard {
  return { kind: "optional-chain", covers: path("address"), test: { kind: "absence", operator: "!=", absence: "null" }, holds: true, evidence: { path: "src/page.ts", line: 31 }, ...overrides };
}

const READ: UseOperation = { steps: [{ kind: "member", name: "city", optional: false }], end: { kind: "none" } };
const SHOWN: UseOperation = { steps: [], end: { kind: "consume", as: "shown" } };
const UNMODELLED: UseOperation = { steps: [], end: { kind: "unmodelled", detail: "expression" } };

function use(line: number, overrides: Partial<FlowUse> = {}): FlowUse {
  return { site: { path: "src/page.ts", line }, path: path("address.city"), changed: path("address"), operation: SHOWN, guards: [], hops: [{ step: "subscribe", evidence: { path: "src/page.ts", line } }], ...overrides };
}

interface Setup {
  links?: readonly Link[];
  flow?: Record<string, FlowResult>;
  templates?: Record<string, FlowResult>;
  callers?: Record<string, ConsumerCallers>;
  members?: Record<string, ConsumerMemberOccurrences>;
  serving?: ConsumerSession["serving"];
  unresolvedCalls?: ConsumerSession["unresolvedCalls"];
  ambiguousCalls?: ConsumerSession["ambiguousCalls"];
  property?: string;
  change?: HypothesisInput["change"];
  target?: HypothesisInput["target"];
  method?: string;
  path?: string;
  origins?: Record<string, RequestOriginReader>;
}

function setup(options: Setup = {}) {
  const followed: Carrier[] = [];
  const templated: Carrier[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  let preparations = 0;
  const session: ConsumerSession = {
    base: BASE,
    links: options.links ?? [link()],
    serving: options.serving ?? [{ repo: "api", handler: { path: "Owners.java", symbol: "get", line: 5 } }],
    unresolvedCalls: options.unresolvedCalls ?? [],
    ambiguousCalls: options.ambiguousCalls ?? [],
    cuts: [],
    callers: (declaration) => (asked.push(declaration.symbol), options.callers?.[declaration.symbol] ?? { kind: "found", callers: [] }),
    memberOccurrences: ({ member }) => options.members?.[member] ?? { kind: "found", occurrences: [] },
    flow: { follow: (carrier) => (followed.push(carrier), options.flow?.[carrierKey(carrier.site)] ?? NO_FLOW) },
    templates: { follow: (carrier) => (templated.push(carrier), options.templates?.[carrierKey(carrier.site)] ?? NO_FLOW) },
    requestOrigins: (repo) => options.origins?.[repo],
  };
  const workspace: ServingWorkspace = {
    session: async (hypothesis) => {
      opened.push(hypothesis.property.join("."));
      return { ok: true, value: session };
    },
    serving: () => ({ kind: "unserved" }),
  };
  const queries: ConsumerQueries = createConsumerQueries({
    sources: {
      withWorkspace: async (_, run) => ({
        ok: (preparations++, true),
        value: await run(workspace),
      }),
    },
  });
  const request: ConsequencesRequest = { repo: { repo: "web", path: "/work/web" } as ConsequencesRequest["repo"], hypothesis: { method: options.method ?? "get", path: options.path ?? "/owners/{id}", target: options.target ?? "response", property: options.property ?? "address", change: options.change ?? "nullable" } };
  const ask = async () => {
    const answer = await queries.consequences(request);
    assert.ok(answer.ok);
    assert.notEqual(answer.value.status, "unknown");
    return answer.value as Exclude<typeof answer.value, { status: "unknown" }>;
  };
  return { ask, followed, templated, opened, asked, queries, request, session, preparations: () => preparations };
}

const verdictsOf = (fact: Awaited<ReturnType<ReturnType<typeof setup>["ask"]>>) => fact.value.findings.map((finding) => (finding.status === "complete" ? finding.value.verdict.kind : finding.evidence.at(-1)?.via));

test("hypotheses asked together share one prepared workspace and are answered in the order asked, an invalid one with its own fault", async () => {
  const { queries, request, opened, preparations } = setup();
  const { hypothesis, ...workspace } = request;
  const answers = await queries.consequencesOfEach({ ...workspace, hypotheses: [{ ...hypothesis, property: "phone" }, { ...hypothesis, change: "bogus" as HypothesisInput["change"] }, hypothesis] });

  assert.ok(answers.ok);
  assert.deepEqual(answers.value.map((answer) => (!answer.ok ? answer.fault.kind : answer.value.status === "unknown" ? "unknown" : answer.value.value.hypothesis.property)), ["phone", "invalid-hypothesis", "address"]);
  assert.deepEqual(opened, ["phone", "address"]);
  assert.equal(preparations(), 1);
});

test("hypotheses that are all invalid are answered without preparing the workspace", async () => {
  const { queries, request, preparations } = setup();
  const { hypothesis, ...workspace } = request;
  const answers = await queries.consequencesOfEach({ ...workspace, hypotheses: [{ ...hypothesis, change: "bogus" as HypothesisInput["change"] }] });

  assert.ok(answers.ok);
  assert.deepEqual(answers.value.map((answer) => !answer.ok && answer.fault.kind), ["invalid-hypothesis"]);
  assert.equal(preparations(), 0);
});

test("each use gets its verdict, with the chain from the call site that proves it", async () => {
  const flow = { [carrierKey(siteOf())]: { uses: [use(30, { operation: READ }), use(40, { operation: READ, guards: [guard()] }), use(50, { operation: UNMODELLED, path: path("address") })], next: [], frontiers: [] } };
  const fact = await setup({ flow }).ask();

  assert.deepEqual(verdictsOf(fact), ["incompatible", "admits", "review"]);
  const first = fact.value.findings[0];
  assert.ok(first?.status === "complete");
  assert.deepEqual(first.value.chain.map((hop) => [hop.step, hop.evidence.path, hop.evidence.line]), [["http-call", "src/owner.service.ts", 10], ["subscribe", "src/page.ts", 30]]);
  assert.equal(first.evidence[0]?.line, 30);
  assert.equal(fact.status, "complete");
});

test("the answer echoes the normalized hypothesis and the old guarantee it assumed", async () => {
  const fact = await setup({ property: "[].address" }).ask();

  assert.deepEqual(fact.value.hypothesis, { method: "GET", path: "/owners/{id}", target: "response", property: "[].address", change: "nullable" });
  assert.equal(fact.value.assumedOldGuarantee, "present-and-non-null");
  assert.deepEqual(fact.value.findings, []);
});

test("several hypotheses are answered on one prepared workspace, each from the session it asks for", async () => {
  const { session } = setup();
  const asked: string[] = [];
  const workspace: PreparedWorkspace = { session: async (hypothesis) => (asked.push(formatHypothesis(hypothesis)), { ok: true, value: session }) };
  const hypotheses = [{ property: "address", change: "nullable" }, { property: "name", change: "optional" }].map((written) => {
    const parsed = parseHypothesis({ method: "GET", path: "/owners/{id}", target: "response", ...written });
    assert.ok(parsed.ok);
    return parsed.value;
  });

  const answers = [];
  for (const hypothesis of hypotheses) answers.push(await consequencesOn(workspace, hypothesis));

  assert.deepEqual(asked, ["GET /owners/{id} response address nullable", "GET /owners/{id} response name optional"]);
  assert.deepEqual(answers.map((answer) => answer.ok && answer.value.status !== "unknown" && [answer.value.value.hypothesis.property, answer.value.value.hypothesis.change]), [["address", "nullable"], ["name", "optional"]]);
});

test("a hypothesis derived from a diff states the old guarantee it was derived from instead of the assumed one", async () => {
  const oldGuarantee: ValueSet = { literals: { boolean: [], number: [], string: "every" }, array: false, object: false, null: false, absent: false };
  const change = derivedChange({ introduced: ["null"], added: [], retired: [], alwaysAbsent: false, oldGuarantee });
  assert.ok(change.ok);
  const { session } = setup();

  const answer = await consequencesOn({ session: async () => ({ ok: true, value: session }) }, { method: "GET", path: "/owners/{id}", target: "response", property: path("address"), change: change.value });

  assert.ok(answer.ok && answer.value.status !== "unknown");
  assert.deepEqual(answer.value.value.assumedOldGuarantee, oldGuarantee);
});

test("an optional property is admitted behind a test that excludes undefined, not behind one that excludes only null, with undefined as the witness", async () => {
  const undefinedTest = guard({ kind: "condition", test: NOT_UNDEFINED });
  const nullTest = guard({ kind: "condition", test: NOT_NULL, evidence: { path: "src/page.ts", line: 39 } });
  const flow = { [carrierKey(siteOf())]: { uses: [use(30, { operation: READ, guards: [undefinedTest] }), use(40, { operation: READ, guards: [nullTest] })], next: [], frontiers: [] } };

  const fact = await setup({ flow, change: "optional" }).ask();

  assert.deepEqual(fact.value.findings.map((finding) => finding.status === "complete" && finding.value.verdict), [
    { kind: "admits", guards: [undefinedTest] },
    { kind: "incompatible", witness: "undefined", at: 0, failing: READ.steps[0], capability: "readable" },
  ]);
});

test("a renamed property is decided as one that is always absent, and the answer states its new path once", async () => {
  const flow = { [carrierKey(siteOf())]: { uses: [use(30, { operation: READ, guards: [guard()] })], next: [], frontiers: [] } };

  const fact = await setup({ flow, property: "owner.address", change: { renamed: "location" } }).ask();

  assert.deepEqual(fact.value.hypothesis, { method: "GET", path: "/owners/{id}", target: "response", property: "owner.address", change: { renamed: "location" }, renamedTo: "owner.location" });
  assert.deepEqual(verdictsOf(fact), ["review"]);
  assert.equal(JSON.stringify(fact.value).split("owner.location").length - 1, 1);
});

test("under a values change the uses left silent are counted, and any other change states no count", async () => {
  const compared: UseOperation = { steps: [], end: { kind: "compare", operator: "===", literal: "B" } };
  const flow = { [carrierKey(siteOf())]: { uses: [use(30, { path: path("address") }), use(40, { path: path("address"), operation: compared }), use(50, { operation: READ })], next: [], frontiers: [] } };

  const fact = await setup({ flow, change: { values: { added: ["A"] } } }).ask();

  assert.equal(fact.value.silent, 2);
  assert.deepEqual(verdictsOf(fact), ["review"]);
  assert.deepEqual(fact.value.hypothesis.change, { values: { added: ["A"], removed: [] } });
  assert.equal((await setup({ flow, change: { values: { removed: ["A"] } } }).ask()).value.silent, 2);
  assert.equal((await setup({ change: { values: { added: ["A"] } } }).ask()).value.silent, 0);
  assert.equal("silent" in (await setup({ flow }).ask()).value, false);
});

test("a meaning note reaches the answer as written and makes every use a review", async () => {
  const flow = { [carrierKey(siteOf())]: { uses: [use(30, { path: path("address") })], next: [], frontiers: [] } };

  const fact = await setup({ flow, change: [{ meaning: "euros become cents" }] }).ask();

  assert.deepEqual(fact.value.hypothesis.change, { meaning: "euros become cents" });
  assert.deepEqual(fact.value.findings.map((finding) => finding.status === "complete" && finding.value.verdict), [{ kind: "review", reason: "meaning" }]);
  assert.equal("silent" in fact.value, false);
});

test("a wrapped array is echoed with the path its elements move to, once", async () => {
  const fact = await setup({ property: "owner.items", change: { wrapped: "content" } }).ask();

  assert.deepEqual(fact.value.hypothesis, { method: "GET", path: "/owners/{id}", target: "response", property: "owner.items", change: { wrapped: "content" }, elementsAt: "owner.items.content[]" });
});

test("an admitted use names in its evidence every guard that kept an introduced value from it", async () => {
  const nullTest = guard({ kind: "condition", test: NOT_NULL, evidence: { path: "src/page.ts", line: 28 } });
  const undefinedTest = guard({ kind: "condition", test: NOT_UNDEFINED, evidence: { path: "src/page.ts", line: 29 } });
  const flow = { [carrierKey(siteOf())]: { uses: [use(30, { operation: READ, guards: [undefinedTest, nullTest] })], next: [], frontiers: [] } };

  const fact = await setup({ flow, change: ["nullable", "optional"] }).ask();

  const [admitted] = fact.value.findings;
  assert.ok(admitted?.status === "complete");
  assert.deepEqual(admitted.value.verdict, { kind: "admits", guards: [nullTest, undefinedTest] });
  assert.deepEqual(admitted.evidence.map((place) => place.line), [30, 28, 29]);
});

test("an invalid hypothesis is refused before any snapshot is read", async () => {
  const { queries, request, opened } = setup();

  const answer = await queries.consequences({ ...request, hypothesis: { ...request.hypothesis, change: "renamed" } });

  assert.ok(!answer.ok);
  assert.equal(answer.fault.kind, "invalid-hypothesis");
  assert.deepEqual(opened, []);
});

test("only the call sites of the asked operation are followed: a shared type connects nothing", async () => {
  const other = link({ file: "src/pet.service.ts", line: 3, name: "GET /pets/{id}" });
  const { ask, followed } = setup({ links: [link(), other] });

  await ask();

  assert.deepEqual(followed.map((carrier) => carrier.site.kind === "call-site" && carrier.site.file), ["src/owner.service.ts"]);
});

test("a link that is not qualified is not followed: it is an unknown item that names its basis", async () => {
  const { ask, followed } = setup({ links: [link({ basis: "suffix" })] });

  const fact = await ask();

  assert.deepEqual(followed, []);
  assert.deepEqual(verdictsOf(fact), ["link-basis:suffix"]);
  assert.equal(fact.status, "complete");
});

test("every qualified basis is followed", async () => {
  const links = (["exact", "base-path", "operation-id"] as const).map((basis, index) => link({ basis, line: 10 + index }));
  const { ask, followed } = setup({ links });

  await ask();

  assert.equal(followed.length, 3);
});

const returning = (symbol = "find") => ({ [carrierKey(siteOf())]: { uses: [], next: [{ carrier: { site: returnOf(symbol), path: path("address") }, hops: [{ step: "return" as const, evidence: { path: "src/owner.service.ts", line: 12 } }] }], frontiers: [] } });
const caller = (overrides: Partial<ConsumerCaller> = {}): ConsumerCaller => ({ file: "src/page.ts", line: 20, at: 25, kind: "call", provenance: "resolved", confidence: 1, proven: true, ...overrides });

test("a function return continues at each proven call occurrence of its callers, and the call is a hop of the chain", async () => {
  const flow = {
    ...returning(),
    [carrierKey({ kind: "call-result", repo: "web", file: "src/page.ts", line: 25, callee: "find" })]: { uses: [use(26, { operation: READ })], next: [], frontiers: [] },
    [carrierKey({ kind: "call-result", repo: "web", file: "src/page.ts", line: 27, callee: "find" })]: { uses: [use(28, { operation: READ })], next: [], frontiers: [] },
  };
  const callers = { find: { kind: "found" as const, callers: [caller({ at: 25 }), caller({ at: 27 })] } };

  const fact = await setup({ flow, callers }).ask();

  assert.deepEqual(fact.value.findings.map((finding) => finding.status === "complete" && finding.value.chain.map((hop) => [hop.step, hop.evidence.line])), [
    [["http-call", 10], ["return", 12], ["caller", 25], ["subscribe", 26]],
    [["http-call", 10], ["return", 12], ["caller", 27], ["subscribe", 28]],
  ]);
});

test("a caller that is not a proven call, has no position, or sits in a template is a frontier, not a continuation", async () => {
  const callers = { find: { kind: "found" as const, callers: [caller({ file: "src/a.ts", line: 1, at: 4, provenance: "heuristic", proven: false }), { file: "src/b.ts", line: 1, kind: "call" as const, provenance: "resolved" as const, confidence: 1, proven: true }, caller({ file: "src/c.ts", line: 1, at: 6, resource: "src/c.html" })] } };
  const { ask, followed } = setup({ flow: returning(), callers });

  const fact = await ask();

  assert.deepEqual(verdictsOf(fact), ["ambiguous-caller", "unresolved-caller", "unmodelled-flow:template-caller"]);
  assert.deepEqual(fact.value.findings.map((finding) => finding.evidence.at(-1)?.path), ["src/a.ts", "src/b.ts", "src/c.html"]);
  assert.deepEqual(followed.map((carrier) => carrier.site.kind), ["call-site", "return"]);
});

test("a function nothing calls, or one in a repository without a graph, is a frontier: an empty answer is never safe", async () => {
  assert.deepEqual(verdictsOf(await setup({ flow: returning() }).ask()), ["no-caller"]);
  assert.deepEqual(verdictsOf(await setup({ flow: returning(), callers: { find: { kind: "unavailable" } } }).ask()), ["graph-unavailable"]);
});

test("a return whose function the graph does not know is an unresolved caller", async () => {
  assert.deepEqual(verdictsOf(await setup({ flow: returning("ghost"), callers: { ghost: { kind: "unresolved" } } }).ask()), ["unresolved-caller"]);
});

test("an operation served but with no call site linked is one unknown item at its handler, never an empty answer", async () => {
  const fact = await setup({ links: [] }).ask();

  assert.deepEqual(verdictsOf(fact), ["no-call-site"]);
  assert.deepEqual(fact.value.findings[0]?.evidence.map(({ path, line }) => [path, line]), [["Owners.java", 5]]);
});

test("an operation no repository serves is a typed fault", async () => {
  const answer = await setup({ serving: [] }).queries.consequences(setup().request);

  assert.ok(!answer.ok);
  assert.equal(answer.fault.kind, "unknown-operation");
});

test("a flow that loops back to a boundary already followed terminates, following it once", async () => {
  const a = { kind: "member" as const, repo: "web", file: "src/a.ts", owner: "A", member: "owner", line: 3 };
  const b = { kind: "member" as const, repo: "web", file: "src/b.ts", owner: "B", member: "owner", line: 4 };
  const flow = {
    [carrierKey(siteOf())]: { uses: [], next: [{ carrier: { site: a, path: path("address") }, hops: [] }], frontiers: [] },
    [carrierKey(a)]: { uses: [], next: [{ carrier: { site: b, path: path("address") }, hops: [] }], frontiers: [] },
    [carrierKey(b)]: { uses: [], next: [{ carrier: { site: a, path: path("address") }, hops: [] }], frontiers: [] },
  };
  const { ask, followed } = setup({ flow });

  const fact = await ask();

  assert.equal(followed.length, 3);
  assert.deepEqual(fact.value.findings, []);
});

test("a member is one boundary whether it arrives with its line or from a template that does not know it", async () => {
  const declared = { kind: "member" as const, repo: "web", file: "src/card.ts", owner: "Card", member: "owner", line: 6 };
  const { line: _, ...bound } = declared;
  const flow = {
    [carrierKey(siteOf())]: { uses: [], next: [{ carrier: { site: declared, path: path("address") }, hops: [] }, { carrier: { site: bound, path: path("address") }, hops: [] }], frontiers: [] },
  };
  const { ask, followed } = setup({ flow });

  const fact = await ask();

  assert.equal(followed.length, 2);
  assert.deepEqual(fact.value.findings, []);
});

test("a boundary reached again with the changed property elsewhere is a frontier, not a second walk", async () => {
  const a = { kind: "member" as const, repo: "web", file: "src/a.ts", owner: "A", member: "owner", line: 3 };
  const flow = {
    [carrierKey(siteOf())]: { uses: [], next: [{ carrier: { site: a, path: path("address") }, hops: [] }, { carrier: { site: a, path: path("body.address") }, hops: [] }], frontiers: [] },
  };
  const { ask, followed } = setup({ flow });

  const fact = await ask();

  assert.deepEqual(verdictsOf(fact), ["path-conflict"]);
  assert.equal(followed.length, 2);
});

test("a class member is read by the code and by its template, and a child input continues as a member", async () => {
  const parent = { kind: "member" as const, repo: "web", file: "src/page.ts", owner: "Page", member: "owner", line: 12 };
  const child = { kind: "member" as const, repo: "web", file: "src/card.ts", owner: "Card", member: "owner", line: 6 };
  const flow = {
    [carrierKey(siteOf())]: { uses: [], next: [{ carrier: { site: parent, path: path("address") }, hops: [] }], frontiers: [] },
    [carrierKey(parent)]: { uses: [use(14, { operation: READ })], next: [], frontiers: [] },
  };
  const templates = {
    [carrierKey(parent)]: { uses: [use(3, { site: { path: "src/page.html", line: 3 }, operation: READ, guards: [guard()] })], next: [{ carrier: { site: child, path: path("address") }, hops: [{ step: "template-binding" as const, evidence: { path: "src/page.html", line: 5 } }] }], frontiers: [] },
    [carrierKey(child)]: { uses: [use(2, { site: { path: "src/card.html", line: 2 }, operation: READ })], next: [], frontiers: [] },
  };
  const { ask, templated } = setup({ flow, templates });

  const fact = await ask();

  assert.deepEqual(verdictsOf(fact), ["incompatible", "admits", "incompatible"]);
  assert.deepEqual(templated.map((carrier) => carrier.site.kind === "member" && carrier.site.owner), ["Page", "Card"]);
});

test("the answer is the same whatever order the links arrive in, sorted by the place of each item", async () => {
  const early = link({ file: "src/a.service.ts", line: 2 });
  const late = link({ file: "src/b.service.ts", line: 9 });
  const flow = {
    [carrierKey(siteOf("src/a.service.ts", 2))]: { uses: [use(80, { site: { path: "src/z.ts", line: 80 }, operation: READ })], next: [], frontiers: [] },
    [carrierKey(siteOf("src/b.service.ts", 9))]: { uses: [use(5, { site: { path: "src/m.ts", line: 5 }, operation: READ })], next: [], frontiers: [] },
  };

  const forward = await setup({ links: [early, late], flow }).ask();
  const backward = await setup({ links: [late, early], flow }).ask();

  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.value.findings.map((finding) => finding.evidence[0]?.path), ["src/m.ts", "src/z.ts"]);
});

test("a frontier a reader reports keeps its place, cause and the chain that reached it", async () => {
  const flow = { [carrierKey(siteOf())]: { uses: [], next: [], frontiers: [{ at: { path: "src/owner.service.ts", line: 15 }, cause: "unmodelled-flow" as const, reason: "unresolved" as const, detail: "spread", hops: [{ step: "pipe" as const, evidence: { path: "src/owner.service.ts", line: 11 } }] }] } };

  const fact = await setup({ flow }).ask();

  const item = fact.value.findings[0];
  assert.ok(item?.status === "unknown");
  assert.equal(item.reason, "unresolved");
  assert.deepEqual(item.evidence.map((evidence) => [evidence.line, evidence.via]), [[10, "basis:exact"], [11, undefined], [15, "unmodelled-flow:spread"]]);
});

const UTIL = { file: "src/util.ts", symbol: "valueOrDefault", line: 3 };
const parameterOf = { kind: "parameter" as const, repo: "web", ...UTIL, index: 0 };
const utilReturn = { kind: "return" as const, repo: "web", ...UTIL };
const argumentAt = (file: string, line: number) => ({ step: "argument" as const, evidence: { path: file, line } });
const callResultAt = (file: string, line: number) => carrierKey({ kind: "call-result", repo: "web", file, line, callee: UTIL.symbol });

function throughHelper(entries: readonly (readonly [string, number])[]) {
  return {
    [carrierKey(siteOf())]: { uses: [], next: entries.map(([file, line]) => ({ carrier: { site: parameterOf, path: path("address") }, hops: [argumentAt(file, line)] })), frontiers: [] },
    [carrierKey(parameterOf)]: { uses: [], next: [{ carrier: { site: utilReturn, path: path("address") }, hops: [{ step: "return" as const, evidence: { path: UTIL.file, line: 5 } }] }], frontiers: [] },
  };
}

test("a value that entered a function through an argument leaves it at the result of that call, not at every caller of the function", async () => {
  const flow = { ...throughHelper([["src/a.ts", 12]]), [callResultAt("src/a.ts", 12)]: { uses: [use(13, { site: { path: "src/a.ts", line: 13 }, operation: READ })], next: [], frontiers: [] } };
  const callers = { valueOrDefault: { kind: "found" as const, callers: [caller({ file: "src/a.ts", line: 10, at: 12 }), caller({ file: "src/b.ts", line: 30, at: 40 })] } };
  const { ask, followed, asked } = setup({ flow, callers });

  const fact = await ask();

  assert.deepEqual(followed.filter((carrier) => carrier.site.kind === "call-result").map((carrier) => carrier.site.kind === "call-result" && [carrier.site.file, carrier.site.line]), [["src/a.ts", 12]]);
  assert.deepEqual(asked, []);
  assert.deepEqual(verdictsOf(fact), ["incompatible"]);
});

test("the same function entered from two call sites follows both returns", async () => {
  const flow = {
    ...throughHelper([["src/a.ts", 12], ["src/c.ts", 7]]),
    [callResultAt("src/a.ts", 12)]: { uses: [use(13, { site: { path: "src/a.ts", line: 13 }, operation: READ })], next: [], frontiers: [] },
    [callResultAt("src/c.ts", 7)]: { uses: [use(8, { site: { path: "src/c.ts", line: 8 }, operation: READ })], next: [], frontiers: [] },
  };

  const fact = await setup({ flow }).ask();

  assert.deepEqual(fact.value.findings.map((finding) => finding.evidence[0]?.path), ["src/a.ts", "src/c.ts"]);
});

test("a function that calls itself with the value terminates and leaves a frontier at the recursive call", async () => {
  const flow = {
    ...throughHelper([["src/a.ts", 12]]),
    [carrierKey(parameterOf)]: { uses: [], next: [{ carrier: { site: parameterOf, path: path("address") }, hops: [argumentAt(UTIL.file, 6)] }], frontiers: [] },
  };

  const fact = await setup({ flow }).ask();

  assert.deepEqual(verdictsOf(fact), ["unmodelled-flow:recursion"]);
});

test("a return that was not entered through an argument still continues at the callers of its function", async () => {
  const { ask, asked } = setup({ flow: returning() });

  await ask();

  assert.deepEqual(asked, ["find"]);
});

test("an occurrence the graph only guessed is an ambiguous caller at that occurrence, beside the proven one of the same function", async () => {
  const callers = { find: { kind: "found" as const, callers: [caller({ at: 25 }), caller({ at: 27, provenance: "heuristic", confidence: 0.8, proven: false })] } };
  const flow = { ...returning(), [carrierKey({ kind: "call-result", repo: "web", file: "src/page.ts", line: 25, callee: "find" })]: { uses: [use(26, { operation: READ })], next: [], frontiers: [] } };

  const fact = await setup({ flow, callers }).ask();

  assert.deepEqual(verdictsOf(fact), ["incompatible", "ambiguous-caller"]);
  assert.deepEqual(fact.value.findings.map((finding) => finding.evidence.at(-1)?.line), [26, 27]);
});

const registrationAt = (file: string, line: number) => ({ step: "resolver-input" as const, evidence: { path: file, line } });

test("the registration of a resolver the reader continued is no caller, and a function named anywhere else is an unmodelled flow", async () => {
  const flow = {
    ...returning(),
    [carrierKey(returnOf())]: { uses: [], next: [{ carrier: { site: { kind: "member" as const, repo: "web", file: "src/page.ts", owner: "Page", member: "owner" }, path: path("address") }, hops: [registrationAt("src/routes.ts", 34)] }], frontiers: [] },
  };
  const callers = { find: { kind: "found" as const, callers: [caller({ file: "src/routes.ts", line: 30, at: 34, kind: "reference", proven: false }), caller({ file: "src/other.ts", line: 2, at: 9, kind: "reference", proven: false })] } };

  const fact = await setup({ flow, callers }).ask();

  assert.deepEqual(verdictsOf(fact), ["unmodelled-flow:function-reference"]);
  assert.deepEqual(fact.value.findings.map((finding) => [finding.evidence.at(-1)?.path, finding.evidence.at(-1)?.line]), [["src/other.ts", 9]]);
});

test("a dependence that is neither a call nor a reference stays an ambiguous caller", async () => {
  const callers = { find: { kind: "found" as const, callers: [{ file: "src/page.ts", line: 20, kind: "other" as const, provenance: "resolved" as const, confidence: 1, proven: false }] } };

  assert.deepEqual(verdictsOf(await setup({ flow: returning(), callers }).ask()), ["ambiguous-caller"]);
});

test("two uses in two repositories at the same relative place are two findings, each stating its repository and the link it came through", async () => {
  const links = [link({ repo: "web-a" }), link({ repo: "web-b" })];
  const read = { uses: [use(30, { operation: READ })], next: [], frontiers: [] };
  const { ask } = setup({ links, flow: { [carrierKey({ ...siteOf(), repo: "web-a" })]: read, [carrierKey({ ...siteOf(), repo: "web-b" })]: read } });

  const fact = await ask();

  assert.equal(fact.value.findings.length, 2);
  const [first, second] = fact.value.findings;
  assert.ok(first?.status === "complete" && second?.status === "complete");
  assert.deepEqual([first.value.repo, second.value.repo], ["web-a", "web-b"]);
  assert.deepEqual(first.evidence.map((place) => "repo" in place && place.repo), ["web-a"]);
  assert.deepEqual(first.value.link, { id: links[0]!.id, basis: "exact", call: { file: "src/owner.service.ts", line: 10, symbol: "find" }, handler: { repo: "api", path: "Owners.java", symbol: "get", line: 5 } });
});

test("an unknown item locates its evidence in the repository it was followed in", async () => {
  const flow = { [carrierKey(siteOf())]: { uses: [], next: [], frontiers: [{ at: { path: "src/owner.service.ts", line: 15 }, cause: "unmodelled-flow" as const, reason: "unresolved" as const, hops: [] }] } };

  const item = (await setup({ flow }).ask()).value.findings[0];

  assert.ok(item?.status === "unknown");
  assert.deepEqual(item.evidence.map((place) => "repo" in place && place.repo), ["web", "web"]);
});

test("no call site linked lists the call sites of the workspace whose target could not be evaluated, so the empty linkage is not proof", async () => {
  const unresolvedCalls = [{ repo: "web", file: "src/x.service.ts", line: 4, symbol: "load" }, { repo: "web", file: "src/a.service.ts", line: 9, symbol: "save" }];

  const fact = await setup({ links: [], unresolvedCalls }).ask();

  const [item] = fact.value.findings;
  assert.ok(item?.status === "unknown");
  assert.deepEqual(item.evidence.map((place) => [place.path, place.line, place.via, "repo" in place && place.repo]), [
    ["src/a.service.ts", 9, "unresolved-call-site", "web"],
    ["src/x.service.ts", 4, "unresolved-call-site", "web"],
    ["Owners.java", 5, "no-call-site", "api"],
  ]);
});

test("call sites whose target could not be evaluated are listed even when others link, since any of them may call the operation", async () => {
  const unresolvedCalls = [{ repo: "web", file: "src/x.service.ts", line: 4, symbol: "load" }];

  const fact = await setup({ unresolvedCalls }).ask();

  const listed = fact.value.findings.filter((finding) => finding.status === "unknown" && finding.evidence.some((place) => place.via === "unresolved-call-site"));
  assert.deepEqual(listed.map((finding) => finding.evidence.map((place) => [place.path, place.line, place.via])), [[["src/x.service.ts", 4, "unresolved-call-site"]]]);
});

test("a call site that may reach the operation in more than one repository is a frontier, never a link", async () => {
  const ambiguousCalls = [{ from: { repo: "web", file: "src/owner.service.ts", line: 10, symbol: "find" }, repos: ["api", "web"] }];

  const fact = await setup({ links: [], ambiguousCalls }).ask();

  assert.ok(verdictsOf(fact).includes("link-basis:ambiguous:api|web"));
  assert.ok(!verdictsOf(fact).includes("no-call-site"));
});

test("followed call sites are evidence of the answer even when no chain reaches a read", async () => {
  const flow = { [carrierKey(siteOf())]: { uses: [], next: [], frontiers: [] } };

  const fact = await setup({ flow }).ask();

  assert.deepEqual(fact.value.findings, []);
  assert.deepEqual(fact.evidence.map((place) => [place.path, place.line, "repo" in place && place.repo]), [["src/owner.service.ts", 10, "web"]]);
});

const SERVICE_MEMBER = { kind: "member" as const, repo: "web", file: "src/svc.ts", owner: "Svc", member: "owner", line: 6 };
const memberReadAt = (file: string, line: number) => ({ kind: "member-read" as const, repo: "web", file, line, column: 1, owner: "Svc", member: "owner" });
const reachingMember = { [carrierKey(siteOf())]: { uses: [], next: [{ carrier: { site: SERVICE_MEMBER, path: path("address") }, hops: [] }], frontiers: [] } };

test("a member that holds the value is followed into the reads of other classes whose receiver the graph resolved", async () => {
  const flow = { ...reachingMember, [carrierKey(memberReadAt("src/page.ts", 20))]: { uses: [use(21, { operation: READ })], next: [], frontiers: [] } };
  const members = { owner: { kind: "found" as const, occurrences: [{ file: "src/page.ts", line: 20, column: 1, receiver: "injected" as const }] } };
  const { ask, followed } = setup({ flow, members });

  const fact = await ask();

  assert.deepEqual(verdictsOf(fact), ["incompatible"]);
  assert.deepEqual(followed.filter((carrier) => carrier.site.kind === "member-read").map((carrier) => carrierKey(carrier.site)), [carrierKey(memberReadAt("src/page.ts", 20))]);
});

test("a read of the member through a receiver the graph did not resolve is a frontier at that read, and a template read is left to the template reader", async () => {
  const members = {
    owner: {
      kind: "found" as const,
      occurrences: [
        { file: "src/guess.ts", line: 4, column: 1, receiver: "other" as const },
        { file: "src/page.ts", line: 9, column: 1, receiver: "template" as const, resource: "src/page.html" },
      ],
    },
  };
  const { ask, followed } = setup({ flow: reachingMember, members });

  const fact = await ask();

  assert.deepEqual(verdictsOf(fact), ["unmodelled-flow:member-receiver"]);
  assert.deepEqual(fact.value.findings[0]?.evidence.at(-1)?.line, 4);
  assert.equal(followed.filter((carrier) => carrier.site.kind === "member-read").length, 0);
});

test("a member the graph cannot enumerate is a frontier at its declaration, never an empty answer", async () => {
  for (const [members, via] of [
    [{ owner: { kind: "unavailable" as const } }, "graph-unavailable:member-readers"],
    [{ owner: { kind: "unresolved" as const } }, "unresolved-caller:member-readers"],
  ] as const) {
    const fact = await setup({ flow: reachingMember, members }).ask();

    assert.deepEqual(verdictsOf(fact), [via]);
    assert.deepEqual(fact.value.findings[0]?.evidence.at(-1)?.line, 6);
  }
});

test("a boundary reached through two links is followed under each, so each link keeps its uses", async () => {
  const flow = {
    [carrierKey(siteOf("src/a.service.ts", 10))]: { uses: [], next: [{ carrier: { site: SERVICE_MEMBER, path: path("address") }, hops: [] }], frontiers: [] },
    [carrierKey(siteOf("src/b.service.ts", 10))]: { uses: [], next: [{ carrier: { site: SERVICE_MEMBER, path: path("address") }, hops: [] }], frontiers: [] },
    [carrierKey(SERVICE_MEMBER)]: { uses: [use(14, { operation: READ })], next: [], frontiers: [] },
  };

  const fact = await setup({ flow, links: [link({ file: "src/a.service.ts" }), link({ file: "src/b.service.ts" })] }).ask();

  const links = fact.value.findings.flatMap((finding) => (finding.status === "complete" ? [finding.value.link.call.file] : []));
  assert.deepEqual(links, ["src/a.service.ts", "src/b.service.ts"]);
});

const TEMPLATE_CALL = { kind: "template-call-result" as const, repo: "web", resource: "src/page.html", start: 4, end: 20, callee: "label", argument: 0 };
const LABEL = { kind: "method-parameter" as const, repo: "web", file: "src/page.ts", owner: "Page", method: "label", index: 0 };
const labelReturn = { kind: "return" as const, repo: "web", file: "src/base.ts", symbol: "label", line: 4 };
const intoLabel = { carrier: { site: LABEL, path: path("address") }, hops: [{ step: "argument" as const, evidence: { path: "src/page.html", line: 2 } }], returnsTo: TEMPLATE_CALL };

test("a template call into a component method continues at the template expression when the method returns the value, with no graph edge to say so", async () => {
  const flow = {
    [carrierKey(siteOf())]: { uses: [], next: [intoLabel], frontiers: [] },
    [carrierKey(LABEL)]: { uses: [], next: [{ carrier: { site: labelReturn, path: path("address") }, hops: [{ step: "return" as const, evidence: { path: "src/base.ts", line: 5 } }] }], frontiers: [] },
  };
  const templates = { [carrierKey(TEMPLATE_CALL)]: { uses: [use(2, { site: { path: "src/page.html", line: 2 }, operation: READ })], next: [], frontiers: [] } };
  const { ask, asked, followed, templated } = setup({ flow, templates });

  const fact = await ask();

  assert.deepEqual(verdictsOf(fact), ["incompatible"]);
  assert.deepEqual(asked, []);
  assert.deepEqual(templated.map((carrier) => carrier.site.kind), ["template-call-result"]);
  assert.equal(followed.some((carrier) => carrier.site.kind === "template-call-result"), false);
});

test("a component method entered without a template expression to go back to returns to the callers the graph knows", async () => {
  const flow = {
    [carrierKey(siteOf())]: { uses: [], next: [{ carrier: { site: LABEL, path: path("address") }, hops: [] }], frontiers: [] },
    [carrierKey(LABEL)]: { uses: [], next: [{ carrier: { site: labelReturn, path: path("address") }, hops: [] }], frontiers: [] },
  };
  const { ask, asked } = setup({ flow });

  const fact = await ask();

  assert.deepEqual(asked, ["label"]);
  assert.deepEqual(verdictsOf(fact), ["no-caller"]);
});

test("a method entered from a template that returns something else than its own result does not go back to the expression", async () => {
  const other = { ...labelReturn, symbol: "other" };
  const flow = {
    [carrierKey(siteOf())]: { uses: [], next: [intoLabel], frontiers: [] },
    [carrierKey(LABEL)]: { uses: [], next: [{ carrier: { site: other, path: path("address") }, hops: [] }], frontiers: [] },
  };
  const { ask, templated } = setup({ flow });

  const fact = await ask();

  assert.deepEqual(verdictsOf(fact), ["unmodelled-flow:return-context"]);
  assert.deepEqual(templated, []);
});

const POST = "POST /vets";
const SERVICE = "src/vet.service.ts";

const literalOrigin = (value: string | number | boolean | null, line: number, overrides: Partial<Origin> = {}): Origin => ({ kind: "exact", value: { kind: "literal", value }, at: { path: SERVICE, line }, hops: [], conditions: [], ...overrides }) as Origin;
const absentOrigin = (line: number): Origin => ({ kind: "exact", value: { kind: "absent" }, at: { path: SERVICE, line }, hops: [], conditions: [] });
const frontierOrigin = (reason: Extract<Origin, { kind: "frontier" }>["reason"], line: number): Origin => ({ kind: "frontier", reason, at: { path: SERVICE, line }, hops: [], conditions: [] });
const parameterOrigin = (symbol: string, line: number, omitted: readonly Origin[] = []): Origin => ({ kind: "parameter", at: { path: SERVICE, line }, hops: [], conditions: [], parameter: { file: SERVICE, symbol, line, index: 0, path: [], body: true, omitted } });

/** A reader that answers the body of each call site by its line, and the argument of each caller by its line. */
function readerFor(bodies: Record<number, readonly Origin[]>, argumentsAt: Record<number, ArgumentOrigins> = {}) {
  const asked: string[] = [];
  const reader: RequestOriginReader = {
    ofBody: async (site) => (asked.push(`body ${site.line}`), bodies[site.line] ?? []),
    ofArgument: async (call) => (asked.push(`argument ${call.line}`), argumentsAt[call.line] ?? { kind: "passed", origins: [] }),
  };
  return { reader, asked };
}

const postLink = (line: number) => link({ line, name: POST, file: SERVICE });
const requestSetup = (options: Setup & { reader?: RequestOriginReader } = {}) => {
  const { reader, ...rest } = options;
  return setup({ method: "post", path: "/vets", target: "request", property: "id", change: "non-nullable", links: [postLink(10)], ...(reader === undefined ? {} : { origins: { web: reader } }), ...rest });
};
const producers = (fact: Awaited<ReturnType<ReturnType<typeof setup>["ask"]>>) =>
  fact.value.findings.map((finding) => (finding.status === "complete" ? `${finding.value.verdict.kind}@${finding.evidence[0]?.line}` : `unknown ${finding.evidence.at(-1)?.via}@${finding.evidence.at(-1)?.line}`));

test("each producer call site of a request is judged on its own, with the witness an incompatible one writes", async () => {
  const { reader } = readerFor({ 10: [literalOrigin("ok", 11), literalOrigin(null, 12)], 20: [literalOrigin("ok", 21)] });

  const fact = await requestSetup({ links: [postLink(20), postLink(10)], reader }).ask();

  assert.deepEqual(producers(fact), ["incompatible@10", "admits@20"]);
  const [first] = fact.value.findings;
  assert.ok(first?.status === "complete");
  const { verdict } = first.value;
  assert.ok(verdict.kind === "incompatible" && typeof verdict.witness !== "string");
  assert.deepEqual(verdict.witness.at, { path: SERVICE, line: 12 });
  assert.equal(verdict.witness.value, "null");
  assert.deepEqual(first.evidence.map((place) => place.line), [10, 12]);
  assert.deepEqual(first.value.chain.map((hop) => hop.step), ["http-call"]);
});

test("the answer echoes the normalized request hypothesis and the old acceptance it assumes", async () => {
  const { reader } = readerFor({});

  const fact = await requestSetup({ reader, change: ["non-nullable", "required"] }).ask();

  assert.deepEqual(fact.value.hypothesis, { method: "POST", path: "/vets", target: "request", property: "id", change: ["required", "non-nullable"] });
  assert.equal(fact.value.assumedOldGuarantee, "accepts-the-rejected");
});

test("a producer with no origin is never admitted, and neither is one that has an origin it cannot follow", async () => {
  const { reader } = readerFor({ 10: [], 20: [literalOrigin("ok", 21), frontierOrigin("call-result", 22)] });

  const fact = await requestSetup({ links: [postLink(10), postLink(20)], reader }).ask();

  assert.deepEqual(producers(fact), ["review@10", "review@20", "unknown call-result@22"]);
  const reasons = fact.value.findings.flatMap((finding) => (finding.status === "complete" && finding.value.verdict.kind === "review" ? [finding.value.verdict.reason] : []));
  assert.deepEqual(reasons, ["no-origin", "frontier"]);
});

test("a repository with no origin reader leaves its producers to review with a frontier", async () => {
  const fact = await requestSetup().ask();

  assert.deepEqual(producers(fact), ["review@10", "unknown untracked:no-origin-reader@10"]);
});

test("a parameter is resolved at each proven caller of its function, each call apart, with the chain to the witness", async () => {
  const callers: ConsumerCallers = {
    kind: "found",
    callers: [
      { file: "src/page.ts", line: 5, at: 7, kind: "call", provenance: "resolved", confidence: 1, proven: true },
      { file: "src/other.ts", line: 3, at: 4, kind: "call", provenance: "resolved", confidence: 1, proven: true },
    ],
  };
  const { reader, asked } = readerFor({ 10: [parameterOrigin("add", 9)] }, { 7: { kind: "passed", origins: [literalOrigin("ok", 7, { at: { path: "src/page.ts", line: 7 } })] }, 4: { kind: "passed", origins: [literalOrigin(null, 4, { at: { path: "src/other.ts", line: 4 } })] } });
  const { ask, session } = requestSetup({ reader, callers: { add: callers } });

  const fact = await ask();

  assert.deepEqual(asked, ["body 10", "argument 7", "argument 4"]);
  assert.deepEqual(producers(fact), ["incompatible@10"]);
  const [producer] = fact.value.findings;
  assert.ok(producer?.status === "complete");
  assert.deepEqual(producer.value.chain.map((hop) => [hop.step, hop.evidence.path, hop.evidence.line]), [["http-call", SERVICE, 10], ["caller", "src/other.ts", 4]]);
  assert.ok(session);
});

test("an argument a caller omits takes the parameter's default", async () => {
  const callers: ConsumerCallers = { kind: "found", callers: [{ file: "src/page.ts", line: 5, at: 7, kind: "call", provenance: "resolved", confidence: 1, proven: true }] };
  const { reader } = readerFor({ 10: [parameterOrigin("add", 9, [literalOrigin(null, 9)])] }, { 7: { kind: "omitted" } });

  const fact = await requestSetup({ reader, callers: { add: callers } }).ask();

  assert.deepEqual(producers(fact), ["incompatible@10"]);
});

test("a function with no callers, unresolved callers or an unproven caller is a frontier, never an absent origin", async () => {
  const caller = { file: "src/page.ts", line: 5, at: 7, kind: "call" as const, provenance: "heuristic" as const, confidence: 0.5 };
  const none = await requestSetup({ reader: readerFor({ 10: [parameterOrigin("add", 9)] }).reader }).ask();
  const unresolved = await requestSetup({ reader: readerFor({ 10: [parameterOrigin("add", 9)] }).reader, callers: { add: { kind: "unresolved" } } }).ask();
  const unproven = await requestSetup({ reader: readerFor({ 10: [parameterOrigin("add", 9)] }).reader, callers: { add: { kind: "found", callers: [{ ...caller, proven: false }] } } }).ask();

  assert.deepEqual(producers(none), ["unknown unresolved-callers:no-caller@9", "review@10"]);
  assert.deepEqual(producers(unresolved), ["unknown unresolved-callers:unresolved@9", "review@10"]);
  assert.deepEqual(producers(unproven), ["unknown unresolved-callers:ambiguous-caller@7", "review@10"]);
});

test("a recursion through a parameter ends in a located frontier, not in silence", async () => {
  const callers: ConsumerCallers = { kind: "found", callers: [{ file: "src/page.ts", line: 5, at: 7, kind: "call", provenance: "resolved", confidence: 1, proven: true }] };
  const { reader, asked } = readerFor({ 10: [parameterOrigin("add", 9)] }, { 7: { kind: "passed", origins: [parameterOrigin("add", 9)] } });

  const fact = await requestSetup({ reader, callers: { add: callers } }).ask();

  assert.deepEqual(asked, ["body 10", "argument 7"]);
  assert.deepEqual(producers(fact), ["unknown unresolved-callers:recursion@9", "review@10"]);
});

test("another caller of a recursive function cannot make the producer admit", async () => {
  const callers: ConsumerCallers = {
    kind: "found",
    callers: [
      { file: "src/page.ts", line: 5, at: 7, kind: "call", provenance: "resolved", confidence: 1, proven: true },
      { file: "src/other.ts", line: 3, at: 4, kind: "call", provenance: "resolved", confidence: 1, proven: true },
    ],
  };
  const { reader } = readerFor({ 10: [parameterOrigin("add", 9)] }, { 7: { kind: "passed", origins: [parameterOrigin("add", 9)] }, 4: { kind: "passed", origins: [literalOrigin(1, 4)] } });

  const fact = await requestSetup({ reader, callers: { add: callers } }).ask();

  assert.deepEqual(producers(fact), ["unknown unresolved-callers:recursion@9", "review@10"]);
});

test("a function reached twice through different callers is resolved each time, not dropped the second time", async () => {
  const callers: ConsumerCallers = { kind: "found", callers: [{ file: "src/page.ts", line: 5, at: 7, kind: "call", provenance: "resolved", confidence: 1, proven: true }] };
  const { reader } = readerFor({ 10: [parameterOrigin("add", 9), parameterOrigin("add", 9)] }, { 7: { kind: "passed", origins: [literalOrigin(null, 7)] } });

  const fact = await requestSetup({ reader, callers: { add: callers } }).ask();

  assert.deepEqual(producers(fact), ["incompatible@10"]);
  const [producer] = fact.value.findings;
  assert.ok(producer?.status === "complete" && producer.value.verdict.kind === "incompatible");
});

test("a call site whose link is not qualified is reported with its basis and never followed, and the answer names every call site searched", async () => {
  const { reader, asked } = readerFor({ 10: [literalOrigin(null, 11)] });

  const fact = await requestSetup({ reader, links: [postLink(10), link({ line: 30, name: POST, file: SERVICE, basis: "suffix" })] }).ask();

  assert.deepEqual(producers(fact), ["incompatible@10", "unknown link-basis:suffix@30"]);
  assert.deepEqual(asked, ["body 10"]);
  assert.deepEqual(fact.evidence.map((place) => place.line), [10, 30]);
});

test("a request hypothesis on an operation nobody serves is the same typed fault as a response one", async () => {
  const { queries, request } = requestSetup({ serving: [] });

  const answer = await queries.consequences(request);

  assert.ok(!answer.ok && answer.fault.kind === "unknown-operation");
});

test("a response hypothesis follows the flow and never asks for a request origin", async () => {
  const { reader, asked } = readerFor({});
  const flow = { [carrierKey(siteOf())]: { uses: [use(30, { operation: READ })], next: [], frontiers: [] } };

  const fact = await setup({ flow, origins: { web: reader } }).ask();

  assert.deepEqual(verdictsOf(fact), ["incompatible"]);
  assert.deepEqual(asked, []);
});
