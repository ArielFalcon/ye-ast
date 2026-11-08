# ADR-0041: Every query family reads calls from one reconciliation of the index and the syntax

- Status: Proposed, 2026-11-08
- Decision source: the owner, 2026-11-08, verbatim: "lanza un agente con esfuerzo xhigh que prepare el ADr de la
  reconciliacion general, para utilizar lo que es especifico para trace pero de forma general en la base del algoritmo,
  si trace tiene algo que se debe quedar especifico a su herramienta se deja como una extension del algoritmo base,
  usando composicion el algoritmo entrega su flujo y cada herramienta puede agregar las cosas que necesite adhoc. Este
  mecanismo que solo existe en trace de "merge" debe ser general. Que el agente revise si la estrategia que propongo de
  patron composition es la correcta y si es otra pues que lo plantee. El objetivo es tener un algoritmo que conecte de
  forma viable las dos fuentes de informacion disponibles (graph y syntaxcall) dando una estructura final con mas
  precision, enriquecida y podando los errores. Esta estructura debe ser extensible por cada herramienta segun lo
  necesite, pero debe tener de base todo lo que comparten las herramientas. Se debe tener en cuenta ademas de la
  eficacia, la eficiencia del proceos."
  Translated: prepare the ADR of the general reconciliation, so that what is specific to trace is used generally in the
  base of the algorithm; what must stay specific to trace stays as an extension of the base algorithm; by composition
  the algorithm delivers its flow and each tool adds what it needs ad hoc. The "merge" that only trace has must be
  general. Check whether the composition pattern proposed is the right one and propose another if not. The goal is an
  algorithm that viably connects the two available sources (graph and `SyntaxCall`) into a final structure that is more
  precise, enriched and pruned of errors, extensible by each tool, with everything the tools share in its base, weighing
  efficiency as well as effectiveness.
- Related: [ADR-0004](0004-codegraph-dependency-with-own-fact-layer.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md),
  [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md), [ADR-0035](0035-derived-facts-are-retained-by-content.md),
  [ADR-0036](0036-dependence-is-the-compile-time-binding.md), [ADR-0037](0037-host-declared-build-outputs.md),
  [ADR-0038](0038-evidence-composition-is-derived-in-the-core.md), [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md),
  [ADR-0040](0040-a-snapshot-read-parses-each-java-source-once.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0003](../rfc/0003-codegraph-integration.md), [RFC-0010](../rfc/0010-impact-queries.md),
  [RFC-0013](../rfc/0013-trace-and-patterns.md)

