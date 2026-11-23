# ADR-0147: The snapshot cache floor is what each repository's recent contents used, charged as decoded heap

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 D2 ("the memory tier keeps
  decoded, frozen objects and a working-set budget"), unit L9b; and 2026-11-17: "todo lo que queda pendiente se debe ir
  integrando a medida que se pueda, lo haces de forma autonoma" (everything pending is integrated as it can be,
  autonomously), over ADR-0127 decision 2 ("revisited when a measurement ... of the decoded tier's heap (RFC-0040 L9b)
  shows a different working set") and ADR-0143 decision 6 (B8 "waits for a snapshot cache floor sized with their
  measured charge"). The targets it serves (translated): "Times must sit between a few hundred milliseconds and, for the
  most critical jobs, 3-5 s in specific cases; the p75 should be below 1 s", "without sacrificing functionality and
  quality", and "caches with robust stale policies".
- Amends: [ADR-0112](0112-the-default-snapshot-data-budget-never-evicts-what-the-latest-reads-used.md) decisions 1 and 2
  (the floor), [ADR-0121](0121-the-snapshot-cache-floor-counts-a-query-as-one-read-however-many-snapshots-it-spans.md)
  decision 1, [ADR-0126](0126-the-snapshot-cache-keeps-decoded-frozen-values-and-names-a-file-by-its-blob-id.md)
  decision 1 (the charge), [ADR-0143](0143-the-plain-outputs-of-the-snapshot-reading-stages-are-kept-across-queries.md)
  decision 6 (B8 waits)
- Supersedes: [ADR-0127](0127-the-default-snapshot-cache-floor-is-the-working-set-the-corpus-measures.md) decision 1
  (a 128 MiB floor)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.2, D2, L9b;
  [RFC-0006](../rfc/0006-configuration.md) "Snapshot data retained between requests";
  [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md)

**In short:** the default floor of the snapshot data cache is no longer a configured 128 MiB. Per repository the cache
counts what the entries last used by its three latest contents of the live tree and of its revisions charge, and the
floor is the most any one repository's count reached; what a content that left them used is evicted first. Every charge is the heap a decoded entry takes, 2.1 times its serialized bytes as measured. With the floor
sized by use, B8's module statements are kept per file under the snapshot's entry, which ADR-0143 had to leave out.

## Context

ADR-0127 set the floor to 128 MiB, the power of two above the 112.2 MiB the largest corpus repository's seven families
retain together, and said it would be revisited with the heap of the decoded tier. Two facts made the constant wrong:

- **It is a size threshold.** Any constant is below some repository's working set (the pillar "signals, never size
  thresholds"). On shopizer/backend an edit already pushes the working set past it: with 128 MiB, each `callers` after
  an edit evicted 1,081 snapshot entries and 883 derived facts (median of three, `edit-now`), `importers` 701 and 174,
  `trace` 150 and 47.
- **It counts serialized bytes, not heap.** ADR-0126 keeps decoded, frozen values, and the budget still charged their
  JSON bytes. Measured through this cache (a heap delta after a forced collection, keys and bookkeeping included):

| Values | Heap per serialized byte |
|---|---|
| shopizer/backend's 10,440 derived facts (51.4 MiB serialized), read back from the disk tier after a bench | 1.63 |
| jhipster-monolith/application's 3,048 derived facts (9.9 MiB) | 1.45 |
| A relation-shaped synthetic fact set (5 MiB) | 1.76 |
| shopizer's sources entry (1,278 files, 4.3 MiB) | 0.96 |
| jhipster's sources entry (565 files, 1.5 MiB) | 0.99 |
| An all-ASCII synthetic sources entry: the decoded strings keep the serialized text alive | 2.07 |

ADR-0143 measured that keeping B8's module statements (about 540 ms per `callers` on shopizer/backend, 116 reads of the
module reader) grew the working set past the 128 MiB floor and evicted what other queries kept, a regression the
owner's rule forbids. It left B8 for a floor sized with its charge.

| Option | Verdict |
|---|---|
| A larger constant floor | Rejected: a size threshold; any value is below some repository's working set, as 32 MiB and then 128 MiB were |
| A floor from the host's memory or the source bytes | Rejected in ADR-0112 and ADR-0127: the ratio of working set to sources is 25 for Java and under 5 for Angular |
| Hold every repository's recent working set in full | Rejected: a host that serves many repositories (qayaba's server) would hold their sum, without bound |
| The floor is the largest working set one repository's recent contents used, measured | Chosen: derived from use, bounded by one repository's working set, and it grows with what a repository needs |

A first build counted one window of three contents per repository and kept plain least-recently-used eviction. On
jhipster-monolith/application, `impact` after an edit regressed from 752 to 918 ms (median of three, `edit-now`): the
bench edits before every call, so the base revision `impact` reads left the window after two edits, and eviction then
took its entries first because they were the oldest, though the floor was sized to hold them. A floor only says how
much is held; which entries go needs the same signal. Hence the two lanes and the stale-first eviction below.

