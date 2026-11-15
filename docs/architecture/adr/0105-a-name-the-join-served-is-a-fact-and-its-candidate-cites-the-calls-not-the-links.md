# ADR-0105: A name the join served is a fact, and its candidate cites the calls, not the links

- Status: Accepted, 2026-11-15, owner
- Decision source: Owner, 2026-11-15, approving the second fix round of evaluation run 20261114T190541Z-a57733: "Si"
  (yes); unit W3 (size, no fact lost), ranked next steps 1, 2 and 5 of `reviews/topology.md`.
- Related: [RFC-0014](../rfc/0014-workspace-decisions.md) (membership), [RFC-0017](../rfc/0017-answer-size-and-outline.md)
  (counted summaries), [ADR-0066](0066-the-mcp-answers-list-no-duplicate-and-count-template-noise.md)

**In short:** A name a link or a delivered event served already has its answer, the join's: it opens a membership
decision only where a gateway in force ties that prefix to the clone. A `link` or `event-destination` candidate states
the call places that write the name; the handler end is the `to` of the link it points to. The workspace summary prints
the places of a repeated list once, and a decision option that rests on the places of its decision says so.

## Context

Evaluation 20261114T190541Z-a57733 measured the cost of making link-served names visible (workspace-F7):

| Case | `workspace` full | `decisions` summary | `decisions` full |
|---|---|---|---|
| shopizer | 268 -> 327 KB (candidates 74 KB: 2 names x 324 places) | 20.8 -> 82.8 KB | 77 -> 192 KB |
| petclinic-rest | 60 -> 77 KB (candidates 17 KB) | 4.4 -> 20.1 KB | 21 -> 48 KB |

One place list is stored per name (the host and the prefix of one base write the same calls), copied into the decision
and into each option, and printed in the summary once per line that holds it. Causes, by reading:

- `linkCandidates` (`workspace-queries.ts`) puts both ends of every link in the candidate, though the link already holds
  both and the section's name holds the call places.
- `membershipsByName` (`decision-set.ts`) turns every candidate of a clone the declaration lacks into a question,
  including a candidate whose only basis is the join's own verdict; the clone is one the request passed, and the
  answer persists nothing the join did not already decide. Twelve such decisions were added; the oracles tolerate them
  as `unknown_ok`, except three that tie a gateway prefix to its clone (decisions-F3).

## Decision

1. **A join-served name is no membership question.** A name whose candidates are all `link` or `event-destination`
   opens no `membership:name` decision, except for a prefix a gateway in force routes to that candidate's clone, declared
   or inferred: the decision there ties the prefix the caller wrote to the clone that serves it (the case of the three
   decisions evaluation decisions-F3 counted as signal). A name with at least one candidate of another basis (an
   identity comparison, which only the user can confirm) keeps its decision with every option, the join-served ones
   included.
2. **A `link` or `event-destination` candidate cites the calls.** Its `evidence` is the places of the call sites that
   write the name and the join linked into the candidate's repository. The handler place is the `to.handler` of the
   links of `value.links` and `value.internalLinks` that start at those places and end in that repository: nothing is
   dropped, and a place no link accounts for is still printed whole.
3. **The MCP text says a list of places once.** Within one repository's names, a name that writes exactly the places an
   earlier name printed says "same places as <name>" instead of repeating them, when that is shorter; a decision option
   that rests on exactly the places its decision prints says "same places as the decision". `full` and the indexed
   presentations are unchanged.

## Consequences

- `value.candidates` and the membership decisions of `decisions` lose the handler places and the join-served
  questions; `workspace` summaries lose the repeated list. The gate declares `--expect workspace:-` and a decisions
  family when the corpus holds one.
- RFC-0014 rule "membership, one per name" reads "one per name an identity comparison or a gateway in force ties to a
  clone".
- No schema version moves: the shape is the same, its lists are shorter.

## Not decided here

- Citing links by `Link.id`: the id is 41% of a link's bytes, so a reference costs more than the two places it
  replaces. A short digest identity would make it cheap; it touches every family and is tracked with the `Link.id` item
  of the evaluation report.
- Echoing the gateways in force in the `summary` and `details` answers (decisions-F3).
