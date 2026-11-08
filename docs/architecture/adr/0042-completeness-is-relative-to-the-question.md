# ADR-0042: A fact's completeness is relative to what its answer asserts, and every cut states why it exists

- Status: Proposed, 2026-11-08
- Decision source: pending the owner. The tech lead asked, on 2026-11-08, for one design per base proposal after the
  MCP evaluation of that day; this one is "completeness relative to the question: every cut carries a typed reason and a
  scope, and a fact's completeness is computed only over what the answer asserts, so `partial` keeps meaning something".
- Related: amends [RFC-0002](../rfc/0002-facts-contract.md) (envelope, rules 1 and 2); generalizes
  [ADR-0019](0019-cuts-retired-on-a-proven-external-target.md); [ADR-0013](0013-coverage-grows-only-with-evidence.md)
  rule 7, [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md), [ADR-0041](0041-one-call-reconciliation-for-every-family.md)

**In short:** today any cut a query meets anywhere in the snapshot makes the whole answer `partial`, and no cut says
why it exists. Measured on the 2026-11-08 evaluation, 55 of 94 answers are `partial`, 681 cuts reach the agent and none
carries a typed reason. Every cut gets a required reason from a closed set and a typed reach (what it could hide); each
family declares what its answer asserts; a cut degrades the answer only when its reach can hold an asserted item, by
positive proof, failing closed. A construct read but not resolved is an item, never also a cut. `partial` then means "a
place that could hold part of this answer was not reached", and the status line states undecided items instead of
printing a bare `complete`.

## Context

### What was measured

Evidence: the cold answers of `ye-ast_test/evaluations/runs/20261108T140500Z-current-quality-petclinic-jhipster-k7q2`
and `.../20261108T1400Z-current-quality-nname-realworld-q7k2` (engine `be0d6084`), plus CLI re-runs of the same
requests at `main` `9961fd13` with JSON output, one at a time, on nname and realworld only.

| Family | Answers | `partial` | Cuts in partial answers | Cause of `partial`, classified from the facts |
|---|---|---|---|---|
| trace | 21 | 20 | 338 `unresolved-link` | Every cut sits on the walk. NO-TR-2 re-run (51 cuts): 22 member calls whose receiver is not proven (candidates by name), 10 calls with no candidate (`List.of`, `Objects.requireNonNullElse`, stream chains), 9 constructions, 7 bare calls, 2 dispatch, 1 other; 49 carry no reason, 2 carry `detail: "dispatch not proven"` |
| contract_consequences | 25 | 19 | 19 `section` | 12 only because the workspace's cuts are copied into every answer (realworld 7: one unresolved call site, already listed as an `unknown` finding of each answer; nname 5: NATS event publishers and HTTP sites already listed as findings). 7 wrap a single answer that is itself `unknown` ("no repository of the workspace serves …") |
| callers | 9 | 3 | 173 `unresolved-link`, 1 `section` | NW-CAL-1 re-run: 174 cuts, all qualified references whose name tail matches a walked declaration; 733 of their 891 places match only a declaration at depth 11 (`set`), 9 places a declaration at depth ≤ 1. RW-CAL-1: one reference `this.articleStore.getArticle` (in question). RWB-CAL-1: the frontend section, from the same realworld call site |
| impact | 4 | 3 | 100 `unresolved-link`, 2 `no-extractor` | NW-IMPACT-1 re-run (89 cuts): 28 are unresolved module specifiers anywhere in the base and head snapshots (`geojson` ×24, `@/environments/environment` ×4) that resolve to no reached module; 61 are references to walked declarations. RW-IMPACT-1: an unresolved import of a walked component (in question). IMP-JH-1 not classified |
| importers | 5 | 2 | 22 `unresolved-link` | 22 of 22 outside the question: TypeScript build specifiers (`esbuild`, `chrome-launcher`) for a Java file; `geojson` and `@/environments/environment` for `auth-hint.service.ts` |
| workspace, decisions | 13 | 7 | 25 `section` | Realworld (2): its one section cut is the unresolved call site that the same section also lists as an `unresolved` item. nname and petclinic microservices (5): sections led by NATS event sites; other cut kinds not verified |
| outline | 8 | 1 | 1 `unresolved-link` | The outlined file's own wildcard import, also rendered inline as `unresolved` |
| entrypoints | 9 | 0 | 0 | Complete; PCN carries 20 `unknown (no-extractor)` routes and prints `status: complete` |

