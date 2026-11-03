# ADR-0009: Route data in two levels

- Status: Accepted, 2026-10-29, owner; decision 4 corrected on 2026-10-30 (adds the codegen case and the upstream
  candidate) and confirmed by the owner the same day (translated): "I confirm the corrections"; decision 1 narrowed by
  [ADR-0013](0013-coverage-grows-only-with-evidence.md) on 2026-10-30 to frameworks without their own extractor, and
  the known gaps extended the same day ([ADR-0014](0014-angular-and-spring-from-own-extractors.md))
- Decision source: the owner accepted the two levels in the design session of 2026-10-29 (the session's decision log,
  entry "Route tables: two layers"); the owner's exact words were not captured. The discussion started from codegraph's
  resolver extension point not being exported; the owner then asked to record "all the decisions taken" (translated) in
  ADRs and RFCs.
- Related: [ADR-0004](0004-codegraph-dependency-with-own-fact-layer.md),
  [ADR-0013](0013-coverage-grows-only-with-evidence.md), [ADR-0014](0014-angular-and-spring-from-own-extractors.md),
  [RFC-0003](../rfc/0003-codegraph-integration.md), [RFC-0004](../rfc/0004-deterministic-map.md),
  [RFC-0007](../rfc/0007-extension-model.md)

**In short:** breadth comes from codegraph (which route reaches which code, about 20 frameworks); depth comes from
ye-ast's own extractors (matching order, guards, redirects, lazy children, fallbacks), written per framework only where
a fact needs it. Where codegraph misses breadth, ye-ast supplies the routes itself (decision 4).

## Context

"Which URL or endpoint is served by which code" has two levels:

| Level | Answers | Source |
|---|---|---|
| Breadth: route to target | `/shops/:id` → `ShopComponent`; `GET /orders` → `OrderController.list` | codegraph route nodes (name, file, line, target) for Angular, React Router, TanStack, Vue Router/Nuxt, SvelteKit, Next.js, Expo, Express/Fastify, NestJS, Spring, Laravel, Django/Flask/FastAPI, Rails, ASP.NET, Go, Play |
| Depth: router semantics | matching order, guards, redirects, lazy children, fallbacks; base vs head declarations | ye-ast extractors; qayaba has one for Angular |

Known breadth gaps in codegraph 1.6.2:

| Gap | Evidence |
|---|---|
| No Angular route nodes when the routes are typed through an alias of `Route[]` (`type AppRoutes = Route[]`) or a type derived from `Route`, or built by a helper: an array is recognised only after a fixed list of shapes | codegraph 1.6.2 experiment (2026-10-29): `Routes`-typed arrays give route nodes, the alias gives none. On a real Angular 21 app, 0 route nodes for 43 screens (2026-10-30); platform bundle `lib/dist/resolution/frameworks/angular-router.js:106,350` |
| Single-`Route` constants and named outlets are missed: 50 of 57 routes on a second real Angular app | experiment, 2026-10-30 |
| Spring mappings are read by a regular expression: a file whose class `@RequestMapping` is not a literal loses every route, with no `unknown`; a second class in a file inherits the first one's prefix; handlers are linked by method name; `method = {GET, POST}` keeps GET only; composed annotations, `${...}` placeholders and Spring 7's `version` are lost; `@FeignClient` mappings become server routes | platform bundle `lib/dist/resolution/frameworks/java.js:203-286`; fixtures and four real Spring applications (2026-10-30) |
| 0 route nodes on a Spring application generated from an OpenAPI contract: the annotations live in the generated `*Api` interface | qayaba@4105c582 `odd/tasks/codegraph-migration.md:185`. On two real codegen services the generated interface is absent from a source snapshot, and `operationId` equals the implementing method's name in 15 of 15 operations (2026-10-30) |
| 0 frontend-to-backend edges where the URLs are composed, on the three applications qayaba measured; the engine synthesises such an edge only for a literal URL | qayaba@4105c582 `odd/tasks/codegraph-migration.md:240`. On a real Angular app, 0 of 86 HTTP call sites linked to its 102 Spring routes: only a URL argument that starts with a quote or a backtick is read (platform bundle `lib/dist/resolution/tier-synthesizer.js:162-173`, 2026-10-30) |

codegraph's `registerFrameworkResolver` is not exported at runtime
([ADR-0004](0004-codegraph-dependency-with-own-fact-layer.md)). Extraction runs in parse worker threads, each with its
own resolver registry (codegraph 1.6.2 platform bundle `lib/dist/extraction/parse-worker.js:88`): a resolver registered
through an internal path is ignored by `indexAll`, while `indexFiles` and `sync`, which run on the main thread, honour
it (experiment, 2026-10-29). ye-ast cannot plug its own resolvers into codegraph.

## Decision

1. Breadth facts come from codegraph route nodes, through the codegraph adapter.
2. Depth facts come from ye-ast extractors declared per framework in the extension model; TypeScript frameworks use the
   compiler API ([ADR-0008](0008-typescript-compiler-api-source.md)), other languages use tree-sitter.
3. A depth extractor is written only when a fact needs it (for example "this guard change affects these routes").
4. Where codegraph misses breadth, ye-ast supplies the routes and the gap is a candidate upstream contribution:
   - the alias case: the framework's depth extractor supplies the routes too;
   - the codegen case: the HTTP protocol plugin ([RFC-0007](../rfc/0007-extension-model.md)) supplies the routes of an
     interface generated from an OpenAPI contract, from the contract joined with the classes that implement that
     interface.
5. Each fact states which level produced it, and a framework with neither level answers `no-extractor`.

## Consequences

- The deterministic map's first slice needs more than breadth: the Angular depth extractor (the alias case) and the HTTP
  protocol plugin's contract-sourced routes (the codegen case), plus declared resources and the graph closure. Its
  parity diff in [RFC-0004](../rfc/0004-deterministic-map.md) checks the result.
- A frontend call joined to a backend route is a service link, which stays in ye-ast's own layer
  ([ADR-0004](0004-codegraph-dependency-with-own-fact-layer.md) decision 3): codegraph synthesises such edges only for
  literal URLs.
- Every framework with a depth extractor carries conformance fixtures.
