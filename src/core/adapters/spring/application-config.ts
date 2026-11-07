import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments } from "yaml";
import type { BasePath, BasePathKeys } from "../../domain/entrypoints/http-route.ts";
import { profileOfConfigFile, resourcesOfSource } from "../../domain/languages/spring-config.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { UNKNOWABLE_TEXT, type JavaFile } from "./java-symbols.ts";

/** Canonical names: Spring binds a key whatever its case and its dashes or underscores. */
const BASE_PATH_KEYS: Readonly<Record<string, keyof BasePathKeys>> = {
  "server.servlet.contextpath": "contextPath",
  "spring.mvc.servlet.path": "servletPath",
  "spring.webflux.basepath": "webfluxBasePath",
};
const IMPORT = "spring.config.import";
const ACTIVATE = "spring.config.activate";
const ON_PROFILE = "spring.config.activate.onprofile";
const READ_KEYS = [...Object.keys(BASE_PATH_KEYS), IMPORT, ACTIVATE];
const DOCUMENT_SEPARATOR = /^[#!]---[ \t\f]*$/;
const NON_ASCII = /[^\x00-\x7F]/;
const UNICODE_ESCAPE = /^[0-9a-fA-F]{4}$/;

/** A key a document sets that decides a base path; `value` is undefined when the key holds no single string. */
interface Declaration {
  key: string;
  value: string | undefined;
  line: number;
  /** The key holds an alias, a merge or a key that is not a scalar: the keys below it cannot be read exactly. */
  opaque?: true;
}

type ConfigRead = { ok: true; documents: Declaration[][] } | { ok: false; line: number };

/** Which keys of a file are kept: those it reads, and the prefixes on the way to one. */
interface ReadKeys {
  reads(key: string): boolean;
  leads(key: string): boolean;
}

const BASE_PATH_KEYS_READ: ReadKeys = { reads: isReadKey, leads: leadsToReadKey };
const EVERY_KEY: ReadKeys = { reads: () => true, leads: () => true };

const GAP_PRECEDENCE: readonly Gap["reason"][] = ["unresolved", "no-extractor", "source-unreadable"];

interface Gap {
  reason: "unresolved" | "no-extractor" | "source-unreadable";
  evidence: Evidence[];
}

/**
 * The base path the configuration files of one module declare, read key by key: no other value of a file is kept.
 * What the snapshot cannot decide (a placeholder, two values for one key, an import, a condition other than a profile,
 * an alias or merge key on the way to a key) makes it unknown at those declarations; an XML properties file is not read.
 */
export function basePathOf(files: readonly SourceFile[]): Finding<BasePath> {
  const gaps: Gap[] = [];
  const declared = new Map<string, Map<keyof BasePathKeys, { value: string; span: Evidence }>>();
  const evidence: Evidence[] = [];
  for (const file of files) {
    if (file.path.endsWith(".xml")) {
      gaps.push({ reason: "no-extractor", evidence: [{ path: file.path, line: 1 }] });
      continue;
    }
    const read = readConfig(file, BASE_PATH_KEYS_READ);
    if (!read.ok) {
      gaps.push({ reason: "source-unreadable", evidence: [{ path: file.path, line: read.line }] });
      continue;
    }
    for (const document of read.documents) {
      const span = (declaration: Declaration): Evidence => ({ path: file.path, line: declaration.line });
      const profile = documentProfile(document, profileOfConfigFile(file.path));
      for (const declaration of document) {
        const name = BASE_PATH_KEYS[declaration.key];
        if (name === undefined) {
          if (!declaration.key.startsWith(`${ACTIVATE}.`)) gaps.push({ reason: "unresolved", evidence: [span(declaration)] });
          continue;
        }
        if (profile === null || declaration.value === undefined || UNKNOWABLE_TEXT.test(declaration.value)) {
          gaps.push({ reason: "unresolved", evidence: [span(declaration)] });
          continue;
        }
        const group = declared.get(profile) ?? new Map();
        declared.set(profile, group);
        const earlier = group.get(name);
        if (earlier !== undefined && earlier.value !== declaration.value) {
          gaps.push({ reason: "unresolved", evidence: [earlier.span, span(declaration)] });
          continue;
        }
        group.set(name, { value: declaration.value, span: span(declaration) });
        evidence.push(span(declaration));
      }
    }
  }
  if (gaps.length > 0) {
    return {
      status: "unknown",
      reason: GAP_PRECEDENCE.find((reason) => gaps.some((gap) => gap.reason === reason)) ?? "unresolved",
      evidence: sortSpans(gaps.flatMap((gap) => gap.evidence)),
    };
  }
  const keysOf = (profile: string): BasePathKeys =>
    Object.fromEntries(Object.values(BASE_PATH_KEYS).flatMap((name) => {
      const found = declared.get(profile)?.get(name);
      return found === undefined ? [] : [[name, found.value]];
    }));
  const profiles = [...declared.keys()].filter((profile) => profile !== "").toSorted();
  return {
    status: "complete",
    value: { default: keysOf(""), profiles: Object.fromEntries(profiles.map((profile) => [profile, keysOf(profile)])) },
    evidence: sortSpans(evidence),
  };
}

export type ConfiguredValue = { status: "found"; value: string } | { status: "absent" } | { status: "undecided" };

/** A key a configuration file declares, in its canonical spelling, and where. */
export interface ConfiguredKey {
  key: string;
  evidence: Evidence;
}

export interface Configuration {
  /** The string a key holds in the files; `undecided` when two files give it different values or the files cannot all be read. */
  valueOf(key: string): ConfiguredValue;
  /**
   * Every key declared at or under a prefix, whatever its value, in whichever profile. `undecided` holds the places the files
   * could not be read at (a syntax error, an XML file, an import, an alias or merge key on the way to the prefix or below it): they may
   * declare any key.
   */
  keysUnder(prefix: string): { keys: readonly ConfiguredKey[]; undecided: readonly Evidence[] };
}

/**
 * Every key the configuration files of one module declare. Any file the snapshot cannot read as a whole (an XML properties
 * file, a syntax error, an import, a condition other than a profile) leaves every key undecided, as it does a base path.
 */
export function configurationOf(files: readonly SourceFile[]): Configuration {
  const declared = new Map<string, (string | undefined)[]>();
  const keys: ConfiguredKey[] = [];
  const gaps: Evidence[] = [];
  const opaque: ConfiguredKey[] = [];
  let unplaced = false;
  for (const file of files) {
    const read = file.path.endsWith(".xml") ? ({ ok: false, line: 1 } as const) : readConfig(file, EVERY_KEY);
    if (!read.ok) {
      gaps.push({ path: file.path, line: read.line });
      continue;
    }
    for (const document of read.documents) {
      if (documentProfile(document, profileOfConfigFile(file.path)) === null) unplaced = true;
      for (const { key, value, line, opaque: unread } of document) {
        if (key === IMPORT || key.startsWith(`${IMPORT}[`)) gaps.push({ path: file.path, line });
        else if (unread) opaque.push({ key: key.replace(/\.?<<$/, ""), evidence: { path: file.path, line } });
        else if (!key.startsWith(`${ACTIVATE}.`)) {
          declared.set(key, [...(declared.get(key) ?? []), value]);
          keys.push({ key, evidence: { path: file.path, line } });
        }
      }
    }
  }
  const undecided = unplaced || gaps.length > 0;
  const unreadAround = (root: string): Evidence[] => opaque.filter(({ key }) => isWithin(key, root) || isWithin(root, key)).map(({ evidence }) => evidence);
  return {
    keysUnder(prefix) {
      const root = canonicalKey(prefix);
      return { keys: keys.filter(({ key }) => isWithin(key, root)), undecided: sortSpans([...gaps, ...unreadAround(root)]) };
    },
    valueOf(key) {
      const root = canonicalKey(key);
      const values = new Set(declared.get(root));
      const [only] = values;
      if (undecided || unreadAround(root).length > 0 || values.size > 1 || (values.size === 1 && only === undefined)) return { status: "undecided" };
      return only === undefined ? { status: "absent" } : { status: "found", value: only };
    },
  };
}

/**
 * The configuration a source's own module declares: the files of the module that holds it when that module has any, the
 * repository's otherwise. Each module is read once.
 */
export function configurationsOf(files: readonly SourceFile[]): (source: JavaFile) => Configuration {
  const known = new Map<string, Configuration>();
  return (source) => {
    const resources = resourcesOfSource(source.path);
    const key = resources ?? "";
    const held = known.get(key);
    if (held !== undefined) return held;
    const own = files.filter((config) => resources !== undefined && config.path.startsWith(resources) && /^(config\/)?[^/]+$/.test(config.path.slice(resources.length)));
    const configuration = configurationOf(own.length > 0 ? own : files);
    known.set(key, configuration);
    return configuration;
  };
}

/** Whether `key` is `root` or a key below it. */
function isWithin(key: string, root: string): boolean {
  return root === "" || key === root || key.startsWith(`${root}.`) || key.startsWith(`${root}[`);
}

/** The profile a document applies to (`""` for none), or null when its condition is one the snapshot cannot place under a single profile. */
function documentProfile(document: readonly Declaration[], fileProfile: string | undefined): string | null {
  const conditions = document.filter((declaration) => declaration.key.startsWith(`${ACTIVATE}.`));
  if (conditions.length === 0) return fileProfile ?? "";
  const [condition] = conditions;
  if (conditions.length > 1 || condition?.key !== ON_PROFILE || condition.value === undefined || fileProfile !== undefined) return null;
  return condition.value;
}

function readConfig(file: SourceFile, keys: ReadKeys): ConfigRead {
  return file.path.endsWith(".properties") ? readProperties(file.content, keys) : readYaml(file.content, keys);
}

function readYaml(content: string, keys: ReadKeys): ConfigRead {
  const lineCounter = new LineCounter();
  const documents: Declaration[][] = [];
  for (const document of parseAllDocuments(content, { lineCounter, uniqueKeys: true, merge: false })) {
    const [error] = document.errors;
    if (error !== undefined) return { ok: false, line: lineCounter.linePos(error.pos[0]).line };
    const declarations: Declaration[] = [];
    walkYaml(document.contents, [], 1, declarations, lineCounter, keys);
    documents.push(declarations);
  }
  return { ok: true, documents };
}

function walkYaml(node: unknown, path: readonly string[], line: number, out: Declaration[], lines: LineCounter, keys: ReadKeys): void {
  const key = canonicalKey(path.join("."));
  if (isAlias(node) || path.at(-1) === "<<") {
    if (keys.leads(key.replace(/\.?<<$/, ""))) out.push({ key, value: undefined, line, opaque: true });
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      const name = isScalar(pair.key) ? String(pair.key.value) : undefined;
      const at = lines.linePos((isScalar(pair.key) && pair.key.range?.[0]) || 0).line;
      if (name === undefined) {
        if (keys.leads(key)) out.push({ key, value: undefined, line: at, opaque: true });
        continue;
      }
      walkYaml(pair.value, [...path, name], at, out, lines, keys);
    }
    return;
  }
  if (!keys.reads(key)) return;
  if (isScalar(node) && typeof node.value === "string") out.push({ key, value: node.value, line });
  else if (key === ON_PROFILE && isSeq(node) && node.items.every((item) => isScalar(item) && typeof item.value === "string")) {
    out.push({ key, value: node.items.map((item) => (isScalar(item) ? String(item.value) : "")).join(","), line });
  } else out.push({ key, value: undefined, line });
}

