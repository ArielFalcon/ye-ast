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
| Object and configuration values | UrlText and adapter fixtures | fix: evaluate source object and keyed configuration values | implemented |
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
