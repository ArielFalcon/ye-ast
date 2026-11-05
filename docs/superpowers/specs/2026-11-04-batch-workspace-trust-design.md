# Batch installation and external trust

Status: Implemented by Task 2 of the [capability implementation plan](../plans/2026-11-04-mcp-capabilities-implementation.md). Design baseline: Observed HEAD: `602ffe695f3e4130f8b5a603e20ccbaa85717200`; the parent plan and ADR-0022 were also read as present in the working tree. This design does not assume the response-mode migration has landed. [ADR-0022](../../architecture/adr/0022-typed-query-replay-and-selective-evidence.md) closes its six query decisions and requires batch trust; none is reopened here.

## Intent and boundaries

A single explicit selection of local repository roots and a single `trusted` choice authorize an installation operation on precisely those roots, with a separate external trust record for each. The operation has no per-repository confirmation. It does not infer selection from a workspace manifest, membership, a remote, or repository content, clone a remote, or expose administration to MCP. The same explicit operation may select `untrusted`, including to lower existing declarations. This is an administrative action, not a query-wide trust flag. Per-repository live reads remain subject to their own current external declarations.

## Existing behavior and gap

`src/cli/main.ts` parses `init --trust trusted|untrusted [--workspace <file>] [<repo>]`, defaulting to the working directory, and rejects multiple positional repositories. `repositoryOf` resolves the path and uses the existing naming provider or basename for the ID. The CLI reads an explicitly named workspace file before calling `Install.run`. The use case in `src/core/application/install/install.ts` resolves HEAD, validates the optional manifest and checks every named repository's revision before writing; then it writes the selected root's trust record, ensures local excludes, optionally persists the manifest, and refreshes that root's fixed layer. It does not declare trust for manifest members. A later failure carries `trustRecorded`; `not-written` is a successful layer outcome with a reason. The layer itself writes its digest before its fact, each through an individual temporary-file rename, not as a multi-file transaction.

`TrustRecords.write(root, mode)` in `src/core/ports/trust-record.port.ts` already replaces one declaration without changing others. `src/core/adapters/fs/trust-record.adapter.ts` keys records by SHA-256 of the real path, checks record privacy and writes by temporary file and rename. It treats relative and symlink spellings of the same directory as one record. A failed read is not a trustworthy previous declaration; readers fall back to untrusted. `src/core/application/topology/workspace-defaults.ts` only reads persisted workspace membership under trusted mode, while `src/core/adapters/fs/workspace-defaults.adapter.ts` resolves its relative paths against the installed root. These candidate paths are neither the explicit selection nor an externally authorized selector catalog.

The gap is batching explicit targets and reporting actual independent outcomes. Existing single-repository `Install` and trust writer remain the owners of writes; no second trust authority is needed.

## Proposed request and result

Add a batch administrative operation alongside the current `Install.run`, retaining the current single-target CLI and library behavior. The minimal CLI path is:

```text
ye-ast init --trust trusted --repo <id> <path> --repo <id> <path> [--workspace <file>] <launch-repo>
```

Each repeatable two-argument `--repo <id> <path>` and the positional launch root are explicit selections. IDs are supplied once with the selection, not through repeated trust prompts. This matches the launch declaration in [Task 4.1](2026-11-04-mcp-typed-follow-ups-design.md). When `--repo` is present, require the positional launch root rather than silently adding the working directory; without `--repo`, preserve today's default. `--workspace` retains its existing meaning and is installed only on the launch root. It does not add targets. Reject an empty path, missing trust, unknown flags or ambiguous arguments before any write. A single command expresses consent to the entire supplied list; no interactive loop. Existing output remains for the single-target path; batch output lists every target and stage and prints one registration for the launch root. Render fault details with existing redaction.

The following types are proposed, not existing APIs; exact placement should reuse the install port and composition rather than create a general orchestration framework:

```ts
type BatchInstallRequest = {
  launch: { path: string; id: string };
  repositories: readonly { path: string; id: string }[]; // includes launch
  trust: TrustMode;
  workspace?: { path: string; text: string }; // launch only
  signal?: AbortSignal;
};
type BatchInstallReport = {
  targets: readonly {
    requestedPaths: readonly string[];
    id: string;
    canonicalRoot?: string;
    status: "completed" | "failed" | "not-attempted";
    trust: "recorded" | "not-recorded" | "unknown";
    outcome?: InstallOutcome;
    stage?: "preflight" | "trust" | "exclude" | "workspace" | "layer";
    fault?: InstallFault | BatchSelectionFault;
  }[];
};
type BatchSelectionFault = {
  kind: "invalid-selection" | "duplicate-repository-id" | "conflicting-repository-alias";
  detail: string;
};
```

