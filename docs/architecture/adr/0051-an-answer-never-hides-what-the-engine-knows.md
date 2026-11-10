# ADR-0051: An answer never hides or misstates what the engine knows

- Status: Accepted, 2026-11-09, owner
- Decision source: Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (settle every open question as recommended), after "aplica el orden que recomiendas" and "los ADR recogen decisiones mas acotadas referentes a un RFC".
- Related: [RFC-0029](../rfc/0029-presentation-residuals.md) designs this decision; RFC-0010, RFC-0017, RFC-0025, ADR-0042

**In short:** Where the engine already holds a fact, the answer states it: one owner writes fault entry text, a missing
file is a fault in every family, an answer that cannot fit a declared bound is refused instead of truncated, an empty
`include` is a fault, an entrypoint carries its declaration place, and `importers` relationships carry their lines.

## Context

After the evidence-view and absent-file fixes (`6d21e7bc`, `96bf4389`), a re-probe of the agent-usefulness study left 12
presentation items failing: answers over the client's size, a duplicate-repository fault that does not name the entry,
UI routes without their declaration place, an empty glob answered `complete`, `importers` and `outline` answering a cut
for a missing file, and `importers` printing paths only although the index places each relationship. RFC-0029 holds the
evidence and units.

## Decision

1. Fault entry text is one core domain vocabulary; a driving adapter contributes only its prefix, detail framing and next
   step.
2. A requested file no commit entry holds is a fault in every family, decided before any extension filter; an entry the
   export skipped is held, never absent.
3. An answer bound is a value the host or the request declares, met by a shorter projection and refused
   (`answer-over-bound`) when it cannot fit; truncation never happens and there is no built-in byte limit.
4. A declared `include` that selects nothing is a fault; a partly unmatched one is stated on the answer. It lands after
   RFC-0025 U5, which decides what an `include` selects.
5. A reached entrypoint carries the declaration place the engine already read for it.
6. A relationship the `importers` value names carries its place; an answer without a recorded place says so instead of
   implying one.

7. **One transversal mechanism per domain, built when the algorithm is needed.** A rule that decides a fact about code
   lives in one owner that every reader consults, and that owner is designed whole for the fact it decides: its answer
   is a sum type that distinguishes "established" from "not established", so a reader cannot collapse the two by
   accident. A second name-based or heuristic path beside it, and a chain of special cases added per observed input, are
   both defects: the first duplicates the fact, the second turns an algorithm into patches. When a new case appears, the
   owner's contract grows to state it, and the case is answered by the mechanism, never by an `if` in a consumer.
   Corollary for this ADR: an empty result is a fact only when the owner read what it had to read and found nothing;
   otherwise the answer is the engine's explicit "not established", which is what decisions 2 and 6 already require of
   presentation.

## Consequences

- The delivery units, their order and their tests are in RFC-0029, and each unit names the units of other RFCs it waits for.
- Decision 3 adds a declared value to the host profile and the request, and decision 6 adds a field to a published
  value; both are additive contract changes.

## Not decided here

- Bounding `structuredContent` of `mode: full`.
