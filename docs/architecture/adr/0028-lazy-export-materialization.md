# ADR-0028: A SHA request lists the export every time and writes its files only when a reader needs them

- Status: Accepted, 2026-11-06, owner
- Decision source: the owner, 2026-11-06: "luego haz la implementacion completa del plan que propones", approving the
  efficiency plan whose step 5 amends ADR-0020 decisions 4 and 5.
- Related: [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) (amended),
  [ADR-0010](0010-trust-modes.md), [ADR-0015](0015-index-reuse-by-content.md),
  [ADR-0026](0026-snapshot-data-may-retain-reader-outputs.md),
  [ADR-0027](0027-retention-of-immutable-index-entries.md), [RFC-0006](../rfc/0006-configuration.md),
  [RFC-0012](../rfc/0012-observability-and-measurement.md)

**In short:** the `export` stage, writing the commit's selected blobs into a temporary directory, was about 20% of all
call time in a measured seven-repository workspace, and 76% of a SHA outline, even when the snapshot data cache and a
kept index already held everything the answer reads. A request still lists the commit afresh and decides every `written`
flag, skipped entry and budget stop exactly as before. The files are written only when a reader of the directory
actually runs.

## Context

- Run 20261106T131733Z-nname-stage-telemetry-d25598 measured `export` as the largest single stage: 2.6 to 3.1 s of a
  workspace call over seven repositories, on every SHA request.
- ADR-0020 decision 4 required a fresh temporary export before every lookup, because the cache key and the index key
  derive from the export's listing (blob ids, written flags, skipped entries, budget stop). Only the listing is an input
  of those keys; the bytes written are not. With ADR-0026 (reader outputs retained) and ADR-0015/0027 (kept indexes) a
  request often reads no file at all.
- The listing already decides everything without the content: `git ls-tree` gives the entries, and a blob's size, which
  the byte budget needs, is read by `git cat-file --batch-check` without its content ([RFC-0006](../rfc/0006-configuration.md):
  "the size of a blob is known before a byte of it is written").

## Decision

1. ADR-0020 decision 4 is amended: a SHA request still resolves its revision, reads current trust and performs a fresh
   listing of the commit. It no longer writes the commit's files before looking up retained data. The cache key is
   derived from the same listing as before.
2. The listing decides, from the object store alone, exactly what the single-pass export decided: the entries, what is
   skipped and why, the `written` flag of each selected file, the entries budget stop, and the bytes budget stop. The
   bytes budget is decided from blob sizes in git's order, so it is the same decision whether or not any file is later
   written; it never needs writing to be decided.
3. A listing fault is a fault of the request: a selected blob absent from the local object store is `object-missing`,
   as it was, and wins over any retained data and any kept index (ADR-0020 decision 5 is kept for listing faults).
4. The files are written (materialized) at most once per operation and only before a reader of the directory runs:
   the source read on a data-cache miss; the index build on a kept-index miss, or when no index cache is configured;
   and a focused Java outline's read of its focused files. A snapshot served from retained sources, findings and a kept
   index writes nothing.
5. A materialization fault (`object-missing` for a blob that has left the object store since the listing, or
   `export-write-failed`) is raised by the reader that needed the files, with its typed kind, in the place the export
   fault was raised: it is the answer of the request, never an `index-unavailable` unknown and never retained data. A
   fault is remembered for the operation, because the directory then holds an unspecified part of the files. A request
   that needs no file cannot meet a fault of reading or writing blob content (`export-write-failed`, a `git-failed` on
   a blob whose header lists but whose body cannot be read); this is the one difference from a single-pass export, and
   it concerns only the faults of content the answer did not need. Since the listing finds a missing object before
   anything is written, a missing blob is reported as `object-missing` even where a single-pass export would first have
   met a write fault on an earlier file.
6. The Vcs port offers the two halves, `listCommit` and `materializeCommit`, beside `exportCommit`, which is the two in
   sequence and stays for the consumers that always need the files (the live base tree, the changed-file diff). A Vcs
   that offers neither writes in `exportCommit` alone, and a request then behaves as before. The index cache request
   carries an optional `prepare`, called once and only when an index has to be built.
7. Everything else of ADR-0020 holds: no export is retained between requests, the temporary directory of an operation
   is removed by the operation's cleanup, the export never holds a whole file (a blob is written chunk by chunk), an
   untrusted snapshot is read only through the confined reader, and a hit and a miss answer the same bytes.
8. Measurement keeps the `export` stage for the listing and adds a `materialize` stage for the writing
   ([RFC-0012](../rfc/0012-observability-and-measurement.md)). The absence of `materialize` in a measured request is
   the sign that nothing was written. A request that wrote the files shows `export`, then `materialize`.

## Consequences

- A repeated SHA request over retained data and a kept index costs a listing (two git processes that read no file
  content) instead of a listing plus writing every selected blob. The saving is the `materialize` time that no longer
  occurs; a miss pays the same writing, plus one `cat-file --batch-check` pass over the selected blobs.
- Answers, cuts, keys and budgets are unchanged; the key of every cache and index entry derives from the same listing.
- A blob can leave the object store between the listing and the writing (a repository gc'd or rewritten during a
  request); that is an `object-missing` at materialization, as unlikely as it was between two git processes before.
- Any new reader of the exported directory must call `materialize` first. A reader that does not would see an empty
  directory; the consumers are listed in this change and each is covered by a test.

## Not decided here

- Retaining exports on disk, or sharing a materialized directory between operations or processes.
- Skipping the listing itself when nothing changed: the listing is the fresh read of the commit and stays.
