import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { INDEX_STORE_DIRECTORY, type CodeGraphReader, type GraphNodeId } from "../../ports/code-graph.port.ts";
import { createCodeGraph, defaultCodeGraphDeps } from "./codegraph.adapter.ts";

export interface Conformance {
  checks: number;
  /** The first calls whose answers differ, each with the method and its arguments. */
  differences: readonly string[];
}

const SHOWN_DIFFERENCES = 20;

/**
 * Asks the SDK reader and the image of `store` every port method over every file, id and name the store holds, alone
 * and all together, with case variants of each name and every edge kind, and lists the calls whose answers differ.
 */
export function imageConformance(store: string): Conformance {
  const sql = createCodeGraph().open(store);
  const image = createCodeGraph(defaultCodeGraphDeps, { imageBytes: 0 }).open(store);
  if (!sql.ok || !image.ok) throw new Error(`${store} does not open: ${JSON.stringify(sql.ok ? image : sql)}`);
  const { files, ids, names, kinds } = storeKeys(store);
  const differences: string[] = [];
  let checks = 0;
  const compare = <A extends unknown[]>(method: string, ask: (reader: CodeGraphReader) => unknown, args: A): void => {
    checks += 1;
    if (differences.length >= SHOWN_DIFFERENCES) return;
    if (!isDeepStrictEqual(ask(sql.value), ask(image.value))) differences.push(`${method} ${JSON.stringify(args).slice(0, 300)}`);
  };
  try {
    const askedFiles = [...files].reverse().concat(files.slice(0, 1), ["missing/file.ts"]);
    const askedIds = [...ids].reverse().concat(ids.slice(0, 1), ["nothing:missing" as GraphNodeId]);
    for (const file of files) {
      compare("symbolsInFiles", (reader) => reader.symbolsInFiles([file]), [file]);
      compare("unresolvedReferences", (reader) => reader.unresolvedReferences([file]), [file]);
    }
    compare("symbolsInFiles", (reader) => reader.symbolsInFiles(askedFiles), ["all"]);
    compare("unresolvedReferences", (reader) => reader.unresolvedReferences(askedFiles), ["all"]);
    for (const id of ids) {
      compare("symbolsByIds", (reader) => reader.symbolsByIds([id]), [id]);
      compare("incomingEdges", (reader) => reader.incomingEdges([id]), [id]);
      compare("outgoingEdges", (reader) => reader.outgoingEdges([id]), [id]);
      compare("incomingEdges", (reader) => reader.incomingEdges([id], []), [id, []]);
    }
    compare("symbolsByIds", (reader) => reader.symbolsByIds(askedIds), ["all"]);
    compare("incomingEdges", (reader) => reader.incomingEdges(askedIds), ["all"]);
    compare("outgoingEdges", (reader) => reader.outgoingEdges(askedIds), ["all"]);
    for (const kind of kinds) {
      compare("incomingEdges", (reader) => reader.incomingEdges(askedIds, [kind]), ["all", kind]);
      compare("outgoingEdges", (reader) => reader.outgoingEdges(askedIds, [kind, kind]), ["all", kind]);
    }
    compare("outgoingEdges", (reader) => reader.outgoingEdges(askedIds, kinds.slice(0, 2)), ["all", kinds.slice(0, 2)]);
    for (const name of names) {
      for (const variant of new Set([name, name.toLowerCase(), name.toUpperCase()])) {
        compare("declarationsNamed", (reader) => reader.declarationsNamed([variant]), [variant]);
      }
    }
    compare("declarationsNamed", (reader) => reader.declarationsNamed([...names].reverse().concat(names.slice(0, 1), ["missingName"])), ["all"]);
  } finally {
    sql.value.close();
    image.value.close();
  }
  return { checks, differences };
}

function storeKeys(store: string): { files: string[]; ids: GraphNodeId[]; names: string[]; kinds: string[] } {
  const db = new DatabaseSync(join(store, INDEX_STORE_DIRECTORY, "codegraph.db"), { readOnly: true });
  try {
    const column = (sql: string): string[] => (db.prepare(sql).all() as { value: string }[]).map(({ value }) => value);
    return {
      files: column("SELECT file_path AS value FROM nodes UNION SELECT file_path FROM unresolved_refs UNION SELECT path FROM files ORDER BY 1"),
      ids: column("SELECT id AS value FROM nodes UNION SELECT source FROM edges UNION SELECT target FROM edges ORDER BY 1") as GraphNodeId[],
      names: column("SELECT name AS value FROM nodes UNION SELECT reference_name FROM unresolved_refs ORDER BY 1"),
      kinds: column("SELECT DISTINCT kind AS value FROM edges ORDER BY 1"),
    };
  } finally {
    db.close();
  }
}
