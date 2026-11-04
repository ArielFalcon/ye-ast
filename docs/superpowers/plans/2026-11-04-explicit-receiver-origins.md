# Explicit Receiver Origins Implementation Plan

> For implementers: apply the project's test-first workflow, one behavior at a time. Do not implement the excluded inference cases.

**Status:** Implemented and integrated with conservative source-evidence limits. The procedural checklist below is the original plan; the implementation record supersedes changed signatures and eligibility semantics.

**Goal:** Consume fixed receiver evidence already available, resolving exact own-instance member uses without attributing them to a homonymous free function.

**Architecture:** The TypeScript adapter reuses its parsed project, declaration lookup and FieldOrigin records to extract a specific member-use proof. The consumer-owned metadata port carries plain domain values. Application joins them to real graph declarations; domain cut policy applies exact candidate exclusions. Neither transport nor composition performs resolution.

**Tech stack:** Existing TypeScript 6 public AST API, declaration lookup, codegraph reader and node:test. No new dependencies or TypeScript Program.

**Spec:** `../specs/2026-11-04-symbol-proof-improvements-design.md` and the identity/bindings plan.

## Observed problem, not a proposed general type resolver

The lead ran `symbol-planning/receiver-probe.mjs` against the public metadata reader and the pinned source bytes. `AuthHintService.store` already has an origin pointing to the cookie StorageStrategy class; `AuthService.authHint` already points to AuthHintService. Recreating their extraction would duplicate existing work.

The saved branch fact reaches a **free function** `write` in `src/app/features/user/pages/user.page.ts:94`, not a class method of that name. Its file-anchored cuts include seven `this.<field>.write` candidate occurrences for which the metadata reader already supplies a field origin. `fieldUsesOf` in `inbound-edges.ts:251-254` returns immediately when the reached target has no class owner. Consequently those existing origins cannot establish that the direct member reference names a different declaration. This is the specific unsupported proof path; it is not evidence that the seven cuts, or seven independent failures, are removable.

Population reconciliation matched all 1,246 final candidate places to the original mapping. Among 730 this/super hints, 537 syntactically resemble signal/resource/viewChild/input factories, seven already have a field origin, twelve contain inject syntax without a fixed origin, 148 are other unproved direct receivers and 26 are other this/super forms. These are **lexical hints**, not semantic diagnoses. They invalidate the assumption that a generic fixed-field extension will solve most of this population.

Read: `angular-metadata.extractor.ts:181-198`, `angular-metadata.adapter.ts:197-220`, `inbound-edges.ts:245-275`, `impact-queries.ts:537-564`, and `symbol-planning/receiver-evidence.json` / `receiver-population.json`. The real storage slot also has build-time replacements: the proof concerns the source snapshot, not every deployment profile.

## Scope and constraints

- Start with direct calls `this.field.member()` where the existing field origin names a repository class and its own concrete, non-static method can be identified unambiguously. Do not infer a runtime class from a type annotation alone.
- Support named imports, renamed imports and barrels using existing `createDeclarationLookup`; reject ambiguous exports, missing source and cycles as it already does.
- Keep inherited-only methods, arbitrary parameter receivers, factory return values, signals, getters, external members lacking declarations, computed members, optional calls and mutable/escaped receiver situations unknown.
- Do not widen existing provider substitution or mutation refusals. Newly emitted member proofs require an unmodified receiver and member under the admitted source syntax; unknown writes mean no proof.
- Module consumers do not become symbol seeds or entrypoints. A contrary-target proof excludes only one declaration/reference pair; it is not global knowledge that the reference has no effect.
- Scope, skipped sources and parse failures cannot produce absence proofs. A missing target method or graph join retains the cut.

## Shared interface for B and C

Create `src/core/domain/relations/member-use.ts`:

```ts
import type { SymbolRef } from './relation.ts';
import type { ReferenceSite } from './resolved-reference.ts';
export interface MemberUseOrigin {
  owner: SymbolRef;
  receiver: SymbolRef;
  member: SymbolRef;
  reference: ReferenceSite & { name: string; kind: 'calls' };
}
```

`reference.column` is the existing 1-based UTF-16 source coordinate. The raw graph column stays 0-based UTF-16; convert `raw.column + 1` only when matching to this source proof. `name` is the full admitted reference spelling (`this.store.write`), not the root or tail alone. `owner` is the enclosing class/top-level declaration used for containment; `receiver` is the actual source class, `member` its exact implementation declaration. No AST or graph node id crosses this port.

Define `MemberProofContext { completeSource: boolean }` in the same domain file. Add optional `memberUses?: readonly MemberUseOrigin[]` to AngularMetadata and RelationExtractor's result. Add optional second options argument `{ memberProofs?: MemberProofContext }` to both `AngularMetadataReader.read` and `RelationExtractor.extract`; absent/false context disables new member-use proofs. With an explicitly supplied context the native reader returns `memberUses: []` when it cannot prove a use, preventing legacy settlement fallback; a reader that omits the channel retains compatibility. Add optional argument 8 `memberUses?: readonly MemberUseOrigin[]` to `createInboundEdges`; forward it through ImpactQueries WalkInput. C later uses the same channel; no second port or generic value-flow framework.

