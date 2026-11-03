# ADR-0019: A cut whose target is provably external is not emitted

- Status: Proposed
- Decision source: the owner, 2026-11-03 (translated): "S7 + S8, finish it", over the slices `RFC-0016` names after
  measuring that the type layer as an edge source removes one cut.
- Related: [ADR-0010](0010-trust-modes.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md),
  [ADR-0018](0018-type-information-as-a-fact-input.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0010](../rfc/0010-impact-queries.md), [RFC-0016](../rfc/0016-type-resolution.md)

**In short:** `unresolved-link` is emitted when an unresolved reference's name tail matches a declaration the walk
reached. When the file imports that name from a package outside the repository, the reference cannot name that
declaration and the cut is false. ye-ast now reads the file's own imports — syntax and the module configuration the
snapshot already holds — and stops emitting it. No type root, no dependency, no `Program`.

## Context

`RFC-0016` gap A records the finding: the type layer resolves 77,5% of the frontier and almost none of it changes an
answer, because an edge only exists for the 13% that points inside the repository. The population that matters is the
other 64,5%: references whose target is a package. Today they are computed and discarded, and every one of them is a cut
the agent reads as "this might touch your code".

The proof does not need a type checker. A reference's root identifier either is or is not bound by an import of its file,
and `module-resolver.ts` already answers where that import goes: `paths`, `baseUrl` and `extends` from the snapshot's own
configuration, a relative specifier as written, a package the manifest declares as external.

Measured on the same application as `RFC-0016`, with the index already cached, all three diffs end to end:

| Base | Cuts, before | Cuts, after | Places, before | Places, after | Symbols |
|---|---|---|---|---|---|
| `HEAD~5` | 84 | **73** (−13,1%) | 237 | **193** (−18,6%) | 586 → 586 |
| `HEAD~20` | 201 | **184** (−8,5%) | 847 | **782** (−7,7%) | 1.067 → 1.067 |
| `HEAD~60` | 374 | **350** (−6,4%) | 6.257 | **6.151** (−1,7%) | 2.495 → 2.495 |

Cost: median peak RSS 457 MB → 585 MB over three runs each, with the same workload; wall clock inside the noise of
repeated runs (method in `RFC-0016`, "How these costs were measured"). For contrast, the type layer costs +387 MB of
retained memory and removes one cut.

**A correction to `RFC-0016`'s estimate.** It said 55% of the cut places were retirable. That was measured over 1.172 of
the 6.257 `at` entries at `HEAD~60` — the subset whose place carries no reference name. The named places
(`src/a.ts:12 this.store.get`) are exactly the ones a receiver roots and no import proves, so the subset was the
retirable one. The measured effect on all places is 1,7% there and 18,6% on the smallest diff. The theorem held; the
population did not.

## Decision

1. **A reference whose root identifier the file imports from outside the repository is no cut**, whatever name tail the
   index matched. `unresolvedLinkCuts` takes the set of proofs already made, and a reference in it is never attributed to
   a declaration. The unit is **the reference, never the line**: a proof is keyed by its place *and* the name it proves
   (`externalPlaceKey`, `settledPlaceKey`), because a line holds several references and retiring the line would hide a
   true cut that shares it. A hidden dependence is worse than a false cut, and that is the same reason decision 3 pays 6%
   for a simpler shadowing rule. Measured on the same application's index: of the 10.896 places whose reference tail
   matches a declaration somewhere, **468 (4,3%) carry more than one root name on the line**, so keying by the place would
   have retired 468 cuts the proof never covered. That count is an upper bound: it is the whole index, specs included, and
   not only what the walk reached.
2. **Only a proven external target retires.** A name imported from a repository file stays a cut: the reference may name
   the imported declaration, and turning that into an edge needs the declaration, which is the type layer's answer
   (`RFC-0016` S9).
3. **The proof is conservative by construction.** A name the file declares in any scope is never retired, because that
   declaration may shadow the import at the place the reference sits. A hidden dependence is worse than a false cut, and
   the file-level rule costs 6% of the retirements to keep the soundness argument short.
4. **It needs no type root and no flag.** The same inputs and the same engine version give the same answer; there is no
   configuration a caller must supply for the fact to be complete.
5. **It claims no completeness of its own.** The cut kind, the status rule and the unknown reasons are unchanged. A fact
   becomes `complete` only when the retired cut was its only one; on the measured application the list shrank and every
   answer stayed `partial`, which is what the numbers above show.
6. **The port is declared by the consumer and wired by composition.** `core/ports/import-origins.port.ts`; the adapter
   parses one file at a time and drops the tree. No use case imports a parser and no adapter reads another adapter.

## Consequences

- The cut list shrinks by 6% to 13% on the diffs measured, with no symbol gained: this removes noise, it does not extend
  the answer.
- A fact's bytes change without a new input field. The release that carries this is the invalidation boundary, exactly as
  any producer change is; no schema step is needed and none is taken.
- A repository whose configuration ye-ast cannot read retires nothing: the import resolves nowhere, the place stays a cut.
  That is the silent degradation the project asks for, and it never guesses external.
- The remaining cut places are receiver-rooted names (`this.svc.get`), names with no import, and imports from the
  repository. Whether the type layer earns its +387 MB on those is `RFC-0016` S9, and it is now measurable against a
  smaller list.
- Java is unaffected: the adapter reads TypeScript import clauses, and a Java reference keeps its cut.

## Not decided here

- Whether the type layer merges (`RFC-0016` S9): it now needs to prove itself against 350 cuts instead of 374.
- The budget that stops a `Program` and what a fact does when it is reached (`RFC-0016` question 4).
- Any Java equivalent of an import-binding proof: the Java extractor reads annotations, not resolution, and no
  measurement of what it loses exists yet.
