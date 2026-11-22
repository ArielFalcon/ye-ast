# ADR-0129: A full live build goes through the index cache, so one content is indexed once whichever query comes first

- Status: Accepted, 2026-11-22, owner
- Amended: 2026-11-22, by the phase-1 quality review of RFC-0040 (finding F1): decision 3 no longer rests on the recorded
  state; the index tree is verified against the written files before it is published
- Decision source: Owner, 2026-11-17: "al instalar el proyecto se haga el trabajo pesado de indexación de todo de fondo,
  para luego solo tener que reindexar lo que cambia y no hacer todo on-the-fly", and "Apruebo las decisiones" over
  RFC-0040, whose phase 1 lists "one index per content" (task L27, with review finding R13: the measured live-then-sha
  duplicate build).
- Amends: [ADR-0010](0010-trust-modes.md) decision 2 (which stores `untrusted` may open),
  [ADR-0015](0015-index-reuse-by-content.md) decision 1 (who may publish a kept index) and
  [ADR-0027](0027-retention-of-immutable-index-entries.md) decision 3 (a live refresh's obtain is an obtain)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §6 phase 1,
  [RFC-0010](../rfc/0010-impact-queries.md) "Live head", [ADR-0028](0028-lazy-export-materialization.md),
  [ADR-0125](0125-a-live-store-is-read-into-a-graph-image-named-by-its-committed-store-generation.md)

**In short:** a live mirror and a sha query of the same content each built their own full index: the mirror in place, the
sha query in the index cache. Every full build of a live mirror now asks the index cache for the content its `stateId`
names; the cache reuses a kept index or builds and publishes one exactly as for a sha, and the mirror takes a private copy
of it. A sync-derived store is never published. The key does not change: equal content means equal staged bytes, so a
store published from a trusted working tree is the store the commit's own export would build.

## Context

- Measured on jhipster-monolith (618 files) at `HEAD`, one process, an empty index cache, `impact.callers`, main
  `cb1796997`:

  | Order | Full builds | Index stage of the second query | Second query |
  |---|---|---|---|
  | live, then sha | 2 | a build, 1,599 ms | 2,564 ms |
  | sha, then live | 2 | a build, 1,433 ms | 2,581 ms |

- The live `stateId` and the sha index key are already the same digest: `contentFingerprint` over the export with
  `isWritten` as the source selection (`live-tree.ts`, `head-reading.ts`). Only the build differed: `buildMirror` in
  place for the mirror, `CodeGraph.index` into a staged copy for the cache.
- A mirrored file's blob id is the git blob hash of the bytes ye-ast copied, computed from the copy
  (`live-mirror.adapter.ts`, `capture`), never `git hash-object` with filters: a working-tree file that differs from its
  committed blob in one byte (line endings, a smudge filter) has another blob id, so another content digest.
- A store records no absolute path (its `files` table holds repository-relative paths), so a store built in one
  directory serves the same files in another. The engine syncs the paths it is given against their content hashes.

| Option | For | Against |
|---|---|---|
| A. Keep two builds | Nothing to change | The duplicate build: seconds on every first live or sha query of a content the other already indexed |
| B. Publish the mirror's own store after `buildMirror` | No copy before the first answer | A second publisher of kept indexes, with another builder; a later sync writes the store a published entry would share unless copied anyway |
| **C. Every full live build obtains from the cache, and the mirror copies the kept store** | One builder and one publisher of kept indexes; a sync-derived store cannot reach the cache by construction | One copy of the store per full live build (a clone on file systems that offer it) |

## Decision

1. **Every full build of a live mirror goes through the index cache** when one is configured: the first build, the
   rebuild of a store that cannot be opened, the rebuild a synthesized-edge query asks for, and the rebuild after a sync
   the engine cannot do. It asks for the content the refresh's `stateId` names, with the index tree as the snapshot. A
   kept index of that content is reused; otherwise the cache builds one with `CodeGraph.index` and publishes it as it
   publishes a sha's (lease, atomic rename, retention, last use).
2. **The mirror holds a private copy.** `CodeGraph.adoptMirror` replaces the mirror's store by a copy of the kept store
   (a copy-on-write clone where the file system offers one, a byte copy otherwise, never a link), releases the mirror's
   sync worker first as a build does, and answers what `buildMirror` answers for the same files. A later sync writes only
   the copy; the kept index stays immutable ([ADR-0015](0015-index-reuse-by-content.md) decision 1). The lease is held
   until the copy is made.
3. **Only an index tree shown to hold exactly the written files is published.** Every refresh removes the paths the last
   state held, and the paths a refresh that did not finish left pending, that the export no longer writes; but the
   recorded state (`indexed`, `pending`) is only a claim, and the mirror lives inside the repository, so its index tree
   can hold what no state names or lack what the state says it holds. Before it asks the cache, a full build therefore
   compares the index tree with the export's written files from the tree alone (`LiveMirror.verifyIndexTree`): every
   entry staging would take, each file rehashed and compared with the blob id the manifest records, no other path, and no
   link or special file. A tree that departs, or that cannot be checked, is built in place, unpublished, and a written
   file it lacks is one the store does not hold (`notHeld`). A store published from the index tree is therefore built
   from the export's written set and nothing else.
4. **A sync-derived store is never published.** Only the cache's own build from files publishes an entry; no path copies
   a mirror's store into the cache. `sha` facts keep reading full builds alone ([ADR-0015](0015-index-reuse-by-content.md)
   decision 3).
