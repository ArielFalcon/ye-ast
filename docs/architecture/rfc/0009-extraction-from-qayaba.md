# RFC-0009: Extraction from qayaba

- Status: Draft, 2026-10-29
- Related: [ADR-0001](../adr/0001-product-scope-and-priority.md), [ADR-0006](../adr/0006-qayaba-graph-state-per-run.md),
  [RFC-0001](0001-architecture-and-layers.md), [RFC-0002](0002-facts-contract.md),
  [RFC-0003](0003-codegraph-integration.md), [RFC-0004](0004-deterministic-map.md)

**In short:** ye-ast starts from qayaba's deterministic modules in their post-migration form. This RFC lists what moves,
what splits, what stays in qayaba, the couplings to remove on the way, and how each family is taken in. Paths are
relative to qayaba@cfc69e3b `engine/src/`, its main after the migration; bounded contexts live under
`contexts/<context>/`, and only `shared-kernel/` and `shared-infrastructure/` sit directly there.

## What moves

| Family | Modules |
|---|---|
| Change structure | `shared-kernel/diff-parser/` without `changedElements`; `shared-kernel/{diff-hunks,change-slice,blast-radius,file-classes,vendor-dirs,changed-decision}.ts`; `contexts/generation/domain/diff-stat.ts`; `shared-infrastructure/decision-listing.ts` |
| Graph | `shared-kernel/code/index.ts` (walk policy); `shared-infrastructure/code-graph/*`, rewritten over the SDK ([RFC-0003](0003-codegraph-integration.md)), with git co-change (`git-co-change.adapter.ts`) |
| Module resolution | `shared-infrastructure/module-resolution/{module-resolver,dynamic-loads,unlinked-uses}.ts` |
| Entrypoints | `contexts/generation/infrastructure/route-table/`; `contexts/generation/domain/{route-table,declared-resources}.ts` (base vs head) |
| Contracts | `contexts/generation/infrastructure/consumer-expectation/`; `contexts/service-topology/domain/{response-fields,operation-url-pattern}.ts`; the operation diff is `reach-proofs/openapi-operation-diff.ts` (Reach) |
| Topology | `contexts/service-topology/infrastructure/{openapi-http-resolver,http-backend-resolver,event-resolver}.adapter.ts` (FE-BE, BE-BE, events) with their catalogs `{event-pattern,call-pattern,call-site}-catalog.ts`; `shared-kernel/service-links.ts`; `contexts/service-topology/domain/{cross-repo-impact,link-graph,operation-diff}.ts`; `contexts/service-topology/application/profile-scorer.ts` with `domain/profile-score.ts` without `ProposerFeedback` |
| Reach | `contexts/change-analysis/domain/reach-proof.ts` and `reach-proofs/`, generalized from pages to entrypoints |
| Safety | `shared-infrastructure/repo-reader.ts`; from `spec-path-confinement.ts` only `walkRepoFiles` and `REPO_WALK_LIMITS` (`:311-328`); `shared-infrastructure/redaction/{pattern-redaction.adapter,redact-and-bound}.ts`; `shared-kernel/redact-then-bound.ts` |
| Coverage over ingested reports | changed-line assembly (`contexts/objective-signal/domain/assemble-change-coverage.ts`); statement code lines (`contexts/objective-signal/infrastructure/statement-code-lines.ts`) |

Of Safety, the pattern redaction moved first, to `core/adapters/redaction/` behind `core/ports/redaction.port.ts`,
with qayaba's tests; its by-value pass is a function the caller passes. `repo-reader.ts`, the walk and the two
bound modules move with their first consumer in ye-ast: each carries fixed caps, and ye-ast sets no limit before
measurements justify one.

