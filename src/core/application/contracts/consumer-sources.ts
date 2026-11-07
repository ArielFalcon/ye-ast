import { sourceUnreadable } from "../../domain/contracts/consumer-flow.ts";
import type { Hypothesis } from "../../domain/contracts/hypothesis.ts";
import { provenanceOf, sortedEngines } from "../../domain/shared/fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Result } from "../../domain/shared/result.ts";
import { callPlaceOf, compareCallPlaces, httpTargetOf } from "../../domain/topology/call-site.ts";
import { compositeBase } from "../../domain/topology/composite-inputs.ts";
import type { Link } from "../../domain/topology/link.ts";
import { matchCallSite, matchDeclaredOperation, type Gateway, type RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
import type { AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { InboundOccurrences } from "../impact/inbound-edges.ts";
import type { ConsumerFlowReader } from "../../ports/consumer-flow.port.ts";
import type { RequestOriginReader } from "../../ports/request-origins.port.ts";
import type { ConsumerSession, ConsumerSources, PreparedWorkspace, ServingOperation } from "../../ports/consumer-sources.port.ts";
import type { ConsumerTemplateReader } from "../../ports/consumer-template.port.ts";
import type { TemplateFlowReader } from "../../ports/consumer-template-flow.port.ts";
import type { WorkspaceFault, WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import { inboundEdgesOf, receiverSettlementsOf } from "../impact/inbound-origins.ts";
import { createEdgeTargets, syntaxOfSources } from "../navigation/edge-targets.ts";
import { referenceProofsOf } from "../impact/reference-origins.ts";
import { memberProofContextOf } from "../relations/retained-relations.ts";
import type { ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { createHeadReader, type HeadReaderDeps } from "../snapshot/head-reading.ts";
import { prepareCommit } from "../snapshot/prepared-snapshot.ts";
import { ABORTED, declaredTrustOf, withScratch } from "../snapshot/read-snapshot.ts";
import type { WorkspaceReadOperation } from "../topology/workspace-operation.ts";
import type { WorkspaceSnapshotContext } from "../topology/workspace-snapshots.ts";
import { httpRouteName, type Handler, type HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { entrypointsOf } from "../topology/workspace-join.ts";
import { callersOfFunction, occurrencesOfMember } from "./consumer-callers.ts";
import { createConsumerTemplateReader } from "./consumer-templates.ts";

export interface ConsumerSourcesDeps {
  operation: WorkspaceReadOperation;
  heads: HeadReaderDeps;
  digest: Digest;
  /** Reads the TypeScript sources of one repository and follows a value through them. */
  flow(files: readonly SourceFile[], repo: string): Promise<ConsumerFlowReader>;
  /** Reads the TypeScript sources of one repository and follows a request body back to what builds it. */
  origins(files: readonly SourceFile[]): RequestOriginReader;
  metadata: AngularMetadataReader;
  templateFlow: TemplateFlowReader;
  /** The injection and template relations, fields and locals that let the callers of a function see calls made through `inject()`. */
  relations: RelationExtractor;
  /** The engines the analysis reads with beyond those the workspace read names: the code graph and the template compiler. */
  engines: Readonly<Record<string, string>>;
  /** Proves which unresolved references of the code graph are real occurrences; without it no call through an injected field or local is settled. */
  importOrigins?: ImportOriginsReader;
  /** What a source's syntax states; without it no call on a value receiver is settled, and each stays as the graph resolved it. */
  memberNames?: DeclaredMemberNamesReader;
  /** The TypeScript module statements that bind a receiver's declared type to its declaration. */
  modules?: ModuleDependenciesReader;
}

type ReadPlan = Extract<WorkspaceSnapshotContext["plans"][number], { kind: "read" }>;

interface Reading {
  flow: ConsumerFlowReader;
  origins: RequestOriginReader;
  templates: ConsumerTemplateReader;
  graph: CodeGraphReader | undefined;
  inbound: InboundOccurrences | undefined;
}

/**
 * The workspace read of consequences queries: for a set of hypotheses, the repositories' sources and code graphs held
 * until the holder of the workspace answers, the fact envelope of what was asked, and for each hypothesis the links the join
 * admitted. A repository read live, or one the refresh could not provide, has no reader, so a carrier in it is a frontier.
 */
export function createConsumerSources(deps: ConsumerSourcesDeps): ConsumerSources {
  const heads = createHeadReader(deps.heads);
  return {
    async withWorkspace(request, use) {
      const answered = await deps.operation.withRead(request, async (read, context) => {
        const { fact } = read;
        if (fact.status === "unknown") return { ok: false as const, fault: { kind: "git-failed" as const, detail: "the workspace read answered nothing" } };

        return withScratch(deps.heads.scratch, async (directory) => {
          const readings = new Map<string, Promise<Result<Reading, WorkspaceFault>>>();
          const stores: CodeGraphReader[] = [];
          let workspaceJoin: WorkspaceHttpJoin | undefined;
          let routes: RepositoryEntrypoints[] | undefined;
          const entrypointsOfWorkspace = (): RepositoryEntrypoints[] => (routes ??= fact.value.repositories.map(entrypointsOf));

          const readRepository = async (plan: ReadPlan): Promise<Result<Reading, WorkspaceFault>> => {
            const trust = (await declaredTrustOf(deps.heads, plan.at.declared)) ?? "untrusted";
            const prepared = await prepareCommit({ ...deps.heads, preparation: context.preparation }, plan.at.source, plan.at.revision, directory, context.selection, { scope: context.scope, trust }, context.signal);
            if (!prepared.ok) return prepared;
            const loaded = await prepared.value.sources(context.signal);
            if (!loaded.ok) return loaded;
            const { sources } = loaded.value;
            const indexed = await heads.indexHead(prepared.value, directory, context.signal);
            if (indexed === "aborted") return ABORTED;
            if (indexed !== "unavailable" && "fault" in indexed) return { ok: false, fault: indexed.fault };
            if (indexed !== "unavailable") stores.push(indexed.store);
            const origins = indexed === "unavailable" ? undefined : await deps.relations.extract(sources, { memberProofs: memberProofContextOf(loaded.value, context.scope) });
            const importOrigins = deps.importOrigins?.(sources, undefined, prepared.value.facts);
            const proofs = indexed === "unavailable" ? undefined : await referenceProofsOf(importOrigins, indexed.store, loaded.value, context.signal);
            const settled = indexed === "unavailable" || origins === undefined || importOrigins === undefined
              ? undefined
              : await receiverSettlementsOf(indexed.store, createEdgeTargets({ origins: importOrigins, store: indexed.store, modules: deps.modules === undefined ? undefined : { reader: deps.modules, sources }, syntaxOf: syntaxOfSources(deps.memberNames, sources), proofs: async () => origins }), sources.map((file) => file.path), context.signal);
            if (context.signal?.aborted) return ABORTED;
            return {
              ok: true,
              value: {
                flow: await deps.flow(sources, plan.at.repoId),
                origins: deps.origins(sources),
                templates: await createConsumerTemplateReader({ metadata: deps.metadata, flow: deps.templateFlow }, sources),
                graph: indexed === "unavailable" ? undefined : indexed.store,
                inbound: indexed === "unavailable" || origins === undefined ? undefined : inboundEdgesOf(indexed.store, origins, proofs, settled === undefined ? undefined : { dropped: new Set(), into: new Map(), settled }),
              },
            };
          };

          /** A repository is read once, by whichever session asks first; a session that asks meanwhile waits for that reading, and a failed reading is made again by the next. */
          const readingOf = (plan: ReadPlan): Promise<Result<Reading, WorkspaceFault>> => {
            const held = readings.get(plan.at.repoId);
            if (held !== undefined) return held;
            const reading = readRepository(plan).then((result) => {
              if (!result.ok) readings.delete(plan.at.repoId);
              return result;
            });
            readings.set(plan.at.repoId, reading);
            return reading;
          };

          const session = async (hypothesis: Hypothesis): Promise<Result<ConsumerSession, WorkspaceFault>> => {
            const operation = httpRouteName({ method: hypothesis.method, path: hypothesis.path });
            const join = (workspaceJoin ??= joinHttpCalls(fact.value.repositories, entrypointsOfWorkspace(), fact.value.workspace.gateways));
            const callers = new Set(join.links.filter((link) => isCallOf(link, operation)).map((link) => link.from.repo));

            const reached = new Map<string, Reading>();
            for (const plan of context.plans) {
              if (plan.kind !== "read" || !callers.has(plan.at.repoId)) continue;
              const reading = await readingOf(plan);
              if (!reading.ok) return reading;
              reached.set(plan.at.repoId, reading.value);
            }

            return {
              ok: true,
              value: {
                links: join.links,
                serving: join.serving.get(operation) ?? [],
                unresolvedCalls: join.unresolvedCalls,
                ambiguousCalls: join.ambiguousCalls.filter((call) => call.reaching.has(operation)).map(({ from, repos }) => ({ from, repos })),
                callers: ({ repo, ...declaration }) => {
                  const reading = reached.get(repo);
                  return callersOfFunction(reading?.graph, reading?.inbound, declaration);
                },
                memberOccurrences: ({ repo, ...member }) => {
                  const reading = reached.get(repo);
                  return occurrencesOfMember(reading?.graph, reading?.inbound, member);
                },
                flow: { follow: (carrier) => reached.get(carrier.site.repo)?.flow.follow(carrier) ?? sourceUnreadable(carrier.site) },
                templates: { follow: (carrier) => reached.get(carrier.site.repo)?.templates.follow(carrier) ?? sourceUnreadable(carrier.site) },
                requestOrigins: (repo) => reached.get(repo)?.origins,
              },
            };
          };
          const base: PreparedWorkspace["base"] = (asked) => {
            const { schema, snapshot, producer, inputs } = fact;
            const composite = compositeBase(
              { schema, snapshot, producer, inputs, evidence: [] },
              Object.entries(fact.value.sections).map(([repo, section]) => ({ kind: `discovery:${repo}`, fact: provenanceOf(section) })),
              fact.value.workspace,
              (text) => deps.digest.of(text),
              { ...inputs.declaredConfig, ...asked },
            );
            return { ...composite, inputs: { ...composite.inputs, engines: sortedEngines({ ...composite.inputs.engines, ...deps.engines }) } };
          };
          try {
            return { ok: true, value: await use({ base, repositorySnapshots: fact.value.repositorySnapshots, cuts: fact.status === "partial" ? fact.cuts : [], session, serving: (declared) => servingOperation(declared, entrypointsOfWorkspace()) }) };
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
 * What the workspace says about HTTP whatever the hypothesis, decided once: the links its call sites make, the call sites
 * no read could evaluate, the call sites two repositories serve equally with the operations each candidate would link
 * them to, and the handlers each operation has. A hypothesis only selects from it.
 */
interface WorkspaceHttpJoin {
  links: readonly Link[];
  unresolvedCalls: ConsumerSession["unresolvedCalls"];
  ambiguousCalls: readonly (ConsumerSession["ambiguousCalls"][number] & { reaching: ReadonlySet<string> })[];
  serving: ReadonlyMap<string, ConsumerSession["serving"]>;
}

/**
 * The HTTP call sites of the workspace decided once each, against the routes of every repository including their own. A
 * call site two repositories serve equally is ambiguous, never linked to its own.
 */
function joinHttpCalls(repositories: readonly WorkspaceRepository[], entrypoints: readonly RepositoryEntrypoints[], gateways: readonly Gateway[]): WorkspaceHttpJoin {
  const links = new Map<string, Link>();
  const ambiguousCalls: WorkspaceHttpJoin["ambiguousCalls"][number][] = [];
  const unresolvedCalls: ConsumerSession["unresolvedCalls"][number][] = [];
  for (const site of repositories.flatMap((repository) => repository.callSites)) {
    if (site.transport !== "http") continue;
    const target = httpTargetOf(site);
    const from = callPlaceOf(site);
    if (target === undefined) {
      if (site.target.status === "unknown") unresolvedCalls.push(from);
      continue;
    }
    const joined = matchCallSite(site, target, entrypoints, gateways);
    for (const link of joined.links ?? []) links.set(link.id, link);
    if (joined.ambiguous === undefined) continue;
    ambiguousCalls.push({ from, repos: joined.ambiguous.repos.toSorted(compareText), reaching: new Set(joined.ambiguous.routes) });
  }
  const serving = new Map<string, { repo: string; handler: Handler }[]>();
  for (const { repo, entrypoints: routes } of entrypoints) {
    for (const entrypoint of routes) {
      if (entrypoint.kind === "http-route") serving.set(entrypoint.name, [...(serving.get(entrypoint.name) ?? []), { repo, handler: entrypoint.handler }]);
    }
  }
  for (const handlers of serving.values()) handlers.sort((a, b) => compareText(a.repo, b.repo) || compareText(a.handler.path, b.handler.path) || a.handler.line - b.handler.line);
  return {
    links: [...links.values()].sort((a, b) => compareText(a.id, b.id)),
    unresolvedCalls: unresolvedCalls.sort(compareCallPlaces),
    ambiguousCalls: ambiguousCalls.sort((a, b) => compareCallPlaces(a.from, b.from)),
    serving,
  };
}

function servingOperation(declared: { method: HttpMethod; path: string }, entrypoints: readonly RepositoryEntrypoints[]): ServingOperation {
  const matched = matchDeclaredOperation(declared, entrypoints);
  if (matched === undefined) return { kind: "unserved" };
  if ("ambiguous" in matched) return { kind: "ambiguous", repos: matched.ambiguous };
  return { kind: "served", method: matched.route.method, path: matched.route.path };
}

function reachedRouteName(link: Link): string | undefined {
  return link.transport === "http" && link.to.kind === "http-route" ? link.to.name : undefined;
}

export function isCallOf(link: Link, operation: string): boolean {
  return reachedRouteName(link) === operation;
}
