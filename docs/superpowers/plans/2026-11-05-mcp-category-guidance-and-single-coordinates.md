# MCP Category Guidance and Single Coordinates Implementation Plan

> **For agentic workers:** execute P1→P2→P3→V continuously with one implementation owner. The user explicitly chose a Sol agent with medium effort. Do not dispatch subagents or pause for per-step approvals. Root owns integration, review and Git. Use focused TDD, then one final integrated gate.

**Goal:** Remove repeated instructions and unnecessary text from the 27 observed MCP responses while retaining every displayed record, association, source limit and valid follow-up.

**Architecture:** Keep existing typed redaction, source selection, response receipts and renderers. Compact selected provenance into a text-specific projection, attach interpretation/navigation rules once to each relevant category and owner, and display each handler/module coordinate once. Prefer small local helpers over a formatting framework; keep all structured facts and recovery objects unchanged.

**Tech Stack:** Existing TypeScript, Node 24, node:test/tsx, Zod and MCP SDK; no dependencies.

**Spec:** Latest user authorization to reduce instructional redundancy, moving repeated field-level help to category level. Existing common-response, typed-follow-up and selective-evidence contracts remain authoritative except that text provenance and navigation may be compacted as specified here. This follows the [no-budget context refactor](2026-11-05-mcp-response-presentation-compaction.md).

**Baseline:** clean committed `18e5c0f76018aca86dcd9c95497c6fff93db61db`. Existing worktree/node_modules are usable. The root's new plan is initially untracked; no implementation edits exist at handoff.

## Evidence and analysis

Original immutable evaluation: `/Users/arielyumn/Desktop/TRABAJO/ye-ast_test/evaluations/runs/20261105T112810Z-post-compaction-quality-18e5c0f/`: `matrix.json`, `supplement-matrix.json`, `guidance-attribution.json`, `lead-summary.md`, `lead-validation.json` and raw response paths. These are 21 primary tool/mode calls plus six supplemental calls, not exhaustive graph correctness.

New root analysis: /Users/arielyumn/Desktop/TRABAJO/ye-ast_test/evaluations/runs/20261105T115018Z-instruction-pattern-analysis-7muk_65b/`analysis.md` and `patterns.json`. It scans all 27 raw responses. Pattern categories overlap; affected bytes are not additive or guaranteed savings.

| Observed pattern | Actual witness | Disposition |
|---|---|---|
| Full-mode recovery repeated at row level | impact summary/details have 79/78 full mentions; each has 75 occurrences of the exact 27-byte suffix `; mode: "full" includes all` | Give the rule once per applicable category/owner; retain every row count and example |
| Same coordinate in human and JSON forms | callers text: 8 handler rows; impact text: 16 handler and 74 module rows per mode | Use the named typed JSON subtree as the single coordinate, retaining span and other row facts |
| Selected source serialized twice | selected summary/details have a 1,420-byte source line (1,421 including newline), exactly equal to `structuredContent.source` | Replace text serialization with compact source/read context; structured source unchanged |
| Help irrelevant to registered tool | callers snapshot paragraph discusses impact base/head and base-side modules | Branch by actual `RenderContext.tool` and recorded data |
| Repeated origin reference markers | callers details repeats `origin association above` 8 times | An explicitly bounded shared-context group can replace markers without losing membership |
| Per-record free-text flags | decisions details has 45 `free text allowed` row markers | These are permissions. Group only a uniform category; retain flags/exceptions in mixed categories |

Do not interpret repeated formats, overlapping importer categories, distinct module/handler records or unknown finding indices as removable instructions. Cross-response repetition is expected: every response must remain independently interpretable. Do not move essential warnings exclusively into initialize/tools/list. Full navigation text does not contain the ordinary handler/module row duplication; apply fixes to the actual branch.

## Global constraints

