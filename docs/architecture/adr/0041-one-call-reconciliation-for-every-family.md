# ADR-0041: Every query family reads calls from one reconciliation of the index and the syntax

- Status: Accepted, 2026-11-08. The owner accepted it after review, verbatim: "apruebo", including decision 8 (an unbound
  recovered call on a receiver no proof types is counted in M5 and not emitted). The measurements stay gates of the units
  that need them: M5 before U4 is accepted, M1 to M3 before open question 1.
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
and reverse (the calls into a declaration) through a name index retained by its complete inputs. Families extend it by
composition: each applies its own policy to the reconciled calls, and may narrow a binding but never re-bind one.

## Context

### One merge, in trace only

- Trace reconciles per body in `bodyOf` (`src/core/application/trace/trace-walk.ts:378-634`). It matches each call edge
  and unresolved call reference to a written call by line, column and name (`matchOwnedCall`,
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

The figures below come from the 2026-11-08 research, a scratch measurement not kept in the repository. This ADR does not
reproduce them; M1 to M5 measure the implementation.

- Written calls codegraph records nowhere (no edge of any kind but containment and imports, no unresolved reference at
  the same place; the base aligns call-bearing records only, decision 2, and M4 counts again): 1,516. Only 144 name a
  repository declaration: 116 Java `super(...)`/`this(...)` into repository constructors, 19 calls inside top-level
  `const X = f(...)` initializers, 9 scattered. The rest are library calls (712 inside class-field wrappers such as
  `computed(() => ...)`, about 450 on receivers that are no name). These counts size the enrichment, not the noise:
  M5 measures what the recovered library calls produce.
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
- **Records without a column are cut.** After `callEdgesOf` drops the synthesizers `EDGE_POLICY` ignores
  (`trace-walk.ts:47-49`, `src/core/domain/impact/edge-policy.ts:62`), a kept call edge with no column finds no written
  call by column, so trace sends it to the `unplaced` cut unless one written call of its name sits on its line
  (`trace-walk.ts:386-402`). Synthesized edges have no written call by construction.
- **A place matches whatever its name.** When no written call at a record's place agrees with its name, `matchOwnedCall`
  still matches the one written call that starts there (`syntax-calls.ts:56`): a record `beta` matches a call `alpha`.
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
| **Per-file alignment retained by its complete inputs, binding lazy, a name index per read** | As today | First need in a read aligns every read source whose inputs it has not seen; binds only the candidates of reached declarations | Only files whose inputs changed align again | Chosen |
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
   `syntax-calls.ts` and the static binding of `bodyOf` move into it; the reading of calls of `DeclarationUses` moves
   into it, and its reading of `references`, `extends` and `implements` stays. No family aligns or binds calls itself,
   and a fitness test over imports holds it. The pure rules it shares with trace (owning body, call place, column
   comparability) move from `core/domain/trace/` to `core/domain/shared/`.
2. **Inputs and coverage.** A file's call-bearing records are the `calls` and `instantiates` edges of its declarations,
   the calls a resolver retyped into an edge of another kind, read back as references (`declaration-uses.ts:46-54`), and
   its unresolved references of those two kinds. Only they are aligned, and only they can be `contradicted`: a
   `SyntaxCall` is a call or a construction (`src/core/ports/declared-member-names.port.ts:115-116`), while `references`,
   `extends` and `implements` need no invocation syntax (`edge-policy.ts:23-25`). Records of those kinds keep their
   existing reading and verdicts, as trace already reads them apart (`trace-walk.ts:379-380`). A file's written calls
   are `DeclaredMemberNames.calls`, absent when no reader parsed the file: composition keeps the absence, and absent is
   `unread`, never "no call".
3. **Alignment, per file.** Each written call gets its innermost index body by exact lexical ownership, `deferred` when a
   function value its body does not run encloses it. A record matches a written call at its place (its line and column,
   or an anchor the reader lists) when the spelling or the callee agrees with the record's name; a record without a
   column is compared on its line. Today a place also matches the one written call that starts there whatever its name
   (`syntax-calls.ts:56`): U1 keeps that rule byte for byte, and U2 decides, with a mismatched-name fixture and the M4
   count of such matches, whether name agreement becomes required. From U2, past a line's first character outside ASCII
   columns are not compared and the line rule applies. Every call-bearing record and written call then falls in exactly
   one class:

   | Class | What it is | What the base does |
   |---|---|---|
   | `matched` | A record and a written call at one place | Kept, at the written position |
   | `recovered` | A written call no record matches | Added, bound by decision 4 |
   | `synthesized` | A record whose synthesizer is set, or without a column | Kept as the index has it, never cut for want of a written call |
   | `unread` | A record of a source no reader parsed | Kept as the index has it |
   | `misowned` | A record whose written call another body owns | Moved to that body, dropped when that body holds its own record of it |
   | `contradicted` | A record with line and column, not synthesized, in a read source, matching no written call | Pruned, with one `unresolved-link` cut at its place naming its target |
   | `unowned` | A written call no single index body owns | A cut at its place wherever a family reaches its name |

   Alignment reads the file's syntax, its index declarations (kind, name, span) and its call-bearing records (kind,
   place, name, synthesizer, retyping); those are its complete inputs (decision 9).
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
   call references whose binding reaches one of them, as edges into it (the `FollowedEdge` that `typedReferencesOf`,
   `reference-origins.ts:77`, and `redirectedInto`, `edge-targets.ts:297`, already produce). It reads a name index of
   every read source's recovered calls and unresolved call references, by the name each spells as its callee, and binds
   only the candidates of reached declarations. A reached declaration's candidates are complete when looked up under:
   - its own name, in every file: a bare call, a member call `x.f()` and a namespace call `ns.f()` all spell it;
   - each local name an import binding proves reaches it (`importBindings`,
     `src/core/application/navigation/import-bindings.ts:15-31`), only in the importing file, the expansion
     `candidatesInto` already makes for index edges (`edge-targets.ts:325-328`): `import { f as g }` files `g()` and
     `new g()` there;
   - for a class `C`, or a constructor of `C`: `C`'s name and its import aliases, for `new`; `super` among the calls the
     constructors of each direct subclass own (the subclasses by the index's `extends` edges into `C`, and a
     parameterized supertype by its raw name, as `supertypesOf` reads it, `trace-walk.ts:244-251`); `this` among the
     calls `C`'s own constructors own. The Java reader spells chaining `super` or `this` with no callee
     (`src/core/adapters/tree-sitter/java-member-names.adapter.ts:48-60`), so no constructor name finds it otherwise.

   A call spelled any other way (a value alias `const g = f; g()`, a computed callee) is in neither source and reaches
   the declaration through the value's `references` edge, as today; an alias the import join does not prove leaves the
   call unbound under its own name. Impact and `callers` call `into` in `walkInside`'s fixpoint beside `redirectedInto`
   (`impact-queries.ts:619-673`): a bound call is a dependence with its derivation. An unbound recovered call is a cut
   only when attributed: a bare call that names the declaration in its own file or through its proven import, or a
   member call whose receiver a proof types and whose candidates at that type include the declaration (overloads the
   reading does not settle). A member call on a receiver no proof types (a call result, a computed value, an
   unannotated or callback parameter) never reaches the unattributed homonym cut that `unresolvedLinkCuts` makes for a
   qualified index reference without candidates (`src/core/domain/impact/impact-cuts.ts:164-183`): it is counted (M5),
   not emitted, and stays as absent as it is today. Noise is worse than no fix. Index unresolved references keep
   today's rules (open question 7).
