/**
 * The occurrence oracle of the corpus gate (RFC-0031): for each answer that asks what depends on a declaration, every
 * line of the answer's snapshot that writes the declaration's name, classed by what the answer says about that line.
 * Pure: the lines and what the engine's own readers relate in the snapshot come from injected readers, so nothing here
 * reads git, a file or a clock.
 *
 * The facts contract makes the classes meaningful: every place that writes a target's name is the target itself, a
 * dependent the answer lists, a place a cut of the answer covers, outside the answer's declared scope, or a place the
 * engine proved binds something else. The oracle resolves no reference, so it cannot tell that last group from a silent
 * omission: `unaccounted` is an upper bound of the omissions, and each unaccounted line is a lead to audit, not a defect.
 *
 * The targets are the seeds of a `callers` or `impact` answer, each named by the text after the last `.` of its symbol.
 * An occurrence is a line of a text file of the snapshot's commit (the `head` of a live one) that writes that name as a
 * whole word, in a file of the target's own runtime as the engine places files (`fileReach`): a declaration of one
 * language is not bound from another's source. A line is classed by the first rule that holds:
 *   - `target`: inside the target's own lines;
 *   - `listed`: inside the lines of a symbol, an entrypoint's handler or a route's declaration the answer lists, at a
 *     line a symbol's `via` names in its own file or its `resource`, in a file a reached module names (no lines), in the
 *     template of a component the answer lists or seeds, or, in a file one of whose declarations the answer lists, on a
 *     static import or re-export statement or a decorator line of a listed declaration;
 *   - `unnamed-markup`: in a markup file no component of the snapshot names as its template;
 *   - `cut`: at a `path:line` place a cut names in `at`, at the place of a `call-at` reach, in the importer of a `module`
 *     reach, in a file of the runtime of an `anything` reach that names one, or anywhere under one that names none;
 *   - `cut-by-reach`: anywhere under a cut whose `callers-of` reach lists the target, which admits omissions away from
 *     where the cut sits;
 *   - `out-of-scope`: in a path the declared scope's globs leave out, or whose runtime is none of its languages;
 *   - `test-source`: in a file the engine reads as a test (`kindOfChangedFile`), whose edges are not callers (RFC-0010);
 *   - `text`: every time the line writes the name, inside a comment or a string literal (a module specifier is one);
 *   - `cannot-name`: in a file that cannot name the target: not the target's file, and for TypeScript no import or
 *     re-export of the file leads to the target's file or to a file that re-exports from it, and for a template none
 *     of the components naming it can name the target; for Java not in the target's package, importing neither its
 *     type, a type around it nor its package, and not writing its qualified name;
 *   - `unaccounted`: none of the above.
 *
 * What relates files is what the engine's own readers read from the snapshot: the module statements its TypeScript
 * and Java readers resolve (path aliases and barrels included), the package each Java source declares, and the
 * templates its Angular declaration reader finds named in `templateUrl`. A file a reader could not read, and one with a
 * module statement the reader leaves unresolved without proving that no path of the snapshot is its target, may name
 * anything.
 *
 * The lexical rule of `text`, for TypeScript and Java: a comment runs from `//` to the end of the line or from `/*` to
 * `*\/`; a string from a quote to the same unescaped quote on its line, or for Java a text block from `"""` to `"""`; a
 * TypeScript template literal without `${` is a string. A template literal with an expression, a regular expression
 * literal, a string that does not close on its line and a comment that does not close are read as unknown, so a line
 * that writes the name there is never `text`. A decorator line is one of a run of lines directly above a declaration's
 * first line that starts with `@` and whose brackets, outside comments and strings, close at the declaration.
 *
 * What the oracle cannot see: a homonym in a file that can name the target gives unaccounted lines that are correct
 * omissions; a member reached through a receiver whose type the file never imports is `cannot-name`; a dependent that
 * does not write the name (an alias, reflection) is not seen.
 */
import { posix } from "node:path";
import { kindOfChangedFile } from "../src/core/domain/change/changed-file.ts";
import type { ModuleDependency, UntraversedReference } from "../src/core/domain/impact/module-dependency.ts";
import { fileReach } from "../src/core/domain/languages/call-targets.ts";
import { isJavaSource } from "../src/core/domain/languages/java.ts";
import { isAngularTemplate, isTypeScriptFile } from "../src/core/domain/languages/typescript.ts";
import { pathSelection } from "../src/core/domain/shared/scope.ts";
import { type Answer, compareText, isObject, topFact } from "./corpus-gate-diff.ts";
import { languageOf } from "./corpus-gate-ledger.ts";

