# ADR-0031: SHA snapshot data is keyed by the written files, not by the commit

- Status: Accepted, 2026-11-06, owner
- Decision source: the owner, 2026-11-06: "En las decisiones pendientes ve como recomiendes", approving this
  amendment of ADR-0020 decision 4 (and ADR-0026 decision 3, ADR-0030 decision 6, which restate its key).
- Related: [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) (amended),
  [ADR-0015](0015-index-reuse-by-content.md), [ADR-0026](0026-snapshot-data-may-retain-reader-outputs.md),
  [ADR-0028](0028-lazy-export-materialization.md), [ADR-0030](0030-live-captures-use-the-snapshot-data-cache.md),
  [RFC-0006](../rfc/0006-configuration.md), [RFC-0010](../rfc/0010-impact-queries.md),
  [RFC-0012](../rfc/0012-observability-and-measurement.md)

**In short:** the key of a SHA entry named the repository, the resolved SHA and the whole current listing (every file
with its blob, in scope or not, plus skipped entries and the budget stop). Two commits with identical sources, a commit
that only touches a file outside the scope, or the commit an agent makes after its work, could never share an entry,
while the persistent index already shares by content (ADR-0015). The key is now the declared scope, the trust, the
export budget and the path and blob of every file the listing marks `written`, in listing order.

## Context

What each stored value is a function of, at `file:line` of the tree this ADR lands on:

- **Sources.** `readSources` reads the files `export.files` marks `written` from the root, in listing order
  (`read-snapshot.ts:readSources`); `createFsSourceReader` returns `{ path, content }` (`fs-source-reader.adapter.ts:11`).
  A source is its path and the bytes of its blob. The root and the repository name never enter it.
- **Findings.** `extractSources` calls `extractor.extract(sources)` with no libraries (`read-snapshot.ts:extractSources`).
  The composed extractor (`compose.ts:154`) is the Spring and Angular extractors over those sources; the OpenAPI
  contract reader it uses is stateless (`contract-document.adapter.ts:20`). No extractor reads the disk: the only
  `readFile` under `core/adapters` besides the source reader are the TypeScript library declarations of the installed
  compiler. A `Finding` carries repo-relative evidence only (`fact.ts:95`); it embeds no SHA and no repository. A
  configuration file an extractor consults (tsconfig, package.json, angular.json, Spring application files) reaches it
  as one of those sources, so it is in the written set whenever it is consulted.
- **Relations and module-dependency outputs.** `deps.relations.extract(tree.sources, { memberProofs })` and
  `reader.extract(tree.sources)` (`impact-queries.ts:99-106`). Module dependencies read the sources alone. Relations
  also read `memberProofs`, which `memberProofContextOf` derives from the whole listing: the scope, whether the export
  stopped, whether anything was skipped, and whether a TypeScript file is listed but not written
  (`reference-origins.ts:66-69`). That input is already part of the output's slot (`outputKey` adds the slot to the
  entry), so the output remains separate for each value of it even when two listings share their sources entry.
- **The live merge base** (ADR-0030 decision 6) is `prepareCommit`, so it is the same entry.
- Everything else of the listing (unwritten files and their blobs, skipped entries, the budget stop, the SHA) reaches a
  query through `PreparedCommit.tree.export`, which is built from the current listing on every request
  (`prepared-snapshot.ts:prepareCommit`), never from the retained data. Cuts and the snapshot of the fact come from it.
- Producer and adapter versions are not keys: the cache lives in the memory of one process, in one composition
  (ADR-0020 decision 4, ADR-0026 decision 3).
- Fault paths: a listing or materialization fault is returned before or instead of the lookup; findings cut by a
  deadline are not retained; a cancelled stage publishes nothing. None of that changes.

## Decision

1. ADR-0020 decision 4 is amended for a SHA entry. Its key is the digest of `{ scope, trust, budget }` plus the ordered
   `{ path, blob }` of the files the current listing marks `written`. The resolved SHA, the repository, the unwritten
   files, the skipped entries and the budget stop are not in the key. Output slots keep their own inputs (ADR-0026
   decision 3), including the `memberProofs` context of the whole listing.
2. The repository is dropped from the key. No stored value depends on it (Context), and two checkouts or worktrees of
   one repository, or two repositories with equal sources, read equal data. The per-operation preparation map
   (`withSnapshotPreparation`) keeps its own key with the repository and the SHA, since it holds a root and a listing,
   not data.
3. The scope, trust and export budget stay. They decide which files are listed and written, and trust is a declaration
   about content (ADR-0010); a host that sets them differently must not share.
4. A hit answers the same bytes as a miss: equal keys mean the same written paths with the same blobs, hence the same
   sources, findings and outputs, and every other part of the answer is built from the current listing.
5. A live entry keeps its key (ADR-0030 decision 2): its blobs are hashed by the mirror and its `live` marker keeps it
   apart. Sharing between a live capture and a SHA stays not decided.
6. Measurement is unchanged: the `cache` lines of RFC-0012 report the hits and misses the new key produces.

## Consequences

- A commit that changes only files outside the written set (documentation, assets, another scope) or that repeats the
  tree of an earlier one hits the earlier entry: no source read, no extraction, no relations or module-dependency read,
  and no materialization of the files.
- A changed blob of a written file, a file that becomes written or stops being written, a different scope, trust or
  budget miss.
- Entries are shared across repositories; the byte budget and LRU eviction are unchanged.

## Not decided here

- Sharing between a live capture and a SHA (ADR-0030).
