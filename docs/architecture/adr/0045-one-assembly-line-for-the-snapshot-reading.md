# ADR-0045: One assembly line builds, ahead of time and incrementally, the reading every query family consumes

- Status: Proposed
- Decision source: the owner, 2026-11-08, verbatim, on the symptom: "Vuelve el mismo patrón de que se configura un
  recursos para 2 herramientas y el resto no la usa. Por qué eso no es algo de base para todas si se supone que debería
  alimentar desde el análisis de base hasta el análisis específico de cada herramienta? Es el mismo tema que con trace
  anteriormente..."; on the decision: "Claro, debe haber una pieza que coordine como se arma la estructura base que se
  le dan a todas las hermanas. Aquí se integran todos los mecanismos que hay (grafo, syntaxcall, análisis de node
  modules) todo lo que se vaya agregando, en el mismo sitio. Todo forma parte de la cadena de ensamblaje de la fuente de
  verdad que luego consumen todas las herramientas y que pueden agregar algo que necesiten extendiéndola."; on its
  lifecycle: "No se supone que ese recurso se preconstruye para que esté listo cuando las herramientas lo pidan? Y que
  solo se cambie si cambia el código, de ser posible modular para no reconstruir todo sino lo que afecta el código
  cambiado?"
  Translated: the same pattern again, a resource configured for two tools that the rest do not use; why is it not part
  of the base for all of them, if it should feed everything from the base analysis to each tool's own analysis? It is
  the same problem trace had. There must be one piece that coordinates how the base structure handed to every sibling
  family is assembled; every mechanism there is (graph, `SyntaxCall`, the `node_modules` analysis) and everything added
  later integrates in that one place. It is all the assembly line of the source of truth that every tool then consumes,
  and that each may extend with what it needs. Is that resource not supposed to be prebuilt, so it is ready when the
  tools ask for it, and changed only when the code changes, modularly if possible, rebuilding only what the changed
  code affects?
- Related: [ADR-0011](0011-query-protocol-in-the-mvp.md), [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md),
  [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md), [ADR-0026](0026-snapshot-data-may-retain-reader-outputs.md),
  [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md) decision 11, [ADR-0031](0031-snapshot-data-is-keyed-by-the-written-files.md),
  [ADR-0035](0035-derived-facts-are-retained-by-content.md), [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0037](0037-host-declared-build-outputs.md), [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md),
  [ADR-0040](0040-a-snapshot-read-parses-each-java-source-once.md), [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0042](0042-completeness-is-relative-to-the-question.md), [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0003](../rfc/0003-codegraph-integration.md),
  [RFC-0007](../rfc/0007-extension-model.md)
- Amends: ADR-0035 decision 4 (in-flight sharing, decision 6 here); ADR-0036 decision 4 (decision 5 here); ADR-0037
  decision 10's last sentence (decision 5 here); ADR-0041 decision 1 (the owner's place and constructor, decision 1
  here). Supersedes nothing.

**In short:** every query family assembles its own reading of a snapshot: five call sites build `EdgeTargets`, each with
its own proof sources, and only `callers` and `impact` receive the type checker's bindings that ADR-0037 promised to
`importers`, `outline` and contract consequences too. One owner, `BaseReading`, in `core/application/snapshot/`,
assembles per snapshot every evidence stage in one dependency order, retains each stage by its inputs, prebuilds the
stages of the snapshot a server is bound to in the background, and rebuilds after a change only the per-file entries
whose content changed and the cross-file stages that depend on them. Families receive the assembled reading and extend
it by composition, narrowing or adding, never re-assembling nor re-binding; a fitness test keeps every stage
constructor private to the line.

## Context

### The symptom, confirmed on `main` c2861dba

| Site | Family | Proofs passed to `createEdgeTargets` | `typed` | Module readers |
|---|---|---|---|---|
| `impact-queries.ts:274` | `importers` | `SYNTAX_ONLY` | no | `deps.moduleDependencies` (TypeScript only) |
| `impact-queries.ts:561` | `callers`, `impact` | relations' fields, locals, member uses, external uses | yes | `bindingModules`: TypeScript and Java (`:148`) |
| `outline.ts:138` | `outline` focus | `SYNTAX_ONLY` | no | `combinedModuleReader(deps.moduleReaders)` (`outline-queries.ts:68`) |
| `consumer-sources.ts:107` | contract consequences | relations, extracted again, not retained (`:101`) | no | `deps.modules` (TypeScript only) |
| `trace-queries.ts:159` | `trace` | relations, lazy, retained (`:157-158`) | no | `deps.moduleDependencies` (TypeScript only) |

