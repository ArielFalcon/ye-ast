# RFC-0016: Type resolution

- Status: Draft, 2026-11-03. S0, S4, S7, S8, S9, S10, S12 and S13 measured; S8 and S13 are the slices that carry the
  value (6% to 13% of the cuts from the import proof, 12% to 40% from the DI reader), both with no type root. S9 shows the
  port buys 0 to 3 cuts for +2,2 to +2,9 s and +300 to +480 MB. Read `S4 measured`, `The three gaps the measurement
  exposed` and `S9 measured` before the design below; the family plan and what each slice measured are in "What would
  close the remaining families".
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
   intersection. `impact-cuts.ts` now drops a reference whose settled target the walk reached. Keyed by the place **alone**
   that first fix was too coarse: it retired every reference on the line, and a second reference sharing it lost a true
   cut. Both proofs are now keyed by the place and the name they prove —`settledPlaceKey` by the name as written,
   `externalPlaceKey` by the rooted name.
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

> Retire **the reference**, never the line: the proof is keyed by its place *and* its rooted name
> (`impact-cuts.ts`, `externalPlaceKey`), because a line holds several references and retiring the line hides the ones
> the proof never covered. And retire it only when the root identifier has an import binding and the file declares no name
> spelled the same.

A retirement changes when `unresolved-link` is emitted, so it touches `RFC-0002` rule 2 and the completeness rule of
`RFC-0010`; it took its own record, `ADR-0019`. It moves a fact to `complete` only when the retired cut was the fact's
only one; on the measured application it shrank the list and left the status `partial`, and no symbol changed. The win is
the list, not a status claimed in general.

### B. The type layer read no `paths`, and this RFC named a wiring the architecture does not actually forbid

`type-resolution.adapter.ts` accepts `options?: ts.CompilerOptions` and `compilerOptions()` spreads them, so the field
worked; composition passed none, so the program resolved modules without the application's `paths`, `baseUrl` or
`extends`.

The symptom was a wrong answer, not a missing one: `AddressService`, a class of the application, was reported as
`external:@angular/core` at `location-picker.component.ts:49`. Measured then, 36 cut-place rows were a repository import
the checker called `external`.

**Fixed.** The adapter derives its options from the snapshot it already holds. `declaredOptionsOf`
(`module-resolver.ts`) reads the nearest `tsconfig`/`jsconfig` synchronously over the in-memory source map, `extends`
included, and rebases every path it produces under the program's synthetic root, so `paths` and `baseUrl` point at the
files the program actually has. `configOptions` is the only place the tree is parsed: `createModuleResolver` and the type
adapter both call it, so there is one parser for one fact and no second owner. Composition still passes nothing, which is
correct: it does not own the configuration.

**A correction to the paragraph this section used to carry.** It said the wiring was forbidden, and cited `AGENTS.md`,
which this repository does not have. The rule is `RFC-0001` layer table —`core/adapters` never imports another adapter—
together with `.dependency-cruiser.cjs`'s `adapters-are-independent`, which forbids reaching a **different** adapter
family while allowing reuse inside `adapters/typescript/`. `module-resolver.ts` is not an adapter under the project's own
definition: it has no process boundary and exports a function over a reader. `import-origins.adapter.ts` already imports
it in shipped code, the same shape. So no port is needed, and the `DeclaredModuleConfig` row below is retired.

| Shape | Cost | Verdict |
|---|---|---|
| Composition parses the config and passes `ts.CompilerOptions` | A second parser for one fact, beside `module-resolver.ts` | Rejected: two owners of one fact, which the project calls a defect |
| Extract config parsing into a port (`DeclaredModuleConfig`) with one adapter, consumed by both | A refactor of an existing module plus one port | **Retired**: `configOptions` already is the one parse, and a port would add a vocabulary without removing a parser |
| The adapter derives the options from the snapshot it is given, through the same parse | Nothing new; one function beside the resolver | **Shipped**: no second parser, no composition owned configuration, no new port |
| Stop asking the program to resolve modules and let `module-resolver` answer | Nothing new | Not taken: it answers `imports`, not the receiver a `this.x` call needs |

The fixture asserts it: a call whose specifier only the snapshot's own `paths` resolves reaches the repository
declaration, and one reached through an `extends` chain does too. Re-running the 36-row count needs the probe workspace
outside this repository; the fixtures are the proof that lives here.

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
| S9 | **Re-evaluate the port** (gaps B and C) — **measured, 2026-11-03**: does not earn its cost | The measured delta of S8 with the port and without it, after gaps B and C were fixed | `HEAD~5` 76→76 cuts, `HEAD~20` 190→187, `HEAD~60` 359→356, for +2,2 to +2,9 s and +300 to +480 MB. The section below records it |

