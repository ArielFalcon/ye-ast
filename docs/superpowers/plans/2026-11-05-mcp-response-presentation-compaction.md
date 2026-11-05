# MCP Response Context Deduplication Implementation Plan

> **For agentic workers:** implement the four units below with focused red/green tests and one final integrated gate. The user explicitly requested one implementation agent; the root orchestrator owns review, integration and Git. Do not spawn additional workers or execute the superseded budgeted draft.

**Goal:** Reduce repeated presentation content across all seven tools and three modes while preserving every currently displayed record, explanatory association and complete structured result.

**Architecture:** Keep current renderers and add only small adapter-owned helpers for exact context sharing and typed navigation. Render from the existing redacted source objects, sharing context only when it is semantically identical and the complete shared layout is shorter. Do not introduce a response budgeting, ranking, truncation or generic template system.

**Tech Stack:** Existing TypeScript, Node 24, node:test/tsx, Zod and MCP SDK. No dependency changes.

**Spec:** Existing [common modes](2026-11-04-common-mcp-response-modes.md), [selective recovery](../specs/2026-11-04-mcp-selective-evidence-recovery-design.md), [typed follow-ups](../specs/2026-11-04-mcp-typed-follow-ups-design.md) and [ADR-0022](../../architecture/adr/0022-typed-query-replay-and-selective-evidence.md), with this latest user scope: optimize repetition before setting hard limits or complicating display selection.

**Baseline/status:** HEAD `99a671243c17b45712dd19b84ea9b80f0e61f4c0`; authorized for implementation by the user's latest request. This document replaces the unimplemented budgeted proposal. The previous version is preserved in the external audit as `budgeted-plan-superseded-before-implementation.md`. There are no approved or calibrated 2/8-KB caps, row limits or percentage gates in this phase.

## Global constraints

- Preserve public input/output schemas, mode names, strict receipts, full facts, sidecars, recovery objects, identities, selectors and cursors.
- Preserve array order, duplicate source records and all associations. Equal context does not make two findings, decisions, handlers or options the same record.
- Preserve the existing eligibility and omission policies of ordinary views. Do not add top-N, sampling, ranking, byte/row caps, string slicing or new omissions. Refactor repeated support, not the set of displayed consequences.
- Preserve partial/unknown/known-empty distinctions, cuts and relevant uncertainty; no presentation change may claim improved analysis coverage.
- Keep ownership and actual snapshots in equality keys. Same path in two repos, two snapshots or base/head is not interchangeable.
- Redaction precedes presentation. Never reconstruct concealed arguments or expose internal mirror paths.
- Keep the complete current text recovery line and structured recovery sibling. Keep necessary text roots/scope/snapshot/notice context even if structured data also includes it.
- No core, retention, trust, semantic query, dependency, discovery-schema or real application changes.
- Selected summary/details retain every primary page record and current explanatory fields. Selected full may use a concise guide to its unchanged complete structured projection; it must still expose availability and limitations honestly.
- No expression language, `Tn/$n` expansion codec, remote handles, retained results or new MCP tool.
- One implementation owner for shared MCP files. No mechanical split into six renderer modules merely to enable parallel work.

## Review focus

1. Repeated evidence under different owners, snapshots, confidence, ranges or ordering must not be incorrectly shared (U1/U3).
2. Sharing a seed or policy must retain every handler/decision association and flags (U2/U3).
3. Workspace unserved arrays may be a subset or contain extra records; universal backreferences require exact qualified multiset equality (U3).
4. Redacted/unavailable recovery, unknown UI component and known-zero selected results keep distinct meanings (U2/U4).
5. Selected-page records, source identity and cursor continuation remain complete and ordered; full text is a guide, not a second page serialization (U2/U4).

## Evidence and factual limits

Use the external audit at:
`/Users/arielyumn/Desktop/TRABAJO/ye-ast_test/evaluations/runs/20261105T074144Z-migration-comparison-6103f7ba/mode-quality-audit`.

