import { canonicalJson } from "../shared/canonical-json.ts";
import type { Evidence, UnknownReason } from "../shared/fact.ts";
import type { AccessPath, PathMapping } from "./access-path.ts";
import type { Guard, UseOperation } from "./verdict.ts";

/**
 * Where a followed value sits at a boundary the flow readers hand back to the use case. Positions are repository-relative
 * and 1-based; a declaration's `line` is its first line.
 */
export type CarrierSite =
  /** The value an HTTP call written at this call site returns, as the workspace join reports the site. */
  | { kind: "call-site"; repo: string; file: string; line: number; column?: number; symbol: string }
  /** The value of the call of `callee` (a function's own name, as on a return carrier) at a resolved caller's edge. */
  | { kind: "call-result"; repo: string; file: string; line: number; column?: number; callee: string }
  /** The value a function or method returns. */
  | { kind: "return"; repo: string; file: string; symbol: string; line: number }
  /** The value a resolved function or method receives as its parameter at `index`, 0-based. */
  | { kind: "parameter"; repo: string; file: string; symbol: string; line: number; index: number }
  /**
   * The value a component receives through the input whose public name is `name`: the alias when the input declares
   * one. The TypeScript reader resolves it to the member that declares the input, or reports that none does.
   */
  | { kind: "input"; repo: string; file: string; owner: string; name: string }
  /**
   * The value a class member holds: a field, an `input()`, a signal, an `@Input()`. `line` is the member's first line,
   * absent when the producer reads only a template; a member is the same carrier whatever line it comes with.
   */
  | { kind: "member"; repo: string; file: string; owner: string; member: string; line?: number }
  /** The read of a member of `owner` at one occurrence outside its class; `column` is 1-based, so two reads on a line stay apart. */
  | { kind: "member-read"; repo: string; file: string; line: number; column: number; owner: string; member: string }
  /** The value a component method receives as its parameter at `index`, 0-based, when a template passes it; the method is named by its class, with no declaration line. */
  | { kind: "method-parameter"; repo: string; file: string; owner: string; method: string; index: number }
  /**
   * The value the call of `callee` in a template expression returns, going back to that expression: `resource` is the
   * template, `start` and `end` the expression's offsets in it, `argument` the 0-based position the value was passed at.
   */
  | { kind: "template-call-result"; repo: string; resource: string; start: number; end: number; callee: string; argument: number };

/** A value being followed, and where the changed property sits inside it. */
export interface Carrier {
  site: CarrierSite;
  path: AccessPath;
}

/** The code identity of a carrier, which is how the worklist knows it has been there. */
export function carrierKey(site: CarrierSite): string {
  if (site.kind !== "member") return canonicalJson(site);
  const { kind, repo, file, owner, member } = site;
  return canonicalJson({ kind, repo, file, owner, member });
}

/** The file or template a site is in. */
export const siteFile = (site: CarrierSite): string => ("resource" in site ? site.resource : site.file);

/** The first line of the site's declaration or its occurrence; absent when the site is not placed by a line. */
export const siteLine = (site: CarrierSite): number | undefined => ("line" in site ? site.line : undefined);

const FLOW_STEPS = [
  "http-call",
  "response-body",
  "return",
  "caller",
  "pipe",
  "map",
  "subscribe",
  "await",
  "to-signal",
  "assign",
  "fallback",
  "argument",
  "resource",
  "iterate",
  "resolver-input",
  "input",
  "route-data",
  "template-binding",
  "template-read",
] as const;

export type FlowStep = (typeof FLOW_STEPS)[number];

/**
 * The members of a resource (Angular `Resource`, `HttpResourceRef`) that report or replace its state and never hand out
 * its value: a call of one on a value followed through `value` is not a loss. `update` is absent: its callback reads the value.
 */
export const RESOURCE_STATE_MEMBERS: ReadonlySet<string> = new Set(["status", "error", "isLoading", "hasValue", "reload", "set", "destroy", "headers", "statusCode", "progress"]);

/** One step of a chain: what the code does with the value at `evidence`, and where the changed path moves because of it. */
export interface Hop {
  step: FlowStep;
  evidence: Evidence;
  /** Absent when the changed path stays where it was. */
  rewrite?: readonly PathMapping[];
}

/** A place the code operates on the carried value; `hops` are the steps from the carrier to it, nearest the carrier first. */
export interface FlowUse {
  site: Evidence;
  /** What the code reads from the value, in the coordinates of the value at `site`. */
  path: AccessPath;
  /** Where the changed property sits in that value. */
  changed: AccessPath;
  operation: UseOperation;
  guards: readonly Guard[];
  hops: readonly Hop[];
}

/** The value continues at another boundary; `carrier.path` is already in that value's coordinates. */
export interface FlowNext {
  carrier: Carrier;
  hops: readonly Hop[];
  evidence?: readonly Evidence[];
  /** Where the value comes back when the method it enters returns it and no graph edge knows the call: the template expression that called a component method. */
  returnsTo?: Extract<CarrierSite, { kind: "template-call-result" }>;
}

export const FRONTIER_CAUSES = [
  "link-basis",
  "no-call-site",
  "no-caller",
  "unresolved-caller",
  "ambiguous-caller",
  "graph-unavailable",
  "path-conflict",
  "unmodelled-flow",
  "unmodelled-sink",
  "dynamic-access",
  "template-unreadable",
  "unsupported-binding",
] as const;

export type FrontierCause = (typeof FRONTIER_CAUSES)[number];

/** A place the value is lost: where, why in words the taxonomy fixes, and the steps that got it there. */
export interface FlowFrontier {
  at: Evidence;
  cause: FrontierCause;
  reason: UnknownReason;
  /** What the cause alone does not say, such as the link basis. */
  detail?: string;
  hops: readonly Hop[];
}

/** What one reader found at one carrier. Every list is in source order; nothing is sorted across readers. */
export interface FlowResult {
  uses: readonly FlowUse[];
  next: readonly FlowNext[];
  frontiers: readonly FlowFrontier[];
}

export const NO_FLOW: FlowResult = { uses: [], next: [], frontiers: [] };

export function sourceUnreadable(site: CarrierSite): FlowResult {
  return { uses: [], next: [], frontiers: [{ at: { path: siteFile(site), line: siteLine(site) ?? 1 }, cause: "unmodelled-flow", reason: "source-unreadable", hops: [] }] };
}

export function templateUnreadable(at: Evidence): FlowResult {
  return { uses: [], next: [], frontiers: [{ at, cause: "template-unreadable", reason: "source-unreadable", hops: [] }] };
}
