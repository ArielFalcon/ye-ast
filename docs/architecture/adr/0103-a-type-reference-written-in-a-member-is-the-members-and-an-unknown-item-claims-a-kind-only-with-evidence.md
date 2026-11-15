# ADR-0103: A type reference written in a member is the member's, and an unknown item claims an entrypoint kind only with evidence

- Status: Accepted, 2026-11-15, owner
- Decision source: Owner, 2026-11-15: "Si" (yes), approving the second fix round of MCP evaluation run
  20261114T190541Z-a57733 (review findings N1 of `reviews/callers.md` section 4 and N1 of `reviews/inline.md` "New
  findings", which regressed after [ADR-0100](0100-an-unknown-entrypoint-item-says-what-it-stands-for-and-a-registration-through-an-unread-type-is-never-silent.md)).
- Related: [ADR-0017](0017-owner-of-a-member-expands-only-whole-type-edges.md) (extended),
  [ADR-0100](0100-an-unknown-entrypoint-item-says-what-it-stands-for-and-a-registration-through-an-unread-type-is-never-silent.md)
  decision 1 (extended), [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md)
  decision 3, [ADR-0013](0013-coverage-grows-only-with-evidence.md)

**In short:** a type reference the Java relations reader writes inside a method of the referring type, where the graph
already holds an edge from that method to the target, is that method's dependence: the type is reached as the method's
owner and follows only whole-type rows, so whoever merely holds the type is no longer reached. An unknown item states
the entrypoint kind it may be only when the sources give a reason; a method of a component that implements an absent
interface under the generator signal alone states none.

## Context

Two defects of the evaluation rerun share one reading: a construct is taken for more than the evidence says.

1. `name:impact:02` changes a profile-picture upload DTO. The interface that declares the use case names the DTO in the
   signature of one method. The Java relations reader writes that reference as a relation of the interface (a type), and
   the graph holds the same reference as an edge of the method. The relation reached the interface through its own edge,
   so the interface followed every row (ADR-0017: "a type that is reached through its own edges keeps every row"), and
   every class that holds a field or a constructor parameter of the interface was reached with it: 4 symbols and, since
   ADR-0100 added unknown items at class level, 2 entrypoints (a recurring job and an event listener) that call other
   methods of the interface. Neither calls the changed method.
2. `name:entrypoints:01` prints `unknown for http-route <Class>.<method> (raised by <Interface>)` for methods of
   components such as a domain-event publisher and a current-user resolver. The label comes from the delegate rule: a
   component that implements an interface no source declares, in a module whose build declares a source generator,
   has every public method as an unknown item (ADR-0062 decision 3 states that a library interface is then
   indistinguishable from a generated one). `unknownAt` wrote the candidate `http-route` for every such item. The
   foreign-endpoint rule that shares `unknownAt` is not at fault: a method it reads carries a JAX-RS, Micronaut or
   Quarkus HTTP annotation, which is the evidence.

Measurement, read-only, on the `name` repositories (five Java services), with the extractor's own reading: the delegate
rule raised 11 items, none for an interface named `*Delegate` (`DomainEventSubscriber`, `CurrentUserResolver`), all
labelled `http-route`.

## Decision

1. In `callers` and `impact`, a `references` relation whose source is a type is not a dependence of the type when one
   of the type's methods holds the place of the relation and the graph holds an edge from that method to the target
   (calls, instantiates or references). The method carries the dependence; the type is entered as the owner of the
   method, which ADR-0017 limits to subtypes and templates. A relation no method of the type holds an edge for (a
   field, a constructor the graph lacks, a method the graph does not place) stays the type's, so no recall is traded
   for the rule.
2. `unknownAt` takes the candidate kind from its caller. A caller states `http-route` where the reading proves a
   handler of an HTTP server (a controller's method, a method that carries a foreign HTTP annotation). The delegate rule
   states it when the absent interface is named `*Delegate` or the method is named by an `operationId` of a contract
   document of the repository, and otherwise states no candidate: the item keeps `reason`, `evidence` and `raisedBy`.
3. The reached-entrypoint text of `impact` writes each observation with its subject (ADR-0100 decision 1 renders it for
   the entrypoints text) and prints an observation that reads the same as an earlier one of the same entrypoint once.

## Consequences

- `name:impact:02` loses the 4 false symbols and the 2 false entrypoints; the interface and its implementation stay
  reached through the changed method. A class that names the changed type itself in its field still reaches its own
  dependents.
- Expected corpus-gate move: `impact:-` and `callers:-` (fewer reached types), `entrypoints:±` (the subject loses its
  candidate for delegate items), `workspace:-` (workspace answers embed them). Other families do not read these.
- The marker count does not change; the 11 items of the measurement say what raised them and no longer claim a kind.
  Retiring them (a declared classpath holds the library interface, ADR-0073) stays the precise route.

## Not decided here

- Whether a method that implements a library interface under the generator signal should be an item at all. Dropping it
  would lose a generated handler of a repository that names its delegates otherwise; telling them apart needs the
  generated interface or its contract, which `operationId` covers only when a contract document is in the repository.
- The same placement for relations other than `references` (Angular `injects`, template relations), which the graph does
  not hold as member edges.
