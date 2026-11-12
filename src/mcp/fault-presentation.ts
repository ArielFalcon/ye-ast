import { entrypointCandidateText, unknownEntryText, unknownTargetKey } from "../core/domain/shared/unknown-target.ts";
import type { QueryFamily } from "../core/ports/evidence-composition.port.ts";
import type { QueryFault } from "./query-runner.ts";
import { familyOf, type SemanticQuery } from "./query-schema.ts";
import type { ComposeFault, SourceIdentityCause, UnavailableReason } from "./composition-contract.ts";
import type { SelectionFault } from "./select-evidence.ts";
import type { SourceVerificationFault } from "./evidence-cursor.ts";

export type CodedFault = SelectionFault | SourceVerificationFault;
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
  family: QueryFamily;
  live: boolean;
  /** The family's subject form: outline's `files`/`focus`, or importers' `files`. */
  subject?: "files" | "focus" | "importers";
  /** A contract_consequences read of a change between revisions: it names `base` and `head`, as impact does. */
  change?: true;
  workspace: boolean;
  /** Explicit member paths supplied by the request. */
  members: boolean;
  replay: boolean;
  select: boolean;
  cursor: boolean;
  expect: boolean;
};

export type FaultControls = { select?: unknown; page?: { cursor?: string | undefined } | undefined; expect?: unknown };

export function faultContext(query: SemanticQuery, controls: FaultControls = {}): FaultQueryContext {
  const args: { live?: boolean | undefined; workspace?: { repos?: unknown } | undefined; repos?: unknown; replay?: unknown; focus?: unknown; base?: unknown; hypotheses?: unknown } = query.arguments;
  const family = familyOf(query.name);
  const subject = family === "outline" ? (args.focus === undefined ? "files" as const : "focus" as const) : family === "importers" ? "importers" as const : undefined;
  return {
    family,
    live: args.live === true,
    ...(subject === undefined ? {} : { subject }),
    ...(family === "contract_consequences" && args.base !== undefined ? { change: true as const } : {}),
    workspace: args.workspace !== undefined || family === "workspace" || family === "decisions" || family === "contract_consequences",
    members: args.workspace?.repos !== undefined || args.repos !== undefined,
    replay: args.replay !== undefined,
    select: controls.select !== undefined,
    cursor: controls.page?.cursor !== undefined,
    expect: controls.expect !== undefined,
  };
}

/** The published form of a refusal the selection or cursor layer reports by code. */
export function controlFault(fault: CodedFault): ControlFault {
  switch (fault.code) {
    case "invalid-cursor":
    case "selection-not-found":
    case "ambiguous-selection": return { kind: fault.code, detail: fault.code };
    case "replay-unavailable": return { kind: fault.code, detail: fault.code, reason: fault.reason };
    case "result-changed": return { kind: fault.code, detail: fault.code, expected: fault.expected, actual: fault.actual, stage: fault.stage };
  }
}

/** The text of a fault: its kind first, its detail and entries, and a next step only where an argument can correct it. */
export function renderFault(fault: RenderedFault, query?: FaultQueryContext): string {
  const entries = fault.kind !== "duplicate-repository" && "entries" in fault ? fault.entries.map((entry) => `\n  - ${"kind" in entry ? entrypointText(entry) : `${"line" in entry ? `${entry.file}:${entry.line}` : unknownTargetKey(entry)}: ${unknownEntryText(entry)}`}`).join("") : "";
  const head = `fault: ${fault.kind}\n${displayDetail(fault).trim()}${entries}`;
  if (fault.kind === "composition-source-fault") {
    return `${head}\nThe composition returned nothing: queries[${fault.requestIndices.join(", ")}] (${fault.family}) failed. Correct them as below and resend the whole composition.\n${renderFault(fault.cause, query)}`;
  }
  const step = nextStep(fault, query);
  return step === undefined ? head : `${head}\nNext step: ${step}`;
}

function entrypointText(entry: { kind: string; name: string; candidates: readonly string[] }): string {
  return `${entry.kind} ${entry.name}: ${entrypointCandidateText(entry)}`;
}

function displayDetail(fault: RenderedFault): string {
  if (fault.detail !== fault.kind) return fault.detail;
  switch (fault.kind) {
    case "invalid-cursor": return "The cursor cannot be used with this query, selection, page limit and identity";
    case "selection-not-found": return "The selection names no record of this result";
    case "ambiguous-selection": return "The selection matches more than one record of this result";
    case "replay-unavailable": return `This result has no verifiable identity (${fault.reason})`;
    case "result-changed": return "The result differs from the asserted identity";
    default: return fault.detail;
  }
}

/** The argument that selects the commit read. */
function commitArgument(query: FaultQueryContext | undefined): string {
  return query === undefined ? "the selected commit" : readsChange(query) ? "head" : "revision";
}

/** Impact and a contract_consequences change read two commits, base and head. */
function readsChange(query: FaultQueryContext): boolean {
  return query.family === "impact" || query.change === true;
}

function membersArgument(query: FaultQueryContext | undefined): string {
  return query?.family === "workspace" || query?.family === "decisions" ? "repos" : "workspace.repos";
}

