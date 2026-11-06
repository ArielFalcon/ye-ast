# ADR-0029: A live capture uses the snapshot data cache, keyed by the content of its listing

- Status: Accepted, 2026-11-06, owner
- Decision source: the owner, 2026-11-06: "Usa otro para implementar la propuesta que comentas de live con el hash",
  approving that a live capture reuse the snapshot data cache keyed by its content hashes, which amends ADR-0020
  decision 6.
- Related: [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) (amended),
  [ADR-0026](0026-snapshot-data-may-retain-reader-outputs.md), [ADR-0028](0028-lazy-export-materialization.md),
  [RFC-0010](../rfc/0010-impact-queries.md) "The mirror", [RFC-0006](../rfc/0006-configuration.md),
  [RFC-0012](../rfc/0012-observability-and-measurement.md)

**In short:** since ADR-0020, ADR-0026 and ADR-0028 a SHA query reuses the sources, findings, relations and
whole-universe module dependencies of a snapshot whose listing did not change. A live query re-read and re-derived all of
it on every call, though its capture is identified by content exactly as a SHA's listing is: measured on a real
webapp, `impact --live` spent about 740 ms in relations and 860 ms in module dependencies, and `callers --live` 380 to
700 ms in relations, on every call with an unchanged tree. A live capture now uses the same cache under the same
rules; it changes only the key.

## Context

- The key of a SHA entry is the effective source, SHA, scope, trust and export budget plus the whole current listing
  (blob ids, `written` flags, skipped entries, budget stop) (ADR-0020 decision 4). The SHA only names the listing; the
  listing decides the sources.
- A live capture has the same listing. `LiveTree.export` is built from the mirror manifest by `liveExport`
  (`live-export.ts:15`): `{ path, blob, written }` per mirrored file plus the skipped entries. Every `blob` is a git blob
  id computed in process over the bytes the mirror holds:
  - `capture` copies a file into the mirror and hashes the copy (`live-mirror.adapter.ts:216`); a file the mirror
    does not copy is hashed at the source (`:218`). `hashFile` is `sha1("blob <size>\0" + bytes)`, `:611-624`.
  - The stat is read again after hashing and the entry is kept only if size, nanosecond mtime and inode did not move;
    otherwise it is copied and hashed once more, then refused as `unreadable` (`:220-222`, `sameFile` `:627`).
  - A recorded entry survives only while size and nanosecond mtime still match (`:327`); a file whose stat changed is
    hashed again (`:328`, `:344`), and the new blob replaces the old one in the manifest. A file whose stat changed but
    whose content did not gets the same blob and so the same key. A path the previous state marked pending is forced
    through `capture` regardless of its stat (`:327`, `forced`).
  - An untracked file that git does not ignore is listed by `ls-files --others --exclude-standard`
    (`git-working-tree.adapter.ts:25`) and captured like a tracked one. A deleted tracked file is dropped from the
    manifest (`:333-337`).
  - A symbolic link, a link in a parent directory, a submodule, an unsafe path or a special file is not captured: it is
    a skipped entry with its reason (`:308-309`, `:317`, `:324-325`), which belongs to the listing and so to the key.
  - `LiveTree.stateId` is the digest of `contentFingerprint(exported, isWritten)` over this same listing
    (`live-tree.ts:188`), the identity the fact already records.
- The sources a live query reads are the files `export.files` marks `written`, read from the mirror root
  (`readSources`, `read-snapshot.ts:172`); findings, relations and module dependencies are pure functions of those
  sources. Nothing in them depends on HEAD, the merge base or the live snapshot fields, which are added to the fact
  after the read.
- The one assumption is the mirror's own, documented in RFC-0010 "The mirror": an edit that keeps a file's size and
  nanosecond mtime is not seen, by ye-ast or by the engine. The cache adds no new one: a capture is by construction
  what the mirror holds, and the key is the hashes the mirror recorded.

## Decision

1. ADR-0020 decision 6 is amended. A live query still takes the mirror's lock, lists the working tree and reconciles on
   every call, writes its state, re-lists after the answer and reports `stale`, and keeps the retention sweep
   (RFC-0010). Only after the capture is reconciled, and only to read sources, findings, relations and module
   dependencies, does it consult the snapshot data cache.
2. The key of a live entry is the digest of `{ live: true, repo, scope, trust }` plus the capture's whole listing
   (`files` with blob and `written`, `skipped`). The identity names no HEAD, no `stateId` and no mirror path: HEAD does
   not change what the sources are. The `live` marker makes a live entry and a SHA entry different keys even over equal
   listings, so they never share an entry. A different scope, repository, trust or listing is a different key.
3. Everything ADR-0020 decisions 2, 3 and 5 and ADR-0026 say of retained data holds for a live entry: serialized
   UTF-8 sources and completed findings plus the serialized relations and module-dependency outputs, charged against the
   same byte budget and evicted least recently used; data is published only after the stage completed without
   cancellation; findings cut by a deadline are not retained; returned data is deserialized afresh. A fault of the mirror
   refresh wins over any retained data, since the cache is consulted only after a successful reconcile.
4. A hit answers the same bytes as a miss for the same capture. Facts are still built per call from the current capture:
   the live snapshot (`head`, `stateId`), the index origin, the cuts and the staleness notice are never cached.
5. A held live capture (`withLiveCapture` with a pinned request) is unchanged: its consumers still share the one capture
   and its memoized reads; it may fill the cache on a miss and be served from it on a hit.
6. The merge base side of a live change query is a commit and is still read as before; only the head side of a live
   query is retained by this decision.
7. Measurement is unchanged: the existing `cache` lines of RFC-0012 report the hits and misses of live queries too.

## Consequences

- A repeated live query over an unchanged tree skips the source read, the entrypoint extraction, the relations and the
  module-dependency read; it still pays the lock, the two listings, the reconcile and the opening of the store. An edit
  changes at least one blob and so misses.
- The residual assumption (same size and nanosecond mtime) now also means that such an edit would be answered from the
  retained data of the earlier content, as it was already answered from the mirror's stale copy.
- A pinned or a changed tree during a query is as before: the answer reflects the capture, and `stale` reports the
  paths that moved.
- Live entries add to the same budget; a host that sets zero disables them with the rest.

## Not decided here

- Retaining the read of the merge base of a live change query.
- Sharing entries between a live capture and a SHA whose listing is equal. The fact schema differs (`ignored: "git"`),
  and nothing measured asks for it.