export const OCCURRENCE_CLASSES = ["target", "listed", "unnamed-markup", "cut", "cut-by-reach", "out-of-scope", "test-source", "text", "cannot-name", "unaccounted"] as const;
export type OccurrenceClass = (typeof OCCURRENCE_CLASSES)[number];
export type ClassCounts = Record<OccurrenceClass, number>;

/** The classes the oracle sets apart from `unaccounted` by a rule of its own, whose lines an auditor can still read. */
export const SET_APART_CLASSES: readonly OccurrenceClass[] = ["unnamed-markup", "cut-by-reach", "test-source", "text", "cannot-name"];

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

/** A component the engine's Angular reader finds, with the repository paths its decorator names. */
export interface NamedComponent {
  file: string;
  line: number;
  resources: readonly string[];
}

/** What the engine's own readers relate in one snapshot. */
export interface SnapshotRelations {
  /** The module statements its TypeScript and Java readers resolve; a Java one's specifier is the name it imports. */
  dependencies: readonly (Pick<ModuleDependency, "file" | "line" | "endLine" | "specifier" | "kind" | "target" | "namesNoFile"> & { form?: ModuleDependency["form"] | UntraversedReference["form"] })[];
  /** The sources a reader could not read. */
  unread: ReadonlySet<string>;
  /** The package each Java source declares. */
  packages: ReadonlyMap<string, string>;
  components: readonly NamedComponent[];
  /** The text of a TypeScript or Java source of the snapshot. */
  textOf: (file: string) => string | undefined;
}

/** What the engine's readers relate in the commit `commit` of the repository `repo`, as the answer `answer` names it. */
export type RelationsAt = (answer: Answer, repo: string, commit: string) => SnapshotRelations;

export interface Lead extends WrittenLine, OccurrenceKey {
  answer: string;
  /** The target as a cut anchors a declaration: `file::symbol`. */
  target: string;
  /** Whether the answer lists anything in the lead's file. */
  fileListed: boolean;
}

export interface SetApartLine extends Lead {
  class: OccurrenceClass;
}

export interface OccurrenceLedger {
  /** The answers that stated at least one target. */
  answers: number;
  rows: (OccurrenceKey & { counts: ClassCounts })[];
  /** Every unaccounted line, sorted by answer, target, file and line. */
  unaccounted: Lead[];
  /** Every line of a set-apart class, sorted by class, answer, target, file and line. */
  setApart: SetApartLine[];
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
  /** The declarations the answer lists or seeds. */
  declarations: Span[];
  /** The files a reached module names, which it lists without lines. */
  wholeFiles: Set<string>;
  listedFiles: Set<string>;
  cutPlaces: Set<string>;
  cutFiles: Set<string>;
  cutRuntimes: Set<string>;
  cutsEverything: boolean;
  /** The declarations, as `file::symbol`, a `callers-of` reach of a cut names. */
  callersCut: Set<string>;
  inScope: (file: string) => boolean;
}

interface Question {
  snapshot: { repo: string; commit: string };
  targets: Target[];
  accounts: Accounts;
}

/** The snapshot of each answer that states at least one target. */
export function occurrenceSnapshots(answers: readonly Answer[]): { answer: Answer; repo: string; commit: string }[] {
  return answers.flatMap((answer) => {
    const question = questionOf(answer);
    return question === null ? [] : [{ answer, ...question.snapshot }];
  });
}

