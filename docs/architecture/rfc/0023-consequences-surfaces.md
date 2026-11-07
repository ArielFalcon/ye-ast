# RFC-0023: The `contractConsequences` query family on every surface

- Status: Accepted and implemented, 2026-11-07 (see "Implementation notes"; "Where it stands" records the state
  before it)
- Related: [ADR-0034](../adr/0034-name-contract-consequences-explicitly.md) (the public names),
  [ADR-0033](../adr/0033-contract-consequences-as-one-query-family.md) (the decision),
  [ADR-0032](../adr/0032-a-query-family-is-done-when-every-surface-exposes-it.md) (the rule),
  [RFC-0022](0022-contract-change-consequences.md) (the analysis, unchanged here), [RFC-0002](0002-facts-contract.md),
  [RFC-0005](0005-transports.md), [RFC-0015](0015-answer-coordinates.md), [RFC-0017](0017-answer-size-and-outline.md),
  [ADR-0011](../adr/0011-query-protocol-in-the-mvp.md), [ADR-0022](../adr/0022-typed-query-replay-and-selective-evidence.md),
  [ADR-0024](../adr/0024-one-producer-version-for-every-family.md)

**In short:** the analysis of RFC-0022 is reachable only as two library ports, one of which does not answer a fact. This
RFC replaces them with one family, `contractConsequences`, whose two operations answer one composite fact, and exposes it as
the MCP tool `ye_ast_contract_consequences`, the CLI command `contract-consequences`, two protocol methods and a compose query, each
following the conventions `impact` already uses. Nothing in the analysis changes; the RFC-0022 corpus gate proves it.

## Where it stands

| Surface | Today | Evidence |
|---|---|---|
| Library | `ContractConsequencesQueries` (`consequences`, `consequencesOfEach`) answers `Fact<ConsequencesValue>`; `ContractChangeQueries.consequencesOfChange` answers a plain `ContractChangeValue` holding one fact per derived hypothesis | `src/core/ports/contract-consequences-queries.port.ts`, `src/core/ports/contract-change-queries.port.ts:48` |
| Composition | both built, marked "a library surface only" | `src/composition/compose.ts:138-141, 336-341` |
| MCP, compose, CLI, protocol | absent from every closed family list | `src/mcp/query-schema.ts:237`, `src/mcp/composition-input.ts:33`, `src/cli/main.ts:300`, `src/protocol/protocol.ts:3` |
| Measurement | no wrapper, unlike every other family | `src/composition/measurement.ts` |

