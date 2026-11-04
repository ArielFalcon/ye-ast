# Symbol proof improvements: evidence and proposed design

**Status:** Proposed, 2026-11-04. Analysis and implementation plans only; production code is unchanged by this work.

## Request and numbering

The requested three blocks are the final proposed batch: **A**, minimal reference identity/diagnostics plus lexical binding/homonym attribution; **B**, receivers with explicit origins; **C**, one concrete inline DI member-use extension. This maps to the earlier five-point discussion without treating its general type/value-flow ambitions as authorized scope. GeoJSON's declaration-input contract is not being implemented in this batch, and no GeoJSON agent remains active.

The user requires robust solutions adapted to hexagonal/DDD boundaries, existing standards and mechanisms, with justified plans for implementer agents. No new dependencies, runtime execution of repository code, general-purpose binder/flow engine, automatic installed type-root reading, dependency upgrades, commits, or main-checkout changes.

## Observed baseline and evidence

Last verified code gate: 1,628 passing tests plus TypeScript and dependency-cruiser. Pinned application: name-webapp, base `40371fa0db38f33fbd42df5ee6b6737c229174b0`, head `e86996535a3e591b1b14592d7479f5ef21c7b9b1`. The last MCP branch fact has 253 cut records, of which 225 are symbol/declaration cuts. Those 225 contain 1,246 candidate-place occurrences. They were reconciled exactly against **all** original mapping rows by `(anchor, raw place)`; a single row per anchor is insufficient. Their lexical families are hints, not semantic root-cause counts or projected reductions.

The first broad planning delegation returned partial without documents. A narrower identity delegation delivered A; the lead completed public-port probes and the remaining plans, and corrected A's provisional coordinate and repeated-point assumptions based on those probes.

### A: reference identity is actually lost downstream of the graph

`GraphUnresolvedReference` already contains from, name, kind, line and column (`code-graph.port.ts:76`). `UnresolvedUse` and keys in `impact-cuts.ts` lose occurrence detail. `proofsOf` deduplicates root requests by file/line/name; inbound field/local settlement keys are anchor/line. Those are concrete points where evidence may be applied to a neighboring occurrence.

A real codegraph fixture characterized the pinned dependency, including Unicode: graph lines are 1-based and columns are **0-based UTF-16**, not UTF-8 bytes. A call after `é😀` was column 20; its UTF-8 prefix was 23 bytes. Two calls on the same line were columns 20 and 31. `inject(Svc).hit()` emitted `inject` and `inject().hit` at the same point, so equal coordinates do NOT establish equal occurrences.

The existing TypeResolution port documents 1-based coordinates and subtracts one in its adapter; `settledReferences` currently forwards the raw graph column without adding one. Correct that boundary as part of A, without changing the port's contract or activating the checker by default. Preserve raw coordinates in exact graph occurrence keys. Do not implement the initial blanket refusal of all same-point rows: distinguish names/kinds and uniquely matched AST expressions; withhold only ambiguous exact matches.

### B: reuse fixed receiver information instead of rebuilding it

The public metadata probe on pinned sources returned a correct FieldOrigin for `AuthHintService.store` through its alias/barrel chain to the cookie StorageStrategy class, and origins for AuthService.authHint. Those uses still appear among file-anchored candidates.

The reached `write` in the saved fact is a **free function** in `features/user/pages/user.page.ts:94`. `fieldUsesOf` returns immediately for reached targets with no class owner (`inbound-edges.ts:251-254`). Thus current fixed-origin information cannot prove a direct `this.store.write` reference is a different own-instance method. The solution is a precise contrary-target proof after source-member and graph joins, not inventing a call to the free function or assuming every member of a known object is safe.

The population probe further narrows expected ROI: of 730 this/super occurrences, seven direct receivers already have field evidence; 537 syntactically involve signal/resource/viewChild/input factories, twelve inject-containing initializers lack fixed evidence, 148 are other unproved direct origins and 26 other this/super forms. This is not a promise of seven fixes. It shows that the original broad receiver label mixed different semantic problems; fixing ordinary fields does not solve signals.

Controlled public-reader fixtures verified existing field `new Svc()` and local inject support, and absence of support for constructor-body assignment and local `new`. B initially repairs consumption of the existing fixed-source class proof. New constructor/value-flow syntax is deferred until its own affected population and stability proof are established.

### C: inline injection class relation is not a method-use edge

The pinned `provideAuthLifecycle` already produces an injection relation to AuthLifecycleService, but no local origin for its inline `.start()` call. A controlled metadata/inbound fixture reaches the caller through `const svc=inject(Svc); svc.hit()`, but not through `inject(Svc).hit()`. This is an observed missing bridge rather than missing Angular detection.

A negative fixture revealed an existing weakness: a parameter locally named inject still produced an Angular relation because coreName checks import spelling without resolving shadows. New inline proof must fix/guard this boundary first. Use the public AST and a conservative existing-style local declaration refusal, not private compiler binders. Imported/namespace aliases and local paths overrides must be tested. Substitutions keep their existing refusal. No arbitrary factory/return inference or provider simulator is proposed.

