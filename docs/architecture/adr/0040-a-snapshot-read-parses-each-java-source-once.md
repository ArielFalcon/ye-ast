# ADR-0040: A snapshot read parses each Java source once and frees its syntax trees when the read ends

- Status: Accepted, 2026-11-08, owner
- Decision source: the owner, 2026-11-08 (translated): "let's go with A", choosing the hold per snapshot read among the
  three lifetimes measured for Java syntax trees (A per snapshot read, B per query call, C per-file derived facts).
- Related: [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md),
  [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md) decision 4,
  [ADR-0035](0035-derived-facts-are-retained-by-content.md),
  [RFC-0012](../rfc/0012-observability-and-measurement.md)

**In short:** every Java reader parsed the whole Java universe of a snapshot again on every call, so one query parsed
each file between 2 and 11 times. A snapshot read now holds the trees parsed from its sources: each source is parsed
once, every reader of the read shares that tree, and the read frees them all when it ends, whether it answers or throws.

## Context

- Java readers parse per call: the cross-file readers (name bindings, root bindings, declared types, dispatch targets,
  receiver methods, imports, routes, call sites, payload shapes, the value evaluator) build one project of every Java
  source, and the per-file readers (member names, records, trivia) parse each file again. Parses per repeated query on a
  JHipster monolith: `callers` 2 per file, `impact` 3, `trace` 11, `contract_consequences` 5.
- The cross-file readers make 91 to 100% of the parses: 91% of a `trace`, 96 to 100% of `callers` and `impact`, all of
  `contract_consequences`. Their outputs depend on the whole project, so a per-file derived fact (ADR-0035) cannot
  remove them.
- Three lifetimes were measured on prototypes through the stdio MCP on 2026-11-08 (two rounds, medians, host load 20 to
  150, so CPU time rather than wall time; 368 of 368 answers byte-identical to the base). Shopizer backend, CPU ms and
  Java parses:

  | Call | Base | A: per snapshot read | B: per query call | C: per-file facts | C+B |
  |---|---|---|---|---|---|
  | `trace`, repeated | 11,023 (12,903 parses) | 5,455 (1,168) | 5,591 (1,168) | 8,749 (11,730) | 3,841 (1,168) |
  | `callers`, repeated | 2,765 | 1,912 | 1,902 | - | - |
  | `impact`, repeated | 2,937 | 1,987 | 1,988 | - | - |
  | `contract_consequences`, repeated | 5,902 | 4,680 (2,337) | 4,176 (1,169) | - | 3,997 |
  | `contract_consequences`, first | 9,416 | 8,973 | 7,560 | - | - |
  | `trace` after a Java edit, live | 11,155 | 5,698 | 5,515 | 8,402 | 3,857 |

- Peak tree-sitter WASM memory was 66.5 MB in every variant except A on calls that read two snapshots (138 MB); peak
  RSS grew about 300 MB with A or B on a repeated `trace`. C charged 15.3 MB of member names to the snapshot data cache.
  No variant evicted anything.

## Decision

1. A snapshot read holds the Java syntax trees parsed from its sources. The read scope of a read at a revision
   (`withScratch`, and the preparation an operation shares) and the live captures of a live read (`withLiveCaptures`)
   each open one hold when they start and release it when they end, whether their use answers, throws or rejects.
2. A read hands its readers its own copies of its sources, kept by its hold. A reader that parses a kept source gets
   the tree the hold parsed once, by content, so the snapshots one read scope prepares share the tree of an unchanged
   file. A reader's `dispose` of a held tree does nothing; the release frees it.
3. Holds are told apart by those copies, never by process-wide or asynchronous context: two concurrent reads, of one
   snapshot or of two, never share or free each other's trees. A source no open hold kept (a retained source of the
   cache, the copy of a released read, a source a reader writes itself) parses into a tree of its own that the reader
   frees.
4. The snapshot data cache stores the sources as read, never a kept copy and never a tree (ADR-0035 decision 1 holds).
5. Composition builds every Java parser over the holds, and an adapter neither builds a parser of its own nor parses a
   source it wrote in place; fitness tests hold both. The holds belong to one composition, with no module-level state,
   and the core reaches them through the `ParseHolds` port, which names no language.

## Discarded alternatives

- **B, one hold per query call, carried by `AsyncLocalStorage`.** The same CPU as A on calls that read one snapshot,
  and less where one call reads two (`contract_consequences`: 4,176 against 4,680 ms repeated, 7,560 against 8,973
  first). Dropped: the trees would follow implicit asynchronous context instead of the read that owns the sources, so
  their lifetime would depend on how a call is scheduled rather than on a scope the code shows.
- **C, the per-file Java outputs as ADR-0035 derived facts.** A smaller gain (`trace` 8,749 against 5,455 ms with A)
  for 15.3 MB of cache, and it cannot reach the cross-file readers that make most of the parses.
- **C+B.** The lowest CPU (`trace` 3,841 ms), at the cost of both.

## Consequences

- A query parses each Java source of a snapshot once instead of up to 11 times; the trees live as long as the read and
  no longer. Measured on the implementation (2026-11-08, two interleaved rounds against its base, host load 24 to 41
  with another corpus run alongside, 92 of 92 answers byte-identical), Shopizer backend CPU ms: `trace` repeated
  11,316 to 5,506 (12,903 to 1,168 parses), `callers` repeated 2,794 to 1,930, `impact` repeated 3,034 to 1,990, a
  live `trace` after a Java edit 11,442 to 5,716. Peak WASM memory stayed at 66.5 MB on calls that read one snapshot;
  nothing was evicted.
- `contract_consequences` gains nothing yet: its revisions are read through `RevisionSources.filesAt`, which answers the
  files after its read scope ended, so its shape readers parse outside any hold (5,865 to 5,860 parses).
- A read holds every tree it parsed until it ends instead of one reader's trees at a time: peak native memory grows
  with the Java sources of the snapshots one read scope prepares.
- A reader that copies a source before parsing it loses the hold and parses again; it stays correct, only slower.

## Not decided here

- A read scope for `RevisionSources` that lasts while the contract change reads the files, and sharing trees between the
  read scopes of one call, the B gain on `contract_consequences`.
- The per-file Java outputs as derived facts across requests (C).
