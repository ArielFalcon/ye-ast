import type { SettledRangeChange } from "../impact/impact-fact.ts";
import type { EventTarget, HttpTarget, UnresolvedCallSite } from "../topology/call-site.ts";
import type { Link, UnlinkedCallSite } from "../topology/link.ts";
import type { SnapshotRef } from "../shared/fact.ts";

/**
 * How a step was reached from its parent: a resolved call or instantiation, `this.<member>`, a function passed as a
 * value, a member of a class root that has a body or an initializer that makes calls, or the one body a body-less
 * method dispatches to.
 */
export type TraceVia = "call" | "own-member" | "reference" | "member" | "dispatch" | "template";

/** A proven terminal declaration folded under the step that calls or passes it: expanded, with no call, external call or cut. */
export interface TraceLeaf {
  symbol: string;
  file: string;
  start: number;
  end: number;
  /** The caller passes it as a value: it runs later, if at all. */
  deferred?: true;
}

/**
 * A framework data operation, with its access class and only the entity or storage target the source proves.
 */
export type DataEffect = { kind: "data"; line: number; column?: number; operation: string; access: "read" | "write" | "unknown"; target?: { kind: "entity" | "table" | "collection"; name: string } };

/**
 * A call the RFC-0011 call-site extraction proves leaves the process through a declared client (an HTTP request, a
 * published message) with the target it resolves, or a declared framework data operation, at its 1-based line and
 * optional start column in the step's file. `deferred` marks one a function value makes that a registered combinator takes:
 * it runs later, if at all.
 */
export type TraceEffect = DataEffect | { kind: "http"; line: number; column?: number; target: HttpTarget; deferred?: true } | { kind: "message"; line: number; column?: number; target: EventTarget; deferred?: true };

/**
 * Calls that leave the repository, once per name. `import` names the package a file imports the callee from, `global` a
 * name the language's own libraries declare, and `unnamed` a member no declaration in scope is named after (closed world).
 */
export type ExternalCalls = { kind: "import"; module: string; names: readonly string[] } | { kind: "global" | "unnamed"; names: readonly string[] };

export interface TraceStep {
  id: number;
  parent?: number;
  depth: number;
  file: string;
  symbol: string;
  kind: string;
  line: number;
  endLine?: number;
  /** The call in the parent's body; absent on a root and on a member, and the column when the store places one (1-based). */
  at?: { line: number; column?: number };
  via?: TraceVia;
  /** The body passes the declaration as a value: it runs later, if at all. */
  deferred?: true;
  /** The id of the step that expanded the same declaration earlier in pre-order; this one is not expanded again. */
  seen?: number;
  leaves?: readonly TraceLeaf[];
  external?: readonly ExternalCalls[];
  /** The effects its body makes, by line (R12). */
  effects?: readonly TraceEffect[];
  /** Requests placed in this body whose destination remains unknown; not complete effects. */
  unresolvedEffects?: readonly UnresolvedCallSite[];
  /** Every body a call to this body-less method may run, when the declared hierarchy names them all (R7); one is expanded below it `via: "dispatch"`. */
  alternatives?: readonly Omit<TraceLeaf, "deferred">[];
}

/** One range of a file to read, with the steps whose declarations it covers. */
export interface ReadingRange {
  file: string;
  start: number;
  end: number;
  steps: readonly number[];
}

export interface ReadingPlan {
  /** Grouped by file in the order a file first appears in the steps; within a file by line. */
  ranges: readonly ReadingRange[];
  lines: number;
}

/** A workspace match as a trace reports it; `deferred` when only effects that run later, if at all, reach it. */
export type TraceLinked<T> = T & { deferred?: true };

export interface TraceValue {
  /** Present with workspace reading; links are restricted to exactly placed effects in this trace. */
  repositorySnapshots?: readonly { repo: string; snapshot: SnapshotRef }[];
  links?: readonly TraceLinked<Link>[];
  unlinked?: readonly TraceLinked<UnlinkedCallSite>[];
  /** Per requested target, in the request's fixed order, the root steps it selected: homonyms and ranges select several. */
  roots: readonly { target: string; steps: readonly number[] }[];
  /** The requested ranges whose every line holds no token; present when not empty, sorted by file and position. */
  settled?: readonly SettledRangeChange[];
  /** In pre-order: the roots in position order, each followed by its subtree. */
  steps: readonly TraceStep[];
  readingPlan: ReadingPlan;
  /** The declarations whose bodies were read. */
  cost: { expanded: number };
}
