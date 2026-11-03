# ADR-0004: codegraph as a dependency with an own fact layer

- Status: Accepted, 2026-10-29, owner; decision 2 corrected on 2026-10-30 (the store check reads the schema version
  from the store, since `getIndexBuildInfo()` does not return it) and confirmed by the owner the same day
  (translated): "I confirm the corrections"
- Decision source: the owner, 2026-10-29 (translated): "for codegraph option D seems fine to me", choosing among
  A (dependency and wrap), B (fork), C (contribute upstream) and D (dependency plus an own fact layer). Later the same
  day: "leave pending the topic of what should be implemented in codegraph to contribute".
- Related: [RFC-0003](../rfc/0003-codegraph-integration.md), [ADR-0006](0006-qayaba-graph-state-per-run.md),
  [ADR-0007](0007-dependency-versions.md)

**In short:** ye-ast depends on `@colbymchenry/codegraph` for the symbol graph and keeps every fact codegraph does not
compute (service links, entrypoint semantics, consumer expectations, dynamic loads, validity) in its own layer. No
fork. What to contribute upstream is pending.

## Context

- codegraph (MIT, one maintainer, frequent releases) indexes 30+ languages with tree-sitter and ships an in-process
  SDK (`require("@colbymchenry/codegraph")`), route resolvers for about 20 frameworks and its own MCP and daemon.
- qayaba runs its CLI and reads its SQLite store directly, pinned to schema 11 / extraction 27, because the CLI gives
  no JSON for file symbols with line ranges, inbound walks with predecessors, or route nodes with targets
  (qayaba@4105c582 `qa-engine/src/shared-infrastructure/code-graph/codegraph-store-reader.mjs:1-4,39-40`).
- Checked on 2026-10-29: the SDK covers only part of those queries, and `registerFrameworkResolver` is not a public
  export. The package has 39 runtime exports and the function is `undefined`; it is declared only in an internal type
  file (codegraph 1.6.2 `dist/resolution/frameworks/index.d.ts:28`), is absent from `dist/index.d.ts`, and the
  `exports` map rejects the deep import (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

| Option | Effort | Upkeep | Verdict |
|---|---|---|---|
| A. Dependency and wrap | Low | Breaks on store changes | Today's state; the gaps are patched outside |
| B. Fork | Medium | High and permanent: 30+ extractors and a fast upstream | Spends effort on the commodity part |
| C. Contribute upstream | Medium | Low if accepted | Complements D for generic gaps |
| **D. Dependency + own fact layer** | Medium | Medium | **Chosen** |

## Decision

1. codegraph is a pinned dependency, used through one adapter ([RFC-0003](../rfc/0003-codegraph-integration.md)).
2. Access is hybrid: the public SDK for every query it covers, a small raw-SQL remainder in the same adapter, and a
   parity harness over real indexes. The adapter version-checks the store itself: it reads the schema version and the
   extraction version from the store, as qayaba's reader does (qayaba@4105c582
   `qa-engine/src/shared-infrastructure/code-graph/codegraph-store-reader.mjs:39-40,106`). The SDK's
   `getIndexBuildInfo()` cannot replace that check:
   - it returns `{version, extractionVersion}` only, with no schema version (codegraph 1.6.2 `dist/index.d.ts:310`);
   - it reports the last full `indexAll`, because `sync` does not advance it (codegraph 1.6.2 platform bundle
     `lib/dist/index.js:662-663`);
   - the schema version (11) and the extraction version (27) are not exported (platform bundle
     `lib/dist/db/migrations.js:17`, `lib/dist/extraction/extraction-version.js:27`).
3. ye-ast's own facts live in its own layer and store, joined with the graph at query time.
4. No fork now. MIT keeps a fork open as an escape hatch if a needed change inside the indexer is refused upstream.
5. Upstream contributions are pending; the candidate list waits in RFC-0003.

## Consequences

- A codegraph upgrade is a change of its own: the parity harness and conformance fixtures run on it.
- A codegraph upgrade rebuilds every index in full: an index is reused only by the codegraph version that built it in
  full ([ADR-0006](0006-qayaba-graph-state-per-run.md)).
- codegraph's telemetry is forced off (`DO_NOT_TRACK=1`); its CLI shim, which can download bundles, is never called.
- Route semantics stay in ye-ast's own extractors ([ADR-0009](0009-route-data-in-two-levels.md)).
