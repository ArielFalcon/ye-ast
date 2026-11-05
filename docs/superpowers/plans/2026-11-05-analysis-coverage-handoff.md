# Analysis coverage investigation handoff

Prepare evidence-backed implementation plans for three bounded improvements. Give each linked brief to one agent; each is self-contained. These are research assignments, not approved technical designs or instructions to change production code immediately.

Baseline for this handoff: `d35093f807c4a789cb32b50040fad31c0a73ab04`, inspected on 2026-11-05. Recheck HEAD, local changes and existing consumers before relying on symbols or historical observations. The working tree already contains unrelated architecture and response-recovery documents; preserve them.

## Assignments

| Order | Brief | Intended result |
| --- | --- | --- |
| 1 | [Preserve partial outbound-call evidence](2026-11-05-analysis-coverage-task-01-partial-call-evidence.md) | A bounded plan to retain known Java request details and unresolved workspace-impact context without inventing links. |
| 2 | [Connect Angular template expressions](2026-11-05-analysis-coverage-task-02-template-expressions.md) | Reproduce a missing public dependency and propose the smallest safe binding mechanism using the installed parser. |
| 3 | [Investigate contract data changes](2026-11-05-analysis-coverage-task-03-contract-data.md) | Establish which contract changes are lost, their practical impact, and a staged plan for operation-level evidence before field-specific consumers. |

The order expresses the recommended integration sequence, not measured return on investment. Investigations can run independently. No agent may edit shared production files during this stage. If later implementations overlap in fact schemas, composition, MCP rendering or version identity, the lead assigns one owner and sequences integration.

## Shared decision standard

Distinguish these outcomes:

- **Recovered dependency:** a correctly identified consumer, symbol, entrypoint or cross-service link that the baseline missed.
- **Preserved evidence:** useful known information reaches the public answer; no additional reach is claimed.
- **Truthful uncertainty:** unsupported or ambiguous input is explicitly represented without inventing a relationship.
- **Reduced noise:** a false attribution or unnecessary cut is removed; this alone does not prove added coverage.

The original adapter probes demonstrated missing template-expression output, identical operation extraction after a schema type change, and Java request details lost when the base is unknown. They did not establish end-to-end coverage gains, application frequency or performance improvements. Each agent must close those evidence gaps before recommending implementation.

## Existing work to reconcile

Read [Current Engine Mechanism Improvements](2026-11-05-current-engine-mechanism-improvements.md), especially its evidence inventory and conditional Task 7, before proposing work. That plan already covers exact occurrence identity, compiler signature selection, provenance and bounded investigation of Angular bindings. The template brief refines that open investigation; it is not a second implementation of it.

Read [Semantic Provider Migration Reassessment](2026-11-05-semantic-provider-migration-reassessment.md) before recommending LanguageService, Angular LS, JDT or replacement indexing. Older type-root measurements in [RFC-0016](../../architecture/rfc/0016-type-resolution.md) describe their recorded baseline, not current performance or the maximum capability of those tools.

For public evidence delivery, reconcile [ADR-0022](../../architecture/adr/0022-typed-query-replay-and-selective-evidence.md) and the existing [selective recovery design](../specs/2026-11-04-mcp-selective-evidence-recovery-design.md). Recovering evidence omitted by presentation cannot retrieve data discarded by analysis. Do not implement a competing response API.

## Required return from every agent

1. State `completed`, `partial` or `blocked`; record the inspected SHA and relevant local modifications.
2. Separate reproduced behavior, source-based conclusions, external capabilities and unverified hypotheses.
3. Provide source locations and exact reproduction commands, expected versus observed public facts, and negative controls.
4. Identify existing owners, reusable helpers, overlap with accepted work and the smallest useful scope.
5. Produce an improved implementation plan with files, contract decisions, tests, break proofs, integration and measurement steps. Keep unresolved consequential decisions explicit for the project owner.
6. Recommend implement, narrow, defer or reject, with evidence. A negative result is valid.

Do not implement, add dependencies, commit, push or change an accepted ADR during this assignment. No new subagents. The lead coordinates later implementation after the owner resolves consequential design choices. This document itself introduces no architecture decision.

## Handoff verification

On 2026-11-05, all three embedded adapter probes were rerun successfully on Node 24.22.2 with the observations recorded in their briefs. Repository paths and relative links were checked. `npm run check` passed typechecking, architecture checks and all 1,891 tests. These checks validate the handoff baseline; they do not replace the proposed end-to-end investigations or real-application measurements.
