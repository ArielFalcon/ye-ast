import type { ImportedFile, ImportersValue } from "../../../core/domain/impact/importers-fact.ts";
import type { Fact } from "../../../core/domain/shared/fact.ts";
import { renderFactNarrowing, renderFactStatus } from "../../presentation-context.ts";
import type { Place, Presentation, Row, Section } from "../model.ts";
import { cutSection } from "../rows.ts";

/** The `answer.json` member the related-file rows come from. */
export const IMPORTED_FILES_SECTION = "value.files";

const NO_RELATED_FILE = "no-related-files";

interface Membership {
  path: string;
  labels: readonly string[];
}

function membershipsOf(entry: ImportedFile): Membership[] {
  const modules: readonly (readonly [string, readonly string[] | undefined])[] = [
    ["importers", entry.importers],
    ["reexporters", entry.reexporters],
    ["dynamic importers", entry.dynamicImporters],
    ["type importers", entry.typeImporters],
  ];
  const modulePaths = new Set(modules.flatMap(([, files]) => files ?? []));
  const labelsByPath = new Map<string, string[]>();
  const add = (path: string, label: string, index: number): void => {
    labelsByPath.set(path, [...(labelsByPath.get(path) ?? []), `${label}[${index}]`]);
  };
  for (const [label, files] of modules) files?.forEach((path, index) => add(path, label, index));
  entry.users.forEach((path, index) => add(path, modulePaths.has(path) ? "users" : "additional users", index));
  entry.unresolvedNamers.forEach((path, index) => add(path, labelsByPath.has(path) ? "also unresolved name matches" : "unresolved name matches", index));
  return [...labelsByPath].map(([path, labels]) => ({ path, labels }));
}

function placesOf(entry: ImportedFile, related: string): Place[] {
  return [...new Set((entry.places ?? []).filter((place) => place.file === related).map((place) => place.line))]
    .sort((a, b) => a - b)
    .map((line) => ({ path: related, line }));
}

function relatedRow(entry: ImportedFile, { path, labels }: Membership): Row {
  const evidence = placesOf(entry, path);
  return {
    key: [entry.file, path].join("\0"),
    place: { path: entry.file },
    label: path,
    qualifiers: labels.map((name) => ({ name })),
    ...(evidence.length === 0 ? {} : { evidence }),
  };
}

function noRelatedRow(entry: ImportedFile): Row {
  return { key: [entry.file, NO_RELATED_FILE].join("\0"), place: { path: entry.file }, label: "no related files" };
}

/** One row per related file of each requested file, in the order of the categories the fact lists, and one row for a
 * requested file with no related file, so a complete empty answer is stated. */
function importedFileRows(files: readonly ImportedFile[]): Row[] {
  return files.flatMap((entry) => {
    const memberships = membershipsOf(entry);
    return memberships.length === 0 ? [noRelatedRow(entry)] : memberships.map((membership) => relatedRow(entry, membership));
  });
}

export function present(fact: Fact<ImportersValue>): Presentation {
  const files = fact.status === "unknown" ? undefined : fact.value.files;
  const answer: Section[] = files === undefined ? [] : [{ id: IMPORTED_FILES_SECTION, title: "importers", role: "answer", layout: "by-file", primary: true, rows: importedFileRows(files) }];
  return {
    status: renderFactStatus(fact, ""),
    snapshots: [fact.snapshot],
    narrowing: renderFactNarrowing(fact),
    sections: [...answer, cutSection(fact.status === "partial" ? fact.cuts : [])],
  };
}