- No hard/soft budgets, top-N, ranking, sampling, new record omissions or extra page slicing. Preserve the current ordinary-view row eligibility.
- Preserve public input/output schemas, full facts/projections, source receipts, metadata, producer/inputs, recovery objects/identity computation, selectors, page items/order/count and cursors. Do not normalize away nested fields to force comparisons.
- Keep redaction before rendering; no absolute internal roots in selectors. Preserve opaque repo IDs, paths with colons/spaces/quotes and original source indices.
- Keep complete existing recovery text and structured recovery, required text repository roots and stale/live notices. This phase targets other instructional repetition.
- Keep partial/unknown/known-empty/selection-unavailable distinct, including source and per-read unknown reasons and owner-specific cuts/limits.
- Keep every currently displayed finding/handler/module/origin/example/via/range/alias/confidence/count and relationship. Context sharing requires exact equality under owner/snapshot; duplicate source rows remain duplicate rows.
- Never pad full or delete evidence merely to force mode-size ordering. The selected one-record witness should shrink by removing duplication; no universal byte ordering guarantee is introduced.
- No core/query/trust/retention, dependency, digest/cursor/schema, discovery-schema or application changes. No new tool, macro language, result cache or broad renderer extraction.

## Review focus and required regression classes

1. A complete root with an unknown contributing read must retain that read's owner, snapshot and reason after selected-source compaction (P1).
2. Two repository owners with identical relative paths and different base/head/live identities must not inherit each other's rules or snapshots (P2/P3).
3. Shared source context and category help must keep row membership/order, different confidence/support, endLine and via/typeOnly facts (P3).
4. Available-empty and unavailable selections, live stale notices, unavailable recovery and text-only clients must remain truthful and actionable (P1/P2).
5. A singleton or tiny category must not grow because of a larger header/example; shorter complete layout wins, and typed selects reconstructed from text must still execute (P2/P3/V).

## Ownership and interfaces

Worker owns `src/mcp/render-evidence.ts` and tests; `src/mcp/render.ts`, `render.test.ts`, `impact-presentation.test.ts`; `src/mcp/presentation-sharing.ts`/test only if needed; `src/mcp/server.test.ts`; focused additions to `src/composition/mcp.e2e.test.ts`; README and RFC-0005. Optional new `src/mcp/presentation-guidance.test.ts` may hold focused category assertions. `server.ts`/`presentation.ts` edits only for a necessary existing-context forwarding fix, not response assembly/schema redesign. All other source files read-only without a consequential scope decision.

Continue using `RenderContext = { tool: ToolFamily; recovery?: Recovery }`, existing `shareExactContext`/`preferShorterText`, and `EvidenceSelection`/`SourceSummary` types. No new public contract is necessary. Define small internal helpers in their existing owner:

- `renderSourceContext(source: SourceSummary): string[]` in `render-evidence.ts`: compact textual source/read context for every selected mode.
- `impactSnapshotGuide(snapshot: SnapshotRef, mergeBase?: string, context?: RenderContext, hasBaseModules?: boolean): string` (or an equivalent small explicit options object) in `render.ts`: actual tool and recorded-field-aware guidance. Update both local/workspace callers.
- Category helpers remain local. Use literal kind/owner plus each row's named handler/module JSON object; never parse rendered paths or create selector aliases.

Logs, before/after measurement scripts and delivery report go under `.superpowers/sdd/2026-11-05-mcp-category-guidance/`. Real evaluation runs, named application fixtures and raw responses go in a NEW external `<ye-ast_test>/evaluations/runs/<UTC>-category-guidance-<suffix>/`. Never overwrite either prior run or root analysis. Root owns commits; worker does not commit/push.

## P1 — Compact selected source text (priority 1)

**Files:** render-evidence.ts/test, server.test.ts. Public structured projection and receipt assembly are unchanged.