9. **Retention by complete inputs.** Two ADR-0035 derived facts, each keyed by every input it is derived from (ADR-0035
   decisions 1 and 2):
   - a file's written calls (with their owner scopes and its function values), derived from the file alone, keyed by its
     path and content;
   - a file's alignment delta (its recovered and unowned calls with their owner spans and flags, its `contradicted` and
     `misowned` places; positions and names, never node ids or trees), keyed by its path and content and the digest of
     its normalized index inputs: its declarations (kind, name, span) and its call-bearing records (kind, line, column,
     name, synthesizer, retyping).

   The delta's key costs one read of the file's declarations and records from the store; a delta miss with a written
   calls hit aligns without parsing. Whether the written calls fact is retained at all depends on its bytes (M3);
   without it a delta miss parses the file again. The index digest leaves the key only on the proof of open question 2.
   Bindings live for one read.
10. **Laziness.** Nothing runs at indexing. The full alignment runs the first time a read needs the name index, inside
    the read's parse hold (ADR-0040), file by file, reducing each TypeScript output to its delta; the Java trees it
    parses stay held until the read ends. Forward families never trigger it.
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

Every cost below is a measurement to obtain, not a guarantee.

- **Parse.** Forward families parse what they parse today. A reverse family's first need in a read parses every read
  source whose content it has not seen. The 2026-11-08 research measured that parse at 0.06 to 2.5 s per snapshot.