Read `report.md`, `quality/matrix.json`, `redundancy/matrix.json`, `redundancy/lead-reduction-proposals.json`, `redundancy/offline-results.json`, `redundancy/offline-prototype.py` and `implementation-plan-analysis.md`. The latter describes the prior budgeted design; its measured findings and contract observations remain useful, but all budget/extraction/ranking proposals are superseded here.

- Actual matched queries already satisfy summary ≤ details < full on total messages, with an outline summary/details tie. Do not make full longer to change text ordering.
- Lookup scaffolding repeats per handler/module. Impact also repeats 33 base-module instructions containing the same repo/SHA; its source arrays remain necessary.
- In the captured workspace, 44 outward names and unserved records have the same kind/name/qualified evidence. This identity is a case precondition, not a universal property.
- Decisions repeat evidence across gateway/repository subjects and repeat a free-text policy; decision types and options remain different.
- Twenty entrypoint unknown locations share file/reason, but their indices/ranges are distinct facts.
- Caller detail has eight distinct handler associations with the same seed; preserve all eight.
- Importers' 18 paths are real, and categories can overlap. Outline's 12 declarations and 3 imports are real; no large intrinsic duplicate was demonstrated. Do not manufacture changes to these views to claim universal savings.
- Offline transformations suggest potential, not approved runtime syntax, guaranteed percentages, tokens or latency. Quality labels were a bounded lead review, not a model experiment.

## File ownership and interfaces

| Files | Responsibility |
|---|---|
| `src/mcp/render.ts` | Existing ordinary renderers; targeted helper extraction and family layouts, same public exports |
| New `src/mcp/presentation-sharing.ts` and `.test.ts` | Pure exact-context table and shorter-layout choice |
| New `src/mcp/presentation-navigation.ts` and `.test.ts` | Typed lookup grouping and literal reconstruction guidance |
| `src/mcp/presentation.ts` | Optional renderer context, preserving current schema |
| `src/mcp/render-evidence.ts` / `.test.ts` | Mode-aware full guide; summary/details page content preserved |
| `src/mcp/server.ts` / `.test.ts` | Actual tool/recovery context forwarding after redaction; no response-schema change |
| `src/mcp/render.test.ts`, `impact-presentation.test.ts` | Existing family behavior and new regression cases; update assertions only where output representation intentionally changes |
| `src/composition/mcp.e2e.test.ts` | Reuse current real stdio fixture for one compact-lookup/continuation proof |
| New `src/mcp/presentation-replay.test.ts` | Optional external captured-fact replay/measurement, self-contained ordinary regression cases remain in owner tests |
| README and RFC-0005 | Document shared display context and full selected guide without new budget promises |

Do not edit identity, selection, cursor or schema implementations. Read their types/tests as authority. If a helper is only useful once, leave the small function in the owning renderer instead of creating a framework.

In `presentation-sharing.ts`:

```ts
export function shareExactContext<T, C>(rows: readonly T[],
  contextOf: (row: T) => C): Readonly<{
    contexts: readonly C[];
    rows: readonly Readonly<{ value: T; contextIndex: number }>[];
  }>;
export function preferShorterText(literal: string, shared: string): string;
```

Use the existing canonical JSON facility for plain typed context equality. Include repo/snapshot and full support arrays in the caller-supplied context. Context table order is first occurrence; row order and multiplicity are untouched. `preferShorterText` compares complete UTF-8 layouts including definitions/references; ties retain literal text. State is local to one render call.

In `presentation.ts`, add:

```ts
export type ToolFamily = "entrypoints" | "callers" | "impact" |
  "importers" | "outline" | "workspace" | "decisions";
export type RenderContext = { tool: ToolFamily; recovery?: Recovery };
export type ResponseRenderer<T> =
  (fact: Fact<T>, mode: ResponseMode, context?: RenderContext) => string;
```

`Recovery` is a type-only import from its existing owner. Add optional third context to existing renderers without changing their defaults. In server `answer`, pass the actual registered family and existing recovery after redaction/identity calculation. The caller tool must not acquire module selectors merely because it reuses the impact renderer. Direct renderer calls without context give conservative full navigation, not a promise of identity-verified replay. Server assembly remains the sole ordinary recovery-line emitter.

