# RFC-0018: A selection over the change

- Status: Draft, 2026-11-03
- Related: [RFC-0010](0010-impact-queries.md) (the impact request, the walk and its completeness),
  [RFC-0002](0002-facts-contract.md) (inputs, identity, determinism), [RFC-0005](0005-transports.md) (CLI, protocol,
  MCP), [RFC-0011](0011-cross-repository-impact.md) (the workspace trigger),
  [RFC-0017](0017-answer-size-and-outline.md) (answer size), [ADR-0011](../adr/0011-query-protocol-in-the-mvp.md) (one
  protocol, three doors), [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) (coverage grows with evidence)

**In short:** `impact.ofChange` gains `changed`, globs over the changed paths. Only the changed paths these globs
select seed the walk; the repository is still indexed whole, so a caller outside the selection is still known. It is a
request input, not a content scope: unlike `scope`, it never hides a caller.

## Why

An agent asked `impact --live` on a 249-file branch of name-webapp and got 762 seeds and `partial` with 228
`unresolved-link` cuts, and reported the unscoped answer as unusable. The cuts are not new: RFC-0016 measured
name-webapp at `HEAD~60` with 273 cuts after S10 and S13. The seeds are the change itself, and the summary used to
print every one: `groupedSeeds` ignored `detail`. That is fixed here too: a summary lists the seeds a caller asked for
by name and counts the rest globally by selection basis, including the number of declarations and files. Each reached
entrypoint also names one contributing seed with its location and basis, plus the count of other origins, using the
entrypoint's seed indices. This preserves actionable origin evidence without listing every declaration. `detail: "full"`
lists every seed. The summary never prints more bytes than the listing (the rule of RFC-0017): when a small listing
is shorter, it is used instead. The structured fact and its seed indices are unchanged.

The agent's two existing levers are both wrong for this question:

| Lever | What it does | Why it fails here |
|---|---|---|
| none | answers the whole change | a 249-file change is a census, not an answer |
| `scope` | filters the export and the index | a caller outside it is not known, so the answer stops being complete (`README.md:251`, RFC-0010 "The paths") |

Neither answers "what does this area of my change break?". The agent knows its own diff; the seeds are its input echoed
back, not the answer.

## The request

| Field | Shape | Rule |
|---|---|---|
| `changed` | `readonly string[]` of globs | over repository-relative changed paths the scope leaves; each must pass `isValidGlob` (`src/core/domain/shared/scope.ts:36-38`); deduplicated and sorted; omitted means the whole change |

It lives on `ImpactOfChangeBase` (`src/core/ports/impact-queries.port.ts:15-27`), beside `scope` and `budget`. Matching
uses the same port and rule as `scope`, `deps.matcher.matches` through `pathSelection` (`scope.ts:17-19`), so there is
one glob semantics in the product, not two.

It is include-only. An agent narrows by naming the area it wants; `--changed 'src/**'` already leaves docs and styles
out, and an exclude belongs to `scope`, where it also removes configuration an extractor needs.

### Placement

The rule lives in `src/core/domain/change/change-selection.ts`: it filters the change's files by the globs and reports
the globs that selected nothing, reusing the shared glob predicate (`pathSelection`) instead of a second matcher. The
application applies it once, in `readChange` (`impact-queries.ts:290`), which commit and live already share, before
`selectSeeds`; the driving adapters only carry the globs. The seed summary lives in `src/mcp/render.ts`, the adapter that
renders text, and follows the byte rule of RFC-0017; the fact keeps every seed.

## What the selection touches

One filter point, before anything reads the change (`src/core/application/impact/impact-queries.ts:290-333`):

| Downstream | Effect |
|---|---|
| `radius.files` | filtered first; both revisions are still exported whole |
| seeds | `selectSeeds` (`src/core/domain/change/seeds.ts:53-87`) receives only the selected changes |
| removals | `removedDeclarationCuts` only for selected files, so an unselected file raises no cut for a name it removed |
| changed-file `no-extractor` cuts | only selected files. Export and scope cuts stay: they describe the whole walk, not the change |
| changed entrypoints | filtered by `handler.path`, the only anchor the fact carries (`src/core/domain/impact/changed-entrypoints.ts:5-10`) |
| the walk | unchanged: the store is the whole head index (`impact-queries.ts:320-329`), so callers anywhere are reached |
| `summary.filesNotIndexed` | unchanged: index completeness, not the change. A file the index could not read stays a cut even when the selection leaves it out, because its blindness belongs to the whole walk |
| `scope` | independent and composable; both may be set |

The entrypoint filter has a stated limit: a route is named under its handler's file, not under the routing file that
declares it. A selection that excludes the handler excludes the route, as every other answer already names it.

## Identity and reuse

The globs are recorded in `DeclaredConfig.changed` (`src/core/domain/shared/fact.ts:58-66`), sorted and once each. That
is part of `inputs.config` and therefore of the fact identity (`fact.ts:185-190`): the same selection gives the same
bytes, and two selections never collide in the fact cache. `inputs.content` is unchanged, because the export is
unchanged (`impact-queries.ts:302`). No new cache, no server state, no handle.

