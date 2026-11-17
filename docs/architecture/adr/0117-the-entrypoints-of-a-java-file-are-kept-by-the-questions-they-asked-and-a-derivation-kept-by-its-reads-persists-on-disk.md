# ADR-0117: The entrypoints of a Java file are kept by the questions they asked, and a derivation kept by its reads persists on disk

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-16: "este mcp ES el IDE del agente, tiene que estar pensado para aguantar ese ritmo de
  cargas muy grandes y rapidas de trabajo de forma tranquila y controlada" (this MCP is the agent's IDE; it must hold
  that pace of very large, fast loads calmly and in a controlled way); and 2026-11-17: "todo lo que queda pendiente se
  debe ir integrando a medida que se pueda, lo haces de forma autonoma" (everything pending is integrated as it can be,
  autonomously). RFC-0039 M3 and M6 are taken as the RFC recommends.
- Amends: [ADR-0116](0116-a-java-derivation-is-kept-by-the-questions-it-asked-of-a-per-file-index-of-declared-names.md)
  decisions 4 (the disk tier "follows") and 7 (`entrypoints` and the disk tier are "not moved here")
- Related: [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md),
  [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md),
  [ADR-0031](0031-snapshot-data-is-keyed-by-the-written-files.md),
  [ADR-0040](0040-a-snapshot-read-parses-each-java-source-once.md)

**In short:** the Spring entrypoints of a Java file become a per-file derivation kept by `DerivedFacts.ofReads` over
the held project the read already builds, so a one-file edit derives one file and no longer parses every source a
second time; and the entries of `ofReads` reach the disk tier of ADR-0077, so a fresh process with a warm cache
verifies them instead of deriving them. No fact changes.

## Context

ADR-0116 moved `relations` onto recorded reads and measured a one-edit stage of 187 ms against 2,319 ms. Two costs are
left that RFC-0039 names. After one edit `entrypoints` still takes 1,746 ms: `extractRoutes` builds its own project
(`spring-routes.adapter.ts`) and derives every type, every NATS listener and every configuration walk again. And the
first `relations` of a process pays 3.2 s where it paid 2.2 s, because its per-file entries live only in memory.

Measured by CPU profile of `extractRoutes` over the 1,340-file backend (1,229 sources, in process, per call):

| Part | ms |
|---|---|
| parse of every source (the read's hold shares it when sources are kept) | 401 |
| `findingsOfType`, per type | 355 |
| `natsListeners`, per class | 306 |
| `readHierarchy` over every declaration, then `callbacksOf` | 232 + 46 |
| `basePathConfigurations`, per file and type | 139 |
| `pathPrefixConfigurations`, per file and type | 79 |
| `createJavaProject` | 64 |
| `applicationModules` | 3 |

| Option | Verdict |
|---|---|
| Keep the whole stage by a narrower key | Rejected again (ADR-0114, ADR-0116): a body edit elsewhere can change an answer the key calls unchanged |
| Per file for every part, `readHierarchy` and `callbacksOf` included | Rejected here: they walk every declaration and close the supertype graph over the repository; recording them is the per-file hierarchy of RFC-0039 M4 and a design of its own |
| Per file for the parts that read a type, and the callback walk derived at each run of the stage | Chosen |
| Persist `ofReads` entries on disk now | Chosen: the entries are per file, plain JSON and compared by their recorded questions |

## Decision

1. **The entrypoints of a Java source are the per-file derivation `java-entrypoints`**, kept by `DerivedFacts.ofReads`:
   the findings of its types, those of its NATS listeners, the places in it that may set a path prefix or a base path,
   and the resource folders its application classes name. Its subject is the file's path and content digest and one
   digest of every input that is not the Java project, named in full: the configuration files, the contract
   operations and the generator the build files state. Every read of another file goes through the recording project
   (ADR-0116 decision 3); the derivation of one file shares no memo with another.
2. **The merge is the one place that is global.** It orders the per-file findings as one reading of the project does,
   adds the base path of each route from the configuration, the unknown routes a path prefix leaves, and the callbacks
   (`readHierarchy`, `callbacksOf`), which are derived each time the stage runs over the held project: they enumerate
   every declaration and are the one part still keyed by the whole stage (ADR-0116 decision 6).
3. **A source that does not read in full answers from the declaration index alone**: its unreadable finding is what its
   own content states, so a file that does not parse derives nothing and builds no project.
4. **The held project is the read's.** The extractor receives the read's parse hold and derived facts as options of
   `extract`; the snapshot readers pass them. With the hold alone it derives each file over the held project and keeps
   nothing; with neither, or with libraries, it reads as before. All three give one answer.
5. **The entries of `ofReads` persist** for a slot the stored versions name (ADR-0077 decision 7): the value and its
   recorded questions are written under the slot, its reader version and the subject. A stored entry is read when the
   memory tier misses and is used only when every recorded question, asked of the current snapshot, gives the recorded
   answer; otherwise the derivation runs again and replaces it. A reader version bump discards every entry of the slot.
   `java-relations` and `java-entrypoints` are stored at version 1.
6. **The `map` family keeps the memory tier only.** `map` builds no index and never touches the cache directory; it reads
   its entrypoints over the same held project and keeps what it derives in memory, as before.
7. **Not moved here:** `receiver-methods` (RFC-0039 M4), parse on demand (M5), the callback walk per file, and the
   lookup of a configuration property as a recorded question: an edit to a configuration file derives every file.

## Consequences

- A one-file edit derives the entrypoints of that file and of the files whose recorded answers it changed; the others
  verify by lookups. A read that finds nothing changed in Java derives none and parses nothing for this stage.
- The callback walk stays at about 0.3 s per run of the stage until M4 gives it a per-file form.
- Disk use grows by one entry per Java file for each of the two slots; retention is ADR-0077's.
- A stored entry cannot go stale against another file: its recorded answers are compared on every read. It can only go
  stale against the reader's own code, which the slot version and its pin guard (ADR-0077 consequences).

## Not decided here

- `receiver-methods` per file of sites, with `provesBinding`, `unplacedBelow` and `isReferenced` as recorded queries
  (RFC-0039 M4), and whether M5 is built once the numbers of M3 are in.