## Decision

1. **The floor is measured** (amends ADR-0112 decisions 1 and 2, supersedes ADR-0127 decision 1). A read names its
   repository, whether it reads the live tree or a revision, and the content it reads (the snapshot entry's key). Each
   entry is tagged with the content of the read that last used it. Per repository, the cache counts the charge of the
   entries tagged with its latest three distinct contents of the live tree and its latest three of its revisions (the
   current one and the two before it, ADR-0112's base and head); edits move only the live lane, so the base revision of a
   change query stays counted. The floor is the largest such count since the cache began. No constant decides it.
2. **What the floor holds.** Below the floor nothing is evicted; above it, an admission evicts the least recently used
   entries, never one the current read or the two before it used (ADR-0112), nor one used since an open query began
   (ADR-0121, unchanged). Many reads of one content (the seven families at one generation) count as one content, so they
   no longer evict each other. When a content leaves its lane, the entries it last used become stale, and an admission
   over the floor evicts the stale entries first, least recently used first, before any other. A host that reads many
   repositories holds the largest one's working set as its floor, not their sum.
3. **The charge is the decoded heap** (amends ADR-0126 decision 1). An entry is charged
   `ceil(2.1 × (key bytes + serialized value bytes))`: the largest measured ratio (2.07), rounded up. The floor, the
   `retained_bytes` of the `cache` line and an explicit `snapshotCacheBytes` count these bytes. An explicit
   `snapshotCacheBytes` stays a hard cap and zero still disables retention (ADR-0020, ADR-0021).
4. **B8's module statements are kept** (amends ADR-0143 decision 6). The statements of one file, read by the module
   reader over every source of the snapshot, are kept per file in a stage-output slot under the snapshot's entry
   (`SnapshotRetention.output`): the entry names trust, scope, export budget and the written listing, which is
   everything they read, so they are kept on the live tree too. A query cut by an abort or a deadline admits nothing.
   The per-file grain keeps the module reader's calls of a cold query unchanged.
5. Nothing else changes: keys, the admission of completed work only, the freeze, the eviction order and every answer.

## Consequences

- Measured with the latency bench (`unchanged`, `edit-now`, `revision`, `rss-slope` over 20 edits, three repetitions;
  medians; Apple M1 Max), `main` `54ff85ba6` against this decision:

| Cell | Before | After |
|---|---|---|
| shopizer/backend `callers`, unchanged: wall / B8 (`module-dependencies`) | 1,504 ms / 481 ms in 116 reads | 961 ms / not read |
| shopizer/backend `callers` at a repeated revision | 961 ms / 483 ms | 444 ms / not read |
| shopizer/backend `importers`, unchanged | 1,063 ms / 483 ms | 542 ms / not read |
| shopizer/backend `impact` right after an edit | 2,714 ms | 2,249 ms |
| jhipster-monolith/application `impact` at a repeated revision | 543 ms / 124 ms in 91 reads | 373 ms / not read |
| jhipster-monolith/application `impact` right after an edit | 752 ms | 754 ms |
| Equal mix p50 / p75 / p95, shopizer/backend | 1,528 / 2,602 / 4,299 ms | 1,496 / 2,410 / 4,258 ms |
| Equal mix p50 / p75 / p95, jhipster-monolith/application | 387 / 667 / 855 ms | 374 / 639 / 859 ms |
| RSS over 20 edits, each followed by the next family: max, shopizer/backend | 2,894 MB | 2,917 MB |
| same, jhipster-monolith/application | 1,134 MB | 1,105 MB |

  After an edit the cache still evicts (shopizer `callers` 1,153 entries): the entries of the content that left the
  live lane, which no query reads again. No answer changed: the warm differential on petclinic/backend-rest and
  realworld-nx/frontend passed 55 steps each with 0 differing.

- A long-lived process holds, beyond what three reads used, at most the largest working set one repository's recent
  contents used, in heap bytes. A host that needs a smaller bound sets `snapshotCacheBytes`, now in heap bytes.
- The charge over-counts derived facts (1.45-1.76) and non-ASCII sources (about 1.0) to stay a ceiling for all-ASCII
  sources. A pinned test asserts that the charge bounds the heap of decoded facts and an all-ASCII sources entry.
- Reads that do not name a content (none in production) count toward no repository, as before.

## Not decided here

- A separate budget for derived facts (ADR-0035) and the disk tier's retention (ADR-0077).
- Keeping the importers' selection of module statements, the completed hierarchy and the unresolved references
  (ADR-0143 "Not decided here").
- Per-kind charge factors: one factor keeps the charge a ceiling with one rule; revisit if a measurement shows the
  over-count matters.
