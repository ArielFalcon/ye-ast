# RFC-0031: The cut ledger and the outcome control

- Status: Accepted, 2026-11-13. Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados"
  (I approve every pending recommendation; leave them closed); every open question is settled as recommended (see
  Resolved questions). ADR-0071 records its decisions.
- Related: ADR-0013, ADR-0039, ADR-0042, RFC-0012, ADR-0071 (the decision this RFC designs), RFC-0032 to RFC-0038
  (the program this RFC steers)

**In short:** the engine is correct more often than it is useful, and nothing in the repository says which cause of
"cannot tell" is the largest today. Two instruments fix that. A **cut ledger** counts, on every corpus gate run, the
answers by status and the cuts by reason, normalized by the steps the answer expanded. An **outcome control** runs the
agent evaluation with and without the MCP on the same tasks. Every later RFC of this program names the ledger rows it
must move, and is accepted only when they move.

## Problem

| Evidence | Source |
|---|---|
| 25 of 30 traces `partial`; no `complete` was false | `docs/evaluations/trace-quality/2026-11-07-findings.md:22` |
| 55 of 94 answers `partial`, 681 cuts reach the agent | ADR-0042, "In short" |
| The agent evaluation of 2026-11-08 graded 296 needs in 110 sessions: 16.2% served by the engine, 71 of 80 tasks solved by search alone, and no arm without the MCP | the run is kept outside the repository, as ADR-0039 requires of reports |
| In the same run, declaring `node_modules` moved the TypeScript share from 10.7% to 12.0%, inside the noise | same run |
| Raw cut counts mislead: one family's `receiver-unproven` cuts rose from 202 to 486 because traces reached deeper code, while the rate per step stayed near 0.78 | measured on 2026-11-13 during the trace coverage work |

Three consequences follow.

1. The order of the program below is a hypothesis until a current ledger exists. The last distribution of cuts by cause
   predates ADR-0062 to ADR-0070.
2. A raw count cannot judge a change. A fix that lets a walk go deeper raises the count of cuts and is still a gain.
3. The corpus gate (ADR-0039) reports which answers differ per family. It does not say which reasons moved, so a change
   that claims "fewer unknowns" has no number to show.

## The cut ledger

A pure reduction over the facts a gate run already produces. It adds no query and no engine code.

| Row | Definition |
|---|---|
| Key | query family, language of the root (the pack that reads the root's path), cut `kind`, `reason`, `subReason` |
| `answers` | answers of that family and language, by status: `complete`, `partial`, `unknown` |
| `cuts` | cuts with that key |
| `per100Steps` | `cuts` over the expanded steps of the answers that hold them, times 100; absent for a family that expands no step |
| `answersDegraded` | answers whose status is `partial` or `unknown` because of a cut with that key (ADR-0042: a cut degrades only when its reach holds an asserted item) |

Rules:

1. The reasons and sub-reasons are the closed sets of `src/core/domain/shared/fact.ts`. A reason the ledger does not
   know is a failure of the gate, never an "other" row.
2. The ledger is deterministic: sorted rows, no wall clock. Latency stays in the measurement record (RFC-0012).
3. The reduction lives beside the gate (`scripts/`), since no query family needs it. It reads facts through the same
   seam as the gate's diff.
4. The gate prints the ledger of the base, of the candidate, and their difference. The report stays outside the
   repository with the gate's other reports.
5. The ledger sets no threshold. It is a report a reviewer reads, and an expectation the author may declare (open
   question 1). No branch of the engine reads it.

## The outcome control

The agent evaluation already grades needs. It lacks the arm that says what the engine adds.

| Element | Rule |
|---|---|
| Arms | A: the agent with its ordinary tools. B: the same agent with the MCP registered. Same tasks, same model, same budget, same seeds |
| Per task | correct or not against the task's oracle, tool calls, tokens, wall time |
| Per need (arm B) | the grading the 2026-11-08 run used: served, fallback and its cause |
| Reported | the difference B minus A with its interval, per task class and per language |
| Where | the protocol in `docs/evaluations/`; runs and their artifacts outside the repository |

The control is expensive, so it runs per milestone of the program, not per change (resolved question 2).

## What each RFC of the program must move

| RFC | Ledger rows it targets | Outcome signal |
|---|---|---|
| RFC-0032 | `unresolved-link` with the unread-source and unparsed-source sub-reasons; `no-extractor` | none expected alone |
| RFC-0033 | `receiver-unproven` whose cause is a hierarchy open above a library type | flow and dependency classes, Java |
| RFC-0034 | `dispatch` cuts of several bodies, down to zero; step count reported beside it | flow class |
| RFC-0035 | none: a refactor, the gate expects no difference | none |
| RFC-0036 | unlinked call sites by transport | cross-stack class |
| RFC-0037 | none: same bytes, cold and warm | wall time per task |
| RFC-0038 | fault share of calls, per fault kind | adoption: needs where the agent did not try the covering family |

## Acceptance of a change under this program

1. A change that claims fewer unknowns shows the ledger difference of its target rows and of every row that grew.
2. A row that grows is explained: deeper walks (the rate per 100 steps does not grow) or a real regression.
3. A change to the agent surface (RFC-0038) or to presentation shows the outcome control, since the ledger cannot see
   whether an agent uses an answer.
4. ADR-0039 is unchanged: the gate still passes or fails on declared expectations per family.

## Slices

1. The reduction and its report in the gate, with a test over a synthetic set of facts.
2. One baseline ledger on the current corpus at `main`. It reorders, if needed, RFC-0032 to RFC-0038.
3. The protocol of the control arm and one baseline run.

## Resolved questions (owner, 2026-11-13: "apruebo todas las recomendaciones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | Does the gate accept an expectation per reason, such as `--expect-cuts receiver-unproven:-`? | Yes, optional. Without it the ledger is informative. It makes the claim of a change checkable by the same tool that already checks families |
| 2 | How often does the outcome control run? | Once as a baseline, then after each milestone that changes what an agent sees (RFC-0034, RFC-0036, RFC-0038). Never per change: its cost is hours of agent sessions |
| 3 | Is the baseline ledger committed? | No. It names corpus applications, and ADR-0039 keeps such reports outside. The commit that lands a change carries the difference of its target rows in its message |