S4 is superseded by S8 as the slice that changes an answer. Its wiring stays in the branch as the record of the
measurement and as the base of S9; nothing of it merges before S8 shows what it adds. What is left after S9 is not
another port: the remaining families are planned as S10 to S13 in "What would close the remaining families".

## S9 measured: the port buys 0 to 3 cuts

Measured on 2026-11-03 on the same application, commit `e8699653`, with S8, the coordinate guard and gap B in place, the
index already cached, two runs per cell, `--type-root <repo>/node_modules` as the root:

| Base | Cuts, no root | Cuts, with root | Places, no root | Places, with root | Symbols |
|---|---|---|---|---|---|
| `HEAD~5` | 76 | **76** | 126 | **126** | 586 → 587 |
| `HEAD~20` | 190 | **187** | 612 | **604** | 1.067 → 1.072 |
| `HEAD~60` | 359 | **356** | 5.836 | **5.819** | 2.495 → 2.542 |

| | No type root | With one | Delta |
|---|---|---|---|
| Query (index cached) | 3,02–3,66 s | 5,52–6,54 s | **+2,2 to +2,9 s** |
| `maximum resident set size` | 541–576 MB | 844–1.056 MB | **+300 to +480 MB** |

**Gap B does not cost a cut; it was measured against its own absence to say so.** With `declaredOptionsOf` reverted and the
same type root, the answers are identical at `HEAD~5` (76 cuts, 126 places, 586 symbols) and 359 cuts / 2.496 symbols at
`HEAD~60`, against 356 / 2.542 with it. So reading the snapshot's configuration retires **3 cuts and adds 46 symbols** on
the largest diff: it is a correctness fix, never a regression, and the earlier claim in this section that it weakened the
port was a comparison across two different bases (before and after S8), not a measurement of B.

### What the remaining cuts are

At `HEAD~5`, 76 cuts reach 126 places. Classified against the index and the shipped import proof:

| What the place is | Places | Of the 93 attributed references |
|---|---|---|
| `no-extractor`: the file's kind has no extractor | 33 (26%) | — |
| rooted at `this`/`super`, so it needs a receiver's type | — | 43 (46%) |
| a name the file declares itself, which the retirement refuses by design | — | 26 (28%) |
| neither imported nor declared: `console` 13, `caches` 6, `String`, DOM globals | — | 24 (26%) |

**The port settles 39 of those 93 references onto repository declarations, none external, and 54 it cannot settle.** None
of the 39 lands on a declaration the walk reached, and that is exactly why it removes no cut: a settlement retires a place
only when the walk expanded it, and an edge to a declaration nothing else reached changes no answer.

So a quarter of the remaining list is not a type question at all, nearly half is the receiver population the port was
supposed to rescue, and it resolves those references without any of them mattering to the walk. That is the measurement,
not an opinion: `+2,2 to +2,9 s` and `+300 to +480 MB` buy 0 to 3 places out of 126.

The three cuts `HEAD~5` reports over the 73 of `ADR-0019` are not a regression: keying a retirement by the line hid true
cuts that shared it, and the reference-scoped key restores them.

What this leaves is a decision, not a measurement: whether a capability that is inert without a host-supplied type root
and removes 0–3 cuts should stay shipped. The recommendation is to retire the port and `--type-root` in their own slice
and keep S8, which needs no root and removes 6% to 13% of the cuts on the same diff.

### The same numbers in the shape that runs as a server

Everything above is a **one-shot CLI** peak, and the process exits. A long-lived `serve`/`mcp` server was measured directly
on the same repository, four identical queries, sampling the resident set between them:

| | After query 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| No type root | 526 MB | 675 MB | 601 MB | 676 MB |
| With a type root | 804 MB | 1.054 MB | 1.155 MB | **1.481 MB** |

Without a root the process settles and oscillates: it keeps roughly the high-water mark of its largest query, because a
Node process does not hand freed heap back to the operating system. That is the steady state a user's editor holds while
the server is open, and it is already true today.

With a root it **grows by roughly 200 MB per query and does not settle**, to 1,5 GB after four. The `Program` is built
only once — instrumented, one build across those four queries — so the growth is not a second program; it is the live
program plus per-query allocations the collector never reclaims. The +300 to +480 MB of the one-shot table is therefore
the *optimistic* reading of the port's cost: in the shape the MCP actually runs, its cost is per query.