## Shared architecture and contracts

- **TypeScript adapter:** public AST node predicates/positions, existing project ownership, module resolver and declaration lookup. It emits syntax-backed lexical or exact member evidence. No AST escapes through a port; no Program is built for this batch.
- **Domain:** exact reference keys, candidate-specific exclusions and pure value contracts; no Node imports, parser, file reads or framework names. An excluded homonym is not a globally resolved reference or a reached target.
- **Application:** receives immutable bytes and coverage, asks ports, matches proof occurrences and declarations to real graph nodes, and forwards admissible edges to the unchanged walk. Failure to join retains uncertainty. Only actually reached dependencies count as expanded.
- **Composition/MCP:** wire and render; no inference rules or suppression lists.

A defines domain raw occurrence identity with optional `column?:number` / `from?:string` on consumer UnresolvedUse. Missing legacy coordinates are unknown; graph columns retain their actual zero base. Normalize to the existing one-based source-site contracts at call boundaries. Fact rendering remains line-based; internal evaluation must happen before aggregation.

B introduces one shared `MemberUseOrigin` value (owner, receiver class, actual member, exact source call site) and an optional `memberUses` list in existing metadata/relation results. C reuses it. Both share optional `MemberProofContext {completeSource:boolean}` read options; legacy/default calls disable NEW member proofs while preserving existing fields/locals. Application authorizes them only for a full declared source input with no missing/skipped/budget-stopped relevant content, and the reader still refuses parse/project/provider ambiguity. This is the smallest coverage extension needed for the new negative proofs; it does not claim knowledge of arbitrary runtime overrides or unavailable external provider registrations.

## Decisions and rejected approaches

| Decision | Why | Rejected alternative |
|---|---|---|
| Preserve and match exact occurrences | Same-line and nested calls are observed; neighboring proofs must not leak | Tail names, line keys, or blanket equal-point identity |
| Reuse public compiler syntax APIs | Pinned existing dependency and supported AST structure; no custom grammar | Regex-based lexical resolution or private TypeScript binder APIs |
| Prove only a supported local parameter binding | Can rule out direct attribution without inventing callback execution targets | Whole-program callback/value-flow inference |
| Share one exact member-use contract for B/C | Existing origins and declaration lookup provide most inputs | Separate general receiver engine and separate DI result evaluator |
| Require a real source member and graph join | Known class name alone does not establish its member | Treating type annotation or external constructor spelling as an exact runtime target |
| Keep incomplete inputs conservative | Previous GeoJSON investigation showed missing bytes are not absence | Lockfile/name-only suppression and hidden installed dependency inputs |

The existing impact producer version already includes the EDGE_POLICY digest (`compose.ts:179`). Add one `referenceProofVersion` field to that policy (1 for A,2 for B,3 for C) so these semantic changes invalidate derived facts through an existing mechanism. Do not create another cache namespace, runtime flag, graph migration or dependency-version change.

## Implementation order and readiness

1. **A1:** exact identity plus characterized coordinate normalization. **A2:** supported local callback-parameter exclusions. Ready to implement with the documented regressions; no unverified coordinate-base decision remains for the pinned TypeScript/codegraph fixture.
2. **B:** shared member-use/context contracts and the fixed-origin/free-function bridge. Ready as a bounded repair with explicit source-stability and unique-member guards. Do not generalize to all annotated receivers.
3. **C:** fix actual Angular binding proof, then use the shared contract for direct inline class injection. Ready for the admitted own-member cases after A/B; unknown providers/inherited members remain excluded.

Implement shared contracts sequentially, then use disjoint ownership for coherent behavior units with their tests and docs. Lead integrates shared files and reviews observed diffs; no artificial code/test/doc worker split. Do not create workers for all broad families at once.

## Verification and cost contract

The three plans specify exact test names, fixtures, interfaces, commands and negative cases. Correctness means preserving genuine uncertainty while proving real connections or excluding only unrelated direct candidates. A cut reduction alone is not an acceptance criterion. Newly reached symbols need exact caller/target evidence and existing provenance/bounds; peers must stay unreached.

Use one file parse per proof batch, existing per-project parse/resolution caches, source-class member summaries, and per-query exact-use indexes. No cross-snapshot mutable AST cache, repeated per-origin parse, full Program activation, extra dependency root or arbitrary provider execution. Measure extraction and graph-join phases plus end-to-end request cost on the same pinned workload when implementing; this design makes no numerical latency or cut-reduction promise.

Current investigation ran public metadata/inbound fixtures, a real codegraph coordinate fixture and a pinned-source population reconciliation. It did not run a new full suite/build or change production behavior. Actual commands and outputs are retained under `docs/explainer/audits/2026-11-04-name-webapp-cuts/symbol-planning/`.

## Deliverables

- `../plans/2026-11-04-reference-identity-and-bindings.md`
- `../plans/2026-11-04-explicit-receiver-origins.md`
- `../plans/2026-11-04-inline-di-resolution.md`

No unresolved product choice is needed for these narrow slices. Broader DI provider interpretation, signals, external declarations and general value flow require separate designs, not speculative tasks in these plans.
