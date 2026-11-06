import { canonicalJson } from "./canonical-json.ts";
import { compareText } from "./code-node.ts";

export type SchemaVersion = `${number}.${number}.${number}`;

/** The schema version of every fact this build produces. */
export const SCHEMA: SchemaVersion = "0.21.0";

export type SnapshotRef =
  | { repo: string; kind: "sha"; sha: string }
  | { repo: string; kind: "live"; head: string; stateId: string };

export interface Producer {
  name: string;
  version: string;
}

/** What a fact is complete relative to (RFC-0002 rule 4): anything outside it is not covered, never "verified none". */
export interface DeclaredScope {
  languages: readonly string[];
  frameworks: readonly string[];
  /** Globs over repository-relative paths; empty means every path. */
  include: readonly string[];
  /** Globs over repository-relative paths; a path any of them matches is outside the scope. */
  exclude: readonly string[];
  /** Set on a fact over a live working tree: paths git ignores are neither listed nor cut, so completeness is relative to them. */
  ignored?: "git";
}

/** How the repository content is treated (ADR-0010); never decided from inside the repository. */
export const TRUST_MODES = ["trusted", "untrusted"] as const;

export type TrustMode = (typeof TRUST_MODES)[number];

export function isTrustMode(value: unknown): value is TrustMode {
  return typeof value === "string" && (TRUST_MODES as readonly string[]).includes(value);
}

export const WALK_BOUND_FIELDS = ["depth", "hubFanIn", "expansions"] as const;

export type WalkBoundsField = (typeof WALK_BOUND_FIELDS)[number];

export function isWalkBoundField(value: unknown): value is WalkBoundsField {
  return typeof value === "string" && (WALK_BOUND_FIELDS as readonly string[]).includes(value);
}

/**
 * The bounds a walk ran under; a member absent is a bound the caller did not set. `depth` is the deepest level reached
 * (a symbol at this level is not asked for its callers), `hubFanIn` the most callers a symbol may have to be expanded,
 * and `expansions` the most symbols whose callers are followed.
 */
export type WalkBounds = { readonly [Field in WalkBoundsField]?: number };

/**
 * The values the `config` digest stands for, in clear. One member per family that uses it: a member is present only
 * when its family used it, and absent means unbounded, never unknown.
 */
export interface DeclaredConfig {
  walk?: WalkBounds;
  /** The targets `impact.callers` or `trace.walk` was asked about, in the request's fixed order. */
  targets?: readonly string[];
  /** The files `impact.importers` was asked about. */
  files?: readonly string[];
  /** The selectors an outline was asked to focus on, as `<file>:<symbol>` or `<file>:<line>`, in the request's fixed order. */
  focus?: readonly string[];
  /** The globs over the changed paths `impact.ofChange` was asked to seed from, in their fixed order. */
  changed?: readonly string[];
  /** The contract change `contracts.consequences` was asked about, normalized as `<METHOD> <path> <target> <property> <change>`. */
  hypothesis?: string;
  /** What the export may take from a commit, when the host bounded it. */
  exportBudget?: { maxEntries: number; maxBytes: number };
}

/** Where the index a fact read came from (ADR-0015 decision 3); a `sync` one names the full build it continued. */
export type IndexOrigin = { kind: "full" } | { kind: "sync"; base: string };

export interface FactInputs {
  trust: TrustMode;
  /** Digest of the declared scope. */
  scope: string;
  /** The declared scope the digest stands for. */
  declaredScope: DeclaredScope;
  /** Digest of every input of the content that decides the fact: the in-scope files and whatever else the producer names. */
  content: string;
  /** Digest of the values that change results. */
  config: string;
  /** The values the `config` digest stands for, in clear. */
  declaredConfig: DeclaredConfig;
  /** Where the index the fact read came from; absent when the fact read no index. */
  origin?: IndexOrigin;
  /** Version of each engine that produced the fact, by package name; only the engines that took part. */
  engines: Readonly<Record<string, string>>;
}

export interface Evidence {
  path: string;
  line: number;
  endLine?: number;
  via?: string;
  confidence?: number;
}

/** The last line of a place, and nothing when it spans one line: one line is the common case and takes no field. */
export function declarationSpan(line: number, endLine: number | undefined): { endLine?: number } {
  return endLine === undefined || endLine === line ? {} : { endLine };
}

export type UnknownReason =
  | "no-extractor"
  | "no-project"
  | "out-of-scope"
  | "index-unavailable"
  | "source-unreadable"
  | "unresolved"
  | "revision-unavailable"
  | "deadline";

