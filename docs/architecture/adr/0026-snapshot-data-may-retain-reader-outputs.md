# ADR-0026: The snapshot data cache may also retain the serialized output of the relations and module-dependencies readers

- Status: Accepted, 2026-11-06, owner
- Decision source: the owner, 2026-11-06: "luego haz la implementacion completa del plan que propones", approving the
  efficiency plan whose step 4 amends ADR-0020 decision 2.
- Amended by: [ADR-0030](0030-live-captures-use-the-snapshot-data-cache.md) (decisions 1 to 3: a reconciled live
  capture offers retention to its consumers)
- Amended by: [ADR-0031](0031-snapshot-data-is-keyed-by-the-written-files.md) (decision 3: the sources entry is keyed
  by the written files, not by the sha and the repository)
- Amended by: [ADR-0035](0035-derived-facts-are-retained-by-content.md) (decision 1 also admits plain facts derived
  from one file or from named inputs, keyed by content)
- Related: [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) (amended),
  [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md), [RFC-0010](../rfc/0010-impact-queries.md),
  [RFC-0012](../rfc/0012-observability-and-measurement.md)

**In short:** at one snapshot, `callers`, `impact` and `importers` re-run the Angular relations reader and the
whole-universe module-dependencies reader and obtain identical outputs each time. The cache may retain those two
outputs, serialized, under a key that names every input they depend on. The readers stay the only producers.

## Context

A measurement of one Angular webapp, with the snapshot data cache on, showed every `callers` and `impact` call spending
about 0.85 s in the relations reader and every `impact` and `importers` call about 0.9 s in module-dependencies
extraction. Both are pure functions of the exported sources (and, for relations, of the member-proof context derived
from the scope and the export listing). ADR-0020 decision 2 limits the cache to sources and entrypoint findings, so
neither output could be kept.

## Decision

1. ADR-0020 decision 2 is amended: besides UTF-8 serialized sources and completed entrypoint findings, the cache may
   retain the serialized output of exactly two readers: the relations extraction (`RelationExtractor.extract`) and the
   whole-universe module-dependencies extraction (`ModuleDependenciesReader.extract` without `files`). The rest of
   decision 2 holds: no source objects, compiler trees, stores, promises, callbacks, temporary paths or final facts, and
   the budget charges the UTF-8 bytes of each key and serialized payload.
2. An output is its own entry in the same cache, keyed by the key of the sources entry of the snapshot it was read from
   plus a slot that names the reader and every other input the output depends on. A sources entry never grows, so an
   output that does not fit the budget is skipped (decision 3 of ADR-0020) without removing the sources it was read
   from. The slot of relations is the canonical `memberProofs` context the reader receives
   (`memberProofContextOf`: whether the source is complete under the declared scope and the export). The slot of
   module dependencies carries no option, because only the read without `files` is retained.
3. The key of the sources entry already covers the other inputs of both readers: the repository, the resolved SHA, the
   declared scope, the trust, the export budget, and the full export listing with its blob ids, written flags, skipped
   entries and budget stop. The sources a reader receives are a function of that listing. Adapter versions are fixed for
   the composition that owns the cache (ADR-0020 decision 4).
4. A read with `files` (the focused outline) never reads, writes or shares a retained module-dependencies output; it
   is always produced. The outline therefore cannot be answered from, nor pollute, a whole-universe entry. The relations
   read of the contracts consumers is not retained either: it is a different consumer of the same reader and is left
   to its own decision.
5. The existing readers remain the only producers. The cache stores and returns what a reader serialized and never
   derives, completes or filters it. Consumers still run their own post-processing over the returned output.
6. An output is published only after its reader completed and the request was not cancelled. A cancelled read
   publishes nothing. Concurrent requests share no in-flight work: two that miss both produce, and the later `put`
   replaces the earlier one with an equal output.
7. A cache hit and a miss answer the same bytes: when a cache is configured the output a miss returns is the value
   after one serialization round trip, which is what a hit returns, whether or not the entry was admitted.
8. ADR-0030 supersedes the bypass this decision restated from ADR-0020 decision 6: a reconciled live or held-live
   capture offers retention to its consumers, keyed by the content hashes of its listing. A retained output is keyed
   by a SHA snapshot's listing or by a live capture's listing, never by HEAD or by a path.

## Consequences

- Repeated `callers`, `impact` and `importers` calls at one snapshot skip the two readers and pay one deserialization
  of each output. The first call pays one extra serialization per output. The entry bytes the host budgets grow by
  the size of those outputs; an output larger than the whole budget is skipped and cost returns to that of a miss.
- A retained output is observed as the cache line of its entry (`hit`, `miss`, `admitted`, `evicted`,
  `oversize-skipped`); the absence of the reader's stage in a measured request is the sign that it was served.
- A change to a reader's output shape or to an input it starts depending on must change the slot, or remove the
  retention, in the same change.

## Not decided here

- Retaining the relations output of the contracts consumers, the outputs of other readers, or the unresolved
  references of an opened store.
- Sharing outputs across compositions or processes.
