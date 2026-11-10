Objective: the order in which every designed engine-gap unit is implemented, by smaller models without lead supervision.
Branch: one worktree branch per unit from the current `main`; local `main` only, never pushed.
Delivery: one unit per branch and commit; one corpus gate per integration into `main`. Test runner: node:test (`npm test`).

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

Lane C, assembly line (another thread is implementing N1 `t3/name-tail-rule` and a candidate-language filter `t3/candidate-language-filter`; L3 is on main as "delivered, partial", see the ADR-0045 units table):
- C1 L2b → C2 N1 (in progress elsewhere; skip if on main) → C3 L6 → C4 M1 measurement → C5 L4a → C6 L4b → C7 L5-pre → C8 L5-shared → C9 L5-live. L1c is optional, any time. Status: pending.

Lane D, binder:
- D1 RFC-0024 U1 DONE `768893f4`+`6b2aab56`; D2 U2 DONE `251435ae` (in main `1896eb65`) → D3 U3; D4 U4 after U2; D5 U5 after U3. Status: U1 done, rest pending.

Lane E, Java closure (ADR-0044):
- E1 M0 → V0a.1 → V0a.2 → V0a.3; V0b.1 DONE, `eb999856` + `d7052d12` + `0e1a6501` (in main `58853d45`) → V0b.2 after V0a.1; V1a.1 → V1a.2; V1b.1a DONE `30349896`+`4259282f`+`78985315`; V1b.1b DONE `7c34df05`+`644d17df`; V1b.1c DONE `f3d0b1da`+`07d8c1e0` (in main `bd43192c`) → V1b.2, V1b.3 → V1b.4, V1b.5 → V1b.6; V2.1 → V2.2; V3.1 → V3.2 → V3.3 (needs V0a, V0b, V1, V2 and M3 of lane C); V4.1 DONE `6b0b4f32` → V4.2, V4.3 (V4.1 was high-risk item 3, a new flag); V5.1 DONE `af824c9f`; V5.2 after V5.1 and RFC-0028 S1. Status: pending.

Lane F, declaration model (after lane D U1-U4):
- F1 RFC-0027 U1 → U2 → U3 → U4 → U5; U6 after U2 and RFC-0024 U2/U4; U7 any time after L1b; U8 after U0 (removes U0's cut where it reads the relation). Status: pending.

Lane G, frameworks:
- G1 RFC-0025 U1 DONE `54315669`+`5bcc416d`; U2 DONE `59d46c21`+`2842e455`; U3 DONE `febc9ad8`+`a4dc6e6d` (in main `7581a191`) → U4; G2 RFC-0025 U4 (before RFC-0026 U3); G3 RFC-0025 U5 (before RFC-0029 U5).
- G4 RFC-0026 U1 → U2 → U3 (after RFC-0025 U4) → U4 → U5 → U6.
- G5 RFC-0029 U5 (after RFC-0025 U5). Status: pending.

Lane H, value flow:
- H1 RFC-0028 S1 DONE, `aca59224` + `8241c127` + `7b64196c` (in main `58853d45`) → S2 → S3 → S4. Status: S1 done, rest pending.

Lane I, change seeding (ADR-0043):
- I1 U1 → U2a → U2b → U3 → U4. Status: pending.

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