## Review focus

Wrong member/static/inherited/overload joins; two references sharing a line; writes or unknown aliases; source class proved but graph declaration missing; accidentally turning an exclusion into a call edge or reaching a co-located declaration. Each is pinned below.

## Task 1: Reproduce the fixed-origin/free-function gap

**Files:** `src/core/application/impact/inbound-edges.test.ts`, `src/core/domain/impact/impact-cuts.test.ts`, and the composition regression added in Task 3.

- [ ] Add fixture with free function `write`, a different class's own `write` method, a fixed field holding that class, and unresolved `this.store.write` in a caller. With the free function reached, assert no edge to it is invented and its candidate can retire only with the exact contrary-target proof. Without that proof, assert the file cut remains. Current early owner return fails the positive test.
- [ ] Add exact-reference negatives: another receiver on the same line remains a cut; an absent/ambiguous graph member join, missing caller, foreign owner, static-only member, inherited-only method and duplicate overload location produce no exclusion.
- [ ] Run `node --import tsx --test src/core/application/impact/inbound-edges.test.ts src/core/domain/impact/impact-cuts.test.ts`, record the intended red behavior. Do not weaken expectations to fit line-only identities.

## Task 2: Read own-instance member use evidence once per parsed source

**Files:** create `src/core/domain/relations/member-use.ts`; modify `angular-metadata.extractor.ts`, `angular-metadata.adapter.ts`, `angular-metadata.port.ts`, `application/relations/relation-extractor.ts`, `angular-relations.ts`; tests alongside both TypeScript metadata files and Angular relation orchestration.

**Internal syntax interfaces:** add `RawInstanceMethod { className: string; name: string; line: number }` for a unique non-static MethodDeclaration with an implementation body, and `RawFieldCall { owner: {name:string;line:number}; field:string; member:string; line:number; column:number }` for the supported direct call. Add optional raw lists to RawAngularFile; do not retain the whole AST beyond the existing parse cache lifecycle. Extract line/column using `getLineAndCharacterOfPosition(call.getStart(sf))`, adding one to both source coordinates.

- [ ] Add reader tests `fixed_field_own_member_produces_exact_use`, `renamed_barrel_target_preserves_declaration`, `free_function_homonym_is_not_member_target`, `reassigned_or_computed_write_refuses_use`, `nested_regular_function_this_refuses_use`, `arrow_in_method_preserves_this`, `static_getter_inherited_or_overload_ambiguity_refuses_use`, `missing_or_malformed_target_keeps_unknown`. Verify the raw member's owner and implementation line, not just its name. These fail because no member-use output exists today.
- [ ] Implement the shared conservative eligibility gate before emitting new member proofs: application helper `memberProofContext(tree: CommitExtraction, scope: DeclaredScope): MemberProofContext` returns true only when include/exclude are empty, no export budget stopped the tree, no entry was skipped, and every listed eligible non-test TypeScript source is written and has source bytes. Forward options through AngularRelations unchanged. The reader additionally withholds new proofs for parse errors, unresolved project ownership and known/unsupported provider substitutions affecting the target. This is coverage of declared source relationships, not a guarantee about runtime overrides from unavailable code. Add `scoped_or_omitted_source_disables_member_uses`, `legacy_options_absent_preserve_old_metadata`, `parse_error_cannot_authorize_member_use` and a cancellation test at the application await boundary.
- [ ] During the existing public AST visit, collect only explicit instance methods and supported direct field calls. Reject parse diagnostics; verify receiver lexical this belongs to the class (arrows preserve it; a nested ordinary function does not). Do not build a binder/checker or interpret arbitrary expressions. Detect direct/compound/destructured/computed writes affecting the admitted receiver/member; if syntax does not establish stability, withhold the new proof. Keep current FieldOrigin extraction; do not relax any refusal.
- [ ] In the adapter's existing readProject scope, match each call to a unique existing fixed field, use the existing alias/barrel resolution, and find the class's own non-static method body by its source metadata. More than one eligible declaration, provider substitution, member reassignment or missing bytes means no proof. Before using an imported constructor/token or namespace, refuse it if a same-spelled non-import declaration anywhere in the source can shadow that root, reusing the conservative public-AST name inventory already used by ImportOrigins. A local class is eligible only when it is the unique top-level class binding with that name and no conflicting local declaration. Do not assume A implements a general binder: its callback proof is narrower. Add `constructor_or_token_shadow_refuses_member_use` and `nested_class_with_outer_shadow_refuses_member_use`. Preserve the existing provider refusal; do not extend globals or infer from an unbound constructor spelling. Memoize member declarations by class identity and batch uses; no per-target reparse. Emit `MemberUseOrigin` with actual source coordinates and spans represented by SymbolRef. Do not claim external class members through this path.
- [ ] Forward optional memberUses unchanged through AngularRelations. Legacy injected metadata readers with no property behave exactly as before. Run focused metadata/relations tests, then typecheck and architecture checks; expected green.

## Task 3: Integrate exact graph joins and candidate-specific exclusions

