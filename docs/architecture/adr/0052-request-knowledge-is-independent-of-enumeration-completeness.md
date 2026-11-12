# ADR-0052: Identified requests and enumeration completeness are independent knowledge

- Status: Accepted, 2026-11-12, owner
- Decision source: The owner authorized the documented design and its implementation, 2026-11-12: "haz la implementacion".
- Related: [RFC-0030](../rfc/0030-preserve-domain-knowledge-through-projections.md),
  [ADR-0050](0050-one-request-summary-per-declaration.md),
  [ADR-0042](0042-completeness-is-relative-to-the-question.md),
  [ADR-0045](0045-one-assembly-line-for-the-snapshot-reading.md)
- Supersession: ADR-0050 decision 3 only to the extent that ambiguity about additional operations currently
  invalidates every identified operation. All other decisions of ADR-0050 remain authoritative.

**In short:** A declaration can identify a request while leaving other possible requests unknown. Preserve the
identified occurrence and its established components, and separately state the limits on enumeration, target and
execution. A gap still blocks every conclusion it could invalidate.

## Context

RFC-0028 R1 requires a non-empty summary gap list to make the call's target unknown. The current summary combines
request shapes with declaration-wide gaps; this cannot reliably distinguish an uncertain alternative for one request
from uncertainty about another operation. The historical comparison reproduced a previously identified HTTP effect
disappearing because an error callback introduced a dispatch gap. The mechanism follows the current rule, so deleting
an adapter guard is insufficient.

The alternatives are:

| Option | Benefit | Cost or reason to reject |
|---|---|---|
| Keep one unknown target for the whole declaration | Current conservative contract | Erases independently established request knowledge |
| Ignore gaps when any shape is known | Small implementation change | Can assert a false unique target or complete request set |
| **Separate identified occurrences from the completeness of their enumeration** | Preserves knowledge and conservative boundaries | Requires explicit gap relevance and faithful consumer projections |
| Introduce a generic proof platform | Broad expressiveness | Unnecessary infrastructure beyond the evidenced request problem |

## Decision

1. The existing request-summary owner distinguishes identified request occurrences, alternatives for the same
   occurrence, and uncertainty about the set of additional operations. One summary per declaration remains the rule.
2. An occurrence retains only components supported by source evidence. Identifying it is neither proof that it runs
   nor proof that no other request exists. Conditionality and response-origin association remain explicit.
3. A gap blocks a conclusion whenever its evidence could invalidate that conclusion. An occurrence survives a gap
   only with positive evidence that the gap cannot invalidate its identification and retained components. Missing
   relevance information fails closed; an unclassified gap is never silently declared independent.
4. Unique-target and exclusion consumers require their own sufficient proof. A partial request enumeration cannot
   establish absence, exclusive dispatch or an exact consumer/producer link merely because one request is known.
5. Relevance, as clarified 2026-11-12: along an occurrence's chain of calls a gap can change the identified request
   only when it arises inside the request call itself or inside the receiver of a call that enters a callee, or when it
   names no call. A gap at the entering call is judged in the callee. A gap in another statement, a sibling expression or
   an argument cannot change the verb or the route, because an undecided argument already states a run-time or unknown
   part of the URL. Such a gap does not erase the occurrence; it stays on the declaration's summary as a limit on its
   enumeration and execution, and its callers see it as an unresolved call site beside the request. An unknown target
   keeps the verb the code states, and the URL expressions the shape holds.
6. The language adapter provides syntax and binding evidence through the existing held reading. Domain contracts
   define the conclusions that evidence permits. No consumer derives a second request summary or drops uncertainty
   to recover an effect.

## As built

- `occurrenceGaps` (`request-summaries.ts`) applies decision 5 per occurrence; the ordering rule that cleared only gaps
  evaluated after the request is replaced by it.
- `summaryTarget` (`http-call-sites.adapter.ts`) attaches `stated` whenever the occurrence agrees on one verb, also when a
  gap blocks the target.

## Consequences

- RFC-0030 specifies the five delivery units; U1 reconciles RFC-0028 R1 and the call-site consumers together.
- Public fact changes require the schema, persistence and surface compatibility work in the same unit.
- Existing bounded contexts, ports' direction, language packs and snapshot lifetimes remain intact.

## Not decided here

- Reading injection-provider values, selecting runtime build configurations, and external Java library signatures.
- A generic uncertainty algebra or new service. Only request knowledge needs the refinement here.
