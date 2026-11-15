# ADR-0102: A renamed request property is a review of every producer that writes the old name

- Status: Accepted, 2026-11-15, owner
- Decision source: Owner, 2026-11-15: "Si" (yes), approving the second fix round of MCP evaluation run
  20261114T190541Z-a57733, and, for this unit, the recommended option taken: a rename on a request hypothesis is "every
  present write of the old name stops being read", answered per producer with a low-commitment verdict (`review`, "stops
  being read"), never `incompatible`, because the engine cannot know whether a server rejects or ignores the old
  property; the new name becoming required stays a separate `required` hypothesis.
- Related: [RFC-0022](../rfc/0022-contract-change-consequences.md) ("Requests", "Change algebra"),
  [ADR-0033](0033-contract-consequences-as-one-query-family.md),
  [ADR-0013](0013-coverage-grows-only-with-evidence.md)

**In short:** a request hypothesis takes `{ "renamed": "<name>" }`. Every producer that can write the old property
gets `review` with the reason `stops-being-read` and the place of the write; no producer is `incompatible` for a
rename, since a server may ignore the old name as easily as reject it. Producers that write nothing at the old name
still `admit`; frontiers and approximate origins keep their reasons.

## Context

The evaluation case `shopizer:contract:02` asks who sends a property whose name the server changes. The request grammar
(RFC-0022 "Requests") models what a server stops accepting as a value set and refuses the response kinds, `renamed`
among them, with `unsupported-change`; the oracle's question, "which producers send the old property", has no answer.

A rename is not a rejection the engine can state. Whether a server that stops reading `a` fails the request (a closed
schema, strict deserialization) or drops `a` silently (Jackson and Express defaults, open schemas) is a fact about the
server's configuration, which the engine does not read for request bodies (RFC-0022 "Server shapes": Spring request
bodies are a later slice). The producers' side is a fact: the origins that write the old name.

| Option | Verdict for a producer that writes the old name | Why |
|---|---|---|
| Refuse (status quo) | none; the batch is discarded | the question stays unanswered |
| Rename as a rejection of every present value | `incompatible` with the write as witness | claims the server rejects, which is unknown; a false `incompatible` is worse than `review` |
| Rename as "every present write stops being read" (chosen) | `review` (`stops-being-read`) with the write placed | states only what the rename does for certain: the value written there is no longer read |

## Decision

1. A request hypothesis accepts `{ "renamed": "<name>" }`: the server reads the property under `<name>`, a single
   property name (not an element, not a path), instead of under the hypothesis's property. As for a response, it
   contradicts every other entry on the same property (`contradictory-change`).
2. It rejects every present value at the old property (any class, `null` included) and never absence. The new name is
   not followed; that it becomes required is its own `required` hypothesis on the new property.
3. The verdict of a producer under it: an exact origin that writes a present value is `review` with the reason
   `stops-being-read`, never `incompatible`; the verdict carries no witness, and the finding's evidence and chain name
   the write. It decides before frontiers and approximate origins, as `incompatible` does. A producer whose origins
   are all known and none writes a present value `admits`; the rest keeps `frontier`, `approximate` and `no-origin`.
4. The answer states `accepts-the-rejected` as the old contract, as for every request hypothesis. A rename is never
   derived from a diff (a removed and an added property cannot be told from a rename), as for a response.
5. The published producer verdict gains the reason `stops-being-read`; no schema version changes.

## Consequences

- `shopizer:contract:02` answers with one finding per producer of the operation instead of a refusal.
- Expected corpus-gate move: none unless the corpus manifest holds a request rename hypothesis; the change is additive
  on the grammar and the verdict reasons.
- A host that reads `review` reasons by an exhaustive list must learn the new reason.

## Not decided here

- Reading the server's acceptance of unknown properties (Spring/Jackson, OpenAPI `additionalProperties`) so a rename
  could be `incompatible` where the server is proven strict: tracked with the Spring `@RequestBody` slice of RFC-0022.
