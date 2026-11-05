# MCP capability implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`. The lead owns integration, reviews and Git; implementers do not commit or delegate.

**Goal:** Implement the four reviewed Task 4 capability designs without changing their accepted strategy.

**Architecture:** Extend existing query families and administrative boundaries. MCP owns repository targeting and projections; core owns consistent snapshots and workspace replay context; existing Install owns trust writes. Recompute answers for recovery instead of retaining final facts.

**Tech Stack:** Existing TypeScript 6.0.3, Node 24.22.2, MCP SDK, Zod and node:test; no new dependency.

**Specs:** `../specs/2026-11-04-mcp-typed-follow-ups-design.md`, `../specs/2026-11-04-batch-workspace-trust-design.md`, `../specs/2026-11-04-mixed-workspace-snapshots-design.md`, `../specs/2026-11-04-mcp-selective-evidence-recovery-design.md`; ADR-0022.

**Authorization and baseline:** The owner requested implementation after reviewing the four designs. This supersedes the parent plan's design-only restriction for Task 4. Tasks 1–3 are already implemented at `69ca3195804a85f85b432cf3ef38695e2fefe8cb`. The specs' observations of `602ffe6` are historical; preserve the current `mode` contract. The selective-recovery design includes the reviewed UI-route identity correction. Task 5 evaluation remains outside scope.

## Global constraints

- Reuse existing ports, query execution, canonical JSON, digest, redaction and trust writer. Preserve layering and dependency rules.
- MCP remains read-only. A declared catalog grants availability, never trust or workspace membership. No repository-controlled catalog enrollment.
- Keep exact snapshot and contributing-read provenance, analysis status, cuts and unknown reasons. No live-to-HEAD fallback, invented evidence or silently empty failures.
- No final-result retention, handle store, expansion tool, generic pipeline, default page size, token cap or new dependency.
- Preserve unselected common modes; extend recovery metadata explicitly with advertised/runtime parity for structural constraints. Cross-entry ordering/ID uniqueness and current membership/trust/snapshot assertions remain documented server semantic preconditions. Do not restore old `detail` or `full` boolean controls.
- All test writes use disposable directories and isolated trust stores; no network or writes to real trust declarations.
- Read project AGENTS.md and `.claude/skills/ye-ast-testing/SKILL.md`. Use meaningful public seams, failing tests before behavior, and targeted serial break proofs for consequential guards; restore mutations before delivery.
- Each unit requires focused checks, typecheck, architecture and an independent task review. The final integrated gate is `npm run check`.

## Review focus

- Same relative path in different repositories must route to the selected canonical owner; unknown IDs never fall back.
- Aliases and linked worktrees must not conflate trust identities or acquire the same live lock twice.
- A failed installation after trust write must report that write, preserve other outcomes and avoid a misleading ready registration.
- Replaying persisted workspace membership must pin snapshots without changing membership provenance or trusting the replay input.
- A live change, producer/configuration change, deadline or cursor mismatch must not emit a verified selected page; UI routes with unknown components retain selectable recorded evidence.

## Task 1: Declared repository targeting (design 4.1)

**Spec:** Read `docs/superpowers/specs/2026-11-04-mcp-typed-follow-ups-design.md` in full as the exact public contract.

**Files:** `src/core/ports/vcs.port.ts`, `src/core/adapters/git/git-vcs.adapter.ts` and its tests; `src/composition/compose.ts`, `mcp.ts`, relevant composition tests; `src/mcp/server.ts`, `render.ts`, proposed `repository-targeting.ts` and owner tests; README and RFC-0005/0015. Update directly affected typed test fakes when the required Vcs/composition method is added, without changing their behavior.

**Interfaces:** Produce `Vcs.canonicalRoot(repo: string, signal?: AbortSignal): Promise<Result<string, VcsFault>>`, `ComposedQueries.canonicalRepositoryRoot`, optional `McpDeps.repositories` and `repo?: string` on all seven tools. Preserve existing semantic query signatures. The existing GitDeps has no realpath method: add the filesystem injection at that adapter boundary rather than assume it exists.

- [x] Add decisive failing tests for routing every distinct local/workspace branch, omitted/unknown/ambiguous IDs, prototype-like IDs, identical relative files in two roots and preserved trust refusal.
- [x] Implement one catalog resolver using the reviewed dependency shape. Add canonical-root VCS behavior reusing root validation; preserve distinct linked worktrees and reject subdirectories. Test realpath aliases and typed failures through injected boundaries/disposable repositories.
- [x] Parse `mcp [<launch-root>] [--repo <id> <root>]...`; resolve launch overrides and collisions before serving; retain launch-only warm-up. Test malformed pairs, alias coalescing, canonical duplicates and no extra-root warm-up.
- [x] Integrate snapshot-qualified follow-up guidance and selected-root sidecars, preserving redaction and unknown/partial meaning. Test foreign/base/live navigation without claiming old-live retrieval.
- [x] Update implemented discovery/README/RFC guidance, run focused SDK/composition/Git tests, typecheck, architecture and diff checks. Record exact logs and source manifest; do not expose later recovery or mixed-live arguments.

**Delivery:** Task-scoped report and reviewable patch. Batch registration is consumed by Task 2; do not add an unused batch API in this unit.

## Task 2: Batch trust installation (design 4.4)

**Spec:** `docs/superpowers/specs/2026-11-04-batch-workspace-trust-design.md`.

