# ADR-0127: The default snapshot cache floor is the working set the corpus measures

- Status: Accepted, 2026-11-22, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 D2, and the owner's target
  (translated): "Times must sit between a few hundred milliseconds and, for the most critical jobs, 3-5 s in specific
  cases; the p75 should be below 1 s". The owner's rule of 2026-10-30 that a limit waits for measurements on real
  repositories is met here by the latency bench's repositories (RFC-0040 L9a, review finding R11).
- Amends: [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md) decision 1 (the default budget) and
  [ADR-0112](0112-the-default-snapshot-data-budget-never-evicts-what-the-latest-reads-used.md) decision 1 (the size of
  the floor)
- Superseded by: [ADR-0147](0147-the-snapshot-cache-floor-is-what-each-repositorys-recent-contents-used-charged-as-decoded-heap.md) (decision 1: no configured floor; the floor is measured)
- Related: [RFC-0006](../rfc/0006-configuration.md), [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md),
  [ADR-0126](0126-the-snapshot-cache-keeps-decoded-frozen-values-and-names-a-file-by-its-blob-id.md)

**In short:** the default floor of the snapshot data cache is 128 MiB, not 32 MiB. On the largest corpus repository the
seven query families retain 112.2 MiB between them; under 32 MiB the floor protected only the last three reads, so each
family evicted what the next one needed (26,543 evictions in three steady rounds, 12,470 of them by `callers`). Under
128 MiB the same rounds evict nothing and every family hits. A host that sets `snapshotCacheBytes` keeps its hard cap.

## Context

ADR-0112 made the default a floor: an admission never evicts what the current read and the two before it used, and a
query that opens a snapshot preparation is one read (ADR-0121). That removes the cyclic eviction inside one family. It
does not protect a family from the next one: after three reads, whatever the repository's working set holds beyond
32 MiB is evictable, and the families ask different questions of the same entries. ADR-0112 declined a larger constant
for want of a measurement; the latency bench (RFC-0040 L0) is that measurement.

Measured through the stdio MCP, live, the snapshot cache charging the bytes of key plus serialized value as it does
today (ADR-0126 keeps decoded values but charges unchanged; the heap is L9b), one process per repository, one round of
`callers`, `trace`, `impact`, `outline`, `importers`, `entrypoints` (the `map` of the CLI) and `workspace` on the
repository's first gate query of each family, then three more rounds. The working set was read with a 1 GiB floor, so
nothing evicted it; the evictions are counted at the old and at the new default.

| Repository | Retained after one round of all families | Steady evictions at 32 MiB | at 128 MiB |
|---|---|---|---|
| petclinic/frontend-angular | 5.9 MiB | 0 | 0 |
| jhipster-monolith/application | 6.8 MiB | 0 | 0 |
| shopizer/backend (1,340 Java files) | 112.2 MiB (117,690,170 bytes) | 26,543 | 0 |

What each family adds to the cache on shopizer/backend, in the order of a round, as the growth of the retained bytes
(the snapshot entries are the serialized sources, findings and reader outputs; the rest are derived facts, and an
admission of an entry can be partly offset by an eviction or a replaced entry, so the two columns do not add up):

| Family | Charged in the first round | Of it, snapshot entries |
|---|---|---|
| callers | 35.4 MiB | 19.2 MiB |
| trace | 67.5 MiB | 0 |
| impact | 7.2 MiB | 8.0 MiB |
| outline | 0 | 0 |
| importers | 0.2 MiB | 0 |
| entrypoints | 1.8 MiB | 0 |
| workspace | 0 | 0 |

Steady state of shopizer/backend, medians of three rounds, 32 MiB then 128 MiB:

| Family | Evictions | Misses | Hits | Wall |
|---|---|---|---|---|
| callers | 12,470 → 0 | 3 → 0 | 3 → 6 | 3,234 → 1,528 ms |
| trace | 0 → 0 | 0 → 0 | 6 → 6 | 3,347 → 172 ms |
| impact | 9,018 → 0 | 6 → 0 | 3 → 6 | 1,000 → 165 ms |
| outline | 1,659 → 0 | 0 → 0 | 3 → 3 | 136 → 126 ms |
| importers | 3,396 → 0 | 6 → 0 | 3 → 9 | 1,682 → 972 ms |
| entrypoints | 0 → 0 | 0 → 0 | 3 → 3 | 159 → 147 ms |
| workspace | 0 → 0 | 0 → 0 | 3 → 3 | 1,535 → 1,441 ms |

The two small repositories are unchanged within noise: their working sets fit in 32 MiB.

| Option | Verdict |
|---|---|
| A budget proportional to the sources, to the file count or to the host memory | Rejected, as in ADR-0112: the ratio of the working set to the sources is 25 for Java and under 5 for Angular, and the working set is not a function of the machine |
| Keep 32 MiB | Rejected: the one repository above it loses the cross-family reuse the whole latency program depends on |
| A hard cap of the measured working set | Rejected: a hard cap evicts a working set that grows past it, and the floor already holds what the latest reads used |
| 128 MiB as the floor | Chosen: the next power of two above the largest working set measured (112.2 MiB), a configured value |

## Decision

1. ADR-0021 decision 1 and ADR-0112 decision 1 are amended: the default floor is 128 MiB. It is a configured value of
   composition (RFC-0006), read from the measurement above and not from a file count or a size of the sources. Every
   other rule of ADR-0021, ADR-0112 and ADR-0121 stands: the floor is never a cap, an explicit `snapshotCacheBytes`
   is a hard cap, an explicit zero disables retention, and no bytes are reserved in advance.
2. The value is revisited when a measurement of a larger repository or of the decoded tier's heap (RFC-0040 L9b)
   shows a different working set. It is a default, not a claim of an optimal size.

## Consequences

- On a repository whose families retain more than 32 MiB between them, a call after another family finds its entries:
  shopizer/backend's `trace` falls from a 3.3 s to a 0.17 s median and `impact` from 1.0 s to 0.17 s, with no change of
  answer (no key changes; this decision touches no keying, so no warm differential applies).
- A process holds up to 128 MiB of serialized entries before the floor lets it evict, plus what three reads used beyond
  it (ADR-0112). Until L9b, the decoded values take more heap than the bytes charged. A host that needs a bound sets
  `snapshotCacheBytes`.
- Repositories that already fit in 32 MiB hold the same bytes as before: the floor is reached later, never reserved.

## Not decided here

- The heap charge of the decoded tier and the working-set floor per repository (RFC-0040 L9b).
- A budget for the derived facts separate from the snapshot entries (ADR-0035).
