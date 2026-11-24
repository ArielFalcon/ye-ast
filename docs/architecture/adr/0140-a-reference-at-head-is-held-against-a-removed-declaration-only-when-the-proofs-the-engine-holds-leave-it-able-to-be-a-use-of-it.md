# ADR-0140: A reference at head is held against a removed declaration only when the proofs the engine holds leave it able to be a use of it

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra sesion
  por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente tenga que
  tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less capable
  agent implements it in another session; everything must be explicit, leaving almost no room for that agent to take
  important decisions or invent implementations). The decision serves this sentence of the request of the same day:
  "Mejorar la calidad de analisis de lo que ya existe, corregir problemas, optimizar recursos y aprovechar mejor los
  recursos que ya tiene disponible" (improve the quality of the analysis that exists, fix problems, optimise resources
  and make better use of the resources already available).
- Related: [RFC-0046](../rfc/0046-a-removed-declaration-is-attributed-by-the-proofs-and-the-base-revision.md) (the
  design), [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md) decisions 1 and 4,
  [ADR-0042](0042-completeness-is-relative-to-the-question.md) (reason `removed-declaration`),
  [ADR-0019](0019-cuts-retired-on-a-proven-external-target.md),
  [ADR-0088](0088-a-reference-the-base-binds-away-leaves-no-cut-however-the-index-spells-it.md),
  [ADR-0075](0075-the-core-names-no-language-or-framework.md)

**In short:** the `removed-declaration` cut of `impact` lists, today, every unresolved reference at head that spells the
removed name. It now lists a reference only when the proofs the engine holds, asked of the one owner of call binding,
leave that reference able to be a use of the removed declaration; a reference a binding or a receiver's type proves
bound elsewhere is not listed. The cut keeps its reason, its reach and its shape.

## Context

Verified at commit `62a41b28a`:

| Fact | Evidence |
|---|---|
| The cut pairs a reference with a removed declaration by the tail of the name and the import and local-parameter proofs; no binding of the reference decides | `removedDeclarationCuts`, `src/core/domain/impact/impact-cuts.ts` |
| A removed declaration is a file and a name read from a diff line; it carries no kind and no owner | `RemovedDeclaration`, `src/core/domain/change/seeds.ts`; `createDiffReader`, `src/core/domain/change/diff-reader.ts` |
| The one owner of what an unresolved call binds to answers `declaration`, `receiver`, `outside`, `unbound` or `declared`, and `impact` already holds it | `CallBinding`, `CallBindings.boundCalls`, `src/core/application/navigation/call-binding.ts`; `EdgeTargets.bindings`, `src/core/application/navigation/edge-targets.ts` |
| The sibling cut `unresolvedLinkCuts` receives the settled uses, the member proofs and the bound-away uses; the removed-declaration cut receives none | `impactOf`, `src/core/application/impact/impact-queries.ts` |
| The ledger of the corpus gate holds 32 `removed-declaration` cuts in the baseline report: 27 TypeScript, 5 Java | `ledger.candidate.rows` of the baseline corpus report (`family: impact`, `reason: removed-declaration`) |

Options weighed:

| Option | Verdict |
|---|---|
| Reuse the sibling cut's keys (`settled`, `members`, bound-away) | Dropped: they are keyed by a walked declaration, and a removed declaration is not a node; an `away: []` bound-use key means "another cut covers the call", not "the call binds elsewhere" (RFC-0046, Problem) |
| Ask the owner of call binding what each candidate binds to and compare it with the removed declaration | Chosen: ADR-0041 decision 1 makes `CallBindings` the one owner; ADR-0036 makes the compile-time binding the dependence |
| Drop a candidate because a declaration of the same name was added elsewhere in the change | Dropped: an added name is an author's intent, not a binding; an unrelated declaration reusing the name would hide a real dependent |

## Decision

1. **A reference is listed against a removed declaration unless a proof says it is no use of it.** The candidate pairing
   is unchanged (RFC-0046 R1); a pair is dropped only on a proof of one of the shapes below, and every other case keeps
   it.
2. **The proofs are the owner's.** The owner of call binding (`CallBindings`) answers what the reference binds to at
   head; no consumer of the cut binds a call by name. A reference the owner answers as bound to another declaration, as
   bound outside the repository, or as a member call whose proven receiver type has a closed hierarchy unrelated to the
   removed member's owner, is no use of the removed declaration.
3. **Equal anchors keep the pair.** A binding to a declaration whose anchor (`file::name`) is the removed
   declaration's own does not prove a use of it, and does not prove a non-use: the pair stays. Where the removed
   declaration's owners are known and the binding's target belongs to another owner, the pair is dropped.
4. **A binding the owner does not settle keeps the pair.** `unbound` and `declared` bindings, an outside receiver with
   a dispatch, a receiver a provider may replace that only a syntax declaration binds, a reference with no unique key,
   and a reference the reading did not answer keep the cut.
5. **A proof of non-use is a proof about head only.** The head's binding is the compile-time binding (ADR-0036): the
   removed declaration does not exist at head, so a reference the head binds to an existing declaration or outside the
   repository does not depend on it; if that binding is part of the change, the walk already reaches its dependents.
   A binding that depended on the removed declaration at base and now binds elsewhere is not a use of the removed one.
6. **The cut never grows.** The listed places are a subset of today's; no cut reason, no cut field and no cause is
   added by this decision. A cut with no place left is not emitted.
7. **Where the proofs of head leave places, the base revision may be asked.** Opening the merge base's index to tell
   the references it resolved into the removed declaration from the others is a separate step, taken only when places
   remain after decisions 2 to 4 and a measurement shows they do (RFC-0046 U3 and U4). It adds the cause member
   `resolved-at-base` and drops a place only on a non-heuristic base binding to another declaration at a place the
   change did not touch.
8. **The module-augmentation assumption is the engine's own.** An external proof drops a reference as in ADR-0019: a
   module augmentation that declares the removed member on a library type is not read.

## Consequences

- The `removed-declaration` rows of the ledger (`impact`, `typescript` and `java`) fall where a binding proves
  non-use; `impact` answers that listed only such references become `complete` for that cut (ADR-0042).
- A repository that replaced a removed member with a homonym in the same file keeps the reference listed (decision 3);
  it is a dependent to review.
- The domain function receives a set of keys, never a proof type (ADR-0075).
- A wrong drop is a missed dependent; the tests named in RFC-0046 and the corpus gate difference review are the guard.

## Not decided here

- Java owners of removed declarations, and a reference through an outside receiver with a dispatch: tracked in
  RFC-0046 "Not covered".
- A rule for declarations moved between files: RFC-0046 R8 leaves it out.
