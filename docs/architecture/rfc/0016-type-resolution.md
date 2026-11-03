# RFC-0016: Type resolution

- Status: Draft, 2026-11-03. S4 measured: the wiring removes one cut, so the port is not the slice that carries the value.
  Read `S4 measured` and `The three gaps the measurement exposed` before the design below.
- Related: [ADR-0008](../adr/0008-typescript-compiler-api-source.md), [ADR-0010](../adr/0010-trust-modes.md),
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md), [ADR-0015](../adr/0015-index-reuse-by-content.md),
  [ADR-0018](../adr/0018-type-information-as-a-fact-input.md), [RFC-0002](0002-facts-contract.md),
  [RFC-0010](0010-impact-queries.md), [RFC-0013](0013-trace-and-patterns.md), [RFC-0006](0006-configuration.md)

**In short:** one port the core declares and one adapter over `ts.createProgram`, used where a walk meets a reference
the index could not settle. The program is built from the snapshot's own sources and from a type root the caller
provides, cached by content, and every fact that used it records it. Nothing runs out of process, and a repository's own
`tsconfig` keeps the role `RFC-0002` rule 4 already gives it: configuration that interprets content, never configuration
that raises a limit.

## The question and the answer the agent needs

"Does anything call this?" and "what breaks if I change it?" are answered today by codegraph's edges, plus the
`FieldOrigin` settlement in `src/core/application/impact/inbound-edges.ts:195,239`. Where neither settles a reference,
the answer carries an `unresolved-link` cut and the fact is `partial`.

The agent does not need a type error, a completion or a diagnostic. It needs one thing: **which declaration a reference
names**, and whether that declaration is inside the repository or outside it. Nothing else of the compiler is used, and
nothing else is promised.

## Evidence

Probe run on 2026-11-03 over a private Angular application: Angular 21.2, `typescript` 5.9.3 from the repository's own
`node_modules`, commit `e8699653` with uncommitted work in the tree, 701 non-declaration sources, 14.440 call
expressions (66 dynamic `import()` expressions excluded: they name no declaration).

| | Dependency closure available | Not available |
|---|---|---|
| Settled to a repository declaration | 5.940 (41.1%) | 4.812 (33.3%) |
| Settled to a library declaration | 8.473 (58.7%) | 1.879 (13.0%) |
| Unresolved | 27 (0.2%) | 7.749 (53.7%) |

- **Cost.** `createProgram` 1.3-1.8 s, `getTypeChecker` 0.33 s, walk over every call expression 1.0 s; 3.15 s wall and
  680 MB maximum resident set. For contrast, `tsc --noEmit -p tsconfig.app.json` on the same tree took 9.74 s: what this
  RFC uses is **resolution**, not verification, and it is a third of what a type check costs.
- **Determinism.** Two consecutive runs produced identical counts (14.440 / 5.940 / 8.473 / 27). The program is a pure
  function of its roots, its options and the bytes of the files it reads.
- **What the closure buys.** Without it, the unresolved callee names are led by `inject` (835), `set` (644), `computed`
  (630), `input` (401) and `signal` (277); the full top fifteen also carries `string` (237), `Component` (145),
  `output` (121), `pipe` (115), `map` (113), `Injectable` (112), `effect` (107), `optional` (104), `emit` (98) and
  `required` (79). The framework primitives among them are the ones `RFC-0013:169` lists as the features of a role.
- **With the closure**, the 27 that remain are DOM methods on loosely typed elements (`addEventListener`,
  `querySelector`, `getBoundingClientRect`) and one `super`. Nothing of the framework is lost.

Caveats, recorded so nobody reads these numbers as more than they are: it read a working tree, not a `sha`; and it
resolved the callee of every call expression, which is a superset of what a walk would ask. The harness lives outside the
repository, as `RFC-0013`'s probe workspace does. The pin was 5.9.3 when these numbers were first taken; S0 reproduced
all of them at `typescript` 6.0.3 (below), so they no longer depend on the version.

**Read 99,8% as a property of the checker, not of the cuts.** It is the share of *every* call expression the checker
settles. A cut is emitted for a much smaller and deliberately biased population: the references the index could not
settle whose name tail matched a declaration the walk reached. S4 measured that population with the wiring in place and
found one cut (`S4 measured`, below). The two numbers are not comparable and the earlier one was never evidence for this
feature.

## S0: reproduced at 6.0.3, and the frontier

