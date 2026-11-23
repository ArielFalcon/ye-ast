# ADR-0155: A Java syntax tree is shared by its holders and kept resident in the snapshot cache by its path and content

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-23 (translated): "apply all of this when the time comes; resolve the open decisions
  as you best understand them", over RFC-0040 §8 D6 ("resident trees owned per tree (path+content) with generation
  refcounts, fresh parse of changed files, byte charge incl. JS wrappers, RSS ceiling + 200-edit leak test; measure
  parse vs createJavaProject first"); and 2026-11-17: "I approve the decisions" over RFC-0040 D2 (the memory tier and
  its working-set budget). The targets it serves (translated): "Times must sit between a few hundred milliseconds and,
  for the most critical jobs, 3-5 s in specific cases; the p75 should be below 1 s", "without sacrificing functionality
  and quality".
- Amends: [ADR-0040](0040-a-snapshot-read-parses-each-java-source-once.md) decisions 2 and 3 (a tree belongs to one
  hold), [ADR-0147](0147-the-snapshot-cache-floor-is-what-each-repositorys-recent-contents-used-charged-as-decoded-heap.md)
  decision 3 (what a charge counts)
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §8 D6, unit L24

**In short:** a Java syntax tree is owned by every open read that kept a source of its path and content and, while the
snapshot cache keeps it, by the cache; it is freed once, when its last owner lets it go. A read whose snapshot is
retained keeps each tree it uses resident as a cache entry charged to the content it reads, so an edit parses only the
changed files and the trees go through ADR-0147's working-set floor like any other retained value.

## Context

After an edit every derivation that misses its kept answer builds the held Java project (`heldJavaProject`), and the
read's hold parsed every source again: the hold of ADR-0040 lives for one read, so nothing parsed by the previous
generation survives it. D6 asked to measure first how much of that build is parsing. Measured in process on the
repository's tracked Java sources (median of four rounds, Apple M1 Max):

| Repository | Files | Parse | `describeFile` | `createJavaProject` |
|---|---|---|---|---|
| shopizer/backend | 1,210 | 424 ms | 30 ms | 65 ms |
| jhipster-monolith/application | 136 | 51 ms | 3 ms | 5 ms |

Parsing is about 80 % of the build, so D6's first branch holds: trees stay resident; the project and the per-file
descriptions are still built per read (D6 keeps their per-file parts only "if the build dominates").

What a held tree costs, measured as the marginal RSS and JS heap of each further copy of a repository's trees held
alive (the first copy also grows the WASM memory once, which is never returned and is reused afterwards):

| Repository | Source bytes | RSS per source byte | JS heap per source byte |
|---|---|---|---|
| shopizer/backend | 3.49 MiB | 18.45-18.58 | 0.02-0.38 |
| jhipster-monolith/application | 0.44 MiB | 17.43-17.61 | 0.26-0.40 |
| petclinic/backend-rest | 0.31 MiB | 16.53-16.73 | 0.35-0.47 |

| Option | Verdict |
|---|---|
| Trees owned by the store generation, freed when it is retired | Rejected: a hold lives for one read and the live path has no object that outlives queries and knows its content; a second lifetime beside the snapshot cache's would need its own bound |
| Each generation charged for every tree it references | Rejected: three live contents share nearly every tree, so the floor would count them three times and hold that much more of everything else |
| Each tree a cache entry charged to the content of the read that used it last | Chosen: ADR-0147 already moves an entry's charge to the content that uses it, holds what open queries use, evicts the entries of a content that left first, and bounds the whole by the measured floor or the explicit cap |
| Incremental reparse with `tree.edit` | Rejected by D6: under 1 ms saved per file, and error recovery may differ from the cold oracle's tree |

## Decision

1. **A tree has owners** (amends ADR-0040 decisions 2 and 3). The trees of a composition are kept per path and
   content (`sourceKey`), whatever hold parsed them. Every open hold that kept a source and had it parsed owns that
   source's tree once, and the snapshot cache owns it while it keeps it resident. A hold's release and an eviction each
   give up one ownership; the tree is freed exactly once, when the last owner gives it up. Two concurrent reads may now
   share the tree of an unchanged file; neither frees it while the other holds it. A source no open hold kept still
   parses into a tree of its own that its reader frees, and two paths of one text still never share a tree.
2. **Residence.** A read whose snapshot is retained (the live capture and the revision read, where `snapshotRetention`
   exists) keeps the sources it hands to readers with the residence of that read. A tree parsed for, or reused by, such
   a source is kept resident as an entry of the snapshot data cache keyed by the composition's holds and the source's
   path and content, charged to the content of that read (ADR-0147 decisions 1 and 7). A tree already resident is
   marked used by the read, so its charge moves to the newest content that uses it and it is held while a query that
   used it is open (ADR-0121). Copies of kept sources made by the same hold carry its residence.
