# ADR-0145: A kept derivation asks only the questions an edit changed since the index it was verified against

- Status: Accepted, 2026-11-22, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 §3.2 "Recorded-read
  verification" (`verifiedAt` and `changedAt` per kept derivation, early cutoff). The targets it serves (translated):
  "Times must sit between a few hundred milliseconds and, for the most critical jobs, 3-5 s in specific cases; the p75
  should be below 1 s", and "caches with robust stale policies".
- Amends: [ADR-0128](0128-a-kept-derivation-verified-against-a-declaration-index-is-not-asked-again-of-an-equal-one.md)
  decisions 3 and 4 (what a hit asks of an index with another fingerprint, and what `verifiedAt` names),
  [ADR-0116](0116-a-java-derivation-is-kept-by-the-questions-it-asked-of-a-per-file-index-of-declared-names.md)
  decision 4 (a hit asks every recorded question)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.2, L11;
  [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md)

**In short:** after an edit, every kept Java derivation asked all its recorded questions again of the new declaration
index, although an edit changes the answers of only the names in the edited files. The index now tells which questions
may answer differently from an earlier index, computed from the edited files alone, and a kept entry asks only those.
No fact changes.

## Context

ADR-0128 answers a kept derivation without a question when the asking index has the fingerprint the entry was last
verified against. Any edit gives the index a new fingerprint, so the first query after it asks every recorded question
of every entry it touches. Measured through the stdio MCP right after a body edit of one file, per live call:

| Repository | Family | Entries verified | Questions asked | Time verifying |
|---|---|---|---|---|
| jhipster-monolith/application | `trace` | 122 | 2,904 | 1.4-5.4 ms |
| jhipster-monolith/application | `callers` | 280 | 4,442 | 2.1-2.8 ms |
| shopizer/backend | `trace` | 1,719 | 48,370 | 23-36 ms |
| shopizer/backend | `callers` | 5,240 | 95,677 | 43-60 ms |

Over 99% of those entries held: their questions did not change. Each answer of the index is a function of what each
file contributes to it (its content, its declared names, the names its bodies write, its state) and of the index's two
inputs. An edit changes the contribution of the edited files only, so the questions whose answers can change are the
ones named in the difference between an edited file's old and new contribution.

Salsa's red-green keeps a `changedAt` revision per answer and compares it with each entry's `verifiedAt` revision. That
needs one linear history of revisions. Here several indexes interleave in one process: families build the index over
different sources and inputs, and one process may serve several repositories (the reason review finding R7 rejected a
per-generation counter for ADR-0128). So `changedAt` is relative: the set of questions an index changed since a given
earlier index, which is exactly "`changedAt` newer than `verifiedAt`".

| Option | Verdict |
|---|---|
| A global revision counter, `changedAt` per question | Rejected: unsound when indexes over other sources or inputs interleave (R7) |
| A revision line per source set and inputs, kept by the index adapter | Rejected: needs a registry of lines with no owner to bound or drop it |
| The questions an index changed since the index an entry was verified against, from the edited files' difference | Chosen: sound for any two indexes, computed once per pair, held only as long as a kept entry names the earlier index |

## Decision

1. **The version of a set of answers.** `RecordedAnswers` may carry `version`, what a kept entry remembers of the
   answers it was verified against, and `changedSince(version)`: a test that tells, for a question, whether its answer
   may differ from the one the answers named by `version` give, or `undefined` when it cannot tell. The declaration
   index's version is its file entries by path and its inputs.
2. **The difference of an edited file.** The declaration index compares an earlier version with itself by path. A path
   whose content digest differs, or that only one side holds, is edited. Each edited file contributes, per question, a
   value on each side: `file` its content digest, `declarations` its declarations digest, `declaring` and `named` the
   types it declares under the name, `package` the packages it states, `naming` and `marked` whether it writes the name
   or carries the marker, `unread` its state, `build|claimed` the platform package it claims, `listing` its content.
   A question changed when one edited file's two values differ. `unread` also changes with `unreadJvm` and
   `build|generatesInterfaces` with `generatesInterfaces`. No other question changes: every answer is a function of the
   files' contributions and the inputs, which a fitness test over a universe of questions holds.
3. **`changedAt` relative to `verifiedAt`.** `verifiedAt` names the fingerprint and the version of the answers an entry
   was last derived or verified against (ADR-0128 decision 2). A memory hit through answers with another fingerprint
   asks only the recorded questions that `changedSince(verifiedAt)` tells changed; all of them when it cannot tell. The
   test is computed once per pair of index and earlier version.
4. **Early cutoff.** A changed question whose answer equals the recorded one keeps the entry green: the entry is not
   derived again and its `verifiedAt` moves to the asking answers, so the derivations that asked only unchanged or
   equal answers stay kept. A question whose answer differs derives again exactly the entries that recorded it.
5. **Memory only.** The version lives as long as a kept entry names it in `verifiedAt` (ADR-0128 decision 4); it shares
   the per-file entries the index already holds, and adds one map of path to entry per distinct index still named. It
   never reaches the disk tier or a key. An entry read from disk is still verified by every question.
6. **What does not change.** The keys, the recorded questions and answers, the disk tier, the rule that a derivation
   that throws is kept for nobody, and every answer.

## Consequences

- After a body edit, a kept entry that did not record the edited file's content or the listing is answered without a
  question; one that did asks only those questions.
- A signature edit derives again exactly the entries that recorded a question whose answer it changed.
- Two indexes over other sources (families that alternate) compare their whole difference once per switch, which is
  still correct and at worst what ADR-0128 asked.
- The mapping from a file's entry to its contributions must follow the answers of the index; the fitness test fails when
  a new question or a new answer rule is added without it.

## Not decided here

- Early cutoff between derivations (one kept derivation reading another's value): none reads another's value today; a
  subject that names another derivation's value is already equal when that value is.
