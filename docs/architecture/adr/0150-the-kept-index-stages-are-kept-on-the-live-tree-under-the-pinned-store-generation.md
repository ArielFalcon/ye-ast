# ADR-0150: B6 and the implemented contracts are kept on the live tree under the pinned store generation

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 D1 and D2 and §3.2 row
  "Stage outputs of the assembled reading" (key: "content identity or store generation (whichever it reads), scope,
  trust, configuration, validated build-output identities, narrowing"), with review finding R1 ("`stateId` does not
  identify a live store: a synthesized rebuild keeps it"). The targets it serves (translated): "Times must sit between
  a few hundred milliseconds and, for the most critical jobs, 3-5 s in specific cases; the p75 should be below 1 s",
  "without sacrificing functionality and quality", and "caches with robust stale policies".
- Amends: [ADR-0143](0143-the-plain-outputs-of-the-snapshot-reading-stages-are-kept-across-queries.md) decision 3 (the
  live tree assembled both stages per read)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.1, §3.2, L16;
  [ADR-0125](0125-a-live-store-is-read-into-a-graph-image-named-by-its-committed-store-generation.md),
  [ADR-0144](0144-the-mirror-lock-covers-the-refresh-and-the-pin-and-a-live-query-derives-from-the-pinned-capture.md),
  [ADR-0147](0147-the-snapshot-cache-floor-is-what-each-repositorys-recent-contents-used-charged-as-decoded-heap.md)

**In short:** a live capture now carries the store generation its store was pinned at, and the reading keys B6's
reference proofs and the implemented contracts by it on the live tree, as it keys them by the index's digest at a
revision. Two live queries at one pinned generation run each stage once; a rebuild that keeps the `stateId` commits a
new generation and misses. No fact changes.

## Context

ADR-0143 kept the plain outputs of B6 and the implemented contracts in the snapshot cache's output slots, keyed by the
kept index's digest. A live store has no such digest, and its `stateId` does not identify it: a synthesized request
rebuilds the store in full at an unchanged `stateId`, and a synced store and a full build of one content differ in
their graph (ADR-0015). So on the live tree both stages were assembled on every query (ADR-0143, "Not decided here").

Since ADR-0144 a live query reads only the capture it pinned under the mirror lock: the store opened at the committed
store generation as an image (ADR-0125), the export and the sources. The generation is a token that no other commit of
any mirror, in this process or another, has used (`LiveDeps.newStoreGeneration`), written on every committed build or
sync. It names the store the capture reads exactly, but it stopped at the live tree: `HeadReading.open` answered the
store without it, so the reading had nothing to key the stages by.

| Option | Verdict |
|---|---|
| Key by `stateId` | Rejected (R1): a synthesized rebuild keeps it, so a kept output would answer for another graph |
| Expose the pinned generation through the reading's index digest | Rejected: the digest also keys derived facts that reach the disk (the contradicted calls), and RFC-0040 §3.1 keeps the token out of every disk key |
| Expose the pinned generation beside the digest, read only by the kept stages | Chosen: the same slot and key as ADR-0143 with the generation in place of the digest |

## Decision

1. **The pinned generation.** A live capture that pinned a store carries the generation the store was opened at
   (`LiveTree.generation`), taken from the same committed state as the reader, never read again after the lock is
   released. A capture without a store carries none.
2. **Through the reading.** The live head's index answers the pinned store with that generation
   (`HeadIndex.generation`), and every family hands it to the reading (`ReadingSource.generation`) beside the digest.
3. **Keys.** On the live tree, B6's reference proofs and the implemented contracts are kept in the snapshot cache's
   output slots under the snapshot entry (trust, scope and the capture's listing of blob ids), plus the generation,
   whether the hierarchy was completed first, the narrowing's origin paths and the validated identities of the declared
   JDKs the origins read: ADR-0143 decision 3 with the generation in place of the index's digest. A reading with
   neither assembles both stages per read.
4. **Memory only.** The generation keys only these memory slots. The derived facts that read the index (the
   contradicted calls) and the calls through origins stay keyed by the index's digest alone, so on the live tree they
   are assembled per read as before.
5. **Unchanged.** What is kept (plain frozen values, never `BaseReading`, a reader, a parse hold or a signal), the
   abort rule (nothing whose request was aborted is admitted) and the charge: every slot goes through the snapshot
   cache, whose floor is the measured working set of ADR-0147; no new constant.
6. **ADR-0143 amended.** Decision 3: "a live store's committed generation is not exposed to the reading, so on the live
   tree both stages are assembled per read" is replaced by decision 3 above.

## Consequences

- Live queries at one pinned generation, in one process, ask the import origins for B6 and the implemented contracts
  once; a second query with other targets reads the plain values the first kept, after the first released its hold.
- An edit is a new listing and a new generation, so the query right after it assembles both stages as before; the
  gain is on the unchanged cells.
- A rebuild at an unchanged `stateId` (synthesized edges, a store that no longer opens) commits a new generation and
  misses.
- The live working set of a repository grows by the two slots per generation, measured by ADR-0147's floor like every
  other slot.
- Measured with the latency bench (`unchanged` and `edit-now`, 5 calls per cell, two interleaved rounds, Apple M1 Max),
  with a stage line on the implemented-declarations question added to both engines for the run:

  | Cell | Import origins (B6) | Implemented declarations | Wall p50 |
  |---|---|---|---|
  | Java backend (1,210 files), live `callers`, unchanged | 3 ms, 5 of 5 calls -> not asked | 8 ms -> 0 ms | 913-931 -> 839-848 ms |
  | Angular and Java monolith, live `callers`, unchanged | 21-22 ms -> 0 ms | under 1 ms | 210-219 -> 176-179 ms |
  | either repository, live `callers` and `impact`, edit-now | unchanged | unchanged | unchanged within noise |

  Cache evictions over the session moved by 4 of about 2,450; RSS stayed within the run-to-run spread.

## Not decided here

- Keeping the calls through origins on the live tree (a memory slot, which could take the generation the same way; not
  measured by this unit) and the contradicted calls (derived facts that reach the disk by the index's digest, which the
  token must not; RFC-0040 §3.1, open question 2).
- Plain outputs for the completed hierarchy and the unresolved references (ADR-0143, "Not decided here").