/** The argument of the tool that faulted naming a file a target can use instead. */
const FILE_ARGUMENT: Readonly<Record<NonNullable<FaultQueryContext["subject"]>, string>> = { files: "files[]", focus: "focus[].file", importers: "files" };

function omitLive(query: FaultQueryContext | undefined): string {
  return `omit live and pass a committed ${commitArgument(query)}; that answer excludes uncommitted edits`;
}

function nextStep(fault: Exclude<RenderedFault, { kind: "composition-source-fault" }>, query: FaultQueryContext | undefined): string | undefined {
  switch (fault.kind) {
    case "unknown-revision": {
      const argument = query !== undefined && readsChange(query) ? (query.live ? "base" : "base or head") : commitArgument(query);
      const member = query?.members
        ? `Also check ${membersArgument(query)}[].revision.`
        : query?.workspace ? "Also check persisted workspace member revisions in the host configuration." : undefined;
      return [
        `${argument} must resolve to a local commit: pass a branch, tag or sha the owning clone holds${query !== undefined && readsChange(query) ? "" : ", or omit it to read HEAD"}.`,
        ...(member === undefined ? [] : [member, "This fault does not identify which repository's revision failed."]),
      ].join(" ");
    }
    case "no-merge-base":
      return query?.family === "impact"
        ? "base and head share no ancestor: choose commits of one history. The diff runs from merge-base(base, head); a direct diff is not substituted."
        : "The commits share no ancestor: choose commits of one history.";
    case "not-repository-root":
      return query?.members
        ? `Check the selected repository registration and ${membersArgument(query)}[].path: every repository path must be its clone root. This fault does not identify which one failed.`
        : query?.workspace
          ? "Check the selected repository registration and persisted workspace member roots. This fault does not identify which one failed; correct the corresponding host configuration."
          : "The selected repository registration must point to its clone root; correct its host configuration.";
    case "object-missing":
      return `This clone lacks the Git objects of ${query?.family === "impact" ? "base, head or their merge base" : query?.change === true ? "base or head" : commitArgument(query)}: fetch them into the clone or choose a commit it holds. ye-ast never downloads.`;
    case "live-requires-trusted":
      if (query?.workspace || query?.members) {
        const members = query.members ? `${membersArgument(query)} member live selectors` : "persisted workspace member live selectors";
        return `This fault does not identify which repository lacks declared trust. Review ${query.live ? "the top-level live selector and " : ""}${members}; omit live at the affected selectors to read committed content, or have the user declare trust for those repositories. Repository content cannot grant trust.`;
      }
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
    case "unknown-symbol": {
      const step = query?.subject === "importers"
        ? "Pass one of the listed candidates as files; candidates are alternatives, not substitutions."
        : query?.family === "outline"
        ? "Use a listed dotted path as focus[].symbol, or a line inside a declaration as focus[].line; files lists the file whole. Candidates are alternatives, not substitutions."
        : `Use a listed candidate as targets[].symbol, or an inclusive line range {file, start, end}. A line range listed here covers no declaration and no code: call ye_ast_outline for these files at the same ${query?.live ? "live state" : "revision"} and pick a range inside a declaration's span. Candidates are alternatives, not substitutions.`;
      const fileArgument = query?.subject === undefined ? "targets[].file" : FILE_ARGUMENT[query.subject];
      return fault.entries.some((entry) => entry.absent)
        ? `${step} For a file not in the snapshot, use a listed snapshot path as ${fileArgument}: it takes a repository-relative path from the repository root.`
        : step;
    }
    case "unknown-entrypoint":
      return "Use a listed name of that kind as targets[].name, spelled as ye_ast_entrypoints lists it at the same revision; an empty list means the map holds no entrypoint of that kind. Candidates are alternatives, not substitutions.";
    case "top-level-line":
      return "The line lies outside every declaration: focus on a line inside one, or on a listed dotted path as focus[].symbol; files lists the file whole.";
    case "unknown-scope-path":
      return "Correct the include globs against the paths held by the snapshot.";
    case "unknown-change-path":
      return "Correct the changed globs against the paths base..head touches. Remove changed to walk every change within the declared scope; mode or budget cannot fix a path-selection mismatch.";
    case "duplicate-repository":
      return `Drop all but one of the named ${membersArgument(query)} entries, keeping the id and revision intended; a duplicate among persisted members is corrected in the host's workspace declaration.`;
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
    case "invalid-hypothesis":
      return `Correct hypotheses[${fault.index}] and resend them all: nothing is answered while one is refused. method is an HTTP verb, path starts with /, target is response or request, property is an access path such as pets[].name, and change is an entry the target supports.`;
    case "contradictory-revisions":
      return "A change is answered at its head commit, never on the working tree: name the commit with head, and omit live and any other revision for the bound repository.";
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
      ? `select and page cannot recover a source cut by a deadline. ${cause}`
      : `select and page need a verifiable identity. ${cause} A new query without select and page${query.expect ? ", and without the expect it cannot verify," : ""} in mode full returns the data this analysis records; it cannot restore analysis or history that was never captured.`;
  }
  return `expect cannot be checked. ${cause} Omitting expect accepts an unverified result; that is the caller's decision.`;
}
