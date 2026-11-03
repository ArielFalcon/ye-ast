# Architecture records

Read the ADRs for what is decided and the RFCs for designs under discussion. Start with ADR-0001 and RFC-0001. An ADR
marked **Proposed** awaits the owner's acceptance.

## Decisions (ADR)

| ADR | Decision | Status |
|---|---|---|
| [0001](adr/0001-product-scope-and-priority.md) | Code truth engine; qayaba first, any harness second; one product with deployment profiles; own repository; extracted modules after qayaba's migration ([0012](adr/0012-foundation-before-qayaba-migration.md)) | Accepted |
| [0002](adr/0002-project-name.md) | Name `ye-ast` | Accepted |
| [0003](adr/0003-implementation-language.md) | TypeScript; speed from a long-lived process, native code only for a profiled hot path | Accepted |
| [0004](adr/0004-codegraph-dependency-with-own-fact-layer.md) | codegraph as a dependency with an own fact layer, no fork | Accepted |
| [0005](adr/0005-runtime-topology-and-delivery-order.md) | MVP first (library, CLI, stdio MCP); then hooks and daemon in topology A1; no MCP over HTTP. [0011](adr/0011-query-protocol-in-the-mvp.md) supersedes its delivery order and the place of the socket client | Accepted |
| [0006](adr/0006-qayaba-graph-state-per-run.md) | On qayaba's server, graph state lives per run | Accepted |
| [0007](adr/0007-dependency-versions.md) | Latest stable dependencies, pinned exactly | Accepted |
| [0008](adr/0008-typescript-compiler-api-source.md) | TypeScript 6.0.3 as the single version, an exception while TypeScript 7 has no stable compiler API | Accepted |
| [0009](adr/0009-route-data-in-two-levels.md) | Route breadth from codegraph, route depth from own extractors | Accepted |
| [0010](adr/0010-trust-modes.md) | Two trust modes, `trusted` and `untrusted`, describe the repository content and are declared outside it; no mode per host | Accepted |
| [0011](adr/0011-query-protocol-in-the-mvp.md) | One query protocol, JSON-RPC over stdio from the MVP (`ye-ast serve`); the daemon serves it later; hooks do not wait for the daemon | Accepted |
| [0012](adr/0012-foundation-before-qayaba-migration.md) | The foundation starts now; modules extracted from qayaba wait for its migration and move in their migrated form | Accepted |
| [0013](adr/0013-coverage-grows-only-with-evidence.md) | Coverage grows only with evidence: five fact families, parsers never builds, measured entry, failing fixtures first, idioms as data, one owner per fact | Accepted |
| [0014](adr/0014-angular-and-spring-from-own-extractors.md) | Angular and Spring from own extractors over parser libraries (TypeScript compiler API, `@angular/compiler`, tree-sitter-java), with the definition of done | Accepted |
| [0015](adr/0015-index-reuse-by-content.md) | Index reuse by staged content; `sync`-derived indexes serve only live facts that record it | Accepted |
| [0016](adr/0016-remote-refresh-under-trusted.md) | Under `trusted`, declared remotes are refreshed into ye-ast's own mirrors before a query; facts depend on pinned shas only. Supersedes the network clause of 0010 decision 4 for `trusted` | Accepted |

## Designs (RFC)

| RFC | Topic | Status |
|---|---|---|
| [0001](rfc/0001-architecture-and-layers.md) | Layers, ports, entrypoints, deployment profiles | Draft |
| [0002](rfc/0002-facts-contract.md) | Fact statuses (`complete`, `partial` with cuts, `unknown` with a reason), inputs and invalidation, determinism, redaction at egress | Draft |
| [0003](rfc/0003-codegraph-integration.md) | SDK-first access, raw-SQL remainder, path confidence (parity first, then the widest path, a bounded score for heuristic edges and free interface hops), index reuse across shas, upstream candidates | Draft |
| [0004](rfc/0004-deterministic-map.md) | `ye-ast map` in three slices, each with its parity diff, replacing the routes, operations and links of the LLM-written map; page names and flows stay with the host | Draft |
| [0005](rfc/0005-transports.md) | CLI, query server, fixed layer, MCP, hooks, daemon and its good practices | Draft |
| [0006](rfc/0006-configuration.md) | Workspace manifest and profile: trust mode, allowed snapshot kinds, budgets, redaction, store | Draft |
| [0007](rfc/0007-extension-model.md) | Languages, frameworks and protocols as plugins; the Angular and Spring plugins per gap; capability matrix; conformance | Draft |
| [0008](rfc/0008-distribution.md) | npm, Docker, Homebrew | Draft |
| [0009](rfc/0009-extraction-from-qayaba.md) | What moves, splits and stays; constraints for qayaba's migration | Draft |
| [0010](rfc/0010-impact-queries.md) | Impact of a change, callers and importers: the request, the walk without default bounds, the fact and its completeness | Draft |
| [0011](rfc/0011-cross-repository-impact.md) | Impact across repositories: links from call sites to entrypoints, upstream and downstream fixpoint, per-repository sections, the snapshot rule, reuse and completeness | Draft |
| [0012](rfc/0012-observability-and-measurement.md) | Two records: the deterministic fact as the record of why, the host's measurement of what it cost; cost inside the fact, reproduction by input identity, where a baseline lives | Draft |

## Pending decisions

| Topic | Where | Owner input needed |
|---|---|---|
| What to contribute to codegraph upstream | RFC-0003 | Deferred by the owner on 2026-10-29 |
| Publication | RFC-0008, Q1-Q2 | Public or private; clearance of extracted qayaba code; npm name and GitHub organization (license decided: Apache-2.0) |
| Recording the constraints in qayaba's migration | RFC-0009, Q1 | Accepted on 2026-10-30; where to record them, since qayaba's migration branch is active |
| Daemon good practices | RFC-0005 | Complete and agree before the daemon slice |

## Templates

[ADR template](adr/0000-template.md) · [RFC template](rfc/0000-template.md)
