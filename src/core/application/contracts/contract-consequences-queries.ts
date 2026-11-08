import { formatAccessPath, relatePaths, type AccessPath } from "../../domain/contracts/access-path.ts";
import { consequencesFact, OLD_ACCEPTANCE, OLD_GUARANTEE, type AnswerBody, type ConsequenceFinding, type ConsequencesValue, type HypothesisAnswer, type LocatedHop, type ProducerConsequence, type UseConsequence } from "../../domain/contracts/consequence-fact.ts";
import { writtenChange } from "../../domain/contracts/change.ts";
import { carrierKey, siteFile, siteLine, type Carrier, type CarrierSite, type FlowFrontier, type FlowNext, type FlowResult, type Hop } from "../../domain/contracts/consumer-flow.ts";
import { formatHypothesis, parseHypothesis, type Hypothesis, type RequestHypothesis, type ResponseHypothesis } from "../../domain/contracts/hypothesis.ts";
import { writtenRequestChange } from "../../domain/contracts/request-change.ts";
import { decideProducer, type Origin, type SettledOrigin } from "../../domain/contracts/request-origin.ts";
import { decideUse } from "../../domain/contracts/verdict.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { withCuts, type Evidence, type Fact, type FactBase, type UnknownReason } from "../../domain/shared/fact.ts";
import type { Link, LinkBasis } from "../../domain/topology/link.ts";
import type { RepositoryEvidence } from "../../domain/shared/repository-evidence.ts";
import type { ContractConsequencesQueries } from "../../ports/contract-consequences-queries.port.ts";
import type { ConsumerSession, ConsumerSources, PreparedWorkspace } from "../../ports/consumer-sources.port.ts";
import type { RequestOriginReader } from "../../ports/request-origins.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import { isCallOf } from "./consumer-sources.ts";
import { httpRouteName } from "../../domain/entrypoints/http-route.ts";

/** The bases that say the call reaches this operation; the others say it may, and are reported where they stop. */
const QUALIFIED_BASES: ReadonlySet<LinkBasis> = new Set(["exact", "base-path"]);

export interface ContractConsequencesQueriesDeps {
  sources: ConsumerSources;
  /** The operation that answers a change, which derives its hypotheses and answers them with `answerOn`. */
  ofChange: ContractConsequencesQueries["ofChange"];
}

/**
 * The call that handed the value to a function through an argument, and the function it entered. A template expression
 * that handed it to a component method also names where the method's result goes back to, and the method by its name only.
 */
interface Entry {
  repo: string;
  at: Evidence;
  callee: { file: string; symbol: string; line: number };
  returnsTo?: Extract<CarrierSite, { kind: "template-call-result" }>;
}

/** A boundary still to follow: the link the value came through and, nearest last, the calls that entered the functions it is inside. */
interface Pending {
  carrier: Carrier;
  chain: readonly Hop[];
  link: Link;
  entries: readonly Entry[];
}

const located = (evidence: Evidence, repo: string): RepositoryEvidence => ({ ...evidence, repo });
const locatedHops = (hops: readonly Hop[], repo: string): LocatedHop[] => hops.map((hop) => ({ ...hop, evidence: located(hop.evidence, repo) }));

export function createContractConsequencesQueries({ sources, ofChange }: ContractConsequencesQueriesDeps): ContractConsequencesQueries {
  return {
    async ofHypotheses({ hypotheses, ...workspace }) {
      const parsed: Hypothesis[] = [];
      for (const [index, input] of hypotheses.entries()) {
        const hypothesis = parseHypothesis(input);
        if (!hypothesis.ok) return { ok: false, fault: { kind: "invalid-hypothesis", detail: `hypotheses[${index}]: ${hypothesis.fault.detail}`, index, refusal: hypothesis.fault } };
        parsed.push(hypothesis.value);
      }
      return sources.withWorkspace(workspace, async (prepared) => {
        const base = prepared.base({ hypotheses: parsed.map(formatHypothesis) });
        const answered: Answered[] = [];
        for (const hypothesis of parsed) answered.push(await answerOn(prepared, base, hypothesis));
        return assemble(prepared, base, answered);
      });
    },
    ofChange,
  };
}

/** One hypothesis answered, and the call sites its answer searched. */
export interface Answered {
  answer: HypothesisAnswer;
  sites: readonly RepositoryEvidence[];
}