All confirmed by reading the lines named. The same cause produced the trace-only call reconciliation that ADR-0041
removed, and ADR-0041 itself repeats it on its branch: `createReconciledCalls` is built in `trace-walk.ts:152` and again
in `impact-queries.ts:627` (`t3/reverse-call-reconciliation`, confirmed).

### Inventory: every evidence source a family reads about a snapshot

| # | Source | Port or module | How a family obtains it today | Retention today |
|---|---|---|---|---|
| E1 | Export, sources, entrypoint findings | `HeadReader` (`head-reading.ts:91-105`), `PreparedCommit` (`read-snapshot.ts:81-101`) | `atExport`/`atSources`/`atHead`, shared | Snapshot data cache by written listing (ADR-0031) |
| E2 | Codegraph store and index summary | `HeadReading.open()` (`head-reading.ts:190`), per-user `IndexCache` | Each family opens and closes its store | Index cache by content |
| E3 | Written calls, receiver bindings, function values (`DeclaredMemberNames`, `SyntaxCall`) | `DeclaredMemberNamesReader` | `syntaxOfSources` (`edge-targets.ts:70`) in impact, outline, contracts; trace wraps it again (`declarationsOncePerFile`, `trace-queries.ts:126`) | TypeScript: per file (`ts-local-receivers`, `declared-member-names.adapter.ts:114`); Java on `main`: none, composition calls it without `facts` (`compose.ts:184`); per file on the branch (`f15b1387`) |
| E4 | Import origins, root origins, root bindings, declared types, receiver methods, dispatch targets, replaced roots | `ImportOrigins` (`import-origins.port.ts:39-106`), one per language (`compose.ts:237-238`) | Each family calls `deps.importOrigins(sources, paths?, facts)`; only trace passes `paths` (`trace-queries.ts:155`) | TypeScript per file (`import-origins.adapter.ts:56`); module resolution by layout (`module-resolver.ts:218-222`); Java receiver methods by every Java source and the sites asked (branch, `f15b1387`) |
| E5 | Module dependencies | `ModuleDependenciesReader`, TypeScript and Java (`compose.ts:234`, `:267`) | Three different selections (table above) | `retained("module-dependencies")` in impact only (`impact-queries.ts:145-146`); outline extracts per call (`outline-queries.ts:68`) |
| E6 | Relations: fields, locals, member uses, external uses, member proofs | `RelationExtractor`, `retainedRelations` (`retained-relations.ts:13`) | Impact and trace through `retainedRelations`; contracts calls `deps.relations.extract` directly (`consumer-sources.ts:101`) | Snapshot slot (ADR-0026), whole listing |
| E7 | Reference proofs of unresolved references | `unresolvedOf`, `referenceProofsOf` (`impact/reference-origins.ts:20`, `:31`) | Impact; contracts imports them from `impact/` (`consumer-sources.ts:24`) | Per read |
| E8 | Type checker bindings (ADR-0037) | `TypeBindings`, `typedReading` closure (`impact-queries.ts:163-182`) | `callers` and `impact` only | `ofInputs` per snapshot (`type-bindings.adapter.ts:142`) |
| E9 | Edge verdicts, redirects, import bindings | `EdgeTargets` (`edge-targets.ts:110`) | Five constructions | Per read |
| E10 | Receiver binder and base bindings | `CallBinder` (`call-binder.ts:97`); `CallBindings` (branch `call-binding.ts:90`), both built inside `EdgeTargets` | Through `EdgeTargets` | Per read |
| E11 | Reconciled calls (forward) and reverse calls | `ReconciledCalls` (`reconciled-calls.ts:141`); `ReverseCalls` (branch `reverse-calls.ts:55`) | Trace on `main`; trace and impact on the branch, two constructions | Per read; ADR-0041 decision 9 deltas pending |
| E12 | Declaration uses | `createDeclarationUses` (`declaration-uses.ts`) | Outline and trace, two constructions (`outline.ts:138`, `trace-walk.ts`) | Per read |
| E13 | Framework readers: Angular declarations, dynamic loads, unmodelled constructs, declaration evidence | `AngularDeclarationReader`, `DynamicLoadReader`, `UnmodelledConstructsReader` | Impact (`impact-queries.ts:201`, `:230`, `:277`), contracts (metadata, template flow), trace page plans | Mostly `staged` readers (`compose.ts`) without retention |
| E14 | Call sites and data effects (Spring, Java) | `PlacedCallSiteReader`, `DataEffectReader` | Trace (`trace-queries.ts:165-167`), topology | Data effects `ofInputs("trace-data-effects")` in trace only |
| E15 | Java syntax trees and the Java project | `ParseHolds` (ADR-0040, `withScratch`, `read-snapshot.ts:121`; `withLiveCaptures`, `head-reading.ts:82`); `withJavaSources` (`java-project.ts:22`) | Through adapters; nine adapters each build their own `createJavaProject` per call (`java-name-bindings.adapter.ts:51`, `java-receiver-methods.ts:60`, `java-dispatch-targets.ts:63`, `java-imports.adapter.ts:43`, `java-call-sites.adapter.ts:35`, `data-effects.adapter.ts:21`, `spring-routes.adapter.ts:113`, `:142`, `spring-payload-shapes.adapter.ts:476`) | Trees per read; projects per adapter call |
| E16 | Derived facts view | `PreparedCommit.facts` (`DerivedFacts`, `derived-facts.port.ts`) | Threaded by hand into each reader call | ADR-0035 |