In `presentation-navigation.ts`:

```ts
export type LookupGroup = Readonly<{
  selections: readonly EvidenceSelection[];
}>;
export function renderLookupGuide(groups: readonly LookupGroup[],
  context: RenderContext): string[];
```

Build selections from typed recorded coordinates using the existing `EvidenceSelection` union. Group shared kind/owner once; each row retains the exact named handler/module JSON subtree or index/linkId. Add one concrete complete select example per displayed kind, with instructions to combine the literal kind/owner and the row subtree. Use JSON escaping and actual schema fields; no splitting paths by colons, made-up selector IDs or macro substitution. Owner changes are explicit. A singleton keeps its literal form if shorter. Capability and available recovery gate executable guidance; otherwise preserve truthful full-navigation/repeat limitations. No new limit parameter/default.

## Changes by family and mode: all 21 cells

| Tool | summary | details | full |
|---|---|---|---|
| entrypoints | Group existing displayed unknown tuples by exact reason/file; keep every original findingIndex/range and all known routes | Same grouping; retain route→evidence, own guards and caveat; shared evidence must keep each route association | Keep fact/index guide/recipe; remove only demonstrably repeated optional wording |
| callers | Share kind/owner lookup syntax, preserving every currently displayed handler and total | Define equal seed support once; retain all eight handler rows, via, confidence and association caveat | Keep complete fact and relevant joins; omit module advice when capability/data absent |
| impact | Share selector scaffolding and base context; keep existing symbol/module/handler display membership and counts | Same, with actual first-origin explanation and each current association/via/cut | One repo/merge-base guide per owning context, not 33 repeated file instructions; every module remains in the fact |
| workspace | Attach existing unserved condition/references without repeating equivalent evidence | Equality-checked shared listing; proper subsets/multiple owners/extra records remain explicit | Keep all arrays and section/snapshot guide unchanged |
| decisions | Share exact evidence between subjects without merging kinds; preserve options/free-text/required | Shared evidence/policy definitions with explicit flags and every decision's options/basis/recommended | Keep full decisions and relevant short guide |
| importers | Retain category counts, distinctness, overlaps and path-only warning; no forced shrink | Retain all displayed paths and category associations; use shared layout only when lossless and shorter | Retain full overlapping arrays and guide |
| outline | Preserve current declarations/imports; no new summary projection in this phase | Preserve names/kinds/ranges and imports; an existing tie with summary is allowed | Preserve full held/unheld data and short guide |

Creating a differently sampled outline summary or a bounded impact inventory is deferred. That requires a separately justified display policy, not a side effect of deduplication.

### Exact relational rules

- Entrypoints: unknown tuples carry original index/line/endLine; full source order/records are unchanged. A known UI route with component `unknown` remains known and is not renamed to handler.
- Callers/impact: use source seed indices only within owner/snapshot namespaces; module origins are a different array. Sharing a support definition cannot drop a row, alias or union member. Context equality includes basis/confidence/via/evidence as applicable.
- Base modules: group under their owning repo and actual merge base. Reference `module.file` in the already delivered full array rather than listing all files again in the full guide. A foreign section never inherits trigger base. Missing base context says unavailable.
- Workspace: compare kind/name and repository-qualified evidence with multiplicity and snapshot ownership. Use “all recorded outward names are unserved” only on exact equality; otherwise show each unserved membership or explicit reference and keep unmatched records. Status/section cuts remain.
- Decisions: evidence equality is not decision equality. Keep ID/kind/subject/required/outwardKinds/options/recommended. A shared free-text policy applies only to rows that actually allow it; recommendations never authorize trust writes.
- Recovery line, roots and necessary scope/uncertainty are not removable duplicates just because structuredContent includes them.

## Four implementation units (one agent)

The worker completes U1→U2→U3→U4 continuously in the existing isolated worktree. Root owns integration/review/Git. No per-unit agent handoff or mandatory module split.

