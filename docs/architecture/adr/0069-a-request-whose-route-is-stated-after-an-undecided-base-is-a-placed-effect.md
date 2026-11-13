# ADR-0069: A request whose route is stated after an undecided base is a placed effect, marked `authority: "undecided"`

- Status: Accepted, 2026-11-13, lead decision under the owner's standing instruction (2026-11-13)
- Decision source: Lead decision under the owner's standing instruction (2026-11-13) to pick the recommended option, for spec S2 of trace-coverage-followups: "Colocar efectos en frontends con wrapper".
- Supersedes: ADR-0061 decision 3, in part (for the trace, a base-undecided request that states one route, direct or propagated, stops being `effect-unplaced`, and ADR-0061 decision 3's "stated requests (including base-undecided ones)" keeps the cut only for several routes or none); ADR-0054 decision 4, for the trace only (the placed request is no longer also listed in `unresolvedEffects`). The end-to-end tests that pinned the direct case ("without becoming a complete trace effect") are replaced.
- Related: [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md), [ADR-0054](0054-a-stated-route-links-when-only-its-base-is-undecided.md), [ADR-0057](0057-partial-request-strings-keep-what-they-state.md), [ADR-0061](0061-a-trace-returns-the-links-of-requests-under-deferred-steps.md)

**In short:** a call site (a wrapper's caller, or a direct call) whose request states one method and one route after a base the snapshot does not decide,
which is how every frontend that injects its API URL writes a request, is a placed `http` effect of the trace with that route and
`authority: "undecided"`, instead of an `effect-unplaced` cut. The wrapper body that issues the request for several
callers adds no cut when the callers reached in the trace are placed through it.

## Context

Two frontends of the corpus send every request through an own HTTP wrapper whose base URL is injected
(`ApiService.post(path)`, `RestClientService.post(path)`). The topology propagates each wrapper request to its caller
(ADR-0044 decision 7) and links it (`basis: suffix`, `authority: "undecided"`, ADR-0054), but a trace of the caller
answered 0 effects: the caller site and the wrapper's own parametric call were both `effect-unplaced`.

| Case | Links | Effects before | `effect-unplaced` before | Effects after | `effect-unplaced` after |
|---|---|---|---|---|---|
| realworld service | 1 | 0 | 2 | 1 | 0 |
| realworld store | 2 | 0 | 4 | 2 | 0 |
| realworld ui | 2 | 0 | 4 | 2 | 0 |
| nname service | 1 | 0 | 3 | 1 | 0 |
| nname store | 1 | 0 | 6 | 2 | 0 |

Root cause: `effectOf` (`src/core/domain/trace/trace-effects.ts`) turned a site into an effect only when its target was
`complete`. An undecided base makes the target `unknown` even when the request states its verb and route, which the
topology already reads (`undecidedAuthorityTargetsOf`) to make the link. The trace therefore cut the caller and listed
its stated request as unresolved, while the same fact placed a link. The wrapper-body cut is the wrapper's own site, whose
destination is a parameter: `placeEffects` already drops it when every origin the caller's propagated site names is
covered by a placed effect, so placing the caller is enough.

## Decision

1. A call site, direct or propagated from a wrapper (ADR-0044 decision 7), whose target is not complete and whose stated
   request yields exactly one route through
   `undecidedAuthorityTargetsOf` (the owner of that fact) is an `http` effect with `target: { method, path }`, the route
   as the code states it after the base, and `authority: "undecided"`, the same marker a link carries. The trace reads the
   topology's request and never derives one.
2. Several routes (alternative URL expressions), a route not stated, or any other unknown stays `effect-unplaced` with its
   stated request in `unresolvedEffects`, as before.
3. The rule reads the request, not the call's shape: a direct site and a propagated one give the same effect. A site with
   a complete target is unchanged byte for byte.
4. A wrapper body's own call is not an additional cut when every origin of a placed propagated site is covered
   (existing rule of `placeEffects`); a caller whose request is not placed keeps its own cut, so an unresolved caller is
   never hidden by a placed one.
5. `TraceEffect` (http) gains the optional `authority`; the composition schema and the renderers carry it (the text says
   `base-url undecided`). No field is removed or renamed and no schema version changes.

## Consequences

- A frontend trace through an own wrapper lists the requests a UI action issues, each with the link the workspace admits.
- The link join is unchanged: an effect at the caller's exact place establishes the link as the unresolved request did.
- A trace whose only unknowns were undecided-base requests is now `complete`: the effect states that its destination is
  undecided, so completeness no longer counts it as a cut.
- Expected corpus movement: trace effects (http, up) and `effect-unplaced` cuts (down) in frontend cases; links do not move.

## Not decided here

- Several routes at one site (a conditional URL) stay unplaced; placing each as an alternative needs its own decision.
- Which of several callers of one wrapper a path-parametric request belongs to is the workspace join's, not the trace's.