### Family × source matrix (`main` c2861dba)

`●` reads it, `○` could gain from it and does not read it, `·` not relevant, `2×` assembled again inside the family.

| Family | E3 syntax | E4 origins | E5 modules | E6 relations | E7 ref. proofs | E8 typed | E9 EdgeTargets | E11 reconciled | E13 framework | E14 sites/effects |
|---|---|---|---|---|---|---|---|---|---|---|
| `callers` | ● | ● | ● TS+Java | ● | ● | ● | ● | ○ (branch ●) | ● Angular, loads | · |
| `impact` | ● | ● | ● TS+Java | ● | ● | ● | ● | ○ (branch ●) | ● | · |
| `importers` | ● | ● | ● TS only, Java ○ | ○ | ○ | ○ | ● syntax only | ○ (U5) | ● loads | · |
| `outline` focus | ● | ● | ● TS+Java, not retained | ○ | ○ | ○ | ● syntax only | ○ (U5) | · | · |
| contract consequences | ● | ● | ● TS only | ● 2× (not retained) | ● (imported from `impact/`) | ○ | ● | ○ (U5) | ● Angular | · |
| `trace` | ● 2× wrapper | ● with paths | ● TS only, Java ○ | ● | ○ | ○ (excluded) | ● | ● | ● pages | ● |
| `entrypoints` (`map`) | · | · | · | · | · | · | · | · | ● extractor | · |

Where the same source is assembled twice: E3 (two memo wrappers), E5 (three selections, two retention policies), E6
(retained in two families, re-extracted in contracts), E9 (five constructions, four proof sets), E11 and E12 (two
constructions each), E15 (nine Java projects per read).

### Existing partial assemblers: can one grow into the line?

| Candidate | What it already owns | Verdict |
|---|---|---|
| `HeadReader` / `HeadReading` (`snapshot/head-reading.ts`) | The head's tree, prepared commit, selection, fact base, store opening; shared by every family | **Grows into the line's entry point**: the reading a family receives is created from a `HeadReading` |
| `PreparedCommit` (`snapshot/read-snapshot.ts:81-101`) | Per-snapshot `retained(slot)` and `facts`; the retention tiers | **Keeps retention**; the line names its slots and facts |
| `ReadScope` / `ParseHolds` (ADR-0040) | The read's lifetime and its Java trees | **The line's per-read lifetime**, reused unchanged; it is its seed, not a competitor |
| `retainedRelations` (`relations/retained-relations.ts`) | One retained key for relations across families | **Becomes a stage** of the line; its own owner stays `relations/` |
| `EdgeTargets` (`navigation/edge-targets.ts`) | Verdicts, and on the branch the binder and base bindings | **Becomes a stage**; its constructor is called only by the line |
| `compose.ts` | Builds readers per language and merges them (`memberNames`, `importOrigins`, `callSites`) | Stays composition: it builds the readers the line consumes, never the line's stages |

