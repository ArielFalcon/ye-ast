import { formatAccessPath, type AccessPath } from "../../domain/contracts/access-path.ts";
import { OLD_GUARANTEE, type UseConsequence } from "../../domain/contracts/consequence-fact.ts";
import { carrierKey, type Carrier, type CarrierSite, type FlowFrontier, type FlowNext, type FlowResult, type Hop } from "../../domain/contracts/consumer-flow.ts";
import { parseHypothesis, type Hypothesis } from "../../domain/contracts/hypothesis.ts";
import { decideUse } from "../../domain/contracts/verdict.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { withCuts, type Cut, type Evidence, type Fact, type Finding } from "../../domain/shared/fact.ts";
import type { Link, LinkBasis } from "../../domain/topology/link.ts";
import type { RepositoryEvidence } from "../../domain/shared/repository-evidence.ts";
import type { ConsumerQueries } from "../../ports/consumer-queries.port.ts";
import type { ConsequencesFault } from "../../ports/consumer-queries.port.ts";
import type { ConsumerSession, ConsumerSources } from "../../ports/consumer-sources.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { ConsequencesValue } from "../../domain/contracts/consequence-fact.ts";

/** The bases that say the call reaches this operation; the others say it may, and are reported where they stop. */
const QUALIFIED_BASES: ReadonlySet<LinkBasis> = new Set(["exact", "base-path", "operation-id"]);

export interface ConsumerQueriesDeps {
  sources: ConsumerSources;
}

/** The call that handed the value to a function through an argument, and the function it entered. */
interface Entry {
  repo: string;
  at: Evidence;
  callee: { file: string; symbol: string; line: number };
}

/** A boundary still to follow: the link the value came through and, nearest last, the calls that entered the functions it is inside. */
interface Pending {
  carrier: Carrier;
  chain: readonly Hop[];
  link: Link;
  entries: readonly Entry[];
}

const located = (evidence: Evidence, repo: string): RepositoryEvidence => ({ ...evidence, repo });

export function createConsumerQueries({ sources }: ConsumerQueriesDeps): ConsumerQueries {
  return {
    async consequences(request) {
      const parsed = parseHypothesis(request.hypothesis);
      if (!parsed.ok) return { ok: false, fault: { kind: "invalid-hypothesis", detail: parsed.fault.detail, refusal: parsed.fault } };
      const hypothesis = parsed.value;
      const answered = await sources.withSession({ ...request, hypothesis }, async (session) => consequencesOf(session, hypothesis));
      return answered.ok ? answered.value : answered;
    },
  };
}

