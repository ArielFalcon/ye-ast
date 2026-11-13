/**
 * The occurrence oracle of the corpus gate (RFC-0031): for each answer that asks what depends on a declaration, every
 * line of the answer's snapshot that writes the declaration's name, classed by what the answer says about that line.
 * Pure: the lines come from an injected reader, so nothing here reads git, a file or a clock.
 *
 * The facts contract makes the classes meaningful: every place that writes a target's name is the target itself, a
 * dependent the answer lists, a place a cut of the answer covers, outside the answer's declared scope, or a place the
 * engine proved binds something else. The oracle resolves nothing, so it cannot tell that last group from a silent
 * omission: `unaccounted` is an upper bound of the omissions, and each unaccounted line is a lead to audit, not a defect.
 * A homonym (another declaration of the same name) gives unaccounted lines that are correct omissions; a name written in
 * a comment or a string is counted; a dependent that does not write the name (an alias, reflection) is not seen.
 *
 * The targets are the seeds of a `callers` or `impact` answer, each named by the text after the last `.` of its symbol;
 * an occurrence is a line of a text file of the snapshot's commit (the `head` of a live one) that writes that name as a
 * whole word. A line is classed by the first rule that holds:
 *   - `target`: inside the target's own lines;
 *   - `listed`: inside the lines of a symbol, an entrypoint's handler or a route's declaration the answer lists, at a
 *     line a symbol's `via` names in its own file or its `resource`, or in a file a reached module names (no lines);
 *   - `cut`: at a `path:line` place a cut names in `at`, at the place of a `call-at` reach, in the importer of a `module`
 *     reach, in a file of the runtime of an `anything` reach that names one, or anywhere under one that names none;
 *   - `out-of-scope`: in a path the declared scope's globs leave out, or whose runtime is none of its languages;
 *   - `unaccounted`: none of the above.
 */
import { posix } from "node:path";
import { fileReach } from "../src/core/domain/languages/call-targets.ts";
import { pathSelection } from "../src/core/domain/shared/scope.ts";
import { type Answer, compareText, isObject, topFact } from "./corpus-gate-diff.ts";
import { languageOf } from "./corpus-gate-ledger.ts";

export const OCCURRENCE_CLASSES = ["target", "listed", "cut", "out-of-scope", "unaccounted"] as const;
export type OccurrenceClass = (typeof OCCURRENCE_CLASSES)[number];
export type ClassCounts = Record<OccurrenceClass, number>;

/** The families whose answers state, as seeds, the declarations whose dependents they list. */
const TARGET_FAMILIES: ReadonlySet<string> = new Set(["callers", "impact"]);

/** One line of a snapshot that writes a name. */
export interface WrittenLine {
  file: string;
  line: number;
  text: string;
}

/** The lines of the commit `commit` of the repository `repo` (as the answer `answer` names it) that write `name` as a word. */
export type WrittenAt = (answer: Answer, repo: string, commit: string, name: string) => readonly WrittenLine[];

export interface Lead extends WrittenLine, OccurrenceKey {
  answer: string;
  /** The target as a cut anchors a declaration: `file::symbol`. */
  target: string;
  /** Whether the answer lists anything in the lead's file. */
  fileListed: boolean;
}

export interface OccurrenceLedger {
  /** The answers that stated at least one target. */
  answers: number;
  rows: (OccurrenceKey & { counts: ClassCounts })[];
  /** Every unaccounted line, sorted by answer, target, file and line. */
  unaccounted: Lead[];
}

export interface OccurrenceDifferenceRow extends OccurrenceKey {
  base: number;
  candidate: number;
  /** The unaccounted lines of the base the candidate no longer leaves unaccounted. */
  left: Lead[];
  /** The unaccounted lines of the candidate the base did not leave unaccounted. */
  entered: Lead[];
}

export interface OccurrenceKey {
  family: string;
  /** The language whose profile reads the target's file. */
  language: string;
}

interface Target {
  file: string;
  symbol: string;
  line: number;
  endLine: number;
}

interface Span {
  file: string;
  line: number;
  endLine: number;
}

/** What one answer says about places: what it lists, what its cuts cover, and what its scope leaves out. */
interface Accounts {
  listed: Span[];
  /** The files a reached module names, which it lists without lines. */
  wholeFiles: Set<string>;
  listedFiles: Set<string>;
  cutPlaces: Set<string>;
  cutFiles: Set<string>;
  cutRuntimes: Set<string>;
  cutsEverything: boolean;
  inScope: (file: string) => boolean;
}