Reuse is enough: no new subdomain, no new port. The line is one module that names the stages the code already has, in
one order, with one retention each.

### Placement

`.dependency-cruiser.cjs:50-56` forbids a family importing another and names `application/snapshot` as the way to read a
revision; `read-snapshot.ts:19` states "every query family starts here". The rule covers `entrypoints|impact|outline|trace`
only: contracts imports `impact/reference-origins.ts` and `impact/inbound-origins.ts` (`consumer-sources.ts:22-24`),
a cross-family import the rule does not see (confirmed).

| Option | For | Against | Verdict |
|---|---|---|---|
| **`core/application/snapshot/`** | Owns the snapshot's lifetime (read scope, holds), its retention (`PreparedCommit`, derived facts) and its entry (`HeadReader`); every family already depends on it; the lifecycle (prebuilt, incremental) is a snapshot concern | Imports `navigation` and `relations`; `no-circular` (`.dependency-cruiser.cjs:8`) needs the line in its own module, never in `read-snapshot.ts`, which `relations` imports | Chosen |
| `core/application/navigation/` | Owns `EdgeTargets`, `CallBinder`, `ReconciledCalls` | Its language is what an edge or a call reaches; it would have to own relations extraction, the checker's second commit read (`createRevisionSources`), holds and retention slots, none of which is navigation vocabulary | Discarded |
| A new subdomain (`reading/`) | A name that screams the line | A single module never earns a subdomain (AGENTS.md DDD rules); `snapshot` already speaks its language | Discarded |

### Efficiency: what a warm MCP call costs today, and why

The unit is a warm stdio MCP call (owner rule, 2026-11-08). On the ADR-0041 branch at `d6027958` against `main`
c2861dba, one live server per repository, three calls per query: warm totals 20.4 → 39.0 s; `callers` +165%, `impact`
+110%, trace +5%; the largest case 1.9 → 8.1 s (measured 2026-11-08, scratch harness outside the repository). The profile
named per-call whole-snapshot derivations that were not retained: Java member names 2.7 s, Java receiver bindings 1.7 s,
Java function-value calls 1.3 s, receiver methods 1.2 s, reconciled calls 1.0 s. On `main` the cause is visible in
code: composition calls the Java member-names reader without the facts view (`compose.ts:184`, confirmed). U4c
(`f15b1387`, `1d97c274`, `750e37fc`, branch) retains them by hand.

Two lessons from ADR-0040 apply. The hold halved trace's repeat (11.0 → 5.5 s) and cut `callers` (2.8 → 1.9 s), while
per-file derived facts covered only 9% of trace's Java parses, because Java facts are cross-file (`JavaProject`): a
cross-file stage needs a per-snapshot retention, not only per-file ADR-0035 slots. And a stage added without a declared
retention silently becomes a per-call cost.

### Lifecycle today

- The stdio MCP server warms only the launch repository's live index, and only under `trusted`
  (`mcp.ts:91`, `compose.ts:275-284`); nothing of the reading is prebuilt, and under `untrusted` nothing at all.
- Retention is keyed by content: per file (ADR-0035), by named inputs, or by the whole written listing (ADR-0026 and
  ADR-0031, so one edited file misses the whole slot).
- The type checker derives the whole snapshot in one pass keyed by the snapshot's content (ADR-0037 decision 8). After
  one edit (ADR-0037, measured 2026-11-08): whole-snapshot key 3.0-4.5 s CPU; per-program key 0.43-3.7 s; per-file key
  of the importers' closure 0.35-0.53 s for a leaf and 0.66-3.0 s for a hub. A pass peaks at up to 1.46 GB (2.59 GB with
  test files) and retains 66-74 MB of heap.

## Decision

