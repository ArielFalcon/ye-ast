# ADR-0035: The snapshot data cache may retain plain facts derived from one file or from named inputs, keyed by content

- Status: Accepted, 2026-11-07, owner
- Decision source: the owner, 2026-11-07 (translated): "I approve tier 2 per file", approving the per-file granularity
  of the derived-fact memo proposed after measuring repeated MCP queries.
- Amends: [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) decision 2 and
  [ADR-0026](0026-snapshot-data-may-retain-reader-outputs.md) decision 1 (what the cache may retain)
- Related: [ADR-0010](0010-trust-modes.md), [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md),
  [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md),
  [ADR-0031](0031-snapshot-data-is-keyed-by-the-written-files.md),
  [RFC-0012](../rfc/0012-observability-and-measurement.md)

**In short:** readers rebuild, on every request, facts that depend on one file's content alone (where the TypeScript
binder proves a parameter use) or on a small set of named inputs (where a module specifier resolves). The cache may keep
those facts as plain data, keyed by the content they were derived from, so unchanged files are not derived again across
requests, across snapshots (the base and head of a change) or after an edit to another file.

## Context

- Measured through the stdio MCP with the snapshot data cache and a kept index warm (run on 2026-11-07, host load
  12-28): a repeated `callers` on an Angular webapp of about 1,140 TypeScript files spent about 0.38 s binding files
  to find parameter and dynamic-scope uses and about 0.18 s resolving module specifiers, out of about 1.5 s; a repeated
  `impact` spent about 0.74 s of 3.7 s on the same work. Every value is a pure function of one file's path and content,
  or of a specifier, the importing directory and the snapshot's paths and JSON files.
- The readers already keep those values, but only for the life of one reader, which every request builds afresh.
- ADR-0020 decision 2 limits the cache to serialized sources, findings and (ADR-0026) two whole reader outputs. A whole
  output is keyed by the whole written listing (ADR-0031), so one edited file misses all of it.
- Retaining the source objects instead, so the syntax trees stay alive, was measured on another branch: 4 to 9% less
  CPU on repeated calls for 123 to 286 MB of heap the budget does not charge. It is not taken.

## Decision

1. ADR-0020 decision 2 and ADR-0026 decision 1 are amended: the cache may also retain **derived facts**, plain JSON
   values a reader derives either from one file's path and content alone, or from inputs it names in full. Never a
   syntax tree, a node, a program, a promise or any object that holds one.
2. A derived fact is keyed by the digest of its slot (the reader and the fact), the trust of the snapshot it was read
   under, and its inputs: a file by its path and the digest of its content; named inputs as given. The trust stays in
   the key as in ADR-0031 decision 3. No producer or adapter version is in the key: the cache lives in one process
   with fixed readers (ADR-0031, Context).
3. A derived fact shares the cache's byte budget and its least-recently-used order with every other entry, and is
   charged with the UTF-8 bytes of its key and serialized value. The default budget (ADR-0021) does not change.
4. A value is kept only after its derivation completed: a derivation that throws or rejects keeps nothing, and a fact
   cut by a deadline is never a derived fact. A hit and a miss answer the same JSON value: a miss answers the value
   after one serialization round trip. Concurrent requests share no in-flight derivation; the later keep replaces an
   equal value.
5. The view a reader receives is created with the snapshot's retention, so it exists only where retention does, and
   carries that snapshot's trust. Under `untrusted` it holds only what ye-ast derived from its own export.
6. Keeping or finding a derived fact writes no `cache` line; an entry a fact evicts writes its `evicted` line, as
   every eviction does. A measured composition writes one `derived-facts` line per reader call
   with what the call kept and found (RFC-0012).

## Consequences

- Repeated requests skip the derivations whose inputs did not change; an edit derives again only the facts of the
  edited file and the facts that name it among their inputs.
- Many small entries enter the cache. Their bookkeeping is not charged, as for every entry (ADR-0020 decision 2), and
  they compete with snapshot entries for the same budget; the `derived-facts` line reports their bytes and evictions.
- A reader that starts depending on another input must name it in the fact's inputs, or change the slot, in the same
  change.

## Not decided here

- Keeping derived facts across processes, a separate budget for them, or sharing them across trust modes.