- **Alignment.** Today's code compares by scanning lists: `positionedBodies` filters every scope per declaration,
  `callsByOwner` every body and function value per written call, and `matchOwnedCall` every owned call per record
  (`syntax-calls.ts:15-56`). The base builds per-file lookups once (written calls and records by line, bodies ordered by
  span start), so a record is compared only with the written calls of its line and a call only with the bodies around
  it. M1 measures the result.
- **Memory.** Under ADR-0040 every Java tree the full pass parses stays held until the read ends, so the pass's peak
  includes the Java trees of the whole snapshot; TypeScript outputs are reduced to their delta file by file. M1 measures
  peak heap and WASM memory.
- **Warm.** A warm name index reads each file's declarations and call-bearing records (for the delta's key) and its
  retained delta, and parses nothing. Binding follows the candidates of reached declarations, not the repository.
- **Incremental.** A commit or a live sync aligns again only the files whose inputs changed; the name index of a read is
  rebuilt from retained deltas.
- **One-shot processes.** Derived facts live in the process (ADR-0035), so each CLI `callers` or `impact` run pays the
  cold pass; the MCP server and `serve` pay it once per input.

Measurements on the corpus manifest of ADR-0039, each a gate of the unit or open question it names:

| # | Measure | Why |
|---|---|---|
| M1 | Complete `callers`, `impact` and `importers` queries, cold and warm, per repository: CPU, peak heap, peak WASM memory under the Java hold, Java parses, against the indexing time | Bounds the reverse first need and the hold's memory |
| M2 | One-shot CLI `callers` and `impact`, base against candidate, cold and warm, on the largest repositories | With M1 and M3, decides open question 1 |
| M3 | Retained bytes of both derived facts against the 32 MiB default budget (ADR-0021), and the evictions they cause in repeated queries | Cache pressure |
| M4 | Per repository, over call-bearing records only: `matched` (and how many by the one-call-at-a-place rule with another name), `recovered`, `synthesized`, `unread`, `misowned`, `contradicted`, `unowned` | Sizes every class; decides the U2 name rule |
| M5 | Every recovered call per repository, split into bound to a repository declaration, proven outside, unbound and attributed (a cut), unbound and unattributed (a homonym of a reached name, not emitted); and the new cuts per corpus query in `callers`, `impact`, `outline`, `importers` and trace, each inspected | Noise; the report is inspected before U4 is accepted |
| M6 | Answers byte-identical for every refactor unit | Behavior preserved |

## Migration

Each unit is its own commit with its fixture failing first, passes `npm run check`, and passes the corpus gate before it
reaches `main` with the expectations stated (ADR-0039).

