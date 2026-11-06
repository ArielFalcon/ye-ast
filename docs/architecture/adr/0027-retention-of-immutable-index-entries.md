# ADR-0027: Retention of immutable index entries

- Status: Accepted, 2026-11-06, owner
- Decision source: the owner, 2026-11-06, answering "luego haz la implementacion completa del plan que propones" to the
  efficiency plan whose step 7 is "immutable-index retention as a disk-growth problem (ADR-0015 amendment), values from
  measurement"; and the owner, 2026-11-06: "Revisa bien todos los caches implementados para asegurarte que son
  eficientes y seguros, que tienen políticas de validación correctas y que cubren los casos de uso, para evitar dar
  código stale" (decision 8).
- Amends: [ADR-0015](0015-index-reuse-by-content.md) (its "Not decided: garbage collection of kept indexes")
- Related: [ADR-0023](0023-operation-snapshot-views-and-safe-retention.md),
  [RFC-0003](../rfc/0003-codegraph-integration.md), [RFC-0006](../rfc/0006-configuration.md),
  [RFC-0010](../rfc/0010-impact-queries.md) "Retention", [RFC-0012](../rfc/0012-observability-and-measurement.md)

**In short:** the per-user cache of kept full indexes sheds entries by the same signal and the same decided values as
the live mirrors: last use, 14 days unused, 512 MiB of logical bytes, least recently used first. An entry an open
reader holds, and the entry being obtained, are never removed. Retention controls disk growth only; it does not make a
build faster or use less memory.

## Context

- ADR-0015 deferred eviction "until measurements justify one". Run 20261106T131733Z-nname-stage-telemetry-d25598 gave
  them: in one 15-minute varied session over a 7-repository workspace the cache grew from 155 to 363 MB, and a baseline
  run from 156 to 414 MB in 26 entries. Entries range from 3 to 90 MB; one scoped `importers` universe is a 90 MB store
  built in 25 s. Every distinct staged content is a new entry, so growth follows how varied the questions are, with no
  ceiling.
- The live mirrors already have a retention decided by the owner ([RFC-0010](../rfc/0010-impact-queries.md) "Retention",
  `retentionDiscards` in `src/core/domain/snapshot/live-retention.ts`): a pure rule over measurements, supplied by
  composition as typed values (`LIVE_RETENTION` in `src/composition/compose.ts`), skipping the scope being answered and
  any scope a live process holds, with last use read from the state file's modification time.
- Which values transfer:

  | Value | Live mirrors | Index entries | Transfers |
  |---|---|---|---|
  | Last-use signal (modification time) | state file | `summary.json` of the entry, refreshed on every obtain | Yes |
  | `unusedForMs` | 14 days | the same | Yes: the bound is about how long unused data is worth its disk, not about mirrors |
  | `maxBytes` | 512 MiB of logical bytes | the same | Yes: the measured sessions (363 and 414 MB) sit under it, so a session is never evicted from itself, while growth stops at the cap |
  | `keepScopes` (3) | one mirror per scope | none | No: an entry is a content, not a scope; 26 were useful in one session |

  No count cap is introduced. The byte cap and the unused bound are the only limits.

## Decision

1. Retention of kept indexes decides with `retentionDiscards`, the rule the live tree uses, over each entry's logical
   bytes, last use and whether a reader holds it. The entry being obtained is its `current`. There is no count limit.
2. The values are those of RFC-0010 "Retention" for the signal they share: `unusedForMs` 14 days and `maxBytes` 512 MiB.
   A host overrides them through `CompositionOptions.indexRetention`; the adapter removes nothing without a policy.
3. Last use is the modification time of an entry's `summary.json`. Every obtain, a reuse or a publication, sets it to
   the current time. This changes no content of the index, so an entry stays immutable ([ADR-0015](0015-index-reuse-by-content.md) decision 1).
4. A sweep runs once per obtain, after the entry is ready. It never fails the obtain, and what it cannot read or remove
   stays.
5. A reader is protected by a lease. Before an obtain looks at or builds an entry, it writes
   `indexes/.lease-<key>-<pid>-<uuid>` (written complete and renamed into place) holding its pid; the lease is removed
   when the returned store is closed, or when the obtain fails. Retention treats an entry with a lease of a live pid as
   held and never discards it; a lease of a dead pid protects nothing and is removed. A leased entry still counts toward
   the bytes the cache occupies, so the cap is best effort, as in the live tree.
6. Discarding renames the entry away atomically, looks again for a lease on its key, restores the entry if one
   appeared, and removes the renamed directory otherwise. A reader that leases after the rename finds the entry absent
   and rebuilds; a reader that leased before it is seen by the second look. Nothing waits on a lock. This is
   [ADR-0023](0023-operation-snapshot-views-and-safe-retention.md)'s principle of reserving without waiting before the
   destructive step, with a lease per reader instead of a scope lock, since a kept index is shared by any number of
   concurrent readers and has no scope lock to reserve.
7. Each removed entry writes one `index-cache` measurement line (`"outcome":"discarded"`, `entry_bytes`,
   `retained_bytes`, `start_ms`) when measurement is configured, as documented in RFC-0012. The key never appears.
8. The sweep removes a `.build-*` directory (a build in progress or a killed one, including a renamed-away discard)
   when neither it nor any of its direct entries was modified for longer than the debris bound of the live mirror
   (`DEBRIS_STALE_MS`, one hour, the age after which the mirror calls a temporary file debris). A build that writes
   inside the last hour is kept. A build running past that bound without touching its directory or its direct entries
   loses its directory and answers `cache-unavailable`; the next obtain builds again, so this costs time, never a wrong
   fact. Nothing is removed without a retention policy.

## Consequences

- The cache stops growing without bound: it holds at most the cap plus what readers hold and the entry just obtained.
  Retention changes neither build time nor memory; an evicted entry that is asked for again is rebuilt in full (about
  25 s for the largest measured), which is the cost of the cap.
- The temporary `.build-*` directory a killed build leaves is removed by decision 8 once it has gone unwritten for
  the debris bound.
- A lease left by a killed process is removed by the next sweep that sees its pid dead; a reused pid can keep an entry
  longer than needed, which leaves disk over the cap but never deletes live data.
- The 14 days and 512 MiB are decided for the live tree and carried over by analogy; the measured sessions do not test
  the cap, only show the growth it would bound. A different value is an override or a new ADR.
