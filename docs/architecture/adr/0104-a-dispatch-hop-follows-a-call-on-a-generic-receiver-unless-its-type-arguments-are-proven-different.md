# ADR-0104: A dispatch hop follows a call on a generic receiver unless its type arguments are proven different

- Status: Accepted, 2026-11-15, owner; settles decision D8 left open by [ADR-0092](0092-a-type-reached-by-dispatch-up-from-an-implementation-follows-no-subtype.md)
- Decision source: the owner, 2026-11-15: "Si", approving the second fix round of MCP evaluation rerun
  `20261114T190541Z-a57733`, where D8 is released: "compare type arguments on a generic dispatch hop, fail-closed (keep
  the candidate when the comparison cannot be proven)".
- Related: [ADR-0092](0092-a-type-reached-by-dispatch-up-from-an-implementation-follows-no-subtype.md),
  [ADR-0084](0084-a-calls-argument-count-excludes-the-homonyms-that-cannot-take-it.md),
  [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** when the walk goes up from an implementation to the interface method it implements, it follows each call
of that method. A call whose receiver is declared with type arguments (`Mapper<A, B>`) cannot reach an implementation
whose class binds the same type's parameters to other types (`implements Mapper<C, D>`). The walk drops that call for
that implementation, and only when the sources prove the arguments different; every raw, wildcard, type-variable or
unresolved argument keeps the call.

## Context

In the rerun, `callers` of a repository method (`shopizer:callers:01`) still answers 2 false routes and 6 false
methods after ADR-0092. The walk reaches `PersistableTaxRateMapper implements Mapper<PersistableTaxRate, TaxRate>` and
goes up to `Mapper.convert` by the dispatch bridge. The callers of `Mapper.convert` are two facades whose receivers are
declared `Mapper<PersistableCatalogCategoryEntry, CatalogCategoryEntry>` and `Mapper<Manufacturer,
ReadableManufacturer>`: at compile time the receiver of a call fixes the parameterization, and a class that implements
`Mapper` with other arguments is not a subtype of it (JLS 4.10.2, type arguments are invariant), so no value of
`PersistableTaxRateMapper` can be held there. The by-name bridge cannot see it, because it joins the implementation to
the interface by method name and signature and ignores the arguments the class gives the interface.

The comparison is a reading of the sources, not a graph fact: the receiver's type arguments are written at its
declaration, the implementation's at its `implements` clause, and both resolve through the strict name rules the Java
pack already applies (ADR-0062).

## Decision

1. **A path property.** A declaration the walk reaches only by dispatch up from implementations keeps those
   implementations as its origins. A declaration that is a seed, or that any other edge or a down bridge also reaches,
   has no origin and keeps every call. Origins propagate up a chain of hops; a hop above a restricted declaration
   carries that declaration's origins, not the declaration.
2. **The rule.** A call into a restricted declaration is dropped when, for every origin, the pair is proven different;
   it is kept when any origin is not. A declaration that gains an origin or loses its restriction after it was
   expanded is expanded again, so the answer does not depend on the order the walk meets its reasons.
3. **Proven different** (the Java pack, `ImportOrigins.receiverFits`). All of these hold:
   - the call's receiver is a name (a parameter, a local or a field) whose declared type is a repository class or
     interface `T` written with type arguments;
   - the class that declares the origin writes `T` itself, resolved to the same declaration, in its own `extends` or
     `implements` clause with type arguments of the same count;
   - at some position both arguments are ground (a repository or platform type, with type arguments of its own where
     it has them) and differ: the declarations differ, or they are the same declaration whose own arguments are proven
     different by this same rule.
4. **Everything else is unknown, and keeps the call.** A raw or diamond type; a wildcard; a type variable of the
   class, the method or an enclosing type; an array; a name the strict reading leaves unsettled or ambiguous; a
   receiver that is not a plain declared name; a hierarchy between the implementation and `T` that is longer than the
   direct clause (a class that reaches `T` through an abstract base is not compared); a source the reader does not
   read; and a language whose pack does not answer. The TypeScript pack answers `capability-absent`: its types are
   structural, so another class may satisfy a receiver whatever it declares.
5. **The bound.** The reach of every answer is a subset of today's: no call is added, no cut is added, and a call is
   removed only under decision 3. The answer carries no new marker, because a call proven unable to reach the
   implementation is not a dependent, and the walk lists no uncertainty it did not list before.
6. **The assumption.** As ADR-0062: the repository compiles, so a value held by a receiver declared `T<A, B>` has the
   parameterization `T<A, B>`; heap pollution through a raw type or an unchecked cast is outside it.

## Alternatives considered

- **Resolve the whole hierarchy with substitution** (`C extends Base<P> implements ...`, `Base<S> implements T<S, X>`).
  Dropped for now: the evidence is the direct clause, and the substitution through a chain needs its own proof of
  bounds and of type-variable scoping. It extends decision 3 without changing the rule, and every case it would settle
  stays kept today.
- **Compare in the application layer from two readings** (receiver arguments, implementation arguments). Dropped: the
  comparison needs the language's scoping of every name written in the arguments, which is the pack's, and a shared
  type-argument value type would exist for one consumer.
- **Filter the callers inside the inbound edges, with no path property.** Dropped: whether a call is a dependent is
  decided by the implementation the walk came from; the same interface method reached from another implementation keeps
  the call.
- **Mark the dropped calls.** Dropped: a call that cannot reach the seed is not uncertainty, and a marker per dropped
  call is noise.

## Consequences

- `callers` and `impact` of a method implemented from a generic interface list fewer callers: those whose receiver
  names other type arguments than the class that holds the change binds.
- The port of import origins gains one optional reading, `receiverFits`, with the pair as its site; a pack without it
  reads as `capability-absent` and keeps every call.
- Cost: one reading per pair of a restricted declaration's origin and a call it reads into it, asked once per request.
- Trace is unchanged: it selects the targets of a call from the receiver's declared type, not from the callers of an
  interface method.

## Not decided here

- The same comparison through a hierarchy longer than the direct clause.
- Wildcard containment (`Mapper<? extends A, B>` against `Mapper<C, B>`), which needs subtyping the sources do not
  prove through types outside the repository.