S0 ran on 2026-11-03 with `typescript` 6.0.3, installed outside both repositories and verified by printing `ts.version`
before each run.

| Runs | `ts` | Calls | Repository | Library | Unresolved | Settled | Wall | Max RSS |
|---|---|---|---|---|---|---|---|---|
| with the closure, twice | 6.0.3 | 14.440 | 5.940 | 8.473 | 27 | 99.8% | 2.71-3.39 s | 659-662 MB |
| without it, twice | 6.0.3 | 14.440 | 4.812 | 1.879 | 7.749 | 46.3% | 1.29-1.33 s | 315-317 MB |

Every count is identical to the 5.9.3 run, and two consecutive runs of each differ in **no field** of the JSON: only
timings and RSS move. The 27 that remain with the closure are still 26 DOM methods and one `super`.

### The frontier codegraph reports

The probe resolved every call expression, which is a superset of what a walk asks. The real workload is the references
codegraph could not settle. On the same program (`tsconfig.app.json`, 700 files), with `codegraph` 1.6.2:

| Slice | Rows | Share of the frontier |
|---|---|---|
| The program | **18.156** | 100% |
| of which `calls` | 8.793 | 48% |
| `imports` | 3.735 | 21% |
| `function_ref` | 2.777 | 15% |
| `references` | 2.181 | 12% |
| `instantiates` | 366 | 2% |
| `decorates`, `implements`, `extends` | 304 | 2% |
| The whole index, specs included | 72.701 | — |

Building it cost 8 s, 1.16 GB of RSS and a 101 MB store, against 3.15 s and 660 MB for the program: the two fit
together, and neither moved with the pin. Per file the frontier has a median of 19 rows, a p90 of 73 and a maximum of
262.

### What this corrects

Two corrections, neither of which reopens the decision:

1. **Only 8.793 of the 18.156 rows name a callee.** `imports` name a module specifier, not a declaration, so S2's rule
   (`getSymbolAtLocation` on the callee) cannot settle them: they are `module-resolver.ts`'s job, and its answers are
   not fed back into codegraph's unresolved rows today. The port covers `calls`, `instantiates`, `references`,
   `function_ref`, `decorates`, `implements` and `extends` — 14.117 rows — and completeness moves only for those.
2. **74.6% of the whole-index frontier is in `*.spec.ts`** (54.211 of 72.701): test globals with no declarations. The
   probe never saw them because `tsconfig.app.json` excludes specs. A declared scope that includes tests faces a
   different frontier, and its type root has to carry the runner's globals too.

Independent confirmation of the diagnosis: codegraph's own unresolved call names on those files are `inject` 833,
`input` 398, `signal` 277, `Component` 145, `output` 121, `Injectable` 112 and `effect` 106 — the same set the probe
loses without the closure, and almost the same counts. Two mechanisms fail on the same names; the typed root is what
recovers them.

## S4 measured: the wiring removes one cut

S4 was implemented and measured end to end on the same application before any commit: 238 changed lines in 13 tracked
files and 9 new files, `npm run check` green with 1.459 tests.

| Base | Cuts, no root | Cuts, with root | Places, no root | Places, with root | Symbols |
|---|---|---|---|---|---|
| `HEAD~5` | 84 | **83** | 237 | **233** | 586 → 587 |
| `HEAD~20` | 201 | **201** | 847 | **842** | 1.067 → 1.068 |
| `HEAD~60` | 374 | **374** | 6.257 | **6.248** | 2.495 → 2.517 |

Cost, measured on `HEAD~5` with the index already cached, two runs each, the application's own `node_modules` as the type
root:

| | No type root | With a type root |
|---|---|---|
| Wall clock | 3,08–3,28 s | 5,17–5,63 s |
| Maximum RSS | 449 MB | 836 MB |

**+2,1 s and +387 MB for one cut.** The port does resolve: 11.308 of the 14.595 frontier rows settle, 1.896 of them onto
a repository declaration. The problem is selection, not capability: the cuts are the hard remainder, and almost nothing
that settles is asked about. Of the 145 cut places at `HEAD~5`, 30 settle onto a repository declaration and only 4 name a
declaration the walk reached — and only those 4 can disappear.

Three defects were found by measuring, and each is a correction to this RFC:

