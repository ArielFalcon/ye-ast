# ADR-0042: A fact's completeness is relative to what its answer asserts, and every cut states why it exists

- Status: Proposed, 2026-11-08; open questions closed 2026-11-09
- Decision source: the owner, 2026-11-08, verbatim: "lanza un agente con esfuerzo high por cada propuesta para que la
  analice conjuntamente con la evidencia, que investigue y proponga un ADR de cambio". Translated: launch one
  high-effort agent per proposal to analyse it together with the evidence, investigate, and propose an ADR of change.
  This proposal was "completeness relative to the question: every cut carries a typed reason and a scope, and a fact's
  completeness is computed only over what the answer asserts, so `partial` keeps meaning something".
  On closing it, 2026-11-09, verbatim: "Cierra los 3 ADR pendientes con lo que recomiendes para las preguntas
  pendientes. Que se revisen con sol high y se queden aprobados y listos. Ten en cuenta los cambios que aplicará 0045 por
  si debe cambiar algo en estos". Translated: close the three pending ADRs with what you recommend for the pending
  questions; have them reviewed and left approved and ready; take into account the changes ADR-0045 will apply, in case
  something here must change.
- Related: amends [RFC-0002](../rfc/0002-facts-contract.md) (envelope, rules 1 and 2); generalizes
  [ADR-0019](0019-cuts-retired-on-a-proven-external-target.md); [ADR-0013](0013-coverage-grows-only-with-evidence.md)
  rule 7, [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md), [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0045](0045-one-assembly-line-for-the-snapshot-reading.md) (decision 10 here)
- Revisions: measurements come from the evaluation engine `be0d6084` and CLI re-runs at `9961fd13`. Code citations
  (`path:line`) were written against `main` at `ac475e50` and re-verified against `main` at `8c5f181a` on 2026-11-09: the
  trace rows moved with ADR-0041's alignment and binder commits (`69337f5b`, `c2861dba`), which also made trace emit the
  `contradicted` and `unowned` cuts this design had listed as future. The open questions became decisions 5, 7, 1 and
  11.

**In short:** today any cut a query meets anywhere in the snapshot makes the whole answer `partial`, and no cut says
why it exists. Measured on the 2026-11-08 evaluation, 55 of 94 answers are `partial`, 681 cuts reach the agent and none
carries a typed reason. Every cut gets a required reason from a closed set and a typed reach (what it could hide); each
family declares what its answer asserts; a cut degrades the answer only when its reach can hold an asserted item, by
positive proof from the rule that already owns that question, failing closed. An enumerated topology item the workspace
cannot resolve is an item, never also a cut; a walk's frontier stays a cut. `partial` then means "a place that could
hold part of this answer was not reached", and the status line states undecided items instead of printing a bare
`complete`. Reasons and reach are filled from the outputs of ADR-0045's assembly line; the question is the family's;
the work lands as one feature after ADR-0045 L1b and before L2.

## Context

### What was measured

Evidence: the cold answers of `ye-ast_test/evaluations/runs/20261108T140500Z-current-quality-petclinic-jhipster-k7q2`
and `.../20261108T1400Z-current-quality-nname-realworld-q7k2` (engine `be0d6084`), plus CLI re-runs of the same
requests at `main` `9961fd13` with JSON output, one at a time, on nname and realworld only.

| Family | Answers | `partial` | Cuts in partial answers | Cause of `partial`, classified from the facts |
|---|---|---|---|---|
| trace | 21 | 20 | 338 `unresolved-link` | Every cut sits on the walk. NO-TR-2 re-run (51 cuts): 22 member calls whose receiver is not proven (candidates by name), 10 calls with no candidate (`List.of`, `Objects.requireNonNullElse`, stream chains), 9 constructions, 7 bare calls, 2 dispatch, 1 other; 49 carry no reason, 2 carry `detail: "dispatch not proven"` |
| contract_consequences | 25 | 19 | 19 `section` | 12 only because the workspace's cuts are copied into every answer (realworld 7: one unresolved call site, already listed as an `unknown` finding of each answer; nname 5: NATS event publishers and HTTP sites already listed as findings). 7 wrap a single answer that is itself `unknown` ("no repository of the workspace serves …") |
| callers | 9 | 3 | 173 `unresolved-link`, 1 `section` | NW-CAL-1 re-run: 174 cuts, all qualified references whose name tail matches a walked declaration; 733 of their 891 places match only a declaration at depth 11 (`set`), 9 places a declaration at depth ≤ 1. RW-CAL-1: one reference `this.articleStore.getArticle` (in question). RWB-CAL-1: the frontend section, from the same realworld call site, here an undecided call that may reach the walked handler: a frontier (decision 6), in question |
| impact | 4 | 3 | 100 `unresolved-link`, 2 `no-extractor` | NW-IMPACT-1 re-run (89 cuts): 28 are unresolved module specifiers anywhere in the base and head snapshots (`geojson` ×24, `@/environments/environment` ×4) that resolve to no reached module; 61 are references to walked declarations. RW-IMPACT-1: an unresolved import of a walked component (in question). IMP-JH-1 not classified |
| importers | 5 | 2 | 22 `unresolved-link` | 22 of 22 outside the question: TypeScript build specifiers (`esbuild`, `chrome-launcher`) for a Java file; `geojson` and `@/environments/environment` for `auth-hint.service.ts` |
| workspace, decisions | 13 | 7 | 25 `section` | Realworld (2): its one section cut is the unresolved call site that the same section also lists as an `unresolved` item. nname and petclinic microservices (5): sections led by NATS event sites; other cut kinds not verified |
| outline | 8 | 1 | 1 `unresolved-link` | The outlined file's own wildcard import, also rendered inline as `unresolved` |
| entrypoints | 9 | 0 | 0 | Complete; PCN carries 20 `unknown (no-extractor)` routes and prints `status: complete` |

