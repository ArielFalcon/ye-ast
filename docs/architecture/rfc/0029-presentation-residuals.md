# RFC-0029: An answer never hides or misstates what the engine knows

- Status: Accepted, 2026-11-09. Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (every open question settled as recommended; see Resolved questions). ADR-0051 records its decisions.
- Reproductions: kept with the study run outside the repository (`evaluations/runs/20261108T2245Z-agent-usefulness-12f8/engine-gaps/designs/rfc-0029-presentation-residuals/repro`).
- Related: RFC-0002 (facts, cuts, declared scope), RFC-0005 (MCP and CLI), RFC-0010 (impact values), RFC-0017 (answer
  size), RFC-0025 U5 (what `include` selects), ADR-0042 (completeness relative to the question), ADR-0045 (assembly
  line). Repository paths are relative to the engine root at `main` `ebd12a4f`; every citation below was re-read at that
  commit.

**In short:** seven rules, not one per repository. A file no commit entry holds is a fault in every family
that names a file, checked before any readable-file filter; the text of a fault entry has one owner in the core. A
declared answer bound is met by a shorter projection and refused when even that does not fit, never truncated. A fault
that names duplicated workspace entries says which entries. An `include` that selects nothing is a fault. A reached UI
route names the route's own declaration.

## Why these, and what is already closed

The study (`RUN/engine-gaps/consolidated.md`, 54 % of graded needs) found the fact was present and the answer hid it or
misstated it. Three mechanisms are already closed on `main` and are **out of scope** (confirmed by
`git show de7841e8 552a2030 6d21e7bc 96bf4389 --stat` and by reading the code at `ebd12a4f`):

| Closed | Where |
|---|---|
| An absent target faults with `absent: true` and candidate paths (`callers` symbol and range, `impact`, `trace`, `outline` **focus on a readable path**) | `snapshot-files.ts:5-32`, `root-selection.ts:63-66`, `outline-queries.ts:73-77` |
| `callers`/`impact` `details` selects the nearest **dependent**, not the nearest depth; a dispatch link places context, never a dependent | `render.ts:586-600` (`investigationSymbols`) |
| `callers` prints the call place as `via <caller> at <line>` on each row | `render.ts:254-260` (`viaText`), observed: `via createSpringSecurityUser at 40, 47` |

The third answers "`callers` never prints the call place": the place is the `at <lines>` clause of `via`, present in
`summary` and `details` (probe `repro/plan-callers-callsite.json`). No unit re-designs it.

## Problems

| # | Study items | Symptom (asked → answered → oracle) | Evidence |
|---|---|---|---|
| 1 | N-JHIPSTER-TS-FLOW.B2-N1, N-shopizer-TS-FLOW.B2-N1 | `importers` and `outline files` on a guessed path → `status: partial (cuts: 1 not-exported unwritten)`; oracle: no such file, `label-update.ts` is the real one | `jhipster/application:src/main/webapp/app/entities/label/update/label-update.ts:54-62` |
| 2 | N-realworld-TS-IMPACT.B2-N1 | `outline focus` on the extensionless path `x` → `status: partial` + `no-extractor (1): x`; oracle: the file is absent | `reprobe-6d21e7bc/summary.md:83`, `outline-queries.ts:60-62,73-77` |
| 3 | N-shopizer-J-FLOW.A2-N1/N2, N-nname-TS-ROUTES.B1-N2 | `entrypoints` details on `sm-shop/**` → 104,538 characters (104,642 bytes) in 963 lines; `trace` over four UI routes → 567,333 bytes; both rejected by the client; oracle: the routes, not the dump | `sessions/shopizer-J-FLOW.A2/digest.md:24-46`, `reprobe-6d21e7bc/summary.md:81` |
| 4 | N-nname-X-FIELD.A1-N1 | `workspace.repos` names one repository twice → `fault: duplicate-repository` + the bare id; oracle: which entry to drop | probe `repro/plan-duplicate-repository.json` |
| 5 | N-nname-TS-FLOW.B1-N1 | the CLI and the MCP each format a fault entry from their own copy of the same function | `cli/main.ts:141-154`, `fault-presentation.ts:78-97` |
| 6 | N-realworld-TS-ROUTES.B2-N1 | `entrypoints` with an `include` glob matching no path → `status: complete`, 0 findings, no diagnostic; oracle: the glob is wrong | `scope.ts:17-19`, `entrypoint-queries.ts:56` |
| 7 | N-nname-TS-IMPACT.A1-N2, .B1-N3, .B2-N2 | a reached `ui-route` names its component and depth but never the route declaration's own `file:line`; oracle: the agent greps the routing table | `ui-route.ts:18-28`, `reached-entrypoints.ts:21-46` |
| 8 | N-JHIPSTER-TS-IMPACT.B1-N1, N-JHIPSTER-TS-IMPACT.A1/A2-N2 | `importers` lists related files but never the line each relationship is written on: `"…register.ts": importers[2], users[2], unresolved name matches[2]` then `These relationships are paths only; no relationship line locations were recorded`; oracle: `register.ts:12` | `reprobe-6d21e7bc/answers/N-JHIPSTER-TS-IMPACT.B1-N1.txt` |

## Root cause

### M1 — a target's absence is decided by the index, after a readable-file filter (confirmed)

`importers` builds `fixed` and `covered` from the file extension and returns early when `covered` is empty
(`impact-queries.ts:233-235`); only then opens the index and turns every `read.unheld` file into `unheldCut`
(`:267`), which can say only `not-indexed` or `not-exported` (`impact-cuts.ts:112-114`). `outline` repeats the shape:
`fixed`/`covered`/early return at `outline-queries.ts:60-62`, `unheldCut` at `:93`, and `readFocus` filters by
`isReadableFile` (`:75`) **before** `snapshotFiles` sees the selector — so an extensionless absent path never reaches the
absent-file check. The listing each family asks is also `export.files` only (`outline-queries.ts:73`,
`impact-queries.ts:176` for callers, `impact-queries.ts:244` for importers, `trace-queries.ts:126`), although a path the
export **skipped** still exists in the commit (`export.skipped`, `vcs.port.ts:23-27`) and already carries a
`not-exported` cut through `exportCuts` (`entrypoint-map.ts:96-110`). The engine already has the correct rule once:
`listingOf` (`impact-queries.ts:130-131`) is "every path of the snapshot, written or not, skipped entries included", and
it is used only for module dependencies.

Reproduced: `repro/plan-jhipster.json` steps 1-2 answer `status: partial` + `not-exported` for
`label-update.component.ts`; `reprobe-6d21e7bc/summary.md:83` records `outline focus` on `x` answering
`no-extractor (1): x`.

### M2 — no answer is bounded, and no signal exists to bound it (confirmed mechanism, measured symptom)

