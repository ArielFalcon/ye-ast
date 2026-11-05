# Declared repository targeting and snapshot-qualified follow-ups

**Status:** Proposed implementation design for Task 4.1; no capability code is included. Observed checkout: `602ffe695f3e4130f8b5a603e20ccbaa85717200`. The owner reports the common-mode migration in final review; this checkout still exposes the earlier presentation controls. Implement against the reviewed mode migration, not by restoring those controls.

**Decision basis:** [ADR-0022](../../architecture/adr/0022-typed-query-replay-and-selective-evidence.md), [the parent plan](../plans/2026-11-04-common-mcp-response-modes.md), [RFC-0015](../../architecture/rfc/0015-answer-coordinates.md), and [RFC-0017](../../architecture/rfc/0017-answer-size-and-outline.md). The accepted strategy is an optional declared repository identifier on existing tools. Wire details below are this design's proposals.

## Outcome and limits

An agent can take a coordinate belonging to another declared repository and invoke the appropriate existing tool against that repository. The declaration selects availability, not trust. The question, file/symbol/range selector, scope and snapshot retain their existing meanings.

No new tool, generic reference language, query pipeline, source reader, repository scan, implicit clone or MCP write is introduced. Workspace discovery can name a candidate that is unavailable for direct targeting. Neither discovery nor a repository's own workspace file enrolls it into this external catalog.

## Existing seams

- `src/mcp/server.ts`: `McpDeps.repository` supplies one `{ path, repoId }`; every registration forwards that binding. The query families already accept a repository root and stable ID.
- `src/composition/mcp.ts`: `runMcp` resolves the launch root, obtains its stable name and creates one composed read family set. It currently accepts only the optional launch path.
- `src/composition/compose.ts`: `composeQueries` builds families that read the root on each request. Its live dependencies, trust lookups and snapshot cache are not closures over the launch root. Reuse this set; do not create a composition per ID.
- `src/core/ports/entrypoint-queries.port.ts`, `impact-queries.port.ts`, `outline-queries.port.ts`, `workspace-queries.port.ts`, `workspace-impact-queries.port.ts` and `decision-queries.port.ts` already own the semantic query inputs.
- `FactRead.repositoryRoots` gives original roots; `repositorySources` may name internal mirrors and must remain excluded from public responses. `SnapshotRef` owns SHA and live identities.

## External catalog and launch contract

Extend the existing MCP dependency object rather than create a catalog service or new core port:

```ts
type RepositoryBinding = { path: string; repoId: string };

// Proposed additions; existing family, redaction and version fields remain.
interface RepositoryTargetingDeps {
  repository: RepositoryBinding; // launch binding
  repositories?: readonly RepositoryBinding[];
}
```

Composition supplies canonical local Git worktree roots. The effective catalog is the launch binding plus `repositories`, sorted by `repoId` for discovery. The host may supply it directly when embedding the MCP adapter. The local CLI gains repeatable **two-argument** declarations:

```text
ye-ast mcp [<launch-root>] [--repo <id> <root>]...
```

CLI paths resolve against its invocation directory and are canonicalized with the existing filesystem/VCS boundary before server creation. An entry naming the launch root may choose its explicit ID; otherwise retain `repositoryName` and the existing basename fallback. Insert the resulting launch binding after this resolution. Require nonempty IDs and paths and an existing Git root. Reject paths inside a repository that are not its root, as existing installation does. Canonicalization follows the explicit launch arguments; it does not read repository configuration to discover targets.

Canonicalization has one proposed read-only boundary: add `Vcs.canonicalRoot(repo: string, signal?: AbortSignal): Promise<Result<string, VcsFault>>` in `src/core/ports/vcs.port.ts`, implemented in the existing Git adapter by reusing its root validation and filesystem realpath dependency. It returns the worktree root, not the Git common directory, and rejects a subdirectory, nonrepository or unreadable root using existing `VcsFault` kinds. Expose it to launch composition as `ComposedQueries.canonicalRepositoryRoot` beside `repositoryName`; do not inject VCS itself into MCP. Batch installation and mixed-live capture reuse this method, avoiding three different root identity rules. No new catalog service or parser is introduced.