Totals: 55 of 94 answered queries are `partial` (8 more are faults). Of the 55, 16 are `partial` only through cuts
outside what the answer asserts or through an item counted a second time as a cut (importers 2, contract 12, realworld
workspace and decisions 2), 5 more probably so (nname and petclinic microservice workspace and decisions answers: not
fully verified), 7 wrap an `unknown` answer, 26 have cuts inside the question (trace 20, NW-CAL-1, NW-IMPACT-1, NO-OUT,
RW-CAL-1, RW-IMPACT-1, RWB-CAL-1), and 1 is not classified (IMP-JH-1). Of the 681 cuts, none reaches the agent with a
typed reason.

### The mechanisms

1. **One status for the whole snapshot.** `withCuts` (`src/core/domain/shared/fact.ts:254-259`) makes a fact `partial`
   when any cut is passed in, and every family passes repository-wide cuts:
   - importers: every unresolved module specifier of the snapshot and every file the index did not hold
     (`src/core/application/impact/impact-queries.ts:279-290`), whatever file was asked;
   - impact: every unresolved specifier of base and head (`src/core/domain/impact/module-impact.ts:39-48`);
   - outline and trace: every file the index did not hold, and the export's cuts
     (`src/core/application/outline/outline-queries.ts:52,75-81`, `src/core/application/trace/trace-queries.ts:113-116,177-186`);
   - contract consequences: every cut of the workspace fact goes into every hypothesis answer
     (`src/core/application/contracts/contract-consequences-queries.ts:112`, from
     `src/core/application/contracts/consumer-sources.ts:179`).
2. **One place, two encodings.** RFC-0002 rule 2 and ADR-0013 rule 7 say that a construct an extractor reads but cannot
   resolve is an `unknown` item, not a cut. The workspace makes each unresolved call site both an `unresolved` item and
   an `unresolved-link` cut of its section (`src/core/application/topology/workspace-queries.ts:199-207`, the cut at
   `:204`), and an ambiguous join a cut only (`:200,205`, `src/core/domain/topology/call-site.ts:150-152`). Contract
   consequences then inherit the cut and list the same site as an `unknown` finding.
3. **No reason.** `Cut` (`src/core/domain/shared/fact.ts:145-167`) has an optional `detail` with three literals (`:160`),
   an optional `reason` typed as `UnknownReason` (`:161`), and ten kinds. Trace emits every situation as
   `unresolved-link`: a call no rule settles (`src/core/application/trace/trace-walk.ts:215-218`, called at
   `:386,452,459,462,564`), a call settled by name only (`:392`), a receiver held by a value (`:537-543`), a construction
   without one constructor (`:532`), a record the reconciliation contradicts (`:369`), a written call no index body owns
   (`:454`), a function value run (`:583`), dispatch (`:251-254`), a page without plan (`:612,661`,
   `src/core/application/trace/page-plans.ts:29,37,44,51`), an unplaced handler
   (`src/core/application/trace/trace-queries.ts:235,254`), an unplaced effect
   (`src/core/domain/trace/trace-effects.ts:25,28`). Only dispatch sets `detail` (`trace-walk.ts:317`).
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

### What ADR-0045 changes around this design

ADR-0045 (Accepted 2026-11-09) makes one owner, `BaseReading` in `core/application/snapshot/`, assemble the evidence
every family reads (stages B0 to B12), with one language pack per language that declares the stages it cannot
implement as absent capabilities. Four of its effects reach this ADR:

- some cut emitters move: the typed reading, which emits the `build-output` cuts (`impact-queries.ts:168-181`), becomes
  stage B7 of the line (ADR-0045 L1), and the reference proofs move to `navigation` (ADR-0045 decision 1);
- the families keep their own policies over the line's answers (ADR-0045 decision 5, "narrow or add"), and the line
  itself changes no answer shape (ADR-0045 decision 11), so it never builds a cut;
- an absent capability must answer a statement, never silence: "`unknown` per site, … a `no-extractor` cut for a file
  no pack reads, or the cut the family's policy makes for an unproven link (ADR-0042 reach applies)" (ADR-0045
  decision 12);
- L2 (ADR-0041 U5) and L3 widen the proofs of `importers`, `outline` focus, contract consequences and trace, so they move
  the same families this ADR moves.

## Options weighed

