# ADR-0143: The plain outputs of the snapshot reading's index stages are kept across queries

- Status: Accepted, 2026-11-22, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 D1 (the graph read once into
  an immutable image) and D2 (the memory tier keeps decoded, frozen objects within a working-set budget), and RFC-0040
  §3.2 row "Stage outputs of the assembled reading", corrected by review findings R1 ("`stateId` does not identify a live
  store"), R3 ("`BaseReading` closes over the signal, the parse hold and the store; keep only plain stage outputs") and
  R12 ("typed stages must validate build-output content, not only declared paths"). The targets it serves (translated):
  "Times must sit between a few hundred milliseconds and, for the most critical jobs, 3-5 s in specific cases; the p75
  should be below 1 s", "without sacrificing functionality and quality", and "caches with robust stale policies".
- Amends: [ADR-0045](0045-one-assembly-line-for-the-snapshot-reading.md) decision 2 (the retention of B6) and decision 3
  (a stage runs once per read)
- Amended by: [ADR-0147](0147-the-snapshot-cache-floor-is-what-each-repositorys-recent-contents-used-charged-as-decoded-heap.md) (decision 6: B8's module statements are kept per file),
  [ADR-0150](0150-the-kept-index-stages-are-kept-on-the-live-tree-under-the-pinned-store-generation.md) (decision 3: both stages are kept on the live tree under the pinned store generation)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.2, L16;
  [ADR-0026](0026-snapshot-data-may-retain-reader-outputs.md),
  [ADR-0063](0063-a-jdk-the-host-declares-is-the-library-signature-source.md),
  [ADR-0124](0124-a-kept-index-is-read-once-into-an-immutable-graph-image.md),
  [ADR-0126](0126-the-snapshot-cache-keeps-decoded-frozen-values-and-names-a-file-by-its-blob-id.md),
  [ADR-0127](0127-the-default-snapshot-cache-floor-is-the-working-set-the-corpus-measures.md)

**In short:** B6's reference proofs and the implemented contracts re-asked the import origins of thousands of places on
every query at a revision, though their inputs were those of the previous query. Their plain outputs are now kept in the
snapshot cache's stage-output slots, under the kept index and every input of the origins they ask. `BaseReading`
itself, its readers, its parse hold and its signal are never kept. B8's module statements, the costliest stage measured,
are not kept: every way of keeping them grows the working set past the snapshot cache's floor and evicts what other
queries need. No fact changes.

## Context

ADR-0045 keeps per-file stages by content and leaves the cross-file stages "per read". Phase 1 made the inputs of every
stage cheap to reach (the graph image, decoded frozen values, kept Java readers), which left the per-read assembly as
the cost.

Measured with stage lines on `main` `2cf36f289` (three warm calls per cell, Apple M1 Max):

| Cell | Wall p50 | B8 module statements | B6 reference proofs | Implemented contracts | Reverse calls into targets |
|---|---|---|---|---|---|
| Java backend (1,210 files), live `callers` | 1,541 ms | 550 ms | 49 ms | 32 ms | 369 ms |
| same, `callers` at a repeated revision | 1,048 ms | 536 ms | 46 ms | 28 ms | 128 ms |
| Angular and Java monolith, live `callers` | 241 ms | under 1 ms | 32 ms | 2 ms | 5 ms |
| same, `impact` at a repeated revision | 433 ms | 260 ms | 35 ms | under 1 ms | 22 ms |
| either repository, warm `trace` and live `impact` | 55-280 ms | none | none | none | none |

B8's module statements come from the module reader asked file by file (`edge-targets.ts`); the Java reader builds the
whole project on the first file of each read, because each read hands it a new copy of the sources. The live floor
(lock, listing, reconcile) dominates the rest of every live cell; it belongs to RFC-0040 D4.

The snapshot cache already keeps stage outputs: `SnapshotRetention.output` names a slot under the snapshot's entry
(trust, scope, export budget and the written listing of blob ids or content hashes), charges the value to the cache's
budget, admits it frozen after its serialization round trip (ADR-0126) and admits nothing whose signal was aborted.
B4 relations and the calls through origins already use it.

Keeping B8's module statements was built and measured twice on the Java backend, against an interleaved bench of the
same scenarios (first round, unchanged, an edit then the call, three revisions in an `untrusted` process):

| Variant | Warm `callers` | At an edit, `impact` | First `trace` at the third revision |
|---|---|---|---|
| Not kept (`main`) | 1.6-2.0 s live, 1.1 s at a repeated revision | 20 cache entries evicted, 3.0-3.4 s | 98 ms |
| One slot per snapshot content | 1.0 s live, 0.47 s repeated | 3,150 evicted, 3.1-3.3 s | 3.2-3.5 s |
| Every file's statements read once per read through the per-file derived facts (ADR-0115, ADR-0122) | 1.0-1.3 s live, 0.48 s repeated | 3,056 evicted, 3.2-3.9 s | 3.7 s |
| B6 and the implemented contracts only (this ADR) | as `main` live, B6 and contracts 74 ms to under 2 ms at a revision | 20 evicted | 102 ms |

The slot weighs 5.2 MB per content (5.5 MB more for the selection `importers` reads); the per-file facts add a similar
charge once. Either way the working set grows past the 128 MiB floor that ADR-0127 measured without that tier, and the
admission evicts what other queries kept: an edit's `impact` read 2,987 derived facts from disk instead of 5, and a
revision's `trace` derived its call sites again. The warm gain is real (about 0.5 s on this backend) but costs a
regression elsewhere, which the owner's rule forbids.

| Option | Verdict |
|---|---|
| Keep `BaseReading` per generation | Rejected (R3): it closes over the request's signal, the parse hold that frees its trees after the query, and the opened store |
| A new memory tier for stage outputs, with its own budget | Rejected: the snapshot cache's slots already give the key, the charge, the freeze and the abort rule; a second budget would compete with it for the same working set |
| The plain outputs of B6 and the implemented contracts in the snapshot cache's slots | Chosen: about 0.6 MB per kept index, no eviction measured |
| B8's module statements as one slot per content, or through the per-file derived facts | Rejected as measured above; it waits for a floor sized with its charge |

## Decision

1. **What is kept.** The plain, frozen output of a stage, never the reading. A kept value holds no reader, store, parse
   hold, tree, signal or function: B6's reference proofs and the implemented contracts, their sets and maps as arrays
   in their order, revived into new sets and maps per read.
2. **Where.** In the snapshot cache, through `SnapshotRetention.output` (`PreparedCommit.retained`), so the value is
   charged to the cache's budget, evicted by it, and admitted frozen. A read without a snapshot cache assembles every
   stage as before.
3. **Keys.** The snapshot entry's trust, scope, export budget and written listing, plus everything the two stages read:
   the index's digest, whether the hierarchy was completed before the stages (`BaseReadings.open` or `of`), the
   narrowing's origin paths, and the validated identities of the declared JDKs the origins read (each used JDK's
   `ct.sym` digest, version and feature, and the reason each unused one was not read), never their declared paths alone.
   Only a kept index has a digest (ADR-0124); a live store's committed generation is not exposed to the reading, so on
   the live tree both stages are assembled per read (R1).
4. **Nothing cut is admitted.** A stage whose request signal was aborted, by the caller or by a deadline, is answered to
   that request and never admitted (`SnapshotRetention.output`); the next query assembles it.
5. **Invalidation.** A new content is a new snapshot entry (a new commit's blob ids), and a new index digest, another
   narrowing, another declared JDK or another trust misses. Nothing is patched in place.
6. **What waits.** B8's module statements wait for a snapshot cache floor sized with their measured charge (RFC-0040
   L9b, amending ADR-0127). A stage whose output is not plain without a reader stays per read: the completed hierarchy
   (a reader over the store with the supertypes the packs place), the reconciled calls, the reverse calls into targets
   and the edge targets themselves. The unresolved references stay per read: their stage is synchronous, so keeping
   them changes every consumer. None needs trees (RFC-0040 D6 is not triggered by this unit).
7. **ADR-0045 amended.** Decision 2: B6 is kept per index as above instead of "per read". Decision 3: a stage runs once
   per read, or once per key where this ADR keeps its output.

## Consequences

- Two queries at one kept index run B6 and the implemented contracts once; a second query reads the same plain values
  as the first, after the first released its hold.
- The gain is small and on the revision path only: 74 ms of 1.1 s on the Java backend's `callers`, 37 ms on the
  monolith's. The large stage, B8, is measured and waits with its figures.
- The kept values count against the snapshot cache's budget like every other slot, about 0.6 MB per kept index on the
  corpus; the working-set floor (ADR-0127) is unchanged.

## Not decided here

- Sizing the floor for B8's module statements (L9b), and which of the two measured grains to keep then.
- Exposing a live store's committed generation to the reading, so B6 and the implemented contracts are kept on the live
  tree (RFC-0040 L18 changes the lock around the same state).
- Plain outputs for the completed hierarchy and the unresolved references.
