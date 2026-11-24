import { snapshotLine } from "../presentation-context.ts";
import { preferShorterText, shareExactContext } from "../presentation-sharing.ts";
import type { ResponseMode } from "../presentation.ts";
import { LISTED_ITEMS } from "../render-budget.ts";
import type { Place, Presentation, Row, Section, SectionRole } from "./model.ts";

export interface PrintedRow { section: string; key: string }
export interface ElidedRows { section: string; rows: number }
export interface Written {
  text: string;
  /** The rows the text states, in print order; a counted completeness line states every row it groups. */
  printed: readonly PrintedRow[];
  elided: readonly ElidedRows[];
}
export interface WriteOptions {
  /** The most rows `summary` names one by one in a section; defaults to `LISTED_ITEMS`. */
  listedItems?: number;
}

interface Rendered { lines: string[]; printed: PrintedRow[]; elided: ElidedRows[] }
interface Context { section: Section; mode: ResponseMode; previousFile?: string; printed: PrintedRow[]; numbers: ReadonlyMap<Row, number> }

const ROLE_ORDER: readonly SectionRole[] = ["answer", "completeness", "context"];
const indent = (level: number) => "  ".repeat(level);
const fileKey = (place: Place) => `${place.repo ?? ""}\0${place.path}`;
const placeKey = (place: Place) => `${fileKey(place)}\0${place.line ?? ""}\0${place.endLine ?? ""}\0${place.via ?? ""}\0${place.confidence ?? ""}`;
const annotationText = (place: Place) => `${place.via === undefined ? "" : ` via ${place.via}`}${place.confidence === undefined ? "" : ` confidence ${place.confidence}`}`;
const spanText = (place: Place) => place.line === undefined ? "" : place.endLine === undefined ? `${place.line}` : `${place.line}-${place.endLine}`;
const fileText = (place: Place) => `${place.repo === undefined ? "" : `${place.repo}:`}${place.path}`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The reply text of a presentation in one mode: a pure function of its arguments (RFC-0041 §3.4, §3.5). */
export function write(presentation: Presentation, mode: ResponseMode, options: WriteOptions = {}): Written {
  const listed = options.listedItems ?? LISTED_ITEMS;
  const sections = ROLE_ORDER.flatMap((role) => presentation.sections.filter((section) => section.role === role && section.rows.length > 0)).map((section) => renderSection(section, mode, listed));
  const lines = [
    ...presentation.status,
    ...presentation.snapshots.map(snapshotLine),
    ...(presentation.narrowing ?? []),
    ...sections.flatMap((section) => section.lines),
    ...(presentation.next ?? []).map(({ cause, step }) => `next: ${step} (${cause})`),
  ];
  return { text: lines.join("\n"), printed: sections.flatMap((section) => section.printed), elided: sections.flatMap((section) => section.elided) };
}

function renderSection(section: Section, mode: ResponseMode, listed: number): Rendered {
  if (section.role === "completeness" && mode === "summary") return countedCauses(section);
  const full = layoutSection(section, section.rows, mode, []);
  const hidden = mode === "summary" ? hiddenRows(section, listed) : [];
  if (hidden.length === 0) return full;
  const counted = layoutSection(section, section.rows.filter((row) => !hidden.includes(row)), mode, hidden);
  return preferShorterText(full.lines.join("\n"), counted.lines.join("\n")) === full.lines.join("\n") ? full : counted;
}

function hiddenRows(section: Section, listed: number): readonly Row[] {
  if (section.role === "context") return section.rows.slice(listed);
  return section.rows.length > listed ? section.rows.filter((row) => (row.tier ?? 0) > 0) : [];
}

function layoutSection(section: Section, rows: readonly Row[], mode: ResponseMode, hidden: readonly Row[]): Rendered {
  const numbers = new Map(section.numbered === true ? section.rows.map((row, position) => [row, position] as const) : []);
  const context: Context = { section, mode, printed: [], numbers };
  const lines = [`${section.title}:`];
  if (section.layout === "by-file") {
    for (const [group, inGroup] of Map.groupBy(rows, (row) => row.place === undefined ? undefined : fileKey(row.place))) {
      if (group !== undefined) {
        lines.push(`${indent(1)}${fileText(inGroup[0]!.place!)}`);
      }
      lines.push(...sequence(inGroup, group === undefined ? 1 : 2, context, group));
    }
  } else lines.push(...sequence(rows, 1, context));
  const elided: ElidedRows[] = [];
  if (hidden.length > 0) {
    elided.push({ section: section.id, rows: hidden.length });
    lines.push(`${indent(1)}+${hidden.length} more${tierBreakdown(hidden)}: answer.json ${section.id}`);
  }
  return { lines, printed: context.printed, elided };
}

