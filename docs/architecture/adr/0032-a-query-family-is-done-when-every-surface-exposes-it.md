# ADR-0032: A query family is done only when every surface exposes it under the shared contracts

- Status: Accepted, 2026-11-07, owner
- Decision source: the owner, 2026-11-07: "Debe ser uniforme en la base siguiendo los mismos contratos que las demás
  herramientas siempre que sea posible para que quede bien integrada, siguiendo los contratos de tipo de respuesta y
  todo lo que conecta las demás herramientas", and "Me parece bien, deja formalizado el documento para aplicar esta
  unificación. Su RFC y adrs correspondientes".
- Related: [ADR-0011](0011-query-protocol-in-the-mvp.md), [ADR-0022](0022-typed-query-replay-and-selective-evidence.md),
  [ADR-0024](0024-one-producer-version-for-every-family.md), [ADR-0033](0033-contract-consequences-as-one-query-family.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0005](../rfc/0005-transports.md),
  [RFC-0023](../rfc/0023-consequences-surfaces.md)

**In short:** contract consequences (RFC-0022) went through five phases as a library only: the first phase had decided
"no MCP, CLI or protocol surface" while its precision was unproven, and no later phase reopened it, so the restriction
became permanent by omission. One of its two answers also left the fact contract. From now on a query family counts as
delivered only when it answers the shared fact contract and is reachable through every surface the other families use,
compose included; a phase that defers a surface says so and names the phase that adds it.

## Context

- Every outer surface enumerates the families in a closed list: MCP tools (`src/mcp/server.ts:557-646`,
  `SEMANTIC_INPUTS` in `src/mcp/query-schema.ts:237`), compose (`COMPOSE_QUERY` in `src/mcp/composition-input.ts:33`),
  the CLI (`queryOf` in `src/cli/main.ts:300`), the query protocol (`METHOD` in `src/protocol/protocol.ts:3`). A family
  missing from one list is unreachable there, and nothing fails.
- ADR-0011 decision 1 makes a protocol result a fact; RFC-0002 fixes the envelope. `ContractChangeQueries` answers a
  plain value holding facts (`src/core/ports/contract-change-queries.port.ts:48`), which no renderer, recovery or compose
  normalizer accepts.
- The reviews of RFC-0022 checked correctness, precision and cost, never uniformity with the other families, so the gap
  was not reported.

| Option | Effect |
|---|---|
| Expose families case by case, when asked | What happened: a five-phase family nobody can call from an agent |
| A family is done only with the shared contract and every surface (chosen) | One check per family; a deferral is explicit and has an owner |

## Decision

1. A query family answers the RFC-0002 fact contract (`Fact<T>` or a composite built by its rules); a value that is not
   a fact is never a family's answer.
2. A family is delivered when it is reachable through the library port, the MCP server (its tool, the shared response
   modes and presentation rules), compose, the CLI and the query protocol, with the same argument conventions the
   closest existing family uses. A surface that cannot carry the family yet is named in its RFC with the reason and the
   phase that adds it.
3. A family's review checks uniformity explicitly: the answer contract, the argument conventions, faults in the closed
   sets of each surface, and the documentation that lists tools.
4. A design that keeps a family off a surface for a first phase states the condition that ends the restriction; the
   phase that meets it adds the surface.

## Consequences

- Contract consequences gets one family and every surface (ADR-0033, RFC-0023).
- A new family costs its surface work up front; it is planned as part of the family, not after it.

## Not decided here

- Which families are recoverable (replay, select, page): ADR-0022 still decides that per family.
