import type { OutlineBinding, OutlineDeclaration, OutlineFile, OutlineFocus, OutlineImport, OutlineUse, OutlineValue } from "../../../core/domain/outline/outline-fact.ts";
import { hasUnprovedUses } from "../../../core/domain/outline/outline-uses.ts";
import { canonicalJson } from "../../../core/domain/shared/canonical-json.ts";
import type { Cut, Fact } from "../../../core/domain/shared/fact.ts";
import { renderFactNarrowing, renderFactStatus } from "../../presentation-context.ts";
import type { Place, Presentation, Qualifier, Row, Section } from "../model.ts";
import { cutSection, declarationRow } from "../rows.ts";

/** The `answer.json` members the sections of this family come from. */
export const FILES_SECTION = "value.files";
export const FOCUS_SECTION = "value.focus";
export const ANCESTORS_SECTION = "value.focus.ancestors";
export const USES_SECTION = "value.focus.uses";
export const UNHELD_SECTION = "value.unheld";

/** A declaration's row with its members as children, which both modes print, and where an unplaced one was found. */
function declarationTree(file: string, declaration: OutlineDeclaration): Row {
  const row = declarationRow(file, { ...declaration, children: [] });
  const placement = declaration.placement;
  const children = (declaration.children ?? []).map((child) => declarationTree(file, child));
  return {
    ...row,
    ...(placement === undefined ? {} : { qualifiers: [...(row.qualifiers ?? []), { name: "unplaced:", value: `${placement.reason} at ${placement.at.line}:${placement.at.column}` }] }),
    ...(children.length === 0 ? {} : { childrenAreAnswer: true as const, children }),
  };
}

const targetText = (item: OutlineImport): string =>
  item.target.kind === "repository" ? item.target.file
  : item.target.kind === "external" ? `${item.target.module} (package)`
  : `${item.specifier ?? "computed module"} (unresolved: ${item.target.reason})`;

function bindingRow(owner: string, binding: OutlineBinding): Row {
  const declaration = binding.declaration;
  const name = binding.local === undefined || binding.local === binding.imported ? binding.imported : `${binding.imported} as ${binding.local}`;
  return {
    key: [owner, "binding", canonicalJson(binding)].join("\0"),
    ...(declaration === undefined ? {} : { place: { path: declaration.file, line: declaration.line } }),
    label: `${binding.typeOnly === true ? "type " : ""}${name}`,
  };
}

/** The module statement at its own place, the declarations its names reach as children. */
function importRow(file: string, item: OutlineImport): Row {
  const key = [file, "import", canonicalJson(item)].join("\0");
  const qualifiers: Qualifier[] = item.form === undefined ? [] : [{ name: item.form }];
  const bindings = item.bindings.map((binding) => bindingRow(key, binding));
  return {
    key,
    place: { path: file, line: item.line, ...(item.endLine === item.line ? {} : { endLine: item.endLine }) },
    label: `${item.kind === "reexport" ? "re-export" : "import"} ${targetText(item)}`,
    ...(qualifiers.length === 0 ? {} : { qualifiers }),
    ...(bindings.length === 0 ? {} : { childrenAreAnswer: true as const, children: bindings }),
  };
}

/** One group per file: what it declares, then where its modules lead; a file with no declaration says so. */
function filesSection(value: Extract<OutlineValue, { files: readonly OutlineFile[] }>): Section {
  const rows = value.files.flatMap((file): Row[] => [
    ...(file.declarations.length === 0
      ? [{ key: [file.file, "none"].join("\0"), place: { path: file.file }, label: "declares nothing" }]
      : file.declarations.map((declaration) => declarationTree(file.file, declaration))),
    ...file.imports.map((item) => importRow(file.file, item)),
  ]);
  return { id: FILES_SECTION, title: "files", role: "answer", layout: "by-file", primary: true, rows };
}

const lineSelector = (selector: string): number | undefined => (/^\d+$/.test(selector) ? Number(selector) : undefined);