1. **The settlement was keyed by `(declaration, place)`.** The port settles a place onto node Y while
   `unresolvedLinkCuts` attributes the same place to node X by name tail, so the two keys never met. Measured: an empty
   intersection. `impact-cuts.ts:106` now drops a place whose settled target the walk reached, keyed by the place alone.
2. **`column` points at the start of the expression, not at the callee.** For `this.svc.get` the index reports the
   receiver's column, so `nameNodeAt` had to ascend from a call expression to its callee's name.
3. **The program's options never carry `paths`.** Composition calls `createTypeResolution` without `options`
   (`compose.ts:162`), so the application's own aliases are invisible to the checker while `module-resolver.ts` reads them
   correctly. That is gap B below.

None of the three is the reason the wiring removes one cut; fixing them moved the answer from zero to one. The reason is
that an edge is the wrong product: what the agent needs is fewer false cuts, not more edges.

## The three gaps the measurement exposed

### A. A cut whose target is known external is a false cut

`unresolvedLinkCuts` (`impact-cuts.ts:86`) emits a cut when a reference's name tail matches a declaration the walk
reached. It never asks whether the reference could name that declaration at all. When the reference's root identifier is
imported from a package outside the repository, it cannot: the cut is false, and it is most of what the agent reads.

Measured on `HEAD~60`, over the 1.172 frontier rows that sit at a cut place:

| The root identifier is… | Rows | Share |
|---|---|---|
| imported from a package outside the repository | 645 | 55,0% |
| not imported anywhere in the file | 259 | 22,1% |
| `this.x` or `super.y`, so it needs a receiver's type | 224 | 19,1% |
| imported from a repository file | 44 | 3,8% |

**Most of the cut places it can prove are not the declaration they are attributed to**, and proving it does not need a
type root: `ts.createSourceFile` over the file, a map from each import's local name to its specifier, and
`module-resolver.ts:46` to resolve that specifier, which already reads `paths`, `baseUrl` and the `extends` chain. The
probe classified its 1.172 rows in **369 ms**, with no `Program`, no `node_modules` and no type root.

**Corrected by implementing it.** That 1.172 is not the population: it is the 19% of the 6.257 `at` entries of
`HEAD~60` whose place carries no reference name. The named places (`src/a.ts:12 this.store.get`) are exactly the ones a
receiver roots and no import proves, so the probe had measured the retirable subset. Implemented end to end (S8,
`ADR-0019`), over every cut place:

| Base | Cuts | Places | Symbols |
|---|---|---|---|
| `HEAD~5` | 84 → **73** (−13,1%) | 237 → **193** (−18,6%) | unchanged |
| `HEAD~20` | 201 → **184** (−8,5%) | 847 → **782** (−7,7%) | unchanged |
| `HEAD~60` | 374 → **350** (−6,4%) | 6.257 → **6.151** (−1,7%) | unchanged |

At a cost of 457 MB → 585 MB of median peak RSS and no wall clock outside the noise. The rule holds; the estimate of its
reach did not, for the second time in this RFC, and for the same reason: a subset was read as the whole.

The program adds nothing to that number. Of the 645 external rows, 640 agree with the checker, and 36 of the checker's
`external` verdicts are the alias bug of gap B: where the import binding proves a repository file, the checker says
`external`. What the program adds is the 224 receiver rows plus the 117 unimported names it settles onto repository
declarations — about 29% of the cut places, and exactly the part gap C breaks.

**Soundness is the whole cost.** Retiring a cut asserts that the reference does not name the declaration. A local binding
that shadows the import makes that assertion false, and a hidden impact is worse than a false cut. Measured: 39 of the
645 external rows (6,0%) sit in a file that declares a name spelled the same. Rather than resolve the enclosing scope,
the shipped rule refuses **any** file that declares the name anywhere (`ADR-0019` decision 3): it gives up those 6% and
keeps the argument short enough to be obviously right.

> Retire the place only when the root identifier has an import binding and the file declares no name spelled the same.

A retirement changes when `unresolved-link` is emitted, so it touches `RFC-0002` rule 2 and the completeness rule of
`RFC-0010`; it took its own record, `ADR-0019`. It does not move a fact to `complete`: retiring a subset leaves the rest,
so the answer stays `partial` with a shorter list. The win is the list, never the status, and the measurement above
confirms it: no symbol changed.

### B. The type layer reads no `paths`, and this RFC specifies a wiring the architecture forbids

