# ADR-0020: Snapshot data may be retained in memory under an explicit host budget

- Status: Accepted, 2026-11-04, owner
- Decision source: the owner, 2026-11-04: "Sí, caché en memoria con presupuesto del host", approving an optional
  in-memory cache with eviction when its budget is exceeded, while Git exports remain temporary.
- Amended by: [ADR-0026](0026-snapshot-data-may-retain-reader-outputs.md) (decision 2 also admits the serialized
  output of the relations and whole-universe module-dependencies readers)
- Amended by: [ADR-0028](0028-lazy-export-materialization.md) (decisions 4 and 5: the listing is fresh on every
  request, the files are written only when a reader needs them)
- Amended by: [ADR-0030](0030-live-captures-use-the-snapshot-data-cache.md) (decision 6: a reconciled live capture
  uses this cache, keyed by the content hashes of its listing)
- Related: [ADR-0006](0006-qayaba-graph-state-per-run.md), [ADR-0010](0010-trust-modes.md),
  [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md), [RFC-0006](../rfc/0006-configuration.md)

## Context

Repeated queries for the same immutable snapshot reload sources and extract entrypoints even with a ready graph
index. Operation-scoped preparation already shares that work inside workspace impact. Retaining source directories
would extend their lifetime and require a disk integrity, concurrency and cleanup policy. Retaining source objects
would also keep the syntax trees weakly associated with them.

## Decision

1. The disabled default in this decision is superseded by [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md).
   Original decision: composition may enable a snapshot data cache with `snapshotCacheBytes`, an explicit host value. Without it no data
   is retained between requests. Zero, negative, fractional, non-finite and unsafe-integer values disable retention.
2. The cache lives with one composition and its fixed adapters. It retains UTF-8 serialized sources and completed
   entrypoint findings only (ADR-0026 adds the outputs of two readers). The budget charges the UTF-8 bytes of each key and serialized payload, including paths
   and metadata. It bounds retained entry bytes, not Node's total heap, map bookkeeping or transient serialization.
   No source objects, compiler trees, stores, promises, callbacks, temporary paths or final facts are retained.
3. Reads promote entries; admission evicts least-recently-used entries until the byte budget fits. An oversized entry
   is not admitted; an oversized replacement removes its previous entry without evicting unrelated ones.
4. Every request still resolves its revision and reads current trust. SHA preparation performs a fresh temporary Git
   export before looking up data. Its key includes the effective source, resolved SHA, normalized scope, trust and
   export budget, plus the full current export listing, written flags, skipped entries and budget stop. Each use case
   builds its own fact and identity from current inputs. Adapter versions are fixed for the cache's composition.
5. Source and extraction stages publish only after completing without cancellation. A completed source stage may be
   reused after a later extraction was cancelled; the cancelled extraction is repeated. Findings cut by a deadline
   are not retained. Concurrent requests share no in-flight work or cancellation signal. An export fault always wins
   over any retained data. Returned data is deserialized afresh so consumers cannot mutate a stored entry.
6. `live` keeps its existing mirror and lock lifecycle; ADR-0030 lets a reconciled live capture use this cache. Export-only consumers do not restore
   retained sources. Git exports remain temporary and are removed by their operation's existing cleanup.

## Consequences

- Repeated SHA queries can avoid source reads and entrypoint extraction, including requests that change presentation.
  They still export Git blobs and rerun the query-specific analysis; this is not a final-answer cache.
- Serialization and deserialization cost time and allocate transient data; the host chooses a budget from measurements.
  Cache eviction changes cost only, never the deterministic answer or completeness.
- ADR-0021 subsequently enables a bounded default. No CLI flag or MCP tool parameter is added; hosts can override
  retention through composition.
  A per-run host can discard its composition at run end, preserving ADR-0006's lifecycle.

## Not decided here

- Retaining exports on disk, sharing cached data across compositions or processes, or automatic budget sizing (the fixed default is decided by ADR-0021).
- Reusing compiler-owned trees between requests.
