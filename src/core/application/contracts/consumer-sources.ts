import { sourceUnreadable } from "../../domain/contracts/consumer-flow.ts";
import { formatHypothesis } from "../../domain/contracts/hypothesis.ts";
import { provenanceOf, sortedEngines } from "../../domain/shared/fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CallSite, HttpTarget } from "../../domain/topology/call-site.ts";
import { compositeBase } from "../../domain/topology/composite-inputs.ts";
import type { Link } from "../../domain/topology/link.ts";
import { matchCallSite, type Gateway } from "../../domain/topology/link-match.ts";
import type { AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { InboundOccurrences } from "../impact/inbound-edges.ts";
import type { ConsumerFlowReader } from "../../ports/consumer-flow.port.ts";
import type { ConsumerSession, ConsumerSources } from "../../ports/consumer-sources.port.ts";
import type { ConsumerTemplateReader } from "../../ports/consumer-template.port.ts";
import type { TemplateFlowReader } from "../../ports/consumer-template-flow.port.ts";
import type { WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import { inboundEdgesOf } from "../impact/inbound-origins.ts";
import { memberProofContextOf, referenceProofsOf } from "../impact/reference-origins.ts";
import type { ImportOriginsReader } from "../../ports/import-origins.port.ts";
import { createHeadReader, type HeadReaderDeps } from "../snapshot/head-reading.ts";
import { prepareCommit } from "../snapshot/prepared-snapshot.ts";
import { ABORTED, declaredTrustOf, withScratch } from "../snapshot/read-snapshot.ts";
import type { WorkspaceReadOperation } from "../topology/workspace-operation.ts";
import { entrypointsOf } from "../topology/workspace-join.ts";
import { callersOfFunction } from "./consumer-callers.ts";
import { createConsumerTemplateReader } from "./consumer-templates.ts";

export interface ConsumerSourcesDeps {
  operation: WorkspaceReadOperation;
  heads: HeadReaderDeps;
  digest: Digest;
  /** Reads the TypeScript sources of one repository and follows a value through them. */
  flow(files: readonly SourceFile[], repo: string): Promise<ConsumerFlowReader>;
  metadata: AngularMetadataReader;
  templateFlow: TemplateFlowReader;
  /** The injection and template relations, fields and locals that let the callers of a function see calls made through `inject()`. */
  relations: RelationExtractor;
  /** The engines the analysis reads with beyond those the workspace read names: the code graph and the template compiler. */
  engines: Readonly<Record<string, string>>;
  /** Proves which unresolved references of the code graph are real occurrences; without it no call through an injected field or local is settled. */
  importOrigins?: ImportOriginsReader;
}

interface Reading {
  flow: ConsumerFlowReader;
  templates: ConsumerTemplateReader;
  graph: CodeGraphReader | undefined;
  inbound: InboundOccurrences | undefined;
}

/**
 * The workspace read of a consequences query: the links the join admitted and, for each repository that calls the
 * operation, its sources and code graph, held until the query has answered. A repository read live, or one the refresh
 * could not provide, has no reader, so a carrier in it is a frontier.
 */
export function createConsumerSources(deps: ConsumerSourcesDeps): ConsumerSources {
  const heads = createHeadReader(deps.heads);
  return {
    async withSession(request, use) {
      const { hypothesis, ...planning } = request;
      const operation = `${hypothesis.method} ${hypothesis.path}`;
      const answered = await deps.operation.withRead(planning, async (read, context) => {
        const { fact } = read;
        if (fact.status === "unknown") return { ok: false as const, fault: { kind: "git-failed" as const, detail: "the workspace read answered nothing" } };
        const { links, ambiguousCalls, unresolvedCalls } = httpCallsOf(fact.value.repositories, fact.value.workspace.gateways, operation);
        const serving = fact.value.repositories
          .flatMap((repository) => entrypointsOf(repository).entrypoints.flatMap((entrypoint) => (entrypoint.kind === "http-route" && entrypoint.name === operation ? [{ repo: repository.repo, handler: entrypoint.handler }] : [])))
          .sort((a, b) => compareText(a.repo, b.repo) || compareText(a.handler.path, b.handler.path) || a.handler.line - b.handler.line);
        const callers = new Set(links.filter((link) => isCallOf(link, operation)).map((link) => link.from.repo));

        return withScratch(deps.heads.scratch, async (directory) => {
          const readings = new Map<string, Reading>();
          const stores: CodeGraphReader[] = [];
          try {
            for (const plan of context.plans) {
              if (plan.kind !== "read" || !callers.has(plan.at.repoId)) continue;
              const trust = (await declaredTrustOf(deps.heads, plan.at.declared)) ?? "untrusted";
              const prepared = await prepareCommit({ ...deps.heads, preparation: context.preparation }, plan.at.source, plan.at.revision, directory, context.selection, { scope: context.scope, trust }, context.signal);
              if (!prepared.ok) return prepared;
              const loaded = await prepared.value.sources(context.signal);
              if (!loaded.ok) return loaded;
              const { sources } = loaded.value;
              const indexed = await heads.indexHead(prepared.value.tree, prepared.value.root, directory, context.signal);
              if (indexed === "aborted") return ABORTED;
              if (indexed !== "unavailable") stores.push(indexed.store);
              const origins = indexed === "unavailable" ? undefined : await deps.relations.extract(sources, { memberProofs: memberProofContextOf(loaded.value, context.scope) });
              const proofs = indexed === "unavailable" ? undefined : await referenceProofsOf(deps.importOrigins?.(loaded.value.sources), indexed.store, loaded.value, context.signal);
              readings.set(plan.at.repoId, {
                flow: await deps.flow(sources, plan.at.repoId),
                templates: await createConsumerTemplateReader({ metadata: deps.metadata, flow: deps.templateFlow }, sources),
                graph: indexed === "unavailable" ? undefined : indexed.store,
                inbound: indexed === "unavailable" || origins === undefined ? undefined : inboundEdgesOf(indexed.store, origins, proofs),
              });
            }

            const { schema, snapshot, producer, inputs } = fact;
            const base = compositeBase(
              { schema, snapshot, producer, inputs, evidence: [] },
              Object.entries(fact.value.sections).map(([repo, section]) => ({ kind: `discovery:${repo}`, fact: provenanceOf(section) })),
              fact.value.workspace,
              (text) => deps.digest.of(text),
              { ...inputs.declaredConfig, hypothesis: formatHypothesis(hypothesis) },
            );
            const session: ConsumerSession = {
              base: { ...base, inputs: { ...base.inputs, engines: sortedEngines({ ...base.inputs.engines, ...deps.engines }) } },
              links,
              serving,
              unresolvedCalls,
              ambiguousCalls,
              cuts: fact.status === "partial" ? fact.cuts : [],
              callers: ({ repo, ...declaration }) => {
                const reading = readings.get(repo);
                return callersOfFunction(reading?.graph, reading?.inbound, declaration);
              },
              flow: { follow: (carrier) => readings.get(carrier.site.repo)?.flow.follow(carrier) ?? sourceUnreadable(carrier.site) },
              templates: { follow: (carrier) => readings.get(carrier.site.repo)?.templates.follow(carrier) ?? sourceUnreadable(carrier.site) },
            };
            return { ok: true, value: await use(session) };
          } finally {
            for (const store of stores) store.close();
          }
        });
      });
      return answered.ok ? { ok: true, value: answered.value.value } : answered;
    },
  };
}

/**
 * The HTTP call sites of the workspace decided once each, against the routes of every repository including their own: the
 * links they make, the call sites that reach the operation in more than one repository, and those whose target no read
 * could evaluate. A call site two repositories serve equally is ambiguous, never linked to its own.
 */
function httpCallsOf(repositories: readonly WorkspaceRepository[], gateways: readonly Gateway[], operation: string): Pick<ConsumerSession, "links" | "ambiguousCalls" | "unresolvedCalls"> {
  const entrypoints = repositories.map(entrypointsOf);
  const links = new Map<string, Link>();
  const ambiguousCalls: ConsumerSession["ambiguousCalls"][number][] = [];
  const unresolvedCalls: ConsumerSession["unresolvedCalls"][number][] = [];
  for (const site of repositories.flatMap((repository) => repository.callSites)) {
    if (site.transport !== "http") continue;
    const target = httpTargetOf(site);
    const from = { repo: site.repo, file: site.file, line: site.line, symbol: site.symbol };
    if (target === undefined) {
      if (site.target.status === "unknown") unresolvedCalls.push({ repo: site.repo, file: site.file, line: site.line, symbol: site.symbol });
      continue;
    }
    const joined = matchCallSite(site, target, entrypoints, gateways);
    for (const link of joined.links ?? []) links.set(link.id, link);
    const repos = joined.ambiguous?.repos.toSorted(compareText);
    if (repos !== undefined && repos.some((repo) => matchCallSite(site, target, entrypoints.filter((candidate) => candidate.repo === repo), gateways).links?.some((link) => isCallOf(link, operation)))) ambiguousCalls.push({ from, repos });
  }
  const byPlace = (a: { repo: string; file: string; line: number }, b: { repo: string; file: string; line: number }) => compareText(a.repo, b.repo) || compareText(a.file, b.file) || a.line - b.line;
  return {
    links: [...links.values()].sort((a, b) => compareText(a.id, b.id)),
    ambiguousCalls: ambiguousCalls.sort((a, b) => byPlace(a.from, b.from)),
    unresolvedCalls: unresolvedCalls.sort(byPlace),
  };
}

function httpTargetOf(site: CallSite): HttpTarget | undefined {
  return site.transport === "http" && site.target.status === "complete" && "path" in site.target.value ? site.target.value : undefined;
}

export function isCallOf(link: Link, operation: string): boolean {
  return link.transport === "http" && link.to.kind === "http-route" && link.to.name === operation;
}
