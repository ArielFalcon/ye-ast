# ADR-0023: Preserve family views inside operation snapshots

**Status:** Accepted implementation reconciliation; the mixed workspace capability is not yet implemented.
**Date:** 2026-11-05
**Deciders:** Codex implementation lead, within the owner's authorized capability implementation and ADR-0022 strategy.

## Context

[ADR-0022](0022-typed-query-replay-and-selective-evidence.md) requires one selected state per repository throughout a
workspace operation. The [mixed snapshot design](../../superpowers/specs/2026-11-04-mixed-workspace-snapshots-design.md)
proposes nested live leases and a captured extraction shared by the query families. Source inspection established two
constraints that the implementation must preserve.

Committed discovery and callers select `isInMapScope`; composed change analysis selects the wider `isWritten`, which
also includes JSON module resources. Their prepared exports have separate source-selection dependencies. A wider export
can exhaust `ExportBudget.maxBytes` before a narrower export would stop. The resulting export has no omitted listing or
file sizes from which to reconstruct the narrower result. One budgeted union extraction therefore cannot generally
preserve both existing committed answers.

Live extraction already reads the wider set staged in its captured mirror. Reusing that held tree does not require
replacing committed selection semantics. Separately, retention measures which scopes are locked and later deletes its
candidates. Another operation can acquire a candidate between measurement and deletion. The current destructive
methods do not reserve that candidate's lock.

## Decision

Resolve current membership, authority, trust, canonical roots and committed SHAs once per workspace operation. Preserve
the selected state throughout the callback lifetime; no result or capture handle survives the operation.

For committed states, retain existing family-specific prepared exports and extraction views of the same pinned SHA,
with their existing selection functions and budgets. Compatible views may share preparation through the existing
dependency checks. Different selections must not silently share an export or index root. Views remain operation-owned
and are created only when the operation needs them. This explicitly relaxes the draft's literal one-extraction rule
for committed repositories; it does not introduce another snapshot or a working-tree reread.

For live states, capture each canonical location once and hold its lease through discovery, matching and all walks.
Reuse the captured bytes, extraction and index tree. A consumer must not reacquire the location or substitute HEAD.
Current trust and replay validation remain prerequisites; a later operation captures and validates again.

Return callback values and final observations in a named private operation result. Keep captured handles inside the
callback, and construct the result carrier after postludes and owned cleanup. The carrier may hold the value, replay
context and repository notices; it is not a retained result store or a change to deterministic public facts.

At retention's destructive boundary, reserve the candidate scope's existing lock atomically and without waiting.
Delete only while that reservation is held, and release it on every outcome. Skip a busy candidate, including debris
associated with that scope. The measurement remains a policy input rather than deletion authority. Waiting for a busy
candidate inside a nested operation is prohibited because it can create a lock-order cycle. Do not remove another
holder's lock or weaken directory, symlink and path checks.

Keep the two destructive uses distinct: `refresh` resets an incompatible mirror while it already owns that lock;
retention must use a separate idle-only operation. Adding a lock attempt to the owner-held reset would turn the reset
into a skipped deletion or a reentrant wait.

State temporaries must encode their scope before retention can reserve that scope. Use scope-bearing names for new
state writes. Legacy anonymous temporaries cannot be attributed safely and must be left untouched by opportunistic
retention. Lock-attempt temporaries can precede acquisition, so a scope reservation alone does not prove that such a
file is unused; leave them untouched unless inactivity is independently established. This can retain old debris and
must be reported as a limitation rather than claiming complete reclamation. No store migration is required.

## Options considered

| Option | Compatibility | Cost and complexity |
| --- | --- | --- |
| One committed union export and extraction | Changes selection inputs and can change budget cuts; equivalence is unproved | Fewer preparations, with an unsupported semantic assumption |
| Existing family views of one pinned SHA | Preserves current selectors, budgets and typed failures | May prepare more than one export/extraction per SHA; uses existing preparation boundaries |
| Retention relies on measured lock flags | Leaves an acquisition/deletion race | Smallest code, insufficient capture protection |
| Retention waits for a deletion lock | Protects deletion but can block a nested operation on another held lease | Unacceptable lock ordering |
| Retention reserves without waiting | Protects active captures and preserves forward progress | Busy or stale lock files can defer cleanup; requires tests at deletion time |

## Trade-off analysis

State consistency and existing committed facts take priority over an unverified extraction-count optimization.
Prepared SHA views are not retained final facts. Their additional work is explicit; no latency or cache-hit benefit is
claimed. Live still has one captured tree per selected repository.

Retention is opportunistic. Skipping a lock that cannot safely be reserved can temporarily leave usage over policy;
that is preferable to deleting active data. Existing lock acquisition remains responsible for its stale-lock policy.
Cleanup must not introduce another waiting lock or a new lock namespace.

## Consequences

- The internal captured SHA representation contains prepared family views; the wire snapshot vector is unchanged.
- Capture-aware consumers must match canonical root, selected kind, effective scope and compatible preparation inputs.
- Public live support must land coherently across discovery, callers, change impact and decisions, which share member
  types. Existing transports retain their committed subset until integration is complete.
- Retention safety is an independent prerequisite that can be implemented and reviewed before widening those ports.

## Action items

- [x] Guard scope and associated-debris deletion with a nonblocking reservation and public adapter regression tests.
- [ ] Implement operation capture and prepared views without changing ordinary committed selection or budget behavior.
- [ ] Integrate all four core families and cancellation/staleness outcomes before exposing mixed live selectors.
- [ ] Verify actual mixed-state reuse, concurrent ordering, alias rejection and resource release with isolated fixtures.