Of Entrypoints and Module resolution, the Angular route extractor, `route-table.loader.ts` and `module-resolver.ts`
moved to `core/adapters/typescript/` (qayaba@cfc69e3b), with their fixtures as the adapter's tests. The language
registry's facts they used became `core/domain/languages/typescript.ts`. What did not move: the working-copy walk and
the 4,000-file route cap, the base-versus-head reading, and `route-table.ts`'s matching (`matchRoute`, evidence
statuses). The caps became signals: the child-table depth (8) and the re-export depth (12) are cycle detection, the
resolver's 6 rounds run until no new file is asked for, and the `MAY_HOLD_ROUTES` prefilter is dropped. The loader's
reason strings are not kept: an unresolved item carries the reason of the fact contract and its location. The module
resolver's `governingConfig` and the dynamic-load and unlinked-use readers stay for their consumers.

The lcov, c8 and JaCoCo collectors (`contexts/objective-signal/infrastructure/{lcov,c8,jacoco}-coverage.adapter.ts` and
`coverage-collector.adapter.ts`) are not listed: qayaba's migration branch deletes them (commit b3deb252, "remove the
code target"). The two coverage pieces that remain are re-checked against the post-migration tree.

## What splits

| Module | To ye-ast | Stays in qayaba |
|---|---|---|
| `shared-kernel/change-map.ts` | the change map | seeding use-case candidates (imports `UseCaseCandidate`) |
| `shared-kernel/diff-parser/` | hunks, changed lines, literals | `changedElements` (`diff-parser.service.ts:145`): page labels, Angular interpolation |
| `contexts/change-analysis/domain/page-files.ts` | implementation files per entrypoint | the join with the LLM map, retired by [RFC-0004](0004-deterministic-map.md) |
| `contexts/objective-signal/` | which changed lines are code | V8 dumps, source maps of served bundles, mutation, gating |
| `contexts/generation/` route availability | route-table comparison (`domain/route-table.ts`) | classification against DEV redirects (`domain/route-availability-classifier.ts`) |
| `shared-infrastructure/spec-path-confinement.ts` | `walkRepoFiles`, `REPO_WALK_LIMITS` | the confinement of the E2E paths an agent reports |

## What stays in qayaba

- Running or observing an application ([ADR-0001](../adr/0001-product-scope-and-priority.md) decision 1): Context Pack
  and DOM capture, observed requests and data shapes, expectation gaps against live responses, Playwright harness
  facts, bundle mutation, fault injection.
- Coverage policy and gates.
- `contexts/run-orchestration/domain/context-map-validity.ts`, which compares two git trees with a file-suffix rule
  built for an LLM-written map ([RFC-0002](0002-facts-contract.md) rule 5).
- The onboarding job and its LLM proposer (`contexts/service-topology/infrastructure/llm-profile-proposer.adapter.ts`,
  `application/onboarding-service.ts`, `application/ports/profile-proposer.port.ts`), with the `ProposerFeedback` type
  they share from `domain/profile-score.ts:17`.
- The per-run secret scope (`shared-kernel/run-secret-redaction.ts`), which hands by-value secrets to the redaction
  module inside the orchestrator, and `shared-infrastructure/redaction/session-secrets.ts`, which adds a Playwright
  login session's values to that scope (`:1-3,11-13`): the module moves, the secrets stay with the host
  ([ADR-0010](../adr/0010-trust-modes.md) decision 5).
- The E2E confinement in `shared-infrastructure/spec-path-confinement.ts`: it confines the paths an agent reports for
  E2E files (suite specs, the `.qa` manifest and map, Playwright setup; `:1-4`). Only the walk moves.
- Every E2E vocabulary type.

## Couplings to remove on the way

ye-ast removes these as it moves each module; qayaba keeps its code as it is and runs on it meanwhile. The owner,
on 2026-10-30 (translated): "you don't need to ask it for engine changes, you make those in this project, because the
other one keeps working with that code in the meantime".

- Cross-context imports:
  - `contexts/change-analysis/infrastructure/adapters/change-scope-port.adapter.ts:21` → `generation` route ranking
    (`rankRoutesWithRelevance`, called at `:230`);
  - `contexts/generation/infrastructure/consumer-expectation/typescript-expectations.ts:29` → `service-topology`
    (`requestServesOperation`).
- Application-layer I/O in `contexts/service-topology/application/resolve-cross-repo-impact.use-case.ts`: its only
  direct I/O, outside its ports, is one `existsSync` (lines 4 and 73).
