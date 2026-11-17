# ADR-0115: A derivation across files is split where it reads one file, and what it reads of the snapshot is named in its key

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-16: "este mcp ES el IDE del agente, tiene que estar pensado para aguantar ese ritmo de
  cargas muy grandes y rapidas de trabajo de forma tranquila y controlada" (this MCP is the agent's IDE; it must hold
  that pace of very large, fast loads calmly and in a controlled way); and 2026-11-17: "todo lo que queda pendiente se
  debe ir integrando a medida que se pueda, lo haces de forma autonoma" (everything pending is integrated as it can be,
  autonomously).
- Amends: [ADR-0114](0114-a-per-file-derived-fact-reads-its-own-file-alone-and-a-cross-file-derivation-stays-keyed-by-what-it-reads.md)
  ("Not decided here": the dependency record), [ADR-0031](0031-snapshot-data-is-keyed-by-the-written-files.md) (what a
  one-file edit reuses for the module statements of a TypeScript file)
- Related: [ADR-0035](0035-derived-facts-are-retained-by-content.md),
  [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md),
  [RFC-0037](../rfc/0037-persistent-derived-store.md)

**In short:** a cross-file derivation that does read one file's syntax and then combines is reused up to that seam: the
syntax is a per-file fact, and the combination is keyed by the snapshot inputs it reads, named in full. Applied to the
module statements of TypeScript files. A dependency record that names the exact files a derivation read is not built:
the derivations it was meant for (receiver resolution, relations and entrypoints over the Java project and the
TypeScript program) read other files through objects that no call records, so a record over them would be as wide as the
listing.

## Context

After one edit, measured through the stdio MCP, live, `callers` p50 on two repositories (three rounds each, the host
loaded by other sessions: read the ratios), the stages ADR-0114 left re-derived:

| Stage of a one-edit `callers` call | Java backend, 1,340 files (11.7 s) | Angular webapp, 1,173 TypeScript and JSON files (5.5 s) |
|---|---|---|
| `relations` | 2,268 ms | 1,347 ms |
| `entrypoints` | 1,751 ms | 298 ms |
| `receiver-methods` | 788 ms | not run |
| `module-dependencies` | 102 ms | 714 ms |

What each of them reads besides the file it is asked about:

| Derivation | Reads | Can the reads be recorded? |
|---|---|---|
| `module-dependencies` (TypeScript) | per file: its own syntax; per specifier: the paths the snapshot holds, the contents of its JSON files (configurations, manifests), the listing a `namesNoFile` proof scans | Yes: three named inputs and one file |
| `receiver-methods`, `relations`, `entrypoints` (Java) | the held Java project: every type by enumeration (`project.types` filtered per site, 23 uses in `java-receiver-methods.ts` alone), a name through the imports and packages of every file (`lookupType`, `bindName`, `resolveTypeName`), the hierarchy, constants and method bodies of other files, and `provesBinding`, which scans every tree | No: a type declaration, a method or a syntax node hands out another file's tree without a call a recorder could wrap, and the enumeration is every file |
| `relations` (Angular, TypeScript) | a type-checker program over every file | No: enumerates |

A dependency record needs two things: that every read of another file goes through a call the record can see, and that
"a file appeared" is covered by recording the question and its answer. The first does not hold for the Java project,
whose structures are plain objects over syntax trees. Making it hold is the redesign of the project's query surface
(name lookup, hierarchy, enumeration by file), not a seam over the readers.

| Option | Verdict |
|---|---|
| A recorder over the derivation's reads, for every cross-file derivation | Rejected now: the Java project and the TypeScript program cannot be wrapped without redesigning them; a record built over an unwrapped read would be unsound, and one built over every read is the listing |
| Key a per-file result by the file's content and a digest of every file's declarations | Rejected again (ADR-0114): a body edit elsewhere can change an answer the key calls unchanged |
| Split a derivation at the seam where it reads one file, keep each side by what it reads | Chosen |
| A per-site key for `receiver-methods` so queries share sites | Not taken: an unchanged snapshot already answers the same sites from the one kept answer, and a one-edit call misses by the layout whatever the key of a site |

