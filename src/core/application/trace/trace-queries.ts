import { withCuts, type Asserted } from "../../domain/shared/question.ts";
import type { LibrarySource } from "../../domain/topology/library-source.ts";
import type { WorkspaceReadOperation } from "../topology/workspace-operation.ts";
import { compositeBase } from "../../domain/topology/composite-inputs.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import { callsByOwner } from "../navigation/reconciled-calls.ts";
import { unknownTargetKey } from "../../ports/impact-queries.port.ts";
import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";
import type { ComponentRef } from "../../domain/change/seeds.ts";
import { contentFingerprint, exportCuts } from "../../domain/map/entrypoint-map.ts";
import { comparePosition, compareText, joinsFact } from "../../domain/shared/code-node.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { fileCut, placeAt } from "../../domain/impact/impact-cuts.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import { ANYTHING, sortedEngines, type Cut, type Fact, type Finding } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { readingPlan } from "../../domain/trace/reading-plan.ts";
import type { TraceValue } from "../../domain/trace/trace-fact.ts";
import { traceSteps } from "../../domain/trace/trace-tree.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DeclaredMemberNames, DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import type { ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { CallersTarget } from "../../ports/impact-queries.port.ts";
import type { EntrypointTarget, TraceFault, TraceQueries, TraceTarget, UnknownEntrypointFault } from "../../ports/trace-queries.port.ts";
import { distinctTargets, evidenceOfTarget, rangeChanges, requestedRanges, selectRoots, targetKey, triviaOncePerFile, type RootSelection } from "../navigation/root-selection.ts";
import { snapshotFiles, type SnapshotFiles } from "../navigation/snapshot-files.ts";
import { ABORTED } from "../snapshot/read-snapshot.ts";
import { NOTHING_DECLARED } from "../navigation/edge-targets.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import { createHeadReader, type FactSpec, type HeadReaderDeps, type HeadReading } from "../snapshot/head-reading.ts";
import type { CommitExtraction } from "../snapshot/read-snapshot.ts";
import { isTraceRoot, walkTrace } from "./trace-walk.ts";
import { placeEffects } from "./trace-effects.ts";
import { comparePlacement, type DataEffectReader } from "../../domain/trace/data-effect-site.ts";
import type { PlacedCallSiteReader } from "../../domain/topology/call-site.ts";
import { pagePlans } from "./page-plans.ts";
import { createBaseReadings, withOutputs, type BaseReadingDeps } from "../snapshot/base-reading.ts";
import { buildOutputCuts } from "../../domain/shared/build-outputs.ts";

export interface TraceQueriesDeps extends HeadReaderDeps, Pick<BaseReadingDeps, "typeBindings" | "checkerInputs" | "declaredOutputs"> {
  workspace?: WorkspaceReadOperation;
  librarySources?: readonly LibrarySource[];
  /** Reads where the bare names a file calls come from, so a call to a package or a language global is external. */
  importOrigins: ImportOriginsReader;
  /** Reads every language's module statements, which prove which declaration an imported name reaches; without it no edge is redirected. */
  moduleReader?: ModuleDependenciesReader;
  /** Reads the member names each source declares in value positions, so a member call R6 cannot place in the index is still a cut when the code declares its name. */
  memberNames: DeclaredMemberNamesReader;
  /** Reads the relations impact reads, under the same retained key, for the member calls they prove (RFC-0013 R3). */
  relations: RelationExtractor;
  /** Reads the snapshot's call sites (RFC-0011), the declared rows a trace's effects come from (RFC-0013 R12). */
  callSites: PlacedCallSiteReader;
  dataEffects?: DataEffectReader;
  /** Tells the trivia lines of a requested range apart, so they select nothing. */
  sourceTrivia: SourceTrivia;
  /** Version of each engine every operation runs on, by package name. */
  engines: Readonly<Record<string, string>>;
}

const NO_COMPONENTS: ReadonlyMap<string, readonly ComponentRef[]> = new Map();

