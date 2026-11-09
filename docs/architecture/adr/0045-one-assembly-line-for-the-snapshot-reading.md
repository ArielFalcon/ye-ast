# ADR-0045: One assembly line builds, ahead of time and incrementally, the reading every query family consumes

- Status: Accepted, 2026-11-09. The owner accepted it after an independent review and its recheck, verbatim:
  "Apruebo". The ADR-0041 U4c result (warm acceptance M1) is the prerequisite of L1.
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
  On its split by language, 2026-11-09, verbatim: "Es viable que este mecanismo del ADR 0045 de ensamblaje tenga una
  parte agnóstica al lenguaje que declare como es la estructura y funcionamiento y luego una implementación por cada
  lenguaje? De forma que sea extensión para cuando se agreguen más en el futuro?" Translated: is it viable for this
  assembly mechanism to have a language-agnostic part that declares its structure and how it works, and then one
  implementation per language, so that it is an extension point when more languages are added in the future?
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
constructor private to the line. The line is language-agnostic: it declares the stage contracts, their graph, lifecycle,
retention and the reconciliation and binder rules; one language pack per language implements the contracts it can,
declares the ones it cannot as absent capabilities, and supplies the language profile the base rules read, so a new
language is one pack, its profile and its fixtures, with no edit to the line (decision 12).

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
| E17 | TypeScript value flow: the consumer flow and the request origins | `ConsumerFlowReader` builds its own program (`typescript/consumer-flow.adapter.ts:15-16`, `buildProgram`); `RequestOriginReader` builds it again over the same files (`typescript/request-origins.adapter.ts:17-19`) | Contracts assembles both itself, per repository read (`consumer-sources.ts:112-113`) | Per reader: the request reader holds its program for the prepared workspace's life (`request-origins.adapter.ts:13-15`); the flow reader per call |
| E18 | Java URL flow: which methods a call may run | `methodsOf` selects constructors and methods on its own (`spring/java-method-flow.ts:73`), beside `receiverMethods` and `dispatchTargets` | Contracts and topology through the call-site flow | Per adapter call over its own `JavaProject` |
| E19 | Transversal wrappers: redaction and measurement | `redaction` at egress (AGENTS.md invariant), `measured*` and `staged` wrappers in composition (`compose.ts`, `measurement.ts`) | Every family, wrapped by composition | None: they carry no evidence |

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

### Languages today: merged by hand, checked inline

- RFC-0007 already names the plugin kinds: Language (module, statement and decision syntax, test-file rule), Framework
  and Protocol (`rfc/0007-extension-model.md:15-21`, confirmed).
- `core/domain/languages/` already holds pure per-language rules: `java.ts` (`isJavaSource`, `isJvmTestFile`),
  `typescript.ts` (`isTypeScriptSource`, `isTypeScriptFile`, `isTypeCheckerInput`, `isJsonModuleResource`, ...) and
  `call-targets.ts`, whose `runtimeOf` names the two runtimes (`call-targets.ts:5-10`), confirmed.
- Composition merges the readers of each stage by hand, each merge with its own rule: member names by concatenation
  (`compose.ts:182-195`, the merge that lost "unread" before ADR-0041 U0), trivia by set union (`compose.ts:177-178`),
  call sites by concatenation and sort (`compose.ts:197-200`), origins by "first complete answer" over every reader for
  every site (`import-origins-by-language.ts:10-36`), module statements by concatenation in `navigation/module-readers.ts`
  and by a list passed separately (`compose.ts:267`, `:304`). No merge routes a file to the reader of its language;
  every reader filters files itself (confirmed).
- An absent capability is already explicit in one place: the TypeScript origins answer `unknown` per site for
  `dispatchTargets` and `receiverMethods` (`import-origins.adapter.ts:240`, `:242`), and Java answers every `origins`
  site unresolved and replaces no root (`java-name-bindings.adapter.ts:38`, `:43`). Elsewhere absence is a missing
  reader (`unmodelled` is Java-only, `compose.ts:241`; `dynamicLoads` TypeScript-only).