**Files:** `inbound-edges.ts`, `impact-queries.ts`, their tests and `src/composition/impact.e2e.test.ts`.

**Interfaces:** `createInboundEdges(reader,isTestFile,relations,fields=[],settled=[],locals=[],memberUses=[])`. Build a per-snapshot map of admissible member uses keyed by target member file/name/span, plus exact reference identity from A. Reuse GraphSymbol lookups and incoming contains edges. Do not add a database edge or mutate the stored graph.

- [ ] Join `receiver` to one class symbol, `member` to one non-static implementation symbol represented by the adapter proof, and verify actual containment in that class. Join reference.from to a source symbol inside the proved source owner and at the exact admitted call location. A successful source-name match without a graph join is insufficient.
- [ ] For the actual target when reached, add a normal call InboundEdge from the actual reference.from. For a different reached homonym, use A's `declarationUseKey(anchor, referenceKey)` as a **candidate-specific exclusion**, without adding a call to that homonym. A member that was not reached must not be reported expanded; the proof only removes the wrong direct attribution. Keep inheritance/dispatch and ownerThroughMember policies unchanged. A missing own-member proof does not authorize a negative inference from class names alone.
- [ ] Use those exact exclusions in unresolvedLinkCuts; do not place a contrary-target proof into the global external/settled-known set. Removed-declaration expansion is out of this slice; do not silently reuse the proof there without a separate regression and policy decision.
- [ ] Add composition fixture: changed free function `write` leaves other fixed own-instance `write` uses out of its impact; changed actual instance method reaches its real caller; another same-line unproved receiver remains partial. Compare seeds, real internal callers, entrypoints and provenance, not cut counts alone. Add bounded-walk and missing-source fixtures.
- [ ] Run focused metadata, AngularRelations, inbound, impact query and composition tests, then `npm run check`. Run the pinned MCP branch case with the same revisions and report every value/cut change. No reduction target is assumed. Only then consider small new receiver syntaxes.

## Cost, invalidation and next scope

Reuse one TypeScript parse per file and source-class member summaries. New work is AST-linear plus indexed exact graph joins; no scan of all origins per walked symbol should be added. Build proof indexes once per query, reuse existing per-file graph caches, and preserve cancellation checkpoints between awaits. Do not add mutable caches across snapshots.

The graph storage and public Fact shapes need no change. Internal metadata additions are optional for embeddings; producer/proof semantics must invalidate any persisted result cache through the actual existing version boundary. No index staging change is necessary unless implementation changes graph input staging; if it does, update STAGING_RULES_VERSION and its source-digest test deliberately. Resource/type-root inputs are unchanged.

Constructor-body `this.field = new KnownClass()` and `const local = new KnownClass()` are genuine currently unsupported patterns reproduced in receiver-evidence.json, but they are **not included in this first repair**. They need a separate stability/scope proof and a measured affected population. `this.impl = new Supercluster(...)` and `db.table(...)` examples need external member/return evidence and are not justified by a field annotation alone. Signals are a large separate family; this plan does not solve them accidentally.

**Concrete derived-fact invalidation:** increment `EDGE_POLICY.referenceProofVersion` to 2. Composition already hashes EDGE_POLICY into the impact producer version. Keep repeated identical requests deterministic and compare producer identity to the previous work-unit baseline. Do not add a second cache namespace or alter graph database schemas.

## Integrated implementation record (2026-11-04)

- A supplies the canonical occurrence key and validated-occurrence argument 7 of `createInboundEdges`; the optional member channel is argument 8. An absent channel differs from an empty one. Native reads with an explicitly supplied incomplete context return an empty channel, authorizing no settlement.
- B and C share `MemberUseOrigin`, source stability checks, target lookup, graph joins and the domain proof index. No second resolver, dependency, transport rule or graph schema was added. Field-origin edges remain potential paths but cannot settle references under the native channel. Legacy local bridges are replaced by the same exact evidence for supported, unambiguous constant locals.
- Review regressions cover derived-field replacement, observable mutation, reassigned/shadowed/escaped locals, ambiguous occurrences, wrong source spans and same-line unresolved neighbors. Real CLI fixtures verify fixed fields, inline injection and constant locals; incomplete source and unsupported forms retain cuts.
- Full integrated verification and the pinned-application result are recorded in `docs/explainer/audits/2026-11-04-name-webapp-cuts/symbol-implementation/integrated-result.md`. The audit is local evidence, not a claim that all pending symbols are resolved.
- Proof version 3 invalidates derived facts. Whole-file shadow guards and project-wide mutation/provider refusals intentionally retain some valid cuts. This implementation does not infer arbitrary factory results, signal/resource receivers, runtime overrides or external type providers.

Observed pinned-application result after integration: branch cuts 271 to 300 against the A+B baseline before final settlement-authority corrections; symbols 1,514 to 1,511, with 41 entrypoints and 761 seeds retained. `merchantExistsGuard`, `menuExistsGuard` and their routes consumer lose the former local-call inference while their unresolved calls remain cuts. The selected lifecycle inline call remains unproved. These capabilities have positive CLI coverage, but no demonstrated cut reduction on this application.