export function occurrenceLedger(answers: readonly Answer[], writtenAt: WrittenAt): OccurrenceLedger {
  const rows = new Map<string, OccurrenceKey & { counts: ClassCounts }>();
  const unaccounted: Lead[] = [];
  let answered = 0;
  for (const answer of answers) {
    const question = questionOf(answer);
    if (question === null) continue;
    answered += 1;
    const { snapshot, targets, accounts } = question;
    for (const target of targets) {
      const key = { family: answer.family, language: languageOf(target.file) };
      const row = rows.get(keyText(key)) ?? { ...key, counts: emptyCounts() };
      rows.set(keyText(key), row);
      for (const written of writtenAt(answer, snapshot.repo, snapshot.commit, nameOf(target.symbol))) {
        const classed = classOf(written, target, accounts);
        row.counts[classed] += 1;
        if (classed === "unaccounted") unaccounted.push({ ...key, answer: answer.id, target: `${target.file}::${target.symbol}`, ...written, text: written.text.trim(), fileListed: accounts.listedFiles.has(written.file) });
      }
    }
  }
  return { answers: answered, rows: [...rows.entries()].sort(([a], [b]) => compareText(a, b)).map(([, row]) => row), unaccounted: unaccounted.sort(compareLeads) };
}

/** Per family and language, the unaccounted lines of each side and those that left and entered the class. */
export function occurrenceDifference(base: OccurrenceLedger, candidate: OccurrenceLedger): OccurrenceDifferenceRow[] {
  const baseLeads = new Set(base.unaccounted.map(leadKey));
  const candidateLeads = new Set(candidate.unaccounted.map(leadKey));
  const rows = new Map<string, OccurrenceDifferenceRow>();
  for (const { family, language } of [...base.rows, ...candidate.rows]) rows.set(keyText({ family, language }), { family, language, base: 0, candidate: 0, left: [], entered: [] });
  for (const lead of base.unaccounted) {
    const row = rows.get(keyText(lead)) as OccurrenceDifferenceRow;
    row.base += 1;
    if (!candidateLeads.has(leadKey(lead))) row.left.push(lead);
  }
  for (const lead of candidate.unaccounted) {
    const row = rows.get(keyText(lead)) as OccurrenceDifferenceRow;
    row.candidate += 1;
    if (!baseLeads.has(leadKey(lead))) row.entered.push(lead);
  }
  return [...rows.entries()].sort(([a], [b]) => compareText(a, b)).map(([, row]) => row);
}

/** The leads file: one unaccounted line per row, tab-separated, the line's text last. */
export function leadsText(ledger: OccurrenceLedger): string {
  const rows = ledger.unaccounted.map((lead) => [lead.answer, lead.target, `${lead.file}:${lead.line}`, lead.fileListed ? "listed-file" : "unlisted-file", lead.text].join("\t"));
  return `${["answer", "target", "place", "listed", "text"].join("\t")}\n${rows.map((row) => `${row}\n`).join("")}`;
}

function questionOf(answer: Answer): { snapshot: { repo: string; commit: string }; targets: Target[]; accounts: Accounts } | null {
  if (!TARGET_FAMILIES.has(answer.family) || answer.exit !== 0) return null;
  const fact = topFact(answer.stdout);
  if (fact === null || !isObject(fact.value) || !isObject(fact.snapshot)) return null;
  const snapshot = snapshotOf(fact.snapshot);
  const targets = spans(fact.value.seeds).flatMap(({ file, line, endLine, symbol }): Target[] => (typeof symbol === "string" ? [{ file, line, endLine, symbol }] : []));
  if (snapshot === null || targets.length === 0) return null;
  return { snapshot, targets, accounts: accountsOf(fact) };
}

function snapshotOf(snapshot: Record<string, unknown>): { repo: string; commit: string } | null {
  const commit = snapshot.kind === "live" ? snapshot.head : snapshot.sha;
  return typeof snapshot.repo === "string" && typeof commit === "string" ? { repo: snapshot.repo, commit } : null;
}

