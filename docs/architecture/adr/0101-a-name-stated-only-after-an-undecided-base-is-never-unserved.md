# ADR-0101: A name stated only after an undecided base is never unserved

- Status: Accepted, 2026-11-15, owner; amended by [ADR-0107](0107-a-name-stated-only-after-an-undecided-base-is-listed-in-its-own-group.md), which lists such a name in its own group
- Decision source: Owner, 2026-11-15: "Si" (yes), approving the second fix round of MCP evaluation run
  20261114T190541Z-a57733, whose finding workspace-N1 (major, regression) reads: the route a repository's own server
  serves is listed under "no local repository serves". The owner's rule for the unit: never say "no local repository
  serves" for a name whose server side is outside the declared or read scope; say an explicit cut or unknown instead,
  and when the server route is read, link it.
- Related: [ADR-0054](0054-a-stated-route-links-when-only-its-base-is-undecided.md) (decision 6),
  [ADR-0075](0075-the-core-names-no-language-or-framework.md),
  [ADR-0013](0013-coverage-grows-only-with-evidence.md), RFC-0011

**In short:** a path a call states after an undecided base still enters the workspace as an outward name, and still
links when a route read in the workspace takes it. When none does, the join settles nothing (ADR-0054 decision 6) and
the name is not "unserved": that word claims no local repository serves it, and an undecided base can be a repository
of the workspace whose server routes are not read. The call stays one unresolved call site, which already says its base
is undecided. A name some call states with a decided target, or that a configuration, a dependency or a remote states,
stays unserved as before.

## Context

In the evaluation rerun, `name:workspace:01` listed the path prefix `auth` (`client-token-web.strategy.ts:48-52`)
under "no local repository serves (116)" and `name:decisions:01` raised the `repository:auth` decision, although
`name-webapp` serves `GET /auth/client-token` itself (`src/server.ts:57-61`). The cause is two rules that are each
right and together wrong:

- ADR-0054, as extended by the transversal fix plan (unit U5), makes the path stated after an undecided base an outward
  name, so a gateway prefix such as `name-geo-api` shows.
- The join finds no route for it, because the web app's Node server is outside the declared coverage (frameworks
  angular and spring read no Node server route), and ADR-0054 decision 6 already says a route found nowhere settles
  nothing, since the base may name a deployment the workspace does not read.

The name loop of `workspace-queries.ts` read "a name no candidate serves" as "unserved" without asking whether the join
could have decided it. Three names of the corpus workspace have this shape and nothing else tells them apart: `auth`
(served by the web app's own unread server), `protocol` (a middle segment of an identity provider's URL) and
`name-geo-api` (a gateway service no clone holds). Their call sites are identical: an undecided base followed by text.

| Option | Verdict |
|---|---|
| Keep the three unserved and rely on the reader to discount | Rejected: it is the false statement of the finding, and `repository:auth` asks the user a question whose premise is false |
| Detect a repository's unread server side by a framework or a dependency | Rejected: the core names no framework (ADR-0075), and no signal in the sources says a repository has routes no reader models |
| Withhold "unserved" from a name whose every statement is after an undecided base | Chosen: the claim needs a decided authority; the undecided call stays the explicit unknown |

## Decision

1. A name is listed as unserved only when no candidate serves it and at least one statement of it has a decided
   authority: a call site with a decided target (or a published destination), or what a configuration, a dependency, a
   registry or a remote states. A name whose every statement is a path stated after an undecided base is never listed
   as unserved.
2. Such a name stays in its repository section's names, keeps its candidates when a link lands (basis `link`), and
   feeds gateway inference and matching as before. Its call sites stay in the unresolved list with their stated
   request; no cut is added, since each already says its base is undecided.
3. `decisions` reads the same `unserved` list, so no `repository` decision and no `gateway` decision is raised for such
   a name; no other rule of the decision set changes.

## Consequences

- `auth` and `protocol` leave the unserved list and the decisions of `name`. `name-geo-api`, a real gap, leaves them
  too: nothing in the sources separates it from `auth`. It stays visible as the section name and as five unresolved
  call sites that state its route. Serving it needs either a declared gateway for a repository the workspace holds or a
  decided base.
- Expected corpus-gate move: `workspace:-` and `decisions:-` (fewer unserved names and `repository` decisions). Other
  families do not read the unserved list; the gate confirms it.
- Fixed here as the same defect of the same list: one call site reached twice through two callers is one unlinked item,
  its `propagatedThrough` places gathered (workspace-N2), as links already gather theirs.

## Not decided here

- Reading the routes of a Node server (ADR-0013 coverage under a second TypeScript framework, ADR-0075 decision 7);
  once read, such a route links the call and the name is served.
- A qualified statement for a name no read route takes under an undecided base, if the owner wants the geo-api gap
  back: it needs a per-repository fact that the server side is read, which no source states today.
