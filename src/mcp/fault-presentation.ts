import type { ToolFamily } from "./presentation.ts";
import type { QueryFault } from "./query-runner.ts";
import { familyOf, type SemanticQuery } from "./query-schema.ts";
import type { ComposeFault, SourceIdentityCause, UnavailableReason } from "./composition-contract.ts";
import type { SelectionFault } from "./select-evidence.ts";
import type { SourceVerificationFault } from "./evidence-cursor.ts";

type CodedFault = SelectionFault | SourceVerificationFault;
type Published<F> = F extends { code: infer C extends string } ? (C extends string ? Omit<F, "code"> & { kind: C; detail: string } : never) : never;
/** A selection, cursor or identity refusal of an original tool, published with `kind` like every other fault. */
export type ControlFault = Published<CodedFault>;
/** Every fault a tool answers as `isError`. */
export type PublicFault = QueryFault | ComposeFault | ControlFault;
type RenderedFault = PublicFault | SourceIdentityCause;

/**
 * What a fault's guidance may name about the query that faulted: argument names and flags only, never argument values,
 * so no clone path, revision or selector the request supplied reaches the text through it.
 */
export type FaultQueryContext = {
  family: ToolFamily;
  live: boolean;
  /** Outline's subject form. */
  subject?: "files" | "focus";
  /** callers/impact crossing into a workspace, or workspace/decisions given explicit repos. */
  members: boolean;
  replay: boolean;
  select: boolean;
  cursor: boolean;
  expect: boolean;
};

export type FaultControls = { select?: unknown; page?: { cursor?: string | undefined } | undefined; expect?: unknown };

export function faultContext(query: SemanticQuery, controls: FaultControls = {}): FaultQueryContext {
  const args: { live?: boolean | undefined; workspace?: { repos?: unknown } | undefined; repos?: unknown; replay?: unknown; focus?: unknown } = query.arguments;
  const family = familyOf(query.name);
  return {
    family,
    live: args.live === true,
    ...(family === "outline" ? { subject: args.focus === undefined ? "files" as const : "focus" as const } : {}),
    members: args.workspace !== undefined || args.repos !== undefined,
    replay: args.replay !== undefined,
    select: controls.select !== undefined,
    cursor: controls.page?.cursor !== undefined,
    expect: controls.expect !== undefined,
  };
}

/** The published form of a refusal the selection or cursor layer reports by code. */
export function controlFault(fault: CodedFault): ControlFault {
  switch (fault.code) {
    case "invalid-cursor": return { kind: fault.code, detail: "The cursor does not belong to this query, selection, page limit and identity" };
    case "selection-not-found": return { kind: fault.code, detail: "The selection names no record of this result" };
    case "ambiguous-selection": return { kind: fault.code, detail: "The selection matches more than one record of this result" };
    case "replay-unavailable": return { kind: fault.code, detail: `This result has no verifiable identity (${fault.reason})`, reason: fault.reason };
    case "result-changed": return { kind: fault.code, detail: "The result differs from the asserted identity", expected: fault.expected, actual: fault.actual, stage: fault.stage };
  }
}

/** The text of a fault: its kind first, its detail and entries, and a next step only where an argument can correct it. */
export function renderFault(fault: RenderedFault, query?: FaultQueryContext): string {
  const entries = "entries" in fault ? fault.entries.map((entry) => `\n  - ${entry.file}:${"line" in entry ? entry.line : entry.symbol}: ${declarationText(entry)}`).join("") : "";
  const head = `fault: ${fault.kind}\n${fault.detail.trim()}${entries}`;
  if (fault.kind === "composition-source-fault") {
    return `${head}\nThe composition returned nothing: queries[${fault.requestIndices.join(", ")}] (${fault.family}) failed. Correct them as below and resend the whole composition.\n${renderFault(fault.cause, query)}`;
  }
  const step = nextStep(fault, query);
  return step === undefined ? head : `${head}\nNext step: ${step}`;
}