1. **One owner, `BaseReading` (working name), in `core/application/snapshot/base-reading.ts`.** It is created from a
   `HeadReading` and an opened store, per snapshot read, and answers the assembled reading a family consumes. It is the
   only caller of the constructors of every stage below: `createEdgeTargets`, `createCallBinder`, `createCallBindings`,
   `createReconciledCalls`, `createReverseCalls`, `createDeclarationUses`, `retainedRelations`, `referenceProofsOf`, the
   typed reading (moved out of `impact-queries.ts`) and `syntaxOfSources`. Each stage keeps its implementation where its
   vocabulary lives (`navigation`, `relations`, `impact/reference-origins` moved to `navigation` as shared proofs); the
   line only orders, memoizes and retains them. This amends ADR-0041 decision 1: `ReconciledCalls` is created by the line,
   not "per snapshot read as `EdgeTargets` is".
2. **Stages, in dependency order.** Each stage reads only the stages above it, and has one retention:

   | Stage | Depends on | Retention (key) | One changed file invalidates |
   |---|---|---|---|
   | B0 tree, sources, findings, store | — | Snapshot cache (written listing); index cache (content) | Store: codegraph's own sync on the live mirror, a new index per commit |
   | B1 syntax per file (E3) | B0 | Derived fact per file, both languages | That file |
   | B2 import and root origins (E4, TypeScript) | B0 | Per file; module resolution by layout (paths and JSON contents) | That file; a file added, removed or a JSON edit invalidates every resolution (`module-resolver.ts:218-221`) |
   | B3 module dependencies, every language (E5) | B0 | Snapshot slot today; per-file fact plus a join after migration L4 | Today the whole stage; after L4 that file and the join |
   | B4 relations (E6) | B0 | Snapshot slot today; per-file extraction plus a cross-file join after L4 | Today the whole stage; after L4 that file and the join |
   | B5 Java project and its readings (E4 Java, E14, E15) | B0, the read's hold | Trees and one `JavaProject` per read hold; plain outputs (member names, call sites, data effects, receiver methods by sites) as facts keyed by every Java source | Every Java fact keyed by all Java sources; one parse of that file inside the next read |
   | B6 reference proofs (E7) | B0, B2 | Per read | Recomputed per read |
   | B7 typed bindings (E8) | B0, a declared build output | ADR-0037 decision 8 (snapshot content and install records) | The whole pass of its key: 3.0-4.5 s CPU today; the per-program key is open question 3 |
   | B8 edge targets, binder, base bindings (E9, E10) | B1-B4, B6, B7, B5 through `ImportOrigins` | Per read; inputs retained above | Nothing retained |
   | B9 alignment deltas and forward calls (E11) | B1, B0 | ADR-0041 decision 9: per file content and the file's index digest | That file, and files whose index records moved |
   | B10 name index and reverse calls (E11) | B9, B8 | Per read, rebuilt from retained deltas | Rebuilt per read (cost to measure, M2) |
   | B11 framework readers (E13, E14) | B0, B4 | Per file where the reader allows, otherwise a snapshot slot | As its key states |

   Every row is confirmed against the cited code except the B10 rebuild cost and the L4 rows, which are design.
3. **Lazy and memoized by stage.** A stage runs the first time a family asks for it, once per read, and a family that
   never asks for a stage never pays it. `importers` without a call edge to judge never runs B7; an outline without a
   focus runs none of B4 to B10. A stage's memo is a promise shared by every consumer of the read.
4. **Every family receives the full reading.** The proofs B8 binds with are the same for every family: syntax,
   relations, reference proofs, typed bindings where declared, Java readings, every module reader of every language. No
   family passes its own proof set or reader selection. `importers`, `outline` and contract consequences thereby gain
   the typed bindings ADR-0037's Consequences promised and the Java module readers they lack; trace gains typed bindings
   and the Java import readers.
