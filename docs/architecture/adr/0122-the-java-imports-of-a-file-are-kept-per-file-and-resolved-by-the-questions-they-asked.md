# ADR-0122: The Java imports of a file are kept per file and resolved by the questions they asked

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-17: "sin sacrificar funcionalidad y calidad, aplicando procesos profundos de
  optimizaciones a todo lo ineficiente hoy" (no loss of functionality or quality, deep optimization of everything
  inefficient today), over RFC-0040 section 2 (M2: every Java reader parses the whole project again, per query), whose
  unit L14 names the imports of `outline`.
- Related: [ADR-0026](0026-snapshot-data-may-retain-reader-outputs.md)
  decision 4 (a focused read never shares a retained output; it keeps nothing of the universe here either),
  [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md),
  [ADR-0115](0115-a-derivation-across-files-is-split-where-it-reads-one-file-and-keyed-by-the-snapshot-inputs-it-names.md),
  [ADR-0116](0116-a-java-derivation-is-kept-by-the-questions-it-asked-of-a-per-file-index-of-declared-names.md),
  [ADR-0120](0120-the-readers-that-ask-about-one-java-declaration-are-kept-per-file-by-the-questions-they-asked.md)

**In short:** the import declarations of Java sources are two per-file derived facts. The syntax of a file (its import
declarations, plain data) is kept by its content; what each declaration resolves to is kept by `DerivedFacts.ofReads`
over the questions the resolution asked of the declaration index. A read with `facts` parses a source only when its
content changed, and builds the project only for a file whose recorded answers moved. No answer changes.

## Context

`createJavaImportsReader` memoized the parsed universe in a `WeakMap` keyed by the identity of the source list. A list
is a new array on every query, so an `outline` of one file parsed every Java source of the repository and built a
project over them: 507 to 534 ms of the 834 to 854 ms of a warm `outline` on the 1,210-file backend (RFC-0040
section 2).

An import resolves by the types the sources declare (`lookupType`), by a package a source declares (`declaresTypesIn`)
and by the platform packages a source claims (`isPlatformName`). Each is a question the declaration index answers
(RFC-0039), so the resolution is a recorded-reads derivation of one file.

## Decision

1. **Two slots, both stored on disk at version 1** (ADR-0117 decision 5): `java-import-statements`, one entry per source
   by its content (`ofFile`), and `java-import-targets`, one entry per source by its path and content digest, whose value
   is the target of each declaration, in order.
2. **The resolution reads the project and records.** On a miss the project over every parsed source answers through
   `project.reading`, so each question an answer rests on is in the record. The wildcard check asks `declaresTypesIn`,
   never a scan of the project's types, so the package question is recorded.
3. **The project is built when first asked.** A read in which every file of the selection hits builds none and parses
   only the sources whose content changed (their declarations). The project's trees are freed when the read ends.
4. **Sources not read come from the declaration index.** `unread` lists the sources that do not parse or whose
   declarations are only read (in list order), then those whose declarations cannot be listed, as the whole-list reading
   did.
5. **Without `facts`, the reading is the one it was**: the whole list parsed once for the life of the list.
6. **`outline` passes the snapshot's facts to the module reader** (`outline-queries.ts`). `importers` and `impact`
   already pass them where they have them.

## Consequences

- A warm `outline` of one Java file derives nothing and parses nothing; after an edit it parses the edited file, and
  derives again the files whose recorded answers the edit moved.
- The first read of a repository, with no declarations kept, parses each source for its declarations and, to resolve,
  once more for the project: the cost the first index already pays in the background (RFC-0040 section 1).
- The disk tier gains two entries per Java source that writes imports; retention is ADR-0077's.
- Changing the reader changes the pinned digest of its slot, and its version is bumped with it.
- The answers are the bytes of the whole-list reading (the corpus gate runs with `--expect none`).
