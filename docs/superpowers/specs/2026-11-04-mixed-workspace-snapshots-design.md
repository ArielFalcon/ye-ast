# Mixed workspace snapshots

**Status:** Implemented by Task 4 of the [capability implementation plan](../plans/2026-11-04-mcp-capabilities-implementation.md). **Design baseline:** Observed HEAD: `602ffe695f3e4130f8b5a603e20ccbaa85717200`. The common response modes and the interfaces below are prerequisites or proposals, not claims about merged APIs. [ADR-0022](../../architecture/adr/0022-typed-query-replay-and-selective-evidence.md) decides the strategy; [the plan](../plans/2026-11-04-common-mcp-response-modes.md) defines the work.

## Intent and boundary

A workspace operation reads each selected repository at one committed revision or one live state, and uses that same state for discovery, links and every walk. Trust is external and checked separately for each live repository. The snapshot vector is not an atomic cross-repository instant. There is no live-to-HEAD fallback, historical live retrieval, final-result cache, new generic execution pipeline, or change to shared workspace scope. This design does not implement or measure the capability.

## Current mechanism

`src/core/ports/workspace-repos.port.ts` aliases the persisted declaration, which has `path`, optional `id`, `revision` and `remote` in `src/core/domain/topology/workspace-manifest.ts`. `workspace-queries.ts` resolves membership, optionally refreshes authorized remotes, prepares commits and produces repository sections and snapshots. `workspace-impact.ts` uses discovery, then executes trigger and consumer walks and records each contributing read. Its consumer walk currently substitutes `HEAD` for a non-SHA snapshot; that branch must be removed before live workspace reads are exposed.

`src/core/application/live/live-tree.ts` exports `openLive(deps, request, use)`: it locks, refreshes, invokes the callback under the lock, releases in `finally`, then checks staleness and sweeps. `LiveTree` is valid only inside the callback; independently calling a live query inside that callback reacquires the same lock and can deadlock. `src/composition/compose.ts` already gives workspace impact an operation-scoped `withSnapshotPreparation`; standalone workspace and decisions use the regular workspace family. The current MCP schemas in `src/mcp/server.ts` exclude live with workspace and offline and expose `detail`/`full`; retain those exclusions until the complete capability ships. `FactRead` carries roots, sources and refresh outside the fact. `SnapshotRef` already represents SHA or live `head` plus `stateId`.

## Proposed request contract

The following are proposed types, not installed signatures. Keep the persisted manifest format unchanged: live is an explicit operation selector, not an authority or persisted trust setting.

```ts
type SnapshotChoice =
  | { revision?: string; live?: never }
  | { live: true; revision?: never };
type WorkspaceMember = { path: string; id?: string; remote?: string } & SnapshotChoice;
// WorkspaceRequest.repo and WorkspaceReposRequest.repos use WorkspaceMember.
// WorkspaceOfChangeRequest has base: string; its repo choice selects the head.
```

Validate nonempty revisions, paths and IDs, `live` literally `true` when present, and reject both fields even if presented by an untyped caller. Missing choice preserves existing local `HEAD` or authorized committed-remote resolution; persisted members retain their committed revision. An explicit list replaces persisted membership as today. Duplicate IDs remain `duplicate-repository`; aliases resolving to the same live mirror location must be rejected before acquisition with proposed `duplicate-workspace-source`, preventing self-deadlock. Do not infer trust from membership, remote, selector, or source content.

Proposed MCP mapping, in the same migration as schemas and runtime validation: `ye_ast_workspace` accepts top-level `revision` or `live: true`, and each `repos[]` accepts `revision` or `live: true`; `ye_ast_callers` uses those top-level choices plus `workspace.repos[]`; `ye_ast_impact` uses top-level `head` or `live: true`, mandatory `base`, plus member choices. `workspace: {}` still uses eligible defaults; omission still means local impact/callers. Optional targeting from 4.1 resolves the declared ID before core invocation; omission selects the launch repository. It must not change membership or trust. For live members, never refresh their remotes; `offline` controls only committed workspace remote refresh and may coexist with live in workspace operations. Local-only restrictions stay as currently documented until separately migrated. Unknown fields, `live: false`, and same-repository revision/live combinations fail schema and runtime validation; publish equivalent JSON Schema exclusions. No member selector overrides the trigger selector.