/** The composite fact of the answers, whose evidence is every call site they searched. */
export function assemble(workspace: PreparedWorkspace, base: FactBase, answered: readonly Answered[], change?: ConsequencesValue["change"]): Fact<ConsequencesValue> {
  const sites = [...new Map(answered.flatMap((one) => one.sites).map((place) => [canonicalJson(place), place])).values()].sort((a, b) => compareEvidence(a, b) || compareText(a.repo, b.repo));
  const value: ConsequencesValue = { repositorySnapshots: workspace.repositorySnapshots, answers: answered.map(({ answer }) => answer), ...(change === undefined ? {} : { change }) };
  return consequencesFact({ ...base, evidence: sites }, value);
}

const assumedOf = (hypothesis: Hypothesis): Pick<AnswerBody, "hypothesis" | "oldContract"> =>
  hypothesis.target === "response"
    ? {
        hypothesis: {
          method: hypothesis.method,
          path: hypothesis.path,
          target: hypothesis.target,
          property: formatAccessPath(hypothesis.property),
          change: writtenChange(hypothesis.change),
          ...(hypothesis.change.renamedTo === undefined ? {} : { renamedTo: formatAccessPath(hypothesis.change.renamedTo) }),
          ...(hypothesis.change.elementsAt === undefined ? {} : { elementsAt: formatAccessPath(hypothesis.change.elementsAt) }),
        },
        oldContract: hypothesis.change.oldGuarantee ?? OLD_GUARANTEE,
      }
    : { hypothesis: { method: hypothesis.method, path: hypothesis.path, target: hypothesis.target, property: formatAccessPath(hypothesis.property), change: writtenRequestChange(hypothesis.change) }, oldContract: hypothesis.change.oldAcceptance ?? OLD_ACCEPTANCE };

/** The consequences of one hypothesis on a workspace already prepared, so a caller with several hypotheses prepares once. */
export async function answerOn(workspace: PreparedWorkspace, base: FactBase, hypothesis: Hypothesis, derivedFrom?: AnswerBody["derivedFrom"]): Promise<Answered> {
  const stated = { ...assumedOf(hypothesis), ...(derivedFrom === undefined ? {} : { derivedFrom }) };
  const unknown = (reason: UnknownReason, detail: string): Answered => ({ answer: { ...stated, findings: [], status: "unknown", reason, detail }, sites: [] });
  const session = await workspace.session(hypothesis);
  if (!session.ok) return unknown("source-unreadable", session.fault.detail);
  const operation = httpRouteName({ method: hypothesis.method, path: hypothesis.path });
  const selected = selectCalls(session.value, operation);
  if (!selected.ok) return unknown("unresolved", selected.fault);
  const followed = hypothesis.target === "response" ? consequencesOf(session.value, selected.value, hypothesis) : await producersOf(session.value, selected.value, hypothesis);
  const body: AnswerBody = { ...stated, ...followed };
  const sealed = withCuts(base, body, workspace.cuts);
  return { answer: sealed.status === "partial" ? { ...body, status: "partial", cuts: sealed.cuts } : { ...body, status: "complete" }, sites: selected.value.sites.toSorted(compareEvidence) };
}

/** The HTTP call sites that call an operation: the qualified links to follow, and everything else about the join as items of its own. */
interface CallSelection {
  qualified: Link[];
  findings: ConsequenceFinding<UseConsequence | ProducerConsequence>[];
  sites: RepositoryEvidence[];
}

/** An operation no repository serves has no contract to change, so the hypothesis is unknown rather than a fault. */
function selectCalls(session: ConsumerSession, operation: string): Result<CallSelection, string> {
  if (session.serving.length === 0) return { ok: false, fault: `no repository of the workspace serves ${operation}` };
  const findings: CallSelection["findings"] = [];
  const qualified: Link[] = [];
  const sites: RepositoryEvidence[] = [];
  const links = session.links
    .filter((link) => isCallOf(link, operation))
    .sort((a, b) => compareText(a.from.repo, b.from.repo) || compareText(a.from.file, b.from.file) || a.from.line - b.from.line || compareText(a.id, b.id));
  for (const link of links) {
    const { from, basis } = link;
    const at = { path: from.file, line: from.line };
    sites.push(located(at, from.repo));
    if (QUALIFIED_BASES.has(basis)) qualified.push(link);
    else findings.push(frontierItem({ at, cause: "link-basis", reason: "unresolved", detail: basis, hops: [] }, [], from.repo));
  }
  for (const { from, repos } of session.ambiguousCalls) {
    const at = { path: from.file, line: from.line };
    sites.push(located(at, from.repo));
    findings.push(frontierItem({ at, cause: "link-basis", reason: "unresolved", detail: `ambiguous:${repos.join("|")}`, hops: [] }, [], from.repo));
  }

  const unresolved = session.unresolvedCalls.map((call) => located({ path: call.file, line: call.line, via: "unresolved-call-site" }, call.repo)).sort(compareEvidence);
  if (links.length === 0 && session.ambiguousCalls.length === 0) {
    for (const { repo, handler } of session.serving) {
      const evidence = [...unresolved, located({ path: handler.path, line: handler.line, via: "no-call-site" }, repo)];
      findings.push({ status: "unknown", reason: "unresolved", evidence });
    }
  } else if (unresolved.length > 0) {
    findings.push({ status: "unknown", reason: "unresolved", evidence: unresolved });
  }
  return { ok: true, value: { qualified, findings, sites } };
}

