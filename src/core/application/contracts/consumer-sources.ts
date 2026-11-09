import { sourceUnreadable } from "../../domain/contracts/consumer-flow.ts";
import type { Hypothesis } from "../../domain/contracts/hypothesis.ts";
import { provenanceOf, sortedEngines, type BuildOutputInput, type Cut } from "../../domain/shared/fact.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { nameTail } from "../../domain/shared/call-place.ts";
import { contradictedCallCuts } from "../../domain/impact/impact-cuts.ts";
import { followedEdge } from "../../domain/impact/edge-policy.ts";
import type { Result } from "../../domain/shared/result.ts";
import { callPlaceOf, compareCallPlaces, httpTargetOf } from "../../domain/topology/call-site.ts";
import { compositeBase } from "../../domain/topology/composite-inputs.ts";
import type { Link } from "../../domain/topology/link.ts";
import { excludedFrom, matchCallSite, matchDeclaredOperation, type Gateway, type RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
import type { AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import { buildOutputCuts, type DeclaredBuildOutput } from "../../domain/shared/build-outputs.ts";
import { compareOccurrences, occurrenceKey, type InboundOccurrence, type InboundOccurrences } from "../impact/inbound-edges.ts";
import type { ConsumerFlowReader } from "../../ports/consumer-flow.port.ts";
import type { RequestOriginReader } from "../../ports/request-origins.port.ts";
import type { ConsumerSession, ConsumerSources, PreparedWorkspace, ServingOperation } from "../../ports/consumer-sources.port.ts";
import type { ConsumerTemplateReader } from "../../ports/consumer-template.port.ts";
import type { TemplateFlowReader } from "../../ports/consumer-template-flow.port.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import type { TypeBindings } from "../../ports/type-bindings.port.ts";
import type { WorkspaceFault, WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import { inboundEdgesOf, receiverCorrectionsOf } from "../impact/inbound-origins.ts";
import { createBaseReadings, withOutputs, type BaseReading, type ContradictedCall } from "../snapshot/base-reading.ts";
import type { EdgeTargets } from "../navigation/edge-targets.ts";
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
  /** The module statements of every language that bind a receiver's declared type to its declaration. */
  modules?: ModuleDependenciesReader;
  /** What the type checker binds over the declared build outputs; without it no call on a value receiver is typed. */
  typeBindings?: TypeBindings;
  /** The lockfiles and declaration files a commit's typed pass reads beside its sources. */
  checkerInputs?: RevisionSources;
  /** The build outputs a host declared for a repository at a root. */
  declaredOutputs?: (repo: string) => readonly DeclaredBuildOutput[] | undefined;
}

type ReadPlan = Extract<WorkspaceSnapshotContext["plans"][number], { kind: "read" }>;

interface Reading {
  flow: ConsumerFlowReader;
  origins: RequestOriginReader;
  templates: ConsumerTemplateReader;
  graph: CodeGraphReader | undefined;
  inbound: InboundOccurrences | undefined;
  reading: BaseReading | undefined;
  targets: EdgeTargets | undefined;
  cuts: readonly Cut[];
  contradictions: readonly ContradictedCall[];
}

/** The declarations of one operation a contradicted record may name to stand on its frontier: its call sites, and the callers walked from them. */
interface Frontier {
  files: Set<string>;
  declarations: Set<string>;
  /** The `file:name` pairs of a member occurrence query, which names no declaration the graph places. */
  members: Set<string>;
}

function frontierOf(operation: string, links: readonly Link[], reached: ReadonlyMap<string, Reading>): Map<string, Frontier> {
  const frontiers = new Map<string, Frontier>();
  for (const link of links.filter((candidate) => isCallOf(candidate, operation))) {
    const frontier = frontierFor(frontiers, link.from.repo);
    frontier.files.add(link.from.file);
    for (const node of declarationOf(reached.get(link.from.repo)?.graph, link.from)) {
      frontier.files.add(node.file);
      frontier.declarations.add(node.id);
    }
  }
  return frontiers;
}

function frontierFor(frontiers: Map<string, Frontier>, repo: string): Frontier {
  let frontier = frontiers.get(repo);
  if (frontier === undefined) {
    frontier = { files: new Set(), declarations: new Set(), members: new Set() };
    frontiers.set(repo, frontier);
  }
  return frontier;
}

function askFrontier(frontiers: Map<string, Frontier>, repo: string, graph: CodeGraphReader | undefined, declaration: { file: string; symbol: string; line: number }): void {
  const frontier = frontierFor(frontiers, repo);
  frontier.files.add(declaration.file);
  for (const node of declarationOf(graph, declaration)) {
    frontier.files.add(node.file);
    frontier.declarations.add(node.id);
  }
}

function askMemberFrontier(frontiers: Map<string, Frontier>, repo: string, member: { file: string; owner: string; member: string }): void {
  const frontier = frontierFor(frontiers, repo);
  frontier.files.add(member.file);
  frontier.members.add(`${member.file}:${member.owner}`);
  frontier.members.add(`${member.file}:${member.member}`);
}

function onFrontier({ record, target }: ContradictedCall, repo: string, frontiers: ReadonlyMap<string, Frontier>): boolean {
  const frontier = frontiers.get(repo);
  if (frontier === undefined) return false;
  return frontier.files.has(record.file) || frontier.declarations.has(record.from) || frontier.declarations.has(target.id) || frontier.members.has(`${target.file}:${target.name}`);
}

/**
 * The workspace read of consequences queries: for a set of hypotheses, the repositories' sources and code graphs held
 * until the holder of the workspace answers, the fact envelope of what was asked, and for each hypothesis the links the join
 * admitted. A repository read live, or one the refresh could not provide, has no reader, so a carrier in it is a frontier.
 */
export function createConsumerSources(deps: ConsumerSourcesDeps): ConsumerSources {
  const heads = createHeadReader(deps.heads);
  const line = createBaseReadings(deps);
  return {
    async withWorkspace(request, use) {
      const answered = await deps.operation.withRead(request, async (read, context) => {
        const { fact } = read;
        if (fact.status === "unknown") return { ok: false as const, fault: { kind: "git-failed" as const, detail: "the workspace read answered nothing" } };

        return withScratch(deps.heads, async (readScope) => {
          const readings = new Map<string, Promise<Result<Reading, WorkspaceFault>>>();
          const buildOutputs = new Map<string, BuildOutputInput>();
          const stores: CodeGraphReader[] = [];
          let workspaceJoin: WorkspaceHttpJoin | undefined;
          let routes: RepositoryEntrypoints[] | undefined;
          const entrypointsOfWorkspace = (): RepositoryEntrypoints[] => (routes ??= fact.value.repositories.map(entrypointsOf));

          const readRepository = async (plan: ReadPlan): Promise<Result<Reading, WorkspaceFault>> => {
            const trust = (await declaredTrustOf(deps.heads, plan.at.declared)) ?? "untrusted";
            const prepared = await prepareCommit({ ...deps.heads, preparation: context.preparation }, plan.at.source, plan.at.revision, readScope, context.selection, { scope: context.scope, trust }, context.signal);
            if (!prepared.ok) return prepared;
            const loaded = await prepared.value.sources(context.signal);
            if (!loaded.ok) return loaded;
            const { sources } = loaded.value;
            const indexed = await heads.indexHead(prepared.value, readScope.directory, context.signal);
            if (indexed === "aborted") return ABORTED;
            if (indexed !== "unavailable" && "fault" in indexed) return { ok: false, fault: indexed.fault };
            if (indexed !== "unavailable") stores.push(indexed.store);
            const reading = indexed === "unavailable"
              ? undefined
              : line.of(
                  { tree: loaded.value, prepared: prepared.value, hold: readScope.hold, store: indexed.store, digest: indexed.digest, snapshot: { repo: plan.at.repoId, kind: "sha", sha: plan.at.revision }, request: { repo: plan.at.source, scope: context.scope, ...(context.signal === undefined ? {} : { signal: context.signal }) } },
                );
            const typed = await reading?.typed();
            if (typed === "aborted") return ABORTED;
            const origins = await reading?.relations();
            const proofs = await reading?.referenceProofs();
            const targets = reading?.edgeTargets(typed?.typed);
            const contradictions = reading === undefined || targets === undefined ? undefined : reading.contradictedCalls(targets);
            const corrections = indexed === "unavailable" || origins === undefined || targets === undefined ? undefined : await receiverCorrectionsOf(indexed.store, targets, origins, sources.map((file) => file.path), context.signal, contradictions);
            if (context.signal?.aborted) return ABORTED;
            const typedCuts = typed === undefined ? [] : [...typed.inputsLeftOut, ...buildOutputCuts(typed.buildOutputs)];
            if (typed !== undefined) for (const output of typed.outputs ?? []) buildOutputs.set(canonicalJson(output), output);
            return {
              ok: true,
              value: {
                flow: await deps.flow(sources, plan.at.repoId),
                origins: deps.origins(sources),
                templates: await createConsumerTemplateReader({ metadata: deps.metadata, flow: deps.templateFlow }, sources),
                graph: indexed === "unavailable" ? undefined : indexed.store,
                inbound: indexed === "unavailable" || origins === undefined ? undefined : inboundEdgesOf(indexed.store, origins, proofs, corrections),
                reading,
                targets,
                cuts: typedCuts,
                contradictions: corrections?.contradictions ?? [],
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

          /**
           * The written calls the index records nothing of that reach the declarations the join's links write in, one pass
           * over the repositories the hypothesis reached (ADR-0045 L2): a contract answer is a frontier, not a transitive
           * walk, and each repository's occurrences stay its own.
           */
          const recoveredInto = async (reached: ReadonlyMap<string, Reading>, links: readonly Link[]): Promise<ReadonlyMap<string, ReadonlyMap<string, readonly InboundOccurrence[]>>> => {
            const found = new Map<string, Map<string, InboundOccurrence[]>>();
            for (const [repo, reading] of reached) {
              const reverse = reading.reading === undefined || reading.targets === undefined ? undefined : reading.reading.reverseCalls(reading.targets);
              if (reverse === undefined) continue;
              const nodes = [...new Map(links.filter((link) => link.from.repo === repo).flatMap((link) => declarationOf(reading.graph, link.from)).map((node) => [node.id, node])).values()];
              if (nodes.length === 0) continue;
              const into = new Map<string, InboundOccurrence[]>();
              for (const { edge, source, target } of (await reverse.into(nodes)).edges) {
                const occurrence: InboundOccurrence = { from: source, basis: "call", ...followedEdge(edge, "proven"), provenance: edge.provenance, ...(edge.line === null ? {} : { line: edge.line }) };
                into.set(target.id, [...(into.get(target.id) ?? []), occurrence]);
              }
              found.set(repo, into);
            }
            return found;
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

            const recovered = await recoveredInto(reached, join.links.filter((link) => isCallOf(link, operation)));
            const frontiers = frontierOf(operation, join.links, reached);
            const cuts = (): readonly Cut[] => [...contradictedCallCuts([...reached].flatMap(([repo, reading]) => reading.contradictions.filter((call) => onFrontier(call, repo, frontiers)))), ...[...reached.values()].flatMap((reading) => reading.cuts)];
            const inboundOf = (repo: string, reading: Reading | undefined): InboundOccurrences | undefined => {
              if (reading?.inbound === undefined) return undefined;
              const inbound = reading.inbound;
              const recoveredHere = recovered.get(repo);
              return {
                occurrencesOf: (node) => {
                  const merged = new Map<string, InboundOccurrence>();
                  for (const occurrence of [...inbound.occurrencesOf(node), ...(recoveredHere?.get(node.id) ?? [])]) {
                    const key = occurrenceKey(occurrence);
                    if (!merged.has(key)) merged.set(key, occurrence);
                  }
                  return [...merged.values()].sort(compareOccurrences);
                },
              };
            };

            return {
              ok: true,
              value: {
                links: join.links,
                serving: join.serving.get(operation) ?? [],
                cutsAfterWalk: cuts,
                unresolvedCalls: join.unresolvedCalls,
                ambiguousCalls: join.ambiguousCalls.filter((call) => call.reaching.has(operation)).map(({ from, repos }) => ({ from, repos })),
                callers: ({ repo, ...declaration }) => {
                  const reading = reached.get(repo);
                  askFrontier(frontiers, repo, reading?.graph, declaration);
                  const answer = callersOfFunction(reading?.graph, inboundOf(repo, reading), declaration);
                  if (answer.kind === "found") for (const caller of answer.callers) frontierFor(frontiers, repo).files.add(caller.file);
                  return answer;
                },
                memberOccurrences: ({ repo, ...member }) => {
                  const reading = reached.get(repo);
                  askMemberFrontier(frontiers, repo, member);
                  return occurrencesOfMember(reading?.graph, inboundOf(repo, reading), member);
                },
                flow: { follow: (carrier) => reached.get(carrier.site.repo)?.flow.follow(carrier) ?? sourceUnreadable(carrier.site) },
                templates: { follow: (carrier) => reached.get(carrier.site.repo)?.templates.follow(carrier) ?? sourceUnreadable(carrier.site) },
                requestOrigins: (repo) => reached.get(repo)?.origins,
                excludes: excludedFrom(operation, entrypointsOfWorkspace(), fact.value.workspace.gateways),
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
            const read = buildOutputs.size === 0 ? composite : withOutputs(composite, [...buildOutputs.values()]);
            return { ...read, inputs: { ...read.inputs, engines: sortedEngines({ ...read.inputs.engines, ...deps.engines }) } };
          };
          try {
            return { ok: true, value: await use({ base, repositorySnapshots: fact.value.repositorySnapshots, cuts: fact.status === "partial" ? fact.cuts : [], sectionCuts: Object.fromEntries(Object.entries(fact.value.sections).flatMap(([repo, section]) => (section.status === "partial" ? [[repo, section.cuts]] : []))), session, serving: (declared) => servingOperation(declared, entrypointsOfWorkspace()) }) };
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

/** The declaration a call place encloses, as the graph places it: its simple name at its line. */
function declarationOf(graph: CodeGraphReader | undefined, from: Pick<Link["from"], "file" | "line" | "symbol">): GraphSymbol[] {
  if (graph === undefined) return [];
  const found = graph
    .symbolsInFiles([from.file])
    .filter((symbol) => symbol.name === nameTail(from.symbol) && symbol.startLine <= from.line && from.line <= symbol.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine));
  return found.length === 0 ? [] : [found[0]!];
}

function reachedRouteName(link: Link): string | undefined {
  return link.transport === "http" && link.to.kind === "http-route" ? link.to.name : undefined;
}

export function isCallOf(link: Link, operation: string): boolean {
  return reachedRouteName(link) === operation;
}
