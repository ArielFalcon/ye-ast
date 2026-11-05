# Java value flow

## Specs

S1: Arbitrary-depth source method summaries with preserved argument scopes.
S2: Source hierarchy dispatch with explicit unresolved disagreement.
S3: Abstract records from source-proven object construction and accessors.
S4: Evaluated Map keys and consuming-module configuration.
S5: Evidence-backed standard OkHttp leaf.
S6: Deterministic findings and cycle termination.
S7: Corpus stdio acceptance and resource comparison.

## Tasks

| Task | Route | Commit | State |
|---|---|---|---|
| Design and baseline | RFC-0021 and external run artifacts | docs: design Java value-flow summaries | completed |
| Shared summary propagation | Spring adapter port | fix: propagate Java client summaries through source calls | implemented; subscription helpers pending |
| Object and configuration values | JavaValueEvaluator and adapter fixtures | fix: evaluate source object and keyed configuration values | implemented |
| Standard client vocabulary | HTTP adapter fixture | feat: read standard OkHttp requests | implemented |
| Integration and measurements | npm run check and real stdio MCP | docs: record Java value-flow validation | measured; NATS acceptance incomplete |

## Log

- Read repository guidance and testing skill from the principal checkout because these ignored files are absent from the worktree. Corpus remains read-only. Engram tools are unavailable.

- Shared source summaries replace both wrapper engines; their former holder/parameter helpers have no remaining consumers and were deleted.
- Record/configuration interpretation remains adapter-local. Architecture cycles were removed by extracting Java value types and a field-lookup contract; no dependency rule was weakened.
- Configuration defaults distinguish absent from undecided. Recursive placeholders track active keys instead of a depth threshold.
- Public fixtures pass for source event returns and template-method subscription overrides. Binary-only facade subject reporting and helper subscription propagation remain acceptance gaps; no vocabulary entry was added for an application library.
- Twelve type-correct mutations were rejected by their targeted public-seam tests. Full validation and external corpus measurements are recorded in the delivery report.

- Delivery gate: `npm run check` passed 2,383 tests with no failures; focused Spring verification passed 244 tests. Twelve type-correct mutants were killed. Repeated source inventories are byte-identical.
- Source corpus HTTP observations changed from 0 complete / 9 unresolved to 10 complete / 1 unresolved; dynamic override remains unknown. Real workspace MCP HTTP links changed from 10 to 14 and unresolved call markers from 21 to 13. NATS facade cuts and decided-subject counts remain unchanged.
- Observed individual cold MCP tool time: 40.191 s reference, 14.408 s change. Wrapper-reported peak RSS: 1,096,744,960 bytes reference, 1,049,853,952 bytes change. Shared-host single-run measurements do not establish a performance guarantee.
- Status remains partial: binary-facade stated subjects and helper subscriptions still need implementation and acceptance. Fact schema and MCP response summaries are unchanged.

