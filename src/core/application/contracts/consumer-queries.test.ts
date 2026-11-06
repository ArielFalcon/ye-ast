import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessPath } from "../../domain/contracts/access-path.ts";
import { carrierKey, NO_FLOW, type Carrier, type FlowResult, type FlowUse } from "../../domain/contracts/consumer-flow.ts";
import type { HypothesisInput } from "../../domain/contracts/hypothesis.ts";
import type { Predicate } from "../../domain/contracts/use-operation.ts";
import type { TestedGuard, UseOperation } from "../../domain/contracts/verdict.ts";
import type { FactBase } from "../../domain/shared/fact.ts";
import type { Link } from "../../domain/topology/link.ts";
import type { ConsequencesRequest, ConsumerQueries } from "../../ports/consumer-queries.port.ts";
import type { ConsumerCaller, ConsumerCallers, ConsumerSession } from "../../ports/consumer-sources.port.ts";
import { createConsumerQueries } from "./consumer-queries.ts";

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
  serving?: ConsumerSession["serving"];
  unresolvedCalls?: ConsumerSession["unresolvedCalls"];
  ambiguousCalls?: ConsumerSession["ambiguousCalls"];
  property?: string;
  change?: HypothesisInput["change"];
}

function setup(options: Setup = {}) {
  const followed: Carrier[] = [];
  const templated: Carrier[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  const session: ConsumerSession = {
    base: BASE,
    links: options.links ?? [link()],
    serving: options.serving ?? [{ repo: "api", handler: { path: "Owners.java", symbol: "get", line: 5 } }],
    unresolvedCalls: options.unresolvedCalls ?? [],
    ambiguousCalls: options.ambiguousCalls ?? [],
    cuts: [],
    callers: (declaration) => (asked.push(declaration.symbol), options.callers?.[declaration.symbol] ?? { kind: "found", callers: [] }),
    flow: { follow: (carrier) => (followed.push(carrier), options.flow?.[carrierKey(carrier.site)] ?? NO_FLOW) },
    templates: { follow: (carrier) => (templated.push(carrier), options.templates?.[carrierKey(carrier.site)] ?? NO_FLOW) },
  };
  const queries: ConsumerQueries = createConsumerQueries({
    sources: {
      withSession: async (request, run) => {
        opened.push(request.hypothesis.property.join("."));
        return { ok: true, value: await run(session) };
      },
    },
  });
  const request: ConsequencesRequest = { repo: { repo: "web", path: "/work/web" } as ConsequencesRequest["repo"], hypothesis: { method: "get", path: "/owners/{id}", target: "response", property: options.property ?? "address", change: options.change ?? "nullable" } };
  const ask = async () => {
    const answer = await queries.consequences(request);
    assert.ok(answer.ok);
    assert.notEqual(answer.value.status, "unknown");
    return answer.value as Exclude<typeof answer.value, { status: "unknown" }>;
  };
  return { ask, followed, templated, opened, asked, queries, request };
}

const verdictsOf = (fact: Awaited<ReturnType<ReturnType<typeof setup>["ask"]>>) => fact.value.findings.map((finding) => (finding.status === "complete" ? finding.value.verdict.kind : finding.evidence.at(-1)?.via));

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