function consequencesOf(session: ConsumerSession, selected: CallSelection, hypothesis: ResponseHypothesis): Pick<AnswerBody, "findings" | "silent"> {
  const { findings } = selected;
  const queue: Pending[] = selected.qualified.map((link) => {
    const { from, basis } = link;
    return { carrier: { site: { kind: "call-site", ...from }, path: hypothesis.property }, chain: [{ step: "http-call", evidence: { path: from.file, line: from.line, via: `basis:${basis}` } }], link, entries: [] };
  });
  let silent = 0;

  const seen = new Map<string, AccessPath>();
  for (let index = 0; index < queue.length; index++) {
    const { carrier, chain, link, entries } = queue[index]!;
    const repo = link.from.repo;
    const key = `${link.id}\0${carrierKey(carrier.site)}\0${canonicalJson(entries)}`;
    const before = seen.get(key);
    if (before !== undefined) {
      if (relatePaths(before, carrier.path) !== "exact") findings.push(frontierItem({ at: placeOf(carrier, chain), cause: "path-conflict", reason: "unresolved", hops: [] }, chain, repo));
      continue;
    }
    seen.set(key, carrier.path);

    const result = read(session, carrier);
    for (const use of result.uses) {
      const verdict = decideUse(use, hypothesis.change);
      if (verdict === undefined) continue;
      if (verdict.kind === "silent") {
        silent++;
        continue;
      }
      const evidence = [use.site, ...(verdict.kind === "admits" ? verdict.guards.map((guard) => guard.evidence) : [])].map((place) => located(place, repo));
      const value: UseConsequence = {
        repo,
        link: linkOf(link),
        verdict,
        operation: use.operation,
        path: formatAccessPath(use.path),
        changed: formatAccessPath(use.changed),
        chain: locatedHops([...chain, ...use.hops], repo),
      };
      findings.push({ status: "complete", evidence, value });
    }
    for (const frontier of result.frontiers) findings.push(frontierItem(frontier, chain, repo));
    for (const next of result.next) {
      const entered = entriesAfter(carrier, next, entries);
      if (entered === "recursion") findings.push(frontierItem({ at: next.hops.at(-1)?.evidence ?? placeOf(carrier, chain), cause: "unmodelled-flow", reason: "unresolved", detail: "recursion", hops: [] }, chain, repo));
      else queue.push({ carrier: next.carrier, chain: [...chain, ...next.hops], link, entries: entered });
    }
    if (carrier.site.kind === "member") {
      const readers = readersOfMember(session, carrier.site, carrier.path, chain);
      for (const frontier of readers.frontiers) findings.push(frontierItem(frontier, chain, repo));
      queue.push(...readers.next.map((next) => ({ ...next, link })));
    }
    if (carrier.site.kind === "return") {
      const returned = returnsOf(session, carrier.site, carrier.path, chain, entries, result);
      for (const frontier of returned.frontiers) findings.push(frontierItem(frontier, chain, repo));
      queue.push(...returned.next.map((next) => ({ ...next, link })));
    }
  }

  return { ...(hypothesis.change.values === undefined ? {} : { silent }), findings: findings.sort(compareFindings) };
}

const linkOf = (link: Link): UseConsequence["link"] => ({ id: link.id, basis: link.basis, call: { file: link.from.file, line: link.from.line, symbol: link.from.symbol }, handler: { repo: link.to.repo, ...link.to.handler } });

/**
 * The producers of a request body: each qualified HTTP call site that sends the operation's request, with what it can
 * write at the changed property, followed backward from the call through the callers of the functions that pass it on.
 */