`type-resolution.adapter.ts:14-20` accepts `options?: ts.CompilerOptions` and `compilerOptions()` (`:75-85`) spreads
them, so the field works; `compose.ts:162` passes none, so the program resolves modules without the application's
`paths`, `baseUrl` or `extends`.

The symptom is a wrong answer, not a missing one: `AddressService`, a class of the application, is reported as
`external:@angular/core` at `location-picker.component.ts:49`. Measured, 36 cut-place rows are a repository import the
checker calls `external`.

This RFC says the options come "from the snapshot's `tsconfig.json`/`jsconfig.json` through the existing
`module-resolver.ts`". **That wiring is not allowed.** Both files live under `core/adapters`, and the dependency rule in
`AGENTS.md` forbids an adapter importing another adapter; the only frozen exception is `spring` reading `tree-sitter`'s
syntax trees. The sentence describes a fix the architecture rejects, and it was written before the adapter existed.

| Shape | Cost | Verdict |
|---|---|---|
| Composition parses the config and passes `ts.CompilerOptions` | A second parser for one fact, beside `module-resolver.ts:90-125` | Rejected: two owners of one fact, which the project calls a defect |
| Extract config parsing into a port (`DeclaredModuleConfig`) with one adapter over `ts.parseConfigFileTextToJson`, consumed by both | A refactor of an existing module plus one port | **The only shape that keeps one owner**, and the honest fix if the type layer stays |
| Stop asking the program to resolve modules and let `module-resolver` answer, as in gap A | Nothing new | **The cheapest**, and it is what gap A already needs |

### C. codegraph's coordinates are not a contract, and the adapter trusts them

`UnresolvedReference.column` is not documented with a base in `@colbymchenry/codegraph/dist/types.d.ts:197-220`.
Measured over a real index: 1-based for `calls`, **0 for `imports`**, and unusable for `function_ref`. The adapter turns
it into a position (`type-resolution.adapter.ts:135-145`) and, when the position lands on a different identifier,
returns a confident answer about the wrong name. That contradicts the invariant that a fault becomes an explicit
`unknown`, and it is worse than no resolution: it hides a dependency.

The name-on-line fallback was tried and **rejected**: repository settlements fell from 1.896 to 816, because a line holds
several identifiers and the reference's own name is often not the one carrying the type.

| Shape | Cost | Verdict |
|---|---|---|
| Ask codegraph to document the base per kind | An upstream question | Worth filing; not a ye-ast fix |
| Resolve by name inside the declaring function the row names (`fromNodeId`) | A scope-aware search per row | The real fix, and it removes the reliance on `column` |
| Return `unknown` when the identifier at the position does not spell the reference's simple name | A few lines | **A guard to land first**: it turns every wrong answer above into an explicit `unknown` |

## What the measurement changes in the plan

S4 delivers one cut, so it is not the slice that carries the value. The plan is re-ordered: A is the feature, and the
adapter is re-evaluated after A instead of before it.

| # | Slice | Deliverable | Acceptance |
|---|---|---|---|
| S7 | **A guard on the coordinate** (gap C) — **done, 2026-11-03** | A site whose identifier does not spell the reference's name is `unknown`, never a wrong `external` (`type-resolution.adapter.ts`) | Every wrong verdict produced by a misread coordinate becomes `unknown`; a fixture asserts no answer is given about a name that was not read, and removing the guard fails it |
| S8 | **Retire the false cuts** (gap A) — **done, 2026-11-03**, `ADR-0019` | `core/ports/import-origins.port.ts` and its adapter, consumed before the walk, with the file-level shadow rule; **no type root** | Measured: `HEAD~5` 84→73 cuts, `HEAD~20` 201→184, `HEAD~60` 374→350; a shadowed import keeps its cut; a true cut is never retired; a file whose configuration cannot be read retires nothing |
| S9 | **Re-evaluate the port** (gaps B and C) | Only if the remaining cut places — receiver-rooted names and names with no import — are worth +387 MB | The measured delta of S8 with the port and without it, against the 350 cuts and the +2,1 s and +387 MB recorded above |

S4 is superseded by S8 as the slice that changes an answer. Its wiring stays in the branch as the record of the
measurement and as the base of S9; nothing of it merges before S8 shows what it adds.

## How these costs were measured

Every number above is a **peak RSS** and a wall clock taken from one-shot CLI runs with the index already cached:

```bash
/usr/bin/time -l node --import tsx src/composition/main.ts impact <repo> --base HEAD~5 > /dev/null
```

