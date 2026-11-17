# ADR-0119: The receiver methods of the call sites of a Java file are kept by the questions they asked over the names the sources write

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-17: "todo lo que queda pendiente se debe ir integrando a medida que se pueda, lo haces
  de forma autonoma" (everything pending is integrated as it can be, autonomously), over RFC-0039, whose "As measured"
  section for the callback walk names M4 (`receiver-methods` per file) as the unit that comes before M5.
- Amends: [ADR-0118](0118-the-callbacks-of-a-java-file-are-kept-by-the-questions-they-asked-over-the-supertypes-of-its-own-declarations.md)
  decision 5 (`receiver-methods` is "decided by its own unit"),
  [ADR-0116](0116-a-java-derivation-is-kept-by-the-questions-it-asked-of-a-per-file-index-of-declared-names.md)
  decision 7 (`receiver-methods` "not moved here")
- Related: [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md),
  [ADR-0031](0031-snapshot-data-is-keyed-by-the-written-files.md),
  [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md)

**In short:** the receiver method of a call site is derived per file of sites, kept by `DerivedFacts.ofReads` and stored
on disk, so one edit derives the files whose recorded answers changed and verifies the rest. The six reads of the
resolver that look at every file become questions over the names the sources write, and the resolver of every reader
answers them the same way. No fact changes.

## Context

`receiver-methods` is kept as one `ofInputs` entry over the whole listing and the asked sites (ADR-0031), so any edit
derives every asked site: 656 to 797 ms for 13 calls on the 1,340-file backend after ADR-0118, with the held project
(a parse of every source and a project build) paid by whichever stage misses first. The resolver rests on six reads of
the whole project (RFC-0039 "M4: what is left of `receiver-methods`"): whether the strict binding proves anything over
every source, what an anonymous or local class below a type extends, whether a method reference names a method, the
types below a type, a type by qualified name or package, and the types of a file. The last two already end in recorded
questions; the first four scan every tree or every type.

| Option | Verdict |
|---|---|
| Keep the whole-project derivation and key it by the listing | Rejected: an edit anywhere derives every site |
| Record `listing()` whenever a derivation scans | Rejected: a derivation that scans is most of them, so no edit would hit |
| Replace each scan by the primitive question of the index, then read only the files it answers | Chosen |
| A second reading of the project for the recorded path beside the scans | Rejected: two readings of one fact; every other reader of the resolver would keep the scan |

## Decision

1. **The receiver methods of the sites of one file are the per-file derivation `java-receiver-sites`**, kept by
   `DerivedFacts.ofReads` and stored on disk at version 1 (ADR-0117 decision 5). Its subject is the file's path and
   content digest, the sorted places and members of the asked sites in that file, whether the build generates interfaces
   and whether the listing holds a `lombok.config`. Its value is the reading of each of those sites. The stage key of
   ADR-0031 stays: after an edit the stage runs and each file hits or derives.
2. **A global read is a question, answered through the file it names.** `provesBinding` asks `unread` and the marker
   `call-rewriting`, and confirms each file the marker `dynamic-implementation` names with the project's own resolution;
   `isReferenced(name)` asks `naming(method-reference, name)`; the types below a type are found by asking
   `naming(supertype, name)` for the type's name and then for the name of each type found, keeping those whose declared
   hierarchy holds the type; what an anonymous or local class extends is asked as `naming(unplaced-supertype, name)` and
   confirmed in the file answered, and the supertype names a placed type leaves unsettled as `naming(supertype, name)`
   confirmed in the files answered. Each file a question answers is handed out by the project, so its content is recorded
   (`file`). A type by qualified name and the packages with a declared type are the project's `typesDeclaring` and
   `declaresTypesIn`, both recorded.
3. **The resolver reads those names through one function for every reader.** `createResolver` takes the files that write a
   name as a parameter. The default builds them once per project from its declarations with the helpers that build the
   index entries, so `data-effects` and the call-site owner read the same answers as before and the scans of
   `readUnplacedBelow` and `isReferenced` are deleted. `provesBinding` over files stays for the readers that hold no
   index; the derivation answers it from the index and a test holds the two equal.
4. **No memo is shared between two files.** One resolver is made for each derivation, so every question an answer rests on
   is in the record of the derivation that asked it.
5. **The held project is built only by a derivation that missed.** A read in which every file of sites hits answers
   without building it.
6. **Not moved here:** parse on demand (M5), `implementedDeclarations`, `argumentCounts`, `receiverFits` and the
   dispatch readers, which keep the held project.

## Consequences

- A one-file edit derives the sites of that file and of the files whose recorded answers it changed; the others verify by
  lookups over the index. A file that appears, or a name a file starts to write, changes only the answers of the
  derivations that asked for it.
- A global veto (a call-rewriting annotation or a dynamic implementation anywhere, an unread source) changes the answer
  of every derivation that asked: all derive again, which is correct and deliberately coarse.
- The disk tier gains one entry per file of asked sites; retention is ADR-0077's.
- Changing the resolver or its questions changes the slot's pinned digest, so its version is bumped with it.
- The answers are the bytes of the whole-project reading (the corpus gate runs with `--expect none`).
