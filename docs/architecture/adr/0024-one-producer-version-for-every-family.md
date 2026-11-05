# ADR-0024: Every query family stamps one producer version

- Status: Accepted, 2026-11-05, owner
- Decision source: the owner, 2026-11-05 (translated): "if a rule that applies makes no sense it can be removed, for
  example the one that protects data for consumers when there are no consumers; this app is not in production, it is
  in early development. I approve your proposals, start implementing."
- Related: supersedes decision 3 of [ADR-0017](0017-owner-of-a-member-expands-only-whole-type-edges.md);
  [RFC-0010](../rfc/0010-impact-queries.md) "Edge policy", [RFC-0002](../rfc/0002-facts-contract.md) rule 5

**In short:** impact, callers and importers facts no longer append `+edge-policy.<digest>` to the producer version.
Every family of one build reports the same producer, so `ye_ast_compose` can derive connections between a traversal
family and entrypoints or outline.

## Context

ADR-0017 decision 3 digested `EDGE_POLICY` into the producer version, so that a policy change would invalidate stored
impact facts. No impact, callers or importers fact is stored: the only fact store is the fixed layer, and it holds the
entrypoints map, which never carried the suffix. The suffix therefore protected no consumer.

It did split the producer within one process: traversal families reported `0.4.0+edge-policy.547271f654d0`, the others
`0.4.0`. Composition requires equal producer versions to derive a connection, so on the evaluated corpus
(`ye-ast_test/evaluations/runs/20261105T220048Z-compose-combinations-ec9f65`) every callers or impact plus
entrypoints combination reported `context-mismatch producer different`, and no `reached-handler` or `change-dependent`
connection joined them.

| Option | Cost |
|---|---|
| Parse the suffix in composition and compare only shared qualifiers | A second reader of a string format; contradicts the composition plan's "no suffix parsing" |
| Move the digest into `inputs.engines` | Keeps a protection nobody needs, and changes the fact inputs |
| Remove the suffix | A future store of traversal facts must add its own invalidation key |

## Decision

1. Every query family stamps `{ name: "ye-ast", version }` with the package version, unqualified.
2. Composition keeps strict producer equality for derived connections.
3. When a store of impact, callers or importers facts is introduced, it records the edge policy it depends on as part
   of that store's validity key; it is not reintroduced into the producer version for every consumer.

## Consequences

- Traversal and non-traversal reads of one build are compatible for derivation; the composition's strict rule is
  unchanged and now meaningful only across builds.
- A changed edge policy no longer changes the producer version; recovery `expect` still detects a different result,
  because `replay` reruns the query and compares the result.

## Not decided here

- The validity key of a future store of traversal facts.
