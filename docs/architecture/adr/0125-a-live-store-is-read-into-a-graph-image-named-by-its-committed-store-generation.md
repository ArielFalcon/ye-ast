# ADR-0125: A live store is read into a graph image named by its committed store generation

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 D1: "The codegraph adapter
  reads a store's graph in bulk into an immutable in-memory image; raw SQL stays in the adapter, version-checked", and
  RFC-0040 §3.1: "for live, a token the refresh writes to the mirror state on **every** committed build or sync". The
  targets it serves (translated): "Times must sit between a few hundred milliseconds and, for the most critical jobs,
  3-5 s in specific cases; the p75 should be below 1 s [...] without sacrificing functionality and quality."
- Amends: [ADR-0124](0124-a-kept-index-is-read-once-into-an-immutable-graph-image.md) decision 4, "Only stores nothing
  writes"
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.1, §3.3, §5;
  [RFC-0010](../rfc/0010-impact-queries.md) "Live head"; [ADR-0015](0015-index-reuse-by-content.md)

**In short:** a live mirror's store is synced in place, so ADR-0124 left it on the SQL reader. Every committed build or
sync of a mirror now writes a new store generation, a random token, to the mirror state, and clears it while a build or
sync is under way. A live query whose committed state has a generation and no pending path opens the store as an image
kept by the database file and that generation, under the mirror lock. The long-lived sync worker decides whether to
reopen its store by the same token. The token never reaches a key on disk.

## Context

`stateId` is a digest of the mirror's source content (`live-tree.ts`). It does not name the store: a query that reads
synthesized edges rebuilds the store in full at the same `stateId`, and a synced store and a full build of the same
content hold different graphs (ADR-0015). The database file does not name it either: a sync writes it in place, keeping
its inode and possibly its size, and its write-ahead log changes on checkpoints that change no content. ADR-0124's key,
the file's identity and times, is sound only for stores nothing writes.

## Decision

1. **The token.** `MirrorState.storeGeneration` is a fresh random UUID written with every committed build or sync,
   including a full rebuild at an unchanged `stateId`. The state a refresh writes before it starts writing the store
   carries an empty generation; a refresh that only copies files keeps the generation, since it leaves the store alone.
   A state written before this decision reads as an empty generation, which opens the store as before.
2. **The image.** `CodeGraph.open(store, generation)` with a non-empty generation answers from an image kept by the
   database file's path, device and inode plus the generation. Each database file keeps one image: an image obtained at
   another generation drops the one before and its charge. The live images share no budget with the kept indexes:
   128 MiB by default, four times the estimated charge of the largest corpus store (ADR-0124). Everything else of
   ADR-0124's image holds: same answers, frozen values, raw SQL in the adapter after the version check.
3. **When the image is used.** Only under the mirror lock and only for a committed state whose `pending` is empty: the
   reader that proves the store before a query, and the store a refresh just committed, which is opened when the query
   takes it. A refresh never opens the store at a generation it has not committed, so a query never reads an image of a
   store a build or sync is changing or has changed.
4. **The worker.** A sync names the generation committed before it and the one it commits. The mirror's long-lived
   worker reopens its store unless the named generation is the one its own last sync committed: a foreign writer, a
   rebuild, an unfinished write and a sync that names none all reopen. This replaces the comparison of the database
   files' identity and times that L7 introduced.
5. **No disk key.** The token is written only to the mirror state. No index-cache entry, derived fact or answer file
   is keyed or named by it; the disk keys stay content plus reader version (ADR-0077).
6. **Trust.** Live queries run only under `trusted`, and the token names the bytes of one store that ye-ast built from
   its own mirror, so the key holds no trust mode, as ADR-0124 decision 6 argues.

## Consequences

- A repeated live query over an unchanged store opens no store and issues no SQL statement; a query after an edit pays
  the sync and one bulk read of the store.
- The bulk read runs on the query's event loop, as for kept indexes.
- A store removed behind a committed state is still detected: its database file is missing, so the image is read
  again, the read fails and the refresh rebuilds the store.

## Not decided here

- Memory tiers keyed by the store generation (RFC-0040 L5b, L16).