**In short:** only trace joins codegraph's records with ye-ast's own written calls; every other family lets the syntax
judge an index edge but never adds a call the index lacks, so `callers` silently misses calls codegraph does not record.
One module of the core becomes the owner of what a body calls: it aligns the index's records with the written calls
per file, binds every call to its compile-time target with one chain of proofs, and answers forward (a body's calls)
and reverse (the calls into a declaration) through a name index retained by content. Families extend it by
composition: each applies its own policy to the reconciled calls, and may narrow a binding but never re-bind one.

## Context

### One merge, in trace only

- Trace reconciles per body in `bodyOf` (`src/core/application/trace/trace-walk.ts:378-634`). It matches each index edge
  and unresolved reference to a written call by line, column and name (`matchOwnedCall`,
  `src/core/application/trace/syntax-calls.ts:48`), after placing bodies (`positionedBodies`, `:15`) and giving each
  written call its lexical owner (`callsByOwner`, `:32`). A matched record keeps the written position
  (`trace-walk.ts:397-411`); a record the body's syntax does not write becomes an `unplaced` cut (`:401`, `:409`, `:428`);
  a written call no record matches is `missing` (`:506-512`) and is settled by trace's own chain: own member, member
  proof, receiver binding, constructed, annotated and rooted origins, Java declared receivers, then `settleByName`
  with `memberDeclarations` and `mayRunDeclarationOf` (`:513-632`).
- The other families reach the syntax only through `syntaxOfSources` (`src/core/application/navigation/edge-targets.ts:78`)
  and `createEdgeTargets` (`:142`). There the syntax judges an edge the index already holds (`verdictsOf`, `:177`;
  receiver settlement, `:229-284`) and adds nothing: `callers` of `ArticlesService.getArticle` in a NgRx `signalStore`
  repository misses the call inside `const ArticleStore = signalStore(withMethods(...))`, where codegraph records no edge
  and no unresolved reference over the whole initializer (measured 2026-11-08), so the answer is silently incomplete.
- `DeclarationUses` (`src/core/application/navigation/declaration-uses.ts:17`) already claims to be "shared by every
  family that reads a body's uses", but it reads the index only.

### What was measured (11 repositories, 2026-11-08)

- Written calls codegraph records nowhere (no edge of any kind but containment and imports, no unresolved reference at
  the same place): 1,516. Only 144 name a repository declaration: 116 Java `super(...)`/`this(...)` into repository
  constructors, 19 calls inside top-level `const X = f(...)` initializers, 9 scattered. The rest are library calls
  (712 inside class-field wrappers such as `computed(() => ...)`, about 450 on receivers that are no name).
- Every record only codegraph has is a synthesized heuristic edge without a column (interface dispatch, template
  calls): the syntax readers miss no written call.
- Matching by column alone invents about 30 false gaps (two calls of one chain start at the same column); line, column
  and name together invent none.
- Parsing every source for `memberNames` costs 0.06 to 2.5 s per snapshot (1,173 Java files 2.5 s; 708 TypeScript files
  1.6 s and 154 MB of heap when every output was kept), 10 to 25% over indexing. Today `callers` and `impact` parse only
  the sources of the edges they follow, and `memberNames` is not a derived fact: the TypeScript reader retains only its
  local receivers (`src/core/adapters/typescript/declared-member-names.adapter.ts:114`), the Java reader ignores the
  view (`src/core/adapters/tree-sitter/java-member-names.adapter.ts:27`).

### Defects the code shows beyond the missing merge

- **Two binders disagree.** Trace builds `EdgeTargets` without proofs (`src/core/application/trace/trace-queries.ts:157`)
  and settles value receivers only through member proofs and syntax bindings (`trace-walk.ts:490-505`); impact passes
  field and `inject()` local origins (`src/core/application/impact/impact-queries.ts:561`). A call through an injected
  field is `proven` in `callers` and a cut in trace (observed on 2026-11-08 at a login page's `this.authService.doLogin`).
  Five call sites build `EdgeTargets` with four proof sets (`impact-queries.ts:274`, `:561`, `outline/outline.ts:138`,
  `contracts/consumer-sources.ts:107`, `trace-queries.ts:157`); ADR-0036 decision 4 justifies only the syntax-only set of
  `importers` and `outline`.
- **Coverage is lost.** Each reader answers no `calls` for a source it does not parse, but composition concatenates them
  into an array (`src/composition/compose.ts:192`), so trace's guard `syntax.calls === undefined`
  (`trace-walk.ts:387`) cannot tell an unread source from one that writes no call. RFC-0002: empty never means none.
  Whether a walk reaches a body in an unread source (a `.js` file, a TypeScript test, a Java file the parser rejects) and
  cuts all its edges as `unplaced` is a hypothesis, not measured.
- **Records without a column are cut.** A kept call edge with no column finds no written call by column, so trace sends
  it to the `unplaced` cut unless one written call of its name sits on its line (`trace-walk.ts:386-402`). Synthesized
  edges have no written call by construction.
- **Columns counted apart.** codegraph and the TypeScript compiler count columns differently past a line's first
  character outside ASCII. Trace's effects compare columns only before it (`countedAlike`,
  `src/core/application/trace/trace-effects.ts:131`); `matchOwnedCall` compares them everywhere, so such a line can yield
  a false `unplaced` and `missing` pair (hypothesis, not measured).

### Inventory: trace's reconciliation, base or trace extension

| Piece (today) | Class | Why |
|---|---|---|
| Written calls with owners and anchors (`SyntaxCall`, both readers) | Base | Already a port every family can read |
| Coverage of a source by a reader | Base | RFC-0002; every family must tell unread from empty |
| Body placement and lexical ownership (`positionedBodies`, `callsByOwner`) | Base | Who makes a call is a fact every family reports (`callers` lists the body) |
| `deferred` (a call inside a function value its body does not run) | Base attribute, family policy | Impact counts it as a dependence; trace orders and marks it (R8) |
| Matching by line, column and name, anchors, line-only rule (`matchOwnedCall`) | Base | One alignment, or families disagree on what the index recorded |
| Column comparability (`countedAlike`) | Base | Today only effects apply it |
| `unplaced` (a placed record the syntax contradicts) | Base, with the classes of decision 3 | Pruning an index error is shared; the blind cut of column-less and synthesized records is the defect above |
| `missing` (a written call no record matches) | Base | The enrichment every family lacks |
| Static binding: own member (R2), member proof (R3), receiver binding, constructed, annotated, returned (R4, R5), root origins of bare names and plain chains, Java declared receiver (R5), typed (ADR-0037) | Base | Which declaration a call binds to at compile time; `EdgeTargets.bindsClass` and `settleBound` already implement it twice |
| Candidates of an unbound call: declarations of its name the language rule admits (`mayRunDeclarationOf`), sources declaring it in a value position (`memberDeclarations`), closed world (R6) | Base | Impact and importers already apply the language rule (`unresolvedLinkCuts`, `unresolvedNamersOf`) |
| Constructor of an instantiated class (`trace-walk.ts:591-599`) | Base | Static binding of `new C(...)` |
| Nominal class required for a value receiver (ADR-0029 decision 11) | Trace extension | Execution, not dependence (ADR-0036) |
| Dispatch (`unboundDispatch`, `nominalMethod` hidden subclasses, R7, R10) | Trace extension | What runs below the static target |
| An external leaf the repository replaces (`isReplaced`) | Trace extension | Execution of a library path |
| A call that runs a field's value (`runsValue`), construction members, page order (R9) | Trace extension | Execution order and run-time values |
| Source order and folding (R8, R10), effects (R12), budget and `seen` (R11, R13) | Trace extension | Belong to the walk |

### Where the reconciliation can run

| Option | Forward (a body's calls) | Reverse (calls into a declaration) | After an edit | Verdict |
|---|---|---|---|---|
| Per body at query time, as trace does | Parses the bodies' files | Needs every file aligned and bound per query | Nothing kept | Forward only |
| Whole graph at indexing, bindings included | Free | Free | Rebuilt whole; bindings need per-request inputs (build outputs, relations, scope) unknown at indexing | Discarded |
| **Per-file alignment retained by content, binding lazy, a name index per read** | As today | First need in a read aligns every read source once per content; binds only the candidates of reached names | Only edited files align again | Chosen |
| The same, aligning only files whose text spells a reached name | As today | Cheaper cold | As above | Kept as the fallback of open question 1 |

### Pattern: composition or another

| Pattern | Shape here | For | Against | Verdict |
|---|---|---|---|---|
| **Composition: the base answers a value, a family applies its own policy** | `ReconciledCalls` answers reconciled calls with their bindings; trace, impact and the others map them through their own functions | One owner of the fact; families add what they need without the base knowing them; each part tested with fakes; laziness per access path | The base must expose the proof behind each binding so a family can narrow it | Chosen |
| Pipeline of stages | align, bind, project and family stages as a configured sequence | Explicit stages, measurable one by one | Forward work is per body and reverse work per name, so a whole-graph pipeline is eager; family stages need the walk's state (depth, `seen`); a stage framework is structure the code has nowhere else | Only as plain call order inside the base |
| Decorator over `CodeGraphReader` | A reader that also returns recovered calls as edges or unresolved references | No family changes; reverse through `incomingEdges` | The port would claim index provenance for syntax facts; binding needs per-request proofs a reader cannot take; a reader returns no cuts, so pruning would be silent; any `incomingEdges` would need every source parsed | Discarded |
| Supplement merged at indexing behind the graph port | Recovered calls written into or beside the store when it is built | Persisted with the kept index; reverse by query | Writing codegraph's store forks its data (ADR-0004, RFC-0003); bindings depend on request inputs (ADR-0037 build outputs, relations, scope, trust); mirror sync must keep it; paid by families that never need it | Discarded; persisting the alignment delta in ye-ast's own store stays open (question 1) |
| Strategy per family | The base calls family hooks at its decision points | One algorithm | The base must know every decision any family makes (dispatch, pages, leaf replacement): inversion of control, a template method in disguise | Discarded |

The owner's proposal holds, with two precisions the code forces. First, the base owns binding as well as alignment:
trace's merge is both, and two binders already disagree. Second, an extension narrows and never re-binds: a family may
refuse a binding or add facts the base does not model, so one call never has two targets in two families.

## Decision

1. **One owner.** A module of `core/application/navigation/`, working name `ReconciledCalls`, created per snapshot read
   as `EdgeTargets` is today, owns what a body calls: it aligns the index's records with the written calls and binds
   every call to its compile-time target. `EdgeTargets` becomes its component for the index's edges; the alignment of
   `syntax-calls.ts` and the static binding of `bodyOf` move into it; `DeclarationUses` is subsumed. No family aligns or
   binds calls itself, and a fitness test over imports holds it. The pure rules it shares with trace (owning body, call
   place, column comparability) move from `core/domain/trace/` to `core/domain/shared/`.
2. **Inputs and coverage.** A file's records are the edges of its declarations, every kind but containment and imports,
   and its unresolved references with retyped calls read back (`declaration-uses.ts:46`). Its written calls are
   `DeclaredMemberNames.calls`, absent when no reader parsed the file: composition keeps the absence, and absent is
   `unread`, never "no call".
3. **Alignment, per file.** Each written call gets its innermost index body by exact lexical ownership, `deferred` when a
   function value its body does not run encloses it. A record matches a written call on its line when column and name
   agree (the spelling, the callee, or an anchor the reader lists); a record without a column matches only the one
   written call of its name on its line; past a line's first character outside ASCII, columns are not compared and the
   line rule applies. Every record and written call then falls in exactly one class:

   | Class | What it is | What the base does |
   |---|---|---|
   | `matched` | A record and a written call at one place | Kept, at the written position |
   | `recovered` | A written call no record matches | Added, bound by decision 4 |
   | `synthesized` | A record whose synthesizer is set, or without a column | Kept as the index has it, never cut for want of a written call |
   | `unread` | A record of a source no reader parsed | Kept as the index has it |
   | `misowned` | A record whose written call another body owns | Moved to that body, dropped when that body holds its own record of it |
   | `contradicted` | A record with line and column, not synthesized, in a read source, matching no written call | Pruned, with one `unresolved-link` cut at its place naming its target |
   | `unowned` | A written call no single index body owns | A cut at its place wherever a family reaches its name |

   Alignment reads recorded places, never resolutions, so it depends on the file's content and its extraction only.
4. **Binding, one chain.** Every call the index left without a target (a recovered call, an unresolved reference) and
   the receiver of every kept edge are bound by one chain, in order, with the proofs the family reads: the type checker
   (ADR-0037); a member proof of the relations; the body's own member (R2); constructor chaining (`super(...)` to the
   direct superclass's constructor, `this(...)` to one of the class's own, selected by the Java signature reading R5
   uses); `new C(...)` through `C`'s origin to its constructor; the origin of a bare name (ADR-0029); the root of a plain
   chain, outside the repository when external or ambient; the receiver's type, from a field's or an `inject()` local's
   origin, the syntax's receiver binding or the Java declared receiver, to the member that type or its nearest ancestor
   declares. Otherwise the call is unbound, with candidates: the declarations of its name the language rule admits and
   the sources that declare the name in a value position; with none it is external (R6). A binding records its target,
   its derivation (ADR-0036: a recovered call is `proven` or `typed`, never `resolved`, which names the index's own
   resolution) and the link of the chain that proved it.
5. **Static binding is the base; execution is trace's.** The base answers which declaration a call binds to at compile
   time. The nominal class a value receiver needs (ADR-0029 decision 11), dispatch (R7, R10), a replaced external leaf,
   a call that runs a field's value, page order (R9), source order and folding (R8, R10), effects (R12) and the walk's
   bounds are trace's extension.
6. **Extension by composition, narrowing only.** A family composes the base's answer with its own policy, a function of a
   reconciled call and its binding; the base calls no family code. An extension may refuse a binding (the family's cut)
   or add what the base does not model (dispatch alternatives, effects, order). It never binds a call to another
   declaration, never aligns again, and a family that reads the relations hands the base all their proofs (fields,
   locals, member uses), trace included. ADR-0036 decision 4 holds: `importers` and `outline` bind by syntax alone.
7. **Forward access.** `callsOf(body)` answers a body's reconciled calls in source order, bound lazily and memoized for
   the read. It parses only the files whose bodies are asked, as today.
8. **Reverse access.** `into(nodes)` answers, for declarations a reverse walk reached, the recovered calls and unresolved
   references whose binding reaches one of them, as edges into it (the `FollowedEdge` that `typedReferencesOf`,
   `reference-origins.ts:77`, and `redirectedInto`, `edge-targets.ts:297`, already produce), and the unbound ones that
   name them as unresolved uses. It reads a name index of every read source's recovered calls and unresolved references,
   by callee name (the class name for `new`, `super` and `this` for chaining), and binds only the candidates of reached
   names. Impact and `callers` call it in `walkInside`'s fixpoint beside `redirectedInto`
   (`impact-queries.ts:619-673`): a bound call is a dependence with its derivation; an unbound one passes through
   `unresolvedLinkCuts` (`src/core/domain/impact/impact-cuts.ts:131`) as an index unresolved reference does, so it cuts
   only where its name points at a reached declaration of the same runtime.
9. **Retention by content.** A file's alignment delta (its recovered and unowned calls with their owner spans and flags,
   its `contradicted` and `misowned` places; positions and names, never node ids or trees) is an ADR-0035 derived fact
   keyed by the file's path and content. A warm name index parses nothing. Bindings live for one read.
10. **Laziness.** Nothing runs at indexing. The full alignment runs the first time a read needs the name index, inside
    the read's parse hold (ADR-0040), file by file, keeping only each delta. Forward families never trigger it.
11. **Coverage grows by reader.** Only sources a syntax reader parses (TypeScript, Java) are reconciled; others keep the
    index's records. A new language's reader brings its conformance fixtures (ADR-0013).
12. **No answer shape changes.** No field, no derivation value and no SCHEMA bump; cuts are `unresolved-link`.
13. **Accepted on measurement.** The status moves to Accepted only with the measurements below on the corpus.

Sketch of the structure (names indicative):

```ts
type CallBinding =
  | { kind: "declaration"; target: GraphSymbol; derivation: DependenceDerivation; proof: ProofLink }
  | { kind: "outside"; root: ImportOrigin }
  | { kind: "unbound"; candidates: readonly GraphSymbol[]; declaredIn: readonly string[] };

type ReconciledCall =
  | { class: "matched"; at: CallPlace; record: IndexRecord; deferred?: true; binding(): Promise<CallBinding> }
  | { class: "recovered"; at: CallPlace; written: SyntaxCall; deferred?: true; binding(): Promise<CallBinding> }
  | { class: "synthesized" | "unread"; record: IndexRecord; binding(): Promise<CallBinding> };

interface ReconciledCalls {
  callsOf(body: GraphSymbol): Promise<{ calls: readonly ReconciledCall[]; cuts: readonly Cut[] }>;
  into(nodes: readonly GraphSymbol[]): Promise<{ edges: readonly FollowedEdge[]; unbound: readonly UnresolvedUse[] }>;
}
```

| Family | Reads from the base | Its extension |
|---|---|---|
| `trace` | `callsOf`, bindings with their proof link | Execution policy of decision 5 |
| `impact`, `callers` | `into` in the fixpoint, edge verdicts, unbound uses | Dependence policy (ADR-0036), bridges, relations, importer fallback, fan-in, cuts |
| `importers` | `into` the requested files' declarations: bound calls make users, unbound ones namers | Users and namers per file |
| `outline` (focus) | `callsOf` of the focused body | Found and unproved uses |
| `contract_consequences` | `into` and the edge verdicts | Consumer frontiers |
| `entrypoints` (map) | Nothing: it reads extractors, no call (`src/core/application/entrypoints/` reads no edge) | Reached through `impact` and trace roots |

## Efficiency

- **Parse dominates.** Alignment is linear in records and written calls once a file is parsed. Forward families parse
  what they parse today. A reverse family's first need in a read parses every read source once per content: at most the
  measured 0.06 to 2.5 s, only for content not seen before, and keeping one file's delta at a time instead of every
  output (the 154 MB above were measured with every output kept; what this saves is part of M1).
- **Warm.** The deltas are small (1,516 written calls without a record over 11 repositories, all of them kept), so a warm
  name index costs lookups. Binding cost follows the candidates of reached names, not the repository.
- **Incremental.** A commit or a live sync aligns again only the files whose content changed; the name index of a read is
  rebuilt from retained deltas.
- **One-shot processes.** Derived facts live in the process (ADR-0035), so each CLI `callers` or `impact` run pays the
  cold parse; the MCP server and `serve` pay it once per content.

Measurements before acceptance, on the corpus manifest of ADR-0039:

| # | Measure | Why |
|---|---|---|
| M1 | Cold and warm cost of the full alignment per repository (CPU, peak heap, Java parses) against its indexing time | Bounds the reverse first need |
| M2 | One-shot CLI `callers` and `impact`, base against candidate, on the largest repositories | Decides open question 1 |
| M3 | Retained bytes of the deltas against the 32 MiB default budget (ADR-0021), evictions | Cache pressure |
| M4 | Per repository: `matched`, `recovered` (bound by derivation, unbound, outside), `synthesized`, `unread`, `misowned`, `contradicted`, `unowned` | Confirms "the readers miss no written call" and sizes every class |
| M5 | New cuts per corpus query in `callers`, `impact`, `outline`, `importers`, trace, each inspected | Noise: at most the 144 repository-naming calls over 11 repositories, and only where a reached name is named |
| M6 | Answers byte-identical for every refactor unit | Behavior preserved |

## Migration

Each unit is its own commit with its fixture failing first, passes `npm run check`, and passes the corpus gate before it
reaches `main` with the expectations stated (ADR-0039).

| Unit | Change | Gate expectation |
|---|---|---|
| U0 | Composition keeps `calls` absent for unread sources; the `unread` class in trace | `none` on the corpus expected; `trace:+` where a walk enters an unread source |
| U1 | Alignment moves to `ReconciledCalls`; domain rules to `core/domain/shared/`; trace reads `callsOf` | `none` (M6) |
| U2 | `synthesized`, column comparability, `misowned` and `contradicted` replace trace's blind `unplaced` | `trace:±` |
| U3 | One binder: trace's static chain and `EdgeTargets`' receiver settlement become one; trace hands over field and local origins | `trace:+`; `callers`, `impact` none |
| U4 | Name index, `into`, constructor chaining; `impact` and `callers` read it in the fixpoint | `callers:+`, `impact:+`, `±` where a scoped cut appears |
| U5 | `outline` focus, `importers` and `contract_consequences` read the base | `outline:+`, `importers:±`, `contract_consequences:±` |
| U6 | `contradicted` pruning in the reverse families | `callers:±`, `impact:±`; none expected (M4 first) |

Conformance fixtures, in the base's tests through its public seam and once per family that wires it:

1. **Constructor chaining (Java).** `class B extends A { B() { super(1); } B(String s) { this(); } }` with `A(int)` and
   `A(int, int)`: `callers` of `A(int)` lists `B()`, `callers` of `B()` lists `B(String)`, trace from `B(String)` steps
   to `B()` and then `A(int)`. With `A(String)` added, the signatures at the call's arity differ and the reading does not
   settle them, so `super(1)` is a cut listing `A(int)` and `A(String)` (R5).
2. **Call in a top-level const initializer (TypeScript).** `export const Store = signalStore(withMethods((s, api =
   inject(Api)) => ({ load: () => api.getArticle() })))`, which the index records nothing of: `callers` of
   `Api.getArticle` lists `Store` at the call's line, `proven`; trace marks the call `deferred`.
3. **Synthesized edge kept.** A call edge with a synthesizer and no column: kept, no cut, in trace and `callers`.
4. **Homonym false gap.** `this.http.get(url).pipe(map(f))`, with the index recording `pipe` only: `pipe` is `matched`,
   `get` `recovered`, nothing `contradicted`; and `a.save(); b.save();` on one line pairs each record with its own call.
5. **Unread source.** A body in a source no reader parses: its records kept, nothing recovered or contradicted.
6. **Contradicted record.** An edge placed where the source writes no call: pruned with one cut, never silent.
7. **No noise from library calls.** `x = computed(() => Math.max(a, b))` adds no cut in `callers` or `impact`.

## Consequences

- `callers` and `impact` gain the dependences codegraph does not record: on the corpus 144 call sites name repository
  declarations, each now a dependence or a scoped cut instead of nothing.
- A call has one target in every family that binds it; trace steps where `callers` proves.
- An index error the syntax contradicts is pruned with a cut; a synthesized record is never pruned for lacking a written
  call.
- A reverse query's first need in a read parses every read source once per content; one-shot CLI runs pay it every time
  until open question 1 decides otherwise.
- `DeclaredMemberNamesReader` is consumed by navigation, not only trace; its port comment and the alignment rules'
  domain move with U1.
- Coverage of a new language's calls arrives with its reader, not with family code.

## Risks

- **Several families move at once.** Mitigated by U0 to U6, each gated with stated directions.
- **Noise from recovered calls.** Unbound recovered calls follow the existing cut rules for unresolved references, scoped
  to reached names and the language rule; M5 counts them.
- **Cache pressure and cold cost.** M1 to M3 before acceptance.
- **Alignment depends on codegraph's places.** A codegraph upgrade that moves its columns changes the classes;
  conformance fixtures 3, 4 and 6 and the version-checked adapter (RFC-0003) catch it.
- **A family keeps a private binder.** The import fitness test of decision 1.

## Not decided here

Open questions, each with the recommended answer:

1. **Persist the deltas beside the kept index?** Recommended: decide on M2. If one-shot runs need it, write them in
   ye-ast's own store, keyed by the kept index's content digest, with its retention (ADR-0027); never into codegraph's
   store. The text pre-filter (align only files that spell a reached name) is the alternative to measure then.
2. **Key the delta by content alone?** Recommended: yes, if a fitness test shows codegraph's recorded places of a file
   depend on that file alone (index it in two snapshots of different neighbours and compare); otherwise add the digest
   of the file's recorded places to the key.
3. **Move or cut a `misowned` record?** Recommended: move it, since lexical ownership is exact; M4 counts them before U2.
4. **Deferred calls in reverse families.** Recommended: a dependence, as index edges inside function values count today;
   only trace reads `deferred` (R8).
5. **An `unowned` written call.** Recommended: a cut where a family reaches its name, never attributed to the file's
   top-level code by guess.
6. **Languages beyond TypeScript and Java.** Out of scope; each enters with its reader under ADR-0013.