## Operation and lifecycle

Proposal: resolve membership, canonical worktree roots through Task 4.1's `Vcs.canonicalRoot`, identity and external trust first; reject an untrusted live selection with existing `live-requires-trusted` before opening its tree. Resolve each committed source once using current refresh rules; live always uses its declared local clone. Capture all selected live trees with `store: true` using the same shared scope and export selection, in a globally deterministic order of canonical declared live roots. Use nested `openLive` callbacks so every successful lock stays held through the complete discovery, matching and walk operation; unwind in reverse order. Canonical root ordering across operations prevents lock-order cycles. Canonicalization must identify aliases that map to one mirror before acquisition; it cannot be a string comparison over unnormalized paths. Do not acquire the same location twice. A failure during capture unwinds every acquired callback. This is deliberately an operation-scoped lease, not a persistent store: holding the locks prevents a second refresh from changing a mirror while walks use it.

Use the following proposed **application-internal** context and callback seam (not a public handle):

Implementation reconciliation, 2026-11-05: [ADR-0023](../../architecture/adr/0023-operation-snapshot-views-and-safe-retention.md)
preserves existing committed family selections and budgets. Committed states may have distinct operation-owned
`PreparedCommit` views of the same pinned SHA; live states retain one held capture and extraction. This replaces the
draft's literal one-extraction requirement for SHA states, without changing the selected state, wire vector or trust.

```ts
type CapturedRepository =
  | { kind: "sha"; repo: string; declaredRoot: string; sourceRoot: string;
      snapshot: Extract<SnapshotRef, { kind: "sha" }>; trust: TrustMode;
      prepared: ReadonlyMap<"discovery" | "callers" | "change", PreparedCommit> }
  | { kind: "live"; repo: string; declaredRoot: string; sourceRoot: string;
      snapshot: Extract<SnapshotRef, { kind: "live" }>; trust: "trusted";
      live: LiveTree; tree: CommitExtraction };
type CapturedWorkspace = {
  membership: WorkspaceInForce;
  captured: ReadonlyMap<string, CapturedRepository>;
  unavailable: readonly {
    repo: string; snapshot: Extract<SnapshotRef, { kind: "sha" }>;
    reason: "revision-unavailable";
  }[];
  workspaceReplay: WorkspaceReplayContext;
};
```

A proposed `withWorkspaceSnapshots(request, use)` in `src/core/application/topology/workspace-snapshots.ts` resolves membership and invokes `use(captured)` inside the nested live leases and existing committed preparation lifetime. Its exact proposed signature is `withWorkspaceSnapshots<T, F>(request: WorkspaceRequest, use: (context: CapturedWorkspace) => Promise<Result<T, F>>): Promise<Result<WorkspaceSnapshotRead<T>, F | WorkspaceFault>>`; an explicit unavailable committed remote stays a separate unavailable plan with its pinned SHA, not a fabricated `CommitExtraction`. Reuse the existing `PreparedCommit`, `CommitExtraction` and `LiveTree` types, importing them from their current application owners. The private `WorkspaceSnapshotRead<T>` carrier contains the callback value as `value`, plus optional `workspaceReplay` and `workspaceLive` metadata. Construct that carrier only after live postludes and owned cleanup finish; callback handles and preparation never enter it. This keeps observations separate from the callback value without changing a public fact schema. Only successful SHA/live captures appear in `captured`; `unavailable` carries the separately pinned missing reads, and `membership` preserves its actual source. `workspaceReplay` is owned by Task 4.2 and includes the complete selected snapshot vector, including known unavailable SHA sections; discovery's unavailable plans still produce their existing unknown sections.

`sourceRoot` names the declared clone or authorized Git mirror. Each SHA prepared view owns the export and index
selection its family already uses, under the same pinned SHA and existing budget; compatible views may share. Prepare
only views needed by the operation. For live, `live.root` is the already-captured index tree. Build its `tree` once from
the captured bytes using the existing reader/extractor seams and reuse it throughout the operation. No family rereads
the working tree or reacquires a held live location.

