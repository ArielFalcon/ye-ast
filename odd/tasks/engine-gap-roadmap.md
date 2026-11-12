Objective: the order in which every designed engine-gap unit is implemented, by smaller models without lead supervision.
Branch: one worktree branch per unit from the current `main`; publication follows explicit owner authorization.
Delivery: one unit per branch and commit; one corpus gate per integration into `main`. Test runner: node:test (`npm test`).

## Current delivery status (2026-11-12)

All RFC-0024 through RFC-0029 implementation units are integrated into `main` through `949507ce`.
The original 106-item study acceptance remains open; passing implementation checks and the 113-answer regression
corpus do not establish that every study requirement is satisfied. Injected API URL values and external Java
hierarchy evidence remain explicit uncertainty where not proven. The owner has authorized publication and parallel
acceptance work. Separate ADR-0044/0045 implementation and measurement debt retains its own acceptance criteria.

## Specs

- S1 (owner, 2026-11-09): "aplica el orden que recomiendas" — this file is that order.
- S2 (owner): "esto lo implementaran modelos de menor capacidad, sin la supervicion tuya" — each unit's document names its
  files, RED test, acceptance, probe and gate expectation; an implementer that meets a decision the document does not
  settle stops and reports it, never decides it.
- S3 (owner): "Resuelve todas las preguntas abiertas como recomiendes" — every design question is settled in its
  document's "Resolved questions".

## Where each unit is specified

| Source | Units | Document |
|---|---|---|
| RFC-0024 / ADR-0046 | U1-U5 receiver-typed settlement | `docs/architecture/rfc/0024-receiver-typed-settlement.md` |
| RFC-0025 / ADR-0047 | U1-U5 Angular route graph | `docs/architecture/rfc/0025-angular-route-tables.md` |
| RFC-0026 / ADR-0048 | U1-U6 framework callbacks | `docs/architecture/rfc/0026-framework-invoked-entrypoints.md` |
| RFC-0027 / ADR-0049 | U0-U8 declaration model | `docs/architecture/rfc/0027-declaration-model.md` |
| RFC-0028 / ADR-0050 | S1-S4 request summaries | `docs/architecture/rfc/0028-value-flow-through-wrappers.md` |
| RFC-0029 / ADR-0051 | U1-U7 presentation residuals | `docs/architecture/rfc/0029-presentation-residuals.md` |
| ADR-0045 / ADR-0041 | L2b, N1, L1c, M1, L4a-b, L5-pre/shared/live, L6 | `odd/tasks/adr-0045-0041-units.md` |
| ADR-0044 | M0, V0a-V5 (26 units) | `odd/tasks/adr-0044-units.md` |
| ADR-0043 | U1, U2a, U2b, U3, U4 | `odd/tasks/adr-0043-units.md` |

## Tasks (in order; a unit starts only when every unit it names as prerequisite is on `main`)

Lane A, invariant first:
- A1 RFC-0027 U0: a Java type target is `partial` while its type references are unread (a false `complete` on main today). Status: DONE, `741cf87d` (in main `58853d45`).

Lane B, presentation (independent of the engine lanes):
- B1 RFC-0029 U1 (one owner of fault entry text) DONE, `1049ec7b` + `6b8e5d2d` + `5d68efba` (in main `58853d45`) → B2 U2 DONE `a1a97999` (in main `1896eb65`) → B3 U3 → B3 U3 (duplicate repository names `repos[i]`) → B4 U6 (UI route `declaredAt`) → B5 U7 (importers carry relationship lines) → B6 U4 (host-declared answer bound; high-risk item 3). Status: pending.

Lane C, assembly line (L3 is on main as "delivered, partial", see the ADR-0045 units table):
- C1 L2b → C2 N1 (typed-key slice delivered; six frozen-list occurrences remain, with the brief's classification still to reconcile) → C3 L6 (implementation delivered; acceptance still needs M4's per-repository counts from M1) → C4 M1 measurement → C5 L4a → C6 L4b → C7 L5-pre → C8 L5-shared → C9 L5-live. L1c is optional, any time. Status: pending; do not schedule another L6 implementation without a new defect.

Lane D, binder:
- D1 RFC-0024 U1 DONE `768893f4`+`6b2aab56`; D2 U2 DONE `251435ae` (in main `1896eb65`) → D3 U3; D4 U4 after U2; D5 U5 DONE `784500b8` (in main). U5 removes trace's second nominal receiver selection; 4509 tests pass, 105 corpus answers are identical, and both real trace probes are byte-identical to the baseline. The Java probe still has the baseline's receiver-unproven cuts; it does not establish the interface hop.