### U1: Exact sharing primitives and regression witnesses

**Files:** new presentation-sharing.ts/test; existing renderer tests for baseline witnesses.

- [ ] Write tests that keep row order and duplicate row multiplicity, share truly equal context, distinguish repo/snapshot/endLine/confidence/basis/evidence order, and retain literal representation when definitions are longer or tied. Expected contexts/rows are hand-written, not generated by the implementation under test.
- [ ] Run `node --import tsx --test src/mcp/presentation-sharing.test.ts`; observe expected missing behavior, then implement the two interfaces above with no source mutation or cross-request state.
- [ ] Rerun the helper tests; record the observed result in the local progress report. Do not add unused layout/ranking/budget abstractions.

### U2: Lookup/base-context compaction and selected full guide

**Files:** presentation-navigation.ts/test, presentation.ts, render.ts, server.ts/test, render-evidence.ts/test, impact-presentation.test.ts.

- [ ] Add failing tests for eight handler associations sharing one seed, many module lookups with exact coordinates, 33 base modules sharing one repo/merge-base, two owners with identical paths/different merge bases, and unavailable recovery. Assert all rows/source IDs remain represented and that expanded kind/owner/row subobjects produce schema-valid original selectors.
- [ ] Run `node --import tsx --test src/mcp/presentation-navigation.test.ts src/mcp/impact-presentation.test.ts src/mcp/render-evidence.test.ts src/mcp/server.test.ts`; failures must identify the intended repeated-layout change.
- [ ] Implement shared navigation and owner-specific base guidance with current redacted facts. Keep existing consequence selection rules. Pass actual tool/recovery context from server; preserve the answer pipeline order, schemas, digest and paging.
- [ ] Add `mode: ResponseMode` to `renderEvidenceSelection` input and forward it at its server call. For full, emit concise navigation to source/context/items/page, availability and relevant limitations plus required recipe/sidecars; do not duplicate records/source JSON. Summary/details retain current complete page fields/items. Full unavailable/known-zero remain distinct; no extra page slicing.
- [ ] Rerun focused files plus `node --import tsx --test src/mcp/evidence-schema.test.ts src/mcp/select-evidence.test.ts src/mcp/evidence-cursor.test.ts`. Verify full structured facts/projections and recovery are deep-equal to independent pre-change fixtures.

### U3: Exact support sharing across remaining families

**Files:** render.ts, render.test.ts, impact-presentation.test.ts, helper tests as needed.

- [ ] Add failing grouping tests for twenty unknown entrypoint tuples, workspace exact equality/proper subset/evidence mismatch/multiple owners, and decisions with shared support but different options/free-text flags. Assert explicit indices/associations, meaningful evidence, partial/unknown/cuts and zero values.
- [ ] Run `node --import tsx --test src/mcp/render.test.ts src/mcp/impact-presentation.test.ts src/mcp/presentation-sharing.test.ts`; observe failures before changes.
- [ ] Apply the family matrix above through typed records. Preserve information rather than regex-editing already formatted strings. Use shorter-layout choice including reference definitions. Leave importer/outline views unchanged where no genuine shorter equivalent exists.
- [ ] Rerun those files and typecheck. Check all 21 cells, especially hidden association loss under a shared evidence definition and canonical equality that misses ownership.

### U4: Integrated validation, measurements and docs

**Files:** server.test.ts, composition/mcp.e2e.test.ts, new presentation-replay.test.ts if needed; README, RFC-0005 and this plan's progress checkboxes. Measurement/report outputs under `.superpowers/sdd/2026-11-05-mcp-response-context-deduplication/` only.

