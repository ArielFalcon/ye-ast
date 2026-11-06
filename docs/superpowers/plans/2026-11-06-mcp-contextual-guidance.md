# Contextual MCP guidance implementation plan

**Goal:** Make continuation guidance useful for the current tool and result, then remove repeated instructions without losing evidence recovery.

**Architecture:** Presentation stays in the MCP driving adapter. Existing typed faults, facts, query schemas and recovery capabilities remain authoritative. Guidance is deterministic, optional and local to the response; no session state, public action schema or generic guidance engine is introduced.

**Contract:** RFC-0005 MCP presentation and shared ownership; ADR-0022 typed replay and selective evidence; the owner's approved proposal and independent design review.

## Constraints

- Preserve facts, scope, traversal, snapshot identity, receipts, recovery, pagination, trust and redaction.
- Code, documentation and commits use English; user communication uses neutral Spanish.
- No dependency changes, remote pushes or edits to unrelated original-checkout changes.
- `details` is explanatory, not exhaustive. Preserve omission counts, material limits, owners and usable selector coordinates/examples.
- Validation remains SDK input validation; use existing capability definitions rather than a second taxonomy.
- A cut kind or matching numeric limit alone does not establish its origin. In particular export and walk cuts both use `caller-budget`; do not recommend `budget.expansions` without evidence of origin.
- A new query after failed replay is not historical recovery. Never silently remove identity assertions or change scope.
- Tests guard observable behavior, executable selectors, typed fields and concrete must-not rules, not exact prose.
- Implementers use Opus 5.5 medium in native T3 child worktrees derived from the parent's committed HEAD. Lead owns merges and final integration.

## Ordered work

- [x] Create parent worktree from original local HEAD; isolate unrelated dirty changes.
- [ ] F1 (blocking): preserve minimal typed family/query context through fault delivery; explicitly handle all public fault kinds, selection/replay/cursor faults and composition source failures. Avoid generic mandatory next-step footers and preserve redaction. Own `server.ts`, fault rendering in `render.ts`, `presentation.ts`, a cohesive fault-rendering module if justified, and relevant tests. Verify focused MCP tests and typecheck. Commit and independently review before integration.
- [ ] V1 (parallel after F1): contextual input validation and truthful per-tool selector shapes. Own `query-schema.ts`, `evidence-schema.ts` and their tests. Cover select/page pairing, tool/owner/workspace eligibility; preserve discovery/runtime parity. No server or renderer changes.
- [ ] P1 (parallel after F1): contextual success/unknown/cut guidance and reduced repetition. Own success portions of `render.ts`, `render-evidence.ts`, `presentation-context.ts`, `presentation-guidance.ts` and corresponding tests. Preserve literal selector recovery, make workspace guides conditional, remove duplicated source navigation, locate continuation beside page. No input-schema or fault-foundation changes. Verify executable selector round trips through the MCP seam.
- [ ] I1: review and integrate V1/P1 into parent, resolve seams, update RFC-0005 to the final behavior, and inspect a global guidance search.
- [ ] I2: run `npm run check`, complete independent whole-change review and fix actionable findings. Do not claim adoption/performance benefits without measurement.
- [ ] I3: integrate validated parent branch into the original checkout, preserving concurrent changes, and report actual checks and remaining limits. No push.

## Acceptance

- Invalid controls identify the rejected constraint without advertising unsupported capabilities.
- Fault advice uses the current family, actual cause and available data; composition identifies source indices and gives the correction once.
- Missing analysis is never described as recoverable by a presentation mode; unavailable historical replay is never described as retained data.
- Complete sufficient answers need no footer; partial/unknown answers retain their meaning and material diagnostics.
- Every printed literal selector remains executable with its recovery recipe. Page continuation preserves selection, limit and identity.
- Changed presentation does not change public facts or source identity. Redaction still covers all new contextual text.

## Progress ledger

- Setup: parent `feature/mcp-contextual-guidance`, baseline `7a9c3425fae894b9153a3f06dd198b9bba21da18`. Original dirty topology work is excluded.
- Ruling: ambiguous `caller-budget` provenance receives no parameter-specific remedy. Reason: export cuts are folded into impact facts alongside walk cuts. Cost: less specific advice for this ambiguous case; no new core provenance contract is needed for this scope.
- F1 first review: three medium findings in `26303c8`: control metadata values changed, live impact advice named excluded head, and persisted workspace membership was treated as explicit request paths. Lead applies bounded corrections and MCP regressions before a fresh scoped re-review.
- Ruling: preserve existing control-fault `detail` values in public metadata and explain their meaning in presentation only. Reason: retain the wire payload while removing duplicated codes from the readable text. Cost: the machine field stays less descriptive; consumers still receive typed fields and contextual presentation.
- F1 fix round 1: metadata compatibility addressed; review identified missing persisted-member variants for unknown revisions and workspace/decisions root failures. Round 2 treats workspace/decisions as workspace consumers even without `repos`, mentions persisted member revisions, and guards all three families through MCP regressions.
