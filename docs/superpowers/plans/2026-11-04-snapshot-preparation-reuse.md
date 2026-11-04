# Reuse snapshot preparation

Goal: Remove measured repeated work without changing deterministic facts or public query contracts.

Approved direction: Keep preparation owned by application/snapshot; share compatible immutable SHA preparation through one operation, preserving selection, budget, trust and cancellation. Sources and entrypoint extraction are separate lazy stages. Temporary exports are removed after all consumers finish. Live reads retain their lock and lifecycle. TypeScript syntax reuse is weakly held by source identity and parser options; compiler programs remain separate.

Owner approved optional cross-request memory retention with an explicit host budget on 2026-11-04. No disk export retention is authorized. See ADR-0020.

## Tasks

- [x] Add regressions for exactly-once export/load/extract in a shared operation, distinct preparation inputs, cancellation and cleanup on failure.
- [x] Add internal operation preparation and lazy source/extraction stages in application/snapshot. Route SHA head, change and workspace reads through it; preserve existing no-session behavior.
- [x] Wire operation-scoped workspace impact in composition, keeping read-only public ports unchanged. Verify discovery and walks share preparation while building independent facts.
- [x] Make importers load sources without extracting entrypoints; guard SHA and live behavior and cancellation.
- [x] Reuse compatible TypeScript syntax trees with weak source keys. Verify option separation and content invalidation; preserve adapter outputs.
- [x] Implement budgeted cross-request immutable data reuse, with trust/revision revalidation and independent cancellation.
- [x] Run focused regressions and type-compatible break proofs, independently review integration, search all preparation/parser call sites and run npm run check. No commits or push.

Verification: npm run check passed with 1,627 tests; three type-compatible break proofs failed as intended; independent review found no actionable defects. Frozen real-MCP impact and importers responses were byte-identical before and after. Cross-request retention was subsequently approved; its final verification is recorded below.


## Cross-request implementation

- [x] Add explicit host `snapshotCacheBytes` and per-composition serialized data storage with UTF-8 byte accounting and LRU eviction.
- [x] Restore data lazily after a fresh Git export, preserving current SHA, source, trust, scope, export budget, listing and cuts.
- [x] Guard independent cancellation, no retained in-flight work, mutation isolation and export-only consumers.
- [x] Verify live bypass and real cold/warm MCP response equality, then review and run the global gate.

Final cross-request verification: npm run check passed with 1,644 tests, typecheck and architecture checks. Twenty real MCP calls preserved full response bytes with retention disabled/enabled. Independent review found no concrete defects. Six integration mutations and six storage mutations were detected. No commit or push.
