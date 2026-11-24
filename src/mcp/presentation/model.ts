import type { SnapshotRef } from "../../core/domain/shared/fact.ts";

export type SectionRole = "answer" | "completeness" | "context";

export interface Place {
  repo?: string;
  path: string;
  line?: number;
  endLine?: number;
  /** How an evidence place was found and how sure that is; printed only on an evidence place, never on a row's own. */
  via?: string;
  confidence?: number;
}

/** One stated fact about a row, printed in parentheses: depth, confidence, fan-in, via. */
export interface Qualifier { name: string; value?: string }

export interface Row {
  /** The identity of the fact the row states; never printed. Unique within its section. */
  key: string;
  /** Where the fact is. Absent for a fact with no place (a count, a name). */
  place?: Place;
  /** What the fact is: `http-route GET /api/x`, `save [method]`. */
  label: string;
  qualifiers?: readonly Qualifier[];
  /** The places that prove the row beyond its own place. Printed in `details` only; `summary` counts them. */
  evidence?: readonly Place[];
  /** Rows the fact contains: the calls of a trace step, the members of a declaration. */
  children?: readonly Row[];
  /** The children are the answer, so `summary` prints them too (trace steps, outline members). */
  childrenAreAnswer?: true;
  /** 0: asked directly (a direct dependent, a link). 1 and above: reached through tier 0. Default 0. */
  tier?: number;
}

export interface Section {
  /** Stable name, also the member of `answer.json` the rows come from (`value.symbols`). */
  id: string;
  title: string;
  role: SectionRole;
  layout: "by-file" | "list" | "tree";
  rows: readonly Row[];
  /** The one section `page` pages when no `select` is given. At most one per presentation. */
  primary?: true;
  /** A selection addresses the rows by position, so each top-level row prints its zero-based position in `rows` as `n. `. */
  numbered?: true;
}

export interface Presentation {
  /** The completeness verdict lines, as `renderFactStatus` writes them. */
  status: readonly string[];
  /** One per repository read. */
  snapshots: readonly SnapshotRef[];
  /** Scope and change selection, only when the caller narrowed. */
  narrowing?: readonly string[];
  sections: readonly Section[];
  /** A step tied to a cut or gap of this answer and to the parameter or tool that lifts it. */
  next?: readonly { cause: string; step: string }[];
}
