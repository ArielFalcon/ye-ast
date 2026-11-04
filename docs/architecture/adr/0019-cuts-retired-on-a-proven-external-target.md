# ADR-0019: A cut whose target is provably external is not emitted

- Status: Proposed
- Decision source: the owner, 2026-11-03 (translated): "S7 + S8, finish it", over the slices `RFC-0016` names after
  measuring that the type layer as an edge source removes one cut.
- Related: [ADR-0010](0010-trust-modes.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md),
  [ADR-0018](0018-type-information-as-a-fact-input.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0010](../rfc/0010-impact-queries.md), [RFC-0016](../rfc/0016-type-resolution.md)

**In short:** `unresolved-link` is emitted when an unresolved reference's name tail matches a declaration the walk
reached. When the file imports that name from a package outside the repository — or nothing binds it and the language's own
libraries declare it — the reference cannot name that declaration and the cut is false. ye-ast reads the file's own
imports and the pinned compiler's own lib names, syntax and the module configuration the snapshot already holds, and stops
emitting it. No type root, no dependency and no project-wide type-checking `Program`.

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

1. **A reference whose root identifier is provably external is no cut**, whatever name tail the index matched. There are
   two proofs of that, and both are syntax: the file imports the root from outside the repository, or nothing binds it and
   the language's own libraries declare it while the snapshot declares no global of that name. `unresolvedLinkCuts` takes
   the set of proofs already made, and a reference in it is never attributed to a declaration. The unit is **the
   reference, never the line**: a proof is keyed by file, raw graph line and column, source ID, full name and kind.
   Coordinates must be valid and the full occurrence and syntax match must be unique. Missing, stale or ambiguous
   positions prove nothing. Raw graph columns are zero-based UTF-16; source ports receive one-based columns.
   `Cut.at` remains line-based, after all occurrences have been evaluated.
   A hidden dependence is worse than a false cut, and that is the same reason decision 3 pays 6% for a simpler shadowing
   rule. Measured on the same application's index: of the 10.896 places whose reference tail matches a declaration
   somewhere, **468 (4,3%) carry more than one root name on the line**, so keying by the place would have retired 468 cuts
   the proof never covered. That count is an upper bound: it is the whole index, specs included, and not only what the walk
   reached.
2. **Only a proven external target retires.** A name imported from a repository file stays a cut: the reference may name
   the imported declaration, and turning that into an edge needs the declaration, which is the type layer's answer
   (`RFC-0016` S9).
3. **The proof is conservative by construction.** A name the file declares in any scope is never retired, because that
   declaration may shadow the import at the place the reference sits. For the ambient proof the snapshot is checked too: a
   `.d.ts` or a global augmentation that declares the name keeps its cut. A hidden dependence is worse than a false cut.
   **Measured, the simplification costs almost nothing**: removing the refusal entirely retires 2 of the 107 places at
   `HEAD~5` and none at `HEAD~20` or `HEAD~60`, and a scope-aware rule (`RFC-0016` S11) recovers neither, because both
   declarations enclose their use. The 6% this decision was justified with was a share of the probe's candidate rows, not
   of the places a fact reports.
4. **It needs no type root and no flag.** The same inputs and the same engine version give the same answer; there is no
   configuration a caller must supply for the fact to be complete.
5. **It claims no completeness of its own.** The cut kind, the status rule and the unknown reasons are unchanged. A fact
   becomes `complete` only when the retired cut was its only one; on the measured application the list shrank and every
   answer stayed `partial`, which is what the numbers above show.
6. **A callback parameter is a different lexical declaration**, only for an exact bare call to a supported simple
   parameter. It excludes attribution to a removed homonym in another file; it neither identifies the callback value
   nor creates an edge. Unsupported scope syntax or a parse error leaves the candidate in place.
7. **The port is declared by the consumer and wired by composition.** `core/ports/import-origins.port.ts`; the adapter
   checks one file at a time and drops the tree. Its public isolated transpilation API creates a single-file compiler
   program internally for syntax diagnostics; it does not load or type-check the project. No use case imports a parser and no adapter reads another adapter.

## Consequences

- The cut list shrinks by 6% to 13% on the diffs measured, with no symbol gained: this removes noise, it does not extend
  the answer.
- The ambient proof adds another **7% to 16% of the cuts** on the same three diffs (`HEAD~5` 76→64, `HEAD~20` 190→176,
  `HEAD~60` 359→334), also with no symbol gained. Its table is generated from the installed `typescript` and a test fails
  while it drifts, so moving the pin (`ADR-0007`) requires regenerating it, not remembering to.
- A fact's bytes change without a new input field. `EDGE_POLICY.referenceProofVersion` participates in the existing
  producer digest and invalidates derived facts; no graph or fact schema step is needed.
- A repository whose configuration ye-ast cannot read retires nothing: the import resolves nowhere, the place stays a cut.
  That is the silent degradation the project asks for, and it never guesses external. The same holds for a snapshot that
  declares a global of its own: the ambient proof steps back and the place keeps its cut.
- The remaining cut places are receiver-rooted names (`this.svc.get`), names with no import, and imports from the
  repository. Whether the type layer earns its +387 MB on those is `RFC-0016` S9, and it is now measurable against a
  smaller list.
- Java is unaffected: the adapter reads TypeScript import clauses, and a Java reference keeps its cut.

## Not decided here

- Whether the type layer merges (`RFC-0016` S9): measured on 2026-11-03, it removes 0 to 3 cuts for +2,2 to +2,9 s and
  +300 to +480 MB, so the recommendation is to retire it and keep this record's proof, which needs no root.
- The budget that stops a `Program` and what a fact does when it is reached (`RFC-0016` question 4).
- Any Java equivalent of an import-binding proof: the Java extractor reads annotations, not resolution, and no
  measurement of what it loses exists yet.
