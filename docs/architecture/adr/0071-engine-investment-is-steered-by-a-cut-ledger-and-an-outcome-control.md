# ADR-0071: Engine investment is steered by a cut ledger and an outcome control

- Status: Proposed, 2026-11-13, tech lead; waits for the owner
- Decision source: Owner, 2026-11-13: "estas propuestas de correccion y mejoras deben ser de forma transversal y no
  parches puntuales. Genera los RFC y ADR correspondientes" (the corrections and improvements must be cross-cutting,
  not point patches; write their RFCs and ADRs). The owner has not yet accepted the decisions below.
- Related: RFC-0031 (design), ADR-0013, ADR-0039, ADR-0042, RFC-0012

**In short:** every gate run reports the cuts by reason, normalized by expanded steps, and the agent evaluation gains
an arm without the MCP. A change that claims fewer unknowns, or a better outcome for an agent, shows the matching
number. Without this, the order of the engine's work is an opinion.

## Context

The repository holds point measurements: 25 of 30 traces `partial` on 2026-11-07, 55 of 94 answers `partial` in
ADR-0042. None is current, none is comparable across changes, and raw counts rise when a walk reaches deeper code. The
agent evaluation of 2026-11-08 found the engine served 16.2% of graded needs and had no arm without the MCP, so it
cannot say what the engine adds to a task.

| Option | Verdict |
|---|---|
| Keep judging a change by the gate's per-family difference only | Rejected: it shows that answers moved, not which cause of "cannot tell" shrank |
| A threshold the gate enforces ("partial below N%") | Rejected: a size threshold decides nothing about correctness, and deeper walks legitimately add cuts |
| A ledger as a report, with optional declared expectations, plus a control arm per milestone | Chosen |

## Decision

1. The corpus gate reports a cut ledger: answers by status and cuts by family, language, kind, reason and sub-reason,
   with the rate per 100 expanded steps and the answers each key degrades.
2. The ledger is a deterministic reduction of the gate's facts. It lives beside the gate, reads no wall clock and sets
   no threshold. An unknown reason fails the run.
3. A change that claims fewer unknowns states its target rows and shows their difference, and explains every row that
   grew.
4. The agent evaluation runs two arms on the same tasks, model and budget: without and with the MCP. It reports the
   difference per task class and language.
5. The control arm runs as a baseline and after each milestone that changes what an agent sees, never per change.
6. ADR-0039 is unchanged. Reports stay outside the repository and name no application here.

## Consequences

- The order of RFC-0032 to RFC-0038 is confirmed or changed by the first baseline ledger.
- A fix that deepens walks is no longer mistaken for a regression.
- The control arm costs agent sessions; its frequency is bounded by decision 5.

## Not decided here

- Whether the gate takes an expectation per reason (RFC-0031, open question 1).
- Any target value for a ledger row. A target needs a baseline first.
