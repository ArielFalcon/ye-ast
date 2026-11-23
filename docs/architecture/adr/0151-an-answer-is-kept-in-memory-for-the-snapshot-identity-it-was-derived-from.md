# ADR-0151: An answer is kept in memory for the snapshot identity it was derived from

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 D3: "An answer is kept in
  memory for its generation", and RFC-0040 §3.2 row "Answer memo": "the fact before redaction and rendering [...] Memory
  only [...] Family, canonical request, content identity, store generation, `head`, trust, engine versions, schema, and
  the validated identities of declared build outputs", corrected by review findings R1 ("`stateId` does not identify a
  live store: a synthesized rebuild keeps it"), R2 ("The memo also needs `head`, because a commit without a tree change
  moves it") and R12 ("Memo and typed stages must validate build-output content, not only declared paths"); and
  2026-11-17: "everything pending is integrated as it can be, autonomously". The targets it serves (translated): "Times
  must sit between a few hundred milliseconds and, for the most critical jobs, 3-5 s in specific cases; the p75 should
  be below 1 s", "without sacrificing functionality and quality", and "caches with robust stale policies".
- Amends: [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) decision 2 ("no [...] final facts are retained");
  [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md) "Not decided here" ("Storing whole
  facts: not done"), for memory only
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.1, §3.2, §5, D3, L17;
  [ADR-0125](0125-a-live-store-is-read-into-a-graph-image-named-by-its-committed-store-generation.md),
  [ADR-0144](0144-the-mirror-lock-covers-the-refresh-and-the-pin-and-a-live-query-derives-from-the-pinned-capture.md),
  [ADR-0147](0147-the-snapshot-cache-floor-is-what-each-repositorys-recent-contents-used-charged-as-decoded-heap.md)

**In short:** a query that reads its head through the head reader (`callers`, `importers`, `outline`, `trace`) keeps
its fact in the snapshot data cache, under its family, its canonical request and the identity of the snapshot it pinned:
the content, the store generation and HEAD for the live tree, the commit and its export for a sha, with trust, scope,
engine versions and schema. A repeated query, a `page` or `select` follow-up, a second response mode and the
per-repository callers of a workspace `replay` then answer the kept fact after the freshness proof, without deriving
again. Nothing cut by a deadline or an abort, nothing `unknown` for a transient reason, and nothing over a declared
build output is kept.

## Context

Every MCP follow-up re-runs its query: `page` and `select` re-derive the fact only to cut evidence out of it and check
its result identity (`server.ts` `answer`, `evidence-cursor.ts`); a second mode (`summary` then `details`) re-derives the
same fact to render it again; a workspace `replay` reruns every repository's query to compare identities. After phase 2
each of these still pays the warm derivation: on the corpus' Java backend a warm `callers` costs about 1 s, of which the
freshness proof and the pin are a fraction (RFC-0040 §2, ADR-0147 consequences).

Facts were never kept because an answer's inputs were not all named in memory: a live store had no identity beyond
`stateId` (R1) and a commit without a tree change keeps `stateId` while HEAD moves (R2). ADR-0125 and ADR-0144 now name
the live store by the generation committed under the lock and pin HEAD with the capture.

| Option | Verdict |
|---|---|
| A memo in the MCP server, keyed by the request | Rejected: the request names a revision or the live tree, not the content; without the freshness proof an edit would answer the old fact |
| A memo in each family's code | Rejected: four copies of the identity and admission rules, and a family added later would have none |
| A memo where a family reads its head, after the proof and the pin, before derivation | Chosen: the head reader is the one place that knows the pinned identity, and the staleness notice and the pin still run on every call |
| Key build outputs by their declared paths and a cheap tag (lock record, listing) | Rejected: R12; the typed reading re-checks every path it asked (`type-bindings.adapter.ts` `unchanged`), which a key over declared paths cannot do |

## Decision

1. **Where.** The head reader keeps the fact a family's read answers, after the snapshot is pinned (the live capture
   under the mirror lock, ADR-0144; a commit's prepared export at a resolved sha) and its sources loaded, and before the
   family's read runs. A family opts in by naming itself and its request; `callers`, `importers`, `outline` and `trace`
   do. The map, `impact.ofChange`, `workspace`, `decisions` and `contract_consequences` read their heads their own way
   and keep nothing.
2. **The key.** The snapshot entry the capture already reads under (trust, declared scope, export budget and the written
   listing by blob id, ADR-0126 and ADR-0147) plus a slot naming:
   - the family and its **canonical request**: every field of the request the family declares as a key field, with
     the revision resolved to a commit by the snapshot identity below; `signal` and `onStale` are excluded, since the
     memo sits inside the pinned call and the staleness notice runs after it as before;
   - the **snapshot identity**: for the live tree, `stateId`, the store generation the capture was pinned at (R1) and
     HEAD (R2); for a sha, the commit and the digest of its whole export (written, unwritten and skipped entries), the
     content the kept index's content key is derived from with the engine versions;
   - the fact spec's engine versions and declared configuration, the producer and the schema version.
3. **The request fields are enumerated.** Each family's key fields are listed in one table per family, typed against
   the family's request: a request field added without an entry fails `tsc`. At run time a request holding a field the
   table does not list is not kept, so an unlisted input never shares a slot.
4. **Never kept.** A fact is not admitted when the request was aborted, when any part of it is `unknown` with reason
   `deadline`, `index-unavailable`, `source-unreadable` or `revision-unavailable`, or carries a `deadline` cut; nor when
   the repository has declared build outputs (`node_modules`, generated Java sources, a JDK): their validated identity
   is the set of paths the typed reading asked and what it found there, held inside the reader, so until a reader
   exposes it such an answer is derived on every call (R12). A failed result is never kept.
5. **Value and charge.** The kept value is the fact before redaction and rendering, after its one serialization round
   trip, deep-frozen (ADR-0126), so the first answer and every hit are the same frozen value. It is charged as every
   snapshot cache entry is, as decoded heap. Its key grows with distinct requests, so it is admitted as keyed by a
   request: not counted in the working-set floor and evicted least recently used above it (ADR-0147 decision 6,
   amended 2026-11-23; it was first counted in the floor, which then grew with every distinct request). There is no
   size constant and an explicit `snapshotCacheBytes` of zero keeps nothing.
6. **Memory only.** Nothing of it reaches the derived-fact disk tier (ADR-0077) or any file; the store generation never
   reaches a disk key (RFC-0040 open question 2).
7. **Observable.** Each lookup reports `hit`, `admitted` or `not-kept` to the host's measurement as one `answer-memo`
   line (RFC-0012).

## Consequences

- A follow-up or a repeated query at an unchanged snapshot costs the freshness proof, the pin and the presentation. An
  edit moves `stateId` and the generation; a commit without a tree change moves HEAD; a sync or rebuild at the same
  `stateId` moves the generation; a new revision resolves to another commit: each misses.
- The first answer of a query is frozen. A consumer that mutated a fact now throws, which the suite exercises.
- The first answer pays one serialization round trip of its fact; the first call of each cell below moved within
  noise (shopizer/backend live `callers` 17.5 s before and 16.6 s after, cold process).
- Measured on the stdio MCP over clones of the corpus (`main` `0a0962bec` against this decision; medians of five calls
  after a first one, Apple M1 Max). The `answer-memo` line answered `hit` on every follow-up:

| Repository, snapshot, family | Repeated query | Second mode (`details`) | `page` + `select` |
|---|---|---|---|
| shopizer/backend, live, `callers` | 915 → 178 ms | 929 → 175 ms | 903 → 175 ms |
| shopizer/backend, live, `importers` | 494 → 169 ms | 493 → 171 ms | |
| shopizer/backend, live, `trace` | 219 → 169 ms | 215 → 168 ms | |
| shopizer/backend, revision, `callers` | 452 → 25 ms | 446 → 27 ms | 437 → 20 ms |
| shopizer/backend, revision, `importers` | 272 → 21 ms | 253 → 20 ms | |
| realworld-nx/frontend, live, `callers` | 102 → 69 ms | 99 → 67 ms | 99 → 67 ms |
| realworld-nx/frontend, revision, `callers` | 38 → 17 ms | 38 → 17 ms | 35 → 15 ms |

  A live hit still pays the freshness proof and the pin (about 170 ms on shopizer/backend, 65 ms on
  realworld-nx/frontend); a hit at a revision pays the commit resolution and the listing. The warm differential on
  petclinic/backend-rest and realworld-nx/frontend passed 55 steps with 0 differing.

## Not decided here

- Keeping the answers of the map, `impact.ofChange` and the workspace families, which read their heads outside the head
  reader.
- A validated identity of declared build outputs that a memo key can carry (the asked paths of a typed reading).
- Single flight for identical concurrent queries: each computes, the last admission wins with an equal value.
