# ADR-0092: A type entered for a member that dispatch reached up from an implementation follows no subtype

- Status: Accepted, 2026-11-14, owner; amends decision 1 of [ADR-0017](0017-owner-of-a-member-expands-only-whole-type-edges.md)
- Decision source: the owner, 2026-11-14, accepting the transversal fix plan of evaluation run `20261114T125655Z-c68fc8`
  (unit U2, cause C2) and its decisions D1 to D8: "Acepto". D8 defers the comparison of type arguments on the dispatch
  hop (C2b); it is not decided here.
- Related: [ADR-0017](0017-owner-of-a-member-expands-only-whole-type-edges.md),
  [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** a type the walk enters only because it declares a member that dispatch reached from an implementation
follows no `extends`/`implements` row. The other subtypes of that type are siblings of the implementation, not
dependents of the change. A subtype entered below a type that is itself entered through a member is entered through a
member too, so it does not open the rows of whoever uses it.

## Context

ADR-0017 decision 1 lets a type entered because it declares a reached member expand into its subtypes, "a subtype depends
on it". That holds for a member that changed or that a call reached: a subtype inherits the member. It does not hold for
a member that the walk reached by dispatch up from one implementation: the contract is not changed, and the other
implementors are siblings that the walk already refuses to come down to (`callersOf`: "a path that went up never comes
back down to a sibling").

Measured on one `callers` query over a Java repository (evaluation run `20261114T125655Z-c68fc8`, case
`shopizer:callers:01`), a seed in one implementation of a generic interface with 41 implementors answered 108 symbols
for 14 true dependents. The up bridge reached the interface method; its owner type followed `implements` to the 41
sibling implementors, each entered as a whole declaration at depth 3, and 17 classes that reference those implementors
at depth 4. The same shape appears in two other repositories of the corpus, at smaller scale.

A type entered below such a type went on to expand as a whole declaration, so a subtype reached only because it
inherits a member opened every row of whoever injects or references it, the expansion ADR-0017 removed for its parent.

## Decision

1. A type entered for a member that an `up` dispatch bridge reached follows the `uses-component`, `uses-directive` and
   `uses-pipe` relations and no `extends` or `implements` edge. The rule is data: `EDGE_POLICY.ownerThroughDispatch`.
2. A type that another reached member entered by a call, or that is a seed or is reached through its own edge, keeps
   the rows of ADR-0017 decision 1 and 2, whichever of its members the walk reached first. The `down` bridge is
   unchanged: a subclass of an implementation inherits it.
3. A subtype the walk reaches through the `extends` or `implements` row of a type entered through a member is itself
   entered through a member: it follows its own subtypes and the templates that render it, and no row of whoever uses
   it. A subtype that its own edge also reaches keeps every row.
4. The type stays entered at the member's depth, so the entrypoints declared on an interface (a route generated from a
   contract) stay associated with the member it serves.

## Consequences

- `callers` and `impact` list fewer symbols and entrypoints when a seed implements a method of an interface or an
  abstract class with other implementors; every dependent that reaches the change through the member's own callers stays.
- A caller that the walk reached only because it uses a sibling implementor, and no member the change reaches, is no
  longer listed. That is the false positive removed, not a dependent lost.
- The comparison of the receiver's type arguments on the dispatch hop is still absent (D8): a caller of the interface
  method whose receiver names other type arguments is still followed.

## Not decided here

- Type-argument comparison on the dispatch hop (C2b): a new receiver reading in the Spring adapter, deferred by the
  owner (D8).