| Option | For | Against |
|---|---|---|
| A. Document that `partial` is normal | No code | No mechanism; the agent still cannot tell a gap that matters from one that cannot |
| B. Rank cuts by severity | Short status | A severity is an opinion, not a fact; no rule decides it without heuristics |
| C. Stop emitting noisy cut classes (signal reads, builders, library calls) | Fewer cuts | One rule per construct: the drawer of rules ADR-0039 exists to stop; risks false `complete` where the class is not proven external (ADR-0019 already covers the provable part) |
| D. Make a collection with `unknown` items `partial` | `complete` never hides an unknown | `partial` becomes universal again (entrypoints 9 of 9, jhipster contract answers) and means two things: not reached, or reached and undecided |
| E. Several statuses per fact (one per claim) | Most precise | More output and more decisions per family before any measurement; decided on measurement by decision 11 |
| F. Partial only above a number of cuts | Simple | A size threshold: forbidden by the design pillars |
| **G. Typed reason and reach per cut; each family declares what it asserts; a cut counts only when its reach can hold an asserted item, by positive proof; one encoding per enumerated topology item; undecided items stated** | Fixes the mechanism for every family; a `partial` says where and why; fails closed | A reach proof per cut source; every emitter changes; risk of a false `complete` if a proof is wrong (see Risks) |

## Decision

