# ADR-0088: A reference the base binds away leaves no cut, however the index spells it

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md),
  [ADR-0084](0084-a-calls-argument-count-excludes-the-homonyms-that-cannot-take-it.md),
  [ADR-0087](0087-a-java-call-the-reading-cannot-read-is-unproven-and-a-call-on-super-runs-without-dispatch.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** the base binding settles a written call away from a reached declaration by a proof about the call, and
the cuts read that settlement only for a reference the index spells with a qualifier and gives no candidate. The index
spells some calls the binding settles as a bare name, a call on `super` among them, and each kept a cut the engine had
already proven wrong. The settlement now counts for a bare reference too, on both paths that cut it.

## Context

Reproduced on `callers` and `impact`, after ADR-0087 made a call on `super` an exact answer:

| The call | The reached declaration | Answer |
|---|---|---|
| `super.m(a)` inside the override `m` of a class whose superclass is outside the repository | that override | `impact` is `partial`, a `hidden-caller` cut at the call |
| `super.bRun()` inside an anonymous class of an outside type | a `bRun` another class declares | `callers` is `partial`, a `name-only` cut at the call |

The first was measured on the corpus: one such cut on one answer. Neither call can run the reached declaration
(JLS 15.12.4.4), and the reverse reading already records each as settled away from it.

ADR-0079 decision 1 states which references are asked as the qualified ones without a candidate. That was the set its
measurement needed, not a rule of correctness: the reverse walk (ADR-0041 decision 8) binds every written call it finds
by name, bare ones included, and ADR-0079 decision 3 is written against the kinds of the binding, not against the
spelling of the reference.

## Decision

1. **The settlement of ADR-0079 decision 3 counts for a bare reference.** A reference the index spells as a bare name
   cuts nothing toward a reached declaration the base binds it away from, as a qualified one without a candidate does.
2. **Both cuts read it.** The `hidden-caller` cut of a reference attributed to a declaration of its own file or of a
   file it imports, and the `name-only` cut of one attributed to none, each leave out the declarations the reference is
   bound away from. A cut with no declaration left is not made.
3. **What makes it a proof for a bare name.** A call without a receiver may run a declaration of a subclass, so its
   binding is settled away only by what the base already requires: an answer outside the repository on the bare form
   settles only when it is exact (ADR-0087 decision 4); a target that is another declaration settles only when that
   target was reached or the reached declaration's language pack proves it neither implements nor overrides it
   (ADR-0079 decision 3); an argument count the declaration cannot take (ADR-0084). A call the binding attributes to
   the declaration keeps the cut ADR-0041 decision 8 gives it.
4. **A qualified reference with candidates is unchanged.** It keeps its cut whatever the binding answers; no measurement
   asks for more.
5. **The bound.** As ADR-0079 decision 9: the reach of every cut is a subset of today's, a reference that produced no
   cut produces none, and no dependent is added or removed.

## Alternatives considered

- **Settle only a call on `super`.** Dropped: the settlement is a proof about the binding whatever the form of the call,
  and a rule per form would leave the next bare form with the same cut.
- **Drop the reference in the reverse reading instead of in the cuts.** Dropped: the cuts own what an unresolved
  reference marks, and the reverse reading already states the settlement they read.

## Consequences

- A repository whose bare references the binding does not settle answers byte-identically.
- A call the binding attributes to a declaration of its own file left two `hidden-caller` cuts of the same reach, one
  from each rule; it now leaves the one of ADR-0041 decision 8.
- Cost: none added; the settlements are the ones the reverse walk already computes.