function declarationText(entry: { file: string; candidates: readonly string[] }): string {
  return entry.candidates.length === 0 ? `${entry.file} declares no symbol` : `declared in ${entry.file}: ${entry.candidates.join(", ")}`;
}

/** The argument that selects the commit read. */
function commitArgument(query: FaultQueryContext | undefined): string {
  return query === undefined ? "the selected commit" : query.family === "impact" ? "head" : "revision";
}

function membersArgument(query: FaultQueryContext | undefined): string {
  return query?.family === "workspace" || query?.family === "decisions" ? "repos" : "workspace.repos";
}

function omitLive(query: FaultQueryContext | undefined): string {
  return `omit live and pass a committed ${commitArgument(query)}; that answer excludes uncommitted edits`;
}

function nextStep(fault: Exclude<RenderedFault, { kind: "composition-source-fault" }>, query: FaultQueryContext | undefined): string | undefined {
  switch (fault.kind) {
    case "unknown-revision":
      return `${query?.family === "impact" ? "base or head" : commitArgument(query)} must resolve to a local commit: pass a branch, tag or sha this clone holds${query?.family === "impact" ? "" : ", or omit it to read HEAD"}${query?.members ? `; a ${membersArgument(query)}[].revision may be the one that does not resolve` : ""}.`;
    case "no-merge-base":
      return query?.family === "impact"
        ? "base and head share no ancestor: choose commits of one history. The diff runs from merge-base(base, head); a direct diff is not substituted."
        : "The commits share no ancestor: choose commits of one history.";
    case "not-repository-root":
      return query?.members
        ? `Every ${membersArgument(query)}[].path must be the top-level directory of its clone, not a subdirectory.`
        : "The server's bound repository path is not a repository root; it is host configuration, not a query argument.";
    case "object-missing":
      return `This clone lacks the Git objects of ${query?.family === "impact" ? "base, head or their merge base" : commitArgument(query)}: fetch them into the clone or choose a commit it holds. ye-ast never downloads.`;
    case "live-requires-trusted":
      return query?.live
        ? `Live reads need a repository the user declared trusted (ye-ast init --trust trusted); repository content cannot grant it. Otherwise ${omitLive(query)}.`
        : `A ${membersArgument(query)} entry asks for live on a repository not declared trusted; omit live on that entry or have the user declare it trusted.`;
    case "unsupported-object-format":
      return `Live reads do not support this repository's object format: ${omitLive(query)}.`;
    case "live-mirror-failed":
      return `Copying the working tree failed for the reported reason: retry once it is fixed, or ${omitLive(query)}.`;
    case "unreadable":
      return "A file ye-ast must read is unreadable for the reported reason: fix it in the clone, then retry; mode or budget do not change it.";
    case "unwritable":
      return "ye-ast could not write its .ye-ast layer under the repository root: fix permissions or free space there, then retry.";
    case "export-write-failed":
      return "Exporting the snapshot to a temporary directory failed: free space or fix permissions of the temporary directory, then retry.";
    case "git-failed":
      return "Git failed for the reported reason: fix that condition in the clone, then retry; mode or budget do not change it.";
    case "invalid-name":
    case "aborted":
    case "internal-fault":
      return undefined;
    case "unknown-symbol":
      return query?.family === "outline"
        ? "Use a listed dotted path as focus[].symbol, or a line inside a declaration as focus[].line; files lists the file whole. Candidates are alternatives, not substitutions."
        : `Use a listed candidate as targets[].symbol, or an inclusive line range {file, start, end}; ye_ast_outline with files at the same ${query?.live ? "live state" : "revision"} lists declaration spans. Candidates are alternatives, not substitutions.`;
    case "top-level-line":
      return "The line lies outside every declaration: focus on a line inside one, or on a listed dotted path as focus[].symbol; files lists the file whole.";
    case "unknown-change-path":
      return "Correct the changed globs against the paths base..head touches. Remove changed to walk every change within the declared scope; mode or budget cannot fix a path-selection mismatch.";
    case "duplicate-repository":
      return `Two ${membersArgument(query)} entries name the same repository: keep one, with the intended id and revision.`;
    case "duplicate-workspace-source":
      return `Remove the duplicate workspace source identified by the repository IDs: one ${membersArgument(query)} entry per repository.`;
    case "workspace-capture-unavailable":
      return fault.cause.kind === "live-requires-trusted"
        ? "The named repository is not declared trusted, so its working tree cannot be captured live: omit live for it, or have the user declare it trusted."
        : "Inspect the capture cause of the named repository: retry when its working tree can be captured, or omit live to read committed snapshots, which exclude uncommitted edits.";
    case "unknown-repository":
      return "Set repo to one of the declared IDs in available; declaring another repository is host configuration.";
    case "ambiguous-repository":
      return "The host declares this ID for several paths; no repo value can disambiguate it until the server's repository catalog is fixed.";
    case "workspace-replay-mismatch":
      return newMembershipQuery();
    case "result-changed":
      switch (fault.stage) {
        case "workspace-replay": return newMembershipQuery();
        case "source-identity":
          return query?.cursor
            ? "The result behind page.cursor changed. To accept the new result, restart without page.cursor and set expect to actual or omit it; earlier pages belong to the old result."
            : "The current result differs from expect. To accept it, set expect to actual or omit expect; it is a different result, not the asserted one.";
        case "composition":
          return "The composition differs from its expect. To accept it, set the composition's expect to actual or omit it; it is a different composition, not the asserted one.";
      }
    case "replay-unavailable":
      return "stage" in fault && fault.stage === "composition"
        ? `The composition has no verifiable identity (${fault.reason}), so its expect cannot be checked. ${unavailableCause(fault.reason)}`
        : unverifiable(fault.reason, query);
    case "invalid-cursor":
      return "Pass page.nextCursor from the previous page with the same query, select, page.limit and expect, or restart without page.cursor.";
    case "selection-not-found":
      return "Copy select's coordinates and owner from a details or full answer of this same query; indices are zero-based.";
    case "ambiguous-selection":
      return "Add the owner or coordinates that tell the matching records apart, as a details or full answer of this query prints them.";
    case "composition-request-too-large":
      return "Split the queries over several ye_ast_compose calls or shorten their arguments; each call reruns its queries independently.";
    case "composition-conflicting-expectations":
      return `queries[${fault.requestIndices.join(", ")}] repeat one query with different expect values: keep one expect, or none, for all of them.`;
    case "deadline":
      return "The composition ran out of time before every query finished: send fewer or narrower queries per call. Mode does not change the work.";
  }
  const unhandled: never = fault;
  return unhandled;
}