Inject that operation-local map into the existing head-reader/impact dependencies, and make `createHeadReader` use a matching captured tree before opening a new live lease. Match canonical root, selected snapshot kind and effective scope; a mismatch is a typed capture failure, never reuse of another capture. Existing public query families remain the invocation seam, but their captured path must not call `openLive` again. Refactor the single-repository live processing to share the same extraction/walk code. Contexts cannot escape the callback or enter a cache. Discovery-only workspace and decisions use the same lifetime; decisions must not reacquire locks. Current trust is checked during capture and used consistently for that operation; each later operation checks again.

The exact read-context extension from [Task 4.2](2026-11-04-mcp-selective-evidence-recovery-design.md) is `WorkspaceReposRequest.replay?: WorkspaceReplayContext` and `FactRead.workspaceReplay?: WorkspaceReplayContext`. Resolve and verify its current declaration fingerprint before acquisition. A SHA pin changes read revision inside the same membership provenance. A live pin is compared with the fresh capture's head/stateId; mismatch becomes `workspace-replay-mismatch` before any walk. Emit the actual context with the resulting fact; do not store it between operations.
On completion, perform each live tree's existing stat comparison against its captured manifest and attach notices by repository ID. A mutation while capture or traversal runs cannot change the mirrored bytes being read; it must yield a stale notice if the existing stat comparison detects it. Stat comparison does not prove that no change escaped detection. Preserve the state actually captured, not the newer working tree. If the staleness check cannot run, do not assert freshness: propose a repository-scoped `staleness-unavailable` sidecar with typed cause, because silently dropping this failure would imply a successful check. Release all locks and scratch preparations on faults, thrown exceptions and cancellation; pass the operation signal to waits, refreshes, reads and walks. Once cancelled, do not emit a successful result or advertise replay. Retention sweeps occur only after their lock is released, following current `openLive` behavior; never sweep another held capture. Each destructive scope or associated-debris deletion must reserve that scope's lock atomically without waiting and skip busy scopes; an earlier lock observation is not sufficient authority to delete (ADR-0023).

Proposed per-repository sidecar, separate from the existing local `live` notice:

```ts
type WorkspaceLiveNotice =
  | { kind: "stale"; repo: string;
      snapshot: Extract<SnapshotRef, { kind: "live" }>;
      notice: LiveStaleNotice }
  | { kind: "staleness-unavailable"; repo: string;
      snapshot: Extract<SnapshotRef, { kind: "live" }>;
      cause: LiveFault | VcsFault };
// FactRead.workspaceLive?: readonly WorkspaceLiveNotice[];
```

`LiveStaleNotice` keeps its existing `stateId` and `changed` fields. Collect notices after callbacks unwind, sort by repository and publish them as `workspaceLive` in workspace transport responses; absence never claims an atomic fresh workspace. Keep local responses' existing `live` sibling unchanged. Both sidecars are redacted and excluded from Task 4.2 identity. Do not return a serialized response before post-callback stale checks complete.

## Diff, provenance and failures

For impact, resolve `base` to a commit and compute the merge base with the captured trigger's committed head. For a live trigger, compare that merge base against the captured live export, including staged, unstaged and untracked changes, using the existing live diff mechanism; neither reread the working tree nor substitute the head commit. Base-side extraction and removed-entrypoint handling remain at the explicit merge-base snapshot. `changed` filters trigger diff seeds; the common `scope` continues to apply to every repository. Other repositories have no implied diff base.

Keep the sorted full `repositorySnapshots` vector for successful captures, including each live `{ repo, kind: "live", head, stateId }`, and retain discovery, trigger, upstream and downstream `FactProvenance` reads per section. Unavailable committed remote sections retain their existing `revision-unavailable` unknown and pinned SHA; never invent a live snapshot on capture failure. Preserve cuts and section uncertainty, and use existing composite partial rules. Carry per-repository stale and staleness-unavailable sidecars outside deterministic facts, redacted at the transport boundary. Do not merge changed paths across repositories. A failed live capture fails the operation with repository ID and the underlying typed fault; it is not an empty section or a committed substitute.

