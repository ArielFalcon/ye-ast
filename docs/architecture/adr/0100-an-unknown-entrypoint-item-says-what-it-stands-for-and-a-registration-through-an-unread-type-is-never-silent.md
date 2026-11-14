# ADR-0100: An unknown entrypoint item says what it stands for, and a registration through an unread type is never silent

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner, 2026-11-14: "Acepto" (I accept), on the transversal fix plan of MCP evaluation run
  20261114T125655Z-c68fc8, whose decision D5 reads: a scanned bean that extends a library type whose source is absent
  gets an unknown entrypoint item only after the marker volume is measured on the corpus and shown to be small, each
  marker naming a plausible entrypoint.
- Related: [ADR-0048](0048-a-framework-invoked-implementation-is-an-entrypoint.md) (decision 4 extended),
  [ADR-0013](0013-coverage-grows-only-with-evidence.md), [ADR-0073](0073-a-classpath-the-host-declares-is-a-library-signature-source.md)

**In short:** an unknown item of the entrypoint readers carries a `subject`: the kind of entrypoint the construct may
be, the symbol at its place and the annotation, supertype or library call that raised it. JobRunr recurring jobs are
read from plugin data. A scanned bean that extends a class whose source is absent is one unknown item at the class,
because the registration the base holds (a NATS subject, for one) cannot be read; a declared classpath reads it and
retires the item.

## Context

In the evaluation run, `name:entrypoints:01` answered `complete` with three `unknown (no-extractor)` items that carry
only evidence ranges. Two point at a publisher and an audit resolver (`@Component` classes that implement an interface
whose own supertype is absent, in a module whose build declares an OpenAPI generator), and nothing says which
entrypoint they stand for. Two real entrypoints were absent under `complete`: a NATS listener that inherits its
subject from a base class whose source is not in the repository (`nats-listeners.ts` documents the form as not read
and emits nothing), and a JobRunr recurring job registered through `RecurringJobBuilder.withJobLambda(this::syncUsers)`
which no reader knows. ADR-0048 decision 4 says "never a silent absence" for what its data covers; these two forms are
outside that data.

Measurement for the second form (D5), on every Java repository of the corpus, read-only, with the extractor's own
supertype closure: scanned beans whose superclass no source declares and the platform does not own.

| Repositories | Java files | Markers it would add | Plausible entrypoints |
|---|---|---|---|
| 8 of 11 | 1,619 | 0 | not applicable |
| 3 of 11 (the NATS-based services) | 419 | 5 (2, 1, 2) | 5 of 5: each extends the one messenger base `ListenerMessageDelegate` and is a listener |

A wider rule (any unresolved superclass, platform ones included) adds six more on two repositories, all
`WebSecurityConfigurerAdapter` or `GlobalMethodSecurityConfiguration` configuration classes: not entrypoints, so the
rule keeps the extractor's own definition of an unread supertype, which excludes the platform packages.

## Decision

1. `Finding` of kind `unknown` gains an optional `subject`: `{ candidate?, symbol?, raisedBy? }`, where `candidate` is
   the entrypoint kind the construct may be (absent when the construct does not say), `symbol` is the declaration at
   the place and `raisedBy` is the annotation, supertype or library member that raised the item. The field is
   additive; `reason` and `evidence` keep their meaning, and the readers of unknown items that already know a subject
   (listeners, jobs, callbacks, routes, delegates) state it.
2. JobRunr recurring jobs enter as plugin data: a call on `RecurringJobBuilder` that names a method reference as the
   job lambda is a `job` entrypoint whose handler is that method; its trigger is the `withCron` argument of the same
   builder chain, and a trigger the sources do not give leaves the item `unknown` with the handler as its subject.
3. A scanned bean, concrete, that extends a class no source declares and the platform does not own is one unknown item
   `no-extractor` at the class, with the supertype as `raisedBy`, unless a reader found a listener in it. When the
   host declares library sources that hold the base, the supertype is no longer unread and the item is not raised.
4. A reader that finds nothing to retire an item keeps it: a class-level unknown that stands because the class
   mapping may combine with an absent interface (RFC-0007 row S5) is not redundant, and is out of this decision.

## Consequences

- The three unknowns of the evaluation case name their candidate kind and symbol; the listener and the job appear.
- Expected corpus-gate move: `entrypoints:±` (new items, new optional field). Other families do not read unknown
  entrypoint items; the gate confirms it.
- A bean that extends an unread class and is not a listener adds one item; the corpus has none, and a declared
  classpath (ADR-0073) is the precise route for a repository that has many.

## Not decided here

- JobRunr forms other than the builder with a method reference (`scheduleRecurrently` with a lambda, `@Recurring`).
- Retiring the class-level unknown of a contract-joined controller that has a class mapping.
