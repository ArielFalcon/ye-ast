import { formatAccessPath, type AccessPath } from "../../domain/contracts/access-path.ts";
import { OLD_GUARANTEE, type UseConsequence } from "../../domain/contracts/consequence-fact.ts";
import { carrierKey, type Carrier, type FlowFrontier, type FlowResult, type Hop } from "../../domain/contracts/consumer-flow.ts";
import { parseHypothesis, type Hypothesis } from "../../domain/contracts/hypothesis.ts";
import { decideUse } from "../../domain/contracts/verdict.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { withCuts, type Cut, type Evidence, type Fact, type Finding } from "../../domain/shared/fact.ts";
import type { LinkBasis } from "../../domain/topology/link.ts";
import type { ConsumerQueries } from "../../ports/consumer-queries.port.ts";
import type { ConsumerSession, ConsumerSources } from "../../ports/consumer-sources.port.ts";
import type { ConsequencesValue } from "../../domain/contracts/consequence-fact.ts";

/** The bases that say the call reaches this operation; the others say it may, and are reported where they stop. */
const QUALIFIED_BASES: ReadonlySet<LinkBasis> = new Set(["exact", "base-path", "operation-id"]);

export interface ConsumerQueriesDeps {
  sources: ConsumerSources;
}

interface Pending {
  carrier: Carrier;
  chain: readonly Hop[];
}

export function createConsumerQueries({ sources }: ConsumerQueriesDeps): ConsumerQueries {
  return {
    async consequences(request) {
      const parsed = parseHypothesis(request.hypothesis);
      if (!parsed.ok) return { ok: false, fault: { kind: "invalid-hypothesis", detail: parsed.fault.detail, refusal: parsed.fault } };
      const hypothesis = parsed.value;
      return sources.withSession({ ...request, hypothesis }, async (session) => consequencesOf(session, hypothesis));
    },
  };
}

function consequencesOf(session: ConsumerSession, hypothesis: Hypothesis): Fact<ConsequencesValue> {
  const operation = `${hypothesis.method} ${hypothesis.path}`;
  const findings: Finding<UseConsequence>[] = [];
  const cuts: Cut[] = [...session.cuts];
  const queue: Pending[] = [];
  const sites: Evidence[] = [];

  const links = session.links
    .filter((link) => link.transport === "http" && link.to.kind === "http-route" && link.to.name === operation)
    .sort((a, b) => compareText(a.from.repo, b.from.repo) || compareText(a.from.file, b.from.file) || a.from.line - b.from.line || compareText(a.id, b.id));
  for (const { from, basis } of links) {
    const at = { path: from.file, line: from.line };
    sites.push(at);
    if (QUALIFIED_BASES.has(basis)) {
      queue.push({ carrier: { site: { kind: "call-site", ...from }, path: hypothesis.property }, chain: [{ step: "http-call", evidence: { ...at, via: `basis:${basis}` } }] });
    } else {
      findings.push(frontierItem({ at, cause: "link-basis", reason: "unresolved", detail: basis, hops: [] }, []));
    }
  }

  const seen = new Map<string, AccessPath>();
  for (let index = 0; index < queue.length; index++) {
    const { carrier, chain } = queue[index]!;
    const key = carrierKey(carrier.site);
    const before = seen.get(key);
    if (before !== undefined) {
      if (!samePath(before, carrier.path)) findings.push(frontierItem({ at: placeOf(carrier), cause: "path-conflict", reason: "unresolved", hops: [] }, chain));
      continue;
    }
    seen.set(key, carrier.path);

    const result = read(session, carrier);
    for (const use of result.uses) {
      const verdict = decideUse(use, hypothesis.change);
      if (verdict === undefined) continue;
      const evidence = verdict.kind === "admits" ? [use.site, verdict.guard.evidence] : [use.site];
      findings.push({ status: "complete", evidence, value: { verdict, operation: use.operation, path: formatAccessPath(use.path), changed: formatAccessPath(use.changed), chain: [...chain, ...use.hops] } });
    }
    for (const frontier of result.frontiers) findings.push(frontierItem(frontier, chain));
    for (const next of result.next) queue.push({ carrier: next.carrier, chain: [...chain, ...next.hops] });
    if (carrier.site.kind === "return") {
      const callers = callersOf(session, carrier, chain, result.next.length > 0);
      findings.push(...callers.frontiers);
      queue.push(...callers.next);
    }
  }

  const value: ConsequencesValue = {
    hypothesis: { method: hypothesis.method, path: hypothesis.path, target: hypothesis.target, property: formatAccessPath(hypothesis.property), change: hypothesis.change },
    assumedOldGuarantee: OLD_GUARANTEE,
    findings: findings.sort(compareFindings),
  };
  return withCuts({ ...session.base, evidence: sites.sort(compareEvidence) }, value, cuts);
}

