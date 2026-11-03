# RFC-0004: The deterministic map

- Status: Draft, 2026-10-29
- Related: [RFC-0002](0002-facts-contract.md), [RFC-0003](0003-codegraph-integration.md),
  [RFC-0007](0007-extension-model.md), [RFC-0009](0009-extraction-from-qayaba.md),
  [ADR-0009](../adr/0009-route-data-in-two-levels.md), [ADR-0010](../adr/0010-trust-modes.md)

**In short:** `ye-ast map` computes, at a snapshot, the entrypoints of a workspace, the files that implement each one
and the API operations they reach. It replaces the routes, operations and links of the map qayaba asks an LLM to write
and is the same artifact the fixed layer gives any agent. Page names and business flows stay host data, joined by
entrypoint key. It ships in three slices, each with its own parity diff against the LLM maps of the apps qayaba already
onboarded.

## Why the map comes first

- qayaba's map is written by its author agent in a `mode: context` run
  (qayaba@4105c582 `agents/agent/qa-author.md:23,43-63`). The `context_maps` table is its source of truth; the file
  `e2e/.qa/context.json` is a fallback (qayaba@4105c582 `src/server/run-engine-factory.ts:1131-1183`).
- It still ranks routes and names pages (`qa-engine/src/contexts/generation/domain/route-ranking.ts`,
  `qa-engine/src/contexts/change-analysis/domain/page-files.ts`). Every fact downstream of it inherits a
  non-deterministic input.
- The procedure the prompt describes is mechanical (find routing files, find OpenAPI files, link client calls to
  operations), and qayaba already has a deterministic counterpart for each step.
- Its output is directly the agnostic fixed layer.

## Contents

| Section | Source |
|---|---|
| Entrypoints (`ui-route`, `http-route`, ...) with target | the Angular and Spring plugins for those frameworks ([ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md)); codegraph route nodes (breadth) for frameworks without their own extractor; the OpenAPI contract joined with the classes that implement the generated interface, where handlers carry no route annotation ([ADR-0009](../adr/0009-route-data-in-two-levels.md), [RFC-0007](0007-extension-model.md)) |
| Implementation files per entrypoint | target, declared resources (templates, styles a source names by relative literal), graph closure to a bound |
| API operations | OpenAPI documents of the workspace; service links from the stitcher |
| Links entrypoint → operation | ye-ast's stitcher matches consumer call sites to operations; codegraph's own HTTP edges cover only literal URLs |
| Completeness | per section, with `unknown` reasons ([RFC-0002](0002-facts-contract.md)) |

Evidence for the sources:
- On an OpenAPI-codegen Spring app codegraph emits 0 route nodes: "annotations live in the generated `*Api` interface"
  (qayaba@4105c582 `odd/tasks/codegraph-migration.md:185`).
- codegraph 1.6.2 makes no Angular route node for routes typed through an alias of `Route[]`
  ([ADR-0009](../adr/0009-route-data-in-two-levels.md)).
- codegraph synthesizes a frontend HTTP call → backend route edge only for a literal URL; the three applications qayaba
  measured yield 0 such edges because their URLs are composed (qayaba@4105c582
  `odd/tasks/codegraph-migration.md:240`).

## The LLM map's fields and their source

| Field of qayaba's map | Source in ye-ast |
|---|---|
| `routes[].path` | entrypoint name |
| `routes[].component` | entrypoint target |
| `routes[].source` | entrypoint file and line |
| `routes[].implementationFiles` | implementation files per entrypoint |
| `routes[].name` | host: page names stay host data |
| `api[]` (`operationId`, `method`, `path`, `service`, `spec`) | API operations |
| `feBe[]` (`route`, `operationId`, `via`) | links entrypoint → operation |
| `flows` | host: business flows are not derivable from code |
| `builtAtSha` | the snapshot each fact records |

qayaba's S12 states "the map remains the source of page names and flows" (qayaba@4105c582
`odd/tasks/codegraph-migration.md:91`), and its prompt rendering reads names and flows from the map
(`qa-engine/src/contexts/generation/infrastructure/prompt-builders/architecture-context.ts:28-106`). ye-ast replaces
routes, operations and links; a host keeps names and flows as its own data and joins them to ye-ast's entrypoints by
entrypoint key (repository, kind and name). What qayaba's run still produces is qayaba's decision.

## Slices

Each slice ships on its own and is accepted by its own parity diff. All three belong to the MVP: they need only the
library, `ye-ast map`, `ye-ast init` and the stdio MCP ([ADR-0011](../adr/0011-query-protocol-in-the-mvp.md)
decision 5).

| Slice | Delivers | Trust mode, snapshot | Parity diff against the LLM maps |
|---|---|---|---|
| 1. Entrypoints | entrypoints (the Angular and Spring plugins, codegraph breadth for other frameworks, the contract-sourced HTTP routes) and the implementation files of each | `untrusted`, at a sha | `routes`: the entries qayaba's route ranking and page files read (qayaba@4105c582 `qa-engine/src/contexts/generation/domain/route-ranking.ts:35,90-153`, `qa-engine/src/contexts/change-analysis/domain/page-files.ts:51-93`) |
| 2. Operations and links | API operations and the links entrypoint → operation | `untrusted`, at a sha | `api` and `feBe` |
| 3. Live tree | the same map on the working tree, the fixed layer and the MCP | `trusted`, `live` | none from qayaba, whose maps are built at a sha (`builtAtSha`): the values of a `live` map of a clean tree equal those of the `sha` map at its HEAD, and the fixed layer and the MCP show the facts `ye-ast map` prints |

## Acceptance

1. Byte-identical output for the same snapshot and configuration.
2. Each slice passes its parity diff: each entry the LLM map has in the slice's sections and ye-ast lacks is either
   explained (`unknown` with reason) or fixed; each one ye-ast adds is shown with evidence.
3. Slices 1 and 2 run under `untrusted` at a sha; slice 3 adds `trusted` on a live tree
   ([ADR-0010](../adr/0010-trust-modes.md)).

## Open questions

The owner accepted these recommendations on 2026-10-30 (translated): "yes, I accept them all".

| # | Question | Recommendation |
|---|---|---|
| 1 | Does qayaba retire the part of its `mode: context` run that ye-ast replaces, and the onboarding step that triggers it, once parity holds? | Yes for routes, operations and links, in qayaba, after slices 1 and 2 pass their parity diffs. Names and flows stay host data (qayaba's S12), so what the run still produces is qayaba's decision |
| 2 | Output format: JSON only, or JSON plus a Markdown digest for agents? | JSON as the fact; Markdown rendered by the fixed-layer writer ([RFC-0005](0005-transports.md)) |