Add `Install.runBatch(request: BatchInstallRequest): Promise<BatchInstallReport>` to the administrative port alongside `run`. The report carries preflight and per-target failures rather than hiding them in a single batch fault. To report the stage on failure, extend the existing install fault with the stage at its existing stop sites; preserve its kind and `trustRecorded`. The library receives explicit IDs and roots. The CLI uses each supplied member ID; for the positional launch root it uses a matching explicit binding if present, otherwise the existing repository naming mechanism. It refuses collisions instead of inventing identifiers. Resolve each existing root through the proposed `Vcs.canonicalRoot` from Task 4.1 before any write, then verify HEAD via `resolveCommit`. Extend `InstallDeps.vcs` to `Pick<Vcs, "resolveCommit" | "canonicalRoot">`; the Git adapter owns realpath/root validation, and the use case owns coalescing and selection. Do not implement filesystem calls inside install or a second canonicalizer. Canonical identity is the real path of the worktree root, matching the trust writer, not the git common directory: distinct linked worktrees remain distinct records. Coalesce repeated spellings of one canonical root only when their IDs agree; preserve all requested spellings in the report. One ID for different canonical roots is `duplicate-repository-id`; multiple IDs for one root is `conflicting-repository-alias`. Invalid realpath or root/HEAD yields its underlying typed fault. No case folding or hand-written filesystem normalization substitutes for realpath. Detect selection and ID conflicts and validate the launch workspace before any writes; on any preflight failure report failed targets and all others `not-attempted`. The launch must appear exactly once after coalescing. Revalidate through `Install.run` at execution: preflight is not a lock against filesystem changes.

Process canonical targets in deterministic canonical-root order, sequentially, invoking the existing single-target operation with the common mode and only the launch manifest. Continue after an ordinary per-target failure so one failure does not suppress the other explicitly selected targets; after cancellation mark unstarted targets `not-attempted`. Do not retry automatically. Expose every completed outcome including exclude lines, workspace outcome and layer status; include `InstallFault.trustRecorded` for failed installs. `recorded` means the writer succeeded during this attempt, not that later stages succeeded or that the declaration cannot subsequently change. A preflight failure is `not-recorded` for this attempt, not a claim that no old record exists. If an unexpected exception prevents establishing the stage, report `unknown`, stop further execution, and preserve prior outcomes. A process crash or forced termination may prevent any complete report; inspect records before retrying.

Explicitly choosing a mode replaces each selected existing declaration, including `untrusted` to `trusted` and `trusted` to `untrusted`; same-mode reruns have the same effective declaration, although the current writer can replace its file. An absent record becomes the selected mode on successful write. Unselected records are untouched. Do not pre-read and report a previous mode as authoritative: read faults, races and concurrent writes make that claim unsafe. If a write fails, report the writer fault; do not infer the old effective mode. There is no global transaction, rollback, or promise that all roots share a point-in-time state. An exclude, workspace or layer failure can follow an already successful trust write. The layer may have written its digest before a fact write fails; `not-written` also needs explicit reporting, not a success claim for a complete layer. Rerunning the same explicit selection is the recovery path; never silently undo a trust transition.

Batch exits `0` only when every target completed and every layer is `written` or `unchanged`; a `not-written` layer produces exit `1` in batch while retaining its reason. Any target failure or preflight selection failure exits `1`; malformed CLI syntax exits `2`, cancellation exits `130`, unexpected internal failure exits `70`. These batch rules are proposed; existing single-target mapping remains unchanged. Current install faults are the unions in `src/core/ports/install.port.ts`: VCS (`unknown-revision`, `git-failed`, `not-repository-root`, `unreadable`, `object-missing`, `no-merge-base`, `export-write-failed`, `aborted`), trust (`unreadable`, `refused`, `unwritable`, `no-location`), local exclude (`git-failed`, `unreadable`, `unwritable`, `refused`), fixed-layer (`unreadable`, `unwritable`, `invalid-name`), live (`live-requires-trusted`, `unsupported-object-format`, `live-mirror-failed`) and workspace (`workspace-invalid`). Preserve the original kind and detail plus stage; do not reinterpret coincident names. The three selection kinds above are proposed batch faults. No new MCP or query-protocol fault mapping is introduced by installation.

