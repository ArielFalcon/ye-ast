# ADR-0076: A transport is a protocol plugin, and a link inside a repository is kept

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados" (I approve
  every pending recommendation; leave them closed), after "estas propuestas de correccion y mejoras deben ser de forma
  transversal y no parches puntuales" (the corrections and improvements must be cross-cutting, not point patches). On
  2026-11-13 the owner also stated: "Es de extrema importancia que se resuelvan bien la relaciones entre frontend
  -backend y backend -backend" (it is of extreme importance that frontend-backend and backend-backend relations are
  resolved well).
- Related: RFC-0036 (design), RFC-0007, RFC-0011, ADR-0013, ADR-0051, ADR-0060, ADR-0061

**In short:** the way two services talk is a plugin with a registered identity, and the core compares no transport
with a literal. A call that matches a route of its own repository is still classified internal, and is now listed,
followed by impact and returned by trace. A trace run with a workspace continues into the handler of a link that names
exactly one entrypoint.

## Context

RFC-0007 designs a protocol plugin kind that was not built. `transport` is a closed union of two values
(`src/core/domain/topology/call-site.ts:22`), the event grammars a closed union of five, and the core branches on the
literal in 33 places. `src/core/application/topology/workspace-join.ts:47-49` drops every link whose ends share a
repository. A trace returns the links of its requests (ADR-0061) and does not enter the producer.

| Option | Verdict |
|---|---|
| Add a third value to the union when a protocol is needed | Rejected: every one of the 33 branches is edited again each time |
| Treat a repository with several services as several repositories by configuration | Rejected: it asks the user to describe what the sources already state |
| A protocol plugin, internal links kept, trace through a decided link | Chosen |

## Decision

1. A transport is a `ProtocolPlugin` with a registered identity. It owns the grammar of a target, the matching ladder,
   the rating of a match and the class of an unmatched call site.
2. A framework plugin states that a body issues a request or declares a handler and tags it with a protocol identity.
   The topology use case reads the identity and never a literal.
3. HTTP and events are the first two plugins. Their rules move unchanged, and the corpus gate expects no difference.
4. A link whose ends share a repository keeps the class `internal`. It is listed in its own section of `workspace`,
   followed by workspace impact, and returned by trace. Each end states its module where the repository declares
   modules.
5. Decision 4 is preceded by a probe of what each family answers today for that relation, and covers only the
   families that do not report it.
6. A trace run with a workspace expands the handler of a link that names exactly one entrypoint, as a step `via:
   "link"` with its repository, at the revision the workspace pins, under the existing budgets. It crosses as many
   links as those budgets allow; a budget that runs out is an explicit cut.
7. A new protocol enters under ADR-0013. This ADR adds none; the first schema-first protocol is chosen from the
   baseline ledger and the cross-stack class of the outcome control (ADR-0071).
8. The protocol plugin needs only the registered identities of ADR-0075 decision 2 and does not wait for the rest of
   that ADR.

## Consequences

- A schema-first client, gRPC or GraphQL has one place to enter and one contract to meet.
- A repository that holds a client and its server, or two services, shows their relation.
- A trace fact may read several snapshots and lists each one.

## Not decided here

- Host ownership of a literal origin at the exact rung: measured first (RFC-0036, "Not decided here").
- `--workspace` on `impact` and `callers`.