/**
 * `java.util.Properties` syntax as Spring Boot's loader reads it: a `#---` or `!---` line at column 0 separates
 * documents unless the line before is a comment of the same prefix, and a comment that opens a document reopens the
 * previous one. Spring decodes the file as ISO-8859-1, so a value holding a character outside ASCII is not decided.
 */
function readProperties(content: string, keys: ReadKeys): ConfigRead {
  const lines = content.split(/\r\n|\r|\n/);
  const documents: { declarations: Declaration[]; entries: number }[] = [];
  let current = { declarations: [] as Declaration[], entries: 0 };
  let lastCommentPrefix: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const start = index;
    const raw = lines[index] ?? "";
    let logical = raw.trimStart();
    if (logical === "") continue;
    const prefix = logical[0];
    if (prefix === "#" || prefix === "!") {
      if (DOCUMENT_SEPARATOR.test(raw) && lastCommentPrefix !== prefix) {
        if (current.entries > 0) documents.push(current);
        current = { declarations: [], entries: 0 };
        continue;
      }
      if (current.entries === 0) current = documents.pop() ?? current;
      lastCommentPrefix = prefix;
      continue;
    }
    lastCommentPrefix = undefined;
    while (endsWithEscape(logical) && index + 1 < lines.length) logical = logical.slice(0, -1) + (lines[++index] ?? "").trimStart();
    const entry = splitEntry(logical);
    if (entry === undefined) return { ok: false, line: start + 1 };
    current.entries++;
    const key = canonicalKey(entry.key);
    if (keys.reads(key)) current.declarations.push({ key, value: NON_ASCII.test(entry.raw) ? undefined : entry.value, line: start + 1 });
  }
  if (current.entries > 0) documents.push(current);
  return { ok: true, documents: documents.map((document) => document.declarations) };
}