The syntax-only mechanisms do not change this envelope: `import-origins` is built per query and dropped, and the ambient
table is a fixed few hundred kilobytes.

## What would close the remaining families

The list above is not one problem. It is four, and only one of them is the type layer's. The rule that orders the work is
narrower than "remove the cut": **a place may stay in the list, but it may not name a declaration the reference was never
proven to reach.** That is `RFC-0002` rule 2 applied to what the emitter already knows, and it is what S8 started.

| # | Family at `HEAD~5` | Mechanism | Effect | Cost |
|---|---|---|---|---|
| S10 | 19 of the 24 unbound references: `console` 13, `caches` 6, `String` — **done, 2026-11-03** | A root the pinned `typescript` lib declares, and that the snapshot declares no global of, cannot name a repository declaration. Retire the place, as an ambient proof | Measured: `HEAD~5` 76→**64** cuts and 126→**107** places, `HEAD~20` 190→**176**, `HEAD~60` 359→**334**, no symbol changed | ~0: a generated table of 2.545 names, 57 KB, with a drift test |
| S11 | 26 references the file declares itself | Replace the file-level shadow refusal with an enclosing-scope check, conservative: a declaration in a scope that encloses the use keeps the `unknown` | **Measured, not shipped**: the file-level rule blocks only 2 of the 107 places at `HEAD~5` and none at `HEAD~20` or `HEAD~60`, and a scope check recovers neither, because both declarations enclose their use | ~0 folded into the parse `import-origins` already performs |
| S12 | every bare reference whose declaration lives in another file it never imported | A bare name is file-scoped: attribute it only to a declaration of its own file, or to the one its import binding names; otherwise cut the caller's file and name the reference | Measured: 7 of the 22 anchored places at `HEAD~5` stop naming a declaration they cannot reach; the list keeps its length | ~0: the same pass over the imports |
| S13 | 33 `no-extractor` places at `HEAD~5` (30,8% of them), 49 places and 16 `no-extractor` cuts at `HEAD~60` (1,1%) — **done, 2026-11-03** | The DI reader already knew the token it injects; `inject(TOKEN)` only became unreadable because a token is not a class. Relate the class to the token's declaration, as it already does for a class | Measured: `HEAD~5` 62→**37** cuts and 107→**78** places, `no-extractor` places 33→**4**; `HEAD~20` 172→**141**; `HEAD~60` 311→**273**, no symbol changed | Inside the extractor: one branch of the DI reader, no new parse |
| — | 43 receiver-rooted references | The one family that needs the checker, which S9 measured as not paying | — | +2,2 to +2,9 s and +300 to +480 MB per query, growing in a server |

Two rules hold for whichever of these lands:

1. **No slice claims completeness of its own.** S10 retires places, so a fact may move to `complete` when the retired cut
   was its only one; that is `ADR-0019` decision 5, not a new claim.
2. **S12 may not shorten the list.** Re-anchoring keeps the fact `partial`, because the reference still names something
   outside the answer. It removes the false attribution, which is the harm, not the count.

Measured cost of the syntax-only mechanisms on the same application (1.138 sources, 70 files holding cut places):

| | Latency | Memory |
|---|---|---|
| lib declared names parsed at runtime (107 files, 2.538 names) | 223–227 ms, once per process | set ~0,1 MB retained, ~100 MB transient peak |
| the same names as a precomputed table | ~0 | ~30 KB |
| a second syntax pass over the 70 files that hold places | 224–259 ms | ~25 MB transient, nothing retained |
| the same pass folded into `import-origins`'s own parse | ~0 marginal | 0 |
| `createDeclarationLookup` over a repository import | ms per file, lazy | ~0 |

None of these empties the list. The receiver population needs a type and the `no-extractor` population needs an extractor.
What S10 to S12 buy is a list that never names a declaration it cannot prove, at a cost the process already pays.

### S10 measured

Shipped 2026-11-03. The table is generated from the installed pin (`scripts/lib-globals.ts`) and a test fails while it
drifts, so the names can never disagree with the compiler that would answer the same question. The snapshot's own global
declarations are read from its `.d.ts` files and from any file that augments the global scope, so a repository that spells
a lib name itself keeps its cut.

| Base | Cuts | Places | Symbols |
|---|---|---|---|
| `HEAD~5` | 76 → **64** (−15,8%) | 126 → **107** (−15,1%) | 586 → 586 |
| `HEAD~20` | 190 → **176** (−7,4%) | 612 → **576** (−5,9%) | 1.067 → 1.067 |
| `HEAD~60` | 359 → **334** (−7,0%) | 5.836 → **5.765** (−1,2%) | 2.495 → 2.495 |