`size()` only chooses between two candidate texts (`render.ts:700,709`, and `:745` by shape; see
`presentation-sharing.ts`). Every renderer prints its whole body, and the schemas say the limits are work: the trace
budget "Limits work, not result size" (`query-schema.ts:74-77`). The MCP text has three paths, all unbounded: the
selection receipt (`server.ts:487`), the `full` branch (`:493`) and the summary/details branch (`:518`); each family's
renderer is selected by a table and passed to `respond` (`server.ts:416-430`, `presentation.ts:6-15`).

Measured: `entrypoints` details `sm-shop/**` = 104,538 characters / 963 lines, summary = 62,708 characters / 349 lines
(`repro/000-R29-ENTRYPOINTS-*.json`); trace over four UI routes = 567,333 bytes
(`reprobe-6d21e7bc/summary.md:81`). The rejecting client declared no number, only "exceeds maximum allowed tokens".

### M3 — the duplicate fault keeps the id and drops the entries (confirmed)

`workspace-plan.ts:170-174` builds `asked = [request.repo, ...inForce.value.repos]`, computes `ids` in that order, finds
the first repeated id and faults with `detail: duplicate`. It never records which entries collided, and `asked[0]` is the
launch repository, which is not an element of the request's `repos`. Probe: `fault: duplicate-repository` /
`application` / "keep one, with the intended id and revision".

### M4 — the fault entry vocabulary has two implementations (confirmed)

`declarationText` is byte-identical in `cli/main.ts:151-154` and `fault-presentation.ts:94-97`; `entrypointText`
(`fault-presentation.ts:78-80`) and the CLI's inline branch (`main.ts:145`) repeat the same rule. Entrypoints may not
import each other (AGENTS.md dependency table), so the copy is structural.

### M5 — the declared scope is never checked against what the commit holds (confirmed)

`pathSelection` is a predicate (`scope.ts:17-19`): an `include` glob that matches nothing selects nothing, and no family
compares the globs with the paths the commit holds. The published contract promises an error only for `changed`
(README:293), so the contract needs the same sentence for `include`.

### M6 — a reached UI route drops its declaration place (confirmed)

`Finding.evidence` holds the route entry's place (`angular-routes.adapter.ts:123`), and `reachedEntrypoints` builds
`ReachedEntrypoint` from `handler` only (`reached-entrypoints.ts:21-46`). `ReachedEntrypoint` has no field for it
(`impact-fact.ts:64-72`), and `entrypointLine` prints only the component (`render.ts:274-277`).

### M7 — the `importers` fact drops the line every source of a relationship already has (confirmed)

`ImportedFile` lists related files as paths (`importers-fact.ts:6-28`). Each source of a relationship carries a line: a
graph edge has `line` (`code-graph.port.ts:63-68`), a module statement has `line` (`module-dependency.ts:25-29`), and an
unresolved reference has `line` (`impact-cuts.ts:8-21`). `readImporters` flattens every one of them to its source file
(`importers.ts:55-57` for edges, `:36-44` for statements) and drops the line; `unresolvedNamersOf` does the same for
references (`importers-fact.ts:46-54`). The renderer can therefore only print paths, and says so
(`render.ts:1122`). This is a fact gap, not a rendering rule: the engine read the line and the value never kept it.

Reproduced (`reprobe-6d21e7bc/answers/N-JHIPSTER-TS-IMPACT.B1-N1.txt`, jhipster/application at `6b000b5d`):
`importers` on `src/main/webapp/app/account/register/register.service.ts` answers `"…/register.ts": importers[2],
users[2], unresolved name matches[2]` and then "These relationships are paths only"; the import it should name is
`register.ts:12`.


## Reach

| Mechanism | Every site | Variants |
|---|---|---|
| M1 | `unheldCut`: `outline-queries.ts:93`, `impact-queries.ts:267`. Listings built from `export.files` only: `outline-queries.ts:73`, `impact-queries.ts:176` (callers), `impact-queries.ts:244` (importers), `trace-queries.ts:126`; the correct rule already exists as `listingOf` (`impact-queries.ts:130-131`) but only module dependencies use it | any wrong path in `importers`, `outline files`, `outline focus`; a target naming a **skipped** path (symlink, unsafe path, submodule) is misreported `absent: true` by `trace`/`impact` today |
| M2 | the three text paths in `respond` (`server.ts:487,493,518`) and every renderer | any family can exceed a client cap silently (`status: complete`) |
| M3 | `workspace-plan.ts:170-174`; `duplicate-workspace-source` (`fault-presentation.ts:181-182`) already names ids | a duplicate among persisted members (`workspace.source: persisted`) names no entry |
| M4 | every fault entry shape; `top-level-line` entries use the same sentence | `unknown-symbol`, `top-level-line`, `unknown-entrypoint` |
| M5 | `scope` on every family (`declaredScope`/`pathSelection`/`exportSelection`) | a typo in `include`; an include matching only excluded paths (no path is in scope); a scope whose only match is a skipped path (held, so matched) |
| M6 | `ReachedEntrypoint` consumers: impact, callers, workspace sections, compose rows | an `unknown` entrypoint whose evidence is a class is a join defect, not this mechanism |
| M7 | `readImporters` (`importers.ts:36-57`), `unresolvedNamersOf` (`importers-fact.ts:46-54`), `renderImporters` (`render.ts:1106-1128`), the MCP `importers` output schema (`server.ts:256-257`) | any relationship whose line exists but is not kept: a static import, a re-export, a dynamic or type import, a call edge, a name match |

## Classified, not designed here

| T6 item(s) | Why |
|---|---|
| every item whose symptom is "depth-1 callers replaced by `N other symbols`" | Closed at `ebd12a4f`: `render.ts:586-600` selects by relation, and dispatch only places context. |
| `N-PETCLINIC-J-IMPACT.A1-N1/A2-N1`, `N-realworld-J-IMPACT.A2-N2`, `CF-*` "test callers dropped by policy" (`inbound-origins.ts:29`) | The engine never reads those edges: it is a declared policy, not hidden knowledge. Disclosing it costs bytes on every answer; resolved question 5 keeps it out until measured. |
| `N-PETCLINIC-J-IMPACT.A2-N1` class-level `unknown` entrypoint row | The join settled an entrypoint to a class: a binder/reconciliation defect (T5), not a renderer rule. |
| `N-realworld-TS-IMPACT.B2-N4` "`via: import` entrypoints mixed with call reach" | Impact edge classification (`edge-policy.ts`), not presentation. |

## Design

### D0 — one owner for the fault-entry vocabulary