function endsWithEscape(line: string): boolean {
  return (line.length - line.replace(/\\+$/, "").length) % 2 === 1;
}

function splitEntry(line: string): { key: string; value: string; raw: string } | undefined {
  let end = 0;
  while (end < line.length && !/[=:\s]/.test(line[end] ?? "")) end += line[end] === "\\" ? 2 : 1;
  const rest = line.slice(end).replace(/^\s*[=:]?\s*/, "");
  const key = unescape(line.slice(0, end));
  const value = unescape(rest);
  return key === undefined || value === undefined ? undefined : { key, value, raw: rest };
}

function unescape(text: string): string | undefined {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = text[++index] ?? "";
    if (next === "u") {
      const hex = text.slice(index + 1, index + 5);
      if (!UNICODE_ESCAPE.test(hex)) return undefined;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else out += { t: "\t", n: "\n", r: "\r", f: "\f" }[next] ?? next;
  }
  return out;
}

/** Spring's relaxed binding spelling of a key: lower case, without dashes or underscores. */
export function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function isReadKey(key: string): boolean {
  return key in BASE_PATH_KEYS || key === IMPORT || key.startsWith(`${IMPORT}[`) || key.startsWith(`${ACTIVATE}.`);
}

/** Whether a value at this key may hold a key the base path reads. */
function leadsToReadKey(key: string): boolean {
  return READ_KEYS.some((read) => key === "" || read === key || read.startsWith(`${key}.`) || key.startsWith(`${read}.`) || key.startsWith(`${read}[`));
}

function sortSpans(spans: readonly Evidence[]): Evidence[] {
  const unique = new Map(spans.map((span) => [`${span.path}\0${span.line}`, span]));
  return [...unique.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}