No symbol moved, which is the point: this proof removes noise and never expands an answer. Cost: none measurable — the
table is 57 KB of source compiled into the process and the snapshot's global check is a substring scan over the texts the
adapter already holds.

### S11 measured, and not shipped

The scope-aware shadow rule was implemented and measured before being kept, and it changed nothing: `HEAD~5` stayed at
64 cuts and 107 places, and the two larger diffs were identical. The reason is not the rule but the population. Removing
the shadow refusal altogether — the most permissive version — retires only **2 of the 107 places**, and both declarations
enclose their use, so no scope check can recover them. The file-level refusal `ADR-0019` decision 3 chose therefore costs
**1,9% of the places at `HEAD~5` and nothing at the other two bases**, not the 6% of retirements that decision estimated
from the probe rows. The simpler rule stays and `ADR-0019` is corrected.

### S12 measured

Shipped 2026-11-03. A bare name cannot leave its file: an unresolved `params()`, `onClick()` or `write()` was attributed to
a declaration of that name in an unrelated file the reference never imported. Measured at `HEAD~5`, those attributions were
`params` in `paginated-resource.ts` read as `order-checkout.store.ts::params`, and `onClick` in a map control read as
`dialog.component.ts::onClick`.

| Base | Cuts | Places | Anchored places | Symbols |
|---|---|---|---|---|
| `HEAD~5` | 64 → **62** | 107 → 107 | 22 → **15** | 586 → 586 |
| `HEAD~20` | 176 → **172** | 576 → **567** | — | 1.067 → 1.067 |
| `HEAD~60` | 334 → **311** | 5.765 → **5.729** | — | 2.495 → 2.495 |

The list keeps its length: 7 places leave a declaration for the caller's file, where the reference is named. The places
that disappear are duplicates — one place was listed under every homonym of that name, and it is now listed once. No
symbol moved, because nothing became reachable that was not.

**What is left is only the receiver population and the extractor's own gaps.** No further syntax proof can shorten the
list: a `this.svc.get` whose receiver type is not written in the syntax needs the checker, and S9 measured the checker as
not paying.

### S13 measured

Shipped 2026-11-03. The population was not the route extractor at all: all 33 places at `HEAD~5` were `inject(TOKEN)`
field initializers, and the DI reader already resolved the token — it only refused to relate a class to anything that is
not a class, so an `InjectionToken` became an unreadable relation and its place a cut. Relating the class to the token's
declaration is the same `injects` relation the reader already emitted for a service.

| Base | Cuts | Places | `no-extractor` places | Symbols |
|---|---|---|---|---|
| `HEAD~5` | 62 → **37** (−40,3%) | 107 → **78** | 33 → **4** | 586 → 586 |
| `HEAD~20` | 172 → **141** (−18,0%) | 576 → **530** | 49 → **4** | 1.067 → 1.067 |
| `HEAD~60` | 311 → **273** (−12,2%) | 5.729 → **5.683** | 49 → **3** | 2.495 → 2.495 |

The four places that remain are `inject(ElementRef<HTMLElement>)`: the argument is a type instantiation, so the reader
cannot name it and the cut stays, which a fixture pins. No symbol moved, because a token is a value nothing calls.

This was the largest cut reduction after S8, and it came from a branch of code that already had the answer.

## How these costs were measured

Every number above is a **peak RSS** and a wall clock taken from one-shot CLI runs with the index already cached:

```bash
/usr/bin/time -l node --import tsx src/composition/main.ts impact <repo> --base HEAD~5 > /dev/null
```

`maximum resident set size` is what the process actually held at its peak, never the virtual size. It is a property of a
one-shot run, where the process ends with that peak; a long-lived daemon keeps only what its queries still reference, and
a memoized `Program` is one of the few things that stays.

A delta is reported only when the two configurations' runs or their ranges do not overlap, which is why the type root's
+387 MB, the import binding's +128 MB and S9's +2,2 to +2,9 s are stated as numbers. A single run is never the evidence.

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
| 11 | Where does the module configuration come from, if the type layer stays? | **Answered by the snapshot itself.** `declaredOptionsOf` reads the nearest `tsconfig`/`jsconfig` from the sources the adapter already holds, and `configOptions` is the one parse both it and `module-resolver` call. No port, no composition-owned configuration, and no second parser. The `DeclaredModuleConfig` port the earlier draft recommended is retired: `module-resolver` is a helper without a process boundary, not an adapter, and reuse inside `adapters/typescript/` is what `import-origins` already does |