| Unit | Change | Gate expectation |
|---|---|---|
| U0 | Composition keeps `calls` absent for unread sources; the `unread` class in trace | `none` on the corpus expected; `trace:+` where a walk enters an unread source |
| U1 | Alignment of call-bearing records moves to `ReconciledCalls`, today's matching rule kept byte for byte; domain rules to `core/domain/shared/`; trace reads `callsOf` | `none` (M6) |
| U2 | `synthesized`, column comparability, `misowned` and `contradicted` replace trace's blind `unplaced`; the name rule at a shared place is decided on M4 | `trace:±` |
| U3 | One binder: trace's static chain and `EdgeTargets`' receiver settlement become one; trace hands over field and local origins. Before the move, regression tests pin through `callers` and `impact` every settlement `EdgeTargets` makes today: `proven` and `name-match` for a field origin, an `inject()` local, a constructed, a declared and an annotated receiver, `typed`, a drop and a redirect | `trace:+`; `callers` and `impact` `none`, answers byte-identical |
| U4 | Name index with its complete candidate lookup, `into`, constructor chaining, the attribution rule of decision 8; `impact` and `callers` read it in the fixpoint; accepted only after the M5 report is inspected | `callers:+`, `impact:+`, `±` where an attributed cut appears |
| U5 | `outline` focus, `importers` and `contract_consequences` read the base | `outline:+`, `importers:±`, `contract_consequences:±` |
| U6 | `contradicted` pruning in the reverse families | `callers:±`, `impact:±`; none expected (M4 first) |

Conformance fixtures, in the base's tests through its public seam and once per family that wires it, each added failing
first in the unit named:

1. **Only calls are reconciled (U1).** `class C extends Base implements Port { dto: Dto; run() { this.svc.load(); } }`
   with the index holding `extends`, `implements`, a `references` edge to `Dto` and a `calls` edge to `load`: only
   `load` is aligned; the other three edges are neither matched nor contradicted, and every family follows them as
   before.
2. **Homonym false gap (U1).** `this.http.get(url).pipe(map(f))`, with the index recording `pipe` only: `pipe` is
   `matched`, `get` `recovered`, nothing `contradicted`; and `a.save(); b.save();` on one line pairs each record with
   its own call.
3. **Unread source (U0).** A body in a source no reader parses: its records kept, nothing recovered or contradicted.
4. **Synthesized edge, policy unchanged (U2).** A call edge with no column and a synthesizer `EDGE_POLICY` does not
   ignore: the base classifies it `synthesized`, trace and `callers` follow it, and trace emits no `unplaced` cut. An
   edge of `angular-template`, `angular-event` or `interface-impl`: the base preserves it as `synthesized`, and every
   family still leaves it unfollowed (`edge-policy.ts:62`).
5. **Mismatched name at a place (U2).** A record `beta` at a place where the only written call is `alpha`: U1 matches
   them as today; from U2 the outcome follows the rule M4 decides (kept, or `beta` `contradicted` and `alpha`
   `recovered`).
6. **Contradicted record (U2, U6).** A call edge placed where the source writes no call: pruned with one cut, never
   silent.
7. **Constructor chaining (U4, Java).** `class B extends A { B() { super(1); } B(String s) { this(); } }` with `A(int)`
   and `A(int, int)`: `callers` of `A(int)` lists `B()`, `callers` of `B()` lists `B(String)`, trace from `B(String)`
   steps to `B()` and then `A(int)`. With `A(String)` added, the signatures at the call's arity differ and the reading
   does not settle them, so `super(1)` is a cut listing `A(int)` and `A(String)` (R5).
8. **Call in a top-level const initializer (U4, TypeScript).** `export const Store = signalStore(withMethods((s, api =
   inject(Api)) => ({ load: () => api.getArticle() })))`, which the index records nothing of: `callers` of
   `Api.getArticle` lists `Store` at the call's line, `proven`; trace marks the call `deferred`.
