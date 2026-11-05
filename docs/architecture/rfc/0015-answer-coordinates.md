# RFC-0015: Answer coordinates an agent can act on

- Status: Draft, 2026-11-03
- Related: [RFC-0002](0002-facts-contract.md) (evidence, rules 2, 3 and 5), [RFC-0004](0004-deterministic-map.md)
  (entrypoints), [RFC-0005](0005-transports.md) (MCP and CLI), [RFC-0010](0010-impact-queries.md) (impact value),
  [ADR-0001](../adr/0001-product-scope-and-priority.md), [ADR-0017](../adr/0017-owner-of-a-member-expands-only-whole-type-edges.md)

**In short:** every value that names a place today carries a file, a start line and a symbol, but not where the place
ends, and `via` names the caller without the line where it calls. Add one optional `endLine` to `Seed`,
`ImpactedSymbol` and `Handler`, and one optional `lines` to `via`, filled from data the walk already reads. The agent
then reads an exact span and an exact call site instead of re-reading a file and grepping each caller. Additive and
optional, from schema `0.5.0` to `0.6.0`.

## Why

The fact is correct and complete about the graph, and it stops one step short of the edit. Measured on a real Angular
webapp (name-webapp at `e8699653`, 9 probe requests of `odd/probes/mcp-answer-precision/`, stdio MCP client, this
branch's working tree). These are historical measurements under the then-current selectors and do not describe the
current response modes:

| Call | text | `structuredContent` |
|---|---|---|
| `ye_ast_entrypoints` | 5.1 KB | 19.4 KB |
| `callers` `formatRating` | 4.9 KB | 11.0 KB |
| `callers` `relativeDayLabel` | 1.4 KB | 4.0 KB |
| `callers` `AppButtonComponent` | 17.9 KB | 31.8 KB |
| `callers` `AuthService.getAccessToken` | 0.9 KB | 2.4 KB |
| `callers` `RestClientService.get` | 20.6 KB | 131.2 KB |
| `callers` `authGuard` | 4.1 KB | 7.3 KB |
| `callers` `AddressDetailResponseSchema` | 4.1 KB | 10.3 KB |
| `callers` `haversineKm` | 12.1 KB | 47.3 KB |
| **9 calls** | **71.2 KB** | **264.6 KB** |

For every one of those places the agent must:

1. **Find the end of the unit.** `Seed.line` and `ImpactedSymbol.line` are the declaration's first line
   ([RFC-0010](0010-impact-queries.md#the-fact)); nothing says where it stops. Reading with an offset means guessing a
   window, and guessing wrong cuts the body. Reading the whole file is correct and expensive. The walk already holds
   `endLine` — `GraphSymbol` carries it (`src/core/ports/code-graph.port.ts:55-57`) and the projection drops it
   (`src/core/application/impact/impact-queries.ts:489-505`).
2. **Find the use.** `via` names the symbol a reach came through, without the place in the reached symbol where it
   depends on it. The edge's line is right there when the edges are read (`GraphEdge.line`, `code-graph.port.ts:64`, read
   in `src/core/application/impact/inbound-edges.ts:80-88`) and `InboundEdge` keeps only `from`
   (`inbound-edges.ts:10-16`). So the agent greps the callee's name in each caller's file, once per caller: 116 `via`
   entries across the 9 answers above. The walked edge runs from the reached symbol to the one it depends on, so the
   line worth answering is the one in the reached symbol's own file: the place to edit.

The same argument holds for `Handler` (`src/core/domain/entrypoints/http-route.ts:26-30`), the place a route, a
reached entrypoint and a changed entrypoint name: the extractors already produce a span (`spanOf` at
`src/core/adapters/spring/findings.ts:13-15`, `endLine` in the Angular router extractor) and every handler is built from
it keeping only the start (`src/core/adapters/spring/spring-routes.adapter.ts:371`, `src/core/adapters/spring/listeners.ts:155`,
`src/core/adapters/typescript/angular-routes.adapter.ts:85`).

This is not a request for code in the answer, which the facts contract refuses: it is the two coordinates that turn
"this symbol" into "this span" and "this caller" into "this use".

## What changes

```ts
type DependenceBasis = "call" | "reference" | "contains" | "dispatch" | "relation" | "import";

interface Seed { file: string; symbol: string; line: number; endLine?: number; basis: SeedBasis }

interface ImpactedSymbol {
  file: string; symbol: string; kind: string; line: number; endLine?: number;
  depth: number; confidence: number; fanIn: number;
  /**
   * The dependence that first reached the symbol: `lines` are the places inside this symbol's own file where it depends
   * on `via`, in line order and all of them, and `basis` says what that dependence is.
   */
  via?: { file: string; symbol: string; lines?: readonly number[]; basis: DependenceBasis };
  seeds: readonly number[];
}

interface Handler { path: string; symbol: string; line: number; endLine?: number }
```

| Rule | Statement |
|---|---|
| R1 | `endLine` is present only when the declaration spans more than one line, the convention `Evidence` and `CallSite` already follow (`src/core/domain/topology/call-site.ts:47`). A one-line declaration prints `264`, never `264-264`. |
| R2 | `via.lines` holds **every** place inside the reached symbol's own file where it depends on `via`, sorted and without duplicates, never the first one: a symbol with three recorded dependence locations retains all three; a dependence alone does not prove an edit is needed. The full fact preserves them (`strongestPerSymbol` in `src/core/application/impact/inbound-edges.ts` merges by source and used to keep one line). |
| R3 | `via.basis` says what the dependence is, always: `call` when a call or an instantiation is among the merged edges, `reference` when it only names the symbol, and `contains`, `dispatch`, `relation` or `import` for the structural ones the walk follows (a member's type at the same depth, a dispatch bridge, an Angular injection or template use, the top-level code of an importing file). |
| R4 | `endLine >= line` for every value, and never above the declaration the store reports. |
| R5 | Determinism holds: two runs of the same request over the same snapshot give identical bytes (RFC-0002 rule 3). Every added value is a field of the store read for that snapshot, so no clock and no extra I/O enter the answer. |
| R6 | CLI and MCP preserve the same recorded coordinates; MCP text may group or omit recorded evidence with truthful recovery. |

Text, current and proposed (the numbers are from a real answer):

```
    264 renderImpact [function] (depth 0)             ->     264-281 renderImpact [function] (depth 0)
    264 renderImpact (requested)                      ->     264-281 renderImpact (requested)
  - http-route GET /orders -> src/OrderController.java:40 OrderController.one
                                                    ->   - http-route GET /orders -> src/OrderController.java:40-58 OrderController.one
    (depth 1, via src/mcp/render.ts:renderImpact)     ->     (depth 1, via src/mcp/render.ts:renderImpact at 291)
    (depth 2, via B.user)                             ->     (depth 2, via src/b.ts:B.user at 14, 21, 33)
    (depth 2, via B.user)                             ->     (depth 2, via src/b.ts:B.user at 33 (reference))
    (depth 2, via B.user)                             ->     (depth 2, via src/b.ts:B.user (contains))
```

In the current MCP contract, `mode: "full"` carries these fields in the structured fact. Summary/details receipts
carry only mode, status, snapshot and an unknown reason when applicable. Related MCP queries can select a declared
owner with `repo`. Use the owner's recorded SHA as `revision`; a base-side module uses the recorded merge-base SHA.
A live follow-up is a fresh read whose head and stateId must be compared with the earlier identity. Symbol names may
select multiple declarations. An undeclared owner needs an updated registration or an instance bound to that clone.

## What this refuses to add

| Candidate | Why not |
|---|---|
| A code snippet or the signature | The facts contract answers facts about code, not code; it multiplies bytes and goes stale against the snapshot. `kind` plus the qualified name is enough to decide whether to open the file. |
| Lines in `ImportersValue` | `importers` states a file-level relation by design ([RFC-0010](0010-impact-queries.md#the-fact)); the line adds a search the caller did not ask for. |
| Names behind `fanIn` | `fan-in` counts call-like callers the walk saw; every caller the walk followed is already listed as a symbol at the next depth. Naming the rest would restate the same list. |
| A `basis` enum on `via` | An agent acts on the line, not on the edge's origin. The structural cases are named in the text (R2) and are few. |
| More precision than the store has | An edge with `line: null` says nothing; it takes no field and no invented line. |

## Cost

Measured on the same 9 real answers (name-webapp at `e8699653`, stdio MCP client), counting the bytes this feature adds
to each one, over the tree that precedes it:

| Piece | text | `structuredContent` |
|---|---|---|
| `endLine` on seeds, impacted symbols and handlers | +1.09 KB | none by default |
| `via.lines` and `via.basis` | +1.09 KB | none by default |
| **total** | **+2.18 KB (+3.8 % of 57.4 KB)** | **0 B; the fields ride with the value under `full: true`** |

The table records the historical `full: true` selector and its then-current delivery; those byte counts are not a
measurement of the current modes. Today `mode: "full"` includes the structured fact and the text modes carry minimal
receipts. Text and structured content are measured separately because they are distinct wire channels, but a client
may expose either or both to a model. No tokenizer or model exposure was measured.

The historical text grew 3.8 % over the cut-work baseline of 57.4 KB for those answers. The recorded probe also
reported 429.5 KB and 157.4 KB for ten practical tasks (`odd/tasks/mcp-answer-precision.md`, L18–L19); these figures
are historical and are not a current-mode comparison.

## Placement and edits

No port changes and no new query: everything is read today. The change is a projection, a render and a schema version.

| File | Edit |
|---|---|
| `src/core/domain/impact/impact-fact.ts` | `Seed.endLine`, `ImpactedSymbol.endLine`, `ImpactedSymbol.via.line` |
| `src/core/domain/entrypoints/http-route.ts` | `Handler.endLine` |
| `src/core/application/impact/inbound-edges.ts` | `InboundEdge` keeps the edge's line (absent for a bridge or a containment), deduplicated per source |
| `src/core/application/impact/walk.ts` | `Rec.via` carries the line; `enterOwners` marks the structural case |
| `src/core/application/impact/impact-queries.ts` | project `endLine` and `via.line`; the same for reached entrypoints |
| the map's producers | `Handler` built from a finding that already carries `endLine` |
| `src/mcp/render.ts` | `symbolLine`, `groupedSeeds`, `handlerText`, `entrypointLine`, `changedLine`, `reachedLine` |
| `src/core/domain/shared/fact.ts` | `SCHEMA` to `0.6.0` |

The CLI prints the fact as JSON and needs no change. The fixed layer stores the entrypoints fact
(`src/core/application/fixed-layer/fixed-layer-admin.ts`), so its shape change invalidates it; `producer.version` is part of
fact validation (RFC-0002 rule 5), so nothing migrates: the next `ye-ast init` writes the new shape.

Risk: item 3 (a contract other consumers read: the fact schema and the MCP output), so the change takes its own commit
and an independent verifier.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Branch `fix/fact-contract-and-mcp-projection` bumps `SCHEMA` from `0.4.0` to `0.5.0` (`d11a8ec`) and removes `ImpactedSymbol.seeds`. Both cannot claim `0.5.0`. | Settled: that branch landed first, so this one takes `0.6.0`. The number is not published in a released build before this, so the cost was a rebase, not a migration. |
| 2 | Does `via` need `line` at all when the dependence is structural, or is printing `(contains)` / `(dispatch)` enough? | Print the reason and keep the field absent. An empty field with no explanation is the silent empty RFC-0002 rule 1 forbids, and an enum is a field no agent acts on. |
| 3 | Should `Handler` grow `endLine` in the map too, where the agent usually wants the route, not the method body? | Yes, uniformly: 43 lines of a 5.1 KB answer, and a special case per family is the complexity this repository rejects. |
| 4 | Is `endLine` the right name when `Evidence` already has it, or should the three values carry a range object? | Keep the flat `endLine` the contract already uses. A nested `{ start, end }` would be a second grammar for the same thing. |
| 5 | Do we need the reverse: the end of the symbol a `callers` walk stops at, which is the seed's own `endLine`? | Already covered: the seed carries it, and a reached symbol carries its own. Nothing else is asked for. |
