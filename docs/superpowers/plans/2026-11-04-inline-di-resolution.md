# Inline DI Member Resolution Implementation Plan

> For implementers: apply the project's test-first workflow; checkboxes are pending. Reuse the completed identity and MemberUseOrigin contracts instead of creating a parallel resolver.

**Status:** Proposed; executable after A and B's shared member-proof interface.

**Goal:** Connect the supported direct `inject(KnownClass).method()` use to its actual method, preserving uncertainty for shadowed APIs, substitutions and unsupported return shapes.

**Architecture:** Angular-specific syntax and token binding remain in the TypeScript Angular adapter. The existing metadata port carries MemberUseOrigin. Application joins source evidence to graph symbols; domain exact-reference cut policy and walk bounds remain authoritative. MCP and composition contain no framework rules.

**Tech stack:** Existing TypeScript 6 public AST APIs, module resolver, declaration lookup, metadata project ownership and graph reader; no new package or Program.

**Spec:** `../specs/2026-11-04-symbol-proof-improvements-design.md`; A and B plans define exact identity and shared member evidence.

## Verified trace and safety prerequisite

`angular-metadata.extractor.ts:216-224` already reads the inject call and its owner, but only fills local when the call initializes a variable. `angular-metadata.adapter.ts:175-185` already emits the class injection relation; `inbound-edges.ts:300-318` bridges only a named local. The real pinned `provideAuthLifecycle` at auth.providers.ts:56-57 has a class injection finding but no LocalOrigin. Its `inject().start` reference is present in the final cut inventory.

A public-reader/fake-graph probe reproduced the distinction: local `const svc=inject(Svc); svc.hit()` reaches run from hit; inline `inject(Svc).hit()` does not. A separate fixture with a parameter named inject incorrectly produced the existing injection relation: coreName currently recognizes the import spelling without checking shadowing. Extending inline settlement before fixing that binding boundary would be unsafe. A provider substitution fixture retains an injection relation but no fixed origin; new member proof must retain the same substitution refusal.

Real graph characterization confirms nested `inject` and `inject().hit` rows share a starting coordinate. A must keep them distinct by name/kind/source and normalize 0-based UTF-16 graph columns to 1-based source positions. Rejecting all repeated coordinates would make this feature impossible.

## Admitted cases and exclusions

Admit a direct non-optional call of a literal identifier member on a direct inject call, with a literal repository class token resolving through current imports/renames/barrels. Verify the actual Angular core binding; admit named aliases and namespace imports only where that binding is unshadowed. The target class must have a unique own concrete non-static method implementation and no known provider substitution.

Exclude optional inject/call chains, InjectionToken-to-provider inference, useClass/useExisting/useFactory/useValue substitutions, inherited-only members, abstract/no-body methods, computed names, arbitrary wrapper/factory calls, signals, result chaining beyond this one member, dynamic tokens and missing source. Invalid or unclassified syntax remains unknown. Do not equate an annotation with runtime identity. Scope-limited or incomplete provider/source inputs cannot prove the absence of replacement: withhold the new member proof in those contexts; retain the existing ordinary class relation only under its existing contract.

## Review focus

Shadowed inject (already reproduced); same-line multiple/nested calls; replacement providers; ambiguous actual member/caller join; preserving a genuine unresolved neighbor and all walk bounds. Cover these directly, not merely object shape snapshots.

## Task 1: Guard the actual Angular binding

**Files:** `angular-metadata.extractor.ts`, `angular-metadata.adapter.ts`, `angular-metadata.adapter.test.ts` and a focused extractor test file if needed. Reuse a same-technology syntax helper from A only if its existing public contract answers this question; do not invent a general binder.

- [ ] Add `shadowed_parameter_inject_produces_no_angular_relation`, `shadowed_namespace_refuses_member_proof`, `local_inject_function_is_not_angular`, `class_token_parameter_shadow_keeps_unknown`, `alias_and_namespace_angular_bindings_are_supported`, `repository_paths_override_of_angular_core_is_not_framework`. The parameter fixture must fail against today's incorrect relation. Negative tests distinguish no Angular binding from a real unsupported Angular construct; keep unknown evidence where the latter is encountered.
- [ ] Use public AST declarations and import bindings for BOTH the inject API root and the class-token/namespace root. Reuse B's conservative imported-root shadow guard; a unique local top-level class with no conflicting declarations remains eligible. Do not resolve a parameter called Svc to a global imported Svc merely because names agree. A conservative whole-file refusal when a local declaration can shadow the imported inject or namespace is acceptable initially: do not implement a custom full lexical binder to recover every legitimate site. Use the existing module resolver to verify the core module resolves externally, not merely that its specifier text equals @angular/core. Parse failure or uncertain binding means no new proof. Apply the binding guard consistently to injection findings, field/local origins and the new inline path so known false relations are not preserved as a side effect of the extension.
- [ ] Run focused metadata tests and observe red then green. Preserve renamed imports, namespaces, project ownership and known provider substitutions. Record any conservative loss of old inferred relations; never hide it by updating snapshots without explanation.

