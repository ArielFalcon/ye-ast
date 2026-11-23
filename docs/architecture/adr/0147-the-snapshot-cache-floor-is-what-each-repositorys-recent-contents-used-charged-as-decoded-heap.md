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
6. **An entry keyed by a request is not counted in the floor** (amended 2026-11-23, phase-2 review). An entry's key
   grows either with the content (the sources, a file's facts, a stage over the index) or with what one request asked
   of that content: an answer (ADR-0151), and a Java derivation kept per file by the places a request asked in it or by
   the sites of a request (`keptByFile`, the receiver methods; ADR-0119, ADR-0120, ADR-0146). The caller names which
   when it admits (`KeyedBy`). A request-keyed entry is charged to no content, so the floor stays the content's working
   set. Otherwise it is held and evicted as any entry: never while the current read, the two before it or an open query
   used it; above the floor, after the stale entries, least recently used first, and of a content entry and a request
   one last used by the same read, the content entry first (the answer stands for the whole derivation that read it).
   Distinct requests at one content then keep at most the floor plus what the held reads asked, whatever their number.
   When the oldest stale entry is held, eviction goes on with the others instead of stopping.
7. **A read charges its own content** (amended 2026-11-23, phase-2 review). `beginRead` answers a handle whose lookups
   and admissions count for the content that read reads, whatever read began after it, and each charge is measured
   against the repository of the content it reaches. Two overlapping queries on different repositories then measure
   each repository's own working set, and the floor stays the largest of them, not a mix. A lookup or admission made
   on the cache itself still counts for the latest read.

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

- Amendment 6 and 7 (phase-2 review): before them, every answer of a distinct request was charged to the content it
  answered over, so the floor (the maximum ever measured) rose with each one and nothing was evicted while that content
  was among the repository's latest: a cache-level probe kept 401 MiB after 2,000 distinct 100 KB outputs at one
  content, with 0 evicted. Measured in process on shopizer/backend, 200 distinct `callers` requests at one revision
  (`main` `83a1ffd7d` against the amendment; Apple M1 Max):

| After request | Before: retained / floor | After: retained / floor |
|---|---|---|
| 1 | 278.3 / 278.3 MiB | 278.3 / 267.0 MiB |
| 10 | 331.0 / 331.0 MiB | 273.5 / 273.5 MiB |
| 200 | 561.1 / 561.1 MiB | 273.5 / 273.5 MiB (at most 295.9 between requests) |

  The floor stops growing once the content's working set is read; the per-request wall time moved within noise
  (p50 996 → 980 ms) and a repeat of the last two requests still hits (25 ms). The latency bench `unchanged` cells of
  shopizer/backend and jhipster-monolith/application (seven families, five repetitions) moved within noise
  (shopizer `callers` p50/p95 174/198 → 175/185 ms, jhipster `callers` 93/94 → 93/95 ms). A first build held a
  request-keyed entry only by the read that used it: the answer of the first `callers` was then the only entry the
  next two reads could evict while they admitted more of the content, and the bench's first repeated `callers` derived
  it again (p95 198 → 1,673 ms on shopizer/backend, 94 → 181 ms on jhipster). Hence the hold of decision 6. No answer
  changed: the warm differential on petclinic/backend-rest and realworld-nx/frontend passed 55 steps with 0 differing.

## Not decided here

- A separate budget for derived facts (ADR-0035) and the disk tier's retention (ADR-0077).
- Keeping the importers' selection of module statements, the completed hierarchy and the unresolved references
  (ADR-0143 "Not decided here").
- Per-kind charge factors: one factor keeps the charge a ceiling with one rule; revisit if a measurement shows the
  over-count matters.