Lane E, Java closure (ADR-0044):
M0 acceptance is not established: the located probe covers one repository, not the required per-repository corpus measurement. Later JDK implementation does not establish that measurement's delivery.
- E1 M0 → V0a.1 → V0a.2 → V0a.3; V0b.1 DONE, `eb999856` + `d7052d12` + `0e1a6501` (in main `58853d45`) → V0b.2 after V0a.1; V1a.1 → V1a.2; V1b.1a DONE `30349896`+`4259282f`+`78985315`; V1b.1b DONE `7c34df05`+`644d17df`; V1b.1c DONE `f3d0b1da`+`07d8c1e0`; V1b.2 DONE `2f89f24f`+`6d020333` (in main `4e536aea`) → V1b.3 → V1b.4, V1b.5 → V1b.6; V2.1 → V2.2; V3.1 → V3.2 → V3.3 (needs V0a, V0b, V1, V2 and M3 of lane C); V4.1 DONE `6b0b4f32` → V4.2, V4.3 (V4.1 was high-risk item 3, a new flag); V5.1 DONE `af824c9f`; V5.2 after V5.1 and RFC-0028 S1. Status: pending.

Lane F, declaration model (after lane D U1-U4):
- F1 RFC-0027 U0-U8: implementation delivered. U1 `8abd8361`, U2 `d5070686`, U3-U6 `949507ce`, U7 `d955096c`, U8 `834a75f1`. Original study step acceptance retains the documented URL and Java receiver-proof limits; do not schedule duplicate implementation units.

Lane G, frameworks:
- G1 RFC-0025 U1 DONE `54315669`+`5bcc416d`; U2 DONE `59d46c21`+`2842e455`; U3 DONE `febc9ad8`+`a4dc6e6d`; U4 DONE `d23524d4`+`cbb4f9c3`+`6c19541d`+`61103da2` (in main `4e536aea`); U5 DONE `90dd9433` (in main). G2's U4 and G3's U5 prerequisites are delivered; final study acceptance remains separate.
- G4 RFC-0026 U1 DONE `5c6d5bf4` → U2 DONE `cdef9064` → U3 DONE `0e0194fd` → U4 DONE `511a7662` → U5 DONE `d3555e73` → U6 DONE `c749c8c9`.
- G5 RFC-0029 U5 DONE in `949507ce`: unmatched original selections share one owner across revision, live and workspace reads; output notices use schema 0.23.0.

Lane H, value flow:
- H1 RFC-0028 S1 DONE, `aca59224` + `8241c127` + `7b64196c` (in main `58853d45`); S1 guarded values and S2 DONE `11526951` → S3 DONE `2dd1408c` (acceptance completed by S4) → S4 DONE `aa7806cf`. Status: S1-S4 done.

Lane I, change seeding (ADR-0043):
- I1 U1, U2a, U2b, U3 and U4: implementation delivered in the ancestry of `8b74bb38`; preserve the final study acceptance distinction.

Close:
- Z1 Re-probe the study's 106 items on the new `main` (`evaluations/runs/20261108T2245Z-agent-usefulness-12f8/engine-gaps/BRIEF.md`, "Re-probe") and report per class closed/improved/still-fails. Status: pending.

Lanes run in parallel only when their units edit disjoint files; the corpus gate runs once per integration and never
concurrently with another gate or full suite.

## Acceptance gate for every unit (owner, 2026-11-10, ADR-0051 decision 7)

A unit is not done because its tests pass. Before it is integrated it must state, in its own report:
1. **The owner.** Which single module decides the fact this unit touches, and why that module and not a new one.
2. **The contract.** That the owner's answer separates "established" from "not established" (a sum type, the domain's
   `Evaluated`/`Undecided` where it fits), and that no reader can collapse the two by accident.
3. **No second path.** That no other module computes the same rule — or, where a documented temporary duplicate exists,
   the unit that removes it. A new duplicate without a named closing unit is a defect, not a debt.
4. **No chain of special cases.** That the change is not an `if` per observed input; a new case grows the owner's
   contract, never a consumer's conditional.
5. **The fitness function.** A `*.single-rule.test.ts`-style test when the fact has an owner worth protecting, or a
   stated reason why the shape cannot be guarded mechanically.

Audit of the units already on `main` runs against this list; its findings are scheduled like units.


## Audit of main `cc802be3` against ADR-0051 decision 7 (2026-11-10)

