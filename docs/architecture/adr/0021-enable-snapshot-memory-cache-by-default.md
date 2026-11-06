# ADR-0021: Enable snapshot data retention by default with a 32 MiB budget

- Status: Accepted, 2026-11-04, owner
- Decision source: the owner, 2026-11-04: "si compensa tenerla se activa por defecto", explaining that MCP users rarely
  adjust configuration. The measured reuse below meets that condition.
- Supersedes: the disabled default in [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) decision 1 only
- Amended by: [ADR-0030](0030-live-captures-use-the-snapshot-data-cache.md) (decisions 1 and 3: a reconciled live
  capture uses this cache and its budget)
- Related: [RFC-0006](../rfc/0006-configuration.md)

## Context

The configured cache preserved the complete responses of twenty real MCP calls, with immutable SHAs, seven
repositories and eight snapshots including the comparison base. A repeated workspace impact exported the same eight
snapshots while avoiding all eight source reads and all eight entrypoint extractions. The retained serialized entries
peaked at 5,759,218 bytes in a replay of that workload. These observations establish reuse and one working-set size;
they are not a general latency or memory guarantee.

A disabled default leaves everyday MCP sessions without that reuse unless their launcher supplies a composition
setting. The owner chose useful defaults over requiring that configuration.

## Decision

1. Composition enables the shared snapshot data cache with a default budget of 32 MiB. That is the already measured
   budget, with room above the observed working set. It is an initial bounded default, not an optimal size claimed for
   every repository. No bytes are reserved in advance: entries are admitted as queries produce them.
2. The host may override `snapshotCacheBytes`; an explicit zero disables retention. The override uses nullish fallback
   so zero is preserved. The same composition default reaches the CLI, stdio MCP and library hosts.
3. All other ADR-0020 rules remain: least-recently-used eviction, a cap on UTF-8 entry bytes rather than whole-process
   heap, serialized data only, fresh temporary Git exports, current trust and revision checks, no final facts or
   shared cancellation. "No live retention through this cache" is superseded by ADR-0030.

## Consequences

- Ordinary long-lived MCP sessions reuse completed SHA source reads and extraction without launcher configuration.
- The process may retain up to 32 MiB of serialized entry data plus runtime bookkeeping and transient decoding data.
  Serialization adds work to a cold query; a short-lived single-call CLI may see no reuse benefit.
- Large workspaces may evict entries and recompute them. Eviction changes cost, never the answer.
- The cache does not remove Git export, graph traversal or query-specific analysis. When this ADR was written `live`
  was unchanged; ADR-0030 later let a reconciled live capture use the cache.

## Not decided here

- Automatic budget sizing, disk export retention, or reuse across processes.