1. **Every cut states why it exists.** `Cut` gains a required `reason` from one closed union in
   `core/domain/shared/fact.ts`, replacing the optional `detail` and the optional `UnknownReason`. Every cut has one,
   structural ones included. Where a port already owns the vocabulary of a reason, the union imports that type instead
   of copying it: the export's skip reasons (`src/core/ports/vcs.port.ts:13`) and the dispatch reasons
   (`DispatchTargets`, `src/core/ports/import-origins.port.ts:138`). The mapping below is the inventory of every `Cut`
   construction under `src/core` at `8c5f181a` (`rg` over the ten kind literals, the cut helpers and the bound
   builders); U1 starts by re-running it on the code it lands on (after ADR-0045 L1b, decision 10), and the union holds
   exactly what it finds:

   | Emitter | Kind | Reason |
   |---|---|---|
   | Walk bounds: `src/core/application/impact/walk.ts:146-153`, `src/core/domain/impact/module-impact.ts:76,87,108`, `src/core/application/trace/trace-walk.ts:641-644` | `depth`, `hub`, `caller-budget` | the kind itself |
   | No emitter under `src/core` today | `node-cap`, `deadline` | the kind itself |
   | Export budget: `src/core/domain/map/entrypoint-map.ts:95` | `caller-budget` | `export-budget` |
   | Export skips: `entrypoint-map.ts:96-99` | `not-exported` | the skip reason the VCS port owns: `symlink`, `submodule`, `unsafe-path`, `collision` |
   | Listed but not written: `src/core/application/impact/impact-queries.ts:258,287`, `src/core/application/outline/outline-queries.ts:79` | `not-exported` | `unwritten` |
   | Language without extractor: `entrypoint-map.ts:100-103`, `impact-queries.ts:258,413`, `outline-queries.ts:52` | `no-extractor` | `language` |
   | Angular template no component covers: `impact-queries.ts:413` | `no-extractor` | `template-uncovered` |
   | Changed file that is not source: `impact-queries.ts:206`, `src/core/application/trace/trace-queries.ts:115` | `no-extractor` | `not-source` |
   | Not held by the index: `impact-queries.ts:286,287,576`, `outline-queries.ts:78,79`, `trace-queries.ts:179` | `no-extractor` | `not-indexed` |
   | File without symbols: `impact-queries.ts:577`, `trace-queries.ts:180` | `no-extractor` | `no-symbols` |
   | Unmodelled construct: `impact-queries.ts:578`, `outline-queries.ts:80` | `no-extractor` | `unmodelled` |
   | Module reader did not read: `impact-queries.ts:288`, `module-impact.ts:56`, `src/core/application/outline/outline.ts:41` | `no-extractor` | `module-unread` |
   | Contract document finding unknown: `src/core/domain/impact/changed-contracts.ts:66` | `no-extractor` | `contract-unread` |
   | Build outputs (`src/core/domain/shared/build-outputs.ts:27-30` from `impact-queries.ts:168-181`; the emitter moves into the line's B7 at ADR-0045 L1, with these reasons) | `build-output` | `live-tree` (`:169`), `inputs-unreadable` (`:172`), `version-mismatch` (`:179`, `unused`), `outputs-unreadable` (`:180`, fault `unreadable`), `checker-failed` (`:180`, fault `checker-failed`, `src/core/ports/type-bindings.port.ts:37-39`), `link-outside` (`:181`, `refused`) |
   | `unresolvedLinkCuts`, `src/core/domain/impact/impact-cuts.ts:128-187` | `unresolved-link` | `hidden-caller` (`hidden`), `dynamic-load` (`loaders`), `name-only` (`unattributed`) |
   | `unresolvedPlaceCuts`, `impact-cuts.ts:97` (from `impact-queries.ts:289`); `module-impact.ts:47` | `unresolved-link` | `specifier` |
   | `module-impact.ts:41` | `unresolved-link` | `dynamic-load` |
   | `removedDeclarationCuts`, `impact-cuts.ts:193` | `unresolved-link` | `removed-declaration` |
   | `unreadRelationCuts`, `impact-cuts.ts:231` | `unresolved-link` | `relation-unread` |
   | `unprovedUseCuts`, `src/core/domain/outline/outline-uses.ts:36-42` | `unresolved-link` | `use-unproven` |
   | Trace call no rule settles: `trace-walk.ts:215-218` at `:386,452,459,462,564`; by name only `:392`; a receiver held by a value `:537-543` | `unresolved-link` | `receiver-unproven` when candidates are listed, `callee-unknown` when none; the call site decides which |
   | Trace construction whose class has not exactly one constructor with a body: `trace-walk.ts:532` | `unresolved-link` | `constructor-unsettled` |
   | Trace reconciliation (ADR-0041 decision 3): a record its source contradicts, `trace-walk.ts:369`; a written call no single index body owns (`BodyCalls.ambiguous`, `src/core/application/navigation/reconciled-calls.ts:116`), `trace-walk.ts:454` | `unresolved-link` | `contradicted`, `unowned` |
   | Reverse-family reconciliation (`callers`, `impact`): on `t3/reverse-call-reconciliation`, not on `main` at `8c5f181a` | `unresolved-link` | `contradicted`, `unowned`, the same members, from the same builder (decision 10) |
   | Trace dispatch: `trace-walk.ts:251-254,306-323` | `unresolved-link` | `dispatch`, with a sub-reason: the one `DispatchTargets` owns when the port gave one (`:317`), `several-bodies` (`:318`), `overridable` (`:322`), otherwise `unproven` (`:312`, and `:317` without a port reason) |
   | Trace function value: `trace-walk.ts:583` | `unresolved-link` | `function-value` |
   | Trace page: `trace-walk.ts:612,661`, `page-plans.ts:29,37,44,51` | `unresolved-link` | `page-unplanned` |
   | Trace handler: `trace-queries.ts:235,254` | `unresolved-link` | `handler-unplaced` |
   | Trace effect: `src/core/domain/trace/trace-effects.ts:25,28` | `unresolved-link` | `effect-unplaced` |
   | Workspace dependency closure: `src/core/application/topology/workspace-queries.ts:139-145` | `unresolved-link` | `dependency-unresolved` (its `dependency` diagnostic stays) |
   | Workspace call site: `workspace-queries.ts:204` | `unresolved-link` | `call-site-unresolved` until U3 makes it an item only |
   | Unsettled join: `src/core/domain/topology/call-site.ts:151`, at `workspace-queries.ts:205` and `src/core/application/topology/workspace-impact.ts:432` | `unresolved-link` | `join-unsettled` |
   | Unserved operation: `workspace-impact.ts:381-383` | `unresolved-link` | `operation-unserved` |
   | Sections: `src/core/domain/shared/fact.ts:214-219`, `workspace-impact.ts:431` | `section` | `section-partial` or `section-unknown`, from the section's own status, which still holds its cuts or its `unknown` reason |

   Each emitter maps to exactly one reason; a new situation adds a member in the commit that emits it, and the type
   makes a cut without a reason a compile error. The union is closed, not small: it is rendered as counts per kind and
   reason, and in full only in `details`.

   **A `section` cut carries only its own reason** (`section-partial` or `section-unknown`), never a summary of its
   section's reasons. The section's fact already holds its cuts with their reasons, and the renderer reads them there
   (decision 7); copying them into the parent's cut would encode one place twice, the defect decision 6 removes.
2. **Every cut states what it could hide.** `Cut` gains a typed `reach`, set by the emitter from data it already holds:
   `anything` (with the file's runtime when known), `callers-of` (declaration anchors), `call-at` (a place inside a
   walked body), `module` (the specifier, its importing file, and whether the resolver classified it as a package),
   `call-site` (the call site as the topology extractor read it: its transport, and its method and path template when
   known). An emitter that cannot fill a narrower reach sets `anything`.
3. **Each family declares what its answer asserts**, as a value its use case builds from the request and the walk, in
   the family's domain. Two families that ask about the same files ask different questions, so the shared `Asserted`
   union separates them: the files' own content (outline) from what depends on the files (importers). An unread `B.ts`
   in the runtime of an asked `A.ts` (`impact-queries.ts:286`, `outline-queries.ts:78`, and the export cuts of
   `entrypoint-map.ts:92-105` both share) cannot change `A.ts`'s declarations, and can import `A.ts`:

   | Family | Asserts | A cut is in question when its reach can hold |
   |---|---|---|
   | importers (`dependents`) | importers and users of the asked files | an import or use of an asked file: a specifier the resolver's own rules could resolve to it, a dynamic load or an unread file sharing its runtime |
   | outline (`local`) | declarations and imports of the asked files | a place in an asked file, or an asked file not read |
   | callers, impact (`walk`) | the dependents reached, their entrypoints, the modules reached | a caller of a walked declaration, an edge into a walked module, a file sharing the runtime of a walked file |
   | trace (`walk`) | the steps and effects of the walk | a call inside a walked body, or a file sharing the runtime of a walked file |
   | contract consequences (`operation`) | consumers and producers of the operation and their uses of the property | a call site the topology matcher cannot exclude from that operation (decision 4) |
   | workspace, decisions, entrypoints (`everything`) | the whole topology or map | every cut (no change) |

   Every bound and every export cut (`caller-budget` of the export, `not-exported` of a submodule) is in question for
   every family, since what it left out is unknown.
4. **A cut is out of question only by positive proof, and the proof fails closed.** One pure function
   `inQuestion(cut, asserted)` in `core/domain/shared` decides it: a reach of `anything` without a runtime, a missing
   datum, or a proof that needs a rule the resolver did not apply, keeps the cut in question. A runtime proof reuses
   `sharesRuntime` (`src/core/domain/languages/call-targets.ts:16-20`); a specifier proof reuses the resolver's own
   classification (path mapping, package, relative), never a file name heuristic. A call site is out of an operation's
   question only when its transport is not the operation's (a datum the extractor states), or when the topology matcher,
   `matchCallSite` (`src/core/domain/topology/link-match.ts:253`), with the workspace's gateways and configured base
   paths, finds neither a match nor a `could` on any rung: exact, base path, behind a gateway, suffix
   (`link-match.ts:136-181`). A gateway prefix (`POST /orders-api/orders` reaching `POST /orders`), a base path
   (`/billing/orders` reaching `GET /orders`) or a suffix (`/restaurants/daily-menus` reaching `GET /daily-menus`)
   therefore keeps the cut (`src/core/domain/topology/link-match.test.ts:80,86,107`). `inQuestion` holds no path
   matcher of its own; without the matcher's answer the cut stays. This generalizes ADR-0019, whose proof that a
   reference names an external target is one such proof.
5. **Status over the question; a cut out of question is dropped, not listed apart.** `withCuts` takes the asserted
   value and keeps only the cuts in question; the fact is `complete` when none is left. A cut out of question is not
   emitted, as ADR-0019 already does for a proven external target: it bounds no part of this answer, and listing it is
   the noise this decision removes. A separate list was weighed and refused: it would put the 22 importers cuts of the
   evaluation back in front of the agent under another name, and every renderer and the gate would have to decide again
   what to do with it. Its effect stays visible in the conformance fixtures and in the corpus gate's report, and the
   whole snapshot's coverage stays where it is asked: `entrypoints` and `workspace` assert everything and keep every
   cut.
6. **An enumerated item is never also a cut; a frontier is always a cut.** Two things differ:
   - an *enumerated item* is an element the answer lists, found by an extractor independently of any walk: a topology
     call site, an entrypoint, a contract finding. Unresolved, it is an `unknown` item of its collection, never also a
     cut (RFC-0002 rule 2, ADR-0013 rule 7): the item already says that what it would bind is undecided;
   - a *frontier* is where a walk or an execution stopped without reaching what lies beyond: an unresolved call or an
     unproven dispatch in a trace body (`trace-walk.ts:306-323,615-616`), an unresolved reference to a walked
     declaration, an undecided call site that may reach a walked handler (`workspace-impact.ts:432`), ADR-0041's
     `contradicted` and `unowned` records (ADR-0041 decision 3, "a cut at its place"; `trace-walk.ts:369,454`). What
     lies beyond is not enumerated anywhere, so it can hide declarations, effects and dependents; it stays a cut even
     when the same place is listed elsewhere as an item, and the trace port's promise holds
     (`src/core/ports/trace-queries.port.ts:63-64`: "a call no rule settles is an `unresolved-link` cut with its
     candidates").

   The deduplication applies only to topology: a workspace or decisions section stops cutting at its unresolved call
   sites (`workspace-queries.ts:204`), which it already lists as `unresolved` items (`:199,207`). An unsettled join
   (`:205`) stays a cut until U3 shows that the section lists it as an item; this design did not verify that it does.
   Contract consequences take from the listed items, as findings, the ones whose transport can carry the operation, and
   the workspace's remaining cuts only through decision 5. Trace, callers, impact, workspace callers and workspace
   impact are unchanged by this decision.
7. **Undecided items are stated; a collection with `unknown` items stays `complete`.** RFC-0002 rule 2 stands: a
   collection that reached every place that could hold an item is `complete`, even with `unknown` items. Making it
   `partial` (option D) was refused: `partial` would mean both "not reached" and "reached and undecided", and it would
   become universal again (entrypoints 9 of 9, the jhipster contract answers). The renderer never prints a bare
   `complete` for it: the status line reads `complete (N undecided)`, counted from the items the family asserts. A
   composite whose only section is `unknown` prints that section's status and reason, not `partial (cuts: 1 section)`.
8. **Rendering of cuts.** The status line counts in-question cuts by kind and reason (`partial (cuts: 20
   unresolved-link receiver-unproven, 2 unresolved-link dispatch)`); `details` prints the reason on every cut row, with
   its sub-reason where it has one.
9. **No schema bump.** The fields change without a `SCHEMA` bump and without compatibility code while the MCP has no
   consumers.
10. **Relation to ADR-0045's assembly line.**
    - **Where the vocabulary lives.** `Cut`, its reason union and its reach stay in `core/domain/shared/fact.ts`, the
      envelope every layer already imports, below the line. No stage of the line builds a `Cut` (ADR-0045 decision 11):
      a stage answers typed evidence (a reconciliation class, `unread`, a port's `unknown` with its reason, a module
      resolution), and the family's policy, or the shared cut builder it calls, turns it into a cut with its reason and
      reach. Where two families cut from the same stage answer, one builder owns the reason: the `contradicted` and
      `unowned` cuts, built today by trace (`trace-walk.ts:215-218`), move beside `ReconciledCalls` in `navigation`
      when the reverse families emit them, so the reverse families never map the reconciliation's classes again.
    - **What each part reads.** The reason and the reach are filled from the line's outputs: the `module` reach's
      resolver classification from B2b's module resolution and B3's statements, the runtime from the language profile
      (`sharesRuntime` today; the profile list of `core/domain/languages/` after ADR-0045 L1c), `callers-of` anchors
      from the walk over B8 to B10b, `call-at` places from B9's alignment, `call-site` data from B11's call sites. A
      datum a stage does not state is left out of the reach, never re-derived by the family, and `inQuestion` fails
      closed on it. The asserted value is the family's own output, built from its request and its walk; the walk is the
      family's policy over the line's answers (ADR-0045 decision 5). `inQuestion` reads only the cut and the asserted
      value: it reads neither the line nor the family's evidence, and the line never knows the question. Completeness
      relative to the question is a narrowing every family applies through the same function, the kind of extension
      ADR-0045 decision 5 allows.
    - **Absent capabilities map onto the existing reasons; absence is never a proof.** Three cases, by what the absent
      stage would have decided:
      - a file no pack reads is a `no-extractor` cut with reason `language`, the existing member, with a reach of
        `anything` and the file's runtime when the profile list classifies the path; a path no profile classifies has
        no runtime and keeps every family `partial` (decision 4);
      - an enumerated item an absent stage would decide (an entrypoint, a call site, a contract finding) is an `unknown`
        item of its collection (decision 6), never a cut;
      - a frontier an absent stage would settle (TypeScript `dispatchTargets` and `receiverMethods`, which answer a bare
        `unknown` per site today, `src/core/adapters/typescript/import-origins.adapter.ts:240,242`) keeps the
        situation's reason (`dispatch`, `receiver-unproven`, `callee-unknown`) with the sub-reason
        `capability-absent`. U1 adds that member to the `unknown` answer of the ports that can be absent
        (`DispatchTargets`, `ReceiverMethod`), and the line sets it from the pack's declaration, so the reason names
        the absence without any family testing a language.

      No top-level reason member is added for absence. A cut whose sub-reason is `capability-absent` leaves the
      question only by a proof that does not read the absent stage (a runtime proof, a resolver classification); an
      absent stage never counts as "nothing there".
    - **Order against ADR-0045's migration.** ADR-0045 L0, L1 and L1b first; then this ADR's U1 to U6 as one feature;
      then ADR-0045 L2, L3, L5a, L4, L5 and L6. L1c may land on either side: it is byte-identical and keeps reasons.
      - After L1b, because L1 moves the `build-output` emitter into B7 and the reference proofs into `navigation`, so
        U1 inventories each emitter once, where it stays; because `capability-absent` reads L1b's pack declarations;
        and because L1 and L1b are gated `none` (byte-identical), which a cut metadata change made before them would
        break. ADR-0041 U4 (the reverse reconciliation, the prerequisite of L1) is then on `main`, so its
        `contradicted` and `unowned` cuts in `callers` and `impact` are emitters U1 covers.
      - Before L2, because L2 and L3 move `importers`, `outline` focus, contract consequences and trace by widening
        proofs: with question-relative status a moved status means a place inside the answer, so their reports are
        legible, and two features with two gates keep ADR-0041 decision 8's attribution apart; because after U1 the
        type forces every cut L2 and L3 add (Java module specifiers for `importers`, `build-output` cuts for the
        families that gain B7) to carry a reason and a reach; and because U3 and U6 edit `consumer-sources.ts`, which
        L2 edits too.
    - **One corpus gate for the feature**, before `main` (AGENTS.md, ADR-0039: once per integration, never per commit).
      Each unit is its own commit with its failing fixture first and `npm run check`; the feature's gate declares `±`
      for every family whose answers carry cuts, since U1 changes cut metadata everywhere. A `±` admits any move, so
      the report is reviewed answer by answer, and `main` is blocked unless: no `complete` answer becomes `partial`;
      values are unchanged except cut metadata (`reason` and `reach` added, `detail` removed) and the cuts decided out
      of question; every status change is one the Migration table expects, attributed to its unit, and every expected
      move happens or its absence is explained; and every cut of every head answer has a reason.
11. **One status per fact; a status per claim only on measured evidence.** Option E (trace's steps and effects, callers'
    direct and transitive dependents) is not adopted. The proposal measured it "after U5", ADR-0041's U5, which is now
    ADR-0045 L2; but L3 (typed bindings and the receiver classification in trace) and L6 (reconciliation pruning in the
    reverse families) still change the cuts both counts read, so a count before them measures cuts those units remove or
    add.
    - **Measurement and trigger.** On the head answers of the first corpus gate run after ADR-0045 L3 and L6 are on
      `main`, read from that run's report (no extra run; it needs this ADR's reasons and reach, which land before L2):
      - T: trace answers that are `partial` where every in-question cut is `receiver-unproven` and every candidate it
        lists is a declaration the same walk expanded, whose subtree has no effect and no in-question cut;
      - C: `callers` answers that are `partial` where every in-question cut has a `callers-of` reach naming only
        declarations at depth greater than 1.
    - **T = 0 and C = 0:** one status per fact is final and option E is closed; the lead records both counts in this
      ADR's Revisions, and reopening needs a new ADR.
    - **T > 0 or C > 0:** each counted answer has a claim that is provably complete while its answer is `partial`, a
      verdict the agent cannot read today. A new ADR proposes a status per claim for that family only (trace: steps and
      effects; callers: direct and transitive), with the counted answers as its conformance fixtures and its own gate
      (`trace:±` or `callers:±`), because a second status adds a field to every answer of the family. This ADR is not
      amended; until that ADR is accepted, one status per fact stands.

### Relation to RFC-0002

This ADR amends RFC-0002 explicitly, without superseding it:

- the envelope's `Cut` gains `reason` (required, closed) and `reach`;
- rule 1 reads "a fact a bound cut is `partial` and lists every cut that could hold an item its answer asserts";
- rule 2 adds "an enumerated item is never also a cut; a walk's frontier is always a cut", and that the status line
  states undecided items;
- rule 4 (completeness relative to the declared scope) is unchanged: the question narrows completeness inside the
  declared scope, never beyond it.

## How a family declares what it asserts

A family's use case builds its asserted value next to the walk it already runs, and passes it to `withCuts`:

```ts
// core/domain/shared/fact.ts
type Asserted =
  | { kind: "local"; files: readonly string[] }        // outline: what the asked files themselves hold
  | { kind: "dependents"; files: readonly string[] }   // importers: what could import or use the asked files
  | { kind: "walk"; declarations: readonly string[]; files: readonly string[]; modules: readonly string[] } // callers, impact, trace
  | { kind: "operation"; transport: string; excludes: (site: CallSiteReach) => boolean } // contract consequences
  | { kind: "everything" };                              // map, workspace, decisions

function withCuts<T>(base: FactBase, value: T, cuts: readonly Cut[], asserted: Asserted): CompleteFact<T> | PartialFact<T>;
```

The emitter fills `reach`; the family supplies data (`asserted`), never a rule; `inQuestion` is the only owner of the
rule. The one exception is `operation.excludes`, which contract consequences build from `matchCallSite` with the
workspace's gateways, so the path rule keeps its one owner in the topology domain and `inQuestion` only reads its
answer. A family that cannot yet state what it asserts passes `everything`, which keeps today's behavior.

## Migration

One feature, after ADR-0045 L1b and before L2 (decision 10). Each unit is one behavior with its tests, its failing
fixture first, and `npm run check`; the feature passes one corpus gate at its end, before `main`, with the acceptance
criteria of decision 10. The column below is what that gate's report must show for each unit, so every move is
attributed.

| Unit | Change | Expected moves in the feature's gate report |
|---|---|---|
| U1 | Re-run the emitter inventory of decision 1 on the code after L1b; required `reason` and `reach` on every emitter, `detail` and the `UnknownReason` values removed from cuts; `capability-absent` on the ports that can be absent, set by the line from the packs (decision 10); `withCuts` still keeps every cut | Every family with cuts changes cut metadata only (`reason`, `reach`, `detail`); the gate rejects removals under `+` (`scripts/corpus-gate-diff.ts:175-198`), hence `±`. Statuses and payloads unchanged |
| U2 | Render reasons and sub-reasons in the status line and in `details`; `complete (N undecided)`; a composite over one `unknown` section prints it (only `src/mcp`) | Outside the gate (outside `src/core`); MCP tests |
| U3 | Topology deduplication (decision 6): workspace and decisions sections stop cutting at call sites they list; contract consequences take those items as findings | Realworld workspace, decisions and 7 contract answers become `complete (N undecided)`; the 5 nname contract answers lose their event-site cuts. No other family moves |
| U4 | `inQuestion` and `asserted` for importers (`dependents`) and outline (`local`) | Both importers partials of the evaluation become `complete`; outline unchanged on its one case |
| U5 | Impact's module walk and the symbol walks of callers, impact and trace: specifier and runtime reach | NW-IMPACT-1 loses its 28 specifier cuts and stays `partial` (61 in question); trace and callers keep their in-walk cuts |
| U6 | Contract consequences: `operation` reach through `matchCallSite` over the workspace's remaining cuts | No evaluation answer moves after U3; moves only where a workspace keeps dependency or export cuts |

U1 lands first because every later unit reads `reason` and `reach`; U3 before U6 because U6 assumes topology items no
longer arrive as cuts.

## Conformance fixtures

Each fixture names the rule it guards; the negative ones guard the golden rule.

1. Importers of a Java file with an unresolved TypeScript specifier elsewhere: `complete`.
2. Importers of a TypeScript file with an unresolved specifier that a path mapping pattern of the snapshot could resolve
   to it: `partial` with reason `specifier` (fails closed).
3. Importers of a TypeScript file with a non-literal dynamic import in the same runtime: `partial`, `dynamic-load`.
4. One snapshot where `B.ts`, in the runtime of `A.ts`, is not held by the index: outline of `A.ts` is `complete`;
   importers of `A.ts` is `partial`, `not-indexed` at `B.ts`. Outline of a file the index did not hold: `partial`,
   `not-indexed`.
5. A workspace section with one unresolved call site: one `unknown` item, no cut, `complete (1 undecided)`.
6. A contract hypothesis on HTTP with an unresolved event call site in a consumer: `complete`; with an unresolved HTTP
   call site of unknown method: one `unknown` finding, `complete (1 undecided)`; with a consumer file in a runtime
   without extractor: `partial`, `language`.
7. Contract cuts the topology matcher cannot exclude stay: a hypothesis on `POST /orders` with an undecided call site
   whose known template is `orders-api/orders` and a declared gateway `orders-api`; on `GET /orders` with
   `billing/orders` and a route whose configuration adds `/billing`; on `GET /daily-menus` with
   `restaurants/daily-menus` (suffix). Each stays `partial` (or keeps its finding); the same call site with a template no
   rung can match and no `could` is out of question.
8. Frontiers are never deduplicated: a trace whose unresolved dispatch hides an implementation with an HTTP effect stays
   `partial` with a `dispatch` cut, even when a workspace lists the same call place as an item; a trace over a call
   ADR-0041 reconciles as `contradicted` or `unowned` keeps that cut; a recovered call the walk cannot follow keeps its
   `receiver-unproven` or `callee-unknown` cut.
9. Every bound (`depth`, `hub`, `caller-budget`, export `caller-budget`, `deadline`) keeps the answer `partial` for
   every family, whatever the asserted value.
10. A cut whose reach is `anything` without a runtime keeps every family `partial`.
11. Every cut carries a reason, sections included (`section-partial`, `section-unknown`); a trace dispatch cut renders its
    reason, with its sub-reason, in summary and details.
12. An absent capability fails closed: trace from a TypeScript method that calls a body-less interface method, where
    the TypeScript pack declares `dispatchTargets` absent, stays `partial` with a `dispatch` cut whose sub-reason is
    `capability-absent`, for every asserted value that holds the walked file's runtime.

## Consequences

- `partial` means that a place that could hold part of this answer was not reached, and says why. On the evaluation,
  16 of 55 `partial` answers (up to 21 with the unverified ones) become `complete` or `complete (N undecided)`, and 7
  print as the `unknown` answer they wrap; trace stays `partial` where its walk truly stops, now with a reason per cut.
- Fewer cuts reach the agent where they cannot matter (importers: 22 to 0 on the evaluation; NW-IMPACT-1: 89 to 61).
- Every emitter changes once (U1); `withCuts` gains one argument; one shared predicate owns relevance.
- From U1 on, every cut ADR-0045's later units add carries a reason and a reach by type, and an absent capability
  reaches the agent as a named reason instead of an unexplained cut.
- Trace and callers volume is not reduced by this ADR: it is resolution work (ADR-0041 and the receiver and dispatch
  designs). Their cuts become legible, not fewer.

## Risks

- **A false `complete`.** A reach proof that is wrong turns a true unknown into `complete`: an unresolved specifier a
  path mapping, a package `exports` map or a workspace package link could resolve to the asked file; a file without
  extractor in a runtime that does call into the asked one (Kotlin into Java, JavaScript into TypeScript); an event
  call site the workspace mislabels; a call that reaches the operation through a gateway or a base path. Mitigations:
  proofs only from the resolver's own classification, `sharesRuntime` and `matchCallSite`; a missing datum fails
  closed; fixtures 2, 3, 4, 6, 7 and 10; the feature's gate report is reviewed answer by answer and blocks any
  `complete` → `partial` move or unexpected status change (decision 10).
- **An absent capability read as "nothing there".** Mitigated by decision 10: absence keeps the situation's reason,
  never leaves the question by the absent stage's own answer, and fixture 12 fails first.
- **A frontier taken for an item.** Deduplicating a place a walk could not cross hides what lies beyond it: effects
  behind a dispatch, dependents behind an undecided call. Decision 6 limits deduplication to topology items the
  workspace enumerates; fixture 8 guards it.
- **Noise moved, not removed.** A reason union that grows per case becomes its own drawer of rules. The union is closed,
  maps one reason per emitter situation, reuses the vocabularies its ports already own, is rendered as counts, and a
  new member needs an emitter that cannot use an existing one.
- **Order against ADR-0045 slips.** If L2 had to land before this feature, the two features' moves on `importers`,
  `outline` and contract consequences would meet in one report. Mitigation: each feature keeps its own gate, the later
  one is gated against a `main` that already holds the earlier, and U1's inventory is re-run on the code it lands on.
- **Hidden context.** Dropping an out-of-question cut hides it from a caller who wanted the whole snapshot's coverage.
  That question belongs to `entrypoints` and `workspace`, which assert everything and keep every cut.

## Closed questions

| # | Question of the proposal | Decision |
|---|---|---|
| 1 | Should a collection with `unknown` items stay `complete`? | Yes, stated as `complete (N undecided)`: decision 7 |
| 2 | Drop out-of-question cuts, or keep them in a separate list? | Drop them: decision 5 |
| 3 | One status per claim? | Not now; measured after ADR-0045 L3 and L6, with the outcome decided for each result: decision 11 |
| 4 | Does a `section` cut carry a summary of its section's reasons? | No, only its own reason: decision 1 |

## Recorded follow-ups

- **Status per claim.** Trigger: the first corpus gate run after ADR-0045 L3 and L6 are on `main`. Action and outcomes:
  decision 11.
- **Unverified causes.** The nname and petclinic microservice workspace sections beyond their event call sites, and the
  jhipster impact case (IMP-JH-1), were not classified by this design. Trigger: this feature's gate report. A section
  that stays `partial` through a call site it lists as an item is a U3 defect and blocks `main`; any other cause is
  reported with its reason, which U1 makes visible, and handled by the family that owns it.

## Not decided here

- Resolution that removes trace and callers cuts (receivers, dispatch, library calls): ADR-0041, ADR-0045 L3 and the
  designs that follow them.
- The coverage gap of Angular `RouterModule.forChild` routes: framework coverage under ADR-0013.
