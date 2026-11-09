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
  /** The hypotheses `contractConsequences.ofHypotheses` was asked about, each normalized as `<METHOD> <path> <target> <property> <change>`, in the order asked. */
  hypotheses?: readonly string[];
  /** The revisions `contractConsequences.ofChange` was asked to compare, as asked. */
  base?: string;
  head?: string;
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
  /** Each build output a host declared that the fact read (ADR-0037 decision 6); absent when it read none. */
  buildOutputs?: readonly BuildOutputInput[];
}

/** A declared build output a fact read: whether the snapshot's lockfile verified it, and the digest of what was read from it. */
export interface BuildOutputInput {
  kind: "node-modules";
  /** The repository directory the output stands for, `""` for the root. */
  at: string;
  verified: boolean;
  digest: string;
}

export interface Evidence {
  column?: number;
  path: string;
  line: number;
  endLine?: number;
  via?: string;
  confidence?: number;
}

/** Whether one place holds another: same file, same first line, and it ends no earlier. */
export function spanCovers(outer: Evidence, inner: Evidence): boolean {
  return outer.path === inner.path && outer.line === inner.line && (outer.endLine ?? outer.line) >= (inner.endLine ?? inner.line);
}

/** Evidence that never repeats a line: a place an earlier one holds adds nothing. */
export function distinctEvidence(evidence: readonly Evidence[]): Evidence[] {
  return evidence.filter((span, index) => !evidence.slice(0, index).some((earlier) => spanCovers(earlier, span)));
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

/** Why an export left a path out; the VCS port owns the vocabulary. */
export const EXPORT_SKIP_REASONS = ["symlink", "submodule", "unsafe-path", "collision"] as const;
export type ExportSkipReason = (typeof EXPORT_SKIP_REASONS)[number];

/** Why a dispatch port could not name the bodies a call runs, when it says; the dispatch port owns the vocabulary. */
export const DISPATCH_UNKNOWN_REASONS = ["aspect may replace the body", "generated implementation", "dispatch not proven"] as const;
export type DispatchUnknownReason = (typeof DISPATCH_UNKNOWN_REASONS)[number];

/** A stage the language pack of the site's file declares it cannot implement (ADR-0045 decision 12). */
export const CAPABILITY_ABSENT = "capability-absent";

/** Why a cut exists: one member per emitter situation (ADR-0042 decision 1). */
export const CUT_REASONS = [
  "depth", "hub", "caller-budget", "node-cap", "deadline", "export-budget",
  ...EXPORT_SKIP_REASONS, "unwritten",
  "language", "template-uncovered", "not-source", "not-indexed", "no-symbols", "unmodelled", "module-unread", "contract-unread",
  "live-tree", "inputs-unreadable", "version-mismatch", "outputs-unreadable", "checker-failed", "link-outside",
  "hidden-caller", "dynamic-load", "name-only", "specifier", "removed-declaration", "relation-unread", "use-unproven",
  "receiver-unproven", "callee-unknown", "constructor-unsettled", "contradicted", "unowned", "dispatch", "function-value",
  "page-unplanned", "handler-unplaced", "effect-unplaced",
  "dependency-unresolved", "join-unsettled", "operation-unserved",
  "section-partial", "section-unknown",
] as const;
export type CutReason = (typeof CUT_REASONS)[number];

/** What narrows a reason: why a dispatch was not proven, or that the stage which would settle the cut is absent. */
export const CUT_SUB_REASONS = [...DISPATCH_UNKNOWN_REASONS, "several-bodies", "overridable", "unproven", CAPABILITY_ABSENT] as const;
export type CutSubReason = (typeof CUT_SUB_REASONS)[number];

export type Runtime = "java" | "typescript";

/** What a cut could hide, from the data its emitter holds (ADR-0042 decision 2); `anything` when it holds no narrower one. */
export type CutReach =
  | { kind: "anything"; runtime?: Runtime }
  /** Callers of these declaration anchors. */
  | { kind: "callers-of"; declarations: readonly string[] }
  /** A call at this place inside a walked body. */
  | { kind: "call-at"; place: string }
  /** Edges from an importing file through these specifiers; `package` when the resolver classified one, absent when it did not. */
  | { kind: "module"; importer: string; specifiers: readonly { specifier: string; package?: boolean }[] }
  /** A call site as the topology extractor read it. */
  | { kind: "call-site"; transport: string; method?: string; template?: string };

export interface Cut {
  kind:
    | "depth"
    | "hub"
    | "caller-budget"
    | "node-cap"
    | "unresolved-link"
    | "build-output"
    | "deadline"
    | "section"
    | "not-exported"
    | "no-extractor";
  /** Where the computation stopped: repo-relative paths or symbols, or the section of a composite. */
  at: readonly string[];
  limit?: number;
  reason: CutReason;
  subReason?: CutSubReason;
  reach: CutReach;
  dependency?: {
    name: string;
    reason: (typeof DEPENDENCY_SELECTION_REASONS)[number];
    candidates: readonly string[];
  };
}

/** The reach of a cut nothing narrower bounds. */
export const ANYTHING: CutReach = { kind: "anything" };

export type WalkBoundKind = "depth" | "hub" | "caller-budget";

/** A walk bound at `at`: what it left out is unknown, so it is in question for every family (ADR-0042 decision 3). */
export function boundCut(kind: WalkBoundKind, at: string, limit: number): Cut {
  return { kind, at: [at], limit, reason: kind, reach: ANYTHING };
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
    .map((name): Cut => ({ kind: "section", at: [name], reason: sections[name]?.status === "unknown" ? "section-unknown" : "section-partial", reach: ANYTHING }));
}

export function composeSections<S extends Sections>(base: FactBase, sections: S): CompleteFact<S> | PartialFact<S> {
  const [first, ...rest] = incompleteSectionCuts(sections);
  if (first === undefined) return { ...base, status: "complete", value: sections };
  return { ...base, status: "partial", value: sections, cuts: [first, ...rest] };
}

/** The engines by name, sorted, so provenance does not depend on the order the composition built them in. */
export function sortedEngines(engines: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(engines).toSorted(([a], [b]) => compareText(a, b)));
}

