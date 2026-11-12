# ADR-0058: The suffix rung never lets a stated text fill a route variable

- Status: Accepted, 2026-11-12, owner
- Decision source: Owner, 2026-11-12: "Aplica loque recomiendes para todo lo pendiente", applying the recommendation that the suffix rung never lets a stated literal fill a route variable and never cuts a call that states its origin.
- Supersedes: RFC-0011 question 3 only where it lets the `suffix` rung do either.
- Related: ADR-0013, ADR-0054, RFC-0011

## Context

The `suffix` rung (one path ends with the other, at confidence 0.5) produced two false links, measured on real
workspaces:

1. A suffix match let a text the call states fill a route parameter, as `daily-menus` filling `{id}` of
   `GET /restaurants/{id}`. The measured web call `GET <undecided base>/name-restaurants-api/restaurants/daily-menus`
   turned out to reach that route through its inferred gateway prefix, where the path after the prefix equals the route
   and the request really dispatches to it (the consumer's path drifted from `GET /daily-menus`); that link stays.
2. An Angular frontend whose base is the literal `http://localhost:9966/petclinic/api/` (another backend's address)
   linked 10 of 10 calls to microservice routes such as `GET /owners`, by cutting the leading segments of a path the call
   states completely.

## Decision

1. At the `suffix` rung, a segment the call states as text never fills a route variable segment: a parameter
   (`{id}`), a single-segment wildcard, or a segment that is only a run-time hole. A value the call fills at run time
   still binds a parameter, so `[undecided base]/api/articles/{}` links to `GET /articles/{slug}`. The exact and
   base-path rungs keep letting a text fill a parameter: there it is real dispatch. With an undecided base, the rule
   applies to the suffix part of the combined rung only.
2. A call that states its origin (scheme and host) states its whole path: the `suffix` rung cuts neither the route nor the
   call. A declared or inferred gateway prefix is unaffected.

## Consequences

- Fewer `suffix` links; no link field and no schema change. Calls that lose their link are reported unmatched.
- A call that reaches `/restaurants/{id}` with `daily-menus` as the id only by cutting leading segments is no longer
  linked; behind a gateway prefix, or with equal paths, it still links, since there the request dispatches to that
  route.