`maximum resident set size` is what the process actually held at its peak, never the virtual size. It is a property of a
one-shot run, where the process ends with that peak; a long-lived daemon keeps only what its queries still reference, and
a memoized `Program` is one of the few things that stays.

A delta is reported only when the two configurations' three runs do not overlap. That is why the type root's +387 MB and
the import binding's +128 MB are stated as numbers, and why no latency delta is: the wall clock of repeated runs moves
more than the difference between them. A single run is never the evidence.

The floor decomposes exactly, each imported alone: an empty Node process 43 MB, `tsx` +15, the `typescript` compiler API
+140, `codegraph` +53, and ye-ast's own entry point +19, for **272 MB before a repository is touched**. What a query adds
on top is what the query reads, not the engine.


Declared by its consumer, `core/application/impact`, in `core/ports/type-resolution.port.ts`.

```ts
/** One place a fact found a name it could not settle: repo-relative, 1-based. */
export interface ReferenceSite {
  file: string;
  line: number;
  column: number;
  /** The simple name the syntax gives the callee, when it gives one. */
  symbol?: string;
}

/** What a reference names, as the facts need it: a place inside the repository, or a module outside it. */
export type ResolvedTarget =
  | { kind: "repository"; file: string; symbol: string; line: number; endLine: number }
  | { kind: "external"; module: string };

export interface TypeResolution {
  resolve(sites: readonly ReferenceSite[]): readonly Finding<ResolvedTarget>[];
}
```

`Finding` is the existing shape: a value, or `unknown` with a reason and its evidence. A site the port cannot settle is
`unknown`, never absent and never guessed. The port returns one entry per site, in the order it received them, so the
caller keeps position order without sorting.

**The port is synchronous, and that is a consequence of the consumer.** `impactOf`
(`impact-queries.ts:455`) and `walkImpact` (`walk.ts:63`) return values, not promises, and `inbound-edges.ts` is built
synchronously per query. A promise-returning port would force the walk to become asynchronous, and re-running
`createProgram` once per await would multiply the measured 3.15 s; `module-resolver.ts:66-88` is the precedent, and it
pays for that loop precisely because its reader is asynchronous. A synchronous port is affordable only because the
snapshot is already materialized on disk: the adapter reads bytes, it never interleaves a read with a walk.

It lives in `core/ports` because `core/application` may not import an adapter. The domain vocabulary it uses —
`ReferenceSite`, `ResolvedTarget` — lives in `core/domain/relations/resolved-reference.ts`, beside `relation.ts`, since
that subdomain already speaks "what refers to what".

## The adapter

`core/adapters/typescript/type-resolution.adapter.ts`. Side-effecting, so it exports `*Deps` and `default*Deps`, like
every adapter with a process boundary (`AGENTS.md`, "Dependency injection is the testing strategy").

| Step | Rule |
|---|---|
| Roots | The sources the caller names, repository-relative to the snapshot root |
| Options | Taken from the snapshot's `tsconfig.json`/`jsconfig.json` through the existing `module-resolver.ts`, with `noEmit`, and with `plugins` and `types` emptied: a plugin list names code, and reading it from the repository is what `ADR-0010` decision 4 forbids in both modes |
| Type root | A directory outside the snapshot, supplied by the caller or, under `trusted` and without one, derived from the working tree's `node_modules`. It is never a path the repository names, and never a path inside a snapshot: neither an export (`sha`) nor a mirror (`live`) holds `node_modules` |
| Program | `ts.createProgram({ rootNames, options, host })` with a **synthetic** host, never `ts.createCompilerHost`: its `fileExists` and `readFile` resolve only inside the materialized snapshot directory and the type root, and read them from disk synchronously. `createCompilerHost` reads the real file system and would escape both |
| Resolution | `checker.getSymbolAtLocation` on the callee name, `getAliasedSymbol` when `SymbolFlags.Alias`, and `getResolvedSignature` as the fallback for a call through a variable |
| Reference kinds | `calls`, `instantiates`, `references`, `function_ref`, `decorates`, `implements` and `extends` name a declaration and go to the checker. `imports` name a module specifier: they belong to `module-resolver.ts`, which already answers them, and the port reports them `unknown` rather than pretending (S0: 3.735 of 18.156 rows) |
| Placement | `getLineAndCharacterOfPosition` over the declaration's source file, with the declaration's own span |
| Failure | A syntax error, an unreadable file or a site without a symbol is `unknown` with its reason. Nothing throws out of `resolve` |

