# Shared MCP Presentation Policy Implementation Plan

> One implementation owner continues the authorized refactor; root reviews, integrates and commits. Complete the implementation and checks, not a planning-only handoff. No additional agents.

**Goal:** Make reusable presentation optimizations available to every applicable MCP tool through an explicit adapter-owned layer, keeping family-specific meaning and projection decisions local.

**Baseline:** `ab3a319`; existing isolated worktree and installed dependencies. The user explicitly requests implementation, correct architectural placement and a clear separation of shared policy from fine adjustments.

**Architecture:** RFC-0001 assigns response shaping to driving adapters. General MCP presentation belongs in `src/mcp`, not core/domain/application, core/adapters or another transport. `server.ts` remains request/response assembly, redaction and dispatch; shared presentation primitives shape typed redacted facts, while family renderers select their data and explain its specific meaning. Do not create a framework, one-file-per-tool migration or cross-transport dependency.

## Findings and ownership

| Concern | Current state | Required owner |
|---|---|---|
| Status, snapshot, declared scope and changed-selection context | headerLines already called by all seven tools inside render.ts | Small explicit shared presentation-context module, used by all seven; selected context uses the same underlying context projection |
| Compact selected source and per-read inheritance | renderSourceContext private in render-evidence.ts, shared in practice by three selectable tools | presentation-context.ts; selected renderer owns page/item display, not general provenance shaping |
| Exact context sharing and complete shorter layout | presentation-sharing.ts exists, but render.ts also has a private byte scorer and several hand-coded context tables | presentation-sharing.ts for generic operations; family chooses semantic equality key and row eligibility |
| Full/details recovery instructions | optimized in impact/callers, still hand-written in entrypoint guards/profiles, workspace names/unserved, importer path omission and decisions counted dependencies | Small shared presentation-guidance.ts for consistent category-level recovery wording and capability-aware lookup instructions, wired to each applicable family |
| Literal selector coordinates and owner/kind scaffolding | impact-specific construction, cut coordinates separately built, finding/link coordinates have other valid shapes | Shared typed selector/navigation helpers for the same reconstruction rules, reused by handlers/modules/cuts and entrypoint/link navigation where applicable; no selection claims for unsupported tools |
| Guards, base paths, origin namespaces, module via semantics, importer category overlap, workspace equality and decision permissions | Different meanings | Keep in family renderers; do not generalize their truth or merge source records |

Source evidence: the 27 actual responses at `/Users/arielyumn/Desktop/TRABAJO/ye-ast_test/evaluations/runs/20261105T112810Z-post-compaction-quality-18e5c0f/`; pattern analysis at `/Users/arielyumn/Desktop/TRABAJO/ye-ast_test/evaluations/runs/20261105T115018Z-instruction-pattern-analysis-7muk_65b/`; last matched campaign at `/Users/arielyumn/Desktop/TRABAJO/ye-ast_test/evaluations/runs/20261105T115605Z-category-guidance-matched/`. These remain immutable.

## Constraints

- Preserve all full facts, selected receipts/projections, sidecars, public schemas, input controls, source identities, recovery recipes and cursors. No query/core/retention/trust/dependency changes.
- Keep all currently displayed primary records, source order/multiplicity, aliases, coordinates/ranges, owner/snapshot, confidence, via/typeOnly, option/basis/recommendation/permission associations, partial/unknown/empty distinctions and owner-specific limits.
- No budgets, caps, top-N, ranking, sampling, new omissions, extra page slicing, selector macros, result caches or artificial growth of full to force ordering.
- Preserve ordinary projection membership and current omission policies. Choose a shorter representation of the SAME information; singleton/tiny views must not grow from new scaffolding.
- Required recovery lines, roots and live/stale notices stay. Each response remains interpretable without relying only on initialize/tools/list.
- Avoid a second capability authority: existing evidence-schema.ts and validRecoveryControls define supported selections. Navigation helpers consume typed capability/actual context and must agree with those schemas; do not silently widen them or put family truth inside a generic string helper.
- Shared code must have real production consumers. A helper moved out but left unused or parallel local copies is not completion.

## Implementation units

### 1. Shared context and compact-layout policy

Create `src/mcp/presentation-context.ts` with focused tests; extend existing presentation-sharing.ts/tests only as needed. Move existing fact header and compact selected-source context into it, sharing the underlying snapshot/trust/scope/config projection without changing ordinary header field eligibility. Export explicit small typed functions, e.g. `renderFactHeader(fact: Fact<unknown>): string[]`, `renderFactStatus(fact: Fact<unknown>, indent?: string): string[]`, `renderSourceContext(source: SourceSummary): string[]`. Share cut counts/snapshot/evidence primitives where required to avoid cycles; the context module must not import family renderers.

- [ ] First add regressions for seven-tool summary/details header consistency, complete/partial/unknown facts, live/sha, changed-vs-scope caveat and selected complete-root/unknown-read overrides. Preserve independently expected strings/objects and meaningful original assertions.
- [ ] Observe intended focused red failures, then migrate every applicable consumer, removing obsolete local copies.
- [ ] Centralize UTF-8 block length/shorter-choice in presentation-sharing.ts. Family tie behavior and existing listed membership must remain intentional; do not change a listing simply by accidentally changing newline accounting.
- [ ] Use existing exact-context helper when a generic duplicated context table is actually equivalent, but keep workspace equality and family-specific support keys local.

