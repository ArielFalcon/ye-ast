# ADR-0109: The MCP answer states each repeated part once and carries no field its tool's question does not use

- Status: Accepted, 2026-11-16, owner
- Decision source: Owner, 2026-11-16, round 3 of the MCP evaluation b86cb1: "Una respuesta no debe contener informacion
  que no es util para la funcion que realiza" (an answer must not contain information that is not useful for the
  function it performs).
- Related: [ADR-0022](0022-typed-query-replay-and-selective-evidence.md) (full keeps the complete public fact; amended
  here), [ADR-0051](0051-an-answer-never-hides-what-the-engine-knows.md), [ADR-0105](0105-a-name-the-join-served-is-a-fact-and-its-candidate-cites-the-calls-not-the-links.md)
  (not decided: citing links by id), [RFC-0005](../rfc/0005-transports.md), [RFC-0017](../rfc/0017-answer-size-and-outline.md)

**In short:** The full JSON and the text of an MCP answer are a projection of the core fact, and the projection states a
part that several places repeat once and points to it from each place. Nothing is lost: every reference resolves inside
the answer and the projection round-trips to the source answer. The core fact, the CLI, the library and the query
protocol keep their output; no `SCHEMA` moves.

## Context

Measured on the 91 full replies of evaluation b86cb1 (per-family byte shares of the repeated parts):

| Repeated part | Where | Measured |
|---|---|---|
| `schema`, `producer`, `inputs.trust/scope/declaredScope/engines` of a nested fact | every section, read and sub-fact of one answer | 5-repository callers: `declaredScope` 16×, `engines` 10×, `producer` 7×; up to 9% of a callers reply |
| one `unresolved` finding with the same 503 places | once per hypothesis answer of `contract_consequences`, in the JSON and again in the `details` text | 60 KB per copy; `details` 76 KB and 74 KB are one list printed twice |
| the id of a workspace link | re-encodes the link's own `from` and `to`, the handler place and the basis | 55.8 KB of 288 KB of a six-repository `workspace` reply |
| the handler place of an HTTP, listener, job or callback entrypoint | `evidence` and `value.basePath.evidence` of the same record | 1 to 2 copies per record |
| a decision `id` | equals `kind:subject` unless the decision has a scope | 423 of 430 |
| the fixed prefix of the full text | the same line of guidance per family, and a destination line per link though several links share a handler | 19 to 24% of a callers or impact reply at the median |

Selection (`select`, `page`) already answers the need for a part of an answer; it is not a reason to keep the rest
bloated, and the cost of a repeated part is the agent's context, which is the product's budget.

## Decision

1. **Scope.** The rules below shape the `mode: full` result JSON of the nine tools and the `summary`/`details`/`full`
   text of the answer. They run in `src/mcp` after the core answered. The core fact, its recovery identity, the
   `select` pages' sources and every other transport are unchanged. An answer states in its guide where it is a
   projection. This amends ADR-0022 decision 3 ("without `select`, `full` keeps the complete public fact"): `full`
   keeps every fact of the public fact, with a repeated part stated once.
2. **A nested fact states only what differs from its answer.** A nested fact (a workspace section, an indexed read, the
   entrypoints section, a change derivation) omits `schema` and `producer` when they equal the answer's, carries in
   `inputs` only the keys whose value differs from the answer's (`null` marks a key the answer has and the nested fact
   lacks), and omits `snapshot` when it equals the entry of `value.repositorySnapshots` of its section's repository.
   An absent part always means "the answer's".
3. **A finding several answers share is stated once.** In `contract_consequences`, a finding equal (canonical JSON) in
   more than one place of `value.answers[].findings` is listed once in `value.sharedFindings`, in order of first
   appearance, and each place holds `{"sharedFinding": n}`, the zero-based index, as `entrypoints[].seeds` indexes
   `seeds`. The `details` text prints a repeated finding as `same as answer N, finding M`. A finding line lists at most
   `LISTED_ITEMS` places and names how many it left out and that `mode: "full"` lists them all (the existing
   presentation bound of RFC-0017 section 1).
4. **A workspace link has an answer-local key.** Within one answer every workspace link takes the key of its position
   (one-based, over `links` then `internalLinks`) as its `id`; `reach` entries, the `[linkId …]` of the text and the
   `linkId` of `select` use the same key. A `reach` entry naming no link of the answer keeps its original id. The key
   is valid for the answer that carries it and for the replay of its recipe; the core `Link.id` is unchanged and stays
   the identity the join, `compose` and the recovery identity use.
5. **An entrypoint's handler place is stated once.** When the `evidence` of an HTTP route, listener, job or callback
   entrypoint, or of its `basePath`, is exactly its handler's `{path, line, endLine}`, it is `{"sameAs": "handler"}`
   (the handler of the finding's `value`).
6. **A decision `id` that is `kind:subject` is omitted.** No reader of the MCP, the CLI or the manifest uses the id of a
   decision (RFC-0014 question 10 matches a persisted answer by content); a decision whose id differs (a scoped one)
   keeps it.
7. **The investigation guide states the minimum.** Each family's fixed guide names the sections of the full JSON and how
   to select, once; a line a guide repeats per item (a destination per link) is listed once per distinct text; every
   instruction a test pins as behaviour stays. The guide says which parts of rules 2 to 6 the reader meets.
8. **Proof.** Each rule has a test that the projection states the part once and every reference resolves, and a
   round-trip test (an inverse in a `*.testing.ts`) that the projection restores the source answer entry for entry.

## Consequences

- Full replies shrink by the shares of the table; `tools/list` and the server instructions do not grow.
- An agent that parsed `value.sections[repo].schema`, `.producer` or the shared keys of `.inputs` reads the answer's.
  No `SCHEMA` bump, as agreed while the MCP has no consumers.
- The corpus gate is not involved: no `src/core` file changes.

## Not decided here

- A normalized, columnar full format, or delivery by file, tracked as the answer-store design of the same round.
- The `link.id` of a contract-consequences finding (`value.link.id`): it has no table to point to and stays.
- Compose answers: their parts are already identified once.