3. **The charge** (amends ADR-0147 decision 3). A resident tree is charged `ceil(19.1 × (UTF-8 bytes of the source's
   content + key bytes))`: the largest measured marginal RSS (18.58) plus the largest JS heap (0.47) per source byte,
   rounded up. It is a charge factor like ADR-0147's 2.1, not a size threshold: no constant decides what is kept.
4. **What is kept, and when it goes.** The cache entry holds no value, only the release of its ownership; a tree is
   never reachable from a kept value (ADR-0040 decision 4 holds). Eviction follows ADR-0147 unchanged: nothing below
   the floor, a content that left its lane first, never what the current read, the two before it or an open query used.
   An explicit `snapshotCacheBytes` counts resident trees against its cap and zero keeps none, so each read frees its
   own trees as before. Under a cap a tree takes only free room or the room of less recently used trees, and is not kept
   when even that is short: a tree never evicts a fact or a sources entry, so a cap sized for those keeps its hits
   (amended 2026-11-23 after the phase-3 review). A parse that fails keeps nothing resident. A parse is whole or absent, so a read cut by an
   abort or a deadline keeps resident only the trees it finished, which equal a cold parse of their text.
5. **Fresh parses only.** A changed file parses from its text; no tree is edited. The held project, the per-file
   descriptions and every derivation are built per read from the trees exactly as before, so no answer changes.
6. TypeScript is out (D6): its programs are built per file or group, and no stage line shows a cost there.

## Consequences

- Measured with the latency bench (`edit-now`, five repetitions, and `rss-slope` over 200 edits; medians; Apple M1
  Max, machine shared with other runs), the engine before this decision against it. `java-parse` is the tallied stage
  of every Java parse a query asked for:

| Cell, shopizer/backend right after an edit | Before: wall p50 / `java-parse` | After: wall p50 / `java-parse` |
|---|---|---|
| `callers` | 3,211 ms / 396 ms | 2,554 ms / 6 ms |
| `trace` | 4,404 ms / 390 ms | 3,778 ms / 9 ms |
| `impact` | 2,907 ms / 391 ms | 2,476 ms / 6 ms |
| `importers` | 2,270 ms / 400 ms | 1,749 ms / 6 ms |
| `outline` | 1,500 ms / 398 ms | 1,051 ms / 3 ms |
| `workspace` | 2,503 ms / 389 ms | 1,983 ms / 5 ms |
| `entrypoints` | 2,605 ms / 383 ms | 1,099 ms / 3 ms (2,667 / 385 before the live map read through a hold) |

  On jhipster-monolith/application the bench's edits leave Java parsing at 0-22 ms before and after; its `callers` and
  `trace` moved 771 → 699 and 946 → 849 ms. The live `map` now reads its capture through a parse hold like the other
  families (before it opened none, so every one of its parses was its own).
- Memory over long edit sessions. On shopizer/backend the RSS maximum over 200 edits moved 3,013 → 3,006 MB. The bench's `rss-slope` on jhipster-monolith/application (edits of one TypeScript
  file, each followed by the next family) over 600 edits, base `main` against this decision on one machine state:

| Edits | Base RSS / slope of the window before | With resident trees: RSS / slope |
|---|---|---|
| 100 | 1,108 MB / 1,893 KiB per edit | 1,139 MB / 2,491 KiB per edit |
| 200 | 1,110 MB / 30 | 1,145 MB / 48 |
| 400 | 1,007 MB / 75 | 1,048 MB / -800 |
| 600 | 1,019 MB / 28 | 1,073 MB / 124 |

  Both runs drop about 100 MB mid-session and climb back, so the windows' slopes do not settle the question alone. An
  in-process replay of the same session (300 edits, a sample every 25, after a forced collection) settles it: with
  resident trees, the live Java trees stay at 81 (191 KB of source), the tree-sitter WASM memory stays at 32 MiB from
  the first edit to the last, the JS heap at 133-134 MB and the snapshot cache at 52 MB, and RSS holds 1,077-1,088 MB
  from the 50th edit on (19 KiB per edit over the last 200). Base `main` in the same replay held 1,271-1,277 MB from
  the 50th edit, and 873-898 MB in an earlier replay: the RSS level of one process differs by hundreds of MB from run to
  run on either engine, while every quantity resident trees add stays constant. Nothing grows with the edits.
- The warm differential on petclinic/backend-rest and shopizer/backend passed 56 steps with 0 differing, on the final
  branch.
- A resident tree is charged about 67 MiB for shopizer/backend's 3.5 MiB of Java sources; the floor counts it once,
  whatever the number of contents that share it.
- Two reads that overlap share trees (decision 1): a reader never mutates a tree, and a release only gives up one
  ownership, so neither can free what the other reads.

## Not decided here

- Keeping the per-file descriptions (`describeFile`, about 30 ms on shopizer/backend) or the project's per-file parts:
  not dominant today (D6).
- A resident tree for the TypeScript compiler's documents (D6: out until a stage line shows the cost).