/** A fact's identity for RFC-0002 rule 5: its schema, its inputs and its producer, whatever order the keys were written in. */
export type FactIdentity = Pick<FactBase, "schema" | "inputs" | "producer">;

/** A stored fact stands while its identity is the one the current run would write. */
export function sameIdentity(a: FactIdentity, b: FactIdentity): boolean {
  return canonicalJson([a.schema, a.inputs, a.producer]) === canonicalJson([b.schema, b.inputs, b.producer]);
}

/** Where a cut stopped the answer, without why it stopped or what it could hide. */
function placeKey({ reason: _reason, subReason: _subReason, reach: _reach, ...place }: Cut): string {
  return JSON.stringify(place);
}

const CUT_RANK: Record<Cut["kind"], number> = {
  depth: 0,
  hub: 1,
  "caller-budget": 2,
  "node-cap": 3,
  deadline: 4,
  "unresolved-link": 5,
  "build-output": 6,
  "no-extractor": 7,
  "not-exported": 8,
  section: 9,
};

/** How much a reach could hide: anything at all, then anything of one file's runtime or module edges, then one named place. */
function reachWidth(reach: CutReach): number {
  if (reach.kind === "anything") return reach.runtime === undefined ? 0 : 1;
  return reach.kind === "module" ? 1 : 2;
}

const rankIn = (order: readonly string[], value: string | undefined): number => (value === undefined ? order.length : order.indexOf(value));

/** Which of two cuts at one place stands, whatever order they came in: the wider reach, then the reason and sub-reason that come first. */
function standsOver(a: Cut, b: Cut): boolean {
  return (
    reachWidth(a.reach) - reachWidth(b.reach) ||
    rankIn(CUT_REASONS, a.reason) - rankIn(CUT_REASONS, b.reason) ||
    rankIn(CUT_SUB_REASONS, a.subReason) - rankIn(CUT_SUB_REASONS, b.subReason) ||
    compareText(JSON.stringify(a.reach), JSON.stringify(b.reach))
  ) < 0;
}

/**
 * Complete only when nothing cut the answer; otherwise partial with the cuts in kind order, each place once: where two
 * situations cut the same place, the one that could hide more stands, so no order of emission narrows what a place could
 * hide; between equal reaches, the reason and then the sub-reason that come first in their closed order.
 */
export function withCuts<T>(base: FactBase, value: T, cuts: readonly Cut[]): CompleteFact<T> | PartialFact<T> {
  const byPlace = new Map<string, Cut>();
  for (const cut of cuts) {
    const key = placeKey(cut);
    const held = byPlace.get(key);
    if (held === undefined || standsOver(cut, held)) byPlace.set(key, cut);
  }
  const [first, ...rest] = [...byPlace.values()].sort(
    (a, b) => CUT_RANK[a.kind] - CUT_RANK[b.kind] || compareText(a.at.join("\0"), b.at.join("\0")),
  );
  return first === undefined ? { ...base, status: "complete", value } : { ...base, status: "partial", value, cuts: [first, ...rest] };
}