function tierBreakdown(hidden: readonly Row[]): string {
  if (hidden.every((row) => (row.tier ?? 0) === 0)) return "";
  const counts = [...Map.groupBy(hidden, (row) => row.tier ?? 0)].toSorted(([a], [b]) => a - b);
  return ` (${counts.map(([tier, ofTier]) => `tier ${tier}: ${ofTier.length}`).join(", ")})`;
}

function countedCauses(section: Section): Rendered {
  const groups = [...Map.groupBy(section.rows, (row) => row.label)];
  return {
    lines: [`${section.title}:`, ...groups.map(([label, ofLabel]) => `${indent(1)}${ofLabel.length === 1 ? "" : `${ofLabel.length} `}${label}`)],
    printed: section.rows.map((row) => ({ section: section.id, key: row.key })),
    elided: [],
  };
}

/** Rows of one level in order; in `details`, consecutive rows with equal evidence state it once (W4). */
function sequence(rows: readonly Row[], level: number, context: Context, group?: string): string[] {
  const blocks = rows.map((row) => block(row, level, context, group));
  if (context.mode === "summary") return blocks.flatMap(({ head, rest }) => [head, ...rest]);
  const sharing = shareExactContext(rows, (row) => row.evidence ?? []);
  const lines: string[] = [];
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    while (end < rows.length && sharing.rows[end]!.contextIndex === sharing.rows[start]!.contextIndex) end++;
    const run = rows.slice(start, end);
    const literal = run.flatMap((row, offset) => [blocks[start + offset]!.head, ...evidenceLines(row.evidence, row.place, level + 1), ...blocks[start + offset]!.rest]);
    const evidenceKeys = new Set((run[0]!.evidence ?? []).map(placeKey));
    const shareable = run.length > 1 && run.every((row) => row.place === undefined || !evidenceKeys.has(placeKey(row.place)));
    const shared = [...run.flatMap((_, offset) => [blocks[start + offset]!.head, ...blocks[start + offset]!.rest]), ...evidenceLines(run[0]!.evidence, undefined, level + 1)];
    lines.push(...(shareable && preferShorterText(literal.join("\n"), shared.join("\n")) !== literal.join("\n") ? shared : literal));
    start = end;
  }
  return lines;
}

function block(row: Row, level: number, context: Context, group?: string): { head: string; rest: string[] } {
  context.printed.push({ section: context.section.id, key: row.key });
  const place = placeText(row.place, context, group);
  const own = row.place === undefined ? [] : (row.evidence ?? []).filter((evidence) => placeKey(evidence) !== placeKey(row.place!));
  const facts = [
    ...(row.qualifiers ?? []).map(({ name, value }) => value === undefined ? name : `${name} ${value}`),
    ...(context.mode === "summary" && own.length > 0 ? [plural(own.length, "place")] : []),
  ];
  const number = context.numbers.get(row);
  const head = `${indent(level)}${number === undefined ? "" : `${number}. `}${place === "" ? "" : `${place} `}${row.label}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}`;
  const children = row.children !== undefined && (context.mode === "details" || row.childrenAreAnswer === true) ? sequence(row.children, level + 1, context, group) : [];
  return { head, rest: children };
}

function placeText(place: Place | undefined, context: Context, group: string | undefined): string {
  if (place === undefined) { delete context.previousFile; return ""; }
  const file = fileKey(place);
  if (file === group) return spanText(place);
  const previous = context.previousFile;
  context.previousFile = file;
  if (previous === file) return place.line === undefined ? "" : `:${spanText(place)}`;
  return place.line === undefined ? fileText(place) : `${fileText(place)}:${spanText(place)}`;
}

/** The evidence places that say something the row's own place does not; the row's own file is stated as lines. */
function evidenceLines(evidence: readonly Place[] | undefined, owner: Place | undefined, level: number): string[] {
  const news = (evidence ?? []).filter((place) => owner === undefined || placeKey(place) !== placeKey(owner));
  if (news.length === 0) return [];
  const ownFile = owner === undefined ? undefined : fileKey(owner);
  const items = [...Map.groupBy(news, (place) => `${fileKey(place)}\0${annotationText(place)}`)].flatMap(([, inFile]) => {
    const annotation = annotationText(inFile[0]!);
    return fileKey(inFile[0]!) === ownFile
      ? inFile.map((place) => `:${spanText(place)}${annotation}`)
      : [`${fileText(inFile[0]!)}${inFile.some((place) => place.line !== undefined) ? `:${inFile.map(spanText).join(",")}` : ""}${annotation}`];
  });
  return [`${indent(level)}evidence: ${items.join(", ")}`];
}
