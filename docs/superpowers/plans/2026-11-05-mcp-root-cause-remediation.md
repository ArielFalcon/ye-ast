# MCP Root-Cause Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Work in the tool-assigned isolated worktree; follow the ownership and verification boundaries below.

**Goal:** Correct structural causes of incorrect facts, unusable identities and repeated MCP presentation found by the 213-call diagnostic, preserving analysis completeness and reconstructable evidence.

**Architecture:** Fix code semantics at their owning language adapter or domain/application rule. Keep presentation policy in MCP and secret detection in the redaction adapter. The lead owns shared presentation, redaction and integration; seven tool-specific implementers own bounded worktrees. Avoid parallel alternative implementations of shared mechanisms.

**Tech Stack:** TypeScript, node:test, existing compiler/codegraph adapters, MCP SDK and Zod; no dependency changes.

**Spec:** The user's root-cause remediation request and the bounded diagnostic at `/Users/arielyumn/Desktop/TRABAJO/ye-ast_test/evaluations/runs/20261105T135355Z-per-tool-diagnostics-a7lydj6f/report.md`. Evidence there establishes current failures, not their causal introduction by the preceding migration.

## Global Constraints

- Follow the repository architecture/DDD placement and dependency rules in AGENTS.md and RFC-0001. Never weaken architecture checks.
- One owner per fact. A shared mechanism is fixed once at its source; do not compensate independently in each renderer.
- No repository-specific allowlists, app names, exact reported line numbers or synthetic facts in production code.
- Preserve declared/recorded own guards separately from inherited/runtime behavior.
- Preserve genuine dependencies and distinguish invocation locations from type/reference locations.
- Unknown/partial, scope, snapshots, confidence, cuts, owners, original indices and replay/page semantics remain explicit.
- Preserve public full fact shapes and array membership/order unless the lead records and verifies a necessary contract correction. Presentation compaction must not modify facts or pagination.
- No hard response-size limits, record cuts, omitted evidence by arbitrary thresholds, padded full responses, or token/cost claims.
- Repeated paths in distinct semantic categories are not removable duplicates. Factor exact context only, with reconstructable associations.
- Do not remove recovery/receipt copies merely because two channels contain them; text-only and structured clients remain supported.
- The lead alone owns `presentation-*.ts`, shared helpers in `render.ts`, `server.ts`, `server.test.ts`, redaction, integration fixtures/docs and git integration.
- No installs, dependency/lock changes, pushes, public PRs, real application changes or writes to evaluation corpus originals.
- Child worktrees may reuse the parent's existing node_modules with a worktree-local symlink if absent; never replace an existing directory or install dependencies.
- Every fix starts with an observed failure for the intended behavioral reason, then focused tests, typecheck, architecture and diff check. Perform a focused type-correct break proof in the isolated worktree and restore exactly before delivery.
- Child commits are explicitly authorized for this requested worktree integration, limited to owned files and behavior-sized units. Root merges or cherry-picks only reviewed deliverables. Never stage unrelated files.

## Review Focus

- Sibling/nested/reused Angular routes and guard arrays: ownership must not bleed between route objects or branches.
- A source using the same target both as a type and an invocation: preserve reachability while making reported provenance truthful.
- Client identifiers, scheme-only strings and dynamic URL expressions: do not infer gateway prefixes from syntax mistaken for a path.
- Long versioned source identifiers versus real encoded credentials: preserve navigable identities without introducing secret exemptions.
- Multiple cut owners/read indices and nonadjacent equal evidence: context sharing must not change selector reconstruction, multiplicity or ordering.

## Integration and Ownership

All implementers start from an explicitly recorded parent commit through `delegate_task(isolation: "worktree")`. The lead already works in an isolated branch and owns parent git operations. No agent works in the parent's checkout.

First wave: Tasks 1–3, independent semantic owners. In parallel, the lead implements Task 4's shared causes. Remaining tool worktrees start from the resulting shared checkpoint. Seven tool-specific implementers are dispatched in total; runtime concurrency is bounded by the session's available slots.

`render.ts` remains one lead-owned integration file. Where a tool's presentation needs changes, the tool implementer may change **only its assigned named symbol region in its isolated copy**, or introduce a focused family helper that region consumes. Shared helpers/imports and tests are reconciled by the lead. Workers must not move or format unrelated regions. The lead checks symbol ownership and resolves patch conflicts by behavior, never by taking an entire side.

### Task 1: Entrypoints — route-local facts and evidence

**Owner:** entrypoints implementer.
**Edit surfaces:** `src/core/adapters/typescript/angular-router.extractor.ts`, `route-table.loader.ts`, `angular-routes.adapter.ts`, their directly related tests/fixtures; the `itemLine`, `entrypointContext`, `unknownFindingRun`, `entrypointItems` and `renderEntrypointMap` region of the isolated `src/mcp/render.ts`; new `src/mcp/entrypoints-presentation.test.ts` if needed. No shared render helpers.