function read(session: ConsumerSession, carrier: Carrier): FlowResult {
  const flow = session.flow.follow(carrier);
  const { site } = carrier;
  if (site.kind !== "member") return flow;
  const template = session.templates.follow({ site, path: carrier.path });
  return { uses: [...flow.uses, ...template.uses], next: [...flow.next, ...template.next], frontiers: [...flow.frontiers, ...template.frontiers] };
}

/** The resolved callers of the function a return carrier belongs to; every other outcome is a frontier at the function. */
function callersOf(session: ConsumerSession, carrier: Carrier, chain: readonly Hop[], continuesElsewhere: boolean): { next: Pending[]; frontiers: Finding<UseConsequence>[] } {
  const { site } = carrier;
  if (site.kind !== "return") return { next: [], frontiers: [] };
  const declaration = { path: site.file, line: site.line };
  const stop = (frontier: FlowFrontier) => ({ next: [], frontiers: [frontierItem(frontier, chain)] });
  const graph = session.graph(site.repo);
  if (graph === undefined) return stop({ at: declaration, cause: "graph-unavailable", reason: "index-unavailable", hops: [] });
  const symbol = graph
    .symbolsInFiles([site.file])
    .filter((candidate) => candidate.name === site.symbol && candidate.startLine <= site.line && site.line <= candidate.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (symbol === undefined) return stop({ at: declaration, cause: "unresolved-caller", reason: "unresolved", hops: [] });

  const edges = graph.incomingEdges([symbol.id], ["calls"]);
  if (edges.length === 0) return continuesElsewhere ? { next: [], frontiers: [] } : stop({ at: declaration, cause: "no-caller", reason: "unresolved", hops: [] });

  const callers = new Map(graph.symbolsByIds(edges.map((edge) => edge.source)).map((caller) => [caller.id, caller]));
  const next: Pending[] = [];
  const frontiers: Finding<UseConsequence>[] = [];
  for (const edge of edges) {
    const caller = callers.get(edge.source);
    const at = { path: caller?.file ?? site.file, line: edge.line ?? caller?.startLine ?? site.line };
    if (caller === undefined || edge.line === null) {
      frontiers.push(frontierItem({ at, cause: "unresolved-caller", reason: "unresolved", hops: [] }, chain));
    } else if (edge.provenance === "heuristic") {
      frontiers.push(frontierItem({ at, cause: "ambiguous-caller", reason: "unresolved", hops: [] }, chain));
    } else {
      const call = { kind: "call-result" as const, repo: site.repo, file: caller.file, line: edge.line, ...(edge.column === null ? {} : { column: edge.column }) };
      next.push({ carrier: { site: call, path: carrier.path }, chain: [...chain, { step: "caller", evidence: at }] });
    }
  }
  return { next, frontiers };
}

function frontierItem(frontier: FlowFrontier, chain: readonly Hop[]): Finding<UseConsequence> {
  const via = frontier.detail === undefined ? frontier.cause : `${frontier.cause}:${frontier.detail}`;
  return { status: "unknown", reason: frontier.reason, evidence: [...chain, ...frontier.hops].map((hop) => hop.evidence).concat({ ...frontier.at, via }) };
}

function placeOf({ site }: Carrier): Evidence {
  return { path: site.file, line: site.line };
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