export function occurrenceLedger(answers: readonly Answer[], writtenAt: WrittenAt, relationsAt: RelationsAt): OccurrenceLedger {
  const rows = new Map<string, OccurrenceKey & { counts: ClassCounts }>();
  const unaccounted: Lead[] = [];
  const setApart: SetApartLine[] = [];
  let answered = 0;
  for (const answer of answers) {
    const question = questionOf(answer);
    if (question === null) continue;
    answered += 1;
    const { snapshot, targets, accounts } = question;
    const relations = readingOf(relationsAt(answer, snapshot.repo, snapshot.commit));
    for (const target of targets) {
      const key = { family: answer.family, language: languageOf(target.file) };
      const row = rows.get(keyText(key)) ?? { ...key, counts: emptyCounts() };
      rows.set(keyText(key), row);
      const name = nameOf(target.symbol);
      const runtime = runtimeOf(target.file);
      const canName = namerOf(target, relations);
      for (const written of writtenAt(answer, snapshot.repo, snapshot.commit, name)) {
        if (runtimeOf(written.file) !== runtime) continue;
        const classed = classOf(written, target, name, accounts, relations, canName);
        row.counts[classed] += 1;
        if (classed !== "unaccounted" && !SET_APART_CLASSES.includes(classed)) continue;
        const lead: Lead = { ...key, answer: answer.id, target: `${target.file}::${target.symbol}`, ...written, text: written.text.trim(), fileListed: accounts.listedFiles.has(written.file) };
        if (classed === "unaccounted") unaccounted.push(lead);
        else setApart.push({ ...lead, class: classed });
      }
    }
  }
  return {
    answers: answered,
    rows: [...rows.entries()].sort(([a], [b]) => compareText(a, b)).map(([, row]) => row),
    unaccounted: unaccounted.sort(compareLeads),
    setApart: setApart.sort((a, b) => OCCURRENCE_CLASSES.indexOf(a.class) - OCCURRENCE_CLASSES.indexOf(b.class) || compareLeads(a, b)),
  };
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
  const rows = ledger.unaccounted.map((lead) => leadCells(lead).join("\t"));
  return `${["answer", "target", "place", "listed", "text"].join("\t")}\n${rows.map((row) => `${row}\n`).join("")}`;
}

/** The set-apart file: one line of a set-apart class per row, its class first, tab-separated, the line's text last. */
export function setApartText(ledger: OccurrenceLedger): string {
  const rows = ledger.setApart.map((line) => [line.class, ...leadCells(line)].join("\t"));
  return `${["class", "answer", "target", "place", "listed", "text"].join("\t")}\n${rows.map((row) => `${row}\n`).join("")}`;
}

function leadCells(lead: Lead): string[] {
  return [lead.answer, lead.target, `${lead.file}:${lead.line}`, lead.fileListed ? "listed-file" : "unlisted-file", lead.text];
}

function questionOf(answer: Answer): Question | null {
  if (!TARGET_FAMILIES.has(answer.family) || answer.exit !== 0) return null;
  const fact = topFact(answer.stdout);
  if (fact === null || !isObject(fact.value) || !isObject(fact.snapshot)) return null;
  const snapshot = snapshotOf(fact.snapshot);
  const targets = spans(fact.value.seeds).flatMap(({ file, line, endLine, symbol }): Target[] => (typeof symbol === "string" ? [{ file, line, endLine, symbol }] : []));
  if (snapshot === null || targets.length === 0) return null;
  return { snapshot, targets, accounts: accountsOf(fact, targets) };
}

function snapshotOf(snapshot: Record<string, unknown>): { repo: string; commit: string } | null {
  const commit = snapshot.kind === "live" ? snapshot.head : snapshot.sha;
  return typeof snapshot.repo === "string" && typeof commit === "string" ? { repo: snapshot.repo, commit } : null;
}

