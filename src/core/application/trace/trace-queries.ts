import { unknownTargetKey } from "../../ports/impact-queries.port.ts";
import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";
import type { ComponentRef } from "../../domain/change/seeds.ts";
import { contentFingerprint, exportCuts } from "../../domain/map/entrypoint-map.ts";
import { comparePosition, compareText } from "../../domain/shared/code-node.ts";
import { sortedEngines, withCuts, type Cut, type Fact } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { readingPlan } from "../../domain/trace/reading-plan.ts";
import type { TraceValue } from "../../domain/trace/trace-fact.ts";
import { traceSteps } from "../../domain/trace/trace-tree.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DeclaredMemberNames, DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import type { ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { TraceFault, TraceQueries } from "../../ports/trace-queries.port.ts";
import { distinctTargets, evidenceOfTarget, rangeChanges, requestedRanges, selectRoots, targetKey, triviaOncePerFile, type RootSelection } from "../navigation/root-selection.ts";
import { ABORTED } from "../snapshot/read-snapshot.ts";
import { createEdgeTargets } from "../navigation/edge-targets.ts";
import { retainedRelations } from "../relations/retained-relations.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import { createHeadReader, type FactSpec, type HeadReaderDeps } from "../snapshot/head-reading.ts";
import { isTraceRoot, unresolvedOncePerFile, walkTrace } from "./trace-walk.ts";

export interface TraceQueriesDeps extends HeadReaderDeps {
  /** Reads where the bare names a file calls come from, so a call to a package or a language global is external. */
  importOrigins: ImportOriginsReader;
  /** Reads the module statements that prove which declaration an imported name reaches; without it no edge is redirected. */
  moduleDependencies?: ModuleDependenciesReader;
  /** Reads the member names each source declares in value positions, so a member call R6 cannot place in the index is still a cut when the code declares its name. */
  memberNames: DeclaredMemberNamesReader;
  /** Reads the relations impact reads, under the same retained key, for the member calls they prove (RFC-0013 R3). */
  relations: RelationExtractor;
  /** Tells the trivia lines of a requested range apart, so they select nothing. */
  sourceTrivia: SourceTrivia;
  /** Version of each engine every operation runs on, by package name. */
  engines: Readonly<Record<string, string>>;
}

const NO_COMPONENTS: ReadonlyMap<string, readonly ComponentRef[]> = new Map();

