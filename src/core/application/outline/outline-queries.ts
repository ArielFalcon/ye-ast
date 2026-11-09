import { unknownTargetKey } from "../../ports/impact-queries.port.ts";
import { isReadableFile } from "../../domain/change/changed-file.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { contentFingerprint, exportCuts } from "../../domain/map/entrypoint-map.ts";
import type { Evidence, Fact } from "../../domain/shared/fact.ts";
import { fileCut, unheldCut } from "../../domain/impact/impact-cuts.ts";
import { sortedEngines } from "../../domain/shared/fact.ts";
import { withCuts, type Asserted } from "../../domain/shared/question.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { OutlineValue } from "../../domain/outline/outline-fact.ts";
import type { OutlineFault, OutlineQueries, OutlineSelector } from "../../ports/outline-queries.port.ts";
import { ABORTED } from "../snapshot/read-snapshot.ts";
import { createHeadReader, type FactSpec, type HeadReaderDeps } from "../snapshot/head-reading.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { UnmodelledConstructsReader } from "../../ports/unmodelled-constructs.port.ts";
import { focusWithUses, readFocus, readOutline } from "./outline.ts";
import type { ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import { buildOutputCuts } from "../../domain/shared/build-outputs.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import { createBaseReadings, withOutputs, type BaseReadingDeps } from "../snapshot/base-reading.ts";
import { snapshotFiles } from "../navigation/snapshot-files.ts";
import { unmodelledNote } from "../../domain/shared/unmodelled.ts";

export interface OutlineQueriesDeps extends HeadReaderDeps, Pick<BaseReadingDeps, "typeBindings" | "checkerInputs" | "declaredOutputs"> {
  /** Version of each engine every operation runs on, by package name. */
  engines: Readonly<Record<string, string>>;
  /** The reader of every language's module statements. */
  moduleReader: ModuleDependenciesReader;
  /** The requested files whose declarations the graph cannot place; without it no such file is cut. */
  unmodelled?: UnmodelledConstructsReader;
  /** Reads what binds the names a focused declaration uses, from the head's sources. */
  importOrigins: ImportOriginsReader;
  /** What a source's syntax states; without it a focused body's call on a value receiver is listed as the graph resolved it. */
  memberNames?: DeclaredMemberNamesReader;
  /** The relations whose origins and member proofs settle a focused body's calls on a value receiver. */
  relations: RelationExtractor;
}

export function createOutlineQueries(deps: OutlineQueriesDeps): OutlineQueries {
  const headReader = createHeadReader(deps);
  const readings = createBaseReadings({ ...deps, modules: deps.moduleReader });
  const engines = sortedEngines(deps.engines);

  return {
    async outline(request) {
      const focus = request.focus === undefined ? undefined : distinctSelectors(request.focus);
      const files = sortedUnique(focus === undefined ? request.files ?? [] : focus.map(({ file }) => file));
      const spec: FactSpec = { declaredConfig: focus === undefined ? { files } : { focus: focus.map(selectorKey) }, engines };

      return headReader.atSources(request, spec, async (head): Promise<Result<Fact<OutlineValue>, OutlineFault>> => {
        const headTree = head.tree;
        const sources = headTree.sources;
        const content = contentFingerprint(headTree.export);
        const outside = files.filter((file) => !head.selected(file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map((path): Evidence => ({ path, line: 1 })), status: "unknown", reason: "out-of-scope" } };
        const asserted: Asserted = { kind: "local", files };
        const fixed = [...exportCuts(headTree.export), ...files.filter((file) => !isReadableFile(file)).map((file) => fileCut("no-extractor", file, "language"))];
        const covered = files.filter(isReadableFile);
        if (covered.length === 0) return { ok: true, value: withCuts(head.base(content), focus === undefined ? { files: [], unheld: [] } : { focus: [], unheld: [] }, fixed, asserted) };

        const coveredFiles = new Set(covered);
        const unmodelled = (await deps.unmodelled?.extract(sources.filter(({ path }) => coveredFiles.has(path)))) ?? [];
        if (request.signal?.aborted) return ABORTED;
        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        if ("fault" in index) return { ok: false, fault: index.fault };
        const { store, summary } = index;
        try {
          const held = new Set(headTree.export.files.map((file) => file.path));
          const snapshot = snapshotFiles(store, [...held]);
          const focused = focus === undefined ? undefined : readFocus(store, focus.filter(({ file }) => isReadableFile(file)), snapshot);
          const unknown = focused === undefined ? [] : snapshot.describe(focused.unknown);
          if (unknown.length > 0) return { ok: false, fault: { kind: "unknown-symbol", detail: `no declaration at the revision for ${unknown.map(unknownTargetKey).join(", ")}${unmodelledNote(unknown, unmodelled)}`, entries: unknown } };
          if (focused !== undefined && focused.topLevel.length > 0) return { ok: false, fault: { kind: "top-level-line", detail: `no declaration holds ${focused.topLevel.map(({ file, line }) => `${file}:${line}`).join(", ")}; the line is at the top level of its file`, entries: focused.topLevel } };
          const listed = focused === undefined ? readOutline(store, covered, await deps.moduleReader.extract(sources, { files: covered })) : undefined;
          if (request.signal?.aborted) return ABORTED;
          const reading = focused === undefined ? undefined : readings.of({ tree: headTree, prepared: head.prepared, hold: head.hold, store, digest: index.digest, snapshot: head.base(content).snapshot, request });
          const typed = reading === undefined ? undefined : await reading.typed();
          if (typed === "aborted") return ABORTED;
          const used = focused === undefined || reading === undefined ? undefined : await focusWithUses(store, focused, reading, typed?.typed, request.signal);
          if (used === "aborted" || request.signal?.aborted) return ABORTED;
          const read = focused === undefined ? listed!.value : { ...focused.value, focus: used!.focus };
          const cuts = [
            ...fixed,
            ...(typed?.inputsLeftOut ?? []),
            ...buildOutputCuts(typed?.buildOutputs),
            ...(listed?.cuts ?? used!.cuts),
            ...summary.filesNotIndexed.map((file) => fileCut("no-extractor", file, "not-indexed")),
            ...read.unheld.map((file) => unheldCut(file, held)),
            ...unmodelled.map((file) => fileCut("no-extractor", file, "unmodelled")),
          ];
          return { ok: true, value: withCuts(withOutputs(head.base(content, true), typed?.outputs), read, cuts, asserted) };
        } finally {
          store.close();
        }
      });
    },
  };
}

function selectorKey(selector: OutlineSelector): string {
  return "symbol" in selector ? `${selector.file}:${selector.symbol}` : `${selector.file}:${selector.line}`;
}

/** The selectors once each, in a fixed order, so the same request in any order is the same fact. */
function distinctSelectors(selectors: readonly OutlineSelector[]): OutlineSelector[] {
  const byKey = new Map(selectors.map((selector) => [JSON.stringify(selector), selector]));
  return [...byKey].sort(([a], [b]) => compareText(a, b)).map(([, selector]) => selector);
}
