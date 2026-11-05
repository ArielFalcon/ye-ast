# ADR-0017: A type reached through one of its members expands only through whole-type edges

- Status: Accepted, 2026-11-01, owner; decision 3 superseded by [ADR-0024](0024-one-producer-version-for-every-family.md), 2026-11-05
- Decision source: the owner, 2026-11-01, ordering the plan this record belongs to (translated): "genera un plan
  detallado de implementacion de las soluciones de estos problemas de forma que se corrija de raiz en la arquitectura
  respectando la estructura actual. luego lanza con herdr un agente deepseek 4.1-flash para que aplique el plan". The
  rule is row S5 of that plan, `odd/tasks/mcp-answer-precision.md`, and this record is its decision record.
- Related: [ADR-0014](0014-angular-and-spring-from-own-extractors.md), [RFC-0010](../rfc/0010-impact-queries.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0007](../rfc/0007-extension-model.md)

**In short:** a reached method still pulls in the type that declares it, at the method's depth, but from that type the
walk follows only a subtype (`extends`, `implements`) and the Angular relations of a template that renders it
(`uses-component`, `uses-directive`, `uses-pipe`). Whoever calls, injects, references or instantiates the type joins only
through its own edges, so the blast radius of a method no longer grows with every injector of its class.

## Context

The walk reached a method and, at the same depth, the class that declares it, then expanded the class like any other
node. RFC-0010 justified the first step: routes, components and class-level listeners name the class, not the method.
The second step was never justified on its own and carried everything that names the class: every class that injects it,
every file that imports it, every construction site.

Measured on a real Angular application (`../nname/name-webapp`, 2026-11-01, probes in
`odd/probes/mcp-answer-precision/`), the two largest practical calls show the shape:

| Call | Text | Symbols | Entrypoints | Depth-1 files that name the seed |
|---|---|---|---|---|
| callers/impact `AuthService.getAccessToken` | 21.3 KB | 54 | 24 | 1 of 12 |
| callers/impact `RestClientService.get` | 38.2 / 37.7 KB | 101 / 98 | 31 | n/a |

One file of twelve reached at depth 1 names the method asked about. The class that declares it is one of the reached
nodes; the rest is the injection graph around that class, which an edit inside one method does not change.

The alternative was to keep the row and let a budget cut the noise. A depth or hub bound cannot tell an injector of the
class from a caller of the method, so it cuts both; it also makes the answer's value depend on a bound the caller picks,
which is the opposite of a fact.

qayaba's reader climbs the same way: an entry records the container of a reached method at the same depth and expands it
like any other node (`qayaba-merge-b/engine/src/shared-infrastructure/code-graph/codegraph-store-reader.mjs:206,291`).
The slice-1 acceptance of RFC-0010 asked for "containment parity" with it — everything qayaba reaches, ye-ast reaches.
This record supersedes that criterion for this row: containment parity stays, parity of expansion through the owner of
a reached member does not.

## Decision

1. A type the walk enters only because it declares a reached member expands through `extends` and `implements` edges
   (a subtype depends on it) and through the `uses-component`, `uses-directive` and `uses-pipe` relations (a template
   renders it). It does not follow `injects`, `references`, `instantiates`, an interface bridge, or the importer
   fallback into it.
2. A type that is itself a seed, or that the walk reaches through its own edges, keeps every row of the edge policy.
   The restriction is a property of how the type was reached, not of the type.
3. The rule is data in `EDGE_POLICY.ownerThroughMember`; the producer version digests `EDGE_POLICY`, so the change
   invalidates every stored impact fact instead of letting an old answer survive.
4. Whoever uses a member is still reached through its own call edge, and an unresolved use of the member's name is
   already an `unresolved-link` cut. Nothing that genuinely depends on the edit is dropped.

## Consequences

- A change inside a method reports the callers of the method, the subtypes of its type and the templates that render the
  type. It stops reporting the classes that merely inject the type.
- Two of the largest goods of the baseline above lose most of their noise; the seed's own users stay.
- qayaba keeps its reader unchanged; it receives notice of this record. Ye-ast no longer claims containment parity for
  this row, and RFC-0010 says so where the row is described.
- A reader that wants the injection graph asks for the type itself (`ye_ast_callers` on the class), which still follows
  every row: the restriction only applies to types reached through a member.

## Not decided here

- Whether a reached constructor parameter or field type should join (the RFC-0010 "Deferred" list keeps receiver and
  import scoping of `unresolved-link` open).
- Whether qayaba should align its reader; that is a decision of qayaba's own record.

## Amendment: members used through an injection's binding

The index does not resolve a call made through an injected field (`this.rest.get(...)` stays an unresolved reference
named `this.rest.get`), so restricting the owner alone hid the real callers of an injected service's members behind one
`unresolved-link` cut. The Angular injection reader now records the binding an injection is stored in (a field, a
constructor parameter or a constant). From a reached member `m` of a type `O`, every class that injects `O` with binding
`b` contributes as callers of `m` the symbols that hold a reference named `this.b.m` or `b.m` (`EDGE_POLICY.injectedMemberUses`),
at the relation confidence, and those places leave `m`'s `unresolved-link` cut. An injection bound to no name adds no
caller, and its references stay in the cut.