## Decision

1. A derivation that reads one file's syntax and then combines it with the snapshot is split at that seam. What it
   derives from one file's syntax alone is a per-file derived fact (ADR-0114 decision 1). What it combines is read from
   inputs the key names in full.
2. The module statements of a TypeScript file are the per-file fact `ts-module-statements`: the statements, the
   dependencies and the untraversed references its syntax states. The declaration a file exports as default is the
   per-file fact `ts-default-declaration`. They read the file's syntax and no other input.
3. What the specifiers of one file resolve to is the fact `ts-module-resolutions`, per importing file. Its key names every
   input a resolution reads: the specifiers, the paths the snapshot holds, the contents of every JSON file, and the
   listing when one is given. A resolution reads no TypeScript content, so an edit to a TypeScript file keeps every
   resolution; a path that appears or disappears, a changed JSON file or a changed listing derives them again, which
   is correct and deliberately coarse.
4. The slots `ts-module-statements`, `ts-default-declaration` and `ts-module-resolutions`, and the per-file slot
   `java-receiver-bindings` that ADR-0114 left in memory, persist across processes (ADR-0077): each has a version in
   `STORED_DERIVED_FACT_VERSIONS` and a pin in `src/composition/stored-derived-facts.test.ts`.
5. `ModuleDependenciesReader.extract` takes the snapshot's derived facts as an option; a caller without them reads as
   before. The impact use case passes the facts of the snapshot it reads.
6. A cross-file derivation over the Java project or the TypeScript program stays keyed by the whole listing
   (ADR-0031). That is correct and it is the cost the Context table names; no cheaper key has been shown sound.
7. The answers are the bytes a cold read gives: a hit answers what the derivation of the same inputs answered.

## Consequences

- A one-file edit of a TypeScript file derives that file's module statements and, when it is the target of a default
  import, its default declaration; every other file and every resolution is kept. On the Angular webapp the
  `module-dependencies` stage of a one-edit `callers` call went from 714 ms to 66 ms and the call from 5.51 s to 4.73 s
  p50. A fresh process over a warm derived-fact store derives none of them from syntax: the stage went from 1,203 ms to
  333 ms and the call from 8.28 s to 6.35 s (one run each).
- The Java backend is not improved by the TypeScript split: one-edit `callers` stays 11.7 s against 12.4 s (noise), and
  `relations`, `entrypoints` and `receiver-methods` are re-derived after any edit. The persisted
  `java-receiver-bindings` takes the `receiver-methods` stage of a fresh process over a warm store from 1,320 ms to 974
  ms (one run each).
- A partial gain on the Java project does not pay: the held project, a parse of every file, is built by whichever
  reader needs it first, so the stage costs fall only when `relations`, `entrypoints`, `receiver-methods` and the
  origin readers all hit together.
- Adding or removing a file re-resolves the specifiers of every TypeScript file (decision 3), as the layout key of
  `ts-module-resolution` already did for the import-origin readers.

## Not decided here

- A dependency record for the Java project and the TypeScript program. It starts with the project's query surface: name
  lookup, hierarchy and enumeration by file as calls a recorder can wrap (and an index of the names each file declares,
  so "a file appeared" is a lookup), then the readers move onto it, `receiver-methods` first. It is a design of its own.
- The cost of the `namesNoFile` proof (`couldBeNamedBy` over the listing for each candidate, 0.8 s of the 4.5 s of a CPU profile of three
  `module-dependencies` reads over the Angular webapp): an index of the listing, not a key.
- Storing whole outputs (`relations`, `entrypoints`) in the disk tier: ADR-0077 resolved question 3 keeps answers out.