5. **Extension by composition: narrow or add, never re-assemble nor re-bind.** A family maps the reading through its
   own policy, a function of a stage's answer (ADR-0041 decision 6 holds). Amendments:
   - ADR-0036 decision 4 assumed `importers` and `outline` read no relations because they did not extract them. With
     the line they read the same binding; a family whose answer must stay syntax-only states it as a narrowing in its
     own policy, never by withholding inputs. Recommended: no such narrowing (open question 1).
   - ADR-0037 decision 10's last sentence ("Trace keeps ADR-0029 decision 11") becomes a narrowing: trace receives the
     typed binding as every family does; its execution policy keeps the compile-time target and refuses to run it as
     proven where the receiver is a value a provider may replace (ADR-0029 decision 11, the U3 rule), and a typed
     binding to an interface or abstract member is the start of dispatch (ADR-0044 decision 1) below it. A typed binding
     never makes trace run a body ADR-0029 decision 11 refuses, and is never excluded.
6. **Prebuilt for the bound snapshot.** A server bound to a repository prebuilds that repository's reading in the
   background after it starts, so the first tool call finds it ready:
   - the bound snapshot is the launch repository's live capture under `trusted` (extending `warmLive`) and its `HEAD`
     commit under `untrusted`;
   - B0 to B5, B9 and B11 are prebuilt always; B7 only when a build output is declared for that repository; B6, B8 and
     B10 are per read and never prebuilt;
   - a call that arrives before prebuilding ends waits on the in-flight stage, never builds it a second time. This
     amends ADR-0035 decision 4 for the line's stages only: in one process, one in-flight derivation per stage key is
     shared; a caller's abort ends its wait, never the shared derivation; a derivation that fails keeps nothing, and the
     next asker derives again;
   - a snapshot nobody prebuilt (impact's base revision, another `--revision`, a workspace's other repositories) is read
     lazily by decision 3.
7. **Incremental after a change.** Per-file stages are keyed by file content, so a change re-derives only the changed
   files; cross-file stages are invalidated only through their inputs, as the table of decision 2 states. On a live
   sync (the mirror's refresh) the server re-runs the prebuild of decision 6 for the new capture: unchanged files hit,
   changed files derive, cross-file joins rebuild. Under `untrusted`, a new commit is a new snapshot; prebuilding a moved
   `HEAD` waits for the daemon (decision 9). B7 is the honest exception: on an edit it re-derives its whole key, 3.0-4.5 s
   CPU on the measured applications; a live tree is never typed (ADR-0037 Gate), so live syncs never pay it, and a new
   commit pays it once in the background when prebuilt.
8. **A stage enters with its retention, its measurement and its fixtures, in one place.** A new mechanism (ADR-0044's
   Java closure, a future Java class-file reader under ADR-0037's build-output model, Java value flow of [RFC-0021](../rfc/0021-java-value-flow.md)) is one
   row of decision 2: its dependencies, its retention and what one changed file invalidates, one measurement stage line
   (RFC-0012), and conformance fixtures through a family's public seam (ADR-0013). A whole-snapshot derivation without a
   retention other than per read is refused at review: that is the cause of the measured 1.9× warm regression. A
   cross-file stage over Java trees keeps them in the read's hold (ADR-0040) and its plain outputs as facts keyed by all
   its inputs (ADR-0035 decision 1: never a tree or a node in the cache).
9. **Who prebuilds.** Today the stdio MCP server (`ye-ast mcp`) prebuilds its launch repository, and `ye-ast serve`
   prebuilds nothing until a host asks through the protocol (open question 4). The future daemon (ADR-0011) owns
   prebuilding for every repository it serves, schedules it on its watcher, and is the single writer of retained
   stages; the line itself does not change, only the process that calls it. One-shot CLI runs never prebuild.
10. **Fitness functions.**
    - An import test: every stage constructor named in decision 1 is imported only by `snapshot/base-reading.ts` and its
      tests.
    - `.dependency-cruiser.cjs` `one-query-family-never-imports-another` extends to every family folder
      (`contracts`, `topology`, `decisions`, `composition`), with `navigation`, `relations` and `snapshot` as shared.
    - No family's `*Deps` declares an evidence reader port (`ImportOriginsReader`, `DeclaredMemberNamesReader`,
      `ModuleDependenciesReader`, `RelationExtractor`, `TypeBindings`): composition hands them once to the line.
    - Each stage row carries a retention tier from a closed set (per file, named inputs, snapshot slot, read hold, per
      read); a test lists the per-read ones, so a new one is a reviewed diff.
11. **No answer shape changes from the line itself.** Each moved answer comes from a unit of the migration, gated with
    its stated expectations (ADR-0039).

Sketch (names indicative):

```ts
interface BaseReading {
  readonly head: HeadReading;
  syntaxOf(file: string): Promise<DeclaredMemberNames | "unread">;
  origins(): ImportOrigins;
  modules(): Promise<ModuleDependencies>;
  relations(): Promise<RelationExtraction>;
  typed(): Promise<TypedReading>;
  targets(): EdgeTargets;
  calls(): ReconciledCalls;
  reverse(): Promise<ReverseCalls>;
}
```

## Efficiency

Every figure below is a measurement to obtain on warm stdio MCP calls (M1 to M4), except those cited.

- **First call.** With prebuilding, the first `callers` on the bound snapshot pays B6, B8 and B10 only; without it, it
  pays every stage it reaches. B7 cold is 3-7 s CPU (ADR-0037), prebuilt in the background when declared.
- **Warm calls.** Every whole-snapshot stage is retained (decision 8), so a warm call pays per-read compositions over
  retained data: B6, B8, B10, and the Java parses a site reading needs inside its hold. The measured regression cannot
  recur by construction, because a per-call whole-snapshot stage is a reviewed exception, not a default.
- **Memory.** Plain data shares the cache's 32 MiB default budget (ADR-0021); no new budget without a measurement.
  Prebuilt facts the budget evicts before use are waste: M3 measures them. B7's peak (up to 1.46 GB, 2.59 GB with test
  files) is transient and retains 66-74 MB; it runs only where declared.
