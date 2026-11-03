# RFC-0001: Architecture and layers

- Status: Draft, 2026-10-29
- Related: [ADR-0001](../adr/0001-product-scope-and-priority.md), [ADR-0005](../adr/0005-runtime-topology-and-delivery-order.md),
  [ADR-0010](../adr/0010-trust-modes.md), [ADR-0011](../adr/0011-query-protocol-in-the-mvp.md),
  [RFC-0002](0002-facts-contract.md), [RFC-0005](0005-transports.md), [RFC-0006](0006-configuration.md),
  [RFC-0009](0009-extraction-from-qayaba.md)

**In short:** a hexagonal core (domain, application, ports, driven adapters) holds every analysis rule and is the
library a host embeds. Driving adapters (CLI, MCP, the query protocol behind `ye-ast serve`, later hooks and a daemon)
call it through typed, read-only query families and separate admin ports (`SnapshotAdmin`, `FixedLayerAdmin`), injected
by a composition root. Deployment profiles, not components, separate scenarios: a trust mode that describes the
repository content, the snapshot kinds a call may name, and how the host runs ye-ast. The hexagonal and DDD rules are
qayaba's; the layout is a library's.

## Layers

```
┌───────────────── driving adapters (no analysis logic) ─────────────────┐
│ cli (map, init, serve)   mcp (stdio)   protocol   hooks*   daemon*  │   * after the MVP
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ query families and admin ports, injected by composition
                                     │ (in-process, or the protocol client over stdio or a socket)
                                     ▼
┌───────────────────────────────── core ─────────────────────────────────┐
│ ports: query families · SnapshotAdmin · FixedLayerAdmin · driven ports │
│ application/<subdomain>: use cases                                     │
│ domain/<subdomain>: facts, impact, entrypoints,                        │
│   topology, contracts, change structure (pure)                         │
│ adapters/<technology>: codegraph, typescript,                          │
│   tree-sitter, git, openapi, confined reader,                          │
│   redaction, store                                                     │
└────────────────────────────────────────────────────────────────────────┘
composition: builds adapters, picks in-process or protocol-backed query families, wires entrypoints.
```

| Layer | Holds | May import |
|---|---|---|
| `core/domain` | Pure rules and value objects | `core/domain` only; no Node built-ins |
| `core/ports` | Query families, admin ports, driven ports | `core/domain`, `core/ports` |
| `core/application` | Use cases implementing the query families and admin ports | `core/domain`, `core/ports`, other `core/application` subdomains; never `core/adapters` |
| `core/adapters` | Driven adapters | `core/domain`, `core/ports`, libraries; never `core/application`, never another adapter (one frozen exception: `spring` reads the syntax trees of `tree-sitter`) |
| `cli`, `mcp`, `protocol`, `hooks`, `daemon` | Translate requests, shape answers; the daemon also hosts the process | `core/ports`, `core/domain`; never another entrypoint, never adapters or use cases directly |
| `composition` | The root | everything |

A port lives in `core/ports` because an adapter implements it. A contract one use case needs from another application
module is declared beside that module instead: `RelationExtractor` sits in `core/application/relations/` and the impact
use case imports it from there (2026-11-01), so the driven ports stay what adapters implement.

`npm run arch:check` enforces the table and counts type-only imports (`tsPreCompilationDeps`; in a probe on 2026-10-29,
two cross-layer `import type` statements passed without it). The full rules and the placement table are in `AGENTS.md`.

### Why the daemon is not an adapter of the core

A driven adapter is called by the core through a port the core declares (codegraph, git). The daemon calls the core: it
is a driving adapter that also hosts the process.

The query protocol ([ADR-0011](../adr/0011-query-protocol-in-the-mvp.md)) gives the query families a wire
form. Its server and its client live in one driving adapter, `src/protocol/`: the server answers the query families
over a byte stream, and the client implements the same query families over that stream. `ye-ast serve` serves it over
stdio in the MVP; the daemon later hosts the process and the socket. Neither the daemon nor the MCP adapter imports
`protocol`: only `composition` wires it, so moving an entrypoint from the MVP's in-process core to the daemon changes
wiring, not the entrypoint.

## Ports

The core exposes narrow ports, one per concern:

- **Query families, read-only:** `ImpactQueries` (impact walk, callers, importers with completeness;
  [RFC-0010](0010-impact-queries.md)),
  `EntrypointQueries` (entrypoints, entrypoints reaching a symbol, route table), `TopologyQueries` (consumers of an
  operation, contract of an operation, drift, cross-repo impact), `ContractQueries` (consumer expectations, response
  fields), `ChangeQueries` (change map, change slices, changed decisions, operation diff, co-change).
