# ADR-0159: The data-effects reader keeps each file's receiver bindings by its path and content

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-17 (translated): "todo lo que queda pendiente se debe ir integrando a medida que se
  pueda, lo haces de forma autonoma" (everything pending is integrated as it can be, autonomously), over the finding
  ADR-0158 reported to its own unit. The targets it serves (translated): "Times must sit between a few hundred
  milliseconds and, for the most critical jobs, 3-5 s in specific cases; the p75 should be below 1 s", "without
  sacrificing functionality and quality".
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §6, unit L35;
  [ADR-0158](0158-the-java-call-site-readers-take-a-root-calls-methods-from-the-one-reading-of-the-calls.md);
  [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md);
  [ADR-0147](0147-the-snapshot-cache-floor-is-what-each-repositorys-recent-contents-used-charged-as-decoded-heap.md)

**In short:** after an edit, `trace` derives the data effects of the whole snapshot again, and the receiver bindings
of every Java file were a third of that work although each is a function of one file's tree. The data-effects reader
now reads them through the per-file slot the receiver-methods reader already uses, in a slot of its own, stored like
it. On the largest Java repository `data-effects` after an edit falls from about 1.5 s to about 1 s, and no fact
changes.

## Context

`trace` keeps its data effects under every source of the snapshot (`trace-data-effects`), so one edited file derives
them all again. Measured on shopizer/backend (1,210 Java files) right after an edit of one Java file, the stage is
1,492-1,558 ms; ADR-0158's profile split it as the receiver bindings ~645 ms, their resolution ~638 ms and the
syntactic invocations ~233 ms.

`javaReceiverBindings` reads one tree and its options alone: the calls of the file, its declarations and its field
modifiers. The receiver-methods reader already keeps the `declaredFields` reading per file
(`java-receiver-bindings`, stored, ADR-0077); the data-effects reader asks the `includeUnproven` reading, whose
non-private fields carry `unproven`, so it cannot share that slot.

| Part | Verdict |
|---|---|
| The receiver bindings, per file | Kept: a function of one file's path and content |
| Their resolution (`resolve`, the repository hierarchy, the MyBatis mappers) | Not kept: it reads the imports, packages and declarations of other files and the mapper XML, so an edit anywhere may change any file's answer; keeping it needs recorded questions, a cross-file invalidation this unit does not build |
| The syntactic invocations of each type | Not kept: they are syntax nodes, never a derived fact; a per-tree memory is ADR-0158's open question |

Kept in memory only, the bindings did not survive the bench's edit-now rotation: between two `trace` calls six other
families each read a new content, and ADR-0147's floor evicts first the entries last used by a content that left the
`1 + HELD_READS` recent ones, which only `trace` reads. Stored, those evictions become disk reads.

## Decision

1. **One slot per reading.** `receiverBindingsOf` takes the reading it asks; the data-effects reading is kept in
   `java-unproven-receiver-bindings`, the declared-fields reading stays in `java-receiver-bindings`.
2. **Keyed by the file.** The key is the slot, the file's path and its content (its blob when the listing names one),
   through `DerivedFacts.ofFile`; nothing else is read.
3. **Stored.** The slot persists across processes under ADR-0077 (version 1).
4. **The port carries the facts.** `DataEffectReader` moves to `core/ports` and takes the snapshot read's derived facts
   beside `between`; `trace` and live priming pass them.

## Consequences

- Measured through the stdio MCP (`main` `a08367510` against the change, median of five), one Java file edited before
  each call: on shopizer/backend `data-effects` in `trace` falls from 1,492 to 976 ms and the wall p50/p75/p95 from
  3,689/3,745/3,797 to 3,193/3,209/3,303 ms; the first call of a new process over the warm disk cache falls from 1,864 to
  1,111 ms (wall p50 5,092 -> 4,305 ms). `workspace` reads no data effects and does not move (1,902 -> 1,923 ms). On
  jhipster-monolith/application the stage is 38-56 ms either way.
- In process, a `trace` right after another `trace` and an edit: 1,495-1,520 -> 889-894 ms; with three other families
  in between, 1,552 -> 1,034 ms through the disk tier.
- The first derivation of a content writes one stored entry per Java file (about 200 ms once on shopizer/backend), and
  the cache holds about 5 MB more facts there.
- The warm differential on shopizer/backend passes, edit, revert, rename and deletion steps included.

## Not decided here

- Keeping the resolution of the bindings by the questions it asks of other files.
- A per-tree memory of the syntactic invocations (ADR-0158).
