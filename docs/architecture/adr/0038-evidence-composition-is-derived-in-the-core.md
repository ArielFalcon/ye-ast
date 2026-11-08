# ADR-0038: Evidence composition is derived in the core; the MCP executes and renders

- Status: Accepted, 2026-11-08, the owner through the tech lead
- Decision source: the owner, 2026-11-07 (translated): "unify duplicated logic … clean up architecture problems where
  code is scattered that should be centralized … do not accumulate more patch solutions"; the tech lead, 2026-11-08:
  "cut B, as you recommend. Derivation (normalize, identity, materialize, reference checks, contract types) moves to
  `core/application/composition/` behind a driving port; query execution, compose-request orchestration, zod and
  rendering stay in `src/mcp`".
- Related: [ADR-0011](0011-query-protocol-in-the-mvp.md), [ADR-0032](0032-a-query-family-is-done-when-every-surface-exposes-it.md),
  [RFC-0002](../rfc/0002-facts-contract.md)

**In short:** `ye_ast_compose` derived its evidence graph (sources, reads, parts, entities, relations, connections and
issues) inside `src/mcp`, a driving adapter. That derivation decides facts across query answers, so it moves into the
core behind a driving port that composition injects. The MCP keeps what translates the outside world: it executes each
query, orchestrates a compose request, validates it with zod and renders the answer.

## Context

The placement rule of AGENTS.md puts a module in the core when it decides a fact about code, git or contracts, and
outside it when it only translates an outside request into a call and shapes the answer. About 2,400 lines of
`src/mcp` (`compose-evidence.ts`, `composition-normalize.ts`, `composition-identity.ts`,
`compose-evidence-references.ts` and the graph types of `composition-contract.ts`) derive connections and issues from
the facts several query families answered. They could be tested only through the MCP and reached from no other surface.

They also depended on four MCP modules: the query runner (the executed source), recovery (the context a result identity
digests), evidence selection (the read owner and its analysis) and presentation (the family names).

| Cut | What moves | Size | Why not |
|---|---|---|---|
| A. Derivation and query execution | everything in the table above, the query runner, and every MCP tool through a core port | about 4,500 lines | It changes how every MCP tool runs, not only compose; translating tool arguments into family calls is the driving adapter's job |
| **B. Derivation only** | the derivation files and the types they and the MCP share | about 2,400 moved, 400 to 500 edited | Chosen |
| C. None, with a written exception | nothing | none | It contradicts the placement rule and the owner's requirement |

## Decision

1. The evidence derivation lives in `core/application/composition/`: normalizing an executed source into an evidence
   set, its identity, materializing the graph and checking its references and issues. A driving port in `core/ports`
   declares it, and composition injects its implementation into the MCP.
2. The types the derivation and the MCP share are core types: the graph and its records and the executed sources in
   that port; the family names, the read owner, a read's analysis and the context a result identity digests in
   `core/domain/composition/`; the JSON pointer escape in `core/domain/shared/`. The zod schemas of the MCP are typed
   against them.
3. The MCP keeps the execution of each query, the orchestration of a compose request (order, deduplication, deadline,
   faults), the request and response contracts, the zod schemas and the rendering.
4. The move changes no answer: the MCP output of `ye_ast_compose` on the corpus is byte for byte the same before and
   after each step, and `npm run arch:check` keeps the derivation out of `src/mcp`.

## Consequences

- The derivation is unit-tested as a use case with fakes, without an MCP session.
- The library and the query protocol can reach the same derivation when a surface asks for it; ADR-0032 decides when.
- A change to the graph contract now edits a core port, so the units that expose new facts through compose (for
  example a `typed` derivation) edit the core types and the MCP schema together.

## Not decided here

- Whether the library or the query protocol expose compose; ADR-0032 governs that, phase by phase.