Coalesce repeated declarations only when canonical root and ID both agree. Reject one ID for multiple roots and multiple IDs for one root. Distinct linked worktrees remain distinct roots, as in the trust writer; assigning their naturally equal names requires explicit distinct IDs. Do not case-fold IDs or invent aliases. Runtime matching is exact, case-sensitive string equality; even a string resembling a path is never interpreted as a filesystem request. Use own-property-safe lookup or a `Map`; IDs such as `constructor` cannot access object prototypes.

The launch catalog is immutable for the server's lifetime. A restart or a new host-created server supplies changes; trust is still checked by existing queries on every call. Trust records are not enumerated to discover IDs. No new installed catalog file is needed: [batch installation](2026-11-04-batch-workspace-trust-design.md) prints a registration whose argv contains precisely the selected bindings. The user's MCP host owns persistence of that registration outside the repositories. A library host owns its injected array. This settles the catalog source without a second registry or trust authority.

Preserve existing startup warm-up for the launch root. Additional available roots are read on demand; declaring availability alone does not warm their live indexes or refresh their remotes.

## Tool inputs and routing

All seven existing tools gain `repo?: string`. Omission means the launch binding. `repo: ""` is schema-invalid; unknown or ambiguous nonempty IDs fail before a query family is called. Publish a string schema and describe the catalog once in initialize instructions rather than repeat a large dynamic enum in seven schemas.

| Tool | What the chosen binding supplies |
|---|---|
| entrypoints | `map.repo` and `map.repoId` |
| impact, local | `ofChange.repo` and `repoId`; base/head belong to this repository |
| callers/importers, local | `repo` and `repoId`; targets/files are relative to this root |
| outline | `outline.repo` and `repoId` |
| workspace/decisions | `request.repo.path` and `request.repo.id` |
| impact/callers with workspace | The trigger `request.repo`; additional membership keeps its existing explicit/default semantics |

Resolve the binding once at the driving boundary and pass it to the existing family. Do not change `scope`, translate target paths between repositories, infer another repository from a filename, or fall back after lookup failure. Existing explicit `workspace.repos`/`repos` path inputs remain supported; they do not enroll those paths into the catalog or enlarge `repo` authority. Catalog availability also does not automatically include every available root in a workspace analysis.

For successful local responses, expose the selected `{ repo, path }` in the existing redacted `repositoryRoots` sidecar when useful for source navigation. Workspace responses retain roots actually reported by the query. Do not expose the whole catalog or `repositorySources` in every result. The primary fact's `snapshot.repo` must equal the selected ID; mismatch is a wiring failure, not an alternate identity to accept silently.

Proposed adapter-owned fault union:

```ts
type RepositoryTargetFault = {
  kind: "unknown-repository" | "ambiguous-repository";
  detail: string;
  repository: string;
  available: readonly string[]; // IDs only, sorted
};
```

Return the existing MCP `isError` fault channel and metadata, redacted, without `structuredContent` posing as a fact. Invalid launch catalogs produce an initialization/CLI usage failure before serving requests; retain a defensive ambiguous-ID check for directly injected dependencies. Existing VCS, scope, symbol and live faults retain their owners. No new core fault or query-protocol repository ID syntax is necessary for this adapter selector: library/protocol callers already supply their roots explicitly.

## Snapshot-qualified navigation

Guidance identifies **owner repository + actual snapshot + subject**, with existing types. It does not introduce a second coordinate taxonomy.

| Recorded evidence | Supported next query |
|---|---|
| Handler at SHA | `outline` with its owner ID, `revision` equal to its SHA and its file; or `callers` with the recorded symbol/range |
| Destination of a workspace link | Its `to.repo`, destination handler and that repository's recorded contributing snapshot; not the trigger's revision |
| Module row with `snapshot: "base"` | The recorded merge-base SHA and module file; do not relabel it as head evidence |
| Module row at head | Actual SHA or live identity of that impact read |
| Live handler | A new `live: true` query on its declared trusted owner, explicitly described as a fresh read |

