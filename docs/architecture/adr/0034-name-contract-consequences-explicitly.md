# ADR-0034: Name the contract consequences family explicitly

- Status: Accepted, 2026-11-07, owner
- Decision source: the owner, after the proposed names and their implementation scope were explained:
  "haz el renombre tanto en codigo como en documentacion".
- Related: [ADR-0033](0033-contract-consequences-as-one-query-family.md) (naming superseded; family semantics retained),
  [RFC-0023](../rfc/0023-consequences-surfaces.md) (the implementation design)

## Context

The family follows hypothetical or committed request/response contract changes to their effects on consumers and
request producers. `consequences` omits the subject; `contract-evaluation` leaves the evaluation's purpose open, and
`contract_mutation` can suggest changing a contract. Adding `contract` states the subject while preserving the outcome.
Whether this improves tool selection by an LLM remains an evaluation question, not a measured claim.

## Decision

| Surface | Name |
|---|---|
| Library property and protocol namespace | `contractConsequences` |
| Driving port | `ContractConsequencesQueries`, in `contract-consequences-queries.port.ts` |
| MCP tool and compose query | `ye_ast_contract_consequences` |
| CLI command | `contract-consequences` |

These identifiers supersede the naming in ADR-0033. The current library's hypothesis query port, factory, application
module and callers adopt the name immediately, without aliases. The existing hypothesis methods and separate diff
operation retain their behavior; RFC-0023 still owns their unification and exposure on the remaining surfaces.

## Consequences

- Library callers use `contractConsequences` instead of `consumers`.
- The analysis, verdicts, argument semantics and fact schema do not change because of this rename. Existing domain
  names such as `ConsequencesValue`, `ConsequencesFault` and `ConsumerSources` remain valid.
- Public tool descriptions state the input (hypotheses or a diff), the effects followed and the evidence returned.
- Historical decision quotations and evaluation logs retain their original identifiers; current designs use this table.