export const DEPENDENCY_SELECTION_REASONS = ["ambiguous", "unproven-coordinates"] as const;

export interface Cut {
  kind:
    | "depth"
    | "hub"
    | "caller-budget"
    | "node-cap"
    | "unresolved-link"
    | "deadline"
    | "section"
    | "not-exported"
    | "no-extractor";
  /** Where the computation stopped: repo-relative paths or symbols, or the section of a composite. */
  at: readonly string[];
  limit?: number;
  reason?: UnknownReason;
  dependency?: {
    name: string;
    reason: (typeof DEPENDENCY_SELECTION_REASONS)[number];
    candidates: readonly string[];
  };
}

export interface FactBase {
  schema: SchemaVersion;
  snapshot: SnapshotRef;
  producer: Producer;
  inputs: FactInputs;
  evidence: readonly Evidence[];
}

export interface CompleteFact<T> extends FactBase {
  status: "complete";
  value: T;
}

export interface PartialFact<T> extends FactBase {
  status: "partial";
  value: T;
  cuts: readonly [Cut, ...Cut[]];
}

export interface UnknownFact extends FactBase {
  status: "unknown";
  reason: UnknownReason;
}

/** An extractor's item before a use case adds the fact base: `unknown` carries the reason and the evidence of where. */
export type Finding<T> =
  | { status: "complete"; value: T; evidence: readonly Evidence[] }
  | { status: "unknown"; reason: UnknownReason; evidence: readonly Evidence[] };

export type Fact<T> = CompleteFact<T> | PartialFact<T> | UnknownFact;

/** A read's fact envelope without its payload. */
export type FactProvenance = (FactBase & { status: "complete" }) | (FactBase & { status: "partial"; cuts: readonly [Cut, ...Cut[]] }) | UnknownFact;

export function provenanceOf<T>(fact: Fact<T>): FactProvenance {
  const { schema, snapshot, producer, inputs, evidence } = fact;
  const base = { schema, snapshot, producer, inputs, evidence };
  if (fact.status === "unknown") return { ...base, status: "unknown", reason: fact.reason };
  if (fact.status === "partial") return { ...base, status: "partial", cuts: fact.cuts };
  return { ...base, status: "complete" };
}

export type Sections = Readonly<Record<string, Fact<unknown>>>;

/** A composite is complete only when every section is; otherwise it carries one `section` cut per incomplete section. */
export function incompleteSectionCuts(sections: Sections): Cut[] {
  return Object.keys(sections)
    .filter((name) => sections[name]?.status !== "complete")
    .sort()
    .map((name): Cut => ({ kind: "section", at: [name] }));
}

export function composeSections<S extends Sections>(base: FactBase, sections: S): CompleteFact<S> | PartialFact<S> {
  const [first, ...rest] = incompleteSectionCuts(sections);
  if (first === undefined) return { ...base, status: "complete", value: sections };
  return { ...base, status: "partial", value: sections, cuts: [first, ...rest] };
}

/** The engines by name, sorted, so provenance does not depend on the order the composition built them in. */
export function sortedEngines(engines: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(engines).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A fact's identity for RFC-0002 rule 5: its schema, its inputs and its producer, whatever order the keys were written in. */
export type FactIdentity = Pick<FactBase, "schema" | "inputs" | "producer">;

/** A stored fact stands while its identity is the one the current run would write. */
export function sameIdentity(a: FactIdentity, b: FactIdentity): boolean {
  return canonicalJson([a.schema, a.inputs, a.producer]) === canonicalJson([b.schema, b.inputs, b.producer]);
}

const CUT_RANK: Record<Cut["kind"], number> = {
  depth: 0,
  hub: 1,
  "caller-budget": 2,
  "node-cap": 3,
  deadline: 4,
  "unresolved-link": 5,
  "no-extractor": 6,
  "not-exported": 7,
  section: 8,
};

/** Complete only when nothing cut the answer; otherwise partial with the cuts in kind order, each once. */
export function withCuts<T>(base: FactBase, value: T, cuts: readonly Cut[]): CompleteFact<T> | PartialFact<T> {
  const [first, ...rest] = [...new Map(cuts.map((cut) => [JSON.stringify(cut), cut])).values()].sort(
    (a, b) => CUT_RANK[a.kind] - CUT_RANK[b.kind] || compareText(a.at.join("\0"), b.at.join("\0")),
  );
  return first === undefined ? { ...base, status: "complete", value } : { ...base, status: "partial", value, cuts: [first, ...rest] };
}