For example, after a workspace fact identifies an API handler in `service-a` at a recorded commit, proposed input is:

```json
{
  "repo": "service-a",
  "revision": "<recorded-service-sha>",
  "files": ["src/routes.ts"],
  "mode": "details"
}
```

This is an illustrative `ye_ast_outline` request, not an executed call. A symbol target may identify several declarations under existing callers semantics; guidance must identify that selection basis, not promise uniqueness by name alone.

A related query is not recovery of the earlier result. A live choice captures current state and returns its own `head` and `stateId`; these must be compared with the earlier coordinate before treating the source as the same. This design adds no past-live pin or cross-tool result assertion. If the state differs, treat it as a fresh investigation and use the new coordinates. Recovery of **the same** originating result uses that tool's `select` and `expect` from [Task 4.2](2026-11-04-mcp-selective-evidence-recovery-design.md). Never turn a live head SHA into a supposedly equivalent committed read.

If a destination owner is absent from the external catalog, report that limitation and its owner/snapshot. An instance bound there or a user-updated launch registration is required. An agent cannot fix this by putting an absolute path in `repo`. A host source reader must also read the recorded commit or verify the complete live identity; merely opening a working-tree path does not establish a snapshot match.

## Ownership and delivery slices

| Files | Responsibility |
|---|---|
| `src/mcp/server.ts` and a new `src/mcp/repository-targeting.ts` | Dependency shape, pure catalog validation/lookup, seven input schemas and routing; existing response assembly remains the owner of delivery |
| `src/composition/mcp.ts`, `src/composition/compose.ts` | CLI declarations, canonical root resolution through existing technology boundaries, injection and startup behavior |
| `src/core/ports/vcs.port.ts`, `src/core/adapters/git/git-vcs.adapter.ts` | Proposed `canonicalRoot` implementation using the existing root validation and injected filesystem boundary |
| Existing core query ports/application families | Reuse semantic signatures and current per-request trust lookup; no new query abstraction for routing |
| `src/mcp/server.test.ts`, proposed `src/mcp/repository-targeting.test.ts` | Public SDK routing/failure/discovery and the lookup's one owner |
| `src/composition/mcp.test.ts`, `src/composition/mcp.e2e.test.ts` | Launch parsing, canonicalization and actual stdio |
| `README.md`, RFC-0005/0015 and discovery text | Implemented input vocabulary, coordinate ownership and migration guidance |

1. Add catalog and binding resolution with existing single-root behavior preserved. Public SDK tests prove the chosen binding reaches every distinct forwarding branch, including workspace trigger branches. A foreign root sharing the same file path must be decisive in the fixture. Test absent/unknown/ambiguous IDs without invoking analysis, aliases, prototype-like IDs and current trust refusal.
2. Add explicit CLI catalog injection and batch registration integration. Test malformed pairs, launch override, canonical duplicates, distinct worktrees and no warm-up of extra roots. Use injected process boundaries/disposable roots; no actual trust record changes outside the test's temporary directory.
3. Add snapshot-qualified guidance and root sidecars. Test a foreign handler, base-side module and changed live state: the new response identifies its new state and is never labelled replay of the earlier one. Compare the advertised schema and runtime acceptance. Preserve source status/cuts and redaction.

Run focused existing SDK/composition tests and `npm run check` during implementation. Source discovery must show all seven registrations use the same resolver and no bound-root fallback remains in an explicitly targeted branch. These are future acceptance steps, not execution evidence for this document.

## Dependencies and evaluation boundary

Task 4.1 depends on the reviewed common-mode migration. It supplies catalog IDs and owning-root context to Task 4.2 and the trigger binding to Task 4.3. Task 4.4 consumes the launch argv contract above; its one selection generates the complete external catalog. None of these operations raises trust by selection.

The implementation has enough context to proceed without a new architecture choice. Exact helper names inside existing composition are a builder choice; the public fields, lookup/failure semantics and authority boundaries above are fixed by this proposal. Task 5 measures actual client navigation and whole-task utility after implementation; this design promises neither adoption nor lower analysis latency.
