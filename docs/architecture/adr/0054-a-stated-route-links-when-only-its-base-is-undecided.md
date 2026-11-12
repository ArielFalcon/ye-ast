# ADR-0054: A stated route links when only its base is undecided

- Status: Accepted, 2026-11-12, owner
- Decision source: Owner, 2026-11-12, asked whether a request whose route is known and whose base URL comes from
  deployment configuration may link by its route: "Link con basis suffix (Recomendado)".
- Supersedes: the RFC-0011 "Completeness" row "a call site that cannot be told from a candidate, because the evaluator
  cannot resolve the base URL", which kept such a call site a cut unless a gateway prefix was declared.
- Related: ADR-0042, ADR-0051, ADR-0052, ADR-0053, RFC-0011

## Context

Applications inject their base URL from deployment configuration (an environment file a build replaces, a provider
value, a configuration service). The snapshot states the request's verb and the path after that base, and ADR-0052
keeps that knowledge on the call site as `stated`, but the join consumed only complete targets: such a request linked
nothing, even under a declared gateway prefix the RFC said should link it, and was not even listed as unlinked. On a real
workspace of 19 requests, 18 stated their whole path and none linked.

Authority and route are different facts: the authority says which deployment receives the request, the route says which
handler serves it. An undecided authority leaves the first unknown, not the second.

## Decision

1. A call site whose one URL expression is the undecided base followed by text that starts a path segment, with
   run-time values as holes and no other undecided value, states its route. Any other shape states none.
2. Under a gateway prefix in force, declared or inferred, that route links only to a route of the repository the prefix
   routes to, once the prefix is removed, by the gateway rung's own rules.
3. Otherwise it links to the one route of the declared workspace that its path equals, extends through a configured base
   path, or ends with (the base may hold leading segments), at one rung, with its verb and at least one segment both
   state as text. The most specific route of one repository wins; two repositories, or two routes taken equally, are
   ambiguous and never a pick; a route the call could take by a run-time value keeps it undecided.
4. Every such link has basis `suffix`, its confidence, and `authority: "undecided"`, because the base may name a
   deployment outside the declared repositories. The call site also stays listed as unresolved with its stated request,
   since its base remains undecided.
5. Gateway inference reads the first segment such a route states, as it reads a complete target's.
6. A route found nowhere settles nothing: the call site stays an unresolved cut, never `unmatched` drift, since it may
   leave the workspace.

## Consequences

- Workspaces whose base is a deployment value link by route, visibly marked, instead of answering zero links.
- A false link is possible when an undeclared service serves the same verb and path; the basis, the confidence and the
  mark state it, and declaring the gateway or the base removes it.
- `Link.authority` is a new optional field of the link contract (schemas and renderers carry it).