- [ ] Trace the RealWorld sibling guard leak from raw extraction through resolved findings; establish the structural ownership error before changing it.
- [ ] Add an independent small fixture with a guarded sibling, an unguarded parameter sibling, nesting and reused component/guard declarations. Observe the wrong ownership before the fix.
- [ ] Fix route-object/branch ownership at the actual producer. Retain genuine own guards and unknown evidence.
- [ ] Investigate the shared unknown/base-path evidence repeated across findings. Use existing exact-context sharing where it preserves finding indices and every association; do not merge merely similar evidence arrays.
- [ ] Test generalized extraction and presentation conservation, run focused checks and break proof, commit owned changes and report exact root cause and verified scope.

### Task 2: Callers — dependence provenance and locations

**Owner:** callers implementer; this is the single owner of the mechanism shared with impact.
**Edit surfaces:** `src/core/application/impact/inbound-edges.ts`, its focused tests and corresponding impact query tests; `src/core/domain/impact/edge-policy.ts` or same-subdomain provenance rule/tests if the traced cause belongs there; `src/core/adapters/codegraph/` only if the upstream translation itself is faulty. No HTTP extraction, renderers, redaction or schemas.

- [ ] Trace how references and invocation/instantiation edges become `via.basis` and `via.lines`; reproduce the mixed return-type/constructor location without a repository-specific filter.
- [ ] Cover mixed call/reference, reference-only and constructor-only inputs through the owning production seam. Check whether the root is line aggregation, edge classification or SDK translation before choosing a fix.
- [ ] Make the locations truthful for the reported basis while preserving supported reachability, confidence, order and actual reference-only dependencies. Do not silently drop valid graph relations.
- [ ] Demonstrate the correction through callers and the shared impact owner once; leave generic cut-selector presentation to the lead.
- [ ] Run focused checks, a decisive break proof, commit and report any contract interpretation explicitly.

### Task 3: Decisions — evidenced HTTP targets and gateway subjects

**Owner:** decisions implementer; shared HTTP/gateway mechanism also serves workspace.
**Edit surfaces:** `src/core/adapters/typescript/http-call-sites.adapter.ts` and directly related helper/tests; `src/core/domain/topology/link-match.ts` and tests; `src/core/domain/decisions/decision-set.ts` and tests. No Angular route extraction, common MCP context or renderers.

- [ ] Trace `gateway:http:` to the first invalid producer, distinguishing parser output from prefix inference and decision assembly.
- [ ] Reproduce a realistic injected HttpClient field and actual URL expression. Contrast with valid absolute URLs, relative gateway prefixes and unresolved dynamic targets.
- [ ] Correct the semantic classification at its owning layer; preserve uncertainty rather than guessing a URL or suppressing a literal by name.
- [ ] Check exactly repeated evidence at decision creation, if present. Preserve distinct locations, ownership and option support; do not change public facts merely to compress repeated path strings.
- [ ] Verify the downstream gateway decision and workspace interpretation, run focused checks/break proof, commit and report causal chain and remaining coverage.

### Task 4: Lead — shared causes, once

**Owner:** lead, in the parent isolated worktree.
**Edit surfaces:** `src/mcp/presentation-context.ts`, `presentation-guidance.ts`, `presentation-sharing.ts`, `presentation.ts`, shared portions of `render.ts`, their tests; `src/core/adapters/redaction/pattern-redaction.adapter.ts` and related policy/tests; shared SDK/stdio and composition integration tests. Keep security correction separate from presentation commits.

- [ ] Replace shared hardcoded `workspace.repos` advice with guidance derived from the publishing tool's input shape. Test workspace/decisions top-level and impact/callers nested workspace advice through the SDK.
- [ ] Trace long Java path redaction to the false-positive rule. Add general legitimate versioned/code path cases and actual encoded/named/by-value secret controls; fix the classifier without global path bypass or repository allowlist.
- [ ] Factor `cut-places` context at category/owner level, retaining exact cutIndex, owner/read index, anchor and reconstructable literal arguments. Compare complete UTF-8 layouts and use the shorter complete form when factoring adds overhead.
- [ ] Reuse this mechanism in callers and impact, and other applicable projections. Keep categories that cannot share context distinct.
- [ ] Keep recovery accessible in both channels unless actual supported-client evidence authorizes another representation; document its disposition rather than invent negotiation machinery.
- [ ] Commit security and shared presentation as separate verified work units. Publish helper contracts to dependent tool worktrees before they start.

### Task 5: Impact — family presentation and task-proportionate guidance

**Owner:** impact implementer, after shared checkpoint.
**Edit surfaces:** isolated `render.ts` regions `impactSeeds`, `seedListing`, `seedSummary`, `groupedSeeds`, `baseModuleGuides`, `localImpactGuide`, `workspaceImpactGuide`, `unknownImpactGuide`; a focused `src/mcp/impact-presentation.test.ts`. Shared body/reached/module/cut helpers remain lead-owned because callers uses them.