async function producersOf(session: ConsumerSession, selected: CallSelection, hypothesis: RequestHypothesis): Promise<Pick<AnswerBody, "findings">> {
  const { findings } = selected;
  for (const link of selected.qualified) findings.push(...(await producerOf(session, link, hypothesis, session.requestOrigins(link.from.repo))));
  return { findings: findings.sort(compareFindings) };
}

async function producerOf(session: ConsumerSession, link: Link, hypothesis: RequestHypothesis, reader: RequestOriginReader | undefined): Promise<ConsequenceFinding<ProducerConsequence>[]> {
  const { from, basis } = link;
  const repo = from.repo;
  const call: Hop = { step: "http-call", evidence: { path: from.file, line: from.line, via: `basis:${basis}` } };
  const unreadable: Origin = { kind: "frontier", reason: "untracked", detail: "no-origin-reader", at: { path: from.file, line: from.line }, hops: [], conditions: [] };
  const start: Origin[] = reader === undefined ? [unreadable] : [...(await reader.ofBody({ file: from.file, line: from.line, symbol: from.symbol }, hypothesis.property))];
  const work: OriginStep[] = start.map((origin) => ({ origin, through: [] }));
  const settled: SettledOrigin[] = [];
  for (let index = 0; index < work.length; index++) {
    const { origin, through } = work[index]!;
    if (origin.kind === "parameter") work.push(...(await resolveParameter(session, reader!, repo, origin, through)));
    else settled.push(origin);
  }
  const verdict = decideProducer(settled, hypothesis.change.rejected);
  const witness = verdict.kind === "incompatible" ? verdict.witness : undefined;
  const decided: ConsequenceFinding<ProducerConsequence> = {
    status: "complete",
    evidence: [located({ path: from.file, line: from.line }, repo), ...(witness === undefined ? [] : [located(witness.at, repo)])],
    value: { repo, link: linkOf(link), verdict, path: formatAccessPath(hypothesis.property), chain: locatedHops([call, ...(witness?.hops ?? [])], repo) },
  };
  const frontiers = settled.flatMap((origin): ConsequenceFinding<ProducerConsequence>[] => {
    if (origin.kind !== "frontier") return [];
    const via = origin.detail === undefined ? origin.reason : `${origin.reason}:${origin.detail}`;
    return [{ status: "unknown", reason: "unresolved", evidence: [call, ...origin.hops].map((hop) => located(hop.evidence, repo)).concat(located({ ...origin.at, via }, repo)) }];
  });
  return [decided, ...frontiers];
}

/** An origin still to settle, and the parameters it was reached through: a parameter met again on that way is a recursion, while one reached by another way is a result to compute again. */
interface OriginStep {
  origin: Origin;
  through: readonly string[];
}

/** What a parameter holds at each proven caller of its function; a caller the graph cannot prove, a function nobody calls and a recursion are frontiers. */
async function resolveParameter(session: ConsumerSession, reader: RequestOriginReader, repo: string, origin: Extract<Origin, { kind: "parameter" }>, through: readonly string[]): Promise<OriginStep[]> {
  const { parameter } = origin;
  const key = canonicalJson([parameter.file, parameter.symbol, parameter.line, parameter.index, parameter.path, parameter.body]);
  const lost = (at: Evidence, detail: string): OriginStep => ({ origin: { kind: "frontier", reason: "unresolved-callers", detail, at, hops: origin.hops, conditions: origin.conditions }, through });
  const declaration = { path: parameter.file, line: parameter.line };
  if (through.includes(key)) return [lost(declaration, "recursion")];
  const found = session.callers({ repo, file: parameter.file, symbol: parameter.symbol, line: parameter.line });
  if (found.kind === "unavailable") return [lost(declaration, "graph-unavailable")];
  if (found.kind === "unresolved") return [lost(declaration, "unresolved")];
  if (found.callers.length === 0) return [lost(declaration, "no-caller")];
  const resolved: OriginStep[] = [];
  for (const caller of found.callers) {
    const at: Evidence = { path: caller.resource ?? caller.file, line: caller.at ?? caller.line };
    if (caller.resource !== undefined) resolved.push(lost(at, "template-caller"));
    else if (caller.kind === "reference") resolved.push(lost(at, "function-reference"));
    else if (!caller.proven) resolved.push(lost(at, "ambiguous-caller"));
    else if (caller.at === undefined) resolved.push(lost(at, "unresolved-caller"));
    else {
      const argument = await reader.ofArgument({ file: caller.file, line: caller.at, callee: parameter.symbol }, parameter.index, parameter.path, parameter.body);
      const step: Hop = { step: "caller", evidence: { path: caller.file, line: caller.at } };
      for (const value of argument.kind === "omitted" ? parameter.omitted : argument.origins) resolved.push({ origin: { ...value, hops: [...origin.hops, step, ...value.hops], conditions: [...origin.conditions, ...value.conditions] }, through: [...through, key] });
    }
  }
  return resolved;
}