5. **The key is unchanged, and trust stays out of it.** The key stays content digest, engine versions and staging rules.
   Equal content means an equal set of (path, blob id) staged, equal skipped entries and an equal budget stop; with blob
   ids hashed from the copied bytes, the index tree then holds exactly the bytes the commit's export writes, and the
   build is the same `CodeGraph.index`, which honours no repository configuration under either mode. A store published
   from a trusted working tree is the store of that export, so an `untrusted` sha query of the same content may open
   it, and a live mirror may copy a store an `untrusted` sha query built. Any other byte, path, skipped entry or stop is
   another key. ADR-0010 decision 2 is amended: under `untrusted` ye-ast opens the stores the host hands over and the
   ones it built itself, from its own export or from its live mirror's copy of the same content. Trust stays in every
   fact's inputs and in every memory key.
6. **Fallback.** An index tree that departs from the written files or cannot be checked (decision 3), a cache that cannot
   be used (`cache-unavailable`), a build fault other than an abort, or a copy that fails builds the mirror in place as
   before, unpublished. An abort answers as an aborted build did.
7. **No new lock.** The refresh obtains while it holds the mirror lock; the cache takes no lock of its own, so the order
   is always mirror lock, then lease, which a waiter never holds.
8. **Measurement.** The copy writes one `index` line with outcome `adopted` and its store bytes
   ([RFC-0012](../rfc/0012-observability-and-measurement.md)); the cache's build writes `built` as before.

## Consequences

- Measured as in the Context table, with this decision: one full build in either order. Live, then sha: the second
  query 2,564 → 584 ms, with no index stage; sha, then live: 2,581 → 899 ms, its index stage a 27 ms copy. The first
  query of either order costs what it did (live 3,569 → 3,238 ms, the copy 40 ms; sha 3,162 → 2,572 ms), and every
  answer equals the other order's.
- A full live build pays the cache's staging (hard links) and one copy of the store; the cache entry and the mirror
  each hold the store's bytes, which retention already counts for the cache (ADR-0027) and for the mirror (RFC-0010
  "Retention").
- The verification of decision 3 rehashes the written files once per full live build: 39 to 42 ms on jhipster-monolith
  (618 files, three fresh clones), beside a full build of about 1.6 s. A sync or a refresh that builds nothing never runs it.
- Without an index cache (`composeQueries` without `indexCache`) the mirror builds in place, as before.
- `STAGING_RULES_VERSION` moves from 13 to 14, since the adapter that builds indexes changed (the fitness test of
  ADR-0015 pins its sources). What a build produces is unchanged, but every kept index and live mirror of version 13 is
  rebuilt once, and that rebuild already goes through the cache.

## Not decided here

- Publishing a store a sync brought up to date, which needs the `sync` parity decision of ADR-0015 decision 4.
- Sharing one store between the mirror and the cache without a copy.
