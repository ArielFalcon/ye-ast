# ADR-0060: A request to a host evidenced as one repository's, matching no route, is unmatched

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "Aplica lo que recomiendas en el item 3", applying the recommendation that a request to a host evidenced as one repository's, matching no route, is unmatched.
- Supersedes: RFC-0011 rung 4 and its failure table only where a call that names a host is always `external`.
- Related: ADR-0051, ADR-0054, RFC-0011

## Context

Rung 4 of the ladder answers `external` for every call that names a host and matches no route. Measured on real
workspaces, that dropped requests silently where the host is the workspace's own: 24 requests to
`http://localhost:8080/api/v1/...` (the host every link of that application goes through) and a `POST` to
`http://ms-users.b2c:8080/users/{id}/quote` whose authority is the one a link into the same service already uses. A miss
the workspace can evidence is drift and must be explicit (ADR-0051).

## Decision

1. The join infers, beside the gateway prefixes, the origins (scheme and authority) attributed to one repository: an
   origin belongs to repository R when at least one decided HTTP call under it links to R and no call under it links to
   another repository.
2. A call whose origin is attributed to a repository and that no rung matches answers `unmatched`, or `could-match`
   when a rung could still take it, instead of `external`. Its name is the full URL, as for any `unmatched` call.
3. An origin with no link, or one whose calls link to two repositories, is attributed to none, and a call to it that
   matches no route stays `external`.
4. Completeness is unchanged: the join reads the complete route findings only, and `unmatched` never depended on an
   inventory being complete. This decision adds no completeness rule.

## Consequences

- Fewer `external` and more `unmatched` entries in `unlinked`; no link field and no schema change.
- An origin that no call of the workspace links through stays external: the boundary of the workspace is still its
  declared repositories.