Totals: 55 of 94 answered queries are `partial` (8 more are faults). Of the 55, 16 are `partial` only through cuts
outside what the answer asserts or through an item counted a second time as a cut (importers 2, contract 12, realworld
workspace and decisions 2), 6 more probably so (5 nname and petclinic microservice workspace and decisions answers,
RWB-CAL-1: not fully verified), 7 wrap an `unknown` answer, 25 have cuts inside the question (trace 20, NW-CAL-1,
NW-IMPACT-1, NO-OUT, RW-CAL-1, RW-IMPACT-1), and 1 is not classified (IMP-JH-1). Of the 681 cuts, none reaches the agent
with a typed reason.

### The mechanisms

1. **One status for the whole snapshot.** `withCuts` (`src/core/domain/shared/fact.ts:253-259`) makes a fact `partial`
   when any cut is passed in, and every family passes repository-wide cuts:
   - importers: every unresolved module specifier of the snapshot and every file the index did not hold
     (`src/core/application/impact/impact-queries.ts:279-289`), whatever file was asked;
   - impact: every unresolved specifier of base and head (`src/core/domain/impact/module-impact.ts:39-48`);
   - outline and trace: every file the index did not hold, and the export's cuts
     (`src/core/application/outline/outline-queries.ts:51,74-80`, `src/core/application/trace/trace-queries.ts:175-184`);
   - contract consequences: every cut of the workspace fact goes into every hypothesis answer
     (`src/core/application/contracts/contract-consequences-queries.ts:112`, from
     `src/core/application/contracts/consumer-sources.ts:179`).
2. **One place, two encodings.** RFC-0002 rule 2 and ADR-0013 rule 7 say that a construct an extractor reads but cannot
   resolve is an `unknown` item, not a cut. The workspace makes each unresolved call site both an `unresolved` item and
   an `unresolved-link` cut of its section (`src/core/application/topology/workspace-queries.ts:200-207`), and an
   ambiguous join a cut only (`src/core/domain/topology/call-site.ts:150-152`). Contract consequences then inherit the
   cut and list the same site as an `unknown` finding.
3. **No reason.** `Cut` (`src/core/domain/shared/fact.ts:145-167`) has an optional `detail` with three literals, an
   optional `reason` typed as `UnknownReason`, and ten kinds. Trace emits every situation (receiver not proven, no
   candidate, construction, dispatch, effect not placed, page member missing) as `unresolved-link`
   (`src/core/application/trace/trace-walk.ts:236-239,272-275,451,600-606`); only dispatch sets `detail` (`:338`).