Existing `LiveFault` covers `live-requires-trusted`, `unsupported-object-format` and `live-mirror-failed`; `VcsFault`, `ImpactFault`, `WorkspaceFault` and existing unknown `index-unavailable` continue to own their respective failures. Map interrupted/unfinished live refresh (`LiveFailure`'s `unavailable`) to the existing query family's `index-unavailable` unknown where a valid fact base exists; otherwise propose a repository-scoped `workspace-capture-unavailable` fault. Map cancellation to the existing transport cancellation behavior, not a fabricated fact. Add proposed `duplicate-workspace-source` and `staleness-unavailable` to the appropriate closed unions and adapters; preserve cause and repository without exposing absolute paths publicly. Existing unavailable-remote semantics remain intact. Do not advertise a stable identity for deadline-cut results.

Replay (4.2) captures again, checks declarations and trust again, and compares the identity derived from the full public fact and normalized snapshot vector. SHA choices are pinned for replay; a live choice stays live and includes both captured head and stateId in identity. A mismatch produces 4.2's typed identity failure before selected data or a page is returned. Stale sidecars and absolute roots are excluded from identity. There is no request to retrieve the previous live state.

## Ownership and integration

- `src/core/domain/topology/workspace-manifest.ts`: keep persisted contract; define an operation-only selection type in `src/core/ports/workspace-repos.port.ts`, not by changing manifest authority.
- `src/core/ports/workspace-impact-queries.port.ts`, `workspace-queries.port.ts`, `live-queries.port.ts`: request unions, `workspaceReplay`/`workspaceLive` sidecars and closed failure contracts. Coordinate fact schema and protocol serialization where necessary; do not silently change public facts.
- Proposed `src/core/application/topology/workspace-snapshots.ts`, `src/core/application/snapshot/head-reading.ts`, `src/core/application/live/live-tree.ts`, `src/core/application/topology/workspace-queries.ts`, `workspace-impact.ts`, and `src/core/application/impact/impact-queries.ts`: capture, internal captured-read seams, walk reuse and provenance. Preserve adapter boundary at `src/core/ports/live-mirror.port.ts` and `src/core/adapters/fs/live-mirror.adapter.ts`; change only if the lifecycle requires it.
- `src/composition/compose.ts`, `src/composition/mcp.ts`: wire the operation lifetime and trust; `src/mcp/server.ts` and `src/mcp/render.ts`: schema, redacted sidecars and presentation. Audit `src/protocol/` and CLI transport consumers before exposing the changed public ports; each must validate the same union or explicitly retain the old supported subset. Do not expose partial capability.
- 4.1 owns external ID resolution and missing/ambiguous faults. 4.2 owns normalized replay identity, projections and cursors; it consumes this vector and sidecars, never a hidden capture handle. 4.4 owns explicit batch trust installation; this design reads those external declarations and does not define or perform writes.

## Future slices and offline proof

1. Prepare private request unions, validation helpers and committed regression tests without widening any callable public core request. Keep shared public member types committed-only until slice 2 supports discovery, callers, ofChange and decisions together. Test mutual exclusion and defaults through the private validation seam; retain existing committed public behavior and MCP exclusions.
2. Implement operation capture and internal captured walks, base diff and sidecars. Widen the public core revision/live union only in this coherent four-family cut, after discovery, callers, ofChange and decisions all use captured states; no HEAD fallback or unsupported placeholder may be reachable. Through injected ports and disposable repositories, test mixed SHA/live inputs and complete vector/read provenance; mutate a live file after capture and before discovery/walk, assert both use captured content and the repository reports stale. Test two simultaneous operations with opposite membership order, duplicate aliases, untrusted refusal before any live read, capture fault halfway through, cancellation during lock wait and during walk, and release of every acquired lock and scratch resource. Verify no live-to-HEAD path, plus a committed base/live-head diff containing an untracked file and removed route. Exercise standalone workspace and decisions at their public seams.
3. Integrate MCP and supported protocol/CLI contracts, advertised schemas and redaction. Test invalid combinations in both advertised schema and runtime; prove sidecars identify the correct repo, per-repo partial/unknown is retained, and no selectors grant trust. Coordinate 4.1/4.2: replay unchanged state succeeds; edit a live member, then assert the old identity fails before returning selection/page. Test cancellation and staleness-check failure explicitly. Read `.claude/skills/ye-ast-testing/SKILL.md` before tests, use realistic public seams and break proof for each guarded rule.

Run focused `node --import tsx --test` on changed test files, then `npm run check` and a broad search for any live snapshot-to-HEAD substitution. These are implementation acceptance commands, not claims of execution for this design. Real benchmark and adoption work belongs to Task 5.
