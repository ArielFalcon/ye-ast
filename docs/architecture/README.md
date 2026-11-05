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
| [0017](adr/0017-owner-of-a-member-expands-only-whole-type-edges.md) | A type reached through one of its members expands only through whole-type edges | Accepted |
| [0018](adr/0018-type-information-as-a-fact-input.md) | A fact may settle a reference with `typescript`'s compiler API in process, from a type root outside the snapshot; the root is an input of every fact that used it. Measured: as an edge source it removes one cut. Rejected and removed, 2026-11-05 | Rejected |
| [0019](adr/0019-cuts-retired-on-a-proven-external-target.md) | A cut is not emitted when the file's own imports prove its target outside the repository; no type root, and a file-level shadow rule that gives up 6% of the retirements. Measured: 6% to 13% fewer cuts | Proposed |
| [0020](adr/0020-host-budgeted-snapshot-memory-cache.md) | Serialized snapshot data in memory, bounded by a host-overridable byte budget; Git exports stay temporary | Accepted |
| [0021](adr/0021-enable-snapshot-memory-cache-by-default.md) | Snapshot data cache enabled by default with 32 MiB; host override and explicit zero preserved | Accepted |
| [0022](adr/0022-typed-query-replay-and-selective-evidence.md) | Typed selection on existing tools, explicit projections, verified query replay, declared repository targeting, mixed snapshots and result-bound pagination | Accepted |
| [0024](adr/0024-one-producer-version-for-every-family.md) | Every query family stamps one producer version; the edge-policy suffix is removed. Supersedes 0017 decision 3 | Accepted |
| [0025](adr/0025-template-member-calls-join-as-component-calls.md) | A template call through a component's injected field joins as a call of the component, with the template as evidence; amends the ADR-0017 amendment | Accepted |

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
| [0013](rfc/0013-trace-and-patterns.md) | `trace` and `patterns`: two read-only query families for an agent that must understand a repository and plan a change | Draft |
| [0014](rfc/0014-workspace-decisions.md) | Workspace decisions: the gaps the code cannot fill, offered to the user as options each verifiable with `path:line` | Draft |
| [0015](rfc/0015-answer-coordinates.md) | Answer coordinates an agent can act on: `endLine` on the values that name a place and the call-site line on `via`, from data the walk already reads | Draft |
| [0016](rfc/0016-type-resolution.md) | A synchronous port over `ts.createProgram` for the references the index cannot settle, a type root outside the snapshot, and the three gaps a measurement exposed: false cuts proven external, unread `paths`, and codegraph's undocumented coordinates. The port was retired 2026-11-05 | Draft |
| [0017](rfc/0017-answer-size-and-outline.md) | A counted elision is never longer than listing what it hides, and a file outline with declaration spans an agent reads around | Draft |
| [0018](rfc/0018-change-selection.md) | `changed` on `impact.ofChange`: globs over the changed paths select what seeds the walk while the repository stays indexed whole, so callers outside the selection are still known | Draft |

## Pending decisions

| Topic | Where | Owner input needed |
|---|---|---|
| What to contribute to codegraph upstream | RFC-0003 | Deferred by the owner on 2026-10-29 |
| Publication | RFC-0008, Q1-Q2 | Public or private; clearance of extracted qayaba code; npm name and GitHub organization (license decided: Apache-2.0) |
| Recording the constraints in qayaba's migration | RFC-0009, Q1 | Accepted on 2026-10-30; where to record them, since qayaba's migration branch is active |
| Daemon good practices | RFC-0005 | Complete and agree before the daemon slice |

## Templates

[ADR template](adr/0000-template.md) · [RFC template](rfc/0000-template.md)