- [ ] Read root dispositions for the shared graph/cut mechanisms; do not implement alternatives.
- [ ] Trace repeated or irrelevant impact guidance to its condition/context owner. Fix category-level generation and repeated base/head context only where task-relevant information is reconstructable.
- [ ] Cover empty/unknown/partial/nonempty impact, base-side modules, workspace owners, callers mode through shared helpers, and live/recovery unavailable without promising unsupported navigation.
- [ ] Measure old/new rendering on the saved meaningful production-change cases and tiny/no-extractor cases. No forced monotonic byte ordering.
- [ ] Verify focused tests, conservation and break proof; commit owned changes.

### Task 6: Workspace — lossless category evidence presentation

**Owner:** workspace implementer, after shared checkpoint.
**Edit surfaces:** isolated `render.ts` regions `candidateLine`, `groupedByRank`, `namesBlock`, `unservedBlock`, `unresolvedListing`, `unresolvedLine`, `unresolvedBlock`, `renderWorkspace`; new `src/mcp/workspace-presentation.test.ts`. Shared sourceLine/cut helpers remain lead-owned.

- [ ] Trace repeated names/unserved/evidence to presentation ownership rather than treating two valid semantic categories as duplicate facts.
- [ ] Share exact name/evidence context with explicit repository and category associations; preserve all rows and unresolved evidence, membership provenance and counts.
- [ ] Keep full structured results unchanged. Do not replace public fact arrays with new reference schemas.
- [ ] Test multiple repositories with equal text/different owners, partial sections and unknowns; compare bounded saved examples for actual UTF-8 benefit and complete reconstruction.
- [ ] Run focused checks/break proof, commit and report safe changes versus repetitions that remain necessary.

### Task 7: Importers — category membership without repeated path text

**Owner:** importers implementer, after shared checkpoint.
**Edit surfaces:** isolated `render.ts` `importerPathRecovery`, `importerFiles`, `renderImporters`; new `src/mcp/importers-presentation.test.ts`. Optional actual module-resolution defect requires a demonstrated reproduction and lead ownership approval first.

- [ ] Inspect multi-target and importers/users/reexports/dynamic memberships; do not mistake overlap for duplicated relations.
- [ ] Factor exact path/list context only in text with explicit category/target membership and unchanged ordering; keep original full arrays and the one per-category recovery instruction.
- [ ] Preserve scopes, unresolved candidates, type/static distinctions, tiny and empty results. No unmeasured new reference framework.
- [ ] Measure full response/text separately against the saved corpus, use shorter complete layouts, verify reconstruction, run focused tests/break proof and commit.

### Task 8: Outline — navigation correctness and useful fixed context

**Owner:** outline implementer, after shared redaction checkpoint.
**Edit surfaces:** isolated `render.ts` `renderOutline`; new `src/mcp/outline-presentation.test.ts` and a focused public SDK/stdio test file for outline (do not edit lead-owned server.test.ts). No independent redaction changes.

- [ ] Verify the shared path fix through the public outline boundary, including valid long/versioned names and actual secret-bearing content controls.
- [ ] Analyze whether fixed per-call help repeats other context or supplies necessary navigation. Reduce only demonstrated redundancy; identical summary/details calls alone do not require artificial differentiation.
- [ ] Preserve imports/declarations, span navigation, no-extractor, known-empty, missing/unheld and partial semantics; avoid new per-symbol help.
- [ ] Run focused checks/break proof, commit, and report any remaining shared redaction cause to the lead instead of patching locally.

### Task 9: Integration, review and empirical closure

**Owner:** lead plus fresh bounded independent reviewer(s).

- [ ] Inspect each returned diff/commit against causal evidence, ownership, architecture and test assertions. Reject output-only compensation for a faulty producer.
- [ ] Integrate one worktree at a time using reviewed commits, preserving separate behavioral/security units. Resolve actual conflicts symbol by symbol and rerun the affected family checks before proceeding.
- [ ] Run typecheck, architecture and relevant MCP/core/composition tests after dependency seams change. Run `npm run check` once on the integrated final state, then repeat only for subsequent relevant fixes.
- [ ] Build a fresh immutable candidate and rerun a bounded matched workload from the frozen diagnostic, including the original root-cause repros, repeated cut selectors, selected-page reconstruction, tiny results and all seven tool families. Separate intended corrected facts from unchanged facts; compare metadata/snapshots/page/recovery and bytes by channel.
- [ ] Request independent review of semantic/security and presentation/integration changes, with exact diff bases and observed check evidence. Recheck actual fixes in a fresh bounded review.
- [ ] Deliver actual commits/integration state, observed checks and before/after outcomes for every affected tool, plus explicit unresolved items. Do not claim exhaustive graph recall or model adoption.