What does not fit the shared surfaces as is: the change answer is not a fact; its request nests a whole workspace
request beside `base`/`head`; `consequencesOfEach` answers a list; `unknown-operation` is a call fault where a
multi-hypothesis call needs a per-hypothesis answer; hop evidence is typed without its repository
(`src/core/domain/contracts/consumer-flow.ts:91`); the value names no per-repository snapshots, which compose's
multi-repository normalization reads (`vectorOf`, `src/mcp/composition-normalize.ts:281`); the name `contract-change`
is already a compose part kind (impact's changed contracts).

## The family

The library property is `contractConsequences`; MCP and compose use `ye_ast_contract_consequences`, the CLI uses
`contract-consequences`, and protocol methods use the `contractConsequences` namespace (ADR-0034). The current library
already uses this family name; its `consequences` and `consequencesOfEach` methods and the separate `contractChanges`
operation retain their existing behavior until this RFC unifies the operations and their answer shape.

One driving port, `src/core/ports/contract-consequences-queries.port.ts`: evolve the existing hypothesis port and
absorb the separate `ContractChangeQueries` port:

```ts
interface ContractConsequencesQueries {
  ofHypotheses(request: HypothesesRequest): Promise<Result<Fact<ConsequencesValue>, ConsequencesFault>>;
  ofChange(request: ChangeRequest): Promise<Result<Fact<ConsequencesValue>, ConsequencesFault>>;
}
interface HypothesesRequest extends WorkspaceRequest { hypotheses: readonly HypothesisInput[] }   // one or more
interface ChangeRequest extends WorkspaceRequest { base: string; head: string }                   // the bound repository at `head`, not live
```

Both operations prepare the workspace once per call (RFC-0022 "Cost"); `ofChange` derives its hypotheses and answers
them on the same preparation. The use cases keep their owners (`contract-consequences-queries.ts`, `contract-change-queries.ts`);
only the port and the answer's assembly change.

**The value.** One type for both operations:

| Field | Content |
|---|---|
| `repositorySnapshots` | each repository the answer read, with its snapshot, sorted; the vector compose joins on |
| `answers` | one per hypothesis, in the order asked (`ofHypotheses`) or sorted by operation and property (`ofChange`) |
| `answers[].hypothesis` | the normalized hypothesis, as RFC-0022 "Output" echoes it today |
| `answers[].oldContract` | the assumed or derived old guarantee (response) or old acceptance (request) |
| `answers[].derivedFrom` | `ofChange` only: the operation, the property and its contract places at base and head |
| `answers[].status` | `complete`, `partial` with its cuts, or `unknown` with its reason (an operation no repository serves, a workspace read that failed for it) |
| `answers[].findings` | uses or producers with their verdicts, and frontiers as `unknown` findings, as today |
| `change` | `ofChange` only: `base`, `head`, the resolved `snapshots`, and the `derivation` section; retained even when `answers` is empty |
| `change.derivation` | a fact whose value holds gained guarantees, operations added and removed, and the frontiers of the derivation (unreadable contract, unsupported delta, unserved or ambiguous operation) as `unknown` findings; `partial` preserves the source-read cuts from both base and head, and `unknown` carries its reason and evidence without a value |

**Status.** The fact is a composite of its hypothesis sections and, for `ofChange`, the `change.derivation` section
(RFC-0002 rule 2). It is `complete` only when every section is complete; otherwise it is `partial`, retaining its value
with one `section` cut per incomplete section. Each section retains its own cuts or `unknown` reason and evidence.
Even when every hypothesis section is `unknown`, the composite is `partial` and retains every requested hypothesis
and its reason. A global `unknown` is reserved for a computation that cannot assemble the composite at all; it never
replaces an assembled collection of unknown sections.

Derivation coverage is evaluated independently of the hypothesis answers. Source-read cuts from either revision make
`change.derivation` partial and are never discarded, including when no hypothesis was derived. A frontier the analysis
reached and recorded as an `unknown` finding does not itself create a cut: as RFC-0002 rule 2 requires, an exhaustive
collection may be complete while containing unknown items. Completeness states coverage, never that the change is safe
or that every contract place was understood.

| Case | Required result |
|---|---|
| Every requested hypothesis has an unknown section | Composite `partial`; retain all sections, reasons and evidence |
| Both revisions were fully read and compared, with no deltas | `answers: []`, complete derivation and complete composite; retain `change` and resolved snapshots |
| No hypothesis was derived, but contract frontiers were exhaustively recorded | Complete derivation and complete composite; retain `change` and every unknown frontier, never interpret the empty answers as safe |
| No hypothesis was derived and either revision's source read was cut | Partial derivation and partial composite; retain `change`, the original cuts and any recorded frontiers |
| Derivation could not be computed | Unknown derivation section with its reason and evidence; composite `partial` retains `change` and any hypothesis sections |
| Hypothesis answers are complete but either revision's source read was cut | Partial derivation with the original cuts; composite `partial` with a derivation section cut |
| Hypothesis answers are complete and derivation exhaustively records unknown frontiers | Complete composite with the frontiers visible; it makes no safety claim |

All evidence carries its repository (`RepositoryEvidence`), hops and derivation evidence included. Renderers and
compose preserve section limitations and derivation frontiers even when there are no hypothesis answers.

**Faults.** A closed set, the same kinds on every surface: `invalid-hypothesis` (with the index of the hypothesis and
its refusal), `contradictory-revisions`, and the workspace faults the other workspace families already share.
`unknown-operation` stops being a call fault and becomes an `unknown` answer.

**Inputs in the fact.** `inputs.declaredConfig` holds the normalized hypotheses (or `base` and `head`), as it holds one
hypothesis today (`src/core/domain/shared/fact.ts:72`).

## Surfaces

The arguments follow `impact`, the closest family (a bound repository, a nested `workspace`, a change between two
revisions).

**MCP: `ye_ast_contract_consequences`.** Arguments: `repo`; `workspace: { repos?, gateways? }`; `scope` (the shared block, read
by the workspace preparation); exactly one of `hypotheses` (a non-empty list of `{ method, path, target, property,
change }`, with a zod schema mirroring `HypothesisInput`) or `base` with an optional `head`; `revision` or `live` only
with `hypotheses` (a cross-field issue refuses `live` with `base`, as the use case does today); `mode`. A fresh family
(`fresh("contractConsequences")`): no `select`, `page` or `expect` (ADR-0022 decision 1). Renderer `renderContractConsequences` in
`src/mcp/render.ts` under the shared header, status and guidance helpers; `summary` counts verdicts and frontiers per
answer, `details` lists each finding with its place, `full` adds chains and witnesses, with RFC-0017 §1 counted elision.
New fault kinds join `QueryFault` and `fault-presentation.ts`. The instructions' "When to call" list gains one line:
before changing a response or request contract, or to see what a diff of contracts breaks. Tool description:
"Assess how hypothetical or committed HTTP request/response contract changes affect consumers and request producers,
with code evidence and explicit unknowns."

**CLI: `ye-ast contract-consequences <repo>`.** `--hypothesis <json>` (repeatable) or `--base <rev> [--head <rev>]`;
`--revision`; the shared scope options; the workspace is the one the user declared (the persisted declaration the
`workspace` command reads). Output: the redacted fact as JSON; the RFC-0005 exit codes; faults as
`ye-ast: <kind>: <detail>`.

**Protocol (`ye-ast serve`).** Methods `contractConsequences.ofHypotheses` and `contractConsequences.ofChange` in `METHOD`, strict
parameter readers in `params.ts`, error codes for the new fault kinds in `ERROR_CODE`; revision-only and untrusted, as
every protocol workspace read.

**Measurement.** A `measuredContractConsequences` wrapper in `src/composition/measurement.ts`, like every family.

## Compose

`ye_ast_contract_consequences` joins `COMPOSE_QUERY` as a fresh query. Its normalizer is a multi-repository adapter over
`repositorySnapshots` (as `workspace`'s), producing:

| Part kind | From | Anchors |
|---|---|---|
| `consequence-use` | a use with its verdict | its place (file, line, repository), the call site, the handler |
| `consequence-producer` | a producer with its verdict | the body's call site, the witness place, the handler |
| `derived-contract-change` | an `ofChange` answer's `derivedFrom` | the contract places at base and head, the handler |
| `unknown-finding` (existing) | a frontier | its place |

References are added to `partReferences` for each new kind. The existing relations then join them without a new rule:
`shares-evidence` on equal places, file relations on equal files, and the handler anchor with the entrypoint and
impact parts that name the same handler. Joined queries need equal snapshots, schema, producer and trust
(`src/mcp/compose-evidence.ts:216-247`); compose re-reads per query (`src/mcp/compose-request.ts:169`), so joins with
`impact` or `entrypoints` hold at pinned revisions and report `snapshot-difference` under `live`, as for any family.

## What stays unchanged

The flow walks, origins, verdicts, derivation and their costs. The RFC-0022 corpus gate is run before and after each
unit and must report 0 changed findings; a unit that changes a finding is a defect of this RFC.

## Delivery

Each unit carries its tests and docs and runs alone (no concurrent full suites or gate runs):

1. The family port and value: `ContractConsequencesQueries`, composite status, `unknown` answers, repository on every evidence,
   `repositorySnapshots`; the old ports removed; composition and measurement. Tests cover every row of the status
   table, including preservation of base and head source-read cuts. Gate: 0 changed findings.
2. MCP tool and renderer, CLI command, protocol methods, with their faults; `transport-parity.test.ts` covers the
   family on every transport, including all-unknown hypotheses and changes with no derived hypotheses; summary and
   details retain the reasons, derivation limitations and frontier counts, and full retains their complete data.
3. Compose: the query, the normalizer, the part kinds, references and schema; an end-to-end composition of
   `ye_ast_impact` and `ye_ast_contract_consequences` on one workspace at pinned revisions that joins through a handler.
4. Docs: README (tool count, the choice table, compose, failures), AGENTS.md commands, RFC-0005 tables (also listing
   `ye_ast_trace`, missing today), RFC-0022 "Output" pointing here, the architecture index and the docs site.

The review of each unit checks uniformity explicitly (ADR-0032 decision 3) besides correctness.

## Implementation notes

Units 1 to 3 landed as designed, with these choices the design left open:

- The MCP family identifier is `contract_consequences`: tool names derive as `ye_ast_<family>`, so compose registers
  `fresh("contract_consequences")`.
- An empty `hypotheses` list is refused on every surface (MCP schema, CLI usage, protocol parameters).
- A workspace read's cuts also limit `change.derivation`, which looks operations up through the same workspace; a change
  with no derived hypotheses over a cut workspace is therefore `partial`, never `complete`.
- `derived-contract-change` carries `handlers`, the handlers its answer's findings reach, since a derived change may
  reach several.
- The SCHEMA version was not bumped (owner, 2026-11-06: no schema bumps while the MCP has no consumers), which answers
  open question 1.
- A hypothesis `path` is the route as the workspace links it (with any context prefix the handler's route carries); a
  bare contract path no repository serves answers `unknown`.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | SCHEMA: the family adds a value type and `declaredConfig.hypotheses`; the earlier `declaredConfig.hypothesis` landed without a bump or a rule-6 entry. Bump now? | One minor bump with a rule-6 entry covering both, since this step publishes the family on the MCP; the earlier "no bump" applied while no surface existed |
| 2 | A connection rule specific to consequences (an impact `contract-change` and a `derived-contract-change` on the same contract and operation) | Not in this step: the handler and place relations already join them; add a rule only if a compose evaluation shows a join it misses |
| 3 | Recoverability (replay, select, page) | Later, under ADR-0022, after measuring answer sizes on the corpus |
| 4 | Spring application events (RFC-0022 open question 4) | Unaffected: when added, they are answers of this family, not a new tool |