### 2. General category guidance across applicable families

Create `src/mcp/presentation-guidance.ts` with tests. Its inputs describe category information already decided by a family: what is counted/omitted, the applicable recovery modes/path and actual tool/recovery capability. Keep helpers small and pure; no IR, config language or regex transformation of rendered text. Recoverable literal selector helpers should use existing EvidenceSelection subtypes, correct owner/index/handler/module/link fields and JSON escaping.

- [ ] Add cross-family tests that require the SAME general rule to have one owner and actual consumers in entrypoints, callers/impact, workspace, decisions and importers. Outline consumes shared context/layout; it must not acquire selection/recovery controls it lacks merely to show a change.
- [ ] Cover unsupported tool vs unavailable recovery vs available recovery, local/section/read owner differences, same path under different snapshots, escaped paths/symbols and the explicit missing component variant.
- [ ] Route repeated full/details recovery instructions for entrypoint profiles/guards, workspace dependency/unserved categories, importer omitted paths and decisions counted dependencies through the shared helpers. Keep counts and category-specific explanation local. For multiple importer target files, place identical path-recovery instruction once at the applicable category scope, while preserving per-target counts/membership.
- [ ] Reuse the same category recovery and single-literal coordinate policy for callers/impact; do not regress the concise singleton case. Cut/finding/link coordinates keep exact source indices/IDs and owner namespaces. A generic helper cannot invent executable follow-ups for an unsupported or unavailable context.
- [ ] Keep own-guard caveat, origin-vs-chain warning, via-line ownership, base/head resolution, importer overlap, workspace unserved equality and decision free-text permissions as family-specific rules. Where a family has no applicable duplication, retain its output and record that explicitly.
- [ ] Add table-driven tests for uniform/mixed categories and compare complete shorter layouts, including definitions and examples. No lost association or silent global deduplication across owners.

### 3. Architecture contract and integrated verification

- [ ] Add a concise ownership matrix to RFC-0005 explaining transport assembly → shared MCP presentation policy → family projections, with actual files and examples of common versus fine rules. Reference RFC-0001 without declaring presentation a new domain concern. README describes behavior, not implementation details.
- [ ] Update/add SDK tests covering all seven registered tools in all three modes. Assert unchanged structured facts/receipts, metadata, recovery and necessary limits. Execute reconstructed selectors for selectable families; unsupported families do not advertise them. Reuse existing real stdio reconstruction/continuation/changed-source tests.
- [ ] Replay the existing seven-tool × three-mode captured full facts plus selected cases through baseline ab3a319 and current renderers, preserving exact per-tool required records/context. Record body bytes, actual content examples and changed/unchanged reasons for ALL tools. This is renderer regression evidence, not a new live wire/SDK claim. New scope is architecture/application of common rules, so do not repeat a 54-call empirical campaign merely to restate prior data.
- [ ] Run focused policy/family/SDK/stdio tests, typecheck and architecture checks, then ONE final `npm run check` and `git diff --check` after changes stabilize. Repeat a broad check only for a material fix that invalidates it.
- [ ] Deliver an actual dependency/consumer matrix: shared concern → shared module/export → every applicable production consumer → family-specific decisions retained → test evidence. No blanket claim that every tool shrank. Report remaining gaps or justified unchanged behavior per tool.

## Ownership and acceptance

Worker may edit new src/mcp/presentation-context.ts/test and presentation-guidance.ts/test; presentation-sharing.ts/test; presentation.ts; render.ts and its renderer/impact tests; render-evidence.ts/test; server.test.ts; focused composition/mcp.e2e.test.ts; README and RFC-0005. server.ts only if necessary for existing actual context forwarding, with no assembly/schema redesign. Other files need a consequential scope decision. Root owns Git and plan; worker may record progress. Logs/report under `.superpowers/sdd/2026-11-05-mcp-shared-presentation-policy/`; named corpus artifacts remain outside engine. No agents, commits, installs, pushes or original-clone/cache changes by worker.

Complete when shared policy is truly reused by all applicable tools in the correct adapter layer; no generic logic is stranded in an impact-only renderer; family semantics remain explicit; all seven tools have a truthful applicability record; schemas, structured payloads, primary records, cursor/recovery/redaction and uncertainty remain intact; and verification passes. The root reviews source/diff/evidence and decides commits under existing authorization.

## Integration outcome

Implemented and reviewed by root. Shared context/layout/category policy has actual cross-family consumers; family-only importer copy stays local. Handler/module/cut capabilities all use the schema-backed shared guard with strict selector coordinates. Root observed 57 focused tests, the 21-cell and selected frozen replay, and final check passing 2,184 tests with typecheck and architecture correct. Existing structured delivery, source identity and paging regressions pass. Detailed applicability and limits are recorded in `.superpowers/sdd/2026-11-05-mcp-shared-presentation-policy/lead-review.md`. No new live-wire savings campaign or universal shrink claim.
