# ADR-0146: The outside supertypes of a Java method are kept per file of sites by the questions its closure asks

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 §3.2 "Recorded-read
  verification"; and 2026-11-17: "todo lo que queda pendiente se debe ir integrando a medida que se pueda, lo haces de
  forma autonoma" (everything pending is integrated as it can be, autonomously), over ADR-0120 decision 6, which leaves
  "its per-closure form" to "its own unit". The targets it serves (translated): "Times must sit between a few hundred
  milliseconds and, for the most critical jobs, 3-5 s in specific cases; the p75 should be below 1 s".
- Amends: [ADR-0120](0120-the-readers-that-ask-about-one-java-declaration-are-kept-per-file-by-the-questions-they-asked.md)
  decision 6 (`outsideSupertypes` kept whole, by the listing),
  [ADR-0116](0116-a-java-derivation-is-kept-by-the-questions-it-asked-of-a-per-file-index-of-declared-names.md)
  (the markers of the per-file declarations)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.2, L28;
  [ADR-0145](0145-a-kept-derivation-asks-only-the-questions-an-edit-changed-since-the-index-it-was-verified-against.md);
  [ADR-0119](0119-the-receiver-methods-of-a-java-file-are-kept-by-the-questions-they-asked-over-the-names-the-sources-write.md);
  [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md)

**In short:** `outsideSupertypes` was one derivation over every asked site that recorded the whole listing, so any edit
derived it again and rebuilt the hierarchy of every source. It becomes one derivation per file of sites that reads, for
each method, only the part of the hierarchy its closure depends on, through questions the declaration index answers. A
body edit of a file that no closure reads derives nothing; an edit that changes a supertype of the closure derives the
files whose methods have that closure. No fact changes.

## Context

After ADR-0145 a kept derivation asks only the questions an edit changed, so verification after an edit costs 5 to 10 ms
on the 1,340-file backend. The time after an edit is spent deriving again the entries that recorded a question the edit
changes. `outsideSupertypes` records `listing()` (ADR-0120 decision 6), whose answer every edit changes, so every first
query after an edit derives it again, reading the hierarchy of every source (`readHierarchy`: every declaration,
anonymous class and function value).

Measured through the stdio MCP on shopizer/backend (1,340 Java files), right after an edit of the file `callers`
targets that appends a comment (no line moves), median of three:

| Family | Entries derived again | Of them `outsideSupertypes`, by the listing | Time deriving |
|---|---|---|---|
| `callers` | 35 | 11 | 1,076 ms |
| `trace` | 12 | 0 | 538 ms |

On jhipster-monolith/application no measured call asks it.

The answer for one method depends on less than the listing. `outsideSupertypesOf` reads the closure (the owner and the
types below it), the types above the closure, the supertype names left unsettled under a closure name, the anonymous and
local classes that extend a closure type or write a closure name, and the function values only when a closure type is a
functional interface. Each of those is found through a name the index already answers: a type below a type writes that
type's name as a supertype (`naming(supertype, name)`), an anonymous or local class under a name writes it
(`naming(unplaced-supertype, name)`), and a type above is reached by resolving the closure's own clauses. Two global
gates remain: the strict binding (`provesFromIndex`, ADR-0119) and an aspect introduction anywhere, which no question
answered.

| Option | Verdict |
|---|---|
| Keep the listing | Rejected: every edit derives every site again |
| One derivation per site, still over the whole hierarchy | Rejected: the hierarchy is still read whole, and the listing still decides |
| One derivation per file of sites over the part of the hierarchy each closure reads, asked through the index | Chosen |
| A new index question whose answer is the whole hierarchy | Rejected: any declaration edit anywhere would change it |

## Decision

1. **One derivation per file of sites.** `java-outside-supertypes` is kept by `DerivedFacts.ofReads` over the file's
   path and content digest, the sorted distinct places asked of it, and whether the build generates interfaces
   (ADR-0120 decision 1), in memory only as before. A method is found among the file's own types (`typesOf`).
2. **The closure hierarchy.** For a method's owner the derivation reads, through recorded reads: the owner; for each
   name of a closure type, every placed type of the files `naming(supertype, name)` answers, keeping those whose
   strictly resolved clauses reach the closure; every repository type above the closure; and the anonymous and local
   classes of the files `naming(unplaced-supertype, name)` answers. A placed type whose declaration is read asks its
   file's content. Each declaration is read by the same function `readHierarchy` uses, so every entry equals the whole
   reading's, and every entry the answer depends on is read, because the entry writes a closure name.
3. **Function values ask the listing.** Only a closure with a functional interface reads the function values; it reads
   them over every source, which asks `listing()` (RFC-0039 P10).
4. **The gates are questions.** The strict binding is `provesFromIndex`. An aspect introduction is the new marker
   `introduction` of the per-file declarations (`marked(introduction)`), set by the same predicate the whole reading
   applies (`isIntroduction`). The slot `java-declarations` moves to version 3.
5. **No memo is shared between two files**, except the whole hierarchy of decision 3, whose every reader asks the
   listing.
6. **What does not change.** The answers, the reading without kept facts, the reading of `dispatchTargets`, and the
   rule that an entry read from disk is verified by every question.

## Consequences

- A body edit of a file no closure reads derives no outside supertypes; a closure with a functional interface still
  derives on every edit. A signature edit derives exactly the files whose closures asked a name or a file it changed.
- The entries of `java-declarations` stored at version 2 are not read again; each file's declarations are derived once
  more.
- A fitness test holds the kept answer equal to a cold read after eleven kinds of edit (a type renamed, a package moved,
  a platform package claimed, an introduction, an anonymous class below the owner, a function value of a functional
  interface, a file that appears, disappears or stops parsing, a body that stops parsing, and the inputs).
- Measured as in the context table, candidate against the tree before it, with every answer byte-equal (48 of 48):
  after an appended comment, `callers` on shopizer/backend derives 25 entries instead of 35 (`outsideSupertypes` 1
  instead of 11) and spends 803 ms deriving instead of 1,076 ms; the one left is a file of sites whose closure holds a
  functional interface and reads the function values of every source (252 ms). After an edit that moves the queried
  lines, the sites asked are new, so the number derived does not change, and the time spent deriving them falls from
  462-525 ms to 265-278 ms. The wall time of those calls moves within the noise of the run (3.4-3.9 s): most of it is the
  held project the first derivation that misses builds (about 470 ms), the call-site and entry-point stages and the live
  lock. `trace` and the jhipster calls are unchanged.

## Not decided here

- The other derivations that record a file's whole content when they only read its declarations: a narrower question
  needs to know which parts of a type a derivation reads.
