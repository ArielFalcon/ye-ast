# ADR-0128: A kept derivation verified against a declaration index is not asked again of an equal one

- Status: Accepted, 2026-11-22, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 §3.2 "Recorded-read
  verification", corrected by review finding R7 ("`verifiedAt` per generation is unsound across families; use the index
  fingerprint"). The targets it serves (translated): "Times must sit between a few hundred milliseconds and, for the
  most critical jobs, 3-5 s in specific cases; the p75 should be below 1 s", and "caches with robust stale policies".
- Amends: [ADR-0116](0116-a-java-derivation-is-kept-by-the-questions-it-asked-of-a-per-file-index-of-declared-names.md)
  (when `DerivedFacts.ofReads` asks the recorded questions again)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.2, L10;
  [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md),
  [ADR-0117](0117-the-entrypoints-of-a-java-file-are-kept-by-the-questions-they-asked-and-a-derivation-kept-by-its-reads-persists-on-disk.md),
  [ADR-0126](0126-the-snapshot-cache-keeps-decoded-frozen-values-and-names-a-file-by-its-blob-id.md)

**In short:** every hit of `DerivedFacts.ofReads` asked each recorded question again, so a warm query re-verified
thousands of kept Java derivations against an index that had not changed. The declaration index now carries a
fingerprint of everything its answers depend on, and a kept entry remembers, in memory only, the fingerprint it was last
verified against. An entry asked through an index with that same fingerprint is answered without asking anything. No
fact changes.

## Context

`ofReads` keeps a derivation with the questions it asked of the declaration index and the answers it got (ADR-0116);
a hit is valid when every recorded question still gets the same answer. That check ran on every hit, in every query,
including the many warm queries where no source changed. The index is a pure function of its files and of its inputs
(`generatesInterfaces`, `unreadJvm`), so two indexes with equal files and equal inputs answer every question alike, and
an entry that held against one holds against the other.

RFC-0040 first named the verification by a per-generation counter. Review finding R7 showed that unsound: families build
the index over different sources and inputs (a trace over the export's held paths, other readers with `unreadJvm`
false), so one generation holds several indexes that answer differently. The index's own fingerprint is the right name.

| Option | Verdict |
|---|---|
| A counter per store or snapshot generation | Rejected (R7): two indexes of one generation can answer one question differently |
| The fingerprint of the declaration index, kept in memory per entry | Chosen: equal fingerprints imply equal answers, whichever family asks |
| The fingerprint stored with the entry on disk | Rejected: a stored entry may come from another engine version, whose questions the current vocabulary must still check; nothing measured needs it |

## Decision

1. **The fingerprint.** A declaration index carries `fingerprint`: the digest of its files (path and content digest,
   ordered by path) and of its inputs. Equal fingerprints mean every question gets the same answer. `ofReads` receives
   the index itself (`answerIfKnown` and `fingerprint`), not only its answering function.
2. **`verifiedAt`.** A kept entry in the snapshot data cache remembers the fingerprint of the index against which it
   was last derived or verified. It is set after a derivation is kept, after a memory hit whose questions all held, and
   after a disk hit whose questions all held is admitted.
3. **No question for an equal fingerprint.** A memory hit whose `verifiedAt` equals the asking index's fingerprint is
   answered without asking any question. A different fingerprint asks the recorded questions as before and, when they
   hold, moves `verifiedAt` to it.
4. **Memory only.** `verifiedAt` names the entry object the cache holds, so it lives exactly as long as the entry and
   is dropped with it on eviction or replacement. It never reaches the disk tier or a key, and is not charged to the
   budget (one digest per kept entry). An entry read from disk is always verified by its questions first.
5. **What does not change.** The keys, the recorded questions and answers, the disk tier (ADR-0077, ADR-0117), the
   rule that a derivation that throws is kept for nobody, and every answer.

## Consequences

- A warm query whose index matches the one its entries were last verified against asks no recorded question.
- One verification per entry is still paid the first time a query asks through an index with another fingerprint:
  after an edit, or when two families with different indexes alternate, each switch re-verifies once.
- The fingerprint costs one digest over the paths and content digests of the Java sources per index built.

## Not decided here

- `changedAt` per answer and early cutoff (RFC-0040 L11).
- Keeping more than one verified fingerprint per entry.