/** One row per matched declaration, its members under it; the selector that matched it is evidence when it is a line. */
function focusRow(match: OutlineFocus): Row {
  const row = declarationTree(match.file, match.declaration);
  const selected = lineSelector(match.selector);
  const path = match.path;
  const provenPath = path !== undefined && path !== match.declaration.name;
  const names = match.selector === match.declaration.name || match.selector === path;
  const qualifiers: Qualifier[] = [
    ...(provenPath ? [{ name: "path", value: path }] : []),
    ...(selected === undefined && !names ? [{ name: "selector", value: match.selector }] : []),
    ...(match.omitted === 0 ? [] : [{ name: "omitted", value: String(match.omitted) }]),
  ];
  const evidence: Place[] = selected === undefined ? [] : [{ path: match.file, line: selected }];
  return {
    ...row,
    key: [row.key, "focus", match.selector].join("\0"),
    ...(qualifiers.length === 0 ? {} : { qualifiers: [...(row.qualifiers ?? []), ...qualifiers] }),
    ...(evidence.length === 0 ? {} : { evidence }),
  };
}

function useTarget(use: OutlineUse): string {
  if ("declaration" in use) return use.declaration.name;
  return "module" in use ? `${use.module} (package)` : `${use.global} (global)`;
}

/** A use of the focused body: where it leads, how, and the lines of the body that use it. */
function useRow(match: OutlineFocus, use: OutlineUse, attributed: boolean): Row {
  const declaration = "declaration" in use ? use.declaration : undefined;
  const at = [...new Set(use.at.map(({ line }) => line))];
  const qualifiers: Qualifier[] = [
    ...(attributed ? [{ name: "of", value: match.selector }] : []),
    ...use.relations.map((relation) => ({ name: relation })),
    ...(at.length === 0 ? [] : [{ name: "at", value: at.join(", ") }]),
  ];
  return {
    key: canonicalJson([match.file, match.selector, use]),
    ...(declaration === undefined ? {} : { place: { path: declaration.file, line: declaration.line } }),
    label: useTarget(use),
    ...(qualifiers.length === 0 ? {} : { qualifiers }),
  };
}

/** What one match's body uses outside itself; a body that uses nothing says so, and nothing proven says only that. */
function usesRows(match: OutlineFocus, cuts: readonly Cut[], attributed: boolean): Row[] {
  if (match.uses === undefined) return [];
  if (match.uses.length > 0) return match.uses.map((use) => useRow(match, use, attributed));
  const unproved = hasUnprovedUses(cuts, match.file, match.path ?? match.selector);
  return [{
    key: canonicalJson([match.file, match.selector, "uses-nothing"]),
    label: unproved ? "uses nothing proven outside its body" : "uses nothing outside its body",
    ...(attributed ? { qualifiers: [{ name: "of", value: match.selector }] } : {}),
  }];
}

/** The containers of the focused declarations, each stated once whichever match reaches it. */
function ancestorsSection(matches: readonly OutlineFocus[]): Section {
  const rows = matches.flatMap((match) => match.ancestors.map((ancestor) => declarationTree(match.file, ancestor)));
  return { id: ANCESTORS_SECTION, title: "ancestors", role: "context", layout: "list", rows: [...new Map(rows.map((row) => [row.key, row] as const)).values()] };
}

function focusSections(value: Extract<OutlineValue, { focus: readonly OutlineFocus[] }>, cuts: readonly Cut[]): Section[] {
  const attributed = value.focus.length > 1;
  return [
    { id: FOCUS_SECTION, title: "focus", role: "answer", layout: "list", primary: true, rows: value.focus.map(focusRow) },
    { id: USES_SECTION, title: "uses", role: "answer", layout: "list", rows: value.focus.flatMap((match) => usesRows(match, cuts, attributed)) },
    ancestorsSection(value.focus),
  ];
}

function unheldSection(unheld: readonly string[]): Section {
  return {
    id: UNHELD_SECTION,
    title: "unheld files",
    role: "completeness",
    layout: "list",
    rows: unheld.map((file) => ({ key: [file, "unheld"].join("\0"), place: { path: file }, label: "declarations unknown" })),
  };
}

function outlineSections(fact: Exclude<Fact<OutlineValue>, { status: "unknown" }>): Section[] {
  const cuts = fact.status === "partial" ? fact.cuts : [];
  const value = fact.value;
  return [
    ...(value.focus === undefined ? [filesSection(value)] : focusSections(value, cuts)),
    ...(value.unheld.length === 0 ? [] : [unheldSection(value.unheld)]),
    cutSection(cuts),
  ];
}

/** An outline of the files requested, or only the declarations focus selectors matched. */
export function present(fact: Fact<OutlineValue>): Presentation {
  return {
    status: renderFactStatus(fact),
    snapshots: [fact.snapshot],
    narrowing: renderFactNarrowing(fact),
    sections: fact.status === "unknown" ? [] : outlineSections(fact),
  };
}