function accountsOf(fact: Record<string, unknown>, targets: readonly Target[]): Accounts {
  const value = fact.value as Record<string, unknown>;
  const declarations: Span[] = [...spans(value.symbols)];
  for (const entrypoint of arrayOf(value.entrypoints)) if (isObject(entrypoint.handler)) declarations.push(...spans([{ ...entrypoint.handler, file: entrypoint.handler.path }]));
  const listed: Span[] = [...declarations];
  for (const symbol of arrayOf(value.symbols)) {
    const via = symbol.via;
    if (!isObject(via) || !Array.isArray(via.lines)) continue;
    const file = typeof via.resource === "string" ? via.resource : symbol.file;
    if (typeof file === "string") for (const line of via.lines) if (typeof line === "number") listed.push({ file, line, endLine: line });
  }
  for (const entrypoint of arrayOf(value.entrypoints)) if (isObject(entrypoint.declaredAt)) listed.push(...spans([{ ...entrypoint.declaredAt, file: entrypoint.declaredAt.path }]));
  const wholeFiles = new Set(arrayOf(isObject(value.modules) ? value.modules.modules : undefined).flatMap((module) => (typeof module.file === "string" ? [module.file] : [])));
  const listedFiles = new Set([...listed.map((span) => span.file), ...wholeFiles]);
  const accounts: Accounts = { listed, declarations: [...declarations, ...targets], wholeFiles, listedFiles, cutPlaces: new Set(), cutFiles: new Set(), cutRuntimes: new Set(), cutsEverything: false, callersCut: new Set(), inScope: scopeOf(fact.inputs) };
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
    else if (reach.kind === "callers-of" && Array.isArray(reach.declarations)) for (const declaration of reach.declarations) if (typeof declaration === "string") accounts.callersCut.add(declaration);
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

function classOf(written: WrittenLine, target: Target, name: string, accounts: Accounts, relations: Reading, canName: (file: string) => boolean): OccurrenceClass {
  if (within(written, target)) return "target";
  if (isListed(written, accounts, relations)) return "listed";
  if (isAngularTemplate(written.file) && relations.componentsNaming(written.file).length === 0) return "unnamed-markup";
  if (cutCovers(written, accounts)) return "cut";
  if (accounts.callersCut.has(`${target.file}::${target.symbol}`)) return "cut-by-reach";
  if (!accounts.inScope(written.file)) return "out-of-scope";
  if (kindOfChangedFile(written.file) === "test") return "test-source";
  if (relations.writesOnlyText(written, name)) return "text";
  if (!canName(written.file)) return "cannot-name";
  return "unaccounted";
}

function isListed(written: WrittenLine, accounts: Accounts, relations: Reading): boolean {
  if (accounts.wholeFiles.has(written.file) || accounts.listed.some((span) => within(written, span))) return true;
  if (relations.componentsNaming(written.file).some((component) => accounts.declarations.some((span) => within(component, span)))) return true;
  const declared = accounts.declarations.filter((span) => span.file === written.file);
  if (declared.length === 0) return false;
  return relations.importLines(written.file).some((span) => within(written, span)) || declared.some((span) => relations.decoratorLines(span).includes(written.line));
}

/**
 * Whether a file can name the target: for TypeScript, the target's file, a file that re-exports from it, or one whose
 * module statement leads there or stays unresolved; a template through the components naming it; for Java, the
 * target's package, an import of its type, a type around it or its package, or its qualified name written; any file a
 * reader could not read.
 */
function namerOf(target: Target, relations: Reading): (file: string) => boolean {
  const named = new Map<string, boolean>();
  const reexporting = reexportClosure(target.file, relations);
  const javaNames = javaNamesOf(target, relations);
  const namesTypeScript = (file: string): boolean => reexporting.has(file) || relations.dependenciesOf(file).some(({ target: reached, namesNoFile }) => (reached.kind === "unresolved" && namesNoFile !== true) || (reached.kind === "repository" && reexporting.has(reached.file)));
  const namesJava = (file: string): boolean => {
    if (javaNames === undefined || file === target.file) return true;
    const { packageName, qualified } = javaNames;
    if (relations.packages.get(file) === packageName) return true;
    if (relations.dependenciesOf(file).some(({ specifier }) => specifier === qualified || specifier.startsWith(`${qualified}.`) || specifier === `${packageName}.*`)) return true;
    return new RegExp(`(?<![\\w$.])${escaped(qualified)}(?![\\w$])`, "u").test(relations.textOf(file) ?? "");
  };
  const canName = (file: string): boolean => {
    const known = named.get(file);
    if (known !== undefined) return known;
    named.set(file, true);
    const result = relations.unread.has(file)
      || (isAngularTemplate(file) ? relations.componentsNaming(file).some((component) => canName(component.file))
        : isJavaSource(file) ? namesJava(file)
          : isTypeScriptFile(file) ? namesTypeScript(file)
            : true);
    named.set(file, result);
    return result;
  };
  return canName;
}

/** The target's file and every file that re-exports, directly or through another, from it. */
function reexportClosure(file: string, relations: Reading): Set<string> {
  const closure = new Set([file]);
  for (let grew = true; grew;) {
    grew = false;
    for (const dependency of relations.reexports) {
      if (dependency.target.kind !== "repository" || !closure.has(dependency.target.file) || closure.has(dependency.file)) continue;
      closure.add(dependency.file);
      grew = true;
    }
  }
  return closure;
}

/** The package of a Java target's file and the qualified name of the top-level type that holds it; none when its package is not known. */
function javaNamesOf(target: Target, relations: Reading): { packageName: string; qualified: string } | undefined {
  if (!isJavaSource(target.file)) return undefined;
  const packageName = relations.packages.get(target.file);
  if (packageName === undefined) return undefined;
  const type = target.symbol.split(".")[0]!;
  return { packageName, qualified: packageName === "" ? type : `${packageName}.${type}` };
}

interface Reading extends SnapshotRelations {
  reexports: SnapshotRelations["dependencies"];
  dependenciesOf: (file: string) => SnapshotRelations["dependencies"];
  importLines: (file: string) => Span[];
  componentsNaming: (template: string) => (NamedComponent & Span)[];
  decoratorLines: (declaration: Span) => number[];
  writesOnlyText: (written: WrittenLine, name: string) => boolean;
}

/** The relations of a snapshot, indexed by file, with each source lexed once. */
function readingOf(relations: SnapshotRelations): Reading {
  const byFile = new Map<string, SnapshotRelations["dependencies"][number][]>();
  for (const dependency of relations.dependencies) byFile.set(dependency.file, [...(byFile.get(dependency.file) ?? []), dependency]);
  const byTemplate = new Map<string, (NamedComponent & Span)[]>();
  for (const component of relations.components) for (const resource of component.resources) byTemplate.set(resource, [...(byTemplate.get(resource) ?? []), { ...component, endLine: component.line }]);
  const lexed = new Map<string, LexedSource | undefined>();
  const lexedOf = (file: string): LexedSource | undefined => {
    if (!lexed.has(file)) {
      const text = relations.textOf(file);
      lexed.set(file, text === undefined || !(isTypeScriptFile(file) || isJavaSource(file)) ? undefined : lexedSource(text, isJavaSource(file) ? "java" : "typescript"));
    }
    return lexed.get(file);
  };
  return {
    ...relations,
    reexports: relations.dependencies.filter((dependency) => dependency.kind === "reexport"),
    dependenciesOf: (file) => byFile.get(file) ?? [],
    importLines: (file) => (byFile.get(file) ?? []).filter(({ form }) => form === undefined || form === "import-equals").map(({ line, endLine }) => ({ file, line, endLine })),
    componentsNaming: (template) => byTemplate.get(template) ?? [],
    decoratorLines: (declaration) => lexedOf(declaration.file)?.decoratorLinesAbove(declaration.line) ?? [],
    writesOnlyText: ({ file, line }, name) => lexedOf(file)?.writesOnlyText(line, name) ?? false,
  };
}

const CODE = 0;
const TEXT = 1;
const UNKNOWN = 2;

interface LexedSource {
  writesOnlyText: (line: number, name: string) => boolean;
  decoratorLinesAbove: (line: number) => number[];
}

/** A source with the kind of each of its characters, code, comment or string text, or unknown, by the stated lexical rule. */
function lexedSource(text: string, language: "typescript" | "java"): LexedSource {
  const kinds = lexicalKinds(text, language);
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") starts.push(index + 1);
  const lineOf = (line: number): { start: number; text: string } | undefined => {
    const start = starts[line - 1];
    if (start === undefined) return undefined;
    const end = starts[line] === undefined ? text.length : starts[line]! - 1;
    return { start, text: text.slice(start, end) };
  };
  const brackets = (line: number): number | undefined => {
    const read = lineOf(line);
    if (read === undefined) return undefined;
    let depth = 0;
    for (let offset = 0; offset < read.text.length; offset += 1) {
      const kind = kinds[read.start + offset];
      if (kind === UNKNOWN) return undefined;
      if (kind !== CODE) continue;
      const character = read.text[offset]!;
      if ("([{".includes(character)) depth += 1;
      else if (")]}".includes(character)) depth -= 1;
    }
    return depth;
  };
  return {
    writesOnlyText(line, name) {
      const read = lineOf(line);
      if (read === undefined) return false;
      let found = false;
      for (const match of read.text.matchAll(new RegExp(`(?<![A-Za-z0-9_])${escaped(name)}(?![A-Za-z0-9_])`, "gu"))) {
        found = true;
        for (let offset = match.index; offset < match.index + name.length; offset += 1) if (kinds[read.start + offset] !== TEXT) return false;
      }
      return found;
    },
    decoratorLinesAbove(line) {
      let first: number | undefined;
      for (let start = line - 1; start >= 1 && (lineOf(start)?.text.trim() ?? "") !== ""; start -= 1) {
        if (!lineOf(start)!.text.trimStart().startsWith("@")) continue;
        let depth = 0;
        let run = true;
        for (let current = start; current < line && run; current += 1) {
          const opened = brackets(current);
          if (opened === undefined || (depth === 0 && !lineOf(current)!.text.trimStart().startsWith("@"))) run = false;
          else depth += opened;
          if (depth < 0) run = false;
        }
        if (run && depth === 0) first = start;
      }
      return first === undefined ? [] : Array.from({ length: line - first }, (_, offset) => first! + offset);
    },
  };
}

/** The keywords after which a TypeScript `/` starts a regular expression rather than a division. */
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

function lexicalKinds(text: string, language: "typescript" | "java"): Uint8Array {
  const kinds = new Uint8Array(text.length);
  const fill = (from: number, to: number, kind: number) => kinds.fill(kind, from, Math.min(to, text.length));
  const lineEnd = (from: number) => {
    const end = text.indexOf("\n", from);
    return end === -1 ? text.length : end;
  };
  /** Open template literals, each with where it starts and whether it holds an expression, and the brace depth of each open expression. */
  const templates: { start: number; expression: boolean; braces: number }[] = [];
  let index = 0;
  const closeTemplate = (end: number) => {
    const template = templates.pop()!;
    fill(template.start, end, template.expression || templates.length > 0 ? UNKNOWN : TEXT);
    if (templates.length > 0) templates.at(-1)!.expression = true;
  };
  const scanTemplate = (): void => {
    while (index < text.length) {
      const character = text[index]!;
      if (character === "\\") index += 2;
      else if (character === "`") {
        index += 1;
        closeTemplate(index);
        return;
      } else if (character === "$" && text[index + 1] === "{") {
        templates.at(-1)!.expression = true;
        templates.at(-1)!.braces = 1;
        index += 2;
        return;
      } else index += 1;
    }
    fill(templates[0]!.start, text.length, UNKNOWN);
    templates.length = 0;
  };
  while (index < text.length) {
    const character = text[index]!;
    const next = text[index + 1];
    if (character === "/" && next === "/") {
      const end = lineEnd(index);
      fill(index, end, TEXT);
      index = end;
    } else if (character === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close === -1 ? text.length : close + 2;
      fill(index, end, close === -1 ? UNKNOWN : TEXT);
      index = end;
    } else if (language === "java" && text.startsWith('"""', index)) {
      const close = text.indexOf('"""', index + 3);
      const end = close === -1 ? text.length : close + 3;
      fill(index, end, close === -1 ? UNKNOWN : TEXT);
      index = end;
    } else if (character === '"' || character === "'") {
      const end = lineEnd(index);
      let close = index + 1;
      while (close < end && text[close] !== character) close += text[close] === "\\" ? 2 : 1;
      fill(index, Math.min(close + 1, end), close < end ? TEXT : UNKNOWN);
      index = Math.min(close + 1, end);
    } else if (language === "typescript" && character === "`") {
      templates.push({ start: index, expression: false, braces: 0 });
      index += 1;
      scanTemplate();
    } else if (language === "typescript" && character === "/" && startsRegex(text, index)) {
      const end = lineEnd(index);
      fill(index, end, UNKNOWN);
      index = end;
    } else if (templates.length > 0 && (character === "{" || character === "}")) {
      const template = templates.at(-1)!;
      template.braces += character === "{" ? 1 : -1;
      index += 1;
      if (template.braces === 0) scanTemplate();
    } else index += 1;
  }
  return kinds;
}

/** Whether a `/` that opens no comment starts a regular expression: nothing but an operator, a bracket or a keyword before it. */
function startsRegex(text: string, index: number): boolean {
  let before = index - 1;
  while (before >= 0 && /\s/u.test(text[before]!)) before -= 1;
  if (before < 0) return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(text[before]!)) return true;
  const word = /[A-Za-z_$][\w$]*$/u.exec(text.slice(Math.max(0, before - 20), before + 1));
  return word !== null && REGEX_KEYWORDS.has(word[0]);
}

function cutCovers({ file, line }: WrittenLine, accounts: Accounts): boolean {
  return accounts.cutsEverything || accounts.cutPlaces.has(`${file}:${line}`) || accounts.cutFiles.has(file) || accounts.cutRuntimes.has(runtimeOf(file) ?? "");
}

/** The runtime the engine places a file in, as a cut at that file would name it; none for a file no language writes. */
function runtimeOf(file: string): string | undefined {
  const reach = fileReach(file);
  return reach.kind === "anything" ? reach.runtime : undefined;
}

function within({ file, line }: { file: string; line: number }, span: Span): boolean {
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

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
  return Object.fromEntries(OCCURRENCE_CLASSES.map((name) => [name, 0])) as ClassCounts;
}
