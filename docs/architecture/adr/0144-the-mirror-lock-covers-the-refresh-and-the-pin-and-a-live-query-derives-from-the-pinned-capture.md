# ADR-0144: The mirror lock covers the refresh and the pin, and a live query derives from the pinned capture

- Status: Accepted, 2026-11-22, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 D4: "The mirror lock covers
  the refresh only; a query computes on a pinned generation", and RFC-0040 §3.3: "The image and the sources are loaded
  inside it, because the three statements of a bulk read must see one committed store. After that, a pinned reader
  touches neither the store nor the mirror files, so a later sync cannot change what it reads. Derivation runs outside
  the lock." The targets it serves (translated): "Times must sit between a few hundred milliseconds and, for the most
  critical jobs, 3-5 s in specific cases; the p75 should be below 1 s [...] without sacrificing functionality and
  quality."
- Amends: [RFC-0010](../rfc/0010-impact-queries.md) "Live head" ("One live query", steps 1 and 6, and "First live
  index"); [RFC-0005](../rfc/0005-transports.md) "Live freshness" (rule 1);
  [ADR-0125](0125-a-live-store-is-read-into-a-graph-image-named-by-its-committed-store-generation.md) decision 3
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.1, §3.3, §3.4, §5, D4

**In short:** a live query takes the mirror lock, refreshes the mirror, commits its store generation, opens the store
at that generation as an image and loads the capture's sources, then releases the lock. Everything it derives after
that reads the pinned capture only: its export, its sources and its image. A later sync by another process rewrites
the mirror's files and store without changing what a pinned query answers, so live queries on one mirror no longer
wait for each other's derivation.

## Context

The lock was held from the refresh until the answer was built (RFC-0010 "One live query", step 6), with a 50 ms poll
(`live-mirror.adapter.ts`). Three servers on one clone answered with the throughput of one, and 62 % of the wall time
of a burst run was spent waiting for the lock (RFC-0040 §2, M8). The lock existed so that no query read a mirror whose
sources and store a refresh was changing. After ADR-0125 the store a query reads is an immutable image named by the
committed store generation; the sources are plain values in memory once read. What still reached the mirror after the
refresh:

| Read | Where | Why it must not run after release |
|---|---|---|
| The sources, read on first use from the mirror's files | `live-snapshot.ts` | A later reconcile rewrites those files |
| A store opened after the refresh, or a second open of it, without a generation | `head-reading.ts` `liveReading.open` | It read the store a later sync had changed, through SQL |
| The store a build or sync committed, opened when the query took it | `live-tree.ts` | Opened after release, it could load a later sync's store under this query's generation |
| The live side of an of-change diff, copied from the mirror | `impact-queries.ts` `ofChangeLive` | The paths are known only after the base is read, which is too slow for the lock |

## Decision

1. **The locked section.** Under the mirror lock, as one operation: reconcile the mirror with the working tree, stage
   and sync or build the store, commit the state with its `stateId` and store generation (ADR-0125), then pin: open
   the store at the committed generation, and load what the caller reads from the mirror's files (the capture's
   sources, from the snapshot cache by content or from the files, and HEAD). Then the lock is released. The staleness
   check and the retention sweep run after the answer, as before.
2. **The pin.** A pinned capture holds its export, its sources and a reader of the store's image. A query that reads
   the store and finds it unchanged pins the reader that proved it; one that built or synced opens the store it just
   committed before it releases the lock. A pin whose sources cannot be read fails the capture with that fault, and
   nothing reads them again after release.
3. **Derivation reads the pin only.** After release nothing a query derives opens the store, reads the mirror's files
   or reads its state. Every reading of one capture shares its one image reader; closing it is a no-op, and the live
   query releases it when it returns.
4. **The image is whole at open.** `CodeGraph.open(store, generation)` with a non-empty generation always answers from
   an image read in full before `open` returns, kept for that generation within the live budget when it fits
   (ADR-0125 decision 2) and unkept otherwise, so the reader never reads the store afterwards. A refresh treats a state
   that claims a build but names no generation as a store that does not serve, and rebuilds it.
5. **Bytes the pin does not hold.** A query that needs, after release, mirror bytes outside its sources (the live side
   of an of-change diff) copies them with each file's git blob id checked against the pinned export. A file whose
   bytes moved since the pin, because another process synced the mirror meanwhile, is not used: the answer is
   `unknown` with reason `source-unreadable`, never one built from bytes of another state.
6. **Several repositories.** A capture over several repositories pins each one under its own lock, in root order, and
   releases it before taking the next. No two mirror locks are held at once.
7. **Launch priming.** Priming pins a capture as a query does and runs its steps outside the lock. Before each step it
   checks for queries of its process; when one is in flight it ends the capture, waits for those queries and pins
   again, so it primes the state the queries left.
8. **Unchanged.** What a refresh copies, syncs and commits; `unknown` with `index-unavailable` for a refresh cut by the
   deadline or a lock still held at it; the staleness notice, computed after the answer against the pinned manifest;
   the sync worker (ADR-0125 decision 4). An older state is never served as current: a query answers the state it
   pinned, and a tree that moved after the pin is reported by the staleness notice.

## Consequences

- Live queries on one mirror, in one process or several, overlap their derivation; only the refresh and the pin are
  serialized.
- A query after an edit loads the store's image under the lock; a later query that reads the store at the same
  generation finds it kept.
- A query that reads the store after a build or sync now opens it even if it never reads it; every family that asks
  for a store reads it, so no query pays a load it did not pay before.
- An of-change query can answer `unknown` with `source-unreadable` when another process synced one of its changed
  files between its pin and its diff. The window is the of-change derivation; the next query answers the new state.
- `CodeGraph.open` changed, so the staging rules version moves to 15 and every mirror is rebuilt once, through the index
  cache when it holds the content (ADR-0129).

## Not decided here

- A refresh ahead of the query and a published generation swapped by one reference (RFC-0040 §3.1, phase 3, L19).
- Resident stage outputs keyed by the store generation (RFC-0040 L16).