`src/core/domain/shared/unknown-target.ts` (new; domain imports only domain; placement rule 3 of AGENTS.md "a pure rule
over a value"):

```ts
/** A requested target the snapshot cannot resolve: a symbol, a line range, or the file itself. */
export type UnknownTarget = { symbol: string } | { start: number; end: number } | { wholeFile: true };

export type UnknownSymbolEntry = UnknownTarget & {
  file: string;
  /** Whether no entry of the commit holds a file at `file` at all. */
  absent: boolean;
  /** Snapshot paths (a moved file), or dotted containment paths; sorted, once each; empty when nothing could be asked. */
  candidates: readonly string[];
};

/** `file:symbol`, `file:start-end`, or `file`. */
export function unknownTargetKey(entry: UnknownSymbolEntry): string;

/** The sentence after the key: absent, declaring no symbol, or what the file declares. `absent` is optional because a `top-level-line` entry does not carry it. */
export function unknownEntryText(entry: { file: string; candidates: readonly string[]; absent?: boolean }): string;

/** The same sentence for an `unknown-entrypoint` entry. */
export function entrypointCandidateText(entry: { kind: string; name: string; candidates: readonly string[] }): string;
```

`src/core/ports/impact-queries.port.ts` re-exports the type and `unknownTargetKey` from the domain (ports may import
domain). `cli/main.ts:151-154` and `fault-presentation.ts:94-97` delete their copies and import `unknownEntryText`;
`fault-presentation.ts:78-80` and `main.ts:145` use `entrypointCandidateText`. The transport keeps its own framing
(`ye-ast: <kind>:` vs `fault: <kind>` + `Next step:`).

### D1 — a file no commit entry holds is `unknown-symbol`, checked before any filter

Rule: **a requested file is absent only when no entry of the commit holds it.** The listing is
`heldPaths(export)` = `export.files[].path` + `export.skipped[].path` (`vcs.port.ts:23-27`) — the rule the engine
already uses for module dependencies as `listingOf` (`impact-queries.ts:130-131`), extracted and reused. A skipped path
**exists**: it is not the absent fault, it keeps the `not-exported` cut `exportCuts` already emits
(`entrypoint-map.ts:96-110`), and it counts as matched for D4. When `heldPaths` returns `undefined` (a budget stopped the
export, so every later path is unknown), the absence check does not run: the answer keeps today's cut, because absence
cannot be decided.

`src/core/application/navigation/snapshot-files.ts`:

```ts
/** Every path the commit holds: the files the export accepted and the ones it skipped, in the export's order; `undefined`
 * when a budget stopped the export, since nothing at or after the stop is listed. */
export function heldPaths(exported: CommitExport): readonly string[] | undefined;

/** The snapshot paths that could be `file` instead: same basename, then the same directory with stem affinity, then the
 * whole directory, restricted to the requested extension; sorted, once each. */
export function wholeFileCandidates(file: string, listing: readonly string[]): readonly string[];

/** The decided `unknown-symbol` entries for the requested files no listing path holds, in request order. */
export function absentFileEntries(requested: readonly string[], listing: readonly string[]): UnknownSymbolEntry[];
```

`RawUnknownEntry` and `describe(entries: readonly RawUnknownEntry[])` are **unchanged**: a whole-file target is decided
from the listing alone and never reaches `describe`, so there is no second pre-describe shape and no undefined type.
`wholeFileCandidates` implements `movedOrNearby(file, listing)`, first non-empty step wins, same extension as the
requested file in steps 1-2, no extension filter when the requested path has none:

1. listing paths whose basename equals the requested basename (a moved file);
2. listing paths in the same directory whose stem is the requested stem or a `.`-separated prefix of it, or the reverse
   (`label-update` ↔ `label-update.component`);
3. listing paths in the same directory with the same extension.

So `label-update.component.ts` yields `…/label-update.ts`, and an extensionless path yields `[]` unless a file of that
exact name is listed. The symbol and range candidates keep their current rules.

Algorithm, identical in `impact-queries.ts` (importers) and `outline-queries.ts` (files and focus):

1. `const outside = files.filter((file) => !head.selected(file))` — unchanged, `out-of-scope` first
   (`impact-queries.ts:231-232`, `outline-queries.ts:57`).
2. `const listing = heldPaths(headTree.export)`; if it is defined,
   `const absent = absentFileEntries(files, listing)` where `files` is every requested path: `request.files` for
   importers and `outline files`, `focus.map(({ file }) => file)` for `outline focus` — **before** `isReadableFile`,
   `fixed`, `covered` and the `covered.length === 0` early return.
3. If `absent.length > 0`: `return { ok: false, fault: { kind: "unknown-symbol", detail: `no file at the revision for ${absent.map((entry) => entry.file).join(", ")}`, entries: absent } }` — no index is opened, because the listing alone decides.
4. Then `fixed`/`covered` and the index run as today; `unheldCut` keeps its meaning for a held file the index does not
   place, including a skipped one.
5. The other `snapshotFiles` sites (`trace-queries.ts:126`, `impact-queries.ts:193` for callers) take
   `heldPaths(headTree.export) ?? export.files.map(({ path }) => path)`, so a target naming a skipped path stops claiming
   `absent: true`; and the local `listingOf` in `impact-queries.ts:130-131` delegates to the extracted `heldPaths`.

`renderFault` needs no new kind. `detail` names the absent files; `unknownEntryText` prints `<file> is not in the
snapshot; snapshot paths: …` or just the first clause when the candidates are empty; the `unknown-symbol` Next step
already appends the "use a listed snapshot path as targets[].file" sentence when an entry is absent
(`fault-presentation.ts:169-171`). The argument name differs by family, so `FaultQueryContext` gains
`subject: "importers"` alongside `"files" | "focus"` and `nextStep` selects `files`, `files[]` or `focus[].file`.

Determinism: both lists sorted by `compareText`, entries in request order. ADR-0042: a fault asserts nothing, so no cut
is involved; the skipped-path cut is the existing one.

### D2 — a declared answer bound shortens the projection, and refuses when it cannot fit

Rule: **a caller-declared byte bound is met by the shorter projection; if not even the shortest fits, the answer is a
refusal that names the bound and how to narrow. No text is truncated.**

Signals in precedence order: the request's `answerBytes` (a presentation control beside `mode`, excluded from
`SEMANTIC_INPUTS` and from `resultIdentity`); the host's `--answer-bytes` on `ye-ast mcp` and `ye-ast init` (printed into
the MCP registration); none, which applies no bound. There is no built-in number.

`src/mcp/render-budget.ts` (new), the real entry points are the per-family `ResponseRenderer` values passed to `respond`
(`server.ts:416-430`) and the three text paths that `respond` emits (`server.ts:487,493,518`):