- Language checks outside `domain/languages/`, non-import lines, on `main` 9e686958 (confirmed by search for
  `isJavaSource|isTypeScriptSource|isTypeScriptFile|isJvmTestFile|isTypeScriptTestFile|isJsonModuleResource|isTypeCheckerInput`):
  22 lines in 10 files.

  | File | Lines | What the check decides |
  |---|---|---|
  | `application/impact/impact-queries.ts` | 7 (`:152`, `:154`, `:258`, `:259`, `:424`, `:496`, `:497`) | Which files importers and module impact read |
  | `domain/impact/module-impact.ts` | 5 (`:13`, `:28`, `:41`, `:45`, `:55`) | Module impact is TypeScript and JSON resources |
  | `domain/map/entrypoint-map.ts` | 2 (`:39`, `:75`) | Map scope: sources and test rule |
  | `domain/change/changed-file.ts` | 2 (`:12`, `:13`) | A changed file is a source or a test |
  | `application/navigation/edge-targets.ts` | 1 (`:199`) | Structural typing: a value receiver needs settling (ADR-0029 decision 11) |
  | `application/trace/trace-walk.ts` | 1 (`:457`) | Nominal typing: Java's own members are bound by the receiver reading |
  | `application/relations/retained-relations.ts` | 1 (`:28`) | Member-proof completeness counts TypeScript sources |
  | `application/impact/inbound-origins.ts` | 1 (`:36`) | Field and local origins exist only in TypeScript |
  | `application/impact/importers.ts` | 1 (`:40`) | JSON module resources |
  | `domain/snapshot/live-export.ts` | 1 (`:25`) | The live export keeps JSON module resources |

  On the ADR-0041 branch the binder adds Java constructor chaining twice, with two copies of one constant:
  `CHAINING = ["super", "this"]` in `navigation/call-binding.ts:86` and `navigation/reverse-calls.ts:40`, the second
  behind `isJavaSource` (`:44`) (confirmed on `t3/reverse-call-reconciliation`).

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
   | B2a per-file projections of origins (E4, TypeScript): a file's module shape, its bindings and annotations | B0 | Derived fact per file (`import-origins.adapter.ts:56`) | That file |
   | B2b cross-file origin answers (E4, TypeScript): repository globals from every `.d.ts`, `declare global` and script (`import-origins.adapter.ts:130-140`); the heritage of every class for `declaredTypes` (`:243`, `subtypedTypes` `:299`); namespace members through other files' exports (`importBinding`, `:379`); module resolution by layout (`module-resolver.ts:218-221`) | B2a, B0 | A whole-snapshot key over every TypeScript path and content (plus the layout for resolution) until a narrower key is proven (decision 10) | Every B2b answer |
   | B3 module dependencies, every language (E5) | B0 | Snapshot slot today; per-file fact plus a join after migration L4 | Today the whole stage; after L4 that file and the join |
   | B4 relations (E6) | B0 | Snapshot slot today; per-file extraction plus a cross-file join after L4 | Today the whole stage; after L4 that file and the join |
   | B5 Java project and its readings (E4 Java, E14, E15, E18) | B0, the read's hold | Trees and one `JavaProject` per read hold; plain outputs (call sites, data effects, receiver methods by sites) as facts keyed by every Java source's path and content and the snapshot's whole path universe, as the branch keys receiver methods (`java: [path, content]` and `paths`, `java-receiver-methods.ts:99` on `t3/reverse-call-reconciliation`), since a new non-Java file (a `.kt`) can withdraw a proof; member names per file (B1) | Every cross-file Java fact; a file added or removed anywhere; one parse of that file inside the next read |
   | B6 reference proofs (E7) | B0, B2a, B2b | Per read | Recomputed per read |
   | B7 typed bindings (E8) | B0, a declared build output | ADR-0037 decision 8 (snapshot content and install records) | The whole pass of its key: 3.0-4.5 s CPU today; the per-program key is open question 3 |
   | B8 edge targets, binder, base bindings (E9, E10) | B1-B4, B6, B7, B5 through `ImportOrigins` | Per read; inputs retained above | Nothing retained |
   | B9 alignment deltas and forward calls (E11) | B1, B0 | ADR-0041 decision 9: per file content and the file's index digest | That file, and files whose index records moved |
   | B10a retainable reverse lookup (E11): a file's call names and its unbound reverse calls | B9 | Derived fact per file, keyed by path, content and the snapshot's index digest (U4c's final step, `reverse-calls.ts:100-126` on the branch) | That file; every file when the index digest changes |
   | B10b name index and reverse binding (E11) | B10a, B8 | Per read: the name index is assembled from B10a, and the bindings of reached declarations are bound per read | Rebuilt per read; its cost is measured (M5), not assumed small |
   | B11 framework readers (E13, E14) | B0, B4 | Per file where the reader allows, otherwise a snapshot slot | As its key states |
   | B12 TypeScript value-flow program (E17) | B0 | One program per read hold, shared by the consumer flow and the request origins; never a cache entry (it holds compiler trees, ADR-0035 decision 1) | Rebuilt in the next read |

   Every row is confirmed against the cited code except the B10b rebuild cost, the B12 sharing and the L4 rows, which
   are design. **A per-file projection and a cross-file answer are two stages, never one:** a per-file key is allowed
   only for a value derived from that file alone; every cross-file answer declares all its inputs, a whole-snapshot key
   at first.
3. **Lazy and memoized by stage.** A stage runs the first time a family asks for it, once per read, and a family that
   never asks for a stage never pays it. `importers` without a call edge to judge never runs B7; an outline without a
   focus runs none of B4 to B10b. A stage's memo is a promise shared by every consumer of the read.
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
   - ADR-0037 decision 10's last sentence ("Trace keeps ADR-0029 decision 11") becomes a narrowing, and the binding
     must carry what the narrowing reads. Today it does not: `typedVerdictOf` answers `typed` or a redirect without the
     receiver (`edge-targets.ts:179-188`), the receiver is computed only for the edges the checker left unsettled
     (`:164-170`), and trace reads the verdict's `receiver` to decide what runs (`trace-walk.ts:349` on the branch). So a
     binding states three things independently: its target, its derivation (`typed`, `proven`, `resolved`,
     `name-match`), and its receiver classification with the proofs about it (a value receiver and its root, `this`, a
     rooted chain, none; each proof link of the chain that holds). The checker sets the target and the derivation and
     never erases the receiver classification.
   - Trace expands a target only on positive execution evidence: a proof that the receiver holds that class (constructed
     there, `this`, a nominal Java receiver with its closure, ADR-0044 decision 1), never the derivation alone.
     A `typed` binding on a structural value receiver proves the dependence, not the execution: trace keeps the target
     as the compile-time declaration and states the step as unproven, as it does without the checker. The
     replaceable-provider rule (the U3 rule) is one source of that refusal, not the whole of it. A typed binding to an
     interface or abstract member is the start of dispatch below it.
   - Mandatory fixtures, through `callers` and trace: **structural parameter**, `function run(x: Service) { x.execute(); }`
     with a declared build output: `callers` of `Service.execute` lists `run`, `typed`; trace from `run` does not expand
     `Service.execute` as run. **Replaceable provider**, a component that declares
     `providers: [{ provide: Service, useClass: Other }]` and calls `inject(Service).execute()`: `callers` lists the call,
     `typed`; trace does not run `Service.execute` as proven.
6. **Prebuilt for the bound snapshot.** A server bound to a repository prebuilds that repository's reading in the
   background after it starts, so the first tool call finds it ready:
   - the bound snapshot is the launch repository's live capture under `trusted` (extending `warmLive`) and its `HEAD`
     commit under `untrusted`;
   - B0 to B5, B9, B10a and B11 are prebuilt always; B7 only when a build output is declared for that repository; B6,
     B8, B10b and B12 are per read and never prebuilt;
   - a call that arrives before prebuilding ends waits on the in-flight stage, never builds it a second time. This
     amends ADR-0035 decision 4 for the line's stages only: in one process, one in-flight derivation per stage key is
     shared; a derivation that fails keeps nothing, and the next asker derives again;
   - **a shared derivation owns its lifetime.** Today a read's resources end with its callback: `withScratch` frees the
     held trees and removes its directories when `use` returns (`read-snapshot.ts:119-134`), and the typed pass
     captures the first requester's signal (`derive(sources, outputs, signal)` inside the shared pass,
     `type-bindings.adapter.ts:142-144`), so a shared job cannot outlive the read that started it, and the first
     requester's abort cuts every waiter. A shared derivation therefore opens its own read scope and hold, its own live
     capture lease where it reads a live tree, and its own abort signal, linked only to the server's shutdown; it frees
     them when it ends, answered or failed. Waiters receive only its plain result; a waiter's abort ends its wait and
     never frees the job's resources nor aborts it;
   - **shutdown** aborts every job; an aborted job keeps nothing (ADR-0035 decision 4);
   - **identity of a live capture**: a job is keyed by the content of the capture it read (its export fingerprint),
     never by "the mirror now". A live tree is valid only while `openLive` holds its exclusive lock
     (`live-tree.ts:103-119`), so a job never re-opens a capture nor keeps the reader's lock: the job born inside a
     live read copies the plain inputs it needs (paths, contents, its export fingerprint) under that read's capture
     before it detaches, and runs on the copy. A reader that waits on the job therefore never holds a lock the job
     needs, and a later sync cannot change the job's bytes. A job whose capture a newer sync superseded is aborted when
     no waiter remains, and otherwise finishes on its copy; its per-file results stay valid for the next capture
     wherever content is unchanged. The memory of the copies is measured (M3);
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
   Existing assemblies outside the evidence stages are assigned now:
   - **The TypeScript value flow (E17)** becomes B12, one program per read hold shared by the consumer flow and the
     request origins, which build it twice today. Each keeps its own rule as a declared contracts extension: the
     carrier walk (`consumer-flow.walker.ts`) and the backward request walk (`request-origins.walker.ts`) stay
     contracts' own; their name resolution reads B2a/B2b instead of re-resolving through the program where the answers
     agree (measured by the gate, never assumed).
   - **The Java URL flow (E18)** is a declared extension of B5: its method selection (`methodsOf`,
     `java-method-flow.ts:73`) reads ADR-0044's `receiverMethods` and `dispatchTargets` once ADR-0044 V3 lands; until
     then it is listed as a second Java selector in the single-owner fitness test, frozen. Its lenient following is
     ADR-0044 decision 11's to decide, not this ADR's.
   - **Redaction and measurement (E19)** are transversal wrappers, never stages: composition wraps the families and the
     line's stages (one measurement line per stage, RFC-0012) and redaction applies at egress. Neither reads nor
     changes evidence, and no stage depends on them.
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
    - **Complete keys.** For every retained cross-file stage, a conformance test changes one file the stage does not
      own and asserts a miss where the answer depends on it: a new ambient `.d.ts` global, an edited superclass for
      `declaredTypes`, a namespace re-export, a new non-Java file for a Java proof. A narrower key than the whole
      snapshot is accepted only with such a test passing (as ADR-0041 open question 2 requires for the index digest).
    - **Warm cost.** M1 and M5 (below) gate every unit that touches a stage; the guarantee against another per-call
      whole-snapshot derivation is these tests and these measurements, not the structure alone.
