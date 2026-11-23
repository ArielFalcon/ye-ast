# ADR-0126: The snapshot cache keeps decoded, frozen values and names a file by its blob id

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 D2: "The memory tier keeps
  decoded, frozen objects and a working-set budget, with git blob ids as file identity". The targets it serves
  (translated): "Times must sit between a few hundred milliseconds and, for the most critical jobs, 3-5 s in specific
  cases; the p75 should be below 1 s [...] without sacrificing functionality and quality", and "caches with robust
  stale policies".
- Supersedes: [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md) decision 2 (what an entry holds) and decision 5
  (its last sentence: returned data deserialized afresh)
- Amends: [ADR-0035](0035-derived-facts-are-retained-by-content.md) decision 1 (what a derived fact is) and decision 4
  (what a hit and a miss answer)
- Amended by: [ADR-0147](0147-the-snapshot-cache-floor-is-what-each-repositorys-recent-contents-used-charged-as-decoded-heap.md) (decision 1: an entry is charged the heap its decoded
  value takes, by a measured factor of its serialized bytes)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §2 M3, §3.2, §3.5;
  [ADR-0026](0026-snapshot-data-may-retain-reader-outputs.md) decision 7,
  [ADR-0030](0030-live-captures-use-the-snapshot-data-cache.md), [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md)

**In short:** the snapshot data cache held UTF-8 bytes and ran `JSON.parse` on every hit, so a warm `callers` decoded
thousands of facts and a multi-megabyte sources entry again on each call. It now keeps the value it admitted after its
one serialization round trip, deep-frozen, and every hit answers that same object. A file is named in memory keys by the
git blob id its listing already carries, instead of a digest of its content or the content itself.

## Context

RFC-0040 §2 M3 measured, on the corpus Java backend, 3,700-3,950 fact hits per warm `callers`, each a `JSON.parse`, plus
a 4.2 MB and an 11.8 MB snapshot entry decoded again, and keys built by canonicalizing and hashing whole source
contents (`trace-data-effects`, the held Java project, the held syntax trees). On jhipster-monolith a warm `callers`
made 4,247 parses per call. ADR-0020 decision 5 decoded afresh so that a consumer could not change a stored entry;
freezing gives the same guarantee without the decode, and turns a consumer that mutates what it was given into an
error instead of a silent corruption.

Both listings already name each file by a git blob id: `git ls-tree` at a sha, and the live mirror's manifest, which
hashes each copied file as git does (`blob <size>\0` then its bytes). The export writes blob bytes with no filter
(`cat-file --batch`), so equal blob ids mean equal bytes, and the source reader turns equal bytes into equal content.
ADR-0030 already keys a live capture's retained sources by these ids.

## Decision

1. **What an entry holds** (supersedes ADR-0020 decision 2). An entry holds the value its stage published, after one
   JSON serialization round trip, deep-frozen: sources, completed findings and reading cuts, reader outputs
   (ADR-0026) and derived facts (ADR-0035). The rest of ADR-0020 decision 2 stands: no syntax tree, node, program,
   store, promise, callback or temporary path is retained, and the budget charges the UTF-8 bytes of the key and of
   the serialized value. It bounds the serialized bytes, not the heap the decoded value takes; RFC-0040 L9b charges
   that by a measured factor.
2. **What a hit answers** (supersedes the last sentence of ADR-0020 decision 5). A hit answers the stored frozen
   object itself, with no decode. A consumer that needs to change what it received copies it first. Freezing is always
   on, in tests and in production.
3. **A hit and a miss answer the same value** (amends ADR-0035 decision 4 and restates ADR-0026 decision 7). A derived
   fact and a reader output answer, on a miss, the frozen value after its round trip, whether or not it was admitted,
   so a consumer that mutates fails on the first call, not only on a repeated one. Sources and findings read on a miss
   reach the request as read, as before; what is kept of them is the frozen round trip.
4. **What a derived fact is** (amends ADR-0035 decision 1). A derived fact is a plain JSON value, kept frozen.
   Everything else in decision 1 stands.
5. **File identity.** A source read from a listing carries the listing's blob id for its path. In a memory key, a file
   is named by its path and that blob id; a file without one (a library source, a file a test builds) is named by its
   path and the digest of its content, as before, and the two forms never compare equal. This applies to the per-file
   derived facts (ADR-0035 decision 2), to the inputs of `trace-data-effects` and `trace-call-sites`, to the key of a
   held Java project and to the key of a held syntax tree. Keys stay content-addressed: a blob id is the content's
   identity.
6. **What does not change.** Every memory key keeps the trust mode (ADR-0031 decision 3). The disk key of a derived
   fact stays its slot, its reader's version and its file's content digest (ADR-0077), computed only when the memory
   tier misses, so stored entries and their sharing across trust modes are unchanged. Nothing cut by a deadline or an
   abort is admitted. The budget, its floor (ADR-0112, ADR-0121) and the eviction order are unchanged.

## Consequences

- A warm call decodes nothing it finds in the cache, and building a key reads no source content.
- A consumer that sorts, pushes into or assigns to a cached value throws a `TypeError`. The suites run with freezing
  on, and every such consumer copies what it changes.
- The decoded value takes more heap than its serialized bytes; until L9b charges it, the budget undercounts the tier.
- A sources entry is a few dozen bytes per file larger, because each source carries its blob id.
- A source object whose content is changed by spreading it must drop its blob id; no production code does so.

## Not decided here

- The working-set budget and the charge of the decoded tier (RFC-0040 L9b).
- File identity inside the subjects of `ofReads` and the other `ofInputs` callers that still name content.