function read(session: ConsumerSession, carrier: Carrier): FlowResult {
  const { site } = carrier;
  if (site.kind === "template-call-result") return session.templates.follow({ site, path: carrier.path });
  const flow = session.flow.follow(carrier);
  const template = site.kind === "member" ? session.templates.follow({ site, path: carrier.path }) : undefined;
  if (template === undefined) return flow;
  return { uses: [...flow.uses, ...template.uses], next: [...flow.next, ...template.next], frontiers: [...flow.frontiers, ...template.frontiers] };
}

/**
 * The places outside the declaring class that read a member holding the value. The reads in a template are the template
 * reader's; one through any receiver the graph did not resolve is lost, since two instances of a class share no field.
 */
function readersOfMember(session: ConsumerSession, site: Extract<CarrierSite, { kind: "member" }>, path: AccessPath, chain: readonly Hop[]): { next: Omit<Pending, "link">[]; frontiers: FlowFrontier[] } {
  const declaration = { path: site.file, line: site.line ?? 1 };
  const found = session.memberOccurrences(site);
  if (found.kind === "unavailable") return { next: [], frontiers: [{ at: declaration, cause: "graph-unavailable", reason: "index-unavailable", detail: "member-readers", hops: [] }] };
  if (found.kind === "unresolved") return { next: [], frontiers: [{ at: declaration, cause: "unresolved-caller", reason: "unresolved", detail: "member-readers", hops: [] }] };
  const next: Omit<Pending, "link">[] = [];
  const frontiers: FlowFrontier[] = [];
  for (const { file, line, column, receiver } of found.occurrences) {
    if (receiver === "template") continue;
    if (receiver === "other") frontiers.push({ at: { path: file, line }, cause: "unmodelled-flow", reason: "unresolved", detail: "member-receiver", hops: [] });
    else next.push({ carrier: { site: { kind: "member-read", repo: site.repo, file, line, column, owner: site.owner, member: site.member }, path }, chain, entries: [] });
  }
  return { next, frontiers };
}

/**
 * Where a value goes when its function returns it. A value that entered the function through an argument leaves at the
 * result of that very call; any other return continues at the places that depend on the function, each occurrence on its own.
 */