11. **No answer shape changes from the line itself.** Each moved answer comes from a unit of the migration, gated with
    its stated expectations (ADR-0039).
12. **A language-agnostic line, one language pack per language.** RFC-0007's Language plugin kind becomes the pack the
    line reads.
    - **The agnostic part** declares, and no language implements: the stage contracts, which are the existing ports
      (`DeclaredMemberNamesReader`, `ImportOrigins`, `ModuleDependenciesReader`, `CallSiteReader`, `SourceTrivia`,
      `UnmodelledConstructsReader`, `TypeBindings`); the stage graph, lifecycle, retention and invalidation of decisions
      2, 3 and 6 to 8 (`snapshot/base-reading.ts`); and the alignment and binder rules of ADR-0041 (`navigation`,
      `domain/shared`). Only shapes with two implementations today are contracts; a stage only one language has
      (`TypeBindings`, `UnmodelledConstructsReader`, `DynamicLoadReader`) stays a single-language stage, and its contract
      is generalized when a second language implements it, never before.
    - **A language pack** (`core/ports/language-pack.port.ts`, a contract the core consumes; built by composition from
      that language's adapters) declares which paths it owns, implements the stage contracts it can, and declares every
      other stage as an absent capability. First, a pack wraps today's readers and the line keeps each merge's
      aggregation order and rule exactly (concatenation, set union, "first complete answer" over every reader,
      `import-origins-by-language.ts:37-39`); the merges move out of `compose.ts:177-200`, `:237-238` and
      `module-readers.ts` into the line unchanged. Routing a site to one pack is a later, optional refinement, accepted
      only where it is byte-identical. **Routing chooses who answers a site; it never narrows the evidence universe:**
      every pack reads the whole snapshot (Java proofs read the whole path universe, B5; TypeScript globals and heritage
      read every TypeScript source, B2b). A file no pack reads is `unread` (ADR-0041 decision 2), never "no call".
    - **An absent capability is a statement, never an empty result.** Where a family asserts an item an absent stage
      would decide, the line answers what the stage already answers today: `unknown` per site (the TypeScript
      `receiverMethods` and `dispatchTargets`), a `no-extractor` cut for a file no pack reads, or the cut the family's
      policy makes for an unproven link (ADR-0042 reach applies). No family tests a language to find out.
    - **A language profile** (pure data and rules in `core/domain/languages/<language>.ts`, the folder that already holds
      them) supplies what the agnostic rules read per language: the file rules (source, test, manifest, module resource),
      the runtime (`call-targets.ts`), the typing discipline (structural for TypeScript, which ADR-0029 decision 11 reads,
      nominal for Java, which `trace-walk.ts:457` reads), constructor chaining (`super` and `this` for Java; none for
      TypeScript, whose binder chaining has no rule today), and the callee spelling rules of ADR-0041 decision 3 (type
      argument syntax, argument lists). A profile states a value for every field the base reads; a field enters when a
      base rule needs it, never ahead.
    - **Frameworks are plugins over packs.** A framework plugin (RFC-0007: Angular, Spring) names the languages it reads
      and contributes framework stages through the same contracts: Angular the relations (B4) and template readers over
      the TypeScript pack, Spring the entrypoints, routes, call sites and data effects over the Java pack. A framework
      reads a pack's outputs and never implements a language stage; the frozen exception that lets `spring` read the
      Java trees (`.dependency-cruiser.cjs`, `spring-reads-only-the-java-parser`) stays, inside the Java hold.
    - **A framework owns no path and is selected by a signal, never by an extension** (the owner, 2026-11-09,
      verbatim: "Lo que si no se distingue tan fácil es el procesado cuando hayan varios framework de un lenguaje,
      porque la extensión puede ser la misma. Como se conectan en este diseño los plugins al lenguaje, soporta la
      extensión a futuro a otros plugin?"). Packs partition paths; frameworks do not. Each framework plugin declares
      the languages it reads and its applicability signal, read from the snapshot as data, on two levels: the project
      level decides whether the plugin applies at all (a dependency in the nearest manifest: a `package.json` naming
      `@angular/core`, RFC-0007 row A1; a `pom.xml` or Gradle script naming the framework's artifacts), and the file
      level decides which files it inspects (the file's own references to the framework: its imports, annotations and
      types, such as `org.springframework`). A manifest alone is too coarse (a monorepo mixes projects, and a
      dependency does not mean every file uses it); references alone cannot tell a project that lacks the dependency.
      A framework reads the pack's already parsed reading (the one hold of ADR-0040), never parses a file again. The signal is a stage input like any other,
      so its key names it (decision 10). Two frameworks may read the same file, because one file can hold facts of several (today the Spring
      reader takes HTTP routes and NATS listeners from the same classes, `spring-routes.adapter.ts:121`; a NestJS
      service holds routes and TypeORM data access): each contributes its own facts through its stages, contributions to one collection (entrypoints, call sites, relations) are a union sorted by the
      collection's own order, and two frameworks asserting different values of one fact for the same site yield an
      explicit `unknown` with both as evidence, never a choice by registration order. A second framework of a
      language enters as one plugin with its signal, its stages and its conformance fixtures, including one where it
      shares files with the first; the line, the packs and the families stay unedited.
    - **Adding a language** is one pack, one profile, its registration in composition and in the profile list of
      `domain/languages`, and the conformance fixtures of each stage it implements (ADR-0013, RFC-0007 Conformance). The
      line, `navigation` and every family stay unedited. Two limits are stated, not hidden: the index (B0) covers a
      language only where codegraph parses it (RFC-0003), and a language without it answers `no-extractor` for graph
      questions; and a profile field a new language needs that no base rule reads yet is an edit to the base rule, the
      one change this design cannot avoid.
    - **Fitness.** A test lists the language checks (`isJavaSource`, `isTypeScriptSource`, `isTypeScriptFile`,
      `isJvmTestFile`, `isTypeScriptTestFile`, `isJsonModuleResource`, `isTypeCheckerInput` and any later one exported
      by `domain/languages/`) in `core/application` and `core/domain` outside `domain/languages/`, by file and count. It
      starts as the frozen list of the Context table (22 lines, 10 files) and may only shrink; packs, profiles and
      adapters are outside it.

    | Stage | TypeScript pack | Java pack |
    |---|---|---|
    | B0 index | codegraph | codegraph |
    | B1 syntax: written calls, receiver bindings, function values | yes (`declared-member-names.adapter.ts`) | yes (`java-member-names.adapter.ts`) |
    | B2a/B2b origins, root origins, root bindings | yes (`import-origins.adapter.ts`) | root origins and bindings yes; import `origins` answered unresolved per site (`java-name-bindings.adapter.ts:38`) |
    | B2b declared types | yes (`import-origins.adapter.ts:243`) | yes (`java-declared-types.ts`) |
    | B2b receiver methods, dispatch targets | absent: `unknown` per site (`:240`, `:242`); structural typing keeps trace's R7 cut | yes (`java-receiver-methods.ts`, `java-dispatch-targets.ts`; ADR-0044) |
    | B2b replaced roots | yes | absent: none replaced (`java-name-bindings.adapter.ts:43`) |
    | B3 module statements | yes, JSON module resources included | yes (`java-imports.adapter.ts`) |
    | B4 relations (fields, locals, member proofs) | through the Angular framework plugin | absent: no Java relations reader; Java receivers settle through B2 |
    | B5 cross-file project in the read's hold | absent (B7 is TypeScript's cross-file reading) | yes (`JavaProject`, ADR-0040) |
    | B7 typed bindings over declared build outputs | yes (ADR-0037) | absent until a class-file reader (generated sources enter B5, ADR-0044 decision 13) |
    | B9 alignment | yes (base rule over B1 and B0) | yes |
    | B12 value-flow program | yes (consumer flow, request origins) | absent: the Java URL flow is B5's extension (E18) |
    | B11 trivia | yes | yes |
    | B11 call sites | yes (`http-call-sites.adapter.ts`) | yes (`java-call-sites.adapter.ts`, Spring) |
    | B11 dynamic loads | yes | absent |
    | B11 unmodelled constructs | absent | yes (records, `java-records.adapter.ts`) |
    | B11 data effects | absent | yes (Spring, `data-effects.adapter.ts`) |
    | Profile: typing, chaining, runtime | structural; none; `typescript` | nominal; `super`/`this`; `java` |

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

- **First call.** With prebuilding, the first `callers` on the bound snapshot pays B6, B8 and B10b only; without it, it
  pays every stage it reaches. B7 cold is 3-7 s CPU (ADR-0037), prebuilt in the background when declared.
- **Warm calls.** Every whole-snapshot stage is retained (decision 8), so a warm call pays per-read compositions over
  retained data: B6, B8, B10b, and the Java parses a site reading needs inside its hold. That is a design target, not a
  guarantee: B10b assembles the name index on every read (`createReverseCalls`, `reverse-calls.ts:62` on the branch), and
  retention can refuse or lose an entry: a fact larger than the budget is not admitted (`putFact`,
  `snapshot-data-cache.ts:80-85`) and any fact can be evicted by the least-recently-used order. The guarantee is the
  fitness tests of decision 10 and M1/M5 below under the real budget. U4c's result, the per-file retention of reverse
  lookups (B10a), is a prerequisite of L1.
- **Memory.** Plain data shares the cache's 32 MiB default budget (ADR-0021); no new budget without a measurement.
  Prebuilt facts the budget evicts before use are waste: M3 measures them. B7's peak (up to 1.46 GB, 2.59 GB with test
  files) is transient and retains 66-74 MB; it runs only where declared.
- **Incremental.** One edited file re-derives its B1, B2a, B9 and B10a entries, every B2b answer (whole TypeScript key),
  the B3 and B4 joins after L4, every cross-file Java fact (B5), and B7's whole key on a commit.

| # | Measure | Gate of |
|---|---|---|
| M1 | Warm MCP latency per family and query, `main` against each unit, three calls per query | Every unit; acceptance as U4c: warm `callers`/`impact` totals within +15%, no query worse than max(+30%, +100 ms) |
| M2 | Per stage: CPU, retained bytes, hits and misses per call (the measurement stage lines) | L2, L3 |
| M3 | Prebuild: time to ready, peak heap and WASM memory, retained bytes, evictions of prebuilt entries before first use | L5 |
| M4 | After one edited leaf and one edited hub file on the live mirror: CPU of the re-prebuild per stage | L4, L5 |
| M5 | Under the default 32 MiB budget, per warm call and stage: B10b rebuilds and their CPU, facts refused by `putFact`, evictions of line entries, and misses those cause | L1 and every later unit |

## Migration

Each unit is its own commit, failing fixture first, `npm run check`, and the corpus gate before `main` (ADR-0039).
ADR-0041's units U0 to U4c stay as delivered; the line takes them over by moving their construction, not their rules.
**Prerequisite of L1:** U4c finished on `t3/reverse-call-reconciliation`, its last step retaining the unbound reverse
calls per file by path, content and index digest, with its M1 acceptance met (warm `callers`/`impact` within +15%, no
query worse than max(+30%, +100 ms)).

| Unit | Change | Gate expectation |
|---|---|---|
| L0 | Fitness tests of decision 10 written against today's code, listing the five `createEdgeTargets` sites and two `createReconciledCalls` sites as the frozen set that may only shrink; the cruiser rule extended; the language-check test of decision 12 with its frozen list of 22 lines in 10 files (plus the branch's `CHAINING` sites when it lands) | `none` |
| L0 (delivered) | `src/composition/assembly-line.fitness.test.ts`: the calls of each decision-1 constructor outside `snapshot/base-reading.ts`, frozen per file (`createEdgeTargets` 5 in 4 files, `createReconciledCalls` 2, `createDeclarationUses` 3, `retainedRelations` 2, `referenceProofsOf` 3, `syntaxOfSources` 5, and the binder, bindings and reverse calls at their one site each); the language checks, 28 lines in 11 files on the branch (the 22 in 10 of the Context plus the branch's Java constructor-chaining and receiver sites in `call-binding.ts`, `edge-targets.ts`, `reverse-calls.ts` and `impact-queries.ts`); the imports from one family into another, 17 pairs in 8 files, tests included (contracts into impact and topology, decisions and topology into each other, trace into topology), which the extended cruiser rule exempts by file. `src/composition/retained-keys.test.ts`: the complete-key tests, over shared derived facts, of an ambient `.d.ts` global, a superclass edited for `declaredTypes`, a re-export behind a namespace import, and a new `.kt` for Java receiver methods | `none` |
| L1 | `BaseReading` created; `callers`, `impact` and trace read B1-B10b from it with today's proof sets kept per family (a refactor); the typed reading, reference proofs and the two `ReconciledCalls` constructions move into it; Java member names receive the facts view | `none`, answers byte-identical (ADR-0041 M6); M1 no worse |
| L1 (delivered) | `snapshot/base-reading.ts`: `createBaseReadings` per family, `of(read, selection)` per snapshot read, every stage memoized for the read. `callers`, `impact` and trace read from it syntax (B1, one read per file), import origins (B2), relations (B4), the reference proofs and the unresolved references (B6, `reference-origins.ts` moved to `navigation`), the typed reading (B7, moved out of `impact-queries.ts`), the edge targets (B8), both `ReconciledCalls` constructions with their declaration uses (B9) and the reverse calls with their retention (B10). Each family still states its proof selection (origin paths, module reader, scope), which L2 removes. Frozen lists: `createReconciledCalls`, `createReverseCalls` and `retainedRelations` leave every family; `createEdgeTargets` 3 sites (importers, outline, contracts), `createDeclarationUses` 1 (outline), `referenceProofsOf` 1 and `syntaxOfSources` 3 (importers, outline, contracts); the language checks stay 28 lines, one moved from `impact-queries.ts` into the line (the reverse lookup's readable sources, for L1b's packs); the cross-family imports 16 pairs. 72 corpus answers (`callers`, `impact`, trace, `outline`, `importers`, untrusted) byte-identical against the branch before L1; M1 +1 % over 32 warm calls, no query over max(+30 %, +100 ms); M5 over 128 warm calls: B10b rebuilt once per call at 16-58 ms CPU on the heaviest queries, no fact refused by `putFact`, no eviction, no miss | `none` |
| L1b | Language packs (decision 12): the pack port; composition builds the TypeScript and Java packs by wrapping today's readers; the line keeps every merge's aggregation order and rule as it is and the merges move out of `compose.ts`, `import-origins-by-language.ts` and `module-readers.ts`; no site routing; the profiles gain the typing discipline and constructor chaining, which replace the checks at `edge-targets.ts:199`, `trace-walk.ts:457`, `inbound-origins.ts:36` and the branch's two `CHAINING` constants; `retained-relations.ts:28` reads the Angular plugin's language. The frozen list shrinks by those sites | `none`, answers byte-identical; M1 no worse |
| L1b (delivered, wrapping) | `core/ports/language-pack.port.ts` (member names, import origins, module statements, trivia per language) and `core/domain/languages/profiles.ts` (file rules, typing discipline, constructor chaining); composition builds the TypeScript and Java packs from today's readers, and `snapshot/language-packs.ts` merges them in registration order with each merge's rule unchanged, one order test each. The typing discipline and the chaining keywords replace the checks of `edge-targets.ts`, `call-binding.ts`, `inbound-origins.ts` and `reverse-calls.ts` and both `CHAINING` constants; the relation extractor states the language it reads, which `retained-relations.ts` reads; the line's readable sources read the profile list. Language checks: 28 lines in 12 files to 18 in 6; a test forbids telling a language by its profile's name. 72 corpus answers byte-identical against L1 | `none` |
| L1b (delivered, routing) | Each site, file and source goes only to the pack whose profile reads its path (`snapshot/language-packs.ts`, `routedReaders`): a site no pack reads is `unknown` (`unresolved` for origins), a file none reads states nothing, and the sources no pack owns (manifests, configurations, declarations, test files) go to the pack that reads project files, TypeScript's; the Java pack receives only Java sources and the snapshot's whole path list, which its proofs read (decision 5). The concatenation, union, first-complete and module-list merges are gone; the families read one module reader. The extension filters of the Java readers (name bindings, root bindings, declared types, dispatch targets, receiver methods, imports, member names, trivia) and of TypeScript's member names and trivia move into the routing. TypeScript's import-origins guards stay: they also bound what it parses of the files a resolution reaches, inside its own evidence. The replaced roots stay the union of every pack's whole-snapshot answer. A test proves a site of one language reaches no other pack's reader, and one that a list of sources reaches each pack as one list: the Java readers keep what they read of a list by its identity, and a new list per call measured +41 % on warm `callers` before it was kept. 72 corpus answers byte-identical against the wrapping commit; M1 −1 % against L1 | `none` |
| L1c (optional) | File rules from the profiles: the remaining checks of the frozen list (`impact-queries.ts`, `module-impact.ts`, `entrypoint-map.ts`, `changed-file.ts`, `importers.ts`, `live-export.ts`) read the profile list of `domain/languages`; the list ends empty or with each survivor justified in the test | `none`, answers byte-identical |
| L2 | One proof set (decision 4): `importers`, `outline` focus and contract consequences read the line, which is ADR-0041 U5; contracts stops re-extracting relations | Without a build output: `importers:±` (relations and field-origin namers, ADR-0036; Java module readers), `outline:+` (ADR-0041 U5, ADR-0041 Migration), `contract-consequences:±` (relations retained, reconciled calls). With one: the same plus the checker's moves. The gate runs both ways and the report separates the moves of relations and reconciliation (without outputs) from the checker's (the difference between the two runs) |
| L3 | Bindings carry the receiver classification and proofs independently of the derivation (decision 5); trace reads typed bindings and the Java module readers and expands a target only on positive execution evidence; the structural-parameter and replaceable-provider fixtures first | Without a build output: `trace:+` on Java import redirects only. With one: `trace:±`, every move inspected; the two fixtures green; `callers`/`impact` `none` (the receiver field is added, not read by them) |
| L5a | Shared derivations own their lifetime (decision 6): the typed pass, today's only derivation shared between requests, stops capturing the first requester's signal and runs under the server's shutdown alone; a waiter's abort ends only its wait; a failed pass keeps nothing and answers every waiter | `none`; a test aborts the first waiter and asserts the second gets the answer from the one kept pass; a test where a waiter's abort ends its wait while the pass runs; a test where shutdown rejects every waiter and keeps nothing |
| L4 | B3 and B4 split into per-file facts and a join | `none`; M2 and M4 |
| L5 | Prebuilding (decision 6) in the stdio MCP server and incremental re-prebuild on live sync; a shared job's own read scope, hold and capture lease, and superseded captures. These moved from L5a: no shared derivation is born inside a live read before this prebuild (a live tree is never typed, and every live capture belongs to one operation), and the shared owner is earned with its second consumer | `none` in answers; M1 first-call and M3; a test superseding a capture with and without waiters; a test where a job born inside a live read is waited on by that reader (no deadlock) and a later sync leaves its inputs unchanged |
| L6 | ADR-0041 U6 (`contradicted` pruning in the reverse families, merged into U5 by the owner) lands as a stage policy of the line | As ADR-0041 states |

The remaining ADR-0041 work maps onto the line as follows. U5 and the typed bindings for every family are L2 and L3.
The one-owner audit follow-ups map onto L1 and L2: trace effects and seeds re-deriving call lines and body ownership
from raw index spans (`trace-effects.ts`, `seeds.ts`, `link-graph.ts`) read B-stage ownership instead; the candidate
rule divergence between `impact-cuts.ts` and `trace-walk.ts` becomes one stage rule; and the split-on-dot callee names
move to the base's `nameTail`. U6 is L6.

Cost of L1b and L1c, stated honestly (estimate, not measured): a pack port and two packs wrapping existing readers,
the merges moved as they are, two profile fields, and the inline checks rewritten: about 250 to 450 authored lines for
L1b, and 150 to 250 for the optional L1c, with no new behavior to show for it in the answers. Wrapping instead of
routing keeps each merge's rule (concatenation, union, "first complete answer"), so byte identity does not depend on
reproducing them; M6 (byte-identical answers) and the corpus gate are
the proof. L1b lands after L1 so the line already owns the construction it routes; L1c may follow any later unit.

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

Alternatives to decision 12 (language split):

| Option | For | Against | Verdict |
|---|---|---|---|
| **Agnostic line, one pack per language with capabilities, a profile per language** | A new language is a pack, a profile and fixtures; absence is explicit per stage; the hand merges and inline checks have one owner | L1b/L1c cost (about 400-700 lines, no answer moves); a pack port to keep | Chosen |
| Keep per-stage merges in composition, add the language-check fitness test only | Smallest change | Each new language edits every merge and every inline check; each merge keeps its own rule, so absence stays implicit (the U0 defect class) | Discarded |
| A plugin registry with per-language hooks into each stage (strategy per language inside the line) | One call site per decision | The line would call language code at its decision points: the inversion ADR-0041 rejected for families; profiles as data cover the same need without callbacks | Discarded |
| One pack per language with every stage contract generalized now, a third-language shape included (for example value flow or a generic project stage) | Ready for any language | Speculative: no third language, and `TypeBindings`, unmodelled constructs and dynamic loads have one implementation each; AGENTS.md "shared types are earned" | Discarded |
| **Simpler path (the reviewer's): explicit accessors on `BaseReading`, packs that first wrap today's readers keeping their aggregation order, L1c optional** | No generic stage registry; byte identity of L1b does not depend on reproducing four merge rules by routing; L1c's cost is paid only if wanted | Language checks outside packs survive until L1c; site routing deferred | Chosen as the delivery shape of decision 12: four merges with four rules exist today (Context, "Languages today"), so wrapping is the smallest change that keeps answers byte-identical |
| Frameworks as packs (Angular and Spring beside TypeScript and Java) | One kind of plugin | A framework reads a language's outputs and spans one or more languages; RFC-0007 keeps the kinds apart; Spring would duplicate the Java pack's parse | Discarded |

## Consequences

- Every family binds with the same proofs; a dependence `callers` proves is the input of every other family's policy.
- A new mechanism is one stage row, one retention, one measurement, one fixture set; no family changes to receive it.
- `importers`, `outline` and contract consequences answer `build-output` cuts and `inputs.buildOutputs` where a build
  output is declared, as `callers` does.
- The stdio MCP server does background work after start; a host that wants none sets no build output and receives only
  the always-prebuilt stages (open question 4 offers a switch).
- The trace-only and two-tool patterns become detectable: a second construction of a stage fails the import test.
- A new language is one pack, one profile and fixtures; what it cannot provide is stated per stage, so an agent sees
  `unknown` or `no-extractor` instead of silence. The capability table of decision 12 is the source of RFC-0007's
  capability matrix for languages.

## Risks

- **A large move.** Mitigated by L1 as a byte-identical refactor before any proof set changes.
- **Noise from the wider proof set.** L2 and L3 move answers; each moved answer is inspected (ADR-0039), and ADR-0041
  decision 8's attribution rule holds.
- **Prebuild contends with a first call.** Shared in-flight stages remove double work; the call still waits for the
  stage it needs. M3 measures time to ready.
- **Cache pressure.** Prebuilt plain data may evict snapshot entries; M3, with no new budget until measured.
- **Java cross-file stages.** Facts keyed by every Java source miss on any Java edit; a per-file Java declarations fact
  that rebuilds the project without trees is open question 2.
- **Routing changes a merged answer.** Today every origins reader answers every site and the first complete answer wins
  (`import-origins-by-language.ts:37-39`); routing asks only the owning pack. A site whose file one pack owns but another
  reader answered completely today would move. L1b's byte-identical gate catches it; a moved answer is a defect of the
  routing rule, not an accepted difference.
- **Ownership of a path by two packs.** Angular templates count as the TypeScript runtime (`call-targets.ts:7-10`) but are
  a framework resource; JSON module resources are TypeScript module inputs. Each path has one owner pack, and the
  framework reads the paths it names; the profile's file rules decide, and the fitness test fails on overlap.
- **Language readers outside their language's adapter folder.** Java's receiver, dispatch, declared-type and name-binding
  readers live in `core/adapters/spring/` (confirmed: `java-receiver-methods.ts`, `java-dispatch-targets.ts`,
  `java-declared-types.ts`, `java-name-bindings.adapter.ts`). Composition assembles the Java pack across folders; moving
  them is open question 7, not part of L1b.

- **Incomplete cross-file keys.** A retained cross-file answer keyed narrower than its inputs answers stale after an
  edit to another file. Mitigated by whole-snapshot keys first and the complete-key tests of decision 10.
- **Typed bindings widen trace.** Mitigated by decision 5: the receiver classification survives the checker and trace
  needs positive execution evidence; the two mandatory fixtures fail first in L3.
- **A shared job outliving its readers.** Its own scope, hold, lease and signal (decision 6); a leak shows as resources
  held after shutdown, which L5a's tests assert against.

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
7. **Move Java language readers out of `adapters/spring/`?** Recommended: yes, into `adapters/tree-sitter/` or a Java
   adapter folder, in its own refactor after L1b, gated `none`; it shrinks the `spring` cruiser exception to what Spring
   itself reads.
8. **Where the profile list lives.** Recommended: one list in `core/domain/languages/` that the domain rules read
   (`changed-file.ts`, `entrypoint-map.ts`, `module-impact.ts` are pure and cannot receive composition's packs), with
   composition building packs that name the same profile; a test fails when a pack's profile is not in the list.