- [ ] Add a failing test with a long producer/engine/hash catalog and duplicate same-context reads. Assert text does not serialize the full source object or provenance digests/catalog while structured source remains exactly equal. Selected context, every item, evidence/ranges, availability, page total/offset/limit/nextCursor and full recovery stay present as required by each mode.
- [ ] Add failing complete-root/unknown-read, partial-owner cuts, known-zero page and unavailable-selection tests. Independently assert each owner and unknown reason/limit; a root complete label must not hide unknown read coverage.
- [ ] Run `node --import tsx --test src/mcp/render-evidence.test.ts src/mcp/server.test.ts`; observe intended assertion failures, not missing-module failures alone.
- [ ] Implement `renderSourceContext`. Text retains root snapshot/analysis, trust, declaredScope and declaredConfig. Each read retains owner and analysis/reason; show only differences in snapshot/trust/scope/config under an explicit source-context inheritance rule. Group only exact equal context; keep read owner order/multiplicity. Keep all source.limits with their owner/kind/cuts/places/limit. Producer/schema/hash/engine catalogs remain in the unchanged structured source and are located by one concise pointer. Use typed values, not string replacements.
- [ ] Reuse the compact source helper across selected summary/details/full; full remains a guide to context/items, summary/details still display the complete selected context/items. Do not re-expand full merely to make ordering pass. Required source warnings remain in text even if the client ignores the structured part.
- [ ] Re-run the affected tests plus `node --import tsx --test src/mcp/evidence-schema.test.ts src/mcp/select-evidence.test.ts src/mcp/evidence-cursor.test.ts`; check full/receipt JSON deep equality separately from text.

## P2 — Category-level, tool-specific instructions (priority 2)

**Files:** render.ts, render.test.ts, impact-presentation.test.ts, optional presentation-guidance.test.ts.

- [ ] Add failing tests for a 74-module inventory and several reached handlers: all original rows/counts remain, but generic `mode: "full" includes all` is not repeated per row. Assert one recovery rule per actual category+owner that omits data, not a global count that merges owners. The category tells readers exactly which fields are counts/examples and where complete recorded data is recovered.
- [ ] Add failing callers-vs-impact tests: callers text has no advice about specifying impact base/head or base-side modules; impact with actual base modules retains owning merge-base guidance. Module-origin selectors remain unsupported for callers. Available/unavailable recovery and live/sha have separate truthful guidance.
- [ ] Add tests for 8 handlers sharing exact origin support and another differently supported handler. A shared origin group explicitly says which contiguous rows it governs; no 8 repeated `origin association above` sentences, no changed row order or support association. Keep the association-not-call-chain caveat once in that category.
- [ ] Add uniform/mixed free-text decision category tests if changing those markers. Uniform shown categories may declare their common permission once. Mixed categories must retain per-row flags/exceptions, options, basis/recommendations and kind/subject association. Do not treat all 45 observed markers as removable prose. Leave the existing marker layout if no shorter unambiguous representation wins.
- [ ] Run the focused tests red, then move repeated interpretation/full-recovery sentences to the owning headings. Preserve factual per-row counts/remaining-origin counts and examples. Shorten verbose navigation by removing repeated instructions already covered by category rules; keep necessary joins/namespaces, via.lines ownership, partial limits and snapshot/live semantics.
- [ ] Use the actual family from RenderContext, already forwarded after redaction, for concise snapshot advice. A no-context direct renderer call stays conservative; unknown/unavailable branches never promise replay. The exact recovery recipe remains the authoritative executable query.
- [ ] Re-run affected renderer tests and typecheck. Keep unchanged importer/outline/entrypoint/workspace content unless a concrete repeated instruction in these 27 calls justifies a smaller equivalent; no forced mode redesign.

## P3 — One coordinate representation per row (priority 3)

**Files:** render.ts, impact-presentation.test.ts, render.test.ts and focused stdio test.

- [ ] Add failing tests for duplicate handler/module coordinate representations and UTF-8 tiny cases. Use paths containing spaces, colons and quotes; same path under two owners, base/head modules, endLine, confidence, via and typeOnly. Assert complete row semantics and source order/multiplicity, not just string sizes.
- [ ] In selectable categories, retain each exact `handler: {path,symbol,line}` or `module: {file,snapshot}` JSON object once, instead of repeating its values in a separate human prefix. Keep route kind/name/alias, span endLine and depth/confidence/origin/via facts outside that object when they are distinct. If a name is separately meaningful, do not drop it just because it equals a symbol in one witness.
- [ ] At category+owner level emit one literal kind/owner rule and one complete schema-valid selector example. A caller copies the row's named subtree into that selector; no template codec or path splitting. Each owner change is explicit. Singletons keep the shorter complete literal layout. Unsupported/unavailable recovery branches keep useful recorded coordinates without executable-selector claims.
- [ ] Extend existing real stdio proof to reconstruct a handler selector from the NEW text, execute it, continue its cursor and retain changed-source rejection. Add module selector schema reconstruction to focused SDK tests; keep original source/identity/projection/sidecar assertions.
- [ ] Re-run `node --import tsx --test src/mcp/render.test.ts src/mcp/impact-presentation.test.ts src/mcp/server.test.ts src/composition/mcp.e2e.test.ts` plus helper tests if changed.

