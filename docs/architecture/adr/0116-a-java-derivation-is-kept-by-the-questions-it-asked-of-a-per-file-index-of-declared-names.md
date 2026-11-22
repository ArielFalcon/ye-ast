# ADR-0116: A Java derivation is kept by the questions it asked of a per-file index of declared names and the answers it got

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-16: "este mcp ES el IDE del agente, tiene que estar pensado para aguantar ese ritmo de
  cargas muy grandes y rapidas de trabajo de forma tranquila y controlada" (this MCP is the agent's IDE; it must hold
  that pace of very large, fast loads calmly and in a controlled way); and 2026-11-17: "todo lo que queda pendiente se
  debe ir integrando a medida que se pueda, lo haces de forma autonoma" (everything pending is integrated as it can be,
  autonomously). The open questions of RFC-0039 are taken as the RFC recommends.
- Amends: [ADR-0115](0115-a-derivation-across-files-is-split-where-it-reads-one-file-and-keyed-by-the-snapshot-inputs-it-names.md)
  decision 6 and its "Not decided here" (the dependency record for the Java project),
  [ADR-0114](0114-a-per-file-derived-fact-reads-its-own-file-alone-and-a-cross-file-derivation-stays-keyed-by-what-it-reads.md)
  decision 1 (a derivation that reads other files is kept by what it read, not only by every input)
- Amended by: [ADR-0145](0145-a-kept-derivation-asks-only-the-questions-an-edit-changed-since-the-index-it-was-verified-against.md) (decision 4: a hit
  through another index asks only the recorded questions an edit changed)
- Related: [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md),
  [ADR-0035](0035-derived-facts-are-retained-by-content.md),
  [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md),
  [ADR-0031](0031-snapshot-data-is-keyed-by-the-written-files.md)

**In short:** the declared names of a Java file are a per-file derived fact (`java-declarations`); the Java project
answers the questions a derivation may ask of other files through ten primitives over the index those facts make; and a
derivation is kept by its subject and the ordered questions it asked with the answers it got
(`DerivedFacts.ofReads`), so it is reused when the same questions give the same answers and a file that appears is an
answer that changed. `relations` of the Java project is the first derivation to move onto it. No fact changes.

## Context

RFC-0039 designs the dependency record that ADR-0115 left open and measures where the three Java stages spend their
time (M0): derivation, not parse or project build. After one edit `relations` re-derives over every file (2.2 s of a
12.4 s call on the 1,340-file backend) because the project hands other files out as plain objects over syntax trees, so
no key narrower than the listing could be shown sound.

| Option | Verdict |
|---|---|
| A key made of a file's content and a digest of every file's declarations | Rejected again (ADR-0114): a body edit elsewhere can change an answer the key calls unchanged |
| Record what a derivation read, over the project as it is | Rejected (ADR-0115): a type, a method and a node hand out another file's tree without a call a recorder sees |
| Record the questions a derivation asks of an index of declared names, and hand out nothing it does not record | Chosen |

## Decision

1. **The declared names of a Java file are the per-file fact `java-declarations`** (`DerivedFacts.ofFile`, ADR-0114
   decision 1): its state (read, declarations only, unparsed, unreadable), its package and imports, each type and its
   members as plain data, and the names its bodies write that other files may ask about. It reads that file's syntax and
   nothing else, persists across processes (ADR-0077) and has a pinned reader version.
2. **The index is the merge of those facts**, answered through ten primitive questions, each answer plain and sorted:
   `file`, `declarations`, `declaring`, `package`, `named`, `naming`, `marked`, `unread`, `build`, `listing`
   (RFC-0039 section 3.2). A question that answers nothing is a question: its empty answer is recorded.
3. **The project records.** Every cross-file read of the Java project, whichever composite query makes it, ends in a
   primitive question, and a declaration of another file that the project hands out records `file` for its path. A
   memo shared between derivations keeps the reads of the computation that filled it and adds them to whoever it
   answers. A reader that has not moved to the plain handle keeps receiving the declaration with its syntax, which
   records the whole file: coarser than needed and sound.
4. **`DerivedFacts.ofReads(slot, subject, answerNow, derive)`** keeps a derivation by its subject (the file and every
   input that is not the project, named in full) and the ordered pairs of question and answer digest it recorded. It
   hits when every recorded question, asked of the current snapshot, gives the recorded answer; it derives again
   otherwise, replacing the entry (one entry per subject); it never keeps a derivation a deadline or an abort cut. The
   port names no language. The memory tier is built here; the disk tier follows.
5. **`relations` of the Java project is kept per file by `ofReads`**, over the index and the recording project. The
   stage key of ADR-0031 stays: after an edit the stage runs and each file hits or derives. A snapshot with an unread
   source answers the cuts alone, as before. The merged answer is the bytes a cold read gives.
6. **A migrated derivation calls no enumeration of every type.** A reader still on the whole listing keeps today's key.
7. **Not moved here:** `entrypoints`, `receiver-methods`, parse on demand and the disk tier of `ofReads` (RFC-0039
   M3 to M6) and the TypeScript program.

## Consequences

- A one-file edit derives `relations` for that file and for the files whose recorded answers it changed; the others
  verify by lookups over the index. The index costs one per-file derivation for each changed file and a merge for each
  read.
- Soundness rests on three conditions that tests hold: no read of another file outside the recorded questions; no state
  shared between derivations without its reads; an empty answer recorded.
- Measured through the stdio MCP on the 1,340-file backend (p50, candidate against the tree before it): the
  `relations` stage after one edit 2,319 ms to 187 ms and `callers` after one edit 12,263 ms to 9,351 ms; unchanged
  `callers` 6,885 ms to 6,301 ms; the first call of a process pays 1 s more for `relations` (2,199 ms to 3,187 ms).
- The memory tier holds 1.8 MB of declaration entries and 17.1 MB of per-file relation entries for 1,210 sources; the
  answers are the bytes a cold read gives.

## Not decided here

- The disk tier of `ofReads` and the plain handle for each remaining reader: decided by a measured hit rate (RFC-0039
  open questions 2 and 4).
