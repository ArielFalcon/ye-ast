# ADR-0123: A commit listing is kept by its sha, and the index cache sweeps when it builds or once per interval

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-17: "Los tiempos se deben mover entre los pocos cientos de milisegundos y los trabajos
  más críticos 3-5s en casos puntuales, el p75 debería estar por debajo de 1s", and "Apruebo las decisiones" over
  RFC-0040, whose open question 1 recommends keeping the listing of a commit by its resolved sha.
- Amends: [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) decision 4 and
  [ADR-0028](0028-lazy-export-materialization.md) decision 1 (the listing is no longer read afresh from git on every
  request), and [ADR-0027](0027-retention-of-immutable-index-entries.md) decision 4 (the sweep no longer runs on every
  obtain)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §2 M6, [ADR-0015](0015-index-reuse-by-content.md),
  [ADR-0121](0121-the-snapshot-cache-floor-counts-a-query-as-one-read-however-many-snapshots-it-spans.md)

**In short:** a revision query that every cache already served still paid 75-145 ms for `export` (three git processes
that list a tree that cannot change) and a measurement of every kept index. The listing of a full sha is now kept in
memory by repository, sha and entry budget, and the index cache measures its entries when this process built one, on its
first obtain, and then once per interval. Answers, keys and faults are unchanged; the revision is still resolved on every
request.

## Context

Measured with `impact.callers` at `HEAD` on jhipster-monolith (618 files), in one process, warm, main 62a41b28a:

| Stage of a revision call | Time |
|---|---|
| `export` (the listing: `rev-parse`, `ls-tree`, `cat-file --batch-check`) | 75-145 ms, every call |
| `store-open` | 8-14 ms |

- A tree is immutable by its commit sha, and so is the size of a blob by its id. ADR-0020 decision 4 and ADR-0028
  decision 1 required a fresh listing because the cache keys derive from it, not because the tree could differ.
- The listing was already independent of the plan except in two places: which accepted files the plan selects, and where
  the byte budget stops. Both are decided in memory from the listing and the blob sizes.
- The index cache sweep (ADR-0027 decision 4) reads the size of every file of every kept index and the lease files, on
  every obtain, whether or not anything changed that retention could act on.

## Decision

1. ADR-0020 decision 4 and ADR-0028 decision 1 are amended. A request still resolves its revision on every call (a
   symbolic revision is never kept) and still reads current trust. The listing of a full commit sha, once read whole from
   git, is kept in the Git adapter and answers later requests without a git process.
2. What is kept, per commit:
   - **Key:** repository path as given, full sha, and the entry budget (`maxEntries`) the listing was read under. Trust is no
     part of the key: the listing reads the object store alone and no host setting changes it.
   - **Value:** the accepted files (path and blob) and the skipped entries in git's order, where the entry budget stopped
     the listing, and the byte length of every blob a plan has selected so far. The plan is applied to it in memory:
     which files it selects, the `written` flags, the byte budget stop. A blob whose size is not yet known is read in
     order through `cat-file --batch-check` exactly as before, from the first unknown one on.
   - **Charge:** the UTF-8 bytes of the paths plus 40 per blob id plus 96 per record, counted for the whole entry. The
     bound is `listingBytes`, 8 MiB by default, and zero keeps nothing. The corpus listings charge 22 to 255 KB each and
     0.6 MB together, so the default holds more than ten times the corpus. Entries leave least recently used first; an
     entry that does not fit is not kept and evicts none.
   - **Invalidation:** none is needed for correctness, since the sha names the tree. Entries leave by the bound or with
     the adapter, which lives as long as the composition.
3. Admission: a listing is kept only after git answered it whole and no abort or fault cut it. An entry-budget stop is
   part of the key and is kept; a byte-budget stop is decided from the sizes and is kept with them. What is kept is a
   frozen copy, and every answer is built from new records, so changing an answer changes no later one.
4. A kept listing skips one check that a fresh listing makes: that the sha still names a commit and the blob ids are
   still in the object store. The caller has resolved the revision in the same request. A blob that has left the object
   store since the listing is raised where ADR-0028 decision 5 already raises it, by the reader that materializes the
   files, as `object-missing`. A listing that found a selected blob missing is never kept, so a repository that later
   holds the object lists again.
5. ADR-0027 decision 4 is amended. The index cache sweep runs after an obtain that built an index, on the first obtain of
   the process, and then at most once per interval of the injected clock, the shorter of the debris bound and the
   policy's `unusedForMs`. The sweep itself is unchanged. An index another process built is seen at most one interval
   later, and the byte cap was already best effort for an entry a reader holds.
6. Everything else of ADR-0020, ADR-0027 and ADR-0028 holds: no export is retained, the temporary directory of an
   operation is removed by its cleanup, a hit and a miss answer the same bytes, and retention never discards an index an
   open reader holds.

## Consequences

- A repeated revision query over retained data and a kept index no longer spawns a listing: `export` 75-145 ms to 0-7 ms
  on jhipster-monolith, measured in one process. The first query of a commit pays the listing as before.
- Retention can leave an expired or over-cap index on disk for up to one interval after a process that did not build it
  runs; the next build or the next interval removes it.
- A request answered from a kept listing cannot see a repository whose history was rewritten and garbage-collected under
  the same path between two requests while the sha stayed resolvable. Such a commit would fail to resolve first.
- Revision queries over untrusted repositories gain the same floor: the listing reads nothing from the working tree.

## Not decided here

- Keeping the resolved sha of a symbolic revision: the revision stays resolved on every request.
- A host option for `listingBytes` through composition; the adapter takes it and the default is measured above.
- The live floor (RFC-0040 M6, live tree sweep and HEAD resolution) and any resident generation.