function accountsOf(fact: Record<string, unknown>): Accounts {
  const value = fact.value as Record<string, unknown>;
  const listed: Span[] = [...spans(value.symbols)];
  for (const symbol of arrayOf(value.symbols)) {
    const via = symbol.via;
    if (!isObject(via) || !Array.isArray(via.lines)) continue;
    const file = typeof via.resource === "string" ? via.resource : symbol.file;
    if (typeof file === "string") for (const line of via.lines) if (typeof line === "number") listed.push({ file, line, endLine: line });
  }
  for (const entrypoint of arrayOf(value.entrypoints)) for (const place of [entrypoint.handler, entrypoint.declaredAt]) if (isObject(place)) listed.push(...spans([{ ...place, file: place.path }]));
  const wholeFiles = new Set(arrayOf(isObject(value.modules) ? value.modules.modules : undefined).flatMap((module) => (typeof module.file === "string" ? [module.file] : [])));
  const listedFiles = new Set([...listed.map((span) => span.file), ...wholeFiles]);
  const accounts: Accounts = { listed, wholeFiles, listedFiles, cutPlaces: new Set(), cutFiles: new Set(), cutRuntimes: new Set(), cutsEverything: false, inScope: scopeOf(fact.inputs) };
  for (const cut of arrayOf(fact.cuts)) {
    for (const entry of Array.isArray(cut.at) ? cut.at : []) {
      const place = typeof entry === "string" ? placeOf(entry) : null;
      if (place !== null) accounts.cutPlaces.add(place);
    }
    const reach = isObject(cut.reach) ? cut.reach : {};
    if (reach.kind === "anything" && typeof reach.runtime === "string") accounts.cutRuntimes.add(reach.runtime);
    else if (reach.kind === "anything") accounts.cutsEverything = true;
    else if (reach.kind === "module" && typeof reach.importer === "string") accounts.cutFiles.add(reach.importer);
    else if (reach.kind === "call-at" && typeof reach.place === "string" && placeOf(reach.place) !== null) accounts.cutPlaces.add(placeOf(reach.place) as string);
  }
  return accounts;
}

/** What the fact declares in scope: the paths its globs select whose runtime is one of its languages; everything when it declares none. */
function scopeOf(inputs: unknown): (file: string) => boolean {
  const scope = isObject(inputs) && isObject(inputs.declaredScope) ? inputs.declaredScope : null;
  if (scope === null) return () => true;
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  const selected = pathSelection({ include: strings(scope.include), exclude: strings(scope.exclude) }, posix.matchesGlob);
  const languages = new Set(strings(scope.languages));
  return (file) => selected(file) && languages.has(runtimeOf(file) ?? "");
}

function classOf(written: WrittenLine, target: Target, accounts: Accounts): OccurrenceClass {
  if (within(written, target)) return "target";
  if (accounts.wholeFiles.has(written.file) || accounts.listed.some((span) => within(written, span))) return "listed";
  if (cutCovers(written, accounts)) return "cut";
  if (!accounts.inScope(written.file)) return "out-of-scope";
  return "unaccounted";
}

function cutCovers({ file, line }: WrittenLine, accounts: Accounts): boolean {
  return accounts.cutsEverything || accounts.cutPlaces.has(`${file}:${line}`) || accounts.cutFiles.has(file) || accounts.cutRuntimes.has(runtimeOf(file) ?? "");
}

/** The runtime the engine places a file in, as a cut at that file would name it; none for a file no language writes. */
function runtimeOf(file: string): string | undefined {
  const reach = fileReach(file);
  return reach.kind === "anything" ? reach.runtime : undefined;
}

function within({ file, line }: WrittenLine, span: Span): boolean {
  return file === span.file && line >= span.line && line <= span.endLine;
}

/** The `path:line` of a `Cut.at` place, without the reference written after it; null for a file or a `file::declaration` anchor. */
function placeOf(entry: string): string | null {
  const match = /^(.*?):(\d+)(?: |$)/su.exec(entry);
  return match === null || match[1]!.includes("::") ? null : `${match[1]}:${match[2]}`;
}

/** The entries of a list that state a file and a first line, each with its last line (its first when it states none). */
function spans(list: unknown): (Span & Record<string, unknown>)[] {
  return arrayOf(list).flatMap((entry) => (typeof entry.file === "string" && typeof entry.line === "number" ? [{ ...entry, file: entry.file, line: entry.line, endLine: typeof entry.endLine === "number" ? entry.endLine : entry.line }] : []));
}

function arrayOf(list: unknown): Record<string, unknown>[] {
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function nameOf(symbol: string): string {
  return symbol.slice(symbol.lastIndexOf(".") + 1);
}

function leadKey(lead: Lead): string {
  return [lead.answer, lead.target, lead.file, lead.line].join("\0");
}

function compareLeads(a: Lead, b: Lead): number {
  return compareText(a.answer, b.answer) || compareText(a.target, b.target) || compareText(a.file, b.file) || a.line - b.line;
}

function keyText({ family, language }: OccurrenceKey): string {
  return [family, language].join("\0");
}

function emptyCounts(): ClassCounts {
  return { target: 0, listed: 0, cut: 0, "out-of-scope": 0, unaccounted: 0 };
}
