# ADR-0061: A trace returns the links of requests under deferred steps, and labels a call that may reach a request by what it is

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "Implementa los 3. Es de extrema importancia que se resuelvan bien la relaciones entre frontend -backend y backend -backend", applying the recommendation that a trace returns the links of requests under deferred steps, marked deferred, and labels a call that may reach a request by what it is.
- Supersedes: ADR-0056 decision 3, last sentence ("A step that is itself deferred contributes nothing"), in part.
- Related: ADR-0042, ADR-0051, ADR-0056, RFC-0013

## Context

A route trace through an NgRx `rxMethod` store member returned no link, while the trace of the service the member calls
returned it: the walk marks the member step `deferred`, and the link join skipped every deferred step, although the
request is the same. The skip also looked at the step alone, so a non-deferred descendant of a deferred step counted
as executed.

Separately, a call whose callee summary keeps an uncovered gap (a reassigned function field, an unread source) is read
as a placed site with an unknown target and no request stated. The trace cut it as `effect-unplaced` and wrote
"http effect" from the transport alone, which names a request the extraction never found: 104 of 109 such labels in one
workspace were these calls.

## Decision

1. A step is deferred when it or any ancestor, by parent id, is deferred. The effects and unresolved requests of a
   deferred step go to the deferred place set, so the links they reach are returned marked `deferred: true` ("runs
   later, if at all", ADR-0056). A match an executed occurrence also reaches stays unmarked. This replaces the last
   sentence of ADR-0056 decision 3.
2. A placed site that only stands for a call whose callee may reach a request (transport `http`, unknown target, no
   request stated, no library named, an empty `origins`, a cause place other than the call itself) is cut as
   `unresolved-link` with reason `request-possible`, never `effect-unplaced`. `at` is the call place, worded
   `<file>:<line> call that may reach a request (<cause>)`, then the cause place (the last evidence of the site's
   target); `<cause>` is the site's `diagnostic.cause`; `reach` is `call-at` the first entry. The cut is kept, not
   dropped (ADR-0051): the gap is a real unknown.
3. `effect-unplaced` ("<kind> effect") stays for direct request sites, stated requests (including base-undecided
   ones), message sites and sites naming a library (`via`).
4. A link or unlinked call site the workspace sites at an outer caller (a propagated call site, ADR-0044 decision 7) is
   also returned when the trace expands a body the propagation passed through (an `origins` body of the placed site at
   that caller) and an effect of that body states the request the site states (same method, paths equal segment by
   segment, a `{}` segment standing for any), and the route or unlinked path takes that request. The same execution and
   deferral rules apply, and the match carries `issuedAt`: the effect places (`file`, `line`, 1-based `column`, in the
   traced repository) that issue it. The workspace fact keeps its call sites as they are. An effect that supports
   matches of different destinations says nothing about which one the trace runs, so it establishes none of them: the
   trace returns no link through it rather than a guess. Lead decision under the owner's standing instruction
   (2026-11-13), applying the owner's words above on backend-to-backend relations.

## Consequences

- A frontend route trace through a store member returns the same link as the service trace, marked `deferred`.
- A client counting "http effect" cuts counts only requests the extraction found but could not place.
- A backend trace that starts below the outermost caller of a request (a use case, an adapter) returns the link the
  workspace sites at that caller; a trace from the outermost caller returns it as before.
- `request-possible` joins the closed cut reasons; no schema version changes.