- [ ] Extend the existing real SDK/stdio fixtures for a compact literal lookup and a two-page continuation. Preserve all previous identity, changed-result, redaction and source verification assertions. Reuse fixtures; no new large test harness or global trust setup.
- [ ] Replay the frozen seven-tool×three-mode Petclinic requests against current renderer/SDK seams using captured public source facts and existing fake-query test helpers. Keep source context/sidecars equivalent. Store actual old/new text and result bytes, every source object/identity comparison and per-cell findings. If full server replay lacks necessary context, report that cell and measure its actual renderer body separately, clearly labelled; never replace the new renderer with the offline prototype or invent wire measurements.
- [ ] Measure `Buffer.byteLength(JSON.stringify(toolResult), "utf8")` separately from decoded text bytes; exclude RPC IDs/newline. Include shared definitions, references, recipes and roots in the appropriate channel. No token/latency/runtime-analysis claims from adapter replay. Require observable reduction in the targeted repeated witnesses, but no invented universal percentage gate. Importer/outline cells may remain unchanged.
- [ ] Run the new adapter replay with `YE_AST_PRESENTATION_CORPUS=/Users/arielyumn/Desktop/TRABAJO/ye-ast_test/evaluations/runs/20261105T074144Z-migration-comparison-6103f7ba node --import tsx --test src/mcp/presentation-replay.test.ts`, the focused stdio proof `node --import tsx --test src/composition/mcp.e2e.test.ts`, then **one final `npm run check`**. Preserve exact logs/counts. New failures are diagnosed; do not call it complete with known unreported failures. A subsequent code correction gets affected tests and a new gate only when previous integration evidence is invalidated.
- [ ] Update README/RFC-0005 to describe shared context and selected full guide, preserving literal recipes and no caps. Amend only obsolete assertions in tests/docs; retain their underlying guarantee. Deliver report, diff summary, measurements and remaining limits to root. No commits, push or publication by the worker.

## Acceptance and completion

1. No added byte/row budgets, top-N, ranking, new omissions, scope/traversal changes, macro language or massive file extraction. A large response remains large if its unique information requires it.
2. Every currently displayed finding/target/path/handler/decision and its relationship is represented after sharing. Only repeated support/context changes representation. Full source facts and sidecars are compared separately and unchanged; no normalization of nested arrays/inputs/producer/cuts/status to force equality.
3. Shared references are local, explicit and human-readable. Supported selects reconstruct from literal typed fields and pass actual schemas. Unavailable recovery and unsupported families never advertise a nonexistent stable route.
4. Every selected page keeps primary item order/count, source identity, availability and cursor. Full text avoids duplicating the complete structured projection; text modes do not lose page data.
5. Existing explanatory gains remain: own-guard caveat, origins≠call chains, via-line ownership, module-vs-symbol origin namespaces, actual base/head and localized cuts.
6. Frozen adapter measurements and focused regression tests show real deduplication for the identified cases. Reporting covers all 21 cells; unchanged cells are disclosed. No model quality/adoption or generic runtime performance inference.
7. All required final checks pass; root reviews the diff and evidence before delivery. Root decides local commits under existing authorization. No implementation claim is based on the offline simulations alone.

## Explicitly deferred

Hard or soft display budgets, relevance scoring, representative sampling, a new outline-summary projection, second-page previews, discovery-schema factoring and LLM adoption experiments. These are separate decisions after this refactor's measurements. The superseded Sol draft supplies useful findings, not executable budget instructions.

## Integrated implementation record (2026-11-05)

The no-budget refactor is implemented. Navigation helpers remain local to `render.ts` because they have one renderer owner; no separate navigation module or optional replay test module was needed. The actual captured-fact measurement adapter and logs are in `.superpowers/sdd/2026-11-05-mcp-response-context-deduplication/`. The checklists above retain the original intended sequence; observed execution and exceptions are recorded in that directory's `report.md` and `lead-review.md`.

Root reviewed all changed production paths and test diffs, connected the exact-context helper to origin grouping, and ran 44 affected tests plus the final `npm run check`: 2,171 tests passed, with typecheck and architecture checks passing. All 21 renderer cells were measured against the committed renderer over the same captured public facts. Current SDK total-result bytes and an independent cross-version full-corpus fact/identity comparison remain unassessed; renderer nonmutation checks and the existing SDK/stdio identity, redaction, page and replay regressions do not substitute for that empirical comparison. No response budgets, new record cuts or semantic-query changes were introduced.