export function createTraceQueries(deps: TraceQueriesDeps): TraceQueries {
  const headReader = createHeadReader(deps);
  const engines = sortedEngines(deps.engines);

  return {
    async walk(request) {
      const { signal } = request;
      const targets = distinctTargets(request.targets);
      const budget = request.budget ?? {};
      const spec: FactSpec = { declaredConfig: { ...(request.budget === undefined ? {} : { walk: { ...request.budget } }), targets: targets.map(targetKey) }, engines };

      return headReader.atSources(request, spec, async (head): Promise<Result<Fact<TraceValue>, TraceFault>> => {
        const content = contentFingerprint(head.tree.export);
        const outside = targets.filter((target) => !head.selected(target.file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map(evidenceOfTarget), status: "unknown", reason: "out-of-scope" } };
        const fixed = [
          ...exportCuts(head.tree.export),
          ...rangeChanges(targets).filter((file) => kindOfChangedFile(file.path) !== "source").map((file): Cut => ({ kind: "no-extractor", at: [file.path] })),
        ];

        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        if ("fault" in index) return { ok: false, fault: index.fault };
        const { store, summary } = index;
        try {
          const trivia = triviaOncePerFile(deps.sourceTrivia);
          const unresolvedIn = unresolvedOncePerFile(store);
          const isRoot = isTraceRoot(store, unresolvedIn);
          const selections = await Promise.all(targets.map(async (target) => ({
            target,
            selection: "start" in target
              ? await rangeRoots(store, rangeChanges([target]), head.tree.sources, trivia, isRoot)
              : selectRoots(store, [], [target], NO_COMPONENTS, [], isRoot),
          })));
          const missing = selections.flatMap(({ selection }) => selection.missing);
          if (missing.length > 0) return { ok: false, fault: { kind: "unknown-symbol", detail: `no symbol at the revision for ${missing.map(unknownTargetKey).join(", ")}`, entries: missing } };

          const roots = [...new Map(selections.flatMap(({ selection }) => selection.seeds.map(({ symbol }): [GraphNodeId, GraphSymbol] => [symbol.id, symbol]))).values()].sort(comparePosition);
          const declaredIn = declarationsOncePerFile(deps.memberNames);
          const sources = new Map(head.tree.sources.map((file) => [file.path, file]));
          let declared: Promise<ReadonlyMap<string, readonly string[]>> | undefined;
          const memberDeclarations = () => (declared ??= declaringFiles(head.tree.sources.filter((file) => head.selected(file.path)), declaredIn));
          const syntaxOf = async (path: string): Promise<DeclaredMemberNames> => {
            const file = sources.get(path);
            return file === undefined ? NOTHING_DECLARED : declaredIn(file);
          };
          const origins = deps.importOrigins(head.tree.sources);
          const edgeTargets = createEdgeTargets({ origins, store, modules: deps.moduleDependencies === undefined ? undefined : { reader: deps.moduleDependencies, sources: head.tree.sources } });
          let proven: ReturnType<typeof retainedRelations> | undefined;
          const memberProofs = () => (proven ??= retainedRelations(deps.relations, head.prepared, head.tree, request));
          const walk = await walkTrace(roots, { store, unresolvedIn, origins, targets: edgeTargets, inScope: head.selected, memberDeclarations, syntaxOf, memberProofs, budget, ...(signal === undefined ? {} : { signal }) });
          if (walk === "aborted") return ABORTED;

          const { steps, ids } = traceSteps(walk.roots);
          const rootIds = new Map(roots.map((root, index) => [root.id, ids.get(walk.roots[index]!)!]));
          const value: TraceValue = {
            roots: selections.map(({ target, selection }) => ({ target: targetKey(target), steps: selection.seeds.map(({ symbol }) => rootIds.get(symbol.id)!).sort((a, b) => a - b) })),
            steps,
            readingPlan: readingPlan(steps),
            cost: { expanded: walk.expanded },
          };
          const cuts = [
            ...fixed,
            ...summary.filesNotIndexed.map((file): Cut => ({ kind: "no-extractor", at: [file] })),
            ...selections.flatMap(({ selection }) => selection.withoutSymbols.map((file): Cut => ({ kind: "no-extractor", at: [file] }))),
            ...walk.cuts,
          ];
          return { ok: true, value: withCuts(head.base(content, true), value, cuts) };
        } finally {
          store.close();
        }
      });
    },
  };
}

/** Reads each source once for the life of one query, for its member names and its callables alike. */
function declarationsOncePerFile(reader: DeclaredMemberNamesReader): (file: SourceFile) => Promise<DeclaredMemberNames> {
  const read = new Map<string, Promise<DeclaredMemberNames>>();
  return (file) => {
    let declared = read.get(file.path);
    if (declared === undefined) {
      declared = reader.memberNames(file);
      read.set(file.path, declared);
    }
    return declared;
  };
}

const NOTHING_DECLARED: DeclaredMemberNames = { names: [], functionValueCalls: [], callables: [], receiverBindings: [] };

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

async function rangeRoots(store: CodeGraphReader, changes: readonly FileChange[], sources: readonly SourceFile[], trivia: SourceTrivia, isRoot: (symbol: GraphSymbol) => boolean): Promise<RootSelection> {
  const ranges = await requestedRanges(store, changes, sources, trivia);
  return selectRoots(store, ranges.changes, [], NO_COMPONENTS, ranges.uncovered, isRoot);
}
