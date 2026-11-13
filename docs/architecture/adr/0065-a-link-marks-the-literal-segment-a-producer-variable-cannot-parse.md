# ADR-0065: A link marks the literal segment a producer path variable cannot parse

- Status: Accepted, 2026-11-13, lead decision under the owner's standing instruction (2026-11-13)
- Decision source: Lead decision under the owner's standing instruction (2026-11-13) to apply the lead's recommendation to the pending items of the multirepo-quality work (S23, evaluation hypothesis 7). The owner has not chosen between alternatives for this decision.
- Related: [ADR-0058](0058-the-suffix-rung-never-lets-a-stated-text-fill-a-route-variable.md), [RFC-0011](../rfc/0011-cross-repository-impact.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md)

**In short:** where a request states a literal segment that fills a path variable of the matched route, and the producer declares that variable with a type that parses its text strictly (`UUID`, the integer and the floating types) and cannot parse that segment, the link keeps its place and gains a `drift` field naming the segment, the variable and the type. Nothing else about the link changes.

## Context

ADR-0058 keeps a link when a stated text fills a route variable on the exact, base-path and gateway rungs, because there the request really dispatches to the route. The measured workspaces hold three such links that dispatch and still fail at run time (confirmed from source):

- nname `getDailyMenus`: `GET /restaurants/daily-menus` reaches `GET /restaurants/{id}`, whose `id` is a `UUID` (the generated contract interface, implemented by `RestaurantsController.getRestaurantDetail(UUID id, ...)`); the conversion fails.
- shopizer `variation.service.ts:29`: `GET /v2/private/product/variation` reaches `GET /api/v2/private/product/{id}`, `@PathVariable Long id` (`ProductApiV2.java:147-150`).
- shopizer `customer.service.ts:55`: `PUT /v1/private/customer/password` reaches `PUT /api/v1/private/customer/{id}`, `@PathVariable Long id` (`CustomerApi.java:71-74`).

The link is mechanically correct and semantically drifted: removing it would hide a real dependency, and presenting it unmarked would call it healthy.

## Decision

1. A producer's route may declare the types of its path variables (`parameterTypes`, by variable name). The Spring extractor writes them where it already reads the handler: the written type of each `@PathVariable` parameter, named by the annotation's `value` or `name`, else the parameter's. For a handler that implements a generated contract interface (RFC-0007 row S5) and carries no annotation, a parameter named like a variable of the contract path is that variable.
2. Only a closed set of parse-strict types is recorded: `java.util.UUID` (a name that resolves to it, and no repository type of that name), and the integer and floating primitives and their `java.lang` boxes. Any other type, any other language or framework, and any name the sources do not decide state no type. "Unknown" is not drift.
3. When a link is made, the literal segments of the request that fill a variable segment of the route (`{id}` or `{id:regex}` as a whole segment) are checked against its declared type. The route is lined up with the end of the call, since a base path, a gateway prefix and a suffix cut only leading segments; a route that takes the rest of the path is not lined up. A segment the type cannot parse is listed in the link's optional `drift`, in path order, as `{ segment, parameter, type }`. A segment filled at run time, or one the type parses, is never listed.
4. The link is never removed, never moved to another rung and never made silent: `drift` is not part of the link's identity, its confidence and basis do not change, and every answer that lists the link shows the drift beside the basis (`drift: "daily-menus" fills id (UUID)`).
5. The readings of the types are the permissive side of Java's (an integer is an optionally signed digit run, a floating value any decimal, exponent or `NaN`/`Infinity` form, a UUID five dash-separated groups of one to sixteen hex digits), so a marked segment is certain not to parse. A value out of the range of the integer type is not marked.

## Consequences

- `Link` and `HttpRoute` each gain one optional field; no schema version changes, since the fields are absent unless a mark exists and the MCP has no consumers (owner standing rule).
- The families that move are those that list workspace links of Spring producers with typed path variables: links with a literal request segment in a variable position gain a mark; no link appears or disappears.
- A producer whose variable type is declared outside the handler's own parameters (an interface's `@PathVariable` that an override repeats unannotated, a custom converter, `String` parsed by hand) is not marked; that is a miss of the mark, never a false one.
