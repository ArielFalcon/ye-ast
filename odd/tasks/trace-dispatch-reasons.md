# Dispatch veto reasons

L1: Deliver only D9 dispatch cut reasons, approved by the owner; drop evaluated scoping without measured gain.

## Specs

- RFC-0013 R7: preserve the baseline dispatch-veto conditions; project fixed reasons through trace and compose.
- Owner decision 2026-11-08: branch from merge-base main/67894e74; keep the scoping branch as historical evidence.
- Closed reasons: aspect may replace the body; generated implementation; dispatch not proven. No SCHEMA bump.

## Tasks

- [x] RED/GREEN reason mapping, unchanged stereotype veto and deterministic precedence.
- [x] Break-proof reason mapping and trace transport.
- [x] Same 111 pinned probes and twelve named evaluation cases: full fact parity after stripping reasons.
- [x] Fourteen-command differential and MCP catalog budget.
- [x] One final npm run check on Node 24.22.2, fully passing.

## Log

- Base: 84ca43617d4ef2e22256e8415e77bc943b351dbe. Historical branch fix/trace-aspect-scope at 67894e74 is unchanged.
- Reused main's isAspect, namesDynamicImplementation, annotation veto and hierarchy reading. No pointcut/XML/Advisor inventory or stereotype permission is included. Global membership is unchanged; aspect reason takes priority over generator APIs regardless of source order.
- RED observes missing reasons. GREEN: 146 focused tests, 386 Spring tests, 3 language-composition tests. Eight guarded-line mutations caught and restored. Catalog tests 3/3 pass (45,287 total discovery bytes, 0 output schema bytes, 4,167 instruction characters).
- Scratch: /tmp/ye-ast-dispatch-reasons.2F2gVL. All state is isolated there. No push.

- Parity: 159/159 paired facts match after removing only allowed Cut.detail values and preserving object/array order. Includes 12 named full traces, 111 pinned probes and 36 warm summaries. Status, complete steps/cuts and effects remain byte-equal. Differential 14/14 stdout/stderr/exit identical, all 0. Real trace and compose each retain the aspect cut reason. Restored focal suite 149/149 pass.

- Final single npm run check on Node 24.22.2: exit 0; typecheck/architecture pass; 3,736 tests pass, 0 fail. No production edits after the measurements except temporary mutations restored byte-for-byte before the gate. Global code-cleanup and repository extension:clean; all added logic reuses the original predicates and transport. No dependency changes or schema bump.

- Implementation unit: ed01882f0cf031ead9f1f1c81efac9c076f9a97b. Rollback boundary: revert the reason mapping, optional fields, language-composition/trace transport and schema companion together; no data migration. Validation unit preserves the historical reports and records final parity. No push or running job.
