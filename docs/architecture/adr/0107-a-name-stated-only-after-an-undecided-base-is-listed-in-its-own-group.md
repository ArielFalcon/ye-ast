# ADR-0107: A name stated only after an undecided base is listed in its own group

- Status: Accepted, 2026-11-16, owner
- Decision source: Owner, 2026-11-16: the MCP evaluation b86cb1 review of topology finds that since ADR-0101 the name
  `name-geo-api`, written as the base of `address.api.ts:26` in a clone and served by no repository of the workspace,
  is visible only as a section name and five unresolved call sites, so "nothing says nobody serves it"; the round-3
  specification S2 asks that such a name be neither listed unserved nor dropped silently: `auth`, `protocol` and
  `name-geo-api` go to one explicit group, with no `repository:` decision (ADR-0101 rejected a serving signal).
- Related: [ADR-0101](0101-a-name-stated-only-after-an-undecided-base-is-never-unserved.md) (amended),
  [ADR-0054](0054-a-stated-route-links-when-only-its-base-is-undecided.md) (decision 6),
  [ADR-0075](0075-the-core-names-no-language-or-framework.md),
  [RFC-0014](../rfc/0014-workspace-decisions.md)

**In short:** a name written only after an undecided base and served by no repository gets one explicit group of the
workspace answer, `undecidedBase`, with the call places that write it. The group is not `unserved`, which keeps meaning
"a decided statement and no server", and it raises no `repository` decision. One rule covers `auth`, `protocol` and
`name-geo-api`; no signal separates them, so none is invented.

## Context

ADR-0101 removed these names from `unserved` because that word claims no local repository serves the name, and an
undecided base can be a repository of the workspace whose server routes no reader models (ADR-0054 decision 6). It
rejected any signal that says "served by an unread server": nothing in the sources separates `auth` from `name-geo-api`.
The removal was right; leaving the name nowhere was the defect. A reader of the workspace answer can no longer learn
that a name was written, left undecided by the join, and found no served route.

| Option | Verdict |
|---|---|
| Bring the names back into `unserved` | Rejected: it is the false claim ADR-0101 removed, and `repository:auth` asks a question whose premise is false |
| List a name as undecided only when some signal says who serves it | Rejected: ADR-0101 found no such signal; any heuristic would be a guess presented as a fact |
| One group for every such name, with its places, no decision | Chosen: it states exactly what is known (written, base undecided, no server found) and claims nothing more |

## Decision

1. The workspace answer carries `value.undecidedBase`: the names of a repository that no repository serves (no
   candidate, no link) and whose every statement is a path written after an undecided base, each with the places that
   write it, sorted as the other name lists are. A name that some statement states with a decided authority stays
   `unserved` (ADR-0101 decision 1 is kept); a name a candidate serves is in neither list.
2. `unserved` is unchanged: a name no candidate serves with at least one decided statement.
3. `decisions` raises no `repository`, `gateway` or any other decision for a name of the group: the decision set is
   derived from `unserved` as before. The decisions answer carries the group beside its decisions, `value.undecidedBase`,
   so the answer that lists the gaps also says which written names it did not turn into a question and why.
4. The MCP presentations print the group once, as "names whose base is undecided": a summary lists one line per name
   with its count of places, details list the places, and names that share the same places say them once.
5. The names stay in their repository section's names and their call sites stay in its unresolved list; no cut is
   added (ADR-0101 decision 2).

## Consequences

- `name-geo-api`, `auth` and `protocol` reappear in the workspace answer as one group. The reader decides which of them
  is a server outside the read scope; the engine does not.
- `value.undecidedBase` is a new field of two answers, additive: no schema bump (no consumers yet).
- Expected corpus-gate move: `workspace:+` and `decisions:+` (a new group line in each answer); no other family reads
  the group.

## Not decided here

- Reading the routes of a Node server (ADR-0013 coverage under a second TypeScript framework): once read, such a route
  links the call and the name leaves the group as served.
- A signal that separates a name served by an unread server from a gateway to a clone the workspace lacks; it needs a
  per-repository fact that the server side is read, which no source states today.
