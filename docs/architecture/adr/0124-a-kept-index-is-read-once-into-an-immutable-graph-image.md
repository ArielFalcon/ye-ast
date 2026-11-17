# ADR-0124: A kept index is read once into an immutable graph image

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 D1: "The codegraph adapter
  reads a store's graph in bulk into an immutable in-memory image; raw SQL stays in the adapter, version-checked".
  The targets it serves (translated): "Times must sit between a few hundred milliseconds and, for the most critical
  jobs, 3-5 s in specific cases; the p75 should be below 1 s [...] without sacrificing functionality and quality."
- Amends: [RFC-0003](../rfc/0003-codegraph-integration.md) "Access: SDK first, raw SQL remainder"
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §2 M1, §3.2, §5;
  [ADR-0015](0015-index-reuse-by-content.md), [ADR-0027](0027-retention-of-immutable-index-entries.md)

**In short:** a query over a kept index used to ask the store one key at a time through SDK batch methods that prepare a
statement per call: a warm `callers` issued about 30,000 statements. The codegraph adapter now reads a kept index once,
in three statements inside one read transaction, into a frozen image whose lists are already in the orders the port
promises; every later open of that index answers from memory and touches no store. Live mirrors keep the SQL reader
until their store has a committed generation (RFC-0040 L5).

## Context

RFC-0040 §2 M1 measured the cost on a 1,210-file Java backend: 30,020 `prepare` and 32,541 `SELECT` returning 335,986
rows per warm `callers`, 1.0-2.0 s of it SQL, while one bulk read of the whole store takes 250-430 ms. On
jhipster-monolith (4,058 nodes, 6,377 edges, 6,564 unresolved references), measured 2026-11-17 on an Apple M1 Max:

| | Before | After |
|---|---|---|
| Second identical `callers` in one process: store opens, SQL statements | 3, 64 | 0, 0 |
| Warm `callers` (three runs, second and third query of a process) | 2.1-2.8 s | 0.94-1.67 s |
| `store-open` stage of a warm query | 10-37 ms | 0-1 ms |
| Image: one-time load, retained heap, charge | | about 0.3 s, 6.4 MiB, 4.7 MiB |

The SDK exposes no bulk read of nodes, edges and unresolved references, so the image is raw SQL (RFC-0003's remainder).

## Decision

1. **What the image holds.** Symbols by id, by file and by name; edges by source and by target; unresolved references by
   file. Each list is sorted once with the port's comparators, from rows read in row order, so rows those comparators
   leave tied keep the order the store's own lookups return them in. Every value is frozen, and every answer is a new
   list, so a consumer that sorts what it got changes nothing kept.
2. **Same answers.** The image answers every `CodeGraphReader` method deep-equal to the SDK reader: names match exactly
   and case-sensitively, as `nodes.name = ?` does under SQLite's binary collation; unresolved references are uncapped;
   an empty kinds list asks for nothing. A conformance check compares both readers over every file, id and name of a
   store, alone and together, with case variants of each name and every edge kind
   (`scripts/graph-image-conformance.ts`); it runs on the corpus stores before the image serves them.
3. **Access.** The raw SQL lives in the codegraph adapter alone: three `SELECT`s in one read transaction on a read-only
   connection, after the version check RFC-0003 already makes. A store outside the supported versions is refused as
   before.
4. **Only stores nothing writes.** The image serves the kept indexes of the index cache, which are immutable once
   published (ADR-0015). A live mirror is synced in place, so it keeps the SQL reader until RFC-0040 L5 keys an image by
   its committed store generation.
5. **Key, invalidation, charge.** The key is the database file of the store and its identity: path, device, inode,
   size, modification and change times. A store rebuilt at the same path has another identity, so its old image is
   never served. The charge is two bytes per UTF-16 unit of the text and eight bytes per number the image holds,
   measured at about 0.74 of the retained heap. Images are kept least recently used first out within
   `graphImageBytes` (256 MiB by default: eight times the estimated charge of the largest corpus store); one larger
   than the budget is used and not kept, and a read that fails keeps nothing.
6. **Trust.** The key holds no trust mode: the image is a function of the store bytes alone, and the index cache only
   opens stores ye-ast built from its own export at a sha, the same under both modes ([ADR-0010](0010-trust-modes.md)). No deadline or abort
   reaches the load, which is synchronous.

## Consequences

- A warm query over a kept index no longer pays per-key SQL; the first query of a process pays the bulk read once per
  index content.
- The load runs on the query's event loop. On the largest corpus store it is estimated at 250-430 ms (RFC-0040 §2); a
  worker or chunked load is RFC-0040 §5's guard if a cancellation test shows the delay matters.
- Memory grows by the budget at most; RFC-0040 §5's RSS slope covers it in the bench.

## Not decided here

- The live image and its store-generation key: RFC-0040 L5.
- Inverted indexes over the image (D5): RFC-0040 L23.
