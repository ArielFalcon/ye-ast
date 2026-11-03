import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import { contentFingerprint, exportCuts } from "../../domain/map/entrypoint-map.ts";
import type { Cut, Evidence, Fact } from "../../domain/shared/fact.ts";
import { sortedEngines, withCuts } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { OutlineValue } from "../../domain/outline/outline-fact.ts";
import type { OutlineFault, OutlineQueries } from "../../ports/outline-queries.port.ts";
import { ABORTED } from "../snapshot/read-snapshot.ts";
import { createHeadReader, type FactSpec, type HeadReaderDeps } from "../snapshot/head-reading.ts";
import { readOutline } from "./outline.ts";

export interface OutlineQueriesDeps extends HeadReaderDeps {
  /** Version of each engine every operation runs on, by package name. */
  engines: Readonly<Record<string, string>>;
}

/** Whether the index holds a file of this kind: the same rule the importers fact states for its answers. */
const isCovered = (path: string): boolean => ["source", "test"].includes(kindOfChangedFile(path));

export function createOutlineQueries(deps: OutlineQueriesDeps): OutlineQueries {
  const headReader = createHeadReader(deps);
  const engines = sortedEngines(deps.engines);

  return {
    async outline(request) {
      const files = sortedUnique(request.files);
      const spec: FactSpec = { declaredConfig: { files }, engines };

      return headReader.atHead(request, spec, async (head): Promise<Result<Fact<OutlineValue>, OutlineFault>> => {
        const headTree = head.tree;
        const content = contentFingerprint(headTree.export);
        const outside = files.filter((file) => !head.selected(file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map((path): Evidence => ({ path, line: 1 })), status: "unknown", reason: "out-of-scope" } };
        const fixed = [...exportCuts(headTree.export), ...files.filter((file) => !isCovered(file)).map((file): Cut => ({ kind: "no-extractor", at: [file] }))];
        const covered = files.filter(isCovered);
        if (covered.length === 0) return { ok: true, value: withCuts(head.base(content), { files: [], unheld: covered }, fixed) };

        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        const { store, summary } = index;
        try {
          const held = new Set(headTree.export.files.map((file) => file.path));
          const read = readOutline(store, covered);
          const cuts = [
            ...fixed,
            ...summary.filesNotIndexed.map((file): Cut => ({ kind: "no-extractor", at: [file] })),
            ...read.unheld.map((file): Cut => ({ kind: held.has(file) ? "no-extractor" : "not-exported", at: [file] })),
          ];
          return { ok: true, value: withCuts(head.base(content, true), read, cuts) };
        } finally {
          store.close();
        }
      });
    },
  };
}