- **Incremental.** One edited file re-derives its B1, B2, B9 entries, the B3 and B4 joins after L4, every Java fact keyed
  by all Java sources (B5), and B7's whole key on a commit.

| # | Measure | Gate of |
|---|---|---|
| M1 | Warm MCP latency per family and query, `main` against each unit, three calls per query | Every unit; acceptance as U4c: warm `callers`/`impact` totals within +15%, no query worse than max(+30%, +100 ms) |
| M2 | Per stage: CPU, retained bytes, hits and misses per call (the measurement stage lines) | L2, L3 |
| M3 | Prebuild: time to ready, peak heap and WASM memory, retained bytes, evictions of prebuilt entries before first use | L5 |
| M4 | After one edited leaf and one edited hub file on the live mirror: CPU of the re-prebuild per stage | L4, L5 |

## Migration

Each unit is its own commit, failing fixture first, `npm run check`, and the corpus gate before `main` (ADR-0039).
ADR-0041's units U0 to U4c stay as delivered; the line takes them over by moving their construction, not their rules.

| Unit | Change | Gate expectation |
|---|---|---|
| L0 | Fitness tests of decision 10 written against today's code, listing the five `createEdgeTargets` sites and two `createReconciledCalls` sites as the frozen set that may only shrink; the cruiser rule extended | `none` |
| L1 | `BaseReading` created; `callers`, `impact` and trace read B1-B10 from it with today's proof sets kept per family (a refactor); the typed reading, reference proofs and the two `ReconciledCalls` constructions move into it; Java member names receive the facts view | `none`, answers byte-identical (ADR-0041 M6); M1 no worse |
| L2 | One proof set (decision 4): `importers`, `outline` focus and contract consequences read the line, which is ADR-0041 U5; contracts stops re-extracting relations | `importers:±`, `outline:+`, `contract-consequences:±` with a declared build output; `none` without one |
| L3 | Trace reads typed bindings and the Java module readers, narrowed by decision 5 | `trace:±` with a declared build output; `trace:+` on Java import redirects |
| L4 | B3 and B4 split into per-file facts and a join | `none`; M2 and M4 |
| L5 | Prebuilding (decision 6) in the stdio MCP server and incremental re-prebuild on live sync | `none` in answers; M1 first-call and M3 |
| L6 | ADR-0041 U6 (`contradicted` pruning in the reverse families) lands as a stage policy of the line | As ADR-0041 states |

The remaining ADR-0041 work tracked outside the repository as T5b and T8 maps onto L2 and L6 when it is the U5 and U6
scope; its exact content is not recorded in the repository (hypothesis to confirm with the lead).