## Completeness

- The status keeps its meaning relative to the request. `complete` now reads "complete for the selected part of the
  change", never "the whole change".
- No new cut kind. The selection is the caller's question, not a blind spot of the walk, and a cut would make the
  answer `partial` for a reason no reader can fix by reading a place.
- A glob that selects no changed path is a typed fault, `unknown-change-path`, carrying the globs that selected
  nothing. An empty `complete` answer would read as "no impact", which is the one outcome the facts contract forbids
  (RFC-0002). Precedent: `unknown-symbol` fails the whole call when one requested symbol names no node
  (`src/core/ports/impact-queries.port.ts:54-64`).
- The text names the selection (below), so a filtered answer is never read as the whole change.

## Transports

| Door | Shape |
|---|---|
| CLI | `ye-ast impact <repo> --base <rev> [--changed <glob>]...` (`src/cli/main.ts:325-341`) |
| protocol | `changed` in `readOfChange` (`src/protocol/params.ts:137-140`) |
| MCP | `changed` in the `ye_ast_impact` schema (`src/mcp/server.ts:370-409`), with the difference from `scope` in its description |
| workspace (MCP and library) | `WorkspaceOfChangeRequest.changed` (`src/core/ports/workspace-impact-queries.port.ts:45-48`), applied to the trigger's change only |
| live | included: the filter applies to whatever change the query read, untracked files included |

## Rendering

One line after the scope line, read from `inputs.declaredConfig` in `headerLines` (`src/mcp/render.ts:107-109`):

```
change: only paths matching src/app/orders/** (the repository is indexed whole; callers outside the selection are known; the rest of the change is not answered about)
```

When `changed` is absent the line is absent. No value field is added: the structured content already carries `inputs`.

## Why paths and not hunks

- `impact.callers` already takes `{ file, start, end }` (`src/core/ports/impact-queries.port.ts:29-30`) and seeds a
  range through the same rows as a changed line (`rangeChanges`, `impact-queries.ts:356-362`). A hunk query is one
  symbol or one range, which `callers` answers today.
- A removal has no head line: the diff stores it as the new-side line after which it vanished
  (`src/core/domain/change/diff-reader.ts:24-27`). A range cannot name a removed declaration; a path can, and removals
  are what produce `unresolved-link` cuts.
- Two coordinate conventions in one request (git's old side in `@@ -a +c @@` against head) would be a new way to be
  wrong.
- The large-change case is per area, not per hunk.

## What it refuses

| Candidate | Why not |
|---|---|
| Filtering the export or the index | that is `scope`, and it hides callers |
| A cut for unselected changed files | the selection is a request, not a blind spot |
| Silently dropping a glob that matches nothing | an empty `complete` answer reads as "no impact" |
| A default inferred from the size of the change | a threshold would decide behavior; `changed` is explicit |
| A value field or server-held handle for the selection | `inputs.declaredConfig` already carries every request value |
| A range form | `callers` has it, and a removal has no head line; reopen with evidence that an agent asks for a hunk and `callers` fails it |

## Measurement

Implemented on 2026-11-03 and covered by the acceptance tests below, but not measured on name-webapp yet. The probe is
the RFC-0016 and RFC-0017 baseline: name-webapp, the reported branch, trust `trusted`, reproducible by input identity,
with the text bytes and the seeds of one area compared against the unscoped call. The expectation to verify, not a
claim: the seeds fall to the selected area's own seeds, while a caller in an unselected changed file still appears in
`symbols`.

Acceptance, each as a test through the public seam:

1. With one changed file selected, the seeds are that file's alone, and a caller in an unselected changed file still
   appears in `symbols`.
2. Without `changed`, the bytes of every existing fixture are unchanged.
3. A glob that matches no changed path is a `unknown-change-path` fault naming it, never an empty answer.
4. `inputs.declaredConfig.changed` is sorted and unique; two orders of the same globs give the same identity, and two
   selections give different ones.
5. The `change:` line appears only when the selection is set.
6. The CLI, the protocol and the MCP carry the same selection to `ofChange`.

## Questions at review, settled at implementation

| # | Question | Decision |
|---|---|---|
| 1 | `changed`, `change` or `paths` as the name? | `changed`: it names the set it filters, and it does not collide with `scope` |
| 2 | Include-only, or `include` and `exclude` like `scope`? | Include-only: a narrower include covers it, and `exclude` already lives in `scope` |
| 3 | A miss is a fault or a cut? | Fault `unknown-change-path`: a silent empty answer is the failure RFC-0002 forbids |
| 4 | Filter the changed entrypoints by `handler.path`? | Yes, with the routing-file limit stated in the text; keeping them whole would make a filtered answer partly about the whole change |
| 5 | Should the value record which files matched? | No: the request records the globs, and the matched files are derivable from the change |
| 6 | Does the filter apply to `impact --live` untracked files? | Yes: it is over the change the query read |