```ts
export interface AnswerBound { readonly bytes: number }

export type BoundedText =
  | { kind: "text"; text: string }
  | { kind: "refused"; bound: number; mode: ResponseMode; status: string; narrow: readonly string[] };

/** The rendered text under `bound`: the requested mode, else `summary`, else a refusal. */
export function boundedText<V>(render: ResponseRenderer<V>, fact: Fact<V>, mode: ResponseMode, context: RenderContext, bound: AnswerBound | undefined): BoundedText;
```

Algorithm:

1. No bound, or `Buffer.byteLength(text) <= bound.bytes` for `render(fact, mode, context)` → `text`.
2. Else `summary = render(fact, "summary", context)`; it fits → `summary` + one note line: the bound, the requested mode,
   and that the fact's status is unchanged (the note is presentation, **never** a `Cut`).
3. Else `refused` with the fact's `status`, the bound, the requested mode and the narrowing inputs of that family
   (`scope`, `changed`, `targets`, `files`, `focus`, or `mode: "summary"`). `respond` emits it as an `isError` result
   whose `_meta` carries `{ kind: "answer-over-bound", bound, mode, narrow }` — a presentation refusal, not a fact fault,
   so no fact and no cut changes.
4. `mode: "full"`: the bound governs the text channel only; the structured content is the whole fact and is not bounded
   (resolved question 1). When the full text exceeds the bound, step 2 applies; when summary does too, step 3. A client
   whose cap covers the whole message must ask a narrower query or a smaller mode; the answer says so in the refusal.

The bound is a nonnegative integer; zero is valid. All UTF-8 text bytes, including the downgrade note and refusal, count. If the complete refusal text cannot fit, the MCP result uses an empty content array and carries its kind, status, bound, requested mode and narrowing inputs in `_meta`; it is still an error, not an empty fact. A bounded successful response carries its complete existing structured fields in `structuredContent`; a refusal carries no fact or structured output. The bound never applies to metadata or structured content.

The bound is applied once, inside `respond`, around every text it emits (selection receipt, full, summary/details), so a
new family inherits it. Determinism: pure comparison of `Buffer.byteLength`; no clock, no tokenizer (RFC-0017:141).

### D3 — a duplicate names the entries it found

`WorkspaceFault`'s `duplicate-repository` becomes:

```ts
{ kind: "duplicate-repository"; detail: string; repo: string; entries: readonly number[]; fromLaunch: boolean }
```

`entries` indexes the **request's `repos`** (zero-based, ascending; empty when the duplicate comes from persisted
membership). `workspace-plan.ts:170-174`: for each id, the indices in `asked`; subtract one to translate to `repos`, and
when `asked[0]` (the launch repository) is one of them, set `fromLaunch: true` and omit that index.

Text, with no argument values (a path would leak a clone location — `fault-presentation.ts:17-20`):

- `repos[1] and repos[2] name repository `application``;
- `the launch repository and repos[1] name repository `application`` when `fromLaunch`;
- `repository `application` is listed twice among the persisted members` when `entries` is empty.

Next step: "Drop all but one of the named entries, keeping the id and revision intended; a duplicate among persisted
members is corrected in the host's workspace declaration." (`membersArgument` still picks `repos` vs `workspace.repos`.)

### D4 — an `include` that selects no file is a fault; a partly unmatched one is stated

**Seam with RFC-0025 U5** (lead decision): RFC-0025 U5 owns what `include` means — the selection is the question and the
configuration is read whole. This rule only says what happens when the selection is empty, and it lands **after** RFC-0025
U5. It therefore reads **the caller's selection over the paths the commit holds**, never the widened reading: today that
is `heldPaths(export)` (D1: accepted files and skipped entries) filtered by the caller's `pathSelection`; after RFC-0025
U5 the reading must expose the selected paths (`selected: readonly string[]`, recorded beside the widened export), and
`unmatchedIncludes` is called with those paths. If RFC-0025 U5 does not record them, U5 here is blocked. When
`heldPaths` is `undefined` (a stopped export) no scope fault is raised, for the same reason as D1.

```ts
// src/core/domain/shared/scope.ts
/** The `include` globs that match no path of `listing`; sorted, once each; empty when no include was declared. */
export function unmatchedIncludes(scope: Pick<DeclaredScope, "include">, matches: (path: string, glob: string) => boolean, listing: readonly string[]): string[];
```

Rule, in one helper `scopeNotice` (`src/core/application/snapshot/scope-selection.ts`) called by every family after the
selection is known:

1. `include` empty, or every glob matches a selected path → nothing.
2. Every glob matches nothing → fault `{ kind: "unknown-scope-path", detail: `scope.include matches no path read from this commit: ${globs.join(", ")}`, globs }`. Globs go in `detail` exactly as `unknown-change-path` already does (`impact-queries.ts:377`), so both adapters print them with no new branch. Protocol code `-32026`.
3. Some match, others do not → the answer keeps its status and adds one line through `presentation-context.ts`
   (`scopeLines`, `:79-85`, after the existing `scope:` line and before `changed`): `scope: include <globs> selected no
   path (the rest selected <n> files)`. Not a fault and not a cut: nothing is hidden. The MCP text carries the line; the
   CLI prints the fact JSON and needs nothing.

A path the export skipped is **held** (D1), so a glob matching only it matched: the answer keeps the existing
`not-exported` cut and this rule says nothing extra.

### D5 — a reached UI route names its own declaration

`ReachedEntrypoint` gains one optional field (`impact-fact.ts`):

```ts
/** Where the route entry itself is declared; absent for an HTTP route (its handler is that declaration) and for `unknown`. */
declaredAt?: Evidence;
```

`reachedEntrypoints` (`reached-entrypoints.ts:21-46`) fills it from `finding.evidence[0]` when
`finding.value.kind === "ui-route"`; `merge` keeps the first `declaredAt` in sorted order (one route entry, one
evidence). Rendering:

- `reachedLines` (`render.ts:473-486`) appends ` at <path>:<line>` after the route name in every mode.
- `entrypointLine` becomes `entrypointLine(entrypoint: Entrypoint, evidence?: Evidence)` (`render.ts:274-277`) and
  `itemLine(finding: Finding<Entrypoint>)` (`:279-281`) passes `finding.evidence[0]`; `unknownFindingRun` keeps using
  `itemLine`, so unknown rows are unchanged. `entrypointLocation` (`:270-272`) is untouched.

### D6 — every relationship the `importers` value names carries its line

Rule: **a relationship the fact names is a place, not only a path.** `ImportedFile` gains one optional field that carries
every place a relationship was read, one per `(file, line)`:

