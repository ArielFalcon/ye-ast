# ADR-0050: One request summary per declaration

- Status: Accepted, 2026-11-09, owner
- Decision source: Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (settle every open question as recommended), after "aplica el orden que recomiendas" and "los ADR recogen decisiones mas acotadas referentes a un RFC".
- Related: [RFC-0028](../rfc/0028-value-flow-through-wrappers.md) designs this decision; ADR-0041, ADR-0042, ADR-0044, ADR-0045

**In short:** Requests and responses are read through a per-declaration summary computed once and applied at every call, so a project's REST wrapper keeps its base URL and a response keeps flowing through stores and derived signals.

## Context

Value-flow items failed because a wrapper's request is read where it is written, never where it is called, and the response flow starts only when the callee is named like an HTTP verb. RFC-0028 holds the evidence and units.

## Decision

1. One method summary per declaration, computed by a monotone fixpoint over the snapshot's call edges, is the only place a request's parameters and a response's container are read (extends RFC-0021 S1 to every pack).
2. A call site is the summary applied at the call: the wrapper's own base, constants and fields are part of the target.
3. An ambiguous or unreadable summary is a cut at the call, never a merge and never a silent absence.
4. One module answers "is this call a request of the project" for the TypeScript pack: `createRequestCallLookup`; the flow walker, the request-origin reader and ADR-0044 V5.2 call it, and name-based predicates are deleted.
5. A value crossing a binding construct (derived signal, resource, form control) is a carrier; a construct outside the pack's table is a named frontier.

Decision 3 is partially superseded by [ADR-0052](0052-request-knowledge-is-independent-of-enumeration-completeness.md):
identified request occurrences are retained independently of enumeration completeness, with relevant gaps still blocking
the conclusions they can invalidate.

## Consequences

- The delivery units, their order and their tests are in RFC-0028, and each unit names the units of other RFCs it waits for.

## Not decided here

- Source-backed injection-token values are defined by [ADR-0053](0053-multi-repository-relations-retain-their-proof-context.md).
