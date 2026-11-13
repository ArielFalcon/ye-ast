# ADR-0066: The answers list no duplicate unresolved entry, count template and receiver cuts by cause, and refuse unusable controls

- Status: Accepted, 2026-11-13, lead decision under the owner's standing instruction (2026-11-13)
- Decision source: evaluation 20261113T0004Z hypotheses 6, 8 and 9 (S21 of `odd/tasks/multirepo-quality.md`); on each fork the recommended option was taken.
- Related: ADR-0051, RFC-0017, RFC-0005

## Context

The evaluation found 31 exact duplicate lines among 412 unresolved call sites of one workspace and an unresolved
request listed twice in a trace. The two entries of each pair differ only in evidence. One call written once in a
caller reaches a wrapper that holds two transport primitives (for example an `observe: 'response'` branch and the
default branch), so the extraction reads two call sites at the same place with the same stated request; each was mapped
to its own unresolved entry, in the workspace section and in a trace step by two separate writers. Evidence lists also
repeated places (`api.service.ts:9, api.service.ts:9`).

A trace of a page cut 38 of 43 calls as `page-unplanned`, one line per template expression name. A gateway that names
a repository outside the workspace was accepted and matched nothing. `answerBytes: 0` answered `isError` with no
content. The unknown-revision guidance said it could not tell which repository's revision failed.

## Decision

1. `gatherUnresolvedCallSites` (domain `topology/call-site.ts`) is the one owner of reading unresolved entries that
   differ only in evidence as one entry: the evidence of all of them, each place once, first-seen order, entries in the
   order of their first occurrence. The workspace section and the trace steps both build their lists through it. No
   renderer deduplicates. Entries that differ in any other field stay separate.
2. A trace summary counts the calls of `page-unplanned` and `receiver-unproven` (each with its sub-reason) as one line,
   `calls in files, names`, when the cause holds several name lines and that line is shorter than theirs (RFC-0017
   counted elision; no size threshold). Details lists every place; every other cause keeps its line per name.
3. A workspace gateway whose `repo` is not the launch repository or a member is refused with the typed fault
   `unknown-gateway-repository` (`repo`, `entry`; protocol code -32027). It applies to a persisted manifest too; a
   replay answers `workspace-replay-mismatch` first, as for every other declaration change.
4. A request `answerBytes` of 0 is the typed fault `invalid-answer-bytes`, with content that names the control. A host
   limit of 0 keeps its `answer-over-bound` refusal.
5. An `unknown-revision` of a workspace member carries the member in its detail (``repository `id`: ...``), and the
   guidance stops saying the fault cannot name the repository when it does.

## Consequences

- Section unresolved counts fall by the merged entries; the `undecided` count in the status line follows.
- A persisted manifest with a stale gateway now fails loudly instead of matching nothing.
- A fault detail carries the member id by text convention (`inRepository`, `namesRepository`), because the shared fault
  port has no member field; a typed field is the next step if more faults need it.