```ts
// src/core/domain/impact/importers-fact.ts
/** One place a file's relationship to the asked file is written. */
export interface ImportPlace {
  /** The depending file, repo-relative. */
  readonly file: string;
  /** The line of the statement, reference or edge that names the asked file. */
  readonly line: number;
}

export interface ImportedFile {
  file: string;
  importers: readonly string[];
  reexporters?: readonly string[];
  dynamicImporters?: readonly string[];
  typeImporters?: readonly string[];
  users: readonly string[];
  unresolvedNamers: readonly string[];
  /**
   * Every place a relationship named above is written: one per (file, line), by file then line. Absent when no reader
   * recorded a line for this file, never an empty array.
   */
  places?: readonly ImportPlace[];
}

/** The places of the unresolved references that name the file, one per (file, line), by file then line. */
export function unresolvedPlacesOf(file: string, declared: ReadonlySet<string>, qualified: ReadonlySet<string>, references: readonly UnresolvedUse[]): ImportPlace[];
```

`unresolvedNamersOf` and `unresolvedPlacesOf` share one predicate over unresolved references. The former retains every
matching file, including references without a valid line; the latter keeps only positive integer lines. `readImporters`
collects the same places it already filters, from three sources:
`GraphEdge.line` when it is a positive integer, `ModuleDependency.line` for the `direct` categories, and
`AttributedCall.reference.line` for the base-bound calls. Places are sorted by `compareText(file)` then `line`, deduped
by `${file}\0${line}`, and the field is omitted when the list is empty. An edge or reference with no line (`line: null`)
contributes no place; it is never printed as line 0.

Rendering (`renderImporters`, `importerFiles`), and only there:

- When `entry.places` is present, each related-file row appends ` at <line>[, <line>]` with that file's places, sorted;
  the sentence "These relationships are paths only; no relationship line locations were recorded" is **not** printed.
- When at least one related file has no place in that entry, one note says `Relationship lines are recorded where a place
  was read; a related file without one names no recorded line.`
- When no entry carries `places` (a fact retained before this change, or an index that placed none), today's sentence is
  printed unchanged. The renderer never infers a line and never prints `0`.

`full` mode text ("These are paths only, with no relationship line locations", `render.ts:1107`) becomes "Select
`value.files` by file; inspect `importers`, `users` and `places` for recorded links and `unresolvedNamers` for unconfirmed
matches." The MCP output schema (`server.ts:257`) adds
`places: z.array(z.object({ file: z.string(), line: z.number() })).optional()`.


## What does not change

- No new family, port or dependency; `status`, cut kinds, reasons and reaches stay as they are.
- D2's note and refusal are presentation, never a `Cut`; D4's partial case is a status line, never a `Cut`.
- `out-of-scope` for a requested path outside the declared scope keeps its precedence over absence.
- `unknown-symbol` keeps its kind and protocol code; only the entry shape gains a third target form.
- A skipped path is never absent and never "unmatched": its `not-exported` cut stays.
- `full` mode's `structuredContent` is not bounded (resolved question 1).
- `trace` and `importers` gain no `select`/`page` (resolved question 4).
- The `importers` categories, their order and their members keep their shape; U7 only adds places, and an answer with no
  recorded place keeps today's sentence.
- An export stopped by a budget keeps today's behavior: absence is undecidable beyond the stop, so no new absence fault
  is raised (resolved question 11); the pre-existing symbol and range faults under a stopped export are unchanged here and
  named there.

## Delivery units

