# Current Engine Mechanism Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development task-by-task. Checkboxes below reflect the bounded execution evidence; unchecked items remain design gates or unexecuted conditional work.

**Status:** Bounded Tasks 1–4 integrated into the working tree on 2026-11-05; integration verification passed (`npm run check`: typecheck, architecture checks and 1,891 tests). Tasks 5–7 have recorded design, negative-safety and feasibility outcomes below. Unchecked conditional work remains pending; no provider migration or dependency changes are authorized. The owner subsequently authorized code cleanup, local commits and merging these improvements into `main`.

**Goal:** Improve the existing engine's exact static bindings and evidence without adding LanguageService, Angular LS, JDT, dependencies, or another index.

**Architecture:** Keep codegraph, the existing traversal, framework extractors and compiler-backed type port. Repair shared occurrence, signature and provenance mechanisms through their current owners. Project ownership and initializer eligibility have explicit design/evidence gates rather than silent safety-policy changes.

**Tech Stack:** Node 24.22.2, TypeScript 6.0.3 public compiler API, existing codegraph adapter, node:test and tsx.

**Spec:** The [design contract below](#design-contract) specifies this proposal. The [earlier symbol-proof design](../specs/2026-11-04-symbol-proof-improvements-design.md) supplies inherited invariants, not approval for every new task. [Migration reassessment](2026-11-05-semantic-provider-migration-reassessment.md) is a separate future decision.

## Design contract

Preserve public query schemas, exact raw occurrence identity, read-only snapshot confinement, explicit unknowns, existing traversal bounds, and ADR-0017's distinction between whole-type and member dependencies. No repository execution, automatic dependency downloads, installed-project scanning, compiler plugins or new external servers.

A successful change either resolves a source-proven dependency, removes a source-disproven attribution, or makes category/confidence/provenance truthful. A smaller cut count alone is not success. A cut retires only after its exact occurrence, unique source/target join, admitted target expansion and reached source satisfy the existing rule.

Tasks 1–4 are bounded implementation work. Tasks 5–7 are conditional work with explicit approval/evidence gates; do not treat their potential benefits as demonstrated. Production source is unchanged by writing this plan.

## Evidence and overlap

Baseline inspected: `602ffe695f3e4130f8b5a603e20ccbaa85717200`. Recheck HEAD and consumers before execution; line numbers and old checklist states are not authority.

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| [Current-engine diagnostic](../../../../ye-ast_test/evaluations/current-engine-reuse-20261105/report.md), [probe](../../../../ye-ast_test/evaluations/current-engine-reuse-20261105/probe.mjs), [output](../../../../ye-ast_test/evaluations/current-engine-reuse-20261105/results.txt) | Existing resolver handles generic/await callees; a generic receiver position can fail. Current first-declaration lookup misattributes a numeric overload; installed checker selects the correct signature. | Public MCP gains, frequency in the corpus, or a safe production patch. |
| [TS precision experiment v4](../../../../ye-ast_test/evaluations/runs/20261104T202207Z-typescript-language-service-capabilities/experiment/execution-v4/report.md) | Reproduced signal-category, occurrence merge, strongest-path provenance and decorated-owner defects; application corrections were also used in the checker-only B2 arm. | Approval to import its whole patch, activate its semantic-reference interface or claim full transitive reconciliation. |
| [Combined native trial](../../../../ye-ast_test/evaluations/runs/20261104T223130Z-semantic-native-without-codegraph/experiment/execution-v4/report.md) | New binding capabilities coexist with real caller losses, entrypoint changes and costly repeated work. | A production replacement recommendation or intrinsic limits of the tools. |

The [reference identity plan](2026-11-04-reference-identity-and-bindings.md), [syntax-backed causes plan](2026-11-04-syntax-backed-cut-causes.md), and [scoped receiver plan](2026-11-04-scoped-receiver-evidence.md) overlap with this subject. At the inspected baseline, exact reference keys, unique-occurrence checks, raw-column preservation, graph-column + 1 conversion at source-port boundaries, and reached/expanded settlement checks already exist. **Do not reimplement them or apply another column increment.** Preserve their tests. The new gap is expression-to-name anchoring and use of already available compiler semantics.

Keep corpus-specific names, workloads, raw replies and measurements outside this engine repository. The external artifacts map examples to pinned inputs; do not encode those layouts in production.

## Coverage of reported findings

This is a traceability inventory of the written experimental findings, not an exhaustive audit of every raw response, patch or possible engine improvement. The first version of this plan concentrated on the best-supported TS and traversal repairs; it did not establish that all Angular and Java opportunities had been exhausted. A small code change can repair a shared mechanism; neither its size nor this inventory predicts the proportion of corpus cuts it will solve.

| Reported family | Existing-engine opportunity | Evidence level and disposition |
| --- | --- | --- |
| TS generic/await receiver binding | Anchor a graph expression to the actual callee before using the current checker. | Direct current-resolver probe; public gain still to verify. Task 2. |
| TS overload attribution | Consume the current checker's selected signature rather than the first declaration. | Current-resolver failure and existing-checker success reproduced. Task 1. |
| Signal receiver vs invocation | Classify an existing occurrence truthfully; distinguish reads from direct calls. | Application defect reproduced in the overlay, including checker-only shared fixes. Task 3. |
| Evidence strength, locations and via | Keep occurrence metadata coherent and select a real confidence witness. | Shared consumer defects reproduced; not specific to a language service. Tasks 3–4. |
| Decorated declaration owners | Join using a verified declaration-name/owner anchor when decorator uses precede the graph class span. | Overlay reproduced a loss and recovery; the general no-service path requires its own regression. Task 2. |
| Aliases, extends, project scope and declaration inputs | Supply the existing checker with the governing context and explicit coverage. | Context-dependent recovery demonstrated; safe multi-project ownership remains unresolved. Task 5. |
| Injected-field calls in initializers | Distinguish an eligible direct use from a real escape/mutation before filtering all uses of the field. | Rejection predicate identified; safe widening not proved. Task 6. |
| Missing reads or other occurrences | Determine whether the graph omitted a site, a gate rejected it or a join lost it before proposing new reference acquisition. | A new LS reference is not proof that the current graph contains a usable row. Task 7; no blind transplant of the LS-specific polymorphic-this filter fix. |
| Angular own-member, alias and lexical template bindings | Investigate bounded reuse of the installed Angular compiler AST and metadata, with exact scope/owner and local-shadow checks. | LS/native trials demonstrate the dependency, not an LS-free implementation. Task 7; no new binder promised. |
| Angular conditional standalone imports | Investigate existing source readers for source-proven constant-array/conditional forms without executing expressions. | Internal/service-backed gain observed; production evaluator support not established. Task 7. |
| Java receiver/token coordinate mismatch | Normalize an invocation to its method-token span using the installed Java syntax parser. | Mismatch observed. Exact Java target/overload resolution does not follow from a token span alone. Task 7. |
| Java generic/overload targets and method references | Require actual target evidence; do not build a speculative Java type checker from argument spelling. | JDT gains exist, but no equivalent existing-engine solution was demonstrated. Keep as migration-reassessment input. |
| Missing member/declaration nodes and route identity | Assess whether the existing reader can faithfully represent the declaration/entrypoint before adding facts. | Native member seeds improved, but the route-to-variable change failed equivalence. Architecture/contract gate in Task 7. |
| Unavailable context, generated/virtual inputs and failed providers | Report the actual missing evidence; a globally complete empty answer or unrelated generic cut is insufficient. | Trial limitations are established; not every experimental failure exists in current production. Audit the applicable current boundary in Tasks 5 and 7. |
| Outgoing hierarchy, implementations and navigation | Check whether a consequential public dependency is actually missing before using a new API. | Mostly auxiliary API evidence, not independent public gains. No implementation task justified yet. |
| Repeated service startup and native-reader caching | Relevant only if adopting a provider; preserve current index reuse now. | A cost of the experimental replacement, not a demonstrated defect of the current engine. See the separate reassessment plan. |

The Angular evidence is in the [member-binding report](../../../../ye-ast_test/evaluations/runs/20261104T200224Z-angular-integration-spike/experiment/execution-v3/report.md) and [class/scope report](../../../../ye-ast_test/evaluations/runs/20261104T200224Z-angular-integration-spike/experiment/execution-v2/report.md). Java's [discriminatory-controls report](../../../../ye-ast_test/evaluations/runs/20261104T204116Z-java-semantic-integration/experiment/execution-v3/report.md) separates positive semantic evidence from the retained graph edge. These complement the TS and combined evidence above; none establishes all possible no-new-provider fixes.

## Global constraints

- Read AGENTS.md, the project testing skill and relevant ADRs [0004](../../architecture/adr/0004-codegraph-dependency-with-own-fact-layer.md), [0008](../../architecture/adr/0008-typescript-compiler-api-source.md), [0013](../../architecture/adr/0013-coverage-grows-only-with-evidence.md), [0014](../../architecture/adr/0014-angular-and-spring-from-own-extractors.md), [0017](../../architecture/adr/0017-owner-of-a-member-expands-only-whole-type-edges.md), [0018](../../architecture/adr/0018-type-information-as-a-fact-input.md), [0019](../../architecture/adr/0019-cuts-retired-on-a-proven-external-target.md).
- Use the current compiler only when the host already supplies the required type inputs. No default Program activation or new process.
- Compiler/AST objects stay in TypeScript adapters. Application joins evidence; domain decides cuts. Reuse existing readers and normalizers before introducing a helper.
- Graph lines are 1-based; characterized pinned graph columns are 0-based UTF-16. Existing source-port coordinates are 1-based UTF-16. Full occurrence identity also includes source, name and kind.
- No line-only/name-only settlement, first-match configuration selection, first-declaration overload choice or inferred unique runtime dispatch.
- Each semantic work unit advances the existing EDGE_POLICY proof version/producer identity as necessary; do not change the dependency version, fabricate a new store schema, or reuse cached facts under unchanged identity.
- Run the smallest relevant tests, observed RED/GREEN and break proof. Finish each integrated code unit with `npm run check` and `git diff --check`. Commit only if separately requested.

## Review focus

1. Same-line, same-point and Unicode occurrences must remain distinct (Task 2).
2. Unavailable, invalid or ambiguous signatures must not select an arbitrary overload (Task 1).
3. A strong reference must not lend its confidence/location to a weaker call; actual calls still count toward fan-in (Task 3).
4. Confidence provenance must terminate at a real seed even with cycles, competing paths and budget stops (Task 4).
5. Conflicting project owners and mutable/escaped/substituted injected receivers must remain unknown; syntax-only evidence cannot substitute for a missing semantic target (Tasks 5–7).

## Execution order and ownership

Execute baseline preparation, Tasks 1–4, then the public comparison. Evaluate Tasks 5–7 separately only after their gates. Shared `inbound-edges.ts`, `walk.ts`, ports and composition have one owner at a time; do not parallelize their edits. Tests and docs travel with their behavior. Do not cherry-pick whole experimental branches.

### Baseline preparation: freeze the actual old-engine contract

**Files:** Read current sources/tests and earlier plans; evaluation artifacts go to a new run under the sibling corpus, not production source.

- [x] Record HEAD, tracked/untracked source diffs, lock/tool hashes, trust/scope and supplied declarations. Run the baseline `npm run check`; record the actual result rather than inheriting an experiment's test count.
- [x] Reuse the evaluation skill to discover real stdio schemas and freeze a source-authored workload before patching. Include the diagnostic's generic/await and overload cases, signal category, competing evidence paths, decorated owners, real source-backed callers and entrypoints, and a budget-boundary negative.
- [x] Verify exact seeds independently for each range; a line selecting different declarations invalidates a caller comparison. Create an immutable baseline execution export with isolated state.
- [x] Confirm earlier identity fixes in source and tests; mark only genuinely missing rules for new tests. Save the resulting scope ledger.

### Task 1: Resolve the selected call signature

**Files:** Modify `src/core/adapters/typescript/type-resolution.adapter.ts`; test `src/core/adapters/typescript/type-resolution.adapter.test.ts`. Add one consumer wiring regression in `src/core/application/impact/impact-queries.test.ts` only if the adapter contract change affects its wiring.

**Interface:** Keep `createTypeResolution(request, deps): TypeResolution` and ordered `resolve(sites): readonly Finding<ResolvedTarget>[]`. Refine internal `resolveSite(checker, program, site)` / `declarationOf`; no LanguageService API or public schema.

- [x] Add named regression `a typed numeric call resolves its numeric overload rather than the first declaration`: text and numeric signatures are on different lines; assert the repository target is the numeric declaration. This must fail because current `getDeclarations()?.[0]` returns the text signature.
- [x] Add the opposite signature and an unsupported/erroneous invocation rule. A compiler recovery signature is not sufficient proof: require a uniquely located invocation, a signature declaration belonging to the bound callee, and no error affecting that invocation's argument/signature selection. For overloaded calls, unresolved, any/unknown or competing union arguments do not establish unique signature attribution; assert unknown for those controls. Do not reject an otherwise proven invocation solely for an unrelated diagnostic elsewhere. Non-call references retain their separate declaration policy.
- [x] Run `node --import tsx --test src/core/adapters/typescript/type-resolution.adapter.test.ts`; preserve the intended failure.
- [x] Use the existing checker's `getResolvedSignature` for the verified invocation. Reuse existing alias and repository/external target conversion. Do not select the implementation or first overload as a fallback when call evidence is insufficient.
- [x] Run GREEN, then restore a type-correct first-declaration choice as break proof; the numeric regression must fail. Restore the patch and run the integrated checks.

**Acceptance:** Exact static signature, stable coordinates/evidence and unchanged external-target safety. No claim about unique runtime dispatch or all untyped overloads.

### Task 2: Match an expression occurrence to its callee token

**Files:** Modify `src/core/adapters/typescript/type-resolution.adapter.ts`, `import-origins.adapter.ts`, `src/core/domain/relations/resolved-reference.ts` and `src/core/application/impact/impact-queries.ts` only as required to carry the exact spelling/kind. Tests in the matching files. If sharing is necessary, create only `src/core/adapters/typescript/reference-occurrence.ts` and its focused test.

**Interface:** Preserve existing required `ReferenceSite` fields. Add optional `fullName?: string` and `kind?: string` if absent, supplied from the original graph row. A shared adapter-only `findReferenceOccurrence(source: ts.SourceFile, site: ReferenceSite): ts.Node | undefined` returns the unique verified name node, never an AST through a core port. Legacy callers without full metadata retain conservative exact-name behavior.

- [x] Characterize actual raw pinned graph rows for a generic receiver, an awaited receiver, nested calls at the same point, and two calls on one line. Do not infer spelling or coordinate conventions from the hand-authored diagnostic.
- [x] Add the generic-receiver regression: the existing Program can resolve the method at its name token; the pipeline must find that token from the correct raw occurrence without widening to a neighboring call. Assert a real caller and its precise settlement through the public query family.
- [x] Pin wrong/stale/out-of-range positions, Unicode prefixes, duplicate full tuples, same coordinate/different nested names and homonymous receivers. Unsupported syntax or nonunique expression matches produce unknown and retain the relevant cut.
- [x] Run focused adapter/import/query tests RED. Reuse `checkSites`, `syntaxName`, existing expression normalization and exact-key machinery. Match the anchored expression, spelling and role before selecting its name; never search the line for the first matching identifier.
- [x] Keep raw coordinates in reference keys, normalize once at the existing boundary, and preserve `from`/kind/name. Both the syntax-valid-occurrence gate and checker lookup must admit the same uniquely proven occurrence.
- [x] Add a decorated-class regression in which the use precedes the graph's class start. Verify the declaration-name anchor and exact owning class before joining; missing or competing owners remain unknown. Do not shift a location into an arbitrary enclosing symbol to force the join.
- [x] GREEN and break proof: bypass the callee mapping or weaken the unique match; the positive or ambiguity regression must fail. Verify target expansion/source reach before retiring a cut; keep depth/hub/expansion-stop negatives.

**Acceptance:** Source-proven new callers/cut settlements for this mechanism. No global scanner, new compiler program, new inferred reference population or Java binder.

### Task 3: Keep occurrence category and confidence together

**Files:** Modify `src/core/application/impact/inbound-edges.ts`, its test and `impact-queries.test.ts`; `walk.ts` only for the existing fan-in consumer.

**Interface:** Keep `InboundEdges.callersOf`. Add optional internal `InboundEdge.hasCall?: boolean` only if needed to retain call counting independently of the selected evidence. Old producers default to `basis === "call"`. No new public field.

- [x] Public-query regression `an own-field member invocation references the field without calling the field`: `this.signal()` is a call; `this.signal.update(...)` is a reference to the field. Use real distinct source occurrences. A `.value` read is a reference when the existing path supplies one; do not invent missing graph occurrences.
- [x] Regression `strongest evidence keeps its own basis and locations`: merge a weaker call and stronger reference from one source. Assert the stronger reference's confidence, basis and locations remain together and the real call still contributes to fan-in.
- [x] Run focused inbound/query tests RED. Fix `ownUsesOf` using exact rooted reference shape and verified syntax where spelling is insufficient; do not relabel unrelated direct method calls.
- [x] Fix `strongestPerSymbol` to choose one evidence record coherently. Preserve other observed-call existence for fan-in without assigning its call category the reference's confidence. Equal-strength ties use stable source ordering and preserve distinct occurrence evidence internally.
- [x] GREEN and separate break proofs for classification and evidence merge. Check depth/hub behavior so changing the selected basis does not accidentally bypass a call-count bound.

**Acceptance:** Truthful category/provenance with stable dependency reach unless a separately source-proven error is removed. Copy only applicable rules from the TS v4 experiment; not its provider/mode flags.

### Task 4: Make reported via justify the reported confidence

**Files:** Modify `src/core/application/impact/walk.ts`, `walk.test.ts` and one meaningful `impact-queries.test.ts` consumer regression.

**Interface:** Preserve public reached-symbol fields and shortest-depth semantics. Extend the existing internal `widestPaths(seedRecs, links)` computation to retain a coherent predecessor witness alongside its confidence; no alternate experimental traversal.

- [x] Regression `via follows the path that determines confidence`: a later stronger path must replace the first weaker provenance. Assert exact predecessor/evidence and confidence through the query result.
- [x] Guard multiple seeds, equal-confidence deterministic ties, a cycle, owner/dispatch zero-depth bridges and a budget stop. Each selected predecessor chain must end at a real seed; do not invent a path for an unexpanded edge.
- [x] Run walk/query tests RED. Reuse admitted links and widest-path relaxation. Preserve shortest depth and all reaching seeds as separate facts; do not claim they are necessarily the selected confidence witness.
- [x] GREEN and break proof by retaining first-reaching `via`. Reconcile changed entrypoint seed/origin associations independently against source paths, not merely endpoint membership.
- [x] Advance the existing policy identity for this output-semantic change; run integrated checks.

**Acceptance:** Confidence, selected via and source evidence agree. Full source-path reconciliation is required for changed public claims; unproved associations cannot be promoted as improvements.

### Task 5: Design gate for effective project context

**Files to inspect:** `src/core/adapters/typescript/module-resolver.ts`, `type-resolution.adapter.ts`, `src/core/ports/type-resolution.port.ts`, `src/composition/compose.ts`, and `type-resolution-cache.ts`. Corresponding tests own any later approved behavior.

**Status:** Design-gated, not a ready instruction to add automatic project selection.

- [x] Reproduce the root-config/alias failure with an owned source fixture containing a declared extends/reference chain and two conflicting project aliases. First demonstrate what `declaredOptionsOf` and existing `TypeResolutionRequest.options` already support.
- [x] Document the smallest typed host-declared single-project input versus a snapshot-owned multiple-project map. Specify exact file ownership, transitive source/declaration coverage, overlap/conflict outcomes, input content identity, lifetime and cache invalidation. Keep compiler options inside the adapter; do not put TS types in core ports.
- [ ] Obtain the owner's architecture decision before implementing that choice or changing ADR-0018's defaults. Do not silently apply a child project's options to the entire repository.
- [ ] After approval, add consumer tests for exact ownership, missing/ambiguous config, conflicting aliases, an out-of-project caller and configuration-only changes. Unavailable coverage cannot become a globally complete empty result.
- [ ] Reuse the current config parser/confined source reader and explicit dependency declarations. No new server, automatic dependency install, target build or Program when type inputs are absent. Measure additional Program/context costs rather than claiming them free.

**Acceptance:** Effective configuration is evidenced input; no whole-workspace claim from a restricted project. Revisit migration only after separating this cause from missing syntax capability.

### Task 6: Evidence gate for injected-field initializer uses

**Files:** `src/core/adapters/typescript/angular-metadata.extractor.ts`, `angular-metadata.adapter.ts`, their tests and `src/core/application/impact/inbound-edges.test.ts` / a composition consumer fixture.

**Status:** A demonstrated rejection mechanism, not yet a proven safe production widening.

- [x] Freeze a public-reader fixture with one authentic injected field used by a direct member call in a field initializer and later in a method. Confirm `readMemberEvidence` marks the field unsafe and filters the later call; identify every downstream guard before changing one.
- [ ] Isolate direct-use classification from reassignment, alias/escape, dynamic access, mutation, inherited/ambiguous members, local injection-name shadows, provider substitution and missing source coverage. Keep those negatives decisive; do not bypass the global safety gates or infer receiver confinement.
- [ ] Only if existing identity/provider/mutation proofs suffice, admit the narrow direct-initializer form through the existing `MemberUseOrigin` channel and unique graph join. A harmless read in another owner must not globally poison a same-spelled field; prove owner identity before narrowing such a gate.
- [x] If safe attribution requires a new heap/provider model or public semantic policy, stop this unit at a documented negative result and return it to the reassessment plan. No ad-hoc special case to make a corpus cut disappear.
- [ ] For an admitted form, observe RED/GREEN, break proof, real exact-occurrence settlement with all negatives retained, and the full check.

**Acceptance:** Reach or cut retirement only under existing proven stability conditions. A retained unknown is a valid outcome; this unit promises no particular corpus reduction.

### Task 7: Validate residual opportunities without new providers

**Status:** Investigation gate, not authorization to implement every service capability in the engine. Its deliverable is a source-backed feasibility ledger, not a new general binder, Java checker or symbol store.

**Existing surfaces to inspect:** `src/core/adapters/angular-compiler/template-usage.adapter.ts`, `src/core/adapters/typescript/angular-metadata.extractor.ts`, `angular-metadata.adapter.ts`, `src/core/ports/template-usage.port.ts`, `src/core/application/relations/angular-relations.ts`, `src/core/adapters/tree-sitter/java-parser.adapter.ts`, `src/core/adapters/spring/java-symbols.ts`, `src/core/adapters/codegraph/codegraph.adapter.ts`, `src/core/domain/change/seeds.ts` and the existing entrypoint join. Verify current consumers before selecting an edit surface.

- [x] For each residual row in the coverage table, record the original source occurrence, source-authored expected fact, current graph row or missing row, applicable syntax/parser evidence, rejecting predicate and public consequence. Reuse frozen service traces as contextual evidence, not as the independent oracle.
- [x] For missing reads, locate the failure first: missing index occurrence, syntax-role filtering, absent target node or join failure. A checker or service succeeding at a hand-supplied token does not prove that the current pipeline asks that question. Do not scan the entire project to recreate `findReferences` without an assessed need and design.
- [x] For Angular, test one direct own-member binding with an unrelated homonym and a shadowing template local using only installed compiler AST/metadata. Separately test a source-proven constant conditional import with an absent-import negative. Read/call/input/output categories and exact owner must stay distinct. Unsupported inheritance, pipes, scope or expression forms remain unknown. Stop at a feasibility result if representing the binding requires a new internal contract or graph member authority; propose that contract for owner review before production edits.
- [x] For Java, characterize exact method-token mapping on a known graph occurrence, including two expressions on one line. Then ask whether the current engine has independent target evidence. A syntax match alone cannot suppress the wrong overload edge, settle a generic target or justify unique runtime dispatch. If target evidence is missing, record a migration candidate rather than write name/type-spelling heuristics.
- [x] For missing declaration nodes and changed route identities, compare the existing fact owner, selected seed and entrypoint contract. Any alternate declaration source needs an explicit one-owner design; no temporary fake graph IDs or route-to-variable substitution as an improvement.
- [x] Produce a ledger with four outcomes: existing-engine repair demonstrated; bounded no-provider experiment proposed; representation/architecture decision required; no justified existing-engine solution. Quantify affected occurrences only after source reconciliation and keep historical snapshots separate. Promote a new implementation unit only with exact file ownership, a failing public-seam rule, negative controls and the owner's decision where architecture changes.

**Acceptance:** Every reported family has a disposition and evidence boundary. This closes a planning-coverage gap; it does not claim that every possible improvement has been discovered or that all service capabilities should be reimplemented.

## Final public MCP comparison and completion

**Artifacts:** New run outside the engine following the existing evaluation skill. Implemented code units and their tests stay together; no commits without an explicit request.

- [x] Freeze one final candidate, original baseline, workload, independent source oracles, supplied declarations/configs and hashes. Preserve earlier trials; never overwrite their outputs.
- [x] Pilot exact same public callers/impact/importers/outline questions at matching snapshots, scopes, trust, budgets and offered type inputs. Use typed contexts only where the original port can consume them and disclose preparation. Do not substitute LanguageService evidence for the old-engine experiment.
- [x] Reconcile complete structured facts and multiplicity: direct/transitive dependencies, exact occurrence, kind, confidence/via, all changed seed/origin/entrypoint associations, costs and cuts. Independently explain every gain/loss used in acceptance. Do not accept a different seed or a missing consumer as an optimization.
- [x] Measure first/preparation and repeated queries plus full process-tree memory separately with a finite predeclared sample plan; uncontrolled OS cache and sample limitations explicit. Include extra AST/Program work rather than moving it outside the clock.
- [x] Require no unexplained loss of a source-proven dependency or real uncertainty; no new false exact attribution, neighboring settlement, unrelated route change or weakened traversal bound. Preserve known unsupported cases as explicit unknowns.
- [x] Run `npm run check`, `git diff --check` and broad searches for changed rules, old identity/merge shortcuts and accidental LS/JDT/provider dependencies. Record observed results and cleanup/input drift.
- [x] Update this plan's checkboxes only from executed evidence. Produce a per-family ledger of correct gains, corrected false positives, safely retired cuts, retained unknowns and measured cost. Feed important residual gaps to the separate migration reassessment plan.

No numerical reduction or latency target is invented here. The implementation is accepted on source-backed correctness and preserved contracts; the owner decides whether measured benefits justify deployment.

## Execution evidence and retained gates

The [bounded execution report](../../../../ye-ast_test/evaluations/runs/20261105T120000Z-current-engine-mechanism-improvements/continuation-v2/report.md), [completion ledger](../../../../ye-ast_test/evaluations/runs/20261105T120000Z-current-engine-mechanism-improvements/continuation-v2/completion-ledger.json), [raw comparison reconciliation](../../../../ye-ast_test/evaluations/runs/20261105T120000Z-current-engine-mechanism-improvements/continuation-v2/full-fact-reconciliation-v4.json) and [lead integration review](../../../../ye-ast_test/evaluations/runs/20261105T120000Z-current-engine-mechanism-improvements/continuation-v2/lead-integration/review.json) record the evidence behind checked items. The final frozen comparison covers 22 questions and 88 matched scored pairs; it does not establish exhaustive corpus coverage. The independent review inspected code and passed 205 focused tests; the lead completed the remaining bounded raw first/warm and source checks. This is not a claim of an exhaustive independent source audit.

Task 5 ends at the [explicit context alternatives](../../../../ye-ast_test/evaluations/runs/20261105T120000Z-current-engine-mechanism-improvements/context-design.md): project ownership still needs the owner's architecture decision. Task 6 ends at a negative safety result: the complete initializer negative matrix and public settlement were not established, so no initializer eligibility is widened. Task 7's [family ledger](../../../../ye-ast_test/evaluations/runs/20261105T120000Z-current-engine-mechanism-improvements/continuation-v2/feasibility-ledger.md) gives bounded dispositions for the reported families; checked investigation items do not imply that every historical occurrence has been audited or every proposed unit implemented. The [template-expression outcome](2026-11-05-analysis-coverage-task-02-template-expressions.md#outcome) refines the Angular own-member row: own-member bindings add no public reach because member containment already reaches the component and its route, so that unit is rejected. The remaining gap is a template use of an injected field's member, reproduced as a `complete` answer missing its caller and route; its contract still needs the owner's decision.

The compiler port now selects supported overload signatures, but existing resolved graph edges bypass that port: the public overload limitation remains. Missing property-read occurrences, Angular member representation and conditional imports, Java semantic target evidence, and alternate declaration authority remain separate assessed work. No LanguageService, Angular LS or JDT is added. Existing route/importer authority, budget stops and unknowns remain.

Before the cleanup pass below, the initial integrated checkout passed `npm run check` with 1,891 tests and zero failures. Tracked and newly added source whitespace checks and local plan link checks passed. That initial integration matched the measured candidate except for a trailing blank line removal in the new helper. Unrelated pre-existing working-tree files were preserved byte for byte. No commit or push had been made at that stage. See the [integration verification log](../../../../ye-ast_test/evaluations/runs/20261105T120000Z-current-engine-mechanism-improvements/continuation-v2/lead-integration/check.log).

## Cleanup and local delivery

The owner subsequently requested the project code-cleanup pass and local integration into `main`. The pass keeps the existing matcher and traversal, removes the obsolete first-reach `Rec.via` state and its parameter, replaces nested evidence selection with explicit branches, narrows optional values without assertions, and formats the new regression fixtures. No new abstraction, provider, dependency or semantic widening is introduced. Tests and correction code form one delivery unit; these evidence plans form a separate documentation unit. Other pending documentation is outside this delivery.

After cleanup, `npm run check` again passed typecheck, architecture checks and all 1,891 tests. The correction and cleanup unit is commit `38b55c8` (`fix(impact): preserve exact occurrence and confidence evidence`). The [cleanup verification log](../../../../ye-ast_test/evaluations/runs/20261105T120000Z-current-engine-mechanism-improvements/continuation-v2/lead-integration/cleanup/check.log) records the fresh gate. Earlier MCP comparisons remain pre-cleanup measurements; they were not rerun or presented as new timing samples. Public behavior is guarded by the existing tests; cleanup adds no new coverage claim.

## Plan-authoring verification

On 2026-11-05, both new plans' local Markdown link targets were checked, whitespace checks passed, and the unchanged production baseline passed typecheck, architecture checks and all 1,875 tests through `npm run check`. The later coverage-inventory clarification was checked for link targets and whitespace; it did not change production code or rerun that suite. These checks validate the documentation handoff and the then-current baseline, not completion of any implementation checkbox. Re-establish the baseline at execution time. No source changes, dependency changes or commits were made for this planning task.
