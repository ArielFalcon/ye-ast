import { strict as assert } from "node:assert";
import type { ResponseMode } from "../presentation.ts";
import type { Presentation } from "./model.ts";
import { write, type PrintedRow } from "./writer.ts";

/**
 * The migration harness of RFC-0041 section 5, shared by every family unit.
 *
 * I1 (no fact lost) compares the identities a text states, as tokens: a route `VERB /path`, a place `path:line[-end]`
 * (in the forms the legacy renderers and the writer print it: inline, under a file header, as a `:line` continuation,
 * in an evidence list or as JSON), a symbol after `->`, an entrypoint `kind name` or `unknown (reason) for subject`, and the places of a `cuts:` section.
 * The legacy text of each fixture is frozen as a token list when its family migrates; a committed test never calls
 * the legacy renderer.
 */

const VERBS = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|ANY";
const SCAN = new RegExp(
  `(?<route>\\b(?:${VERBS}) /[^\\s,)]*)|(?<json>"path":"[^"]+","line":\\d+(?:,"endLine":\\d+)?)|(?<inline>[\\w@.\\-/\\[\\]{}$]+\\.[A-Za-z0-9]+:\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*)|(?<cont>(?<![^\\s(,]):\\d+(?:-\\d+)?)|(?<anchor>[\\w@.\\-/\\[\\]{}$]+::[\\w.$]+)`,
  "g",
);
const HEADER = /^ {2}(?![ \d])(?=.+[./])([^()]+\.[A-Za-z0-9]+)$/;
const ROW_SPAN = /^ *(?:\d+\. )?(\d+(?:-\d+)?) (?!other\b|containment\b|declarations?\b)\S/;
const LEGACY_RUN = /^ *- unknown \(.*\) (\S+):$/;
const LEGACY_RUN_ROW = /^ *findingIndex \d+: (\d+(?:-\d+)?)$/;
const ANNOTATION = /\b(via|confidence) ([\w.-]+)/g;
const SYMBOL = /-> (?:\S+:\d+(?:-\d+)? )?(\S+)/g;
const IDENTITY = /(?<!for )\b(http-route|ui-route|listener|job|callback) (.+?)(?: ->| \(depth\b| \[findingIndex \d+\]|$)/;
const UNKNOWN = /\bunknown \((?!depth\b)[^)]+\)(?: for [^(\n]*?(?= \(raised by| \S+:\d|\s*\[findingIndex|$))?(?: \(raised by [^)]+\))?/;

/** The identities a text states; see the file comment for the forms. */
export function tokensOf(text: string): Set<string> {
  const tokens = new Set<string>();
  let file: string | undefined;
  let inCuts = false;
  let groupFile: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith(" ")) { file = undefined; groupFile = undefined; inCuts = line === "cuts:"; }
    const place = (value: string) => tokens.add(`${inCuts ? "cut " : ""}place ${value}`);
    const header = HEADER.exec(line);
    if (header !== null) { file = header[1]; groupFile = file; }
    const run = LEGACY_RUN.exec(line);
    if (run !== null) file = run[1];
    const span = ROW_SPAN.exec(line)?.[1] ?? LEGACY_RUN_ROW.exec(line)?.[1];
    if (span !== undefined && (groupFile ?? file) !== undefined) place(`${groupFile ?? file}:${span}`);
    const legacyHandler = /-> (.+?:\d+(?:-\d+)?) (\S+) \(depth/.exec(line);
    if (legacyHandler !== null) place(legacyHandler[1]!);
    for (const match of line.matchAll(SCAN)) {
      const { route, json, inline, cont, anchor } = match.groups as Record<string, string | undefined>;
      if (route !== undefined) tokens.add(`route ${route}`);
      else if (json !== undefined) { const [, path, at, end] = /"path":"([^"]+)","line":(\d+)(?:,"endLine":(\d+))?/.exec(json)!; place(`${path}:${at}${end === undefined ? "" : `-${end}`}`); }
      else if (inline !== undefined) {
        if (legacyHandler?.[1]?.endsWith(inline) === true) continue;
        const [head, ...more] = inline.split(",");
        const at = head!.lastIndexOf(":");
        file = head!.slice(0, at);
        for (const part of [head!.slice(at + 1), ...more]) place(`${file}:${part}`);
      } else if (cont !== undefined && file !== undefined) place(`${file}${cont}`);
      else if (anchor !== undefined) tokens.add(`anchor ${anchor}`);
    }
    if (legacyHandler !== null) tokens.add(`symbol ${legacyHandler[2]}`);
    else if (!line.includes("<path>")) for (const match of line.matchAll(SYMBOL)) tokens.add(`symbol ${match[1]}`);
    for (const match of line.matchAll(ANNOTATION)) tokens.add(`${match[1]} ${match[2]}`);
    const unknown = UNKNOWN.exec(line);
    if (unknown !== null) tokens.add(`entry ${unknown[0]}`);
    const identity = IDENTITY.exec(line);
    if (identity !== null) tokens.add(`entry ${identity[1]} ${identity[2]}`);
  }
  return tokens;
}

/** The sorted tokens of a legacy text, to freeze as a fixture. */
export const freezeTokens = (legacyText: string): string[] => [...tokensOf(legacyText)].toSorted();

export interface Frozen { summary: readonly string[]; details: readonly string[]; bytes: { summary: number; details: number } }

export interface NoFactLost {
  /** Tokens the family documents as moving from `summary` to `details` (evidence, cut places): found in `details` instead. */
  movedToDetails?: ReadonlySet<string>;
  /** Tokens a W6 `+N more` line counts instead of printing. */
  counted?: ReadonlySet<string>;
}

/** I1: every identity the legacy text of `mode` stated is stated by the new text of that mode, or by a documented exception. */
export function assertNoFactLost(mode: ResponseMode, legacy: readonly string[], texts: Record<ResponseMode, string>, { movedToDetails = new Set(), counted = new Set() }: NoFactLost = {}): void {
  const now = tokensOf(texts[mode]);
  const later = tokensOf(texts.details);
  const hasCount = /\+\d+ more/.test(texts[mode]);
  const lost = legacy.filter((token) => !now.has(token) && !(mode === "summary" && movedToDetails.has(token) && later.has(token)) && !(counted.has(token) && hasCount));
  assert.deepEqual(lost, [], `${mode}: the legacy text states identities the new text does not`);
}

const keysOf = (rows: readonly PrintedRow[]) => rows.map(({ section, key }) => `${section}\0${key}`);

/** I2: every row key `summary` prints is printed by `details`. */
export function assertSummaryWithinDetails(presentation: Presentation): void {
  const details = new Set(keysOf(write(presentation, "details").printed));
  const missing = keysOf(write(presentation, "summary").printed).filter((key) => !details.has(key));
  assert.deepEqual(missing, [], "summary prints rows that details does not");
}

/** I4: every row key the writer prints resolves, by `resolve(section, key)`, to an entry of the full projection of the same fact. */
export function assertRowsResolve(presentation: Presentation, resolve: (section: string, key: string) => boolean): void {
  const unresolved = write(presentation, "details").printed.filter(({ section, key }) => !resolve(section, key));
  assert.deepEqual(unresolved, [], "printed rows that are no entry of answer.json");
}

/** I3 for a family: the same fact gives the same bytes. */
export function assertDeterministic(present: () => Presentation): void {
  for (const mode of ["summary", "details"] as const) assert.equal(write(present(), mode).text, write(present(), mode).text);
}
