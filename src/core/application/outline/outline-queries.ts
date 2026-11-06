import { isReadableFile } from "../../domain/change/changed-file.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { contentFingerprint, exportCuts } from "../../domain/map/entrypoint-map.ts";
import type { Cut, Evidence, Fact } from "../../domain/shared/fact.ts";
import { sortedEngines, withCuts } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { OutlineValue } from "../../domain/outline/outline-fact.ts";
import type { OutlineFault, OutlineQueries, OutlineSelector } from "../../ports/outline-queries.port.ts";
import { ABORTED } from "../snapshot/read-snapshot.ts";
import { createHeadReader, type FactSpec, type HeadReaderDeps, type HeadReading } from "../snapshot/head-reading.ts";
import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { CommitExtraction } from "../snapshot/read-snapshot.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { readFocus, readOutline } from "./outline.ts";

export interface OutlineQueriesDeps extends HeadReaderDeps {
  /** Version of each engine every operation runs on, by package name. */
  engines: Readonly<Record<string, string>>;
  /** The readers of module statements, one per language; each reads only the files of its language. */
  moduleReaders: readonly ModuleDependenciesReader[];
}

export function createOutlineQueries(deps: OutlineQueriesDeps): OutlineQueries {
  const headReader = createHeadReader(deps);
  const engines = sortedEngines(deps.engines);

  return {
    async outline(request) {
      const focus = request.focus === undefined ? undefined : distinctSelectors(request.focus);
      const files = sortedUnique(focus === undefined ? request.files ?? [] : focus.map(({ file }) => file));
      const spec: FactSpec = { declaredConfig: focus === undefined ? { files } : { focus: focus.map(selectorKey) }, engines };

      const answer = async (head: HeadReading<Pick<CommitExtraction, "export">>, sources?: readonly SourceFile[]): Promise<Result<Fact<OutlineValue>, OutlineFault>> => {
        const headTree = head.tree;
        const content = contentFingerprint(headTree.export);
        const outside = files.filter((file) => !head.selected(file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map((path): Evidence => ({ path, line: 1 })), status: "unknown", reason: "out-of-scope" } };
        const fixed = [...exportCuts(headTree.export), ...files.filter((file) => !isReadableFile(file)).map((file): Cut => ({ kind: "no-extractor", at: [file] }))];
        const covered = files.filter(isReadableFile);
        if (covered.length === 0) return { ok: true, value: withCuts(head.base(content), focus === undefined ? { files: [], unheld: [] } : { focus: [], unheld: [] }, fixed) };

        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        const { store, summary } = index;
        try {
          const held = new Set(headTree.export.files.map((file) => file.path));
          const focused = focus === undefined ? undefined : readFocus(store, focus.filter(({ file }) => isReadableFile(file)));
          if (focused !== undefined && focused.unknown.length > 0) return { ok: false, fault: { kind: "unknown-symbol", detail: `no declaration at the revision for ${focused.unknown.map(({ file, symbol }) => `${file}:${symbol}`).join(", ")}`, entries: focused.unknown } };
          if (focused !== undefined && focused.topLevel.length > 0) return { ok: false, fault: { kind: "top-level-line", detail: `no declaration holds ${focused.topLevel.map(({ file, line }) => `${file}:${line}`).join(", ")}; the line is at the top level of its file`, entries: focused.topLevel } };
          const listed = focused === undefined ? readOutline(store, covered, await readModules(deps.moduleReaders, sources ?? [], covered)) : undefined;
          if (request.signal?.aborted) return ABORTED;
          const read = focused?.value ?? listed!.value;
          const cuts = [
            ...fixed,
            ...(listed?.cuts ?? []),
            ...summary.filesNotIndexed.map((file): Cut => ({ kind: "no-extractor", at: [file] })),
            ...read.unheld.map((file): Cut => ({ kind: held.has(file) ? "no-extractor" : "not-exported", at: [file] })),
          ];
          return { ok: true, value: withCuts(head.base(content, true), read, cuts) };
        } finally {
          store.close();
        }
      };
      return focus === undefined ? headReader.atSources(request, spec, (head) => answer(head, head.tree.sources)) : headReader.atExport(request, spec, (head) => answer(head));
    },
  };
}

/** The module statements of the requested files from every reader, each resolved against every source, as one read. */
async function readModules(readers: readonly ModuleDependenciesReader[], sources: readonly SourceFile[], files: readonly string[]): Promise<ModuleDependencies> {
  const reads = await Promise.all(readers.map((reader) => reader.extract(sources, { files })));
  return {
    files: reads.flatMap((read) => read.files),
    dependencies: reads.flatMap((read) => read.dependencies),
    unread: reads.flatMap((read) => read.unread),
    untraversed: reads.flatMap((read) => read.untraversed ?? []),
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
