# Scoped receiver evidence: viability and implementation

**Goal:** Demonstrate a complete provider-plus-mutation improvement while preserving uncertainty for aliased, escaped or substituted receivers.

**Architecture:** Keep language binding, allocation and effect evidence inside the existing TypeScript adapter. Application continues exact graph joins and domain retains cut policy. No dependency, process, server or project-wide compiler is added.

## Acceptance before broadening

- [x] Integrate the previously verified syntax unit into local main while preserving concurrent documentation edits.
- [x] Reproduce independent provider and mutation gates through the public reader: clean inline injection is proven; either added gate prevents it.
- [x] Verify the Angular contract that a new authentic InjectionToken has unique object identity.
- [x] Implement the narrow provider-identity evidence and adversarial tests. A declaration merely called a token, a class alias, type-only import, unknown constructor, ambiguous/unreadable barrel or unstable class binding proves no disjointness.
- [x] Evaluate receiver confinement for supported inline injections. It must account for all class/value/instance exposures, not infer independence from a different name or type. If its source/runtime assumptions are insufficient, retain refusal.
- [x] Demonstrate the combined public-reader and exact graph/cut behavior, including relevant mutation/provider negatives.
- [x] Measure complete frozen responses and cost; preserve full dependency reach, entrypoint seeds, cancellation and producer invalidation.
- [x] Review and run focused/full checks before accepting production changes.

The first mutation design admits only a private fresh null-prototype record with an exhaustive binding-use census and primitive literal keys. It is soundly bounded but does not address the pinned corpus's returned records, unknown receivers, reflection and prototype accesses. Do not ship that refinement as a claimed corpus-level solution.

Provider authentication uses the documented Angular runtime contract, the repository's resolution and source evidence. Ordinary metadata lookup can skip an unreadable star branch; such a result is not unique-identity evidence. Prefer retaining uncertainty over copying an approximate resolver. Initial support may conservatively admit direct declarations/imports and reject barrels until strict resolution can prove them.

## Viability boundary selected

Receiver confinement is not admitted. A source-level direct-use census does not prove a closed runtime world, and the selected lifecycle receiver passes a callback capturing this to an external listener. A conservative analysis keeps that case unknown. No global mutation gate is bypassed on the basis of a class name, type or alleged confinement.

The mutation refinement specified for the combined viability test removes only effects on a private fresh null-prototype record: one unambiguous local const binding, a sole literal __proto__: null initializer, and an exhaustive same-function, in-block write/delete census with primitive literal keys or direct dot names. Reads, aliases, returns, captures, shadowing, spreads/accessors, ordinary object prototypes, unknown/coercible keys and unsupported writes retain the original refusal. Key/RHS subtrees are still inspected for their own effects. Two AST passes reuse the parsed file and existing declaration census; there is no interprocedural heap model.

Provider authentication initially supports same-file tokens and direct runtime imports into a top-level const new InjectionToken declaration, including import aliases and namespaces. Type-only imports, barrel hops, mutable/ambiguous bindings and unknown constructors retain refusal. Assignment evidence distinguishes binding writes from property writes and stays scoped to the declaration file; unrelated homonyms must not poison class identity. Native-only extraction reuses the existing declaration census; ordinary metadata reads avoid the additional identity pass.

The combined Git/graph fixture must reach the initializer and retire its exact unresolved inline call only when both provider and mutation evidence succeed. Replacing the token with a class alias or returning the record must retain that cut. This is a bounded capability proof, not evidence that the full pinned corpus's remaining reflection/escape problems are resolved.

Provider identity follows the same declared-external-Angular semantic model as existing inject/decorator extraction. It does not authenticate installed runtime bytes. The standard object-identity contract is documented at https://angular.dev/guide/di/debugging-and-troubleshooting-di#token-identity-confusion and https://angular.dev/guide/di/dependency-injection-providers.

Review found wrapped namespace assignments missing from the write census. Parentheses, assertions, satisfies and non-null wrappers must preserve the underlying namespace identity; reads of type names in assignment assertions must not be counted as binding writes. Five negative public-reader variants and a positive unrelated type-assertion assignment have observed RED/GREEN evidence.

## Verified result

The native Git/graph fixture changes from one unresolved inline call and two reached symbols to no cuts and three reached symbols: its initializer is recovered. Class-alias providers and escaped records retain the call cut. The same fixture failed against the frozen baseline before implementation.

The complete pinned corpus remains at 292 cuts, with its entire impact value unchanged (1,514 symbols, 41 entrypoints, 761 seeds, module impact and expansion cost). Selected lifecycle callers/cuts also remain unchanged. This increment demonstrates the bounded capability, not a reduction in that corpus or a general escape/alias solution. Remaining computed writes, reflection, prototypes and callbacks are still refused.

Independent review found a wrapped-namespace write gap. The lead reproduced five negative wrapper forms as failures, plus an unrelated type-only assertion write that was wrongly counted as a binding mutation; all pass after using existing expression normalization. The final focused adapter/composition/constructor command passes 104 tests. The integrated typecheck, architecture check and full suite pass all 1,875 tests. Provider-only source export separately passes 97 focused tests, typecheck and architecture checks, so the commits remain independently functional.

The provider unit uses policy version 6; adding private-record evidence uses version 7. Both participate in existing producer invalidation. No dependency or project compiler program was added. Scope remains deliberately conservative: direct authenticated token syntax, direct token imports and nonescaping write-only null-prototype records.

Two alternating samples per engine on the pinned branch query give median 5,483.5 ms before and 5,568.5 ms after (+85 ms observed). The sample is too small for a general latency or retained-memory claim. Both samples preserve all 292 cuts. Raw process-family RSS and response comparisons remain local in the ignored audit directory.

Rollback boundaries follow two functional commits: provider identity and its binding-write guards can be reverted independently before the private-record unit; the private-record helper/extractor integration and combined composition regression can be removed without changing module or ordinary graph traversal. Each behavior updates the existing producer policy identity.
