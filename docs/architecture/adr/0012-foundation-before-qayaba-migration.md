# ADR-0012: The foundation starts before qayaba's migration

- Status: Accepted, 2026-10-30, owner
- Decision source: the owner, 2026-10-30 (translated): "Yes, I accept them all", accepting a list of recommendations
  whose first item was "start now with the foundation that does not come from qayaba; a new ADR narrows decision 5 to
  the modules extracted from qayaba".
- Related: [ADR-0001](0001-product-scope-and-priority.md), [RFC-0009](../rfc/0009-extraction-from-qayaba.md)

**In short:** what ye-ast extracts from qayaba still waits for qayaba's root-cause migration and moves in its migrated
form; everything else starts now. This narrows decision 5 of ADR-0001 to the extracted modules.

## Context

- ADR-0001 decision 5: "Implementation starts after qayaba's root-cause migration, extracting the modules in their
  migrated form".
- On 2026-10-30 the migration is not merged: qayaba's main is at 4105c582 and its branch `fix/root-cause-2026-10-28`
  is 90 commits ahead (`git rev-list --count main..fix/root-cause-2026-10-28`).
- RFC-0009 lists what moves from qayaba and what splits. The rest of ye-ast is new code: the facts envelope
  ([RFC-0002](../rfc/0002-facts-contract.md)), the git snapshot export ([ADR-0010](0010-trust-modes.md)), the store
  and the first index ([RFC-0005](../rfc/0005-transports.md)), configuration and the trust record
  ([RFC-0006](../rfc/0006-configuration.md)), and the CLI, `ye-ast serve` and MCP entrypoints
  ([ADR-0011](0011-query-protocol-in-the-mvp.md)). The codegraph adapter is listed as moving but is rewritten over the
  SDK ([RFC-0003](../rfc/0003-codegraph-integration.md)).

| Option | For | Against |
|---|---|---|
| A. Wait for the migration, as ADR-0001 stands | Nothing to reconcile later | Nothing starts until a merge that has no date |
| **B. Start what does not come from qayaba now** | The foundation is ready when the migrated modules can move | The foundation's ports are set before the migrated modules are seen; a mismatch costs an adapter change |
| C. Extract now from the pre-migration tree | Everything starts now | It extracts the twins and dead code the migration deletes, at paths its step 5 renames (RFC-0009) |

## Decision

1. Code that RFC-0009 lists under "What moves" or "What splits" waits until qayaba's root-cause migration is merged
   and moves in its migrated form. The codegraph adapter is the exception: it is rewritten over the SDK, so it is new
   code.
2. Everything else starts now, including any extractor qayaba does not have.

## Consequences

- ADR-0001 decision 5 applies only to the extracted modules.
- The deterministic map's first slice uses the Angular route extractor and the declared resources, both extracted from
  qayaba, so it completes after the migration unless they are rewritten under decision 2; until then the foundation
  runs on codegraph's breadth facts.
- Each path in RFC-0009 is re-verified against the merged tree before its module moves.

## Not decided here

- The order of the foundation's slices, settled when the first slice is planned.