export function createTraceQueries(deps: TraceQueriesDeps): TraceQueries {
  const headReader = createHeadReader(deps);
  const readings = createBaseReadings({ ...deps, modules: deps.moduleReader });
  const engines = sortedEngines(deps.engines);

  return {
    async walk(request) {
      const { signal } = request;
      if (request.workspace !== undefined) {
        if (deps.workspace === undefined) return { ok: false, fault: { kind: "git-failed", detail: "workspace reader unavailable" } };
        const result = await deps.workspace.withRead({
          repo: { path: request.repo, id: request.repoId, ...(request.live ? { live: true as const } : { revision: request.revision }) },
          ...request.workspace,
          ...(request.scope === undefined ? {} : { scope: request.scope }),
          ...(request.offline === undefined ? {} : { offline: request.offline }),
          ...(signal === undefined ? {} : { signal }),
        }, async (read, context) => {
          const { workspace: _workspace, ...local } = request;
          const selected = context.selectedSnapshots.find((snapshot) => snapshot.repo === request.repoId);
          const plan = context.plans.find((plan) => plan.kind === "read" && plan.at.repoId === request.repoId);
          const held = context.liveCaptures.get(request.repoId);
          const at = selected?.kind === "live"
            ? held === undefined ? undefined : { repo: held.repo, live: true as const, revision: undefined }
            : selected?.kind === "sha" && plan?.kind === "read" ? { repo: request.repo, source: plan.at.source, revision: selected.sha, live: undefined } : undefined;
          if (at === undefined) return { ok: false as const, fault: { kind: "git-failed" as const, detail: "trace snapshot unavailable" } };
          const trace = createTraceQueries({ ...deps, preparation: context.preparation, heldLive: () => held, librarySources: context.librarySources?.get(request.repoId) ?? [] });
          const answer = await trace.walk({ ...local, ...at });
          if (!answer.ok) return answer;
          const base = compositeBase(answer.value, [{ kind: "trace", fact: answer.value }, { kind: "workspace", fact: read.fact }], request.workspace, (value) => deps.digest.of(value));
          return { ok: true as const, value: { ...answer.value, ...base } };
        });
        if (!result.ok) return result;
        if (request.live) {
          const stale = result.value.workspaceLive?.find(notice => notice.kind === "stale" && notice.repo === request.repoId);
          if (stale?.kind === "stale") request.onStale?.(stale.notice);
        }
        return { ok: true, value: result.value.value };
      }
      const targets = distinctTargets(request.targets);
      const declarations = targets.filter(isDeclarationTarget);
      const entrypoints = targets.filter(isEntrypointTarget);
      const budget = request.budget ?? {};
      const spec: FactSpec = { declaredConfig: { ...(request.budget === undefined ? {} : { walk: { ...request.budget } }), targets: targets.map(traceTargetKey) }, engines };

      const read = async (head: HeadReading<Pick<CommitExtraction, "export" | "sources">>, findings: readonly Finding<Entrypoint>[]): Promise<Result<Fact<TraceValue>, TraceFault>> => {
        const content = contentFingerprint(head.tree.export);
        const outside = declarations.filter((target) => !head.selected(target.file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map(evidenceOfTarget), status: "unknown", reason: "out-of-scope" } };
        const handlers = entrypointHandlers(findings, entrypoints);
        if (handlers.unknown.length > 0) return { ok: false, fault: { kind: "unknown-entrypoint", detail: `no entrypoint of the map at the revision for ${handlers.unknown.map(traceTargetKey).join(", ")}`, entries: handlers.unknown } };
        const fixed = [
          ...exportCuts(head.tree.export),
          ...rangeChanges(declarations).filter((file) => kindOfChangedFile(file.path) !== "source").map((file) => fileCut("no-extractor", file.path, "not-source")),
        ];

        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        if ("fault" in index) return { ok: false, fault: index.fault };
        const { store, summary } = index;
        try {
          const snapshot = snapshotFiles(store, head.tree.export.files.map(({ path }) => path));
          const trivia = triviaOncePerFile(deps.sourceTrivia);
          const reading = readings.of(
            { tree: head.tree, prepared: head.prepared, store, digest: index.digest, snapshot: head.base(content).snapshot, request },
            { originPaths: head.tree.export.files.map(({ path }) => path).filter(head.selected), inScope: head.selected },
          );
          const { unresolvedIn, lineOf } = reading;
          const syntaxOf = reading.syntaxOf ?? (async (): Promise<DeclaredMemberNames> => NOTHING_DECLARED);
          const sources = new Set(head.tree.sources.map((file) => file.path));
          let declared: Promise<ReadonlyMap<string, readonly string[]>> | undefined;
          const memberDeclarations = () => (declared ??= declaringFiles(head.tree.sources.filter((file) => head.selected(file.path)), (file) => syntaxOf(file.path)));
          const rootFiles = [...new Set(declarations.map((target) => target.file))];
          const syntaxCalls = new Set<GraphNodeId>();
          for (const file of rootFiles) {
            const symbols = store.symbolsInFiles([file]);
            if (symbols.some((symbol) => symbol.kind === "property" || symbol.kind === "field")) {
              const syntax = await syntaxOf(file);
              for (const [id, calls] of callsByOwner(syntax.calls ?? [], symbols, syntax.functionValues)) if (calls.some((call) => !call.deferred)) syntaxCalls.add(id);
            }
          }
          const isRoot = isTraceRoot(store, unresolvedIn, syntaxCalls);
          const selections = await Promise.all(targets.map(async (target): Promise<{ target: TraceTarget; selection: Pick<RootSelection, "seeds" | "missing" | "withoutSymbols"> }> => ({
            target,
            selection: isEntrypointTarget(target)
              ? handlerRoots(store, handlers.byTarget.get(traceTargetKey(target)) ?? [], isRoot)
              : "start" in target
                ? await rangeRoots(store, rangeChanges([target]), head.tree.sources, trivia, snapshot, isRoot)
                : selectRoots(store, [], [target], NO_COMPONENTS, [], isRoot),
          })));
          const missing = snapshot.describe(selections.flatMap(({ selection }) => selection.missing));
          if (missing.length > 0) return { ok: false, fault: { kind: "unknown-symbol", detail: `no symbol at the revision for ${missing.map(unknownTargetKey).join(", ")}`, entries: missing } };

          const roots = [...new Map(selections.flatMap(({ selection }) => selection.seeds.map(({ symbol }): [GraphNodeId, GraphSymbol] => [symbol.id, symbol]))).values()].sort(comparePosition);
          const origins = reading.origins();
          const typed = await reading.typed();
          if (typed === "aborted") return ABORTED;
          const edgeTargets = reading.edgeTargets(typed.typed);
          const reconciled = edgeTargets === undefined ? undefined : reading.reconciledCalls(edgeTargets, reading.declarationUses());
          if (origins === undefined || edgeTargets?.bindings === undefined || reconciled === undefined) throw new Error("a trace binds calls through the base binder, which needs the syntax and the relations' proofs");
          const pageRoots = new Set(selections.flatMap(({ target, selection }) => (isEntrypointTarget(target) ? selection.seeds.map(({ symbol }) => symbol.id) : [])));
          const pages = pageRoots.size === 0 ? {} : { pages: { roots: pageRoots, of: pagePlans(store, reading.relations) } };
          const walk = await walkTrace(roots, { store, unresolvedIn, origins, targets: edgeTargets, bindings: edgeTargets.bindings, uses: reading.declarationUses(), reconciled, inScope: head.selected, memberDeclarations, syntaxOf, budget, ...pages, ...(signal === undefined ? {} : { signal }) });
          if (walk === "aborted") return ABORTED;
          const dataEffects = () => deps.dataEffects?.placed(head.tree.sources) ?? Promise.resolve([]);
          const dataSites = () => head.prepared?.facts === undefined ? dataEffects() : head.prepared.facts.ofInputs("trace-data-effects", { sources: head.tree.sources }, dataEffects);
          const effectCuts = await placeEffects(walk.roots, { store, callsOf: (body) => reconciled.callsOf(body), sites: async () => [...(await deps.callSites.placed(head.tree.sources, request.repoId, deps.librarySources)), ...(await dataSites())].sort(comparePlacement).filter(({ site }) => head.selected(site.file)), lineOf, functionValuesOf: async (file) => (sources.has(file) ? (await syntaxOf(file)).functionValues : undefined) });

          const { steps, ids } = traceSteps(walk.roots);
          const rootIds = new Map(roots.map((root, index) => [root.id, ids.get(walk.roots[index]!)!]));
          const value: TraceValue = {
            roots: selections.map(({ target, selection }) => ({ target: traceTargetKey(target), steps: selection.seeds.map(({ symbol }) => rootIds.get(symbol.id)!).sort((a, b) => a - b) })),
            steps,
            readingPlan: readingPlan(steps),
            cost: { expanded: walk.expanded },
          };
          const cuts = [
            ...fixed,
            ...typed.inputsLeftOut,
            ...buildOutputCuts(typed.buildOutputs),
            ...summary.filesNotIndexed.map((file) => fileCut("no-extractor", file, "not-indexed")),
            ...selections.flatMap(({ selection }) => selection.withoutSymbols.map((file) => fileCut("no-extractor", file, "no-symbols"))),
            ...handlers.unplaced,
            ...selections.flatMap(({ target, selection }) => (isEntrypointTarget(target) ? unplacedHandlers(handlers.byTarget.get(traceTargetKey(target)) ?? [], selection) : [])),
            ...walk.cuts,
            ...effectCuts,
          ];
          const walked: Asserted = { kind: "walk", files: [...new Set([...selections.flatMap(({ target }) => (isEntrypointTarget(target) ? [] : [target.file])), ...steps.map(({ file }) => file)])] };
          return { ok: true, value: withCuts(withOutputs(head.base(content, true), typed.outputs), value, cuts, walked) };
        } finally {
          store.close();
        }
      };
      return entrypoints.length === 0
        ? headReader.atSources(request, spec, (head) => read(head, []))
        : headReader.atHead(request, spec, (head) => read(head, head.tree.findings));
    },
  };
}

