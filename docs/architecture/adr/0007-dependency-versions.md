# ADR-0007: Latest stable dependencies, pinned exactly

- Status: Accepted, 2026-10-29, owner
- Decision source: the owner, 2026-10-29 (translated): "for the implementation the latest stable version of codegraph
  must be used, as well as of all the libraries to use".
- Related: [ADR-0003](0003-implementation-language.md), [ADR-0004](0004-codegraph-dependency-with-own-fact-layer.md),
  [ADR-0005](0005-runtime-topology-and-delivery-order.md), [ADR-0008](0008-typescript-compiler-api-source.md)

**In short:** every dependency enters at its latest stable version at the time it is added and is pinned exactly (no
`^` or `~`). Upgrades are deliberate changes that run the full gate.

## Decision

1. A dependency is added at its latest stable release (npm `latest` dist-tag, no pre-release) and pinned exactly.
   `.npmrc` sets `save-exact=true` and `engine-strict=true`.
2. A dependency is added when the first code that needs it lands, not ahead of it.
3. An upgrade is its own change; for codegraph it also runs the parity harness and conformance fixtures.
4. When the latest stable release lacks a capability ye-ast needs, the exception is recorded in an ADR.

## Versions at scaffolding (2026-10-29)

| Package | Version | Role |
|---|---|---|
| typescript | 6.0.3 | type checking and the analysis API; an exception, see [ADR-0008](0008-typescript-compiler-api-source.md) (latest stable: 7.0.2) |
| tsx | 4.23.15 | running TypeScript without a build |
| @types/node | 24.19.2 | matches the Node 24 runtime (the latest line, 26.x, describes Node 26) |
| dependency-cruiser | 18.7.0 | layering rules |

Planned at their slice, latest stable then: `@colbymchenry/codegraph` (1.6.2 today), `@modelcontextprotocol/server`
(2.4.0 today), `zod` (4.6.7 today).

The MCP package is `@modelcontextprotocol/server`, the stable v2 line, which implements the 2026-07-28 specification.
`@modelcontextprotocol/sdk` 1.x (1.32.2) is not used: its README says "This is v1.x of the MCP TypeScript SDK, the
maintenance line", with fixes "for at least six months after the v2 release (2026-07-27)" (npm, 2026-10-29).

The runtime follows [ADR-0003](0003-implementation-language.md): `.nvmrc` names the latest 24.x patch (24.22.2 on
2026-10-29).

## Consequences

- TypeScript 7 removes the classic compiler API, which the extractors need; the exception is
  [ADR-0008](0008-typescript-compiler-api-source.md).
- dependency-cruiser 18.7.0 supports TypeScript below 7 only ("Support for typescript@>=7 will follow when its API is
  published and stable"): with TypeScript 7.0.2 installed it cruised 0 modules and the layering gate was silently empty.
  With 6.0.3 it parses TypeScript natively; a probe violation fails the gate.