function returnsOf(session: ConsumerSession, site: Extract<CarrierSite, { kind: "return" }>, path: AccessPath, chain: readonly Hop[], entries: readonly Entry[], flowed: FlowResult): { next: Omit<Pending, "link">[]; frontiers: FlowFrontier[] } {
  const declaration = { path: site.file, line: site.line };
  const entry = entries.at(-1);
  if (entry?.returnsTo !== undefined) {
    if (entry.callee.symbol !== site.symbol) return { next: [], frontiers: [{ at: declaration, cause: "unmodelled-flow", reason: "unresolved", detail: "return-context", hops: [] }] };
    return { next: [{ carrier: { site: entry.returnsTo, path }, chain: [...chain, { step: "caller", evidence: entry.at }], entries: entries.slice(0, -1) }], frontiers: [] };
  }
  if (entry !== undefined) {
    if (entry.callee.file !== site.file || entry.callee.symbol !== site.symbol || entry.callee.line !== site.line) return { next: [], frontiers: [{ at: declaration, cause: "unmodelled-flow", reason: "unresolved", detail: "return-context", hops: [] }] };
    const call = { kind: "call-result" as const, repo: entry.repo, file: entry.at.path, line: entry.at.line, callee: site.symbol };
    return { next: [{ carrier: { site: call, path }, chain: [...chain, { step: "caller", evidence: { path: entry.at.path, line: entry.at.line } }], entries: entries.slice(0, -1) }], frontiers: [] };
  }
  const found = session.callers(site);
  if (found.kind === "unavailable") return { next: [], frontiers: [{ at: declaration, cause: "graph-unavailable", reason: "index-unavailable", hops: [] }] };
  if (found.kind === "unresolved") return { next: [], frontiers: [{ at: declaration, cause: "unresolved-caller", reason: "unresolved", hops: [] }] };
  if (found.callers.length === 0) return { next: [], frontiers: flowed.next.length > 0 ? [] : [{ at: declaration, cause: "no-caller", reason: "unresolved", hops: [] }] };

  const registered = new Set([...flowed.next.flatMap(({ hops }) => hops), ...flowed.frontiers.flatMap(({ hops }) => hops), ...flowed.uses.flatMap(({ hops }) => hops)].filter((hop) => hop.step === "resolver-input").map(({ evidence }) => `${evidence.path}:${evidence.line}`));
  const next: Omit<Pending, "link">[] = [];
  const frontiers: FlowFrontier[] = [];
  for (const caller of found.callers) {
    const at: Evidence = { path: caller.resource ?? caller.file, line: caller.at ?? caller.line, ...(caller.kind === "call" && caller.provenance === "heuristic" ? { confidence: caller.confidence } : {}) };
    const lost = (cause: FlowFrontier["cause"], detail?: string) => frontiers.push({ at, cause, reason: "unresolved", ...(detail === undefined ? {} : { detail }), hops: [] });
    if (caller.resource !== undefined) lost("unmodelled-flow", "template-caller");
    else if (caller.kind === "reference") {
      if (!registered.has(`${at.path}:${at.line}`)) lost("unmodelled-flow", "function-reference");
    } else if (!caller.proven) lost("ambiguous-caller");
    else if (caller.at === undefined) lost("unresolved-caller");
    else {
      const call = { kind: "call-result" as const, repo: site.repo, file: caller.file, line: caller.at, callee: site.symbol };
      next.push({ carrier: { site: call, path }, chain: [...chain, { step: "caller", evidence: { path: caller.file, line: caller.at } }], entries: [] });
    }
  }
  return { next, frontiers };
}

/** The calls that entered the functions a value is inside once it continues at `next`; a parameter pushes one, a return keeps them, anything else leaves every function. */
function entriesAfter({ site }: Carrier, { carrier, hops, returnsTo }: FlowNext, entries: readonly Entry[]): readonly Entry[] | "recursion" {
  if (carrier.site.kind === "return" || carrier.site.kind === "call-result") return entries;
  let entry: Entry;
  if (carrier.site.kind === "method-parameter") {
    if (returnsTo === undefined) return [];
    entry = { repo: site.repo, at: hops.at(-1)?.evidence ?? { path: returnsTo.resource, line: 1 }, callee: { file: carrier.site.file, symbol: carrier.site.method, line: 0 }, returnsTo };
  } else {
    if (carrier.site.kind !== "parameter") return [];
    const call = hops.findLast((hop) => hop.step === "argument");
    if (call === undefined) return [];
    entry = { repo: site.repo, at: { path: call.evidence.path, line: call.evidence.line }, callee: { file: carrier.site.file, symbol: carrier.site.symbol, line: carrier.site.line } };
  }
  return entries.some((held) => canonicalJson(held) === canonicalJson(entry)) ? "recursion" : [...entries, entry];
}

function frontierItem(frontier: FlowFrontier, chain: readonly Hop[], repo: string): ConsequenceFinding<UseConsequence> {
  const via = frontier.detail === undefined ? frontier.cause : `${frontier.cause}:${frontier.detail}`;
  return { status: "unknown", reason: frontier.reason, evidence: [...chain, ...frontier.hops].map((hop) => located(hop.evidence, repo)).concat(located({ ...frontier.at, via }, repo)) };
}

function placeOf({ site }: Carrier, chain: readonly Hop[]): Evidence {
  const line = siteLine(site);
  return line === undefined ? chain.at(-1)!.evidence : { path: siteFile(site), line };
}

function compareEvidence(a: Evidence, b: Evidence): number {
  return compareText(a.path, b.path) || a.line - b.line;
}

function compareFindings(a: ConsequenceFinding<UseConsequence | ProducerConsequence>, b: ConsequenceFinding<UseConsequence | ProducerConsequence>): number {
  const where = (finding: ConsequenceFinding<UseConsequence | ProducerConsequence>) => (finding.status === "complete" ? finding.evidence[0] : finding.evidence.at(-1))!;
  return compareEvidence(where(a), where(b)) || Number(a.status === "unknown") - Number(b.status === "unknown") || compareText(canonicalJson(a), canonicalJson(b));
}