function consequencesOf(session: ConsumerSession, hypothesis: Hypothesis): Result<Fact<ConsequencesValue>, ConsequencesFault> {
  const operation = `${hypothesis.method} ${hypothesis.path}`;
  if (session.serving.length === 0) return { ok: false, fault: { kind: "unknown-operation", detail: `no repository of the workspace serves ${operation}`, operation } };
  const findings: Finding<UseConsequence>[] = [];
  const cuts: Cut[] = [...session.cuts];
  const queue: Pending[] = [];
  const sites: RepositoryEvidence[] = [];

  const links = session.links
    .filter((link) => link.transport === "http" && link.to.kind === "http-route" && link.to.name === operation)
    .sort((a, b) => compareText(a.from.repo, b.from.repo) || compareText(a.from.file, b.from.file) || a.from.line - b.from.line || compareText(a.id, b.id));
  for (const link of links) {
    const { from, basis } = link;
    const at = { path: from.file, line: from.line };
    sites.push(located(at, from.repo));
    if (QUALIFIED_BASES.has(basis)) {
      queue.push({ carrier: { site: { kind: "call-site", ...from }, path: hypothesis.property }, chain: [{ step: "http-call", evidence: { ...at, via: `basis:${basis}` } }], link, entries: [] });
    } else {
      findings.push(frontierItem({ at, cause: "link-basis", reason: "unresolved", detail: basis, hops: [] }, [], from.repo));
    }
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

  const seen = new Map<string, AccessPath>();
  for (let index = 0; index < queue.length; index++) {
    const { carrier, chain, link, entries } = queue[index]!;
    const repo = link.from.repo;
    const key = `${carrierKey(carrier.site)}\0${canonicalJson(entries)}`;
    const before = seen.get(key);
    if (before !== undefined) {
      if (!samePath(before, carrier.path)) findings.push(frontierItem({ at: placeOf(carrier, chain), cause: "path-conflict", reason: "unresolved", hops: [] }, chain, repo));
      continue;
    }
    seen.set(key, carrier.path);

    const result = read(session, carrier);
    for (const use of result.uses) {
      const verdict = decideUse(use, hypothesis.change);
      if (verdict === undefined) continue;
      const evidence = (verdict.kind === "admits" ? [use.site, verdict.guard.evidence] : [use.site]).map((place) => located(place, repo));
      const value: UseConsequence = {
        repo,
        link: { id: link.id, basis: link.basis, call: { file: link.from.file, line: link.from.line, symbol: link.from.symbol }, handler: { repo: link.to.repo, ...link.to.handler } },
        verdict,
        operation: use.operation,
        path: formatAccessPath(use.path),
        changed: formatAccessPath(use.changed),
        chain: [...chain, ...use.hops],
      };
      findings.push({ status: "complete", evidence, value });
    }
    for (const frontier of result.frontiers) findings.push(frontierItem(frontier, chain, repo));
    for (const next of result.next) {
      const entered = entriesAfter(carrier, next, entries);
      if (entered === "recursion") findings.push(frontierItem({ at: next.hops.at(-1)?.evidence ?? placeOf(carrier, chain), cause: "unmodelled-flow", reason: "unresolved", detail: "recursion", hops: [] }, chain, repo));
      else queue.push({ carrier: next.carrier, chain: [...chain, ...next.hops], link, entries: entered });
    }
    if (carrier.site.kind === "return") {
      const returned = returnsOf(session, carrier.site, carrier.path, chain, entries, result);
      for (const frontier of returned.frontiers) findings.push(frontierItem(frontier, chain, repo));
      queue.push(...returned.next.map((next) => ({ ...next, link })));
    }
  }

  const value: ConsequencesValue = {
    hypothesis: { method: hypothesis.method, path: hypothesis.path, target: hypothesis.target, property: formatAccessPath(hypothesis.property), change: hypothesis.change },
    assumedOldGuarantee: OLD_GUARANTEE,
    findings: findings.sort(compareFindings),
  };
  return { ok: true, value: withCuts({ ...session.base, evidence: sites.sort(compareEvidence) }, value, cuts) };
}

function read(session: ConsumerSession, carrier: Carrier): FlowResult {
  const flow = session.flow.follow(carrier);
  const { site } = carrier;
  if (site.kind !== "member") return flow;
  const template = session.templates.follow({ site, path: carrier.path });
  return { uses: [...flow.uses, ...template.uses], next: [...flow.next, ...template.next], frontiers: [...flow.frontiers, ...template.frontiers] };
}

/**
 * Where a value goes when its function returns it. A value that entered the function through an argument leaves at the
 * result of that very call; any other return continues at the places that depend on the function, each occurrence on its own.
 */
function returnsOf(session: ConsumerSession, site: Extract<CarrierSite, { kind: "return" }>, path: AccessPath, chain: readonly Hop[], entries: readonly Entry[], flowed: FlowResult): { next: Omit<Pending, "link">[]; frontiers: FlowFrontier[] } {
  const declaration = { path: site.file, line: site.line };
  const entry = entries.at(-1);
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
function entriesAfter({ site }: Carrier, { carrier, hops }: FlowNext, entries: readonly Entry[]): readonly Entry[] | "recursion" {
  if (carrier.site.kind === "return" || carrier.site.kind === "call-result") return entries;
  if (carrier.site.kind !== "parameter") return [];
  const call = hops.findLast((hop) => hop.step === "argument");
  if (call === undefined) return [];
  const entry: Entry = { repo: site.repo, at: { path: call.evidence.path, line: call.evidence.line }, callee: { file: carrier.site.file, symbol: carrier.site.symbol, line: carrier.site.line } };
  return entries.some((held) => canonicalJson(held) === canonicalJson(entry)) ? "recursion" : [...entries, entry];
}

function frontierItem(frontier: FlowFrontier, chain: readonly Hop[], repo: string): Finding<UseConsequence> {
  const via = frontier.detail === undefined ? frontier.cause : `${frontier.cause}:${frontier.detail}`;
  return { status: "unknown", reason: frontier.reason, evidence: [...chain, ...frontier.hops].map((hop) => located(hop.evidence, repo)).concat(located({ ...frontier.at, via }, repo)) };
}

function placeOf({ site }: Carrier, chain: readonly Hop[]): Evidence {
  return site.kind === "input" || site.line === undefined ? chain.at(-1)!.evidence : { path: site.file, line: site.line };
}

function samePath(a: AccessPath, b: AccessPath): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function compareEvidence(a: Evidence, b: Evidence): number {
  return compareText(a.path, b.path) || a.line - b.line;
}

function compareFindings(a: Finding<UseConsequence>, b: Finding<UseConsequence>): number {
  const where = (finding: Finding<UseConsequence>) => (finding.status === "complete" ? finding.evidence[0] : finding.evidence.at(-1))!;
  return compareEvidence(where(a), where(b)) || Number(a.status === "unknown") - Number(b.status === "unknown") || compareText(canonicalJson(a), canonicalJson(b));
}
