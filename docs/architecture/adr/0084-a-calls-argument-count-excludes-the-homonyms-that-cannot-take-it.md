# ADR-0084: A call's argument count excludes the homonyms that cannot take it

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** a call the index does not resolve is paired by name with every reached declaration of that name, and each
pairing is a `name-only` cut. The pairing ignores how many arguments the call writes. Where the language fixes the
number of arguments a declaration takes, a call that writes another number cannot be a call of it, and the declaration
leaves the reach of the cut.

## Context

Measured after ADR-0079 unit U2 on `callers` of a constant in the largest Java repository of the corpus: 685 places
stay marked, 481 of them calls named `get`. 369 of those stay paired with a reached `get` that declares four
parameters, because its owner is a functional interface and the answer of U2 for it is `unknown`; the calls sampled
write none or one argument. No reading of the hierarchy is needed to see that such a call is not one of that method.

In Java a method invocation is applicable to a declaration only when the argument count equals the parameter count, or
is at least the count of the parameters before a variable-arity one (JLS 15.12.2). The sources state both numbers.

## Decision

1. **Two facts the language pack reads.** For a call site, the number of arguments it writes. For a declaration, the
   argument counts it accepts: one number, or a lower bound when its last parameter is of variable arity. Each is
   `unknown` where the pack cannot place the site or the declaration, where several calls of the name start at the
   place, or where the form writes no argument list (a method reference).
2. **The rule is the base's.** A reference whose call writes a count a reached declaration does not accept is bound
   away from that declaration: the settled reference of ADR-0079 decision 3, with no declaration named instead. The
   reference leaves the reach of its `name-only` cut toward that declaration, and the cut leaves when no declaration
   remains.
3. **Only where the language fixes the count.** A language pack answers the two facts only when its language lets no
   declaration take a count other than the ones it states. The Java pack answers. The TypeScript pack declares the
   capability absent: optional, default and rest parameters, overload signatures and `arguments` need their own
   evidence before a rule.
4. **Counts only.** No argument type is compared and no overload is selected: that needs the types of the arguments,
   which library signatures give (ADR-0079 unit U3).
5. **The bound.** As ADR-0079 decision 9: the reach of every cut is a subset of today's, a reference that produced no
   cut produces none, and no dependent is added or removed.
6. **Trace is unchanged.** Trace already filters the candidates of a declared receiver by arity (ADR-0080 unit U2);
   this decision adds nothing to it.

## Alternatives considered

- **Wait for library signatures.** Dropped: U3 settles a receiver's type, which removes these pairings only where a
  `--jdk` or a classpath is declared; the argument count is in the sources of every repository.
- **Filter by arity inside the index's unresolved references.** Dropped: the index keeps a reference's name and place,
  not its arguments; reading them is the pack's.
- **Compare argument types where both are written.** Dropped for now (decision 4): a subtype relation through a type
  outside the repository is not provable from the sources, and a wrong exclusion is a false `complete`.

## Consequences

- The port of import origins gains the two readings, optional as `outsideSupertypes` is, and a pack without them
  answers as today.
- Cost: one reading per call site that stays `name-only` after the bindings of ADR-0079, and one per reached declaration
  those sites name, each asked once for the read.
- A Java declaration whose parameter list the sources do not state (a generated method) accepts any count.
