# ADR-0120: The readers that ask about one Java declaration are kept per file by the questions they asked

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-17: "todo lo que queda pendiente se debe ir integrando a medida que se pueda, lo haces
  de forma autonoma" (everything pending is integrated as it can be, autonomously), over RFC-0039, whose "As measured"
  section for M4 and open question 7 name `declaredSupertypes`, `implicitChains` and `argumentCounts` as the readers that
  come before M5.
- Amends: [ADR-0119](0119-the-receiver-methods-of-a-java-file-are-kept-by-the-questions-they-asked-over-the-names-the-sources-write.md)
  decision 6 (`argumentCounts` and the readers that keep the held project are "not moved here")
- Related: [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md),
  [ADR-0116](0116-a-java-derivation-is-kept-by-the-questions-it-asked-of-a-per-file-index-of-declared-names.md),
  [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md)

**In short:** the declared supertypes, the implicit constructor chains, the argument and accepted counts, the
implemented declarations and the receiver fits of Java sources are derived per file of sites, kept by
`DerivedFacts.ofReads` and stored on disk, so a read in which no recorded answer changed builds no project for them. No
fact changes.

## Context

After ADR-0119 every call of `callers` still builds the held project once (a parse of every source and a project build,
490 to 550 ms of 6.0 s unchanged and 7.5 s after one edit on the 1,340-file backend). A stack at the build shows the
first reader to ask for it is `declaredSupertypes`, which the hierarchy completion asks for every type of the
repository in every call. The readers that ask about one declaration (`declaredSupertypes`, `implicitChains`,
`argumentCounts`, `acceptedCounts`, `implementedDeclarations`, `receiverFits`) read one file and the declarations that file names; they scan the project only to
find the type or the method at a place (`project.types`, `methodsByPlace`), and for whether the strict binding proves
anything (`provesBinding`), which ADR-0119 already answers from the index.

| Option | Verdict |
|---|---|
| Keep the readers on the held project and parse on demand (M5) | Rejected: the readers that scan every type would still read every tree |
| One derivation over every site of the call | Rejected: any edit would derive them all, as before ADR-0116 |
| One derivation per file of sites, over the recording project, as ADR-0119 does for receiver methods | Chosen |

## Decision

1. **Each reader is a per-file derivation**, kept by `DerivedFacts.ofReads` and stored on disk at version 1
   (ADR-0117 decision 5): `java-declared-supertypes`, `java-implicit-chains`, `java-argument-counts`, `java-accepted-counts`, `java-implemented-declarations` and `java-receiver-fits`; the root origins of a file of sites follow the same rule under `java-root-origins` (RFC-0040 L13), and the root bindings under `java-root-bindings` (RFC-0040 L15). The subject is
   the file's path and content digest, the sorted distinct places asked of the file, and whether the build generates
   interfaces. The value is the answer for each place. The sites are asked of the file's own types and methods through
   the project (`typesOf`, a method by place), never by a scan of the project.
2. **What proves is asked of the index.** The strict binding is `provesFromIndex` of ADR-0119. The declarations reading
   of `declaredSupertypes` (every declaration read, a syntax error confined to member bodies) asks `unread` and holds
   when every unread source is read for its declarations only and no JVM source is left unread. The index holds no
   header and no type of such a source, which the project over the declarations does, so the content of each is
   asked too: an edit of it derives every file again.
3. **No memo is shared between two files.** Each derivation answers its places through one reading of the recording
   project, so every question an answer rests on is in the record of the file that asked it.
4. **The held project is built only by a derivation that missed.** A read in which every file of sites hits answers
   without building it.
5. **One declaration index per read of the snapshot.** The readers of one `ImportOrigins` share the index through the
   same function that keeps the receiver methods, so the entries `java-declarations` keeps are read once.
6. **`outsideSupertypes` is kept whole, by the listing.** It lists the supertypes outside the repository of a method's
   owner and every type below it, which reads every declaration, anonymous class and function value of the sources
   (`readHierarchy`). Its derivation, one for each set of sites, records `listing()` and `unread` (RFC-0039 P10 and P8)
   and stays in memory: an unchanged read answers it without a project, and an edit of any source derives it again, as
   today. Its per-closure form is decided by its own unit.
7. **Not moved here:** the dispatch readers, which keep the held project, and parse on demand (M5), which waits for
   them.

## Consequences

- A one-file edit derives the places of that file and of the files whose recorded answers it changed; the others
  verify by lookups over the index.
- A source that stops parsing, a call-rewriting annotation or a JVM source no extractor reads changes the answer of
  every derivation that asked: all derive again, which is correct and deliberately coarse.
- The disk tier gains one entry per file of asked sites for each slot; retention is ADR-0077's.
- Changing a reader or its questions changes the slot's pinned digest, so its version is bumped with it.
- The answers are the bytes of the whole-project reading (the corpus gate runs with `--expect none`).