function isEntrypointTarget(target: TraceTarget): target is EntrypointTarget {
  return "kind" in target;
}

function isDeclarationTarget(target: TraceTarget): target is CallersTarget {
  return !isEntrypointTarget(target);
}

function traceTargetKey(target: TraceTarget): string {
  return isEntrypointTarget(target) ? `${target.kind} ${target.name}` : targetKey(target);
}

type HandlerPlace = { path: string; symbol: string; line: number };

interface EntrypointHandlers {
  /** The handlers, or a UI route's component, of the map's entrypoints each target names, by the target's key. */
  byTarget: ReadonlyMap<string, readonly HandlerPlace[]>;
  /** A UI route of a target whose component the sources do not name, as a cut at the route. */
  unplaced: readonly Cut[];
  unknown: UnknownEntrypointFault["entries"];
}

/** What each entrypoint target starts at: the handler of every complete map entrypoint of its kind and name. */
function entrypointHandlers(findings: readonly Finding<Entrypoint>[], targets: readonly EntrypointTarget[]): EntrypointHandlers {
  const entrypoints = findings.flatMap((finding) => (finding.status === "complete" ? [{ entrypoint: finding.value, evidence: finding.evidence }] : []));
  const byTarget = new Map<string, HandlerPlace[]>();
  const unplaced: Cut[] = [];
  const unknown: UnknownEntrypointFault["entries"][number][] = [];
  for (const target of targets) {
    const named = entrypoints.filter(({ entrypoint }) => entrypoint.kind === target.kind && entrypoint.name === target.name);
    if (named.length === 0) {
      unknown.push({ ...target, candidates: sortedUnique(entrypoints.filter(({ entrypoint }) => entrypoint.kind === target.kind).map(({ entrypoint }) => entrypoint.name)) });
      continue;
    }
    const places: HandlerPlace[] = [];
    for (const { entrypoint, evidence } of named) {
      const handler = entrypoint.kind === "ui-route" ? entrypoint.component : entrypoint.handler;
      if (handler === "unknown") unplaced.push({ kind: "unresolved-link", at: evidence.map((at) => placeAt(at.path, at.line, entrypoint.name)), reason: "handler-unplaced", reach: ANYTHING });
      else places.push({ path: handler.path, symbol: handler.symbol, line: handler.line });
    }
    byTarget.set(traceTargetKey(target), places);
  }
  return { byTarget, unplaced, unknown };
}