- **Admin ports, separate:** `SnapshotAdmin` (open a snapshot, lease it, index it, release it) and `FixedLayerAdmin`
  (write the fixed layer through the driven port `FixedLayerStore`: temporary file, rename). No transport facing an
  agent exposes either. A host reaches `SnapshotAdmin` through the library or `ye-ast serve`, and `FixedLayerAdmin`
  through the library or `ye-ast init`; the in-process MCP server's composition uses `SnapshotAdmin` to open and
  refresh its session's snapshot.
- **Driven ports:** what the core needs from technology: graph, source reader, VCS, `FixedLayerStore`, documents,
  telemetry.
- Every call takes a snapshot handle (repository, sha or live tree, scope digest), an `AbortSignal` and a deadline. A
  deadline is its own kind of cut and follows [RFC-0002](0002-facts-contract.md) rule 3: a fact it cuts is never stored
  nor written to the fixed layer.
- Each family has an in-process implementation and a protocol-backed one (the client in `src/protocol/`) with the same
  contract.

## Entrypoints instead of pages

qayaba reasons from pages. ye-ast generalizes to `Entrypoint { kind, name, file, line, target, level }` with kind
`ui-route`, `http-route`, `listener`, `job` or `cli`, and `level` `breadth` or `depth`
([ADR-0009](../adr/0009-route-data-in-two-levels.md)). A page is a `ui-route` entrypoint.

An entrypoint's `name` identifies it from what the code declares, never from a value that varies by deployment. An
`http-route` is named `METHOD path`, with ` v<version>` when the mapping declares a version (`GET /orders v2`). The
path is the mapping the code declares; the base path the configuration puts before it is a separate finding, reported
per profile ([RFC-0007](0007-extension-model.md) row S6), so the name stays stable when a profile or a deployment
changes it. A `listener` is named by the protocol and the destination it consumes (`kafka orders-created`).
A `ui-route` is named `/<path>`, the full path the code declares from the root route table with the paths of its
parents joined (`/orders/:id`, `/**`), never the `<base href>`; a named outlet adds ` (<outlet>)`
(`/compose (popup)`). Only a route entry that shows a component is a `ui-route`: a redirect is not, and a parent
without a component only adds its path to its children. A path the sources do not give as text, or a `matcher`, is an
`unknown` item, never a guessed name ([RFC-0007](0007-extension-model.md) row A1). The name is unique per Angular project, not per
repository: two apps of one repository may both declare `/home`, and they stay two entrypoints told apart by handler
(RFC-0010 keys entrypoints by kind, name and handler).

## Deployment profiles

| Axis | Values |
|---|---|
| Trust mode ([ADR-0010](../adr/0010-trust-modes.md)) | `trusted` or `untrusted`. It describes the repository content, never the machine, and is declared outside the repository |
| Snapshot | A call parameter: `sha` (immutable, cacheable) or `live` (working tree plus a state id for uncommitted changes). The profile restricts the allowed kinds ([RFC-0006](0006-configuration.md)) |
| Host | `embedded` (the library in the host's process), `child` (`ye-ast serve` as the host's child process, over stdio) or `standalone` (CLI, MCP) |

| Trust mode | Reads | Honours from the repository |
|---|---|---|
| `untrusted` | A snapshot exported from git at a sha; `sha` is the only snapshot kind | Nothing: no ye-ast manifest, `.gitignore`, engine configuration, pre-built index or symlinks; the host passes the manifest |
| `trusted` | The working tree (`live`) or a sha | Its ye-ast manifest and `.gitignore`; symbolic links that stay inside the repository root |

In both modes ye-ast needs no secret and runs no repository code. Under `untrusted` it makes no network request;
under `trusted` its only one is the refresh of declared remotes into its own mirrors
([ADR-0016](../adr/0016-remote-refresh-under-trusted.md)). Isolating the process (identity, file permissions, network)
is the host's decision.

## What is not ye-ast

Driving or observing a running application: DOM capture, requests a page made, V8 coverage dumps, bundle mutation,
fault injection, route availability measured against an environment. Those stay in qayaba and consume ye-ast facts.
Reports produced elsewhere (lcov, JaCoCo) may enter ye-ast as inputs for change coverage.

## Open questions

The owner accepted these recommendations on 2026-10-30 (translated): "yes, I accept them all".

| # | Question | Recommendation |
|---|---|---|
| 1 | Should the change-coverage computation over ingested reports (lcov, c8, JaCoCo) be in the MVP? | No: after the map and the MCP, and only when a consumer needs it. The collectors would be new code: qayaba's branch `fix/root-cause-2026-10-28` deletes its own (`qa-engine/src/contexts/objective-signal/infrastructure/{lcov,c8,jacoco}-coverage.adapter.ts` and `coverage-collector.adapter.ts`, commit b3deb252, "remove the code target") |
| 2 | Is `ChangeQueries.coChange` (git history) worth its cost in the MVP? | No: add with the fixed layer's second version |