9. **Aliased call and construction (U4, TypeScript).** In a const initializer the index records nothing of,
   `import { getArticle as load } from "./api"` and `import { Store as S } from "./store"`, then `load()` and `new S()`:
   `callers` of `getArticle` and of `Store` each list the initializer's constant.
10. **Unknown call-result receiver (U4).** `factory().get(id)` with a reached `B.get`: no cut in `callers` or `impact`;
    M5 counts it as unattributed.
11. **Deferred callback with repository homonyms (U4).** `items.forEach((item) => item.save())` with a reached
    `Repo.save`: no cut in `callers` or `impact`; trace keeps its own R6 cut at the call, as today.
12. **No noise from library calls (U4).** `x = computed(() => Math.max(a, b))` adds no cut in `callers` or `impact`.

## Consequences

- `callers` and `impact` gain the dependences codegraph does not record and ye-ast's proofs bind; an unbound one is an
  attributed cut, or, with no proof to attribute it, stays absent as today and is counted by M5.
- A call has one static target in every family that binds it. Trace starts from the binding `callers` uses, but its
  execution policy may still refuse it (a nominal class, dispatch), so a dependence `callers` proves can stay a trace
  cut, now for a stated execution reason.
- An index error the syntax contradicts is pruned with a cut; a synthesized record is never pruned for lacking a written
  call; `references`, `extends` and `implements` are never aligned.
- A reverse query's first need in a read parses every read source whose inputs it has not seen; one-shot CLI runs pay it
  every time until open question 1 decides otherwise.
- `DeclaredMemberNamesReader` is consumed by navigation, not only trace; its port comment and the alignment rules'
  domain move with U1.
- Coverage of a new language's calls arrives with its reader, not with family code.

## Risks

- **Several families move at once.** Mitigated by U0 to U6, each gated with stated directions.
- **Noise from recovered calls.** An unbound recovered call cuts only when attributed (decision 8); the unattributed
  homonym cut of `unresolvedLinkCuts` is closed to it; M5 reports what is attributed and what is not emitted, and U4 is
  accepted only after that report is inspected.
- **Silence kept where nothing attributes a call.** A recovered call on an untyped receiver that does reach a reached
  declaration stays absent, as today; M5 sizes it.
- **Cache pressure, cold cost and the Java hold.** M1 to M3 before acceptance.
- **Alignment depends on codegraph's places.** A codegraph upgrade that moves its columns changes the classes;
  conformance fixtures 2, 4 and 6 and the version-checked adapter (RFC-0003) catch it.
- **A family keeps a private binder.** The import fitness test of decision 1.

## Not decided here

Open questions, each with the recommended answer:

1. **Persist the deltas beside the kept index?** Recommended: decide on M1 to M3 (complete cold and warm queries,
   evictions and the memory of the Java hold) and M2. If one-shot runs need it, write them in ye-ast's own store, keyed
   by the kept index's content digest, with its retention (ADR-0027); never into codegraph's store. The text pre-filter
   (align only files that spell a reached name) is the alternative to measure then.
2. **Drop the index digest from the delta's key?** Recommended: only on a proof that equal file content gives equal
   complete inputs (declarations with kind, name and span; call-bearing records with kind, place, name, synthesizer and
   retyping), for example a fitness test that indexes one file within two snapshots of different neighbours and compares
   them. Until then the digest stays in the key; decided before U4 relies on retention across snapshots.
3. **Move or cut a `misowned` record?** Recommended: move it, since lexical ownership is exact; M4 counts them before U2.
4. **Deferred calls in reverse families.** Recommended: a dependence, as index edges inside function values count today;
   only trace reads `deferred` (R8).
5. **An `unowned` written call.** Recommended: a cut where a family reaches its name, never attributed to the file's
   top-level code by guess.
6. **Languages beyond TypeScript and Java.** Out of scope; each enters with its reader under ADR-0013.
7. **Should index unresolved references lose the unattributed homonym cut too?** Recommended: decide on the M5 report;
   U4 leaves their rule as it is, so it changes no answer it does not have to.