The adapter never writes. It opens no socket, runs no repository script and installs nothing.

### Cache

Keyed like the index of `ADR-0015`: the content digest of the snapshot, the `typescript` version, the type root's own
digest and an adapter version. A program is built once per key and reused for every query of that snapshot, because the
3.15 s and the 680 MB are paid at construction, not at query time.

## The join at the new scale

`src/core/domain/shared/code-node.ts:20` holds the one join between a graph node and a fact, and it stays the only one.
What changes is how often it is asked.

Today every caller scans linearly over the symbols of a file
(`inbound-edges.ts:174,180,232,233`, `impact-queries.ts:462`, `seeds.ts:67`, `reached-entrypoints.ts:34,39`). That is
affordable because the sets are the seeds, the entrypoints and the call sites a plugin extracted. Type resolution adds
one join per **resolved reference**, against the symbols of the target file.

Three rules keep it honest:

1. **The predicate does not change.** File, line inside the span, simple name. No qualified names, no overloads.
2. **An index sits behind the same owner.** A `Map<file, CodeNode[]>` sorted by `startLine`, searched by line and then
   filtered by name, or a `Map<file + name, CodeNode[]>`. It is a change in the callers, in one module.
3. **Ambiguity becomes explicit.** `inbound-edges.ts:174` resolves a set with `.find()` and silently keeps the first
   candidate. With more joins, that becomes a real risk. The index returns every candidate and the caller either takes
   the only one or reports `unknown` with reason `ambiguous-target`, listing them. This is a contract change and belongs
   to the slice that introduces the index, not to the one that wires the port.

The workload driver is the number of unresolved references the walk already reads
(`reader.unresolvedReferences([file])`), not the 14.440 call expressions of the probe: the port is asked about the
frontier, not about the repository. That number is unmeasured for any real repository and is the first thing the plan
measures.

## Inputs and invalidation

`RFC-0002` rule 5 makes `inputs` decide validity. This RFC adds one field:

```ts
interface FactInputs {
  // ...existing fields: declaredScope, content, declaredConfig, producer
  typeRoot?: { identity: string };   // the digest of what was read, absent when none was supplied
}
```

- A fact that used the port records `typeRoot`. Two facts with equal `inputs` stay equal.
- A different type root invalidates the stored fact, which is the point: a resolution made without the closure is not
  the same answer.
- The `typescript` version already belongs to the producer identity; it moves when the pin moves (`ADR-0007`).
- Adding the field is a **minor** change of the schema under `RFC-0002` rule 6, and it invalidates every stored fact of a
  snapshot once. That invalidation is declared, not discovered.

## Completeness and the cuts

- **A settled reference becomes an inbound edge before the walk, not a cut removed after it.** `impactOf` calls
  `walkImpact` (`impact-queries.ts:470`) and only then builds `unresolvedLinkCuts` over the symbols the walk reached
  (`:474`, `impact-cuts.ts:86-111`). Resolving at the emitter would add an edge from a caller the walk never expanded:
  its own callers and entrypoints would stay unvisited with no cut declaring it, and the answer would be `complete` on an
  unvisited frontier — which `RFC-0010`'s completeness rule forbids. The port is therefore consumed by
  `createInboundEdges` (`inbound-edges.ts:50`), so the new edge takes part in the walk like any other.
- A reference it cannot settle keeps the `unresolved-link` cut, with its reason. `unknown` at a site is not a cut: it is
  an item that says what could not be known at that place (`RFC-0002` rule 2).
- **No new cut for a missing root.** `inputs.typeRoot` records the root that answered, and its absence already says why
  a place stayed unresolved. A `no-type-root` cut would repeat, on every answer of every caller who has not configured
  one, the places `unresolved-link` already names — measured: it fired on a plain impact answer with no root. The places
  keep their existing cut, which is what `ADR-0018` decision 5 already said.
- One new word does extend a closed union: `ambiguous-target` as an `UnknownReason`
  (`src/core/domain/shared/fact.ts:101`), and it needs its own schema step under `RFC-0002` rule 6. It may not arrive as
  a side effect of another slice.