## V — Integration, 27-case replay and documentation

- [ ] Update README/RFC-0005: category-scoped help, single literal coordinates and compact selected-source text; unchanged structured provenance/recovery and no caps. Keep examples executable and explain unknown/read limits where needed.
- [ ] Replay the 27 frozen shapes on the new actual renderer to check text content conservation; preserve all raw pre-change references. For actual result/wire savings, run baseline `18e5c0f` and new code via real stdio against the SAME run-owned replicas/IDs/paths/snapshots/trust/scope. Freeze launch/workload/oracles before scoring and separate discovery. At most 27 matched calls per version (54 total), no repetition/latency benchmark or new corpus campaign. Reuse the existing collector and fixed source evidence.
- [ ] Compare full structured facts/projections, receipts, recovery objects, page/cursor semantics and sidecars exactly per case; report legitimate dynamic fields individually rather than broad normalization. Report text bytes, structured bytes, result JSON bytes and actual wire bytes separately, plus category-instruction repetition counts and actual selector executability. Use the skill ye-ast-mcp-evaluation for the real replay and respect its immutable artifacts/cleanup rules; empirical adoption remains outside this technical sample unless an authorized clean harness is actually available.
- [ ] Require actual reduction in the three targeted witnesses: selected one-record summary/details; callers instructional text without irrelevant base advice; impact repeated reminders and duplicate coordinates. Retain all unique currently displayed information. Unchanged cells are valid. Selected summary/details should no longer exceed full for the observed witness through removed duplication, not padding or cuts; investigate and report if this remains unresolved. No universal ratio or calibrated budget is claimed.
- [ ] Run ONE final `npm run check` after implementation and affected tests settle, plus `git diff --check`. New real failures must be diagnosed and fixed; avoid repeatedly running an unchanged full suite. Do not stop at scaffolding, a disconnected helper, or an unfinished measurement/report without a genuine external or consequential blocker.
- [ ] Deliver report with exact files, observed red/green tests, 27-cell before/after data, preserved invariants, source examples, cleanup, limitations and any remaining findings. Root reviews actual diff and verification before local commits. No push/PR/publication.

## Acceptance

1. The duplicated full selected-source serialization is gone from text; essential root/read/owner/limit interpretation remains and structured source is unchanged.
2. Rules apply once to the relevant category/owner, not repeatedly to fields/rows. There is no orphaned count/example or ambiguity about support association.
3. Each coordinate is displayed once where the compact representation wins, remains literal/schema-valid, and includes all distinct range/via/ownership facts.
4. All displayed primary records/associations, structured facts/receipts/recovery, identities/cursors/redaction and uncertainty survive the refactor. All seven tools and three modes are checked with observed evidence, without claiming complete graph recall.
5. Targeted actual responses shrink, focused/stdio checks and final full check pass, and remaining measurement/empirical limits are explicit.

## Integration outcome

P1, P2, P3 and V are implemented. Root reviewed the actual diff, fixed singleton header overhead and a vacuous test assertion, added typed read-context override coverage, and observed the final full gate passing 2,176 tests with typecheck and architecture correct. Raw replay contains 54 matched calls and 27 exact structured/meta pairs; final renderer bodies match the measured corpus, with selected renderer unchanged. No second final-build live collection was performed. The local `lead-review.md` and `lead-validation.json` under `.superpowers/sdd/2026-11-05-mcp-category-guidance/` preserve exact verification and measurement limits; the original checklists describe the intended sequence rather than a substitute for that evidence.