- `shared-infrastructure/repo-reader.ts` imports `readOwnedSpecFile` and `readFailureReason` from the E2E confinement
  (`:5`) to read each walked file and name why a read failed (`:87,91`). That confinement stays in qayaba, so ye-ast's
  confined reader replaces them.
- `shared-infrastructure/redaction/pattern-redaction.adapter.ts:5` imports `redactByValueCounted`, which reads the
  secrets of the run the call belongs to from an async-context store (`shared-kernel/run-secret-redaction.ts:39,151`).
  That scope stays in qayaba, so ye-ast's redaction module takes the by-value secrets as an argument from the process
  that holds them.
- Silent fail-open results that return empty instead of `unknown` ([RFC-0002](0002-facts-contract.md) rule 1). Two
  cases:
  - a code-graph failure or timeout becomes an empty structural block that only the logs and the run's trace attributes
    record (`contexts/change-analysis/infrastructure/adapters/structural-signal-port.adapter.ts:85-100`);
  - the impact walk stops at its depth bound and says nothing
    (`shared-infrastructure/code-graph/codegraph-store-reader.mjs:295`); in ye-ast that stop is a `depth` cut
    ([RFC-0003](0003-codegraph-integration.md)).
- Walk policy constants tuned on one index, to become configuration (defaults and their origin in
  [RFC-0003](0003-codegraph-integration.md)).

## Intake from qayaba

qayaba is not asked to change for the extraction. The three constraints recommended earlier (an ADR naming a
destination context, a dependency-cruiser rule against E2E imports, a freeze on new silent fail-open) were withdrawn
on 2026-10-30. The owner's answer to withdrawing them in favour of the intake below: "Si".

The modules were first checked at `dad6ad47`. The migration reached qayaba's main at `cfc69e3b`, and the owner
reported it finished on 2026-11-01; its own document marks the root rename done
(`docs/engine-platform-architecture.md:230`) and leaves nothing pending in these families.

The diff `dad6ad47..cfc69e3b`, read on 2026-11-01:

| Change | Effect on this RFC |
|---|---|
| `qa-engine/src/` became `engine/src/`; almost every module listed here moved with identical content | paths above rebased |
| `diff-stat.ts` moved to `contexts/generation/domain/` and lost its size tiers and time budget | row updated; only `DiffStat` and `diffStat` remain |
| `file-classes.ts` lost `isLowRelevance` and `isStyleSheet` | less to move |
| `pattern-redaction.adapter.ts` reads an assignment's value up to the end of the match, so a quoted value with spaces is checked whole | taken as it is |
| `redact-then-bound.ts` was rewritten, and `redact-and-bound.ts` serves it to `structural-signal-port.adapter.ts:4,64` | added to Safety |
| `change-map.ts` imports `sameSpecPath` from `shared-kernel/spec-path.ts` instead of a local `sameFile` | the E2E part still splits off |
| the LLM profile proposer moved into `service-topology` and imports `ProposerFeedback` from `profile-score.ts` | `ProposerFeedback` stays in qayaba |

Every coupling listed above is still present at `cfc69e3b`, at the lines given. No new silent fail-open appeared in
these modules. When ye-ast takes a family after `cfc69e3b`, it diffs that family from `cfc69e3b` the same way; every
coupling or silent fail-open the diff adds joins the couplings above, and ye-ast removes it as it moves the module.

## Open questions

The owner accepted these recommendations on 2026-10-30 (translated): "yes, I accept them all".

| # | Question | Recommendation |
|---|---|---|
| 1 | Record constraints in qayaba's migration now? | Withdrawn on 2026-10-30: qayaba is not changed for the extraction; ye-ast diffs each family at intake ("Intake from qayaba") |
| 2 | During the transition, does qayaba keep its own copies until it consumes ye-ast? | Two copies exist only during a family's parity window: the parity harness runs both side by side, qayaba switches module family by module family behind its ports and deletes its copy at the switch, and a change to that family during the window lands in ye-ast first |