- Answers move from `partial` to `complete` only when no `unresolved-link` cut remains **of a kind the port settles**.
  With `imports` out of its reach, at most 14.117 of the 18.156 rows of S0's frontier can become edges, so S4 names the
  subset it claims and `complete` is claimed only when what is left lies outside it — or `module-resolver`'s answers are
  also wired back, which is a later slice. That is measured per query, never asserted.
- `importers` keeps its own path in the first wiring: `impact-queries.ts:240-241` reads the unresolved references itself,
  so `impact` would settle semantically what `importers` still settles by name tail. The asymmetry is declared in the
  slice that creates it, and is question 8.

## Trust modes

| | `trusted` | `untrusted` |
|---|---|---|
| Snapshot | `live` or `sha` | `sha` only |
| Does the snapshot hold the closure? | **No.** An export holds the git tree's files; a mirror holds the in-scope listing. `node_modules` is in neither | **No**, and the export has no other path to it |
| Type root | The host's, or derived from the working tree's `node_modules` when the caller supplies none | The host's only |
| Without a type root | Today's answer; the port answers `unknown` | Today's answer, unchanged; the port answers `unknown` |
| Configuration read | The repository's `tsconfig` and `.gitignore` | The `tsconfig` only, as `RFC-0002` rule 4 already allows, with `plugins` and `types` emptied |

`ADR-0010`'s invariants hold in both modes: no secret, no network, no repository code executed, no write outside ye-ast's
own store. The adapter reads through the confined reader, like every other path in the core, and `/// <reference path>`
directives inside a `.d.ts` are confined to the type root: a package must not be able to point the compiler at a path it
chooses.

`ADR-0018` decision 6 makes the root the single mechanism whose **provenance** the profile decides. It has a consequence
the owner must weigh: **qayaba declares `untrusted` for every run** (`ADR-0010`, Consequences), so it must supply a type
root for this work to change anything there. The measured cost of doing so is 74.6 MB per resolved closure, against
622 MB for the whole `node_modules`.

## The plan, in slices

Each slice is reviewable alone, leaves `npm run check` green and adds its own fixtures. Estimates are hypotheses, in
the sense of `ADR-0013` decision 4.

| # | Slice | Deliverable | Acceptance | Estimate |
|---|---|---|---|---|
| S0 | **Measure the frontier** — **done, 2026-11-03** | The probe re-run at 6.0.3 and the frontier codegraph reports; both recorded in "S0: reproduced at 6.0.3, and the frontier" | Reproduced exactly, two runs identical field by field, frontier recorded: 18.156 rows, 8.793 of them `calls`. It does not reopen S2 or S4; it narrows both | done |
| S1 | **The port, synchronous** | `core/ports/type-resolution.port.ts`, `core/domain/relations/resolved-reference.ts`, a fake for tests. No wiring, no behaviour change | `npm run arch:check` green; the fake exercised through the port; nothing under `core/application` imports `typescript` | 1 day |
| S2 | **The adapter over a materialized directory** | `core/adapters/typescript/type-resolution.adapter.ts` with `*Deps`, a synthetic compiler host, and fixtures over in-memory sources: bare call, member call, aliased import, generic member, external library, missing declaration, unreadable file, a path escaping both roots, a `/// <reference>` pointing outside the type root | Every fixture fails first for its own reason; the escapes are refused, not resolved; the adapter resolves the repository fixtures and marks the rest `unknown` with a reason; no `ts.createCompilerHost` anywhere | 3 days |
| S3 | **The join index and `ambiguous-target`** | The indexed lookup behind `joinsFact`, plus the `UnknownReason` step that names ambiguity | The existing suite passes unchanged on every fact; a fixture with two candidates that today picks the first reports `ambiguous-target` listing both; the schema step is declared, not implied; measured time of the impact suite before and after | 1.5 days |
| S4 | **Feed the walk** — **measured, superseded by S8** | `createInboundEdges` consumes the port before `walkImpact`, so a settled reference becomes an inbound edge | Cuts removed **and** edges expanded: a fixture where the newly reached caller has a caller of its own must show that second-level caller in the answer. Counting cut removal alone would pass while the fact lies. `importers` keeps its path and the asymmetry is written down. Measured result: 1 cut of 84, +2,1 s, +387 MB | superseded |
| S5 | **`typeRoot` in `inputs`** | The input field and the schema minor bump; no cut | A stored fact is invalidated by a different type root and survives an unrelated one; two runs give equal bytes; an answer with no root is byte-identical to today's | 1 day |
| S6 | **The profile field that names the root** — **done, 2026-11-03** | `CompositionOptions.typeRoot` and `--type-root <dir>`, wired through the process host; the identity is the digest of the directory, recorded as `inputs.typeRoot` | A run with a root records its identity in `inputs.typeRoot` and one without carries no such field, byte for byte as before; a root that reads nothing still answers, with the `unresolved-link` cuts it had | done |