## Write map and administrative ownership

| Destination | Existing writer and scope |
|---|---|
| User configuration `ye-ast/repositories/<sha256(realpath)>.json`, with temporary file and private directories | `TrustRecords.write`; `src/composition/trust-record-directory.ts` selects XDG or APPDATA location. One record per selected root. |
| Git's `info/exclude`, resolved by `git rev-parse --git-path` | `LocalExclude.ensure` via `src/core/adapters/git/git-local-exclude.adapter.ts`; appends missing `.ye-ast/` and `.ye-ast-graph/`, refuses symlinks and locations outside the common Git directory. Linked worktrees may share this file. |
| `<root>/.ye-ast/workspace.json` | `FixedLayerStore.write` only for the explicitly supplied launch manifest; membership never authorizes trust. |
| `<root>/.ye-ast/README.md`, `entrypoints.json` and temporary files | `FixedLayerAdmin.refresh` and `FixedLayerStore`; each selected root, at HEAD, subject to explicit not-written/fault outcomes. |

`Install` is an administrative port composed in `src/composition/compose.ts`; `FixedLayerAdmin` is not injected into MCP or the query protocol. Keep those boundaries. This table describes durable installation writes, not temporary git exports or any separately configured indexing/cache effects of existing queries. The batch must not trigger remote refresh or clone as part of selection.

## Cross-design dependency

[Task 4.1](2026-11-04-mcp-typed-follow-ups-design.md) supplies the external catalog through launch argv or an embedding host's read-only `McpDeps.repositories`. This design needs no new installed catalog file. After a successful batch, print one MCP registration for the launch root with `args: ["mcp", launchRoot, "--repo", id, canonicalRoot, ...]`, including every coalesced selected binding and the launch binding. Use structured argv, not an interpolated shell string. The user's MCP host persists this explicit configuration outside repository content; an embedding host supplies the same array directly. Paths with spaces remain single argv entries.

Hashed trust files are not an enumerable ID catalog. The repository-owned manifest remains membership evidence, not authority to enroll a direct target. Catalog availability grants no trust: every query still reads that root's external declaration. If a batch has any failed/not-attempted target or incomplete layer, print its complete report and **do not print a ready-to-use registration**; a retry or a new explicitly selected subset establishes the installation result. Do not silently narrow the catalog to successful targets. Task 4.3 consumes the per-repository declarations, never a batch-level trusted boolean. All proposed writes remain outside MCP.
## Implementation slices and offline proof

1. Extend `src/core/ports/install.port.ts` and `src/core/application/install/install.ts` with the bounded batch contract and the Task 4.1 VCS canonical-root method injected through `InstallDeps.vcs`; reuse `Install.run`, VCS and trust writer. Extend `src/core/application/install/install.test.ts` with injected fakes for preflight, independent outcomes, cancellation and stage order. Keep current single-target behavior intact.
2. Extend `src/cli/main.ts` and `src/cli/main.test.ts` for repeatable selection, naming, one launch manifest, exit/report mapping, redaction and backward compatibility; wire the batch in `src/composition/compose.ts`. Use disposable repositories and an isolated trust directory in `src/composition/install.test.ts` to prove actual writer and exclude behavior, including linked worktrees. Do not run network or change real declarations.
3. Integrate the Task 4.1 registration contract; live workspace queries additionally depend on Task 4.3. Batch administration can ship without mixed-live support. Update the relevant RFC documentation with implemented behavior at that time; do not advertise the proposed interface prematurely.

Acceptance and break proofs: select two disposable roots once and observe two separately keyed declarations and reports; remove the second invocation and the test must fail. A manifest containing an unselected third root must not change its record; mistakenly adding manifest members to targets must fail. Alias the same real root twice and verify one write; map one ID to two roots and verify zero writes, then break collision detection to prove the guard. Prepopulate opposite trust modes and an unselected record, then assert selected transitions and preservation; swapping the writer mode must fail. Inject a write or exclude failure for one root, assert exact `trustRecorded`, retained prior writes and the other target's outcome; moving the recorded flag before the write or stopping after a normal failure must fail. Inject layer `not-written` and a second-file failure, verify report and exit without rollback claims. Abort between targets and assert remaining entries are not attempted. Check a linked worktree's real root and actual git exclude path, and verify no tracked files change. Use dependency injection for failure ordering and disposable directories for filesystem privacy and rename semantics; do not use the user's repositories, actual trust store, real time or network.