- Audit soundness analysis: confirmed stale complete facts through escaping records and aliases at the HTTP reader seam (both regression tests failed complete vs unknown before the fix). Initializer reconstruction ignored reference lifetime; constructor and builder records had the same hole. Mutable records now require a local reference with only proven simple accessors before the read; argument passing, aliasing, field storage and capture invalidate it. Records, Lombok Value and final-field objects retain their immutable mappings. Shared mutable object fields are rejected, and scalar field writes outside constructors invalidate initializer inference. This is deliberately conservative, with no interprocedural mutation guesses.
- Soundness refinement: passing a record to a source method is safe only when every use of that parameter is a proven zero-argument field getter. This preserves the existing URL helper without allowing setter calls or onward escape. Existing helper fixture passes alongside the escaped-record regressions. Disabling recordIsStable killed both new object tests (complete vs unknown); scalar initializer mutation is guarded separately.
- Audit complexity analysis: confirmed 49,152 leaf evaluations for twelve independent two-implementation edges (expected 24) in the deterministic JavaMethodFlow seam test. The Cartesian product represented irrelevant combinations of independent outputs. Expansion now carries alternatives per output position, compares them independently in both readers, and uses an explicit work stack plus binding-context memoization. Cycles retain undecided leaves. No size/depth cutoff is introduced. Forwarded identifier bindings are canonicalized before cache lookup.
- Quality analysis confirmed repeated full-project implementation/Bean scans, inline framework annotation names, duplicated fluent verb membership and misleading UrlText ownership. Dispatch indexes now live once per JavaProject (WeakMap lifetime); methodsOf selects from that index. JavaValueEvaluator names its broader job, imports use the type/annotation owners directly, and held dispatches to binding, construction and invocation readers with setter tracking separate. Shared Java-value vocabulary constants replace inline annotation names; OkHttp uses FLUENT_VERBS. Removed wrapper-era blank lines. Remaining recursive value evaluation translates stack exhaustion to an undecidable value rather than allowing RangeError to escape.
- Follow-up soundness evidence: source read-only helper forwarding must be checked transitively, not rejected outright and not assumed safe. The initial conservative corpus run lost four valid links; an iterative parameter-use proof restored the exact audit linkId set. Additional fixtures guard inherited mutable fields and prevent shared getter defaults from reconstructing stale mutable state.
- Break proofs: record lifetime deletion, scalar write guard deletion, duplicate edge grouping, memo cache deletion, RangeError rethrow and inherited-field omission all typechecked and failed the targeted tests. Logs are external under the new run's break-proofs directory.
- Corpus accepted run: evaluations/runs/20261105T231324Z-value-flow-fixes (verified-*): 14 identical links, 15 unresolved markers (13 prior + two source-unreadable Java sources exposed by rebased main). Three warm RPC times 7.893/8.209/8.124 s, wrapper wall times 11.65/11.98/11.87 s, peak RSS 1,102,462,976 / 1,107,591,168 / 1,109,606,400 bytes. Audit warm base: 7.857–8.320 s, ~1.080 GB. No corpus files changed.
- Remaining audit limitation: the independent-edge Cartesian explosion and repeated identical forwarded contexts are covered deterministically. A global polynomial bound over exponentially many distinct argument-expression contexts is not proven; keep that stronger complexity task open. Existing binary-facade and subscription helper acceptance gaps remain open.

## Audit follow-up tasks

| Task | State |
|---|---|
| Invalidate escaped/shared mutable records and inherited mutable fields | implemented; public regressions and mutation evidence |
| Eliminate independent dispatch Cartesian products and memoize forwarded contexts | implemented; deterministic linear and nested fixtures |
| Translate deep source-return stack exhaustion to unknown | implemented; 3,000-method fixture and rethrow mutant |
| Index dispatch once, name value evaluator and centralize vocabulary | implemented |
| Eliminate exponential distinct transformed binding contexts | open; confirmed 64/256/1,024 contexts at 6/8/10 levels |
| Binary facade subjects and helper subscriptions | open; prior acceptance gaps |

- Stronger complexity audit is now confirmed open, not merely unproven: nested two-implementation forwarding with different appended path segments yields 64/256/1,024 leaf contexts at 6/8/10 levels. External distinct-contexts.txt reproduces it. Blocker 2 is only partially fixed; do not close the audit or claim global polynomial complexity.

- Final gate: npm run check passed typecheck, architecture and all 2,451 tests; git diff --check passed. Final delivery-* corpus outputs are byte-identical and preserve the exact 14 audit linkIds and 15 unresolved markers. Dedicated final warm runs (RPC seconds / harness seconds / peak RSS bytes): 8.115 / 11.88 / 1106690048; 8.044 / 11.82 / 1107361792; 8.074 / 11.84 / 1105838080. Earlier final-* runs overlapped verification and are excluded from acceptance timing. Seven type-correct mutants were killed. Worktree clean before this evidence-only log update; no push. Engram tools unavailable.
