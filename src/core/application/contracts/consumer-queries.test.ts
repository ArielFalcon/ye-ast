import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessPath } from "../../domain/contracts/access-path.ts";
import { carrierKey, NO_FLOW, type Carrier, type FlowResult, type FlowUse } from "../../domain/contracts/consumer-flow.ts";
import type { Guard } from "../../domain/contracts/verdict.ts";
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

function link(overrides: { file?: string; line?: number; basis?: Link["basis"]; name?: string } = {}): Link {
  const { file = "src/owner.service.ts", line = 10, basis = "exact", name = OPERATION } = overrides;
  const from = { repo: "web", file, line, symbol: "find" };
  return { id: `${file}:${line}:${name}:${basis}`, from, to: { repo: "api", kind: "http-route", name, handler: { path: "Owners.java", symbol: "get", line: 5 } }, transport: "http", basis, confidence: 1 };
}

const siteOf = (file = "src/owner.service.ts", line = 10) => ({ kind: "call-site" as const, repo: "web", file, line, symbol: "find" });
const returnOf = (symbol = "find", line = 8, file = "src/owner.service.ts") => ({ kind: "return" as const, repo: "web", file, symbol, line });

function guard(overrides: Partial<Guard> = {}): Guard {
  return { kind: "optional-chain", covers: path("address"), excludes: ["null", "undefined"], evidence: { path: "src/page.ts", line: 31 }, ...overrides };
}

function use(line: number, overrides: Partial<FlowUse> = {}): FlowUse {
  return { site: { path: "src/page.ts", line }, path: path("address.city"), changed: path("address"), operation: "consume", guards: [], hops: [{ step: "subscribe", evidence: { path: "src/page.ts", line } }], ...overrides };
}

interface Setup {
  links?: readonly Link[];
  flow?: Record<string, FlowResult>;
  templates?: Record<string, FlowResult>;
  callers?: Record<string, ConsumerCallers>;
  serving?: ConsumerSession["serving"];
  property?: string;
  change?: string;
}

function setup(options: Setup = {}) {
  const followed: Carrier[] = [];
  const templated: Carrier[] = [];
  const opened: string[] = [];
  const session: ConsumerSession = {
    base: BASE,
    links: options.links ?? [link()],
    serving: options.serving ?? [{ repo: "api", handler: { path: "Owners.java", symbol: "get", line: 5 } }],
    cuts: [],
    callers: (declaration) => options.callers?.[declaration.symbol] ?? { kind: "found", callers: [] },
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
  return { ask, followed, templated, opened, queries, request };
}

const verdictsOf = (fact: Awaited<ReturnType<ReturnType<typeof setup>["ask"]>>) => fact.value.findings.map((finding) => (finding.status === "complete" ? finding.value.verdict.kind : finding.evidence.at(-1)?.via));

test("each use gets its verdict, with the chain from the call site that proves it", async () => {
  const flow = { [carrierKey(siteOf())]: { uses: [use(30, { operation: "dereference" }), use(40, { operation: "dereference", guards: [guard()] }), use(50, { operation: "unmodelled", path: path("address") })], next: [], frontiers: [] } };
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
const caller = (overrides: Partial<ConsumerCaller> = {}): ConsumerCaller => ({ file: "src/page.ts", line: 20, lines: [25], proven: true, ...overrides });

test("a function return continues at each line of each resolved caller, and the caller is a hop of the chain", async () => {
  const flow = {
    ...returning(),
    [carrierKey({ kind: "call-result", repo: "web", file: "src/page.ts", line: 25, callee: "find" })]: { uses: [use(26, { operation: "dereference" })], next: [], frontiers: [] },
    [carrierKey({ kind: "call-result", repo: "web", file: "src/page.ts", line: 27, callee: "find" })]: { uses: [use(28, { operation: "dereference" })], next: [], frontiers: [] },
  };
  const callers = { find: { kind: "found" as const, callers: [caller({ lines: [25, 27] })] } };

  const fact = await setup({ flow, callers }).ask();

  assert.deepEqual(fact.value.findings.map((finding) => finding.status === "complete" && finding.value.chain.map((hop) => [hop.step, hop.evidence.line])), [
    [["http-call", 10], ["return", 12], ["caller", 25], ["subscribe", 26]],
    [["http-call", 10], ["return", 12], ["caller", 27], ["subscribe", 28]],
  ]);
});

test("a caller that is not a proven call, has no position, or sits in a template is a frontier, not a continuation", async () => {
  const callers = { find: { kind: "found" as const, callers: [caller({ file: "src/a.ts", line: 1, lines: [4], proven: false }), caller({ file: "src/b.ts", line: 1, lines: [] }), caller({ file: "src/c.ts", line: 1, lines: [6], resource: "src/c.html" })] } };
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
    [carrierKey(parent)]: { uses: [use(14, { operation: "dereference" })], next: [], frontiers: [] },
  };
  const templates = {
    [carrierKey(parent)]: { uses: [use(3, { site: { path: "src/page.html", line: 3 }, operation: "dereference", guards: [guard()] })], next: [{ carrier: { site: child, path: path("address") }, hops: [{ step: "template-binding" as const, evidence: { path: "src/page.html", line: 5 } }] }], frontiers: [] },
    [carrierKey(child)]: { uses: [use(2, { site: { path: "src/card.html", line: 2 }, operation: "dereference" })], next: [], frontiers: [] },
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
    [carrierKey(siteOf("src/a.service.ts", 2))]: { uses: [use(80, { site: { path: "src/z.ts", line: 80 }, operation: "dereference" })], next: [], frontiers: [] },
    [carrierKey(siteOf("src/b.service.ts", 9))]: { uses: [use(5, { site: { path: "src/m.ts", line: 5 }, operation: "dereference" })], next: [], frontiers: [] },
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