4. **What the renderer drops.** The status line prints counts per kind (`src/mcp/presentation-context.ts:33-37`);
   trace groups cuts by name and candidates (`src/mcp/render.ts:1257-1262`). Nothing under `src/mcp` reads
   `Cut.detail` or `Cut.reason`, so even the two dispatch reasons never reach the agent, as the evaluation noted ("The
   cut gives no reason (despite the 'dispatch cut reasons' commit)").
5. **`complete` hides undecided items.** Under rule 2 a collection with `unknown` items is `complete`, and the status
   line prints `status: complete` (`src/mcp/presentation-context.ts:34`). The evaluation read that as a misleading
   verdict: contract J1 is `complete` with only `unknown` findings, and callers on Angular code reaches 0 entrypoints
   while the map holds 20 `unknown` routes.

### Verdict on the hypothesis

- **Confirmed** for importers, outline, impact's module walk, contract consequences, workspace and decisions:
  repository-wide cuts and double-encoded items degrade answers they cannot affect.
- **Refuted** for trace, and mostly for callers and impact's symbol walk: their cuts lie on what the answer asserts.
  Their `partial` is true; it is unreadable because no cut says why it exists. Their volume belongs to resolution
  (ADR-0041 and the receiver and dispatch work), not to this mechanism.
- **Confirmed** that no cut states why it exists: 0 of 681 reach the agent with a typed reason.

So the root cause is two mechanisms, not one: completeness is computed over the snapshot instead of over the answer,
and a cut is a place without a cause. Fixing only the first leaves trace unreadable; fixing only the second leaves
importers and contract answers `partial` for files and transports they cannot reach.

## Options weighed

| Option | For | Against |
|---|---|---|
| A. Document that `partial` is normal | No code | No mechanism; the agent still cannot tell a gap that matters from one that cannot |
| B. Rank cuts by severity | Short status | A severity is an opinion, not a fact; no rule decides it without heuristics |
| C. Stop emitting noisy cut classes (signal reads, builders, library calls) | Fewer cuts | One rule per construct: the drawer of rules ADR-0039 exists to stop; risks false `complete` where the class is not proven external (ADR-0019 already covers the provable part) |
| D. Make a collection with `unknown` items `partial` | `complete` never hides an unknown | `partial` becomes universal again (entrypoints 9 of 9, jhipster contract answers) and means two things: not reached, or reached and undecided |
| E. Several statuses per fact (one per claim) | Most precise | More output and more decisions per family before any measurement; deferred to open question 3 |
| F. Partial only above a number of cuts | Simple | A size threshold: forbidden by the design pillars |
| **G. Typed reason and reach per cut; each family declares what it asserts; a cut counts only when its reach can hold an asserted item, by positive proof; one encoding per place; undecided items stated** | Fixes the mechanism for every family; a `partial` says where and why; fails closed | A reach proof per cut source; every emitter changes; risk of a false `complete` if a proof is wrong (see Risks) |

## Decision

1. **Every cut states why it exists.** `Cut` gains a required `reason` from one closed union in
   `core/domain/shared/fact.ts`, replacing the optional `detail` and the optional `UnknownReason`. A bound kind
   (`depth`, `hub`, `caller-budget`, `node-cap`, `deadline`) is its own reason. The other kinds take one reason per
   situation an emitter meets; the initial set, from the emitters found today:

   | Kind | Reasons |
   |---|---|
   | `no-extractor` | `language` (no extractor for the file's language), `not-indexed` (the index skipped or failed the file), `unmodelled` (a construct no extractor models), `template-uncovered`, `module-unread` |
   | `not-exported` | `symlink`, `unsafe-path`, `case-collision`, `submodule` |
   | `build-output` | `version-mismatch`, `link-outside`, `live-tree` |
   | `unresolved-link` | `specifier` (a module specifier the resolver did not resolve), `dynamic-load`, `hidden-caller` (an unresolved reference names a walked declaration), `receiver-unproven` (candidates are the declarations of the name), `callee-unknown` (no candidate, not proven external), `dispatch` (with the existing three details as sub-reasons), `effect-unplaced`, `removed-declaration`, `join-unsettled` |
   | `section` | none: the section's own fact carries its cuts or its `unknown` reason |

   Each emitter maps to exactly one reason; a new situation adds a member to the union in the commit that emits it.
   The union stays closed and small, because its members are rendered as counts.
2. **Every cut states what it could hide.** `Cut` gains a typed `reach`, set by the emitter from data it already holds:
   `anything` (with the file's runtime when known), `callers-of` (declaration anchors), `call-at` (a place inside a
   walked body), `module` (the specifier, its importing file, and whether the resolver classified it as a package),
   `operation` (transport, and method or literal path prefix when known). An emitter that cannot fill a narrower reach
   sets `anything`.
3. **Each family declares what its answer asserts**, as a value its use case builds from the request and the walk, in
   the family's domain:

   | Family | Asserts | A cut is in question when its reach can hold |
   |---|---|---|
   | importers | importers and users of the asked files | an import or use of an asked file: a specifier the resolver's own rules could resolve to it, a dynamic load or an unread file sharing its runtime |
   | outline | declarations and imports of the asked files | a place in an asked file, or an asked file not read |
   | callers, impact | the dependents reached, their entrypoints, the modules reached | a caller of a walked declaration, an edge into a walked module, a file sharing the runtime of a walked file |
   | trace | the steps and effects of the walk | a call inside a walked body, or a file sharing the runtime of a walked file |
   | contract consequences | consumers and producers of the operation and their uses of the property | a call of that operation: same transport, and no known method or literal prefix that excludes it |
   | workspace, decisions, entrypoints | the whole topology or map | every cut (no change) |

   Every bound and every export cut (`caller-budget` of the export, `not-exported` of a submodule) is in question for
   every family, since what it left out is unknown.
4. **A cut is out of question only by positive proof, and the proof fails closed.** One pure function
   `inQuestion(cut, asserted)` in `core/domain/shared` decides it: a reach of `anything` without a runtime, a missing
   datum, or a proof that needs a rule the resolver did not apply, keeps the cut in question. A runtime proof reuses
   `sharesRuntime` (`src/core/domain/languages/call-targets.ts:16-20`); a specifier proof reuses the resolver's own
   classification (path mapping, package, relative), never a file name heuristic. This generalizes ADR-0019, whose
   proof that a reference names an external target is one such proof.
5. **Status over the question.** `withCuts` takes the asserted value and keeps only the cuts in question; the fact is
   `complete` when none is left. A cut out of question is not emitted, as ADR-0019 already does for a proven external
   target: it bounds no part of this answer, and listing it is the noise this decision removes. Its effect stays
   visible in the conformance fixtures and in the corpus gate's report.
6. **One place, one encoding.** A construct read but not resolved is an `unknown` item of the collection that owns it,
   never also a cut (RFC-0002 rule 2, ADR-0013 rule 7). An unresolved or unsettled call site is an item of its
   workspace section; a composite that reads another fact's items (contract consequences) takes the items that can
   belong to its question as findings, and the other fact's cuts only through rule 5.
7. **Undecided items are stated.** RFC-0002 rule 2 stands: a collection that reached every place that could hold an
   item is `complete`, even with `unknown` items. The renderer never prints a bare `complete` for it: the status line
   reads `complete (N undecided)`, counted from the items the family asserts. A composite whose only section is
   `unknown` prints that section's status and reason, not `partial (cuts: 1 section)`.
8. **Rendering of cuts.** The status line counts in-question cuts by kind and reason (`partial (cuts: 20
   unresolved-link receiver-unproven, 2 unresolved-link dispatch)`); `details` prints the reason on every cut row.
9. **No schema bump.** The fields change without a `SCHEMA` bump and without compatibility code while the MCP has no
   consumers.

### Relation to RFC-0002

This ADR amends RFC-0002 explicitly, without superseding it:

- the envelope's `Cut` gains `reason` (required, closed) and `reach`;
- rule 1 reads "a fact a bound cut is `partial` and lists every cut that could hold an item its answer asserts";
- rule 2 adds "a place is an item or a cut, never both", and that the status line states undecided items;
- rule 4 (completeness relative to the declared scope) is unchanged: the question narrows completeness inside the
  declared scope, never beyond it.

## How a family declares what it asserts

A family's use case builds its asserted value next to the walk it already runs, and passes it to `withCuts`:

```ts
// core/domain/shared/fact.ts
type Asserted =
  | { kind: "files"; files: readonly string[] }                     // importers, outline
  | { kind: "walk"; declarations: readonly string[]; files: readonly string[]; modules: readonly string[] } // callers, impact, trace
  | { kind: "operation"; transport: string; method: string; path: string }  // contract consequences
  | { kind: "everything" };                                           // map, workspace, decisions

function withCuts<T>(base: FactBase, value: T, cuts: readonly Cut[], asserted: Asserted): CompleteFact<T> | PartialFact<T>;
```

The emitter fills `reach`; the family fills `asserted`; `inQuestion` is the only owner of the rule. A family that
cannot yet state what it asserts passes `everything`, which keeps today's behavior.

## Migration

Each unit is one behavior with its tests, passes `npm run check`, and passes the corpus gate with the moves declared.
Expected moves come from the evaluation above; the gate's report is the proof.

| Unit | Change | Gate expectation |
|---|---|---|
| U1 | Required `reason` and `reach` on every emitter; `withCuts` still keeps every cut | `<family>:+` for every family with cuts (a field added to each cut); no status changes |
| U2 | Render reasons in the status line and in `details`; `complete (N undecided)`; a composite over one `unknown` section prints it (only `src/mcp`) | not gated (outside `src/core`); MCP tests |
| U3 | One encoding: workspace call sites become items only; contract consequences take items as findings | `workspace:±`, `decisions:±`, `contract-consequences:±`, `callers:±` (workspace callers). Expected: realworld workspace, decisions and 7 contract answers become `complete (N undecided)` |
| U4 | `inQuestion` and `asserted` for importers and outline | `importers:±`, `outline:±`. Expected: both importers partials of the evaluation become `complete`; outline unchanged on its one case |
| U5 | Impact's module walk and the symbol walks of callers, impact and trace: specifier and runtime reach | `impact:±`, `callers:±`, `trace:±`. Expected: NW-IMPACT-1 loses its 28 specifier cuts and stays `partial` (61 in question); trace and callers keep their in-walk cuts |
| U6 | Contract consequences: operation reach over the workspace's remaining cuts | `contract-consequences:±`. Expected: the 5 nname answers lose their event-transport cuts |

U1 lands first because every later unit reads `reason` and `reach`; U3 before U6 because U6 assumes items no longer
arrive as cuts.

## Conformance fixtures

Each fixture names the rule it guards; the negative ones guard the golden rule.

1. Importers of a Java file with an unresolved TypeScript specifier elsewhere: `complete`.
2. Importers of a TypeScript file with an unresolved specifier that a path mapping pattern of the snapshot could resolve
   to it: `partial` with reason `specifier` (fails closed).
3. Importers of a TypeScript file with a non-literal dynamic import in the same runtime: `partial`, `dynamic-load`.
4. Outline of a file while another file of the commit has no extractor: `complete`; outline of a file the index did not
   hold: `partial`, `not-indexed`.
5. A workspace section with one unresolved call site: one `unknown` item, no cut, `complete (1 undecided)`.
6. A contract hypothesis on HTTP with an unresolved event call site in a consumer: `complete`; with an unresolved HTTP
   call site of unknown method: one `unknown` finding, `complete (1 undecided)`; with a consumer file in a runtime
   without extractor: `partial`, `language`.
7. Every bound (`depth`, `hub`, `caller-budget`, export `caller-budget`, `deadline`) keeps the answer `partial` for
   every family, whatever the asserted value.
8. A cut whose reach is `anything` without a runtime keeps every family `partial`.
9. A trace dispatch cut renders its reason in summary and details.

## Consequences

- `partial` means that a place that could hold part of this answer was not reached, and says why. On the evaluation,
  16 of 55 `partial` answers (up to 22 with the unverified ones) become `complete` or `complete (N undecided)`, and 7
  print as the `unknown` answer they wrap; trace stays `partial` where its walk truly stops, now with a reason per cut.
- Fewer cuts reach the agent where they cannot matter (importers: 22 to 0 on the evaluation; NW-IMPACT-1: 89 to 61).
- Every emitter changes once (U1); `withCuts` gains one argument; one shared predicate owns relevance.
- Trace and callers volume is not reduced by this ADR: it is resolution work (ADR-0041 and the receiver and dispatch
  designs). Their cuts become legible, not fewer.

## Risks

- **A false `complete`.** A reach proof that is wrong turns a true unknown into `complete`: an unresolved specifier a
  path mapping, a package `exports` map or a workspace package link could resolve to the asked file; a file without
  extractor in a runtime that does call into the asked one (Kotlin into Java, JavaScript into TypeScript); an event
  call site the workspace mislabels. Mitigations: proofs only from the resolver's own classification and
  `sharesRuntime`; a missing datum fails closed; fixtures 2, 3, 6 and 8; the gate fails on any status change not
  declared `±`, and each one is reviewed in the report.
- **Noise moved, not removed.** A reason union that grows per case becomes its own drawer of rules. The union is closed,
  rendered as counts, and a new member needs an emitter that cannot use an existing one.
- **Hidden context.** Dropping an out-of-question cut hides it from a caller who wanted the whole snapshot's coverage.
  That question belongs to `entrypoints` and `workspace`, which assert everything and keep every cut.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | RFC-0002 rule 2, "complete with only unknowns": should a collection with `unknown` items stay `complete`? | Yes, with decision 7: `complete (N undecided)` on the status line. Making it `partial` (option D) gives `partial` two meanings and makes it universal again |
| 2 | Drop out-of-question cuts, or keep them in a separate list? | Drop them (decision 5), as ADR-0019 does; the gate report and fixtures carry the evidence |
| 3 | One status per claim (trace effects vs steps; callers direct vs transitive)? | Not now. After U5, measure on the corpus how many trace partials have only `receiver-unproven` cuts whose candidates are all walked and effect-free, and how many callers cuts reach only depth > 1; decide with those numbers |
| 4 | Does a `section` cut carry a summary of its section's reasons? | No: the section's own fact holds them, and the renderer reads it (decision 7) |

## Not decided here

- Resolution that removes trace and callers cuts (receivers, dispatch, library calls): ADR-0041 and the designs that
  follow it.
- The coverage gap of Angular `RouterModule.forChild` routes: framework coverage under ADR-0013.
- Unverified in this design: the causes of the nname and petclinic microservice workspace sections beyond their event
  call sites, and the jhipster impact case (IMP-JH-1).