| # | Unit | Size (authored lines) | Depends on | High-risk item |
|---|---|---|---|---|
| U1 | One owner for the fault-entry vocabulary | ~150 | — | 3 (published fault text, two adapters) |
| U2 | A file no commit entry holds is `unknown-symbol`, before every filter | ~250 | U1 | 3 (published fault shape) |
| U3 | A duplicate names its `repos` entries | ~90 | — | 3 (fault shape) |
| U4 | A declared answer bound shortens the projection | ~280 | — | 3 (every tool's text contract) |
| U5 | An empty `include` is a fault, a partly unmatched one is stated | ~300 | RFC-0025 U5 | 3 (new fault kind, protocol code) |
| U6 | A reached UI route names its declaration | ~110 | — | 3 (additive field in a published fact) |
| U7 | Every importers relationship carries its line | ~230 | — | 3 (additive field in a published fact) |

U1 precedes U2 (U2 uses the moved text); the rest are independent. Each is one work-unit commit on the feature branch.

### U1 — One owner for the fault-entry vocabulary

- Files: create `src/core/domain/shared/unknown-target.ts`; edit `src/core/ports/impact-queries.port.ts` (re-export),
  `src/mcp/fault-presentation.ts` (delete `declarationText` `:94-97`, import the shared owner, and keep
  `entrypointText` `:78-80` as the one-line MCP framing that wraps it), `src/cli/main.ts` (delete `declarationText`
  `:151-154`, import, replace the `:145` branch), `src/core/domain/shared/unknown-target.test.ts`,
  `src/cli/main.test.ts`.
- Must not touch: renderer bodies, `snapshot-files.ts`, query use cases.
- RED: `src/core/domain/shared/unknown-target.test.ts`, `"a fault entry is formatted by the one shared owner"` — assert
  `unknownEntryText({file: "a.ts", candidates: [], absent: true}) === "a.ts is not in the snapshot"` and the same for an
  entry with candidates; fails today because the module does not exist. Variant: `entrypointCandidateText` with and
  without candidates. CLI coverage: one `run`-level test in `src/cli/main.test.ts` with a fake port that returns an absent
  `unknown-symbol` fault asserts the sentence on stderr (`faultText` is not exported; do not export it for a test).
- GREEN: `npm run check`; one absent-symbol fault through `npm run cli -- callers …` and through the MCP prints the same
  entry sentence.
- Corpus gate: `--expect none`; a byte difference means the move changed wording.
- Docs: none.
- Risk: item 3 — a published fault text; its bytes must not change.

### U2 — A file no commit entry holds is `unknown-symbol`, before every filter

- Files: `src/core/application/navigation/snapshot-files.ts` (`heldPaths` extracted from `listingOf`,
  `wholeFileCandidates`, `absentFileEntries`), `src/core/application/impact/impact-queries.ts`
  (`:228-267` importers branch; `:176-193` callers listing and snapshot; `:130-131` `listingOf` delegates),
  `src/core/application/outline/outline-queries.ts` (`:57-93`), `src/core/application/trace/trace-queries.ts:126`,
  `src/core/ports/impact-queries.port.ts` (importers fault union becomes `OfChangeFault | UnknownSymbolFault`),
  `src/mcp/fault-presentation.ts` (`subject: "importers"`), tests of the four families.
- Must not touch: `root-selection.ts` (already correct), `impact-cuts.ts`, the `unknown-symbol` Next step.
- RED: `src/core/application/impact/impact-queries.test.ts`, `"importers answers a file no commit entry holds with an absent unknown-symbol entry"` — listing `["src/held.ts", "src/owner.service.ts", "src/held.spec.ts"]`, request
  `["src/gone.ts"]`; assert `ok: false`, `kind: "unknown-symbol"`, `entries[0] = {file: "src/gone.ts", wholeFile: true, absent: true, candidates: ["src/held.spec.ts", "src/held.ts", "src/owner.service.ts"]}` by D1 rule 3.
  Fails today: `ok: true`, `status: "partial"`. Variants: (a) `outline files` for the same path; (b) `outline focus` on
  the extensionless `x` → `absent: true`, `candidates: []`, never `no-extractor`; (c) a **held** file the index does not
  place (including a skipped path) keeps `not-exported`/`no-extractor`, never this fault; (d) an export with `stopped`
  set → no absence fault, today's cut, because `heldPaths` is `undefined`.
- GREEN: `npm run check`; `repro/plan-jhipster.json` steps 1-2 fault and name `…/label-update.ts`; a focus call on `x`
  faults.
- Corpus gate: `--expect importers:± outline:± trace:± callers:±` (answers that faulted as partial change; the report
  must show only those, and any `callers`/`trace` change comes only from a skipped path).
- Docs: README fault table (`unknown-symbol`: a file no commit entry holds), `importers`/`outline` rows, MCP
  `INSTRUCTIONS` error line, `vcs.port.ts` `CommitExport` doc ("what a target's presence is decided from").
- Risk: item 3 — the published fault shape gains a third target form.

### U3 — A duplicate names its `repos` entries

- Files: `src/core/ports/workspace-repos.port.ts`, `src/core/application/topology/workspace-plan.ts:170-174`,
  `src/mcp/fault-presentation.ts:179-180`, `workspace-plan.test.ts`.
- Must not touch: `duplicate-workspace-source`.
- RED: `workspace-plan.test.ts`, `"duplicate-repository names the colliding repos entries"` — `repos: [A, B]` with
  `B === A` (and the launch repository different): `entries: [0, 1]`, `fromLaunch: false`; variant `repos: [A, B, A2]`
  with the launch repository equal to `A`: `entries: [1]`, `fromLaunch: true`; variant persisted duplicate:
  `entries: []`. Fails today: no fields.
- GREEN: `repro/plan-duplicate-repository.json` prints `repos[0] and repos[1] name repository …`; `npm run check`.
- Corpus gate: `--expect workspace:±` (fault text only).
- Docs: README fault row `duplicate-repository`.
- Risk: item 3 — a published fault text.

### U4 — A declared answer bound shortens the projection

- Files: create `src/mcp/render-budget.ts` + `render-budget.test.ts`; `src/mcp/query-schema.ts` (`answerBytes` in every
  `TOOL_INPUTS` entry, never in `SEMANTIC_INPUTS`; beside `mode`), `src/mcp/server.ts` (`respond` `:413-530` bounds the
  three text paths and emits the refusal), `src/mcp/presentation.ts` (`RenderContext.answerBytes`), `src/cli/main.ts`
  and `src/composition/*` (parse and carry `--answer-bytes` on `mcp` and `init`, print it in the registration),
  `server.test.ts`, `cli/main.test.ts`, README, MCP `INSTRUCTIONS` and tool descriptions.
- Must not touch: any `render*` body, `presentation-sharing.ts`, fact types, `SEMANTIC_INPUTS`.
- RED: `render-budget.test.ts`, `"an answer over the declared bound returns the summary projection and says so"` — a
  renderer whose details text is 10 KB and summary 3 KB, bound 4 KB; assert the summary text plus one note naming the
  bound and the requested mode. Fails today: no module. Variants: a bound below every projection → `refused` with
  `status` and `narrow`; no `answerBytes` → byte-identical to today; the selection receipt and `full` text are bounded
  by the same call.
- GREEN: `npm run check`; `repro/plan-size-entrypoints.json` with `answerBytes: 40000` answers < 40,000 bytes (summary or
  refusal naming `scope`/`mode`), and the same call without the control is byte-identical to today's 104,538 characters.
- Corpus gate: `--expect none` (no probe carries `answerBytes`).
- Docs: README control row, `mcp`/`init` command rows, tool descriptions ("pass your client's limit as `answerBytes`;
  without one the answer is not bounded").
- Risk: item 3 — every tool's text contract gains a control.

### U5 — An empty `include` is a fault, a partly unmatched one is stated

- Prerequisite: **RFC-0025 U5 on `main`**, because the rule reads the caller's selection it records (this section blocks
  without it).
- Files: `src/core/domain/shared/scope.ts` (`unmatchedIncludes`), create
  `src/core/application/snapshot/scope-selection.ts` + test, `src/core/application/entrypoints/entrypoint-queries.ts:56-66`,
  `.../impact/impact-queries.ts` (callers/impact/importers), `.../outline/outline-queries.ts`, `.../trace/trace-queries.ts`,
  `.../topology/workspace-queries.ts`, `.../contracts/contract-consequences-queries.ts`,
  `src/core/ports/{entrypoint,impact,outline,trace,workspace-repos,contract}-queries.port.ts` (one shared `ScopeFault`),
  `src/mcp/fault-presentation.ts` (kind + Next step), `src/mcp/presentation-context.ts:79-85` (the partial line),
  `src/protocol/protocol.ts` (`unknown-scope-path: -32026`), tests of the touched families, README.
- Must not touch: `cli/main.ts` (`faultText` prints `detail` at `:148`, and the globs are in it as in
  `unknown-change-path`), `changed`/`unknown-change-path`, the export.
- RED: `entrypoint-queries.test.ts`, `"an include that selects no path is a fault, never an empty complete answer"` —
  selection `["src/a.ts"]`, `include: ["api/**"]` → `{ ok: false, kind: "unknown-scope-path", globs: ["api/**"] }`, and
  the CLI prints the globs through `detail`. Fails today: `complete`, 0 findings. Variants: `include: ["src/**", "api/**"]`
  answers plus the line naming `api/**`; a glob matching only a skipped path answers with its `not-exported` cut and no
  fault.
- GREEN: `npm run check`; a request with `include: ["sm-shop/none/**"]` faults in the MCP and the CLI.
- Corpus gate: `--expect none` (no study probe used a non-matching include; a difference means a scope changed meaning).
- Docs: README `scope` row ("a glob that matches no path is an error"), fault table, `INSTRUCTIONS`, CLI `--include` row.
- Risk: item 3 — a new fault kind and protocol code.

### U6 — A reached UI route names its declaration

- Files: `src/core/domain/impact/impact-fact.ts` (`declaredAt`), `src/core/domain/impact/reached-entrypoints.ts`,
  `src/mcp/render.ts` (`reachedLines` `:473-486`, `entrypointLine` `:274-277`, `itemLine` `:279-281`), tests of both.
- Must not touch: the Angular adapter (`Finding.evidence` already holds the place), `ui-route.ts`, `entrypointLocation`.
- RED: `reached-entrypoints.test.ts`, `"a reached UI route carries the route entry's declaration place"` — complete
  `ui-route` finding with `evidence: [{path: "src/routes.ts", line: 12}]` and a reached component node → `declaredAt`
  equals that evidence; `impact-presentation.test.ts` asserts the row ends ` at src/routes.ts:12`, and `entrypoints-presentation.test.ts` asserts the `entrypoints` row for the
  same finding prints it. Fails today: no field, no clause. Variants: an HTTP route has no `declaredAt` and its row is
  unchanged; an `unknown` row is unchanged.
- GREEN: `npm run check`; a `callers` call on a component in `realworld/frontend` or `nname/name-webapp` prints
  `ui-route <path> -> <component> at <routes file>:<line>`.
- Corpus gate: `--expect impact:± callers:± workspace:±` (the fact gains a field).
- Docs: README `impact`/`callers` value row, RFC-0010 (reached entrypoints carry the route's place).
- Risk: item 3 — an additive field in a published fact.
### U7 — Every `importers` relationship carries its line

- Prerequisites: none.
- Files: `src/core/domain/impact/importers-fact.ts` (`ImportPlace`, `ImportedFile.places`, `unresolvedPlacesOf`;
  `unresolvedNamersOf` delegates), `src/core/application/impact/importers.ts` (`readImporters` collects and sorts the
  places without dropping relationships whose lines were not recorded), `src/mcp/render.ts` (`importerFiles` `:1080-1105` and
  `renderImporters` `:1106-1128`, the `full` guide text `:1107`), `src/mcp/server.ts:257` (output schema), their tests.
- Must not touch: `module-dependency.ts`/`module-dependencies` readers (they already carry `line`), `unresolvedNamersOf`'s
  predicate (it gains one call site, not a second rule), `impact`/`callers` values, `edge-policy.ts`.
- Contract: `ImportPlace { readonly file: string; readonly line: number }`; `ImportedFile.places?: readonly ImportPlace[]`
  as in D6; `unresolvedPlacesOf(file, declared, qualified, references): ImportPlace[]`. No other type changes.
- RED: `src/core/application/impact/importers.test.ts`, `"every relationship keeps the line it was read at"` — a store
  double with one edge `into` the asked file at line 12 and one unresolved reference naming it at line 11, a module
  statement importing it at line 8; assert `places` equals
  `[{file: "src/caller.ts", line: 8}, {file: "src/caller.ts", line: 11}, {file: "src/caller.ts", line: 12}]`-shaped, by
  file then line, once each. Fails today: there is no field. Variants: (a) one relationship with `line: null` yields no
  place for it and the field keeps the others; (b) a file with no recorded line omits `places` (never `[]`); (c)
  `unresolvedNamersOf` still returns the same files for the same fixture.
- RED (render): `src/mcp/importers-presentation.test.ts`, `"an importers row prints the line of each relationship and drops the paths-only note"` —
  one entry with `places` → row ends ` at 8, 11`; no entry with `places` → today's sentence verbatim. Fails today: no
  clause, the sentence always prints.
- GREEN: `npm run check`; `ye_ast_importers` on `src/main/webapp/app/account/register/register.service.ts` in
  `jhipster/application` at `6b000b5d`, `mode: details` (plan `repro/plan-importers-lines.json`) prints
  `"…/register.ts": importers[2], users[2], unresolved name matches[2] at 12` and no "paths only" sentence, where today it
  prints the sentence and no line (`reprobe-6d21e7bc/answers/N-JHIPSTER-TS-IMPACT.B1-N1.txt`).
- Corpus gate: `--expect importers:±` — every `importers` answer that listed at least one relationship gains ` at <lines>`
  and loses the sentence (the fact gains a field, the answer changes both text and JSON), and an answer with no
  relationship is byte-identical; the report must show only `importers` and only that direction.
- Docs: RFC-0010 importers value (the field, its ordering and its absence), README `importers` row and value table, the
  MCP tool description (`server.ts:621`: "Details: paths once, categories/positions" gains "and the place of each
  relationship").
- Risk: item 3 — an additive field in a published fact (`ImportedFile` is `structuredContent`).


## Measurement

| Unit | Study items it should close | Re-check |
|---|---|---|
| U1 | none alone (protects U2 and future entry shapes) | one fault prints the same entry sentence in CLI and MCP |
| U2 | N-JHIPSTER-TS-FLOW.B2-N1, N-shopizer-TS-FLOW.B2-N1 (files) and N-realworld-TS-IMPACT.B2-N1 (focus) | `repro/plan-jhipster.json` steps 1-2; `outline focus` on `x` |
| U3 | N-nname-X-FIELD.A1-N1 | `repro/plan-duplicate-repository.json` names both entries |
| U4 | N-shopizer-J-FLOW.A2-N1/N2, N-nname-TS-ROUTES.B1-N2 | `answerBytes: 40000` returns < 40,000 bytes with the note or the refusal |
| U5 | N-realworld-TS-ROUTES.B2-N1 | the same request faults instead of `complete` with 0 findings |
| U6 | N-nname-TS-IMPACT.A1-N2, .B1-N3, .B2-N2 | the same `callers` answer prints the route entry's line |
| U7 | N-JHIPSTER-TS-IMPACT.B1-N1, N-JHIPSTER-TS-IMPACT.A1/A2-N2 | the same `importers` answer prints `register.ts` at its import line and no "paths only" sentence |

An item counts as closed when the answer names what the oracle named, not merely when it is smaller.

## Resolved questions

Owner decision, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes". Each decision is the
recommendation this draft already argued; the units follow it.

| # | Question | Decision |
|---|---|---|
| 1 | Does the bound govern `structuredContent` (which `mode: "full"` sends whole)? | No. The bound governs the text channel; bounding structured output would cut the fact `full` promises. Reopen only with a client rejecting `structuredContent`. |
| 2 | A glob matching only a path the export skipped: fault or cut? | The cut it already is (`exportCuts`), never the fault: the path exists (D1), so it matched. |
| 3 | Is the answer bound a request control or host configuration? | Both, request first; no built-in default, because a default byte count is the constant AGENTS.md forbids. |
| 4 | Do `trace`/`importers` gain `select`/`page` here? | No. Over-bound they answer the refusal naming narrower inputs; paging is a separate fact-level design. |
| 5 | Does every `callers` answer disclose that test files never depend on anything? | Not now. The policy is declared (`inbound-origins.ts:29`) and the answer does not hide a fact it read; a constant line costs bytes on every answer. Reopen with session evidence. |
| 6 | Does the duplicate fault print the paths it received? | No. Indices plus the id name the entries without echoing clone paths. |
| 7 | Where does the fault-entry text live? | `core/domain/shared` (a pure rule over a domain value), re-exported through the port; entrypoints import it from the core, never from each other. |
| 8 | Which candidates does an absent file offer? | D1's three steps, first non-empty: same basename, same directory with stem affinity, same directory; same extension, no extension filter when the path has none. |
| 9 | Is `outline focus` on an absent path covered by U2? | Yes, checked before `isReadableFile`, like `files`; an extensionless absent path faults with `absent: true`. |
| 10 | Do importers' relationship line locations belong here? | Yes, as U7 (owner decision): `ImportedFile` gains `places` from the lines the readers already hold; the renderer prints them when the fact carries them and keeps today's honest sentence when it does not. |
| 11 | What happens to a target's absence when a budget stopped the export? | No absence decision: `heldPaths` is `undefined` beyond the stop, so the answer keeps today's `not-exported`/`caller-budget` cut and never claims the file does not exist. The pre-existing symbol/range faults under a stopped export are out of this RFC (no CLI query sets an export budget today, RFC-0006). |

## Decisions recorded in ADR-0051

- Fault entry text is one core domain vocabulary; a driving adapter contributes only its prefix, detail framing and next step.
- A requested file no commit entry holds is a fault in every family, and an entry the export skipped is held, never absent.
- An answer bound is a declared value, met by a shorter projection and refused when it cannot fit; truncation never happens and there is no built-in byte limit.
- A declared `include` that selects nothing is a fault; a partly unmatched one is stated on the answer.
- A reached entrypoint carries the declaration place the engine already read for it.
- A relationship the `importers` value names carries its place; an answer without a recorded place says so instead of implying one.

## Review responses

Findings from `designs/review-entrypoints.md` against this draft, at `96bf4389`/`6d21e7bc`. Status at `ebd12a4f`.

| # | Resolution |
|---|---|
| 20 | Fixed. D1 now has an explicit three-step candidate rule and a RED fixture whose listing makes rule 3 produce exactly `["src/held.spec.ts", "src/held.ts", "src/owner.service.ts"]`; the GREEN probe follows rule 2 to `label-update.ts`. |
| 21 | Fixed. D2 names the real entry points (`ResponseRenderer` passed to `respond`; `server.ts:416-430,487,493,518`), bounds all three text paths, and replaces the contradicting rule with "requested mode → summary → refusal". |
| 22 | Fixed. One policy: the listing is `files + skipped` (`heldPaths`, extracted from the existing `listingOf` at `impact-queries.ts:130-131`), a skipped path exists, keeps its `not-exported` cut and counts as matched for D4. A stopped export decides nothing (resolved question 11). The contradictory D4 sentence is gone. |
| 23 | Fixed. U2 covers `outline focus` and checks absence before `isReadableFile`, `fixed` and the `covered.length === 0` early return; the extensionless `x` case is a RED variant. |
| 24 | Fixed by owner decision, after the gap was proved: `ImportedFile` carries paths only (`importers-fact.ts:6-28`) and `readImporters` drops the line (`importers.ts:36-57` vs `code-graph.port.ts:63-68`, `module-dependency.ts:25-29`), so the sentence was honest. It is now **U7**: the fact gains `places`, the renderer prints them when present and keeps today's sentence otherwise. |
| 25 | Fixed by 23's ordering: the absence check runs before the readable filter and both early returns in `importers` and `outline`. |
| 26 | Fixed differently, and more narrowly than the review proposed. There is no new pre-describe shape: `absentFileEntries` decides absence and candidates from the listing alone (no store, before `head.open()`), so `RawUnknownEntry` and `describe` stay byte-identical and no `wholeFile` member is added to a raw type. |
| 27 | Fixed. The units table has a size column; U5 keeps one unit with exact files and a ~300 estimate, and names RFC-0025 U5 as its prerequisite instead of "every family" prose. |
| 28 | Disputed in part. `unknown-scope-path` puts its globs in `detail`, as `unknown-change-path` already does (`impact-queries.ts:377`); the CLI prints `detail` (`main.ts:148`), so no CLI branch is needed. `presentation-context.ts:79-85` is added to U5's files, and a CLI `run` test pins the text. |
| 29 | Fixed. D2 bounds the selection receipt (`server.ts:487`), the full branch (`:493`) and the summary/details branch (`:518`); `full`'s structured content is stated out of the bound. |
| 30 | Fixed. D5 gives `entrypointLine(entrypoint: Entrypoint, evidence?: Evidence)` and names `itemLine` (`:279-281`) as its caller; the render test asserts the UI-route evidence clause. |
| 31 | Fixed. `entries` indexes the request's `repos`, translated from `asked` (`workspace-plan.ts:170`), with `fromLaunch` for the launch repository and an explicit message and test for each case. |
| 32 | Fixed: `main.ts:141-154` (`faultText` `:141-148`, `declarationText` `:151-154`, inline branch `:145`); `render.ts:1295` `traceCutLines` and `:1303` `renderTrace`; `query-schema.ts:74-77`; `ERROR_CODE`; `-32026` kept. |
| 33 | Fixed: trace is 567,333 bytes (`reprobe-6d21e7bc/summary.md:81`); the entrypoints figures are 104,538 characters / 104,642 bytes and 62,708 characters, both from `repro/`. |
| 34 | Fixed: the CLI assertion goes through `run` with a fake port; `faultText` is not exported. |

## Reproduction

`repro/answers.md` and the raw responses in `repro/` were produced on `6d21e7bc`. The two blockers they prove
(`importers`/`outline files` absent cut, unbounded `entrypoints` details) are unchanged at `ebd12a4f` by inspection of the
same lines cited above; `outline focus` on an extensionless path is taken from `reprobe-6d21e7bc/summary.md:83`.


## Scope selection transport

The output-only optional `scopeSelection` on `FactBase` carries `{ unmatchedIncludes, selectedFiles }` for a mixed
selection. It is preserved by provenance, composition and presentation, changes neither status nor cuts, and is not
an input to semantic identity. The additive fact contract uses schema 0.23.0. An entirely empty known selection faults
with `unknown-scope-path` and protocol code -32026; a stopped listing cannot establish a miss.

Workspace matching is over contributing repository/path occurrences, counting an identical relative path separately
in each repository. An unavailable or stopped contributing listing leaves unmatchedness undecidable. Internal nested
walk requests carry a non-serializable marker for the already evaluated workspace scope; public JSON requests cannot
supply that marker. Live selection is derived from each capture's held paths, including skipped entries, using the
original predicate even when configuration reading is wider.
