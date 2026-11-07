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
repeated runs (method in `RFC-0016`, "How these costs were measured"). For contrast, the type layer, since retired
(`ADR-0018`), cost +387 MB of retained memory and removed one cut.

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
   the imported declaration, and turning that into an edge needs the declaration, which a type layer would answer and ye-ast no longer has
   (`ADR-0018`, rejected).
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
6. **A parameter is a different lexical declaration**, only for an exact bare use in value position of a supported
   simple parameter of the enclosing arrow function, function expression, function declaration, method or
   constructor. It excludes attribution to a removed homonym in another file, and a graph edge that links that bare
   use to a homonym declaration is not a dependence; it neither identifies the parameter's value nor creates an edge.
   A type position, unsupported scope syntax or a parse error leaves the candidate and the edge in place.
7. **The port is declared by the consumer and wired by composition.** `core/ports/import-origins.port.ts`; the adapter
   checks one file at a time and drops the tree. Its public isolated transpilation API creates a single-file compiler
   program internally for syntax diagnostics; it does not load or type-check the project. No use case imports a parser and no adapter reads another adapter.

## Consequences

- The cut list shrinks by 6% to 13% on the diffs measured, with no symbol gained: this removes noise, it does not extend
  the answer.
- The ambient proof adds another **7% to 16% of the cuts** on the same three diffs (`HEAD~5` 76→64, `HEAD~20` 190→176,
  `HEAD~60` 359→334), also with no symbol gained. Its table is generated from the installed `typescript` and a test fails
  while it drifts, so moving the pin (`ADR-0007`) requires regenerating it, not remembering to.
- A fact's bytes change without a new input field; no graph or fact schema step is needed. No traversal fact is
  stored, so nothing needs invalidating ([ADR-0024](0024-one-producer-version-for-every-family.md)).
- A repository whose configuration ye-ast cannot read retires nothing: the import resolves nowhere, the place stays a cut.
  That is the silent degradation the project asks for, and it never guesses external. The same holds for a snapshot that
  declares a global of its own: the ambient proof steps back and the place keeps its cut.
- The remaining cut places are receiver-rooted names (`this.svc.get`), names with no import, and imports from the
  repository. The type layer that could have settled them was measured and retired (`ADR-0018`, "Outcome").
- A Java reference keeps its cut: the adapter reads TypeScript import clauses. A Java graph edge is judged by the same
  verdict, from the root its name has by Java's scoping (`java-name-bindings.adapter.ts`): an edge whose name is a
  qualified platform type, or a simple name a single import binds to one, is no dependence, which is the one case the
  measured repositories show (codegraph resolves `org.springframework...User` through the file's import of a homonym).
- A simple Java type name bound to a type of the repository names that type alone, wherever the scoping finds it (a
  member type, the file's package, an on-demand import). An edge into the type's own file stays; an edge into another
  file moves to the type when the graph places it at its qualified name, and is no dependence when the graph places it
  nowhere, which is the measured case: codegraph gives a record no node and matches its name to the constructor of a
  homonym record elsewhere. The record's own answers already say so (an `unknown-symbol` fault naming the record, a
  `no-extractor` cut on its changed file), so the dropped edge hides no dependence the graph represented.

## Not decided here

- A Java cut retired by an import-binding proof, a call on a type name (`T.m()`) whose type declares no such member, a
  use moved to a declaration from a file that does not import it (only the edges of the files that import a reached
  symbol are read for it), and a call on a typed receiver: each needs a proof the verdict does not take yet.

## Amendment: a root proves only the member below it

A root proves where a chain starts, not what a call runs past it. The repository may store its own object in a member of
a package or a platform class (`other.setLogger(new Sink())`, `System.setOut(new RepoStream())`), so a call that reads a
member between its root and its own member (`other.logger.flush()`, `java.lang.System.out.println()`) is neither retired
as a cut nor dropped as an edge by its root, in impact, callers, importers, outline and trace alike. The rule is the one ADR-0029 decision 9 states
(`readsPastRoot`: a call spelling more than two names from its root, a Java root counted after its package); a call one
member below its root (`Math.max`, `_.map`) keeps decision 1.