function newMembershipQuery(): string {
  return "The workspace no longer matches the replayed membership or captured state, so the earlier result cannot be reproduced. For the current workspace send a new query without replay and without expect; it answers about today's membership, not the earlier result.";
}

function unavailableCause(reason: UnavailableReason): string {
  switch (reason) {
    case "deadline": return "The analysis hit its deadline: a narrower scope or fewer targets may let it finish; no presentation mode restores missing analysis.";
    case "unresolved-context": return "Its snapshot or declared context did not resolve to exact values; no argument of this query records them.";
    case "redacted-context": return "Its context holds redacted values, which an identity cannot cover.";
  }
}

/** A recoverable tool's selection or assertion that needs an identity the answer cannot carry. */
function unverifiable(reason: UnavailableReason, query: FaultQueryContext | undefined): string {
  const cause = unavailableCause(reason);
  if (query?.select) {
    return reason === "deadline"
      ? `select and page need a complete analysis. ${cause}`
      : `select and page need a verifiable identity. ${cause} A new query without select and page${query.expect ? ", and without the expect it cannot verify," : ""} in mode full returns the data this analysis records; it cannot restore analysis or history that was never captured.`;
  }
  return `expect cannot be checked. ${cause} Omitting expect accepts an unverified result; that is the caller's decision.`;
}