Slices S1-S5 do not depend on S6: they run on a type root supplied by the caller, which in tests is a directory. What
S6 adds is where that directory comes from in production, and the profile field that names it.

## Out of scope

- **`tsserver`, LSP and any language server.** The engine is the same one, reached in process, without a service that
  chooses the project and keeps state (`ADR-0018` decision 7).
- **Java.** No compiler for Java runs in Node. The equivalent would be a JVM (`jdtls`, `ecj`, JavaParser's symbol
  solver), and the facts Java needs today are annotations that `tree-sitter` already reads. Deferred until `trace`
  exists, if it ever does.
- **`trace` and `patterns`.** `RFC-0013`'s `trace` is not built and `patterns` is deferred. This RFC serves `impact`
  and `callers`, which exist.
- **Editing, rename and refactoring.** Read-only toward agents, by invariant.
- **Full type checking and diagnostics.** Resolution only; the 9.74 s measurement is the reason.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | How does qayaba produce and expose a type root? | **Supply a directory.** The declarations are 74.6 MB (11.308 `.d.ts` and 1.016 `package.json`) against 622 MB of `node_modules`, and the host already supplies the manifest and the store. The root is keyed by the lockfile, so a repo whose lockfile moved gets a different root. Whether the export ever carries a closure is now a separate, weaker question: at 74.6 MB it is not impossible, but it buys nothing a host directory does not |
| 2 | Under `trusted` without a host, may the root be derived from the working tree's `node_modules`? | **Yes, and recorded as such.** It is the only place the closure exists, and the input identity makes the fact invalid when that tree changes. `untrusted` never takes this path |
| 3 | Is a site the port cannot settle a cut or an item reason? | **An item, `unknown` with its reason**, following `RFC-0002` rule 2: it is a construct read but not resolved, not a computation the fact never reached. No new cut: a missing root is recorded in `inputs.typeRoot`, and the places keep the `unresolved-link` cut they already carry |
| 4 | What budget stops a `Program`? | **A wall-clock deadline with a cut**, never stored (`RFC-0002` rule 3). S0 measured both halves on one application: the program 3.15 s and 660 MB, the codegraph index 8 s, 1.16 GB and a 101 MB store. Neither moved with the pin. The deadline is set from a larger repository, and no slice acceptance depends on it: S4 is judged on fixtures, not on latency |
| 5 | Does the same decision apply to Java when `trace` arrives? | **Not automatically.** Revisit with a measurement of what codegraph's Java edges miss on a real Spring application; that measurement does not exist yet |
| 6 | Does type resolution replace `RFC-0013` R2-R6 for TypeScript, or complement them? | **Replace for TypeScript, keep as fallback.** The syntax rules stay the answer when no type root is available; with one they add nothing the checker does not settle, and keeping both would make two mechanisms answer the same question |
| 7 | Does the `typescript` pin move, given `ADR-0008` freezes 6.0.3? | **No.** Resolution uses the same compiler API the extractors already use; the pin moves when `ADR-0008` is superseded, not for this |
| 8 | Does `importers` join the first wiring, or keep its own path? | **Keep its path in S4 and declare it.** `impact-queries.ts:240-241` reads unresolved references itself; bringing `importers` in later is a slice of its own, but until then both answers must be able to disagree and say why |
| 9 | Is a cut retired on an import binding alone, or does it need the checker? | **The import binding (S8, shipped).** It removes 6% to 13% of the cuts on the diffs measured, at no wall-clock cost; the checker adds only the receiver-rooted names, which is what S9 measures. The shadow rule is file-level and deliberately gives up 6% of the retirements |
| 10 | Does a retired cut make the fact `complete`? | **No.** The measured runs stay `partial` and change no symbol. The feature buys a shorter list, not a status, and it must not claim one |
| 11 | Where does the module configuration come from, if the type layer stays? | **A port (`DeclaredModuleConfig`) with one adapter, consumed by `module-resolver` and the type adapter.** Adapter-to-adapter imports are forbidden, and composition parsing the config a second time creates a second owner of one fact |
