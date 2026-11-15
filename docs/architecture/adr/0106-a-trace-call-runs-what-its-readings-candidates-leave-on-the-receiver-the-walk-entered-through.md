# ADR-0106: A trace call runs what its reading's candidates leave, on the receiver the walk entered through

- Status: Accepted, 2026-11-15, owner
- Decision source: Owner, 2026-11-15, approving the second fix round of the MCP evaluation rerun
  `20261114T190541Z-a57733`: "Si" (the findings N2 to N5 of its inline review).
- Related: [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md),
  [ADR-0084](0084-a-calls-argument-count-excludes-the-homonyms-that-cannot-take-it.md),
  [ADR-0087](0087-a-java-call-the-reading-cannot-read-is-unproven-and-a-call-on-super-runs-without-dispatch.md),
  [ADR-0089](0089-an-index-edge-the-receiver-reading-does-not-prove-is-judged-as-the-reference-at-its-place.md)
  (decision 4, which this decision amends), [RFC-0013](../rfc/0013-trace-and-patterns.md)

**In short:** `trace` cut every call its receiver reading answered `unproven`, and listed the declarations of the call's
name across the repository, so a parameter typed `TaxClass` listed 135 candidates and `this.update(x)` in an inherited
body listed the siblings of the body's class. A trace now lists only the declarations the reading offers, follows the
one body they leave where no type outside the repository leaves the hierarchy open, and carries the receiver it entered
a body through, so a call on `this` runs what a value of that receiver runs.

## Context

Reproduced on the trace of a repository's `POST` handler (`shopizer:trace:01`), `partial` with 17 cuts and a 66 KB answer:

| The call | What trace said | What the language binds |
|---|---|---|
| `destination.setCode(x)`, `destination` a parameter typed `TaxClass`, open through `Comparable` | `receiver-unproven`, 68 candidates of the name | `TaxClass.setCode`: the reading offers that one, and keeps it unproven because the platform type may declare an overload (ADR-0087) |
| `new TaxClass()` | `constructor-unsettled`, 2 candidates | the one constructor with no parameter |
| `this.update(x)` in `TaxClassServiceImpl.saveOrUpdate`, `update` inherited | `dispatch overridable`, the 4 sibling services that override it | `update` of the superclass: no type below `TaxClassServiceImpl` declares it |
| `save(entity)` in that inherited `update` | `receiver-unproven`, 9 candidates of the name | the superclass's `save`, so the data write was missing |

Why: a trace builds a cut from `declarationsNamed` when the reading answers `unproven`, though the reading already
names the repository declarations the call can run (ADR-0089 decision 2); `constructorsOf` lists every constructor
whatever arguments the call writes; and the walk reads dispatch below the declaration's owner, never below the class
the walk is running for.

## Decision

1. **A cut lists what the reading offers.** A call whose reading is `unproven` with candidates is a cut listing those
   candidates, never every declaration of its name; the name-based list stays where the reading offers none.
2. **One body is a step.** When the hierarchy is closed (the reading does not say `open`) and the declarations a call
   can run include exactly one body, every other one being replaced by it (it overrides them, they are abstract
   methods of a class above it, they sit with it above the receiver's lineage, or the dispatch of each names it
   alone), the call is a step to that body; any other set is a cut. A hierarchy only types outside the repository leave
   open keeps the cut of ADR-0087, listing its candidates.
3. **A call on `this` runs what the receiver the walk entered through runs.** A step carries the type its body
   runs for: the class that declares it, the class a dispatch chose, or, for an own, bare or `super` call, the
   receiver of the body making it. A dispatch read for a body so entered lists only the declarations a value of that
   receiver can run (the receiver's lineage and the types below it); a body reached again through a receiver no earlier
   expansion covers is expanded again.
4. **A construction takes the constructors that accept its arguments.** The argument counts of a construction and the
   counts a constructor accepts are read as those of a method call (ADR-0084), and the constructors that cannot take the
   written count are not candidates.
5. **A cut cause several cuts share is said once**, and the `--jdk` hint is named only on a cut with the one
   implementation a JDK releases (ADR-0044 decision 5).

## Consequences

- ADR-0089 decision 4 ("`trace` is unchanged") no longer holds: `trace` follows the one body a closed `unproven`
  reading leaves (a generic signature the reading cannot compare, such as `save(E)` in a type and in its interface).
  `callers` and `impact` read the same answer as before. The port's `unproven` answer says when it is `open`.
- The argument counts of constructions are now read by every consumer of `argumentCounts` and `acceptedCounts`, so a
  reverse family also leaves a constructor that cannot take the written count.
- A shared body entered by several unrelated receivers is expanded once for each.

## Not decided here

- A call on a receiver declared outside the repository still lists the repository declarations of its name
  (ADR-0079 decision 4).
- A hierarchy open only through a platform interface whose member names are known (`Comparable` declares only
  `compareTo`) could stop being open for every other name; that change is in the Java pack and moves `callers` and
  `impact`, so it needs its own decision.
- `super.m()` on a hierarchy open through outside types is still unproven.