/** The declarations of the index the handlers name: the one join of a map fact and a node (file, line in span, name). */
function handlerRoots(store: CodeGraphReader, handlers: readonly HandlerPlace[], isRoot: (symbol: GraphSymbol) => boolean): Pick<RootSelection, "seeds" | "missing" | "withoutSymbols"> {
  const symbols = store.symbolsInFiles(sortedUnique(handlers.map(({ path }) => path)));
  const joined = symbols.filter((symbol) => isRoot(symbol) && handlers.some((handler) => joinsFact(symbol, handler)));
  return { seeds: joined.sort(comparePosition).map((symbol) => ({ symbol, basis: "requested" })), missing: [], withoutSymbols: [] };
}

/** A handler no declaration of the index joins is a cut at the handler, never a root silently missing. */
function unplacedHandlers(handlers: readonly HandlerPlace[], selection: Pick<RootSelection, "seeds">): Cut[] {
  return handlers
    .filter((handler) => !selection.seeds.some(({ symbol }) => joinsFact(symbol, handler)))
    .map((handler): Cut => ({ kind: "unresolved-link", at: [placeAt(handler.path, handler.line, handler.symbol)], reason: "handler-unplaced", reach: ANYTHING }));
}

/** Reads each source once for the life of one query, for its member names and its callables alike. */
/** Each member name with the sources that declare it, sorted. */
async function declaringFiles(sources: readonly SourceFile[], declaredIn: (file: SourceFile) => Promise<DeclaredMemberNames>): Promise<ReadonlyMap<string, readonly string[]>> {
  const byName = new Map<string, string[]>();
  for (const file of sources) {
    for (const name of (await declaredIn(file)).names) {
      const files = byName.get(name);
      if (files === undefined) byName.set(name, [file.path]);
      else files.push(file.path);
    }
  }
  return new Map([...byName].map(([name, files]) => [name, files.sort(compareText)]));
}

async function rangeRoots(store: CodeGraphReader, changes: readonly FileChange[], sources: readonly SourceFile[], trivia: SourceTrivia, snapshot: SnapshotFiles, isRoot: (symbol: GraphSymbol) => boolean): Promise<RootSelection> {
  const ranges = await requestedRanges(store, changes, sources, trivia, snapshot);
  return selectRoots(store, ranges.changes, [], NO_COMPONENTS, ranges.uncovered, isRoot);
}