## Task 2: Emit the shared exact member-use proof

**Files:** `angular-metadata.extractor.ts`, `angular-metadata.adapter.ts`, `angular-metadata.port.ts` and their tests. The optional memberUses channel and MemberUseOrigin type are B's shared contract; do not duplicate it.

**Internal signature:** add optional `inlineMember?: { name: string; line: number; column: number; referenceName: string }` to RawInjection. This describes the complete outer member call at its 1-based UTF-16 start; it does not create an artificial LocalOrigin. The extractor fills it only for the admitted direct form. referenceName follows only the characterized syntax forms: `inject().method`, `di().method` or `ng.inject().method`; verify each with pinned graph fixtures. Unsupported normalization returns unknown rather than adding a general expression printer.

- [ ] Add `inline_class_member_has_exact_target`, `inline_alias_barrel_resolves_actual_class`, `two_inline_services_same_line_remain_distinct`, `nested_inject_and_member_share_point_but_not_identity`, `provider_replacement_withholds_member_use`, `optional_token_dynamic_static_inherited_and_missing_target_stay_unknown`. Assert actual owner/class/member spans and the public port's 1-based source position. Add Unicode before the call.
- [ ] Recognize the outer call and the inner inject call with public TypeScript predicates, preserving its existing injection finding independently. Resolve the token through the existing per-project module/declaration lookup. Resolve only the unique own implementation from B's source member summary. Emit MemberUseOrigin with owner, receiver class, target member and exact source reference; honor the existing substituted-token set. Do not pretend every injection points to the named class implementation.
- [ ] Reuse B's optional second read/extract options `{ memberProofs?: MemberProofContext }` through RelationExtractor and AngularMetadataReader; do not add a second eligibility contract. The defaults and application eligibility helper are defined in B: absent/false context disables NEW memberUses proofs while preserving old fields/locals. Reuse that helper, its omission checks and reader parse/provider refusals unchanged. The reader additionally refuses incomplete/unsupported substitution syntax it encounters. Keep this flag internal and deterministic; do not claim it proves providers from unanalysed external/runtime configuration. Existing embeddings lacking options remain conservative. This is evidence about the declared source relationships, not runtime DI simulation or a universal proof of absence of hidden overrides.
- [ ] Add gate tests `scoped_or_omitted_provider_source_disables_member_proofs`, `old_reader_without_options_keeps_existing_results`, `parse_error_cannot_authorize_fixed_receiver`, `cancellation_after_metadata_read_aborts_before_graph_walk`. Update B's positive probes/tests to opt in under complete fixtures. This is the necessary bounded input contract, not a lockfile shortcut.
- [ ] Run focused tests, typecheck and architecture checks. New member uses cannot appear when the eligibility gate is absent/false.

## Task 3: Reuse B's joins and verify user-visible impact

**Files:** `application/impact/impact-queries.ts`, `inbound-edges.ts`, their tests, `src/composition/impact.e2e.test.ts`; update the relevant RFC paragraph when implementation lands.

- [ ] Forward memberUses from the existing relation extraction into createInboundEdges. Match both reference name/kind and normalized position, then join exactly to the caller symbol, receiver and target implementation. The actual call source must be inside the proved owner. Missing/ambiguous joins stay cuts. The inner inject reference and outer method call remain separate occurrences.
- [ ] With the method reached, add only the actual caller through normal call policy and use exact candidate settlements. With only the class reached, retain existing class dependency behavior; do not reach every method or every declaration in the file. Optional legacy metadata has no inline effect.
- [ ] Add composition fixture: modifying Svc.hit reaches the initializer/caller containing inline inject; a peer function in the same file is not reached; a same-line shadowed/unknown neighbor remains partial. Add provider-substituted and budget/depth cases. Compare seeds, caller provenance, reached entrypoints and cuts.
- [ ] Run focused metadata/relations/inbound/query/composition tests then `npm run check`. Repeat pinned branch and a selected AuthLifecycleService method change; compare every newly reached symbol and retired cut. Broad branch may still keep inline start references because the actual start method was not among the reached targets; do not erase them just to meet a count target.

## Cost, compatibility and invalidation

No additional source pass or program is required beyond a bounded AST visit on the parsed metadata. Reuse token resolution and B's source member summary; index exact uses once per query. Keep cancellation between awaited file/project operations. Do not retain mutable AST caches across snapshots.

Metadata additions and read options are optional; public Fact fields, graph store schema and module analysis remain unchanged. Existing embeddings disable new proofs unless they supply complete-source eligibility. Invalidate persisted derived facts through the actual producer/proof-version boundary; no graph staging bump unless its inputs change. If a build profile or arbitrary dynamic provider identity is required, keep it unknown and do not expand this plan into runtime DI simulation.

**Concrete derived-fact invalidation:** increment `EDGE_POLICY.referenceProofVersion` to 3. Composition already hashes EDGE_POLICY into the impact producer version. Keep repeated identical requests deterministic and compare producer identity to the previous work-unit baseline. Do not add a second cache namespace or alter graph database schemas.
