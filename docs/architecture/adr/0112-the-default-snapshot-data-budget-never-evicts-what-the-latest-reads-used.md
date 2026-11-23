# ADR-0112: The default snapshot data budget never evicts what the latest reads used

- Status: Accepted, 2026-11-16, owner
- Decision source: Owner, 2026-11-16, on the live-burst measurement (T5): "darle a la caché un presupuesto acorde al
  tamaño del grafo, o usar el nivel en disco de DerivedFacts (ADR-0077), que ya existe" (give the cache a budget that
  matches the size of the graph, or use the disk tier of DerivedFacts, which already exists).
- Amends: [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md) decision 1 (the default budget) and
  [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) decision 3 (what an admission may evict)
- Amended by: [ADR-0127](0127-the-default-snapshot-cache-floor-is-the-working-set-the-corpus-measures.md) (decision 1: the
  floor is 128 MiB)
- Amended by: [ADR-0147](0147-the-snapshot-cache-floor-is-what-each-repositorys-recent-contents-used-charged-as-decoded-heap.md) (decisions 1 and 2: the floor is derived from what each
  repository's recent contents used, not configured)
- Related: [ADR-0030](0030-live-captures-use-the-snapshot-data-cache.md),
  [ADR-0035](0035-derived-facts-are-retained-by-content.md),
  [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md),
  [RFC-0006](../rfc/0006-configuration.md), [RFC-0010](../rfc/0010-impact-queries.md) "No live fact cache; retained
  snapshot data", [RFC-0012](../rfc/0012-observability-and-measurement.md)

**In short:** with the default budget the cache keeps the entries the current read and the two reads before it used,
even when they exceed 32 MiB, and evicts only older entries to make room. A repeated live call on a large repository
reuses everything the previous call derived instead of evicting it entry by entry before it is needed again. A host that
sets `snapshotCacheBytes` keeps a hard cap, as before.

## Context

Measured through the stdio MCP on a Java backend of 1,340 files (3.9 MB of sources), live, with no edit between calls
(run `20261116T180604Z-live-burst`, main 99687a70b):

| Call | Wall time | What it spent |
|---|---|---|
| `callers`, unchanged, p50 | 16.4 s | `receiver-methods` 3.9 s, `member-names` 2.1 s, `relations` 2.0 s, `entrypoints` 1.7 s, derived again |
| `impact`, unchanged, p50 | 0.58 s | served from the cache |
| `callers` on an Angular webapp (6 MB), unchanged | 1.8 s | served from the cache |

- One `callers` call admits three snapshot entries (4.0, 4.2 and 11.8 MB, the sources with their findings and the two
  reader outputs) and 1,849 derived facts of about 45 KB each (82 MB). It evicts about 1,050 entries per call and finds
  none of its own facts (`derived-facts` hits 0). The working set is about 100 MB against a 32 MiB budget.
- The cause is the policy, not one slow reader. A cache of least-recently-used entries read cyclically by a working set
  larger than its budget evicts every entry just before it is needed again: it hits nothing, and each call still pays
  to serialize and evict the whole set. The Angular webapp's working set fits, so it hits.
- The ratio of the working set to the sources is not a size to configure from the sources: it is about 25 for this Java
  repository and under 5 for the Angular webapp, because a Java file's declarations, calls and receiver bindings
  serialize larger than the file.
- ADR-0021 chose 32 MiB as "an initial bounded default, not an optimal size claimed for every repository", and left
  "automatic budget sizing" undecided. ADR-0035 left "a separate budget" for facts undecided.
- The disk tier ADR-0077 decides has not been built: no code reads or writes derived facts outside the process
  (`createDerivedFacts` takes only the snapshot data cache, `src/core/application/snapshot/derived-facts.ts:16`). It
  also needs an identity of the engine in every key, which no slot carries today, and it would not stop the facts from
  evicting the snapshot entries of the same call from memory.

| Option | Verdict |
|---|---|
| A larger fixed default | Rejected: any constant is below some repository's working set, and the measurement above has no basis for choosing one |
| A budget proportional to the bytes of the sources | Rejected: the ratio is 25 for one language and under 5 for another |
| A budget from a fraction of the host's memory | Rejected: a new constant, unrelated to the graph |
| The disk tier of ADR-0077 | Not taken here: a separate, larger decision (engine identity, retention, atomic store) that does not remove the eviction of snapshot entries by facts |
| Keep what the latest reads used | Chosen |

## Decision

1. ADR-0021 decision 1 is amended. The default budget of 32 MiB is a floor, not a cap: an admission evicts the least
   recently used entries that the current read and the two reads before it did not use, and when none remains it admits
   the entry over the floor. The retained bytes are therefore at most the floor plus what three reads used.
2. A read is one preparation of a snapshot, from its first lookup of the retained entry. Two reads are the base and the
   head of a change query; the third is the one being made.
3. An explicit `snapshotCacheBytes` keeps ADR-0020's meaning: a hard cap that bounds the retained bytes, with an
   explicit zero disabling retention (ADR-0021 decision 2). An entry larger than a hard cap is still not admitted
   (ADR-0030 decision 10).
4. Nothing else changes: the keys of snapshot entries, outputs and facts, the deserialization afresh, the admission only
   of completed work, and the `cache` and `derived-facts` lines of RFC-0012. Eviction changes cost, never the answer.

## Consequences

- A repeated live or SHA call on a repository whose working set exceeds 32 MiB reuses its entries after the first call
  derived them. An edit to one file derives again that file's facts and the entries keyed by the whole listing; the
  facts of the other files hit.
- The process may hold the working sets of three reads over the floor, plus the runtime's bookkeeping. On the measured
  repository that is about 100 MB beyond today's 32 MiB. A host that needs a bound sets `snapshotCacheBytes`.
- The disk tier of ADR-0077 stays as decided and unbuilt; this decision does not depend on it and does not replace it.

## Not decided here

- The disk tier of ADR-0077: its engine identity, retention and store. The measurement of this decision (run
  `20261116T203056Z-u1-cache`) is its baseline.
- A separate budget for derived facts (ADR-0035).
