import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";
import type { ComponentRef } from "../../domain/change/seeds.ts";
import { contentFingerprint, exportCuts } from "../../domain/map/entrypoint-map.ts";
import { comparePosition } from "../../domain/shared/code-node.ts";
import { sortedEngines, withCuts, type Cut, type Fact } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { readingPlan } from "../../domain/trace/reading-plan.ts";
import type { TraceValue } from "../../domain/trace/trace-fact.ts";
import { traceSteps } from "../../domain/trace/trace-tree.ts";
import type { GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { TraceFault, TraceQueries } from "../../ports/trace-queries.port.ts";
import { distinctTargets, evidenceOfTarget, rangeChanges, requestedRanges, selectRoots, targetKey } from "../navigation/root-selection.ts";
import { ABORTED } from "../snapshot/read-snapshot.ts";
import { createHeadReader, type FactSpec, type HeadReaderDeps } from "../snapshot/head-reading.ts";
import { walkTrace } from "./trace-walk.ts";

export interface TraceQueriesDeps extends HeadReaderDeps {
  /** Reads where the bare names a file calls come from, so a call to a package or a language global is external. */
  importOrigins: ImportOriginsReader;
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
        const { store, summary } = index;
        try {
          const selections = await Promise.all(targets.map(async (target) => ({
            target,
            selection: "start" in target
              ? selectRoots(store, await requestedRanges(store, rangeChanges([target]), head.tree.sources, deps.sourceTrivia), [], NO_COMPONENTS)
              : selectRoots(store, [], [target], NO_COMPONENTS),
          })));
          const missing = selections.flatMap(({ selection }) => selection.missing);
          if (missing.length > 0) return { ok: false, fault: { kind: "unknown-symbol", detail: `no symbol at the revision for ${missing.map(({ file, symbol }) => `${file}:${symbol}`).join(", ")}`, entries: missing } };

          const roots = [...new Map(selections.flatMap(({ selection }) => selection.seeds.map(({ symbol }): [GraphNodeId, GraphSymbol] => [symbol.id, symbol]))).values()].sort(comparePosition);
          const walk = await walkTrace(roots, { store, origins: deps.importOrigins(head.tree.sources), inScope: head.selected, budget, ...(signal === undefined ? {} : { signal }) });
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