Read-only audit of the 54 commits integrated since `25f1f51b`. Each finding is scheduled like a unit; the two marked
P0 block the units that would otherwise build on the duplicated rule.

| # | Finding | Class | State | Closing unit |
|---|---|---|---|---|
| 1 | Request recognition has four copies (`request-summaries.ts`, `request-origins.adapter.ts`, `consumer-flow.walker.ts`, and `http-call-sites.adapter.ts` — the last one **not listed** in RFC-0028's consolidation, and the owner RFC-0028 picks is the weakest: it reports `fetch('/orders',{method:'POST'})` as GET with no body, confirmed by probe) | A + C | **P0 real defect, latent while nothing consumes S1** | request-vocabulary: one owner `requestCallOf(shape, call)` over a sum type; amend RFC-0028's owner and its copy list; fitness row seeded with the four copies |
| 2 | Java overload selection duplicated in `data-effects.adapter.ts:76-87` without the guards of `java-receiver-methods.ts:219-262` | A | documented debt (ADR-0044 V0b.2) | data-effects asks `receiverMethods`; fitness row with data-effects as pending |
| 3 | Angular workspace read three times (`angular-projects.ts`, `url-define.ts`, `angular-metadata.adapter.ts`), two of them answering `[]` on a parse error | A + C | real, minor | one `angularWorkspaceOf` returning read/unreadable |
| 4 | `RouterModule`/`provideRouter` recognition duplicated (`angular-router.extractor.ts` vs `route-table.loader.ts`), and `ANGULAR_ROUTER` declared twice; a namespace import reads no routes | A + C | real, moderate | one `angularPackageExport` generalising `angularCoreExport`; fitness row |
| 5 | The nominal receiver path falls back to `membersAbove` (a by-name candidate set) when the owner answers `unproven` without candidates, which the port documents it never does | A + C | contract defect | `memberOfReceiver` answers not-established; fitness row for the nominal path |
| 6 | `issuingCallsOf`/`placedSites` collapse "not read" and "not placed" into "direct"/"one issuing call", hiding the ambiguity ADR-0044 d7 requires as a frontier | C | **P0 real defect** | sum type `{direct}\|{one}\|{several}\|{unplaced}` and `{read}\|{not-read}` |
| 7 | `heldPaths` plus a repeated `?? export.files` in two consumers | A minor | acceptable today (`exportCuts` marks partial) | `heldPaths` returns complete/stopped |
| 8 | The legacy `loadChildren` resolution fabricates `${root}/__legacy__.ts` and patches `root === ""` | B | debt: a patch over a patch | the module resolver exposes `resolveFromRoot(root, specifier)` |
| 9 | Spring Data derived-query access lives as an inline regex | B | legitimate domain, wrong shape | `REPOSITORY_OPERATIONS` as a closed table |

Domains that have an owner worth protecting and no fitness test: request vocabulary, Java overload selection, Angular
workspace, `@angular/*` package exports, nominal receiver candidates, contract issuing calls, export listing, and the
fault-entry vocabulary consolidated by RFC-0029 U1.

## How to implement one unit

1. `git worktree add` a branch from the current `main`; copy `AGENTS.md`, `CLAUDE.md` and `.claude/` from the main
   checkout into it (they are gitignored) and symlink `node_modules`. Node 24.22.2 only.
2. Read `AGENTS.md`, the unit's section and its document's "Resolved questions". Edit only the unit's listed files.
3. Write the RED test the unit names; run it and keep the failing output. Implement until it passes; add the variant.
4. `npm run typecheck`, `npm run arch:check`, the touched tests. Then `npm run check` once.
5. A unit under `src/core/` (not tests) merges `main` first and runs
   `node --import tsx scripts/corpus-gate.ts --corpus <manifest> --base main --candidate <branch>` with the unit's
   `--expect`; every difference in the report is explained, and the `Corpus-Gate:` line becomes the commit trailer.
6. Conventional Commit, no AI attribution; fast-forward local `main`; remove the worktree and branch.
7. Mark the unit done here with its commit. A unit whose document leaves a decision open, whose RED passes before the
   change, or whose gate moves a family it did not declare stops and is reported, never forced.

## Log

- L1 (2026-11-09): "aplica el orden que recomiendas. ten en cuenta que los ADR recogen decisiones mas acotadas referentes a un RFC, porque veo que solo se crean ADR y no se si se esta gestionando bien esto. El objetivo es dejar documentado todos los problemas encontrados, con su causa raiz confirmada y la solucion propuesta bien detallada para implementarse. Porque esto lo implementaran modelos de menor capacidad, sin la supervicion tuya por problemas de cuota semanal"
- L2 (2026-11-09): "Resuelve todas las preguntas abiertas como recomiendes"

- L3 (2026-11-10): main `58853d45` integrates RFC-0027 U0, RFC-0029 U1, RFC-0025 U1, RFC-0024 U1,
  RFC-0028 S1, ADR-0044 V0b.1, V1b.1a, V4.1 and V5.1 in one gate pass (105 answers, 13 differing: 12 are U0's
  `relation-unread` cut with status only and no symbol moved, 1 is RFC-0024 U1's receiver-typed trace).

- L4 (2026-11-10): main `1896eb65` adds RFC-0025 U2, RFC-0029 U2, RFC-0024 U2 and ADR-0044 V1b.1b in one gate pass
  (105 answers, 3 differing, all RFC-0025 U2: petclinic frontend entrypoints 20 unknown -> 20 real routes, the impact
  answer that carries them, and the workspace answer that repeats them). Anthropic credit and the OpenCode Go weekly
  quota ran out mid-unit; reviews after that are Codex or lead-run, and V1b.1b's forward-reference MAJOR was found by
  the Codex review and fixed by the lead.

- L5 (2026-11-10): main `bd43192c` adds RFC-0024 U3 (an edge whose receiver declares several members of the name
  keeps the index target as a name match: a proven it never had), RFC-0029 U3 and ADR-0044 V1b.1c (the pinned
  generator; 4848 java.* types at release 23, byte-identical across two runs). Gate: 105 answers, 0 differing.
  Process: implementers no longer run npm run check, only their single test files, because two units died waiting on
  the shared lock. The lead found two defects the writers left: the generator rejected every real ct.sym for not
  skipping module-info.sig, and its digest regex tripped the commit-id fitness rule.

- L6 (2026-11-10): main `7581a191` adds RFC-0025 U3. Gate 105 answers, 4 differing: shopizer admin goes from 121
  `unknown` route entries to 119 real routes (`/auth/register`, `/pages/catalogue/brands/...`), and the impact, callers
  and workspace answers that carry them follow. The unit's own gate expectation said `entrypoints:+`; the measured
  direction is `±`, because a repository whose unknowns were already route entries replaces them instead of adding.
  The writer shipped it twice broken outside its fixtures: first a guaranteed crash on shopizer (a `sourceRoot: ""`
  produced `/__legacy__.ts`, an absolute path whose config search awaited its own promise), then a 378 KB -> 88 KB
  output the lead had to explain (it was the unknown entries resolving, not content lost).

- L7 (2026-11-10): main `4e536aea` adds six units in one gate pass: ADR-0044 V1b.2 (`--jdk` with the pinned digest,
  usage error on a home with no readable `lib/ct.sym`), RFC-0024 U4 (the contract bridge matches by signature; an
  unread supertype answers unknown), RFC-0025 U4 (a frontiera is a cut of the map, mandatory `readingCuts`),
  RFC-0029 U6 (a reached UI route carries its declaration place), and the two P0 audit units: one request-vocabulary
  owner with its fitness function, and issuing calls as a sum type. Gate: 105 answers, 9 differing — seven are U6's
  added `declaredAt` on the same items, two are U4's twelve false by-name dependents in shopizer, traced twice by
  independent agents. 4498 tests green.
- L8: process failures worth keeping. Two agents were once launched on the same worktree (the first was only quiet,
  waiting on a background gate) and they overwrote each other's test edits; the lead now keeps one agent per worktree at
  a time. A unit integrated without its own full check (RFC-0025 U4) shipped twelve failing tests in another family
  because one double still answered the old extraction shape, which the lead found only when merging: the full check
  belongs to the lead and must run on the unit's own branch too, not only on the merged tree.

- L9 (2026-11-11): main `2df0c558` shares one TypeScript consumer Program between flow and origins per repository
  reading; origins-specific preparation remains lazy. Independent review and cleanup passed, 4510 tests passed,
  and all 105 corpus answers were identical.
- L10 (2026-11-11): main `a4bc689f` delivers RFC-0029 U7. Importers retain recorded relationship places; paths with no
  recorded line retain their category memberships. Independent review and recheck passed, 4513 tests passed, and
  the corpus gate found 11 importers-only differences: each adds only `places`, with the complete prior fact unchanged
  after removing that field. A real MCP probe preserved the prior fact and verified the recorded source lines. The
  RFC now shares the unresolved-reference predicate rather than deriving namers from valid places, which would lose
  namers without a valid line. ADR-0044 V0b.2 remains blocked by missing external-declaration evidence; the proposed
  host-declared classpath input awaits the owner's architecture decision.

- L11 (2026-11-11): main `857e56ae` preserves the prepared sources' existing parse hold through revision HeadReader,
  impact change readings and contract consumer sources; live readings use their capture hold. Shared preparation
  retains its own owner through nested scratch scopes. Independent review and cleanup found no remaining defect,
  4516 tests passed, and all 105 corpus answers were identical. Public tests verify ownership and release; no runtime
  or parsing reduction was measured.

- L12 (2026-11-11): main `543addaf` delivers RFC-0029 U4. MCP text honors the declared host or request byte bound;
  a request overrides the host, and insufficient space produces an explicit refusal. Successful bounded responses
  preserve their complete structured fields. Independent rechecks, 4522 tests and a real stdio MCP equivalence and
  byte-limit probe passed; all 105 corpus answers were identical. The discovery instruction budget remains unchanged.

- L13 (2026-11-11): delivery reconciliation against main `543addaf` separates three remaining acceptance gaps. N1
  has its typed-key/private-name slice on main, but six last-dot occurrences in five files remain in the frozen list;
  reconcile their classification with the original brief before completing that migration. L6 is implemented and its
  105-answer corpus gate passed without differences; its per-repository M4 acceptance evidence remains unverified.
  Java M0's full corpus measurement report was not located; a single-repository probe cannot establish acceptance.

- L14 (2026-11-11): main `a3a1dcb3` delivers framework-owned consumer continuations. One registered plugin collection
  extends the shared TypeScript reading; Angular owns resolver/input semantics, proven root scope and uncertainty.
  Independent branches retain their evidence, while repeated flow/member/caller derivations are reused per hypothesis.
  Type-only imports remain valid in type annotations and cannot prove runtime calls. All cleanup findings were closed,
  4563 tests passed, and all 105 corpus answers were identical. This does not close RFC-0025 U5 or RFC-0026.

- L15 (2026-11-11): main `90dd9433` delivers RFC-0025 U5. Map reads the TypeScript route configuration beyond a
  narrowing include and filters findings and framework reading cuts by the caller's original selection, preserving
  excludes and export cuts in revision and live. Language classification stays in its domain owner without expanding
  frozen fitness lists. Independent reviews closed all findings; 4569 tests passed and all 105 corpus answers were
  identical. Three real scoped probes recovered 5, 6 and 19 known routes from zero, with declaration paths checked
  against their snapshots. Initial source reads increased from 19/86/86 to 84/731/225; retained repeats made no new
  materialization or source-reader calls. Timing samples are not a controlled performance distribution. The clean
  integrated worktree and branch were removed; no push was made. RFC-0029 U5 is now unblocked by this prerequisite.

- L16 (2026-11-11): main `313615c3` adds the isolated S2 resource prerequisite: request-summary gap propagation
  reuses a reading-local graph. Acyclic calls share propagated causes; caller exclusion is evaluated only within the
  relevant cyclic component. The public own/inherited gap evidence, ordering, opaque targets, shapes and results
  remain unchanged. Independent code/cleanup review found no blockers; 4579 tests passed and all 105 corpus answers
  were identical. Work counters cover helper operations, not end-to-end runtime or live S2 behavior. The clean
  integrated worktree and branch were removed. The prerequisite was merged into the preserved S2 WIP; both distinct
  test groups were retained when resolving their insertion conflict. This does not deliver RFC-0028 S2.

## Framework plugin layer (owner, 2026-11-10; continuation delivered 2026-11-11)

Decision: ADR-0045 decision 12, amended by `15d68131`. Landed by `23786547`.

| Piece | Where |
|---|---|
| The contract a plugin is | `src/core/ports/framework-plugin.port.ts`: `FrameworkSignal` on two levels (project dependency, file module) and `FrameworkPlugin` (languages, signal, absent, entrypoints, consumer) |
| The vocabulary a reader consumes | `src/core/ports/router-vocabulary.port.ts`: `RouterVocabulary` over `ImportedName` (binding plus written members), so the plugin never touches the TypeScript AST (ADR-0008) |
| The first plugin | `src/core/adapters/frameworks/angular/angular.plugin.ts`, with conformance fixtures under `fixtures/routes/` run through the real registry |
| The registry, built in one place | `src/composition/framework-plugins.ts` |
| Consumer continuation | The plugin's `consumer` contribution receives the shared TypeScript reading through a syntax projection; generic flow and request origins retain their language owner. Angular owns resolver/input policy and root association. |
| Fitness | `src/composition/framework-plugins.single-rule.test.ts`: the router package, its configuration calls and `RouterModule` are declared only in the plugin; nothing outside `frameworks/` imports it; a wrapped reader is built only by the registry |

Consequence found while landing it: `adapters-are-independent` forbids `frameworks/<name>` and `typescript/` from
importing each other in both directions, so a plugin cannot import the reader it wraps; composition injects the factory.
Granted by the owner the same day: when the Angular readers move into `frameworks/angular/`, they get a frozen
exception shaped like `spring-reads-only-the-java-parser` (`angular-reads-only-the-typescript-parser`), and nothing else
gains that reach.

Delivered by `a3a1dcb3`: the third router recognizer and global input-binding flag are removed from generic flow;
consumer contributions use the actual registry, applicability signals and explicit `capability-absent`. The compiler
API and AST traversal stay in TypeScript; Angular receives projected syntax through a port. This needed no new adapter
import exception and does not move the complete language readers into Angular.

Remaining: `FRAMEWORK_PACKAGES` in `angular-projects.ts` is still a second reading of framework packages. Entrypoint
aggregation and the separately composed framework stages retain their outstanding applicability and migration work;
the consumer-stage delivery does not establish completion of every ADR-0045 stage.

- L17 (2026-11-11): main `5c6d5bf4` delivers RFC-0026 U1. Callback vocabulary and identities are accepted across
  domain, trace, composition, CLI and MCP, including selected evidence recovery. This unit adds no callback producer.
  Independent code and cleanup review completed; typecheck, architecture check and 4583 tests passed. The corpus gate
  compared 105 answers with no differences. U2 is reviewed and awaits its final check against this main.

- L18 (2026-11-11): main `cdef9064` delivers RFC-0026 U2. The existing Java hierarchy retains invoked platform and
  library supertypes, their local subtype closure, unsettled names per declaration and unplaced FQNs. Existing dispatch
  selection remains unchanged. Independent code and cleanup review completed; its quadratic accumulation finding was
  corrected with owned-array append. The final check passed 4584 tests and the corpus gate compared 105 identical
  answers. U3-U6 remain; no callback producer is delivered by U1 or U2.

- L19 (2026-11-11): main `0e0194fd` delivers RFC-0026 U3. Security and Bean Validation callbacks reuse the existing
  Java hierarchy, bean registration and handler helpers. Class precedence and unread-superclass uncertainty are
  covered by the corrected lookup and regression tests. Independent review and its correction recheck completed;
  the final check passed 4597 tests. Four real MCP probes confirmed the intended entrypoints and reverse callers.
  The corpus gate passed with 96 identical answers and nine explained differences: fourteen callback additions in
  four entrypoint answers, one reached callback in impact, and the same callbacks propagated into four workspace
  repository records. All other workspace fields were identical. The initially omitted workspace expectation was
  corrected by replaying cached answers, without rerunning engine queries. The merged worktree and branch were
  removed. Fifteen original RFC delivery units remain: RFC-0026 U4-U6, RFC-0027 U1-U8, RFC-0028 S2-S4 and RFC-0029 U5;
  final study acceptance and separate ADR debt are outside that count. S2 remains isolated and incomplete.

- L20 (2026-11-11): main `11526951` delivers RFC-0028 S2 and the guarded S1 value facts needed by its first boundary.
  HTTP sites and body origins share the summary lookup; independent callback summaries preserve nested request sites
  without asserting execution of their enclosing declaration. Schema 0.22.0 retains a known method when its path is
  unknown, and consequences retain causal evidence and exclude only positively incompatible methods. The full check
  passed 4,647 tests; focused regressions, mutations and fixed-revision MCP probes passed. The final corpus passed
  105 answers: five identical, 83 schema-only changes, and 17 semantic/provenance changes reconciled in the delivery
  report. Coverage withdrawals are explicit: 19 Petclinic links and 17 Realworld links remain uncertain instead of
  silently losing their source evidence. Shopizer preserves every old link, upgrades 170 suffix links to exact and
  adds one exact link; both callback DELETEs are retained. Callable frontiers remain a limitation, not a claimed
  improvement. All three prior main working-tree changes were preserved across integration. The clean merged S2
  worktree, branch and its own verified WIP backup stash were removed; the unrelated trace stash remains. Fourteen
  original RFC units remain; U4 and U5 of RFC-0026 are implemented but not yet integrated. Final study acceptance
  and separate ADR debt remain outside that count.

- L21 (2026-11-11): main `511a7662` delivers RFC-0026 U4. Bean-returned function values and anonymous contract
  implementations are explicit `unknown/no-extractor` items, preserving placed class callbacks. The shared hierarchy
  retains the creation location; no second parse or dispatch change was added. Root review and 17 focused tests
  passed; the final full check passed 4,650 tests, typecheck and architecture checks. All 105 corpus answers were
  identical: this slice is demonstrated by conformance fixtures, without a claim of new measured real-world coverage.
  The three prior main working-tree changes were preserved across integration, and the clean merged worktree and
  branch were removed. Thirteen original RFC units remain; U5 is implemented and reviewed, awaiting integration.

- L22 (2026-11-11): main `d3555e73` delivers RFC-0026 U5. Registered DGS annotation methods are callback
  entrypoints; unsupported type/meta-annotation uses, abstract methods and missing registration retain explicit
  uncertainty. The U4 and U5 branches and conformance fixtures were preserved through the merge. Root review and
  focused tests passed; the final full check passed 4,651 tests, typecheck and architecture checks. The corpus passed
  105 answers: 102 identical and three explained additions in Realworld (22 callback entrypoints, one reached callback
  in impact, and the same records in workspace). Removing only the added callback records makes all three raw answers
  identical to baseline, including metadata. A real MCP probe confirms both MeDatafetcher handlers and the requested
  caller at depth zero; its snapshot is fixed. The three prior main working-tree changes were preserved. The clean
  merged worktree is retained temporarily while its already-running U6 measurement uses the runner; remove it when
  that process ends. Twelve original RFC units remain; S3 is in implementation and U6 measurement is pending.
  U5 measurement completed before cleanup; its merged worktree and branch have now been removed.

- L23 (2026-11-12): main `2dd1408c` integrates RFC-0028 S3 response-start ownership. Full check: 4,665 tests; corpus: 113 identical answers, zero differences. The two fixed-revision MCP probes retain Shopizer option.component.ts:127 and JHipster account.service.ts:44; no false login use. The original Shopizer :101 acceptance remains behind the form-holder frontier assigned to S4, so S3 is not counted as fully closed yet.
- L24 (2026-11-12): main `c749c8c9` closes RFC-0026 U6 and its implementation delivery sequence. Four historical trace selectors now enter callback handlers; four caller counterfactuals add the expected callback. Schema migration and error-to-fact trace answers explain the historical direction reconciliation. The external corpus preserves the original 105 answers and adds eight callback answers (113 total); the shared final gate validates all 113 against accepted main. U6 check: 4,651 tests; documentation-only merge with the separately verified S3 source. Anonymous/lambda body placement and runtime HTTP validation invocation remain outside this RFC. Both completed worktrees and branches were removed after clean-state and integration checks. Eleven original RFC units remain fully unclosed, including S3's remaining form acceptance and S4.

- L25 (2026-11-12): main `aa7806cf` closes RFC-0028 S4 and the retained S3 acceptance. One holder table handles signal/readonly/computed/resource and form-control flow, using the existing import and receiver proof. The graph omitted a plain property read in the real directive; a lazy, reading-owned index over the same TypeScript Program now supplies those reads, with canonical owner file plus name. No public port, parser or carrier kind was added. Root completed the implementation after a clean partial writer delivery; focused RED/GREEN, bounded mutations (including source-generation cache ownership), cleanup, typecheck, arch:check and 4,674 tests passed. Fixed-revision real MCP assertions pass for Shopizer option.component.ts:101/:127 and JHipster account.service.ts:44, has-any-authority.directive.ts:28, settings.ts:48, with no false login use. The final 113-answer gate is identical in every family; the configured runner was tested and used at concurrency 3 without modifying its pre-existing owner edits. S3/S4 worktrees were cleaned after integration. Nine original RFC implementation units remain: RFC-0027 U1-U8 and RFC-0029 U5. Final study acceptance and ADR debt remain separate.

- L26 (2026-11-12): main `d955096c` implements RFC-0027 U7 initializer ownership. The Java reader marks anonymous methods deferred and initialization scopes as executing in the enclosing body; reconciliation applies that fact to written-only and indexed calls. Public block/field initialization regression and bounded classification/alignment mutations pass; typecheck, arch:check and 4,675 tests pass. The 113-answer gate changes only one callback trace: six newly explicit cuts at ArticleDatafetcher.java:314/:335 and CommentDatafetcher.java:44, confirmed against pinned sources; all other answers are identical. Fixed createArticle remains 11 steps, with cuts 17 -> 20 and an additional unnamed chain leaf: omission is fixed, but the original two-step study GREEN remains pending existing Java receiver proof. No dispatch rule was changed or weakened. Eight original RFC implementation units remain (RFC-0027 U1-U6/U8 and RFC-0029 U5), with study acceptance tracked separately. The completed worktree was removed.


- L27 (2026-11-12): main `834a75f1` implements RFC-0027 U8. Java type references join the existing retained B4 stage,
  reusing the held JavaProject and its strict type resolver. Native unresolved names stay query-relative and respect
  the existing distinction between a whole type and an owner reached only through a member. Root completed the
  implementation after a clean partial writer handoff, with one independent review, public/conformance regressions,
  bounded mutations and cleanup. The final check passes 4,681 tests, typecheck and architecture. The corrected corpus
  passes 113 answers: 101 identical, 12 explained callers/impact changes; all other families and both callback method
  counterfactuals remain identical. No declaration or entrypoint identities are removed. The fixed mapper probe is
  complete with ReadableShoppingCartMapper at line 74; source checks cover 216 proven-reference occurrence lines.
  The measured retained B4 repeat performs zero derivations; retention remains whole-snapshot, not per-file. Full
  reconciliation is in `/tmp/ye-ast-rfc27-u8-corpus-reconciliation.md`. Main matches the tested candidate tree exactly;
  all three prior owner changes were preserved before this log append. The merged worktree and branch were removed.
  Seven original implementation units remain: RFC-0027 U1-U6 and RFC-0029 U5. Final study acceptance and ADR debt are
  separate. U1's caller-place/declaration-span inconsistency needs the proposed bounded owner clarification before
  implementation; no new declaration selection policy has been silently introduced.

- **L28 — RFC-0027 U1 delivered** (2026-11-12): merge `8abd8361`, feature `1ad4b4c5`. The owner approved unique
  direct-child selection independent of caller position. B1 declarations reuse the existing TypeScript/Java parse;
  BaseReading owns the shared per-file model, joining index identities and proven containment without duplicates.
  Existing receiver and dispatch selection remains unchanged; U2 owns family consumption. Final check passes 4,691
  tests, typecheck and architecture; corpus passes 113 identical answers, zero differences. Eight bounded mutations
  were detected and restored. Main matches the tested tree; prior owner changes were preserved. No push. Six original
  implementation units remain: RFC-0027 U2-U6 and RFC-0029 U5; final study acceptance and ADR debt are separate.

- **L29 — RFC-0027 U2 delivered** (2026-11-12): merge `d5070686`, feature `81647967`. Outline, target
  candidates/selection, import declaration lookup and call ownership consume the same reading-owned DeclarationModel.
  Syntax-only targets remain explicit partial answers until U4/U5 traversal; unbound focus exposes span without an
  invented path. Real-index integration exposed and fixed header-alignment duplicates and the rejection of legitimate
  index-only overload target sets in the model owner; receiver and dispatch policy is unchanged. Cleanup, focused
  public queries/MCP regressions and twelve bounded mutations passed; final check passed 4,701 tests, typecheck and
  architecture. The corpus passed 113 identical answers, zero differences. Main matches the tested tree exactly; the
  feature branch was removed and the three prior owner changes were preserved before this append. No push. Five
  original implementation units remain: RFC-0027 U3-U6 and RFC-0029 U5; final study acceptance and ADR debt are separate.


- **L30 — Final five RFC implementation units delivered** (2026-11-12): main `949507ce` integrates RFC-0027
  U3/U4/U5/U6 and RFC-0029 U5. Literal and registered factory declarations share the existing model, binder and
  reconciler; Java references remain deferred and preserve accessibility/hierarchy vetoes. Literal member proof
  requires known property names, rejecting opaque spreads and computed keys through one shared syntax predicate.
  The exact clean candidate passed typecheck, architecture checks and 4,726 tests. The final corpus gate passed
  113 answers: five identical, 80 schema-only, 14 schema-driven composite identities and 14 explained payload changes;
  no status or exit changed. The merge carries its exact gate trailer. Two bounded independent reviews cover
  RFC-0023 through RFC-0029; confirmed integration defects were corrected and regressed. No original study closure
  is inferred from those reviews: the store trace reaches the API service but an unproven injected API URL remains
  a cut; external Java hierarchy evidence also remains explicit. Zero original RFC implementation units remain;
  the 106-item reprobe and separate ADR work remain open. The owner subsequently authorized committing the retained
  roadmap/corpus-runner changes, publishing main, and launching acceptance agents.