## Alternatives

| Option | For | Against | Verdict |
|---|---|---|---|
| **One line, lazy stages, prebuilt for the bound snapshot, costly stages only when declared** | One owner; no family pays what it does not ask for; first call ready; B7's memory paid only on opt-in | Prebuild logic in the server; in-flight sharing amends ADR-0035 decision 4 | Chosen |
| Keep per-family wiring, add fitness tests only | Smallest change; no move | Tests can freeze the sites but cannot make five assemblies agree on proofs; each new mechanism is wired again per family, the owner's exact complaint | Discarded |
| Line, lazy only, no prebuilding | Simpler; no background work | First call pays every cold stage; the owner asked for a prebuilt resource | Discarded as the final state; it is L1 to L4 |
| Prebuild everything, B7 included, always | Every first call warm | Up to 1.46 GB peak and 3-7 s CPU per repository whether or not a build output is declared or any family uses it; B7 has no input without a declaration | Discarded |
| Prebuild at indexing and persist with the kept index | Survives processes; one-shot CLI benefits | Bindings depend on request inputs (build outputs, scope, trust); persisting is ADR-0041 open question 1 | Deferred to that question |
| Pipeline framework with configured stages | Explicit stages | Stages are per file, per read and per snapshot at once; a framework adds structure the code has nowhere else (ADR-0041 Context) | Discarded; plain memoized accessors |
| Decorator over the reader ports | No family change | Hides retention per port; cannot share proofs across ports; same reasons as ADR-0041 | Discarded |
| The line in `navigation/` | Beside `EdgeTargets` | See Placement | Discarded |

## Consequences

- Every family binds with the same proofs; a dependence `callers` proves is the input of every other family's policy.
- A new mechanism is one stage row, one retention, one measurement, one fixture set; no family changes to receive it.
- `importers`, `outline` and contract consequences answer `build-output` cuts and `inputs.buildOutputs` where a build
  output is declared, as `callers` does.
- The stdio MCP server does background work after start; a host that wants none sets no build output and receives only
  the always-prebuilt stages (open question 4 offers a switch).
- The trace-only and two-tool patterns become detectable: a second construction of a stage fails the import test.

## Risks

- **A large move.** Mitigated by L1 as a byte-identical refactor before any proof set changes.
- **Noise from the wider proof set.** L2 and L3 move answers; each moved answer is inspected (ADR-0039), and ADR-0041
  decision 8's attribution rule holds.
- **Prebuild contends with a first call.** Shared in-flight stages remove double work; the call still waits for the
  stage it needs. M3 measures time to ready.
- **Cache pressure.** Prebuilt plain data may evict snapshot entries; M3, with no new budget until measured.
- **Java cross-file stages.** Facts keyed by every Java source miss on any Java edit; a per-file Java declarations fact
  that rebuilds the project without trees is open question 2.

## Not decided here

1. **Should any family stay syntax-only (ADR-0036 decision 4)?** Recommended: no. Its reason was that those families did
   not extract relations; with retained stages the cost is a hit warm, and one call has one binding in every family
   (ADR-0041 Consequences). Decided on L2's moved answers.
2. **A plain per-file Java declarations fact?** Recommended: measure on L4 (M4) whether rebuilding `JavaProject` from a
   per-file plain projection of `describeFile` is cheaper than re-parsing every Java source after one edit; until then
   Java facts stay keyed by every Java source.
3. **B7 per program or per file closure?** Recommended: the per-program key (ADR-0037 measured 0.43-3.7 s after one
   edit against 3.0-4.5 s whole-snapshot), decided after L5 on M4; the per-file closure stays rejected for hubs (3.0 s).
4. **Prebuilding in `ye-ast serve` and a switch.** Recommended: `serve` prebuilds only on a host's request through the
   protocol; the MCP server prebuilds by default with no switch until a host shows the need.
5. **Prebuilding a moved `HEAD` under `untrusted` before the daemon.** Recommended: no; a request on a new commit reads
   lazily, and the daemon's watcher takes it (decision 9).
6. **Prebuilding a workspace's other repositories.** Recommended: no until M3 shows the memory of one repository fits
   with room; the launch repository only.