**Files:** Existing install port/use case/tests, CLI parser/report/tests, composition wiring/install tests and implemented installation docs.

**Interfaces:** Consume Task 1 canonicalization and catalog argv. Produce reviewed `Install.runBatch(BatchInstallRequest): Promise<BatchInstallReport>` alongside unchanged `run` behavior; extend existing install failure stages without replacing fault kinds or trustRecorded.

- [x] Test preflight conflicts and zero writes, canonical coalescing, selected/opposite/unselected trust modes, failure after trust, continuation after ordinary failure, layer not-written and cancellation.
- [x] Implement deterministic sequential reuse of Install.run, exact per-target outcomes, current writer semantics and no rollback claim.
- [x] Implement repeated `init --repo <id> <path>` with explicit launch root and one common trust choice; preserve single-target behavior. Print structured launch registration only after complete successful batch. Verify documented exit codes and redaction.
- [x] Prove actual separate trust records/exclude behavior with disposable roots, including linked worktrees and paths with spaces. Run focused tests, typecheck, architecture and diff checks; review this unit.

## Task 3: Recovery identity and committed workspace replay (design 4.2 foundation)

**Spec:** Selective-recovery design, workspace replay and identity/recipe sections. Do not advertise select/page until Task 5.

**Files:** Existing workspace ports/use cases/tests, MCP response/schema owner and proposed recovery module, digest injection in composition, protocol request/result consumers and relevant docs/tests.

**Interfaces:** Produce reviewed `WorkspaceReplayContext`, `WorkspaceReposRequest.replay`, `FactRead.workspaceReplay` and MCP recovery metadata. Reuse Digest/canonicalJson and current public filtering/redaction. This interface is consumed by mixed capture in Task 4.

- [x] Test pinned committed replay with unchanged persisted source, moving branch, changed effective declaration/trust, unavailable remote and complete recipe validation/secrecy.
- [x] Implement declaration fingerprint and same-membership SHA pins with current trust/authorized-remote checks; carry context through protocol and workspace impact without final-fact retention.
- [x] Add unselected result identity and pinned recipe after public filtering/redaction, excluding presentation and sidecars. Preserve merge-base semantics; make deadline/unresolved/redacted context explicitly unavailable. Test semantic/producer/config differences and presentation invariance.
- [x] Verify advertised schemas, redaction and actual stdio; run focused checks, typecheck, architecture and review. Leave future live workspace capture unsupported until Task 4.

## Task 4: Operation-scoped mixed snapshots (design 4.3)

**Spec:** `docs/superpowers/specs/2026-11-04-mixed-workspace-snapshots-design.md`.

**Files:** Workspace/live query ports, topology capture/application owners, head reader and impact reuse seams, existing live lifecycle/adapter only as needed, composition, supported transports and owner tests/docs.

**Interfaces:** Consume canonicalRoot and WorkspaceReplayContext. Produce operation-only SnapshotChoice/WorkspaceMember, callback-scoped capture map, repository-scoped workspaceLive notices and closed fault mapping as specified. Persisted manifest authority stays unchanged.

- [x] Prepare private exclusive revision/live validation and committed regression tests. Keep public shared member types committed-only until discovery, callers, ofChange and decisions support captured states together; keep MCP exclusions until full transport integration.
- [x] Capture each selected state once with canonical lock ordering; reuse live extraction and compatible prepared SHA views, preserving each committed family's selection and budget (ADR-0023). Reject duplicate mirror aliases before locking; no nested reacquisition or context escaping.
- [x] Integrate captured trigger merge-base/live diff, complete contributing reads, stale/staleness-unavailable sidecars, fresh-capture replay assertions and cancellation cleanup.
- [x] Test two opposite-order concurrent operations, mutation after capture, failures midway, cancellation during wait/walk, trust refusal, untracked/removed routes and all resource releases using public seams/disposable roots.
- [x] Migrate supported MCP/protocol/CLI consumers coherently, publish equivalent schema/runtime unions, retain unsupported subsets explicitly where specified. Run focused checks, typecheck, architecture and review before exposing capability.

## Task 5: Typed selections, stateless pagination and integration (design 4.2 completion)

**Spec:** Selective-recovery design, exact selection records, projection schema, cursor execution and acceptance tables, including corrected UI-route identity.

**Files:** MCP recovery, pure selection owner, existing output-schema owner and renderers, composition/stdio tests and implemented docs. Reuse core replay/capture interfaces from Tasks 3–4.

**Interfaces:** Implement reviewed EvidenceSelection, projection/receipt unions, explicit positive safe-integer page limits, source expect and versioned result-bound cursor. Each primary item/context comes from the recorded source.

- [ ] Test each category through its applicable public tool branch with exact source records, zero/unknown/partial cases, independent indexes, dangling links and UI component-known/unknown identities.
- [ ] Implement selected summary/details/full and model-visible coordinates/recipe without changing source analysis. Preserve global cut summaries and necessary referenced context.
- [ ] Add strict stateless cursor decoding and continuation; verify source before emitting items. Test repeated byte-identical pages, exact coverage once, changed live/config/producer/selection/limit, malformed cursors and replay-unavailable deadlines.
- [ ] Prove every page executes the existing query again; retain no final-result/cursor/recipe store. Verify output schema/runtime parity, secrets and cancellation at SDK/stdio seams.
- [ ] Update integrated discovery/docs and run `npm run check`, diff checks and final whole-change review. Record limits without claiming client/model exposure, savings or adoption; those remain Task 5 of the parent evaluation plan.
