# ADR-0033: Contract consequences are one query family, `consequences`, on every surface

- Status: Accepted, 2026-11-07, owner
- Decision source: the owner, 2026-11-07, approving the proposal "una sola herramienta, `ye_ast_consequences`, con dos
  formas de entrada (hipótesis escritas a mano o `base`/`head`), en MCP, CLI, `serve` y `compose`, con el mismo contrato
  de respuesta que las demás": "Me parece bien, deja formalizado el documento para aplicar esta unificación. Su RFC y adrs
  correspondientes".
- Related: [ADR-0032](0032-a-query-family-is-done-when-every-surface-exposes-it.md),
  [ADR-0011](0011-query-protocol-in-the-mvp.md), [ADR-0022](0022-typed-query-replay-and-selective-evidence.md),
  [ADR-0024](0024-one-producer-version-for-every-family.md), [RFC-0022](../rfc/0022-contract-change-consequences.md)
  (its "Output" sentence "F0 has no MCP, CLI or protocol surface" is superseded),
  [RFC-0023](../rfc/0023-consequences-surfaces.md) (the design)

**In short:** the two library families of RFC-0022 (`ConsumerQueries` for written hypotheses, `ContractChangeQueries`
for a diff) become one family, `consequences`, with two operations that answer the same fact value. It is exposed as
the MCP tool `ye_ast_consequences`, a CLI command, protocol methods and a compose query, under the conventions of
`impact`. It is a fresh family: no replay, select or page in this step.

## Context

- RFC-0022 F0 decided no surface while precision was unproven (feature spec S7, 2026-11-06). The phases since measured 0
  false verdicts on the oracle repositories, and the owner asked for the family to be uniform with the others
  (ADR-0032).
- The two families overlap: a diff derives hypotheses and answers each with the hypothesis evaluator. Two tools would
  repeat the workspace arguments, the faults and the rendering.
- `ConsumerQueries` answers `Fact<ConsequencesValue>` with no replay context (`FactRead`), so it can only be a fresh
  family (`src/mcp/recovery.ts`, ADR-0022 decision 1).

| Option | Effect |
|---|---|
| Two tools (`hypotheses`, `change`) | Duplicate arguments, faults and renderers; compose sees two families for one fact kind |
| One family, two operations, one value (chosen) | One tool with exactly one of two inputs, one renderer, one compose adapter |

## Decision

1. One driving port family `consequences` with two operations: `ofHypotheses` (one or more written hypotheses) and
   `ofChange` (a base and a head). Both answer `Result<Fact<ConsequencesValue>, ConsequencesFault>` with one value type;
   the library ports `ConsumerQueries` and `ContractChangeQueries` are replaced, not kept beside it.
2. One fact per call. Each hypothesis is a section of the composite (RFC-0002 rule 2): a hypothesis no repository
   serves, or one the workspace cannot follow, is an `unknown` section, never a call fault. A call fault is reserved for
   input the family refuses (an invalid hypothesis, contradictory revisions) and for workspace faults, each a kind in the
   closed fault set of every surface.
3. Exposed as the MCP tool `ye_ast_consequences`, the CLI command `consequences`, the protocol methods
   `consequences.ofHypotheses` and `consequences.ofChange`, and the compose query `ye_ast_consequences`, following the
   argument conventions of `impact` (`repo`, nested `workspace`, `base`/`head`).
4. Fresh family in this step: response modes `summary`, `details`, `full` with counted elision (RFC-0017 §1); no
   `select`, `page`, `expect` or replay.
5. The analysis is unchanged by the exposure: the corpus gate of RFC-0022 gives identical findings before and after.

## Consequences

- An agent can ask "what breaks if this contract changes" and join it in compose with `impact`, `entrypoints`,
  `callers` and `trace` through the coordinates they already share.
- The library callers of the two old ports (tests and composition only) move to the new port.

## Not decided here

- Recoverability (replay, select, page) for this family: a later ADR under ADR-0022, after measured answer sizes.
- A compose connection rule specific to consequences: RFC-0023 open question 2.
