# ADR-0118: The callbacks of a Java file are kept by the questions they asked, over the supertypes of its own declarations

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-17: "todo lo que queda pendiente se debe ir integrando a medida que se pueda, lo haces
  de forma autonoma" (everything pending is integrated as it can be, autonomously), over RFC-0039, whose "As measured"
  section for M3 and M6 names the per-file callback walk as the unit that comes before M5.
- Amends: [ADR-0117](0117-the-entrypoints-of-a-java-file-are-kept-by-the-questions-they-asked-and-a-derivation-kept-by-its-reads-persists-on-disk.md)
  decisions 2 (the callbacks are "derived each time the stage runs") and 7 (the callback walk per file is "not moved here")
- Related: [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md),
  [ADR-0116](0116-a-java-derivation-is-kept-by-the-questions-it-asked-of-a-per-file-index-of-declared-names.md),
  [ADR-0040](0040-a-snapshot-read-parses-each-java-source-once.md)

**In short:** the framework callbacks the declarations of the project register become a per-file derivation
`java-callbacks`, kept by `DerivedFacts.ofReads`, so the entrypoints stage after one edit derives the callbacks of one
file and a read that finds no Java change builds no project for it. No fact changes.

## Context

After ADR-0117 a one-edit `entrypoints` stage takes about 0.9 s, of which the callback walk is about 0.28 s
(`readHierarchy` and `callbacksOf`) and the rest is the held project (a parse of every source and a project build) that
the walk forces at every run. `readHierarchy` reads every declaration of every file and closes the supertype graph of the
repository, but the closure `callbacksOf` consumes is upward: a type is registered under a contract when it or one of its
ancestors names the contract as a supertype, and the member a contract invokes is looked up on its own class chain and
interface frontier. Every answer about a type needs the supertype clauses of that type and of its ancestors, never those
of its subtypes.

| Option | Verdict |
|---|---|
| Keep the walk per run of the stage | Rejected: it is the cost M5 (parse on demand) cannot remove while the walk reads every tree |
| Record the whole hierarchy as one derivation | Rejected: any file that adds a supertype clause would derive it again |
| A per-file derivation whose supertype edges are those of the file's own declarations and of their ancestors, asked through the recording project | Chosen |

## Decision

1. **The callbacks of a Java source are the per-file derivation `java-callbacks`**, kept by `DerivedFacts.ofReads` and
   stored on disk at version 1 (ADR-0117 decision 5). Its subject is the file's path and content digest. It holds, for
   each invoked contract, the findings of the file's annotated types, anonymous classes, bean methods, unsettled
   supertypes and registered types, and the callbacks it found with their evidence, before they are grouped.
2. **The supertype edges are those of a declaration read up its own ancestors.** The derivation resolves the supertype
   clauses of each declaration of the file and of each ancestor it reaches through the recording project (ADR-0116
   decision 3), and holds them for that derivation only: it shares no memo with another file, so every question an edge
   rests on is in the record of the file that asked it. `readHierarchy` stays the whole-project reading of the dispatch
   readers; the clause resolution is one function both use.
3. **The merge is by contract, then by file.** It concatenates the findings of each contract in the order of the files and
   groups the callbacks of equal value across files, then sorts as the one reading of the project did. The answer is the
   bytes of the whole-project walk (checked by the corpus gate with `--expect none`).
4. **A read that finds nothing changed in Java builds no held project for the entrypoints stage.** The held project is
   built only by a derivation that missed.
5. **Not moved here:** `receiver-methods` (RFC-0039 M4) is decided by its own unit, and parse on demand (M5) stays open
   until the figures of this one are in.

## Consequences

- A one-file edit derives the callbacks of that file and of the files whose recorded answers it changed.
- The disk tier gains one entry per parsed Java file for the slot; retention is ADR-0077's.
- Changing `INVOKED_CONTRACTS` or the derivation changes the slot's pinned digest, so its version is bumped with it.
