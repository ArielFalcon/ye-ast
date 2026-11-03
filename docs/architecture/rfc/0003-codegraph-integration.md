# RFC-0003: codegraph integration

- Status: Draft, 2026-10-29
- Related: [ADR-0004](../adr/0004-codegraph-dependency-with-own-fact-layer.md),
  [ADR-0006](../adr/0006-qayaba-graph-state-per-run.md), [ADR-0007](../adr/0007-dependency-versions.md),
  [ADR-0009](../adr/0009-route-data-in-two-levels.md), [ADR-0010](../adr/0010-trust-modes.md),
  [ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md), [RFC-0002](0002-facts-contract.md),
  [RFC-0008](0008-distribution.md)

**In short:** one adapter owns codegraph. It uses the public SDK for everything it covers and a small raw-SQL remainder,
version-checked and pinned by a parity harness, for the rest. Queries open the store read-only, indexing runs in a child
process, and every cut a walk makes is reported. Path confidence first reproduces qayaba's first-path semantics, then
moves, as a versioned change, to the widest path, a bounded score for heuristic edges and free interface hops. Upstream
contributions are pending by the owner's decision.

## Access: SDK first, raw SQL remainder

Citations are codegraph 1.6.2 files: `index.d.ts:N` is `dist/index.d.ts`, `dist/...` and `npm-sdk.js` belong to the main
package, and `bundle:<path>` is `lib/dist/<path>` of its platform package.

| Need (today served by qayaba's store reader) | SDK | Plan |
|---|---|---|
| File symbols with line ranges | `getNodesInFiles`, `getNodesByIds` | SDK |
| Callers, inbound walk with predecessors | `getIncomingEdgesTo(nodeIds, kinds?)` (`index.d.ts:413`) and `getCallers(nodeId, maxDepth?)`, which returns `{node, edge}` (`:764`). `traverse(startId, options?)` returns `{nodes, edges, roots}` without predecessors (`:722`); `traverseBFS` is internal (`dist/graph/traversal.d.ts:21`) | SDK primitives; the walk and its policy are ye-ast's |
| Fan-in for hub detection | `getFanIn` | SDK |
| Index version check | `getIndexBuildInfo()` returns `{version, extractionVersion}` and no schema version (`index.d.ts:310`); a full `indexAll` stamps it and `sync` does not advance it (`bundle:index.js:662-663`). Schema 11 (`bundle:db/migrations.js:17`) and extraction 27 (`bundle:extraction/extraction-version.js:27`) are not exported | The adapter reads the schema version (`schema_versions`) and the extraction version (`project_metadata`) from the store, as qayaba's reader does (qayaba@4105c582 `qa-engine/src/shared-infrastructure/code-graph/codegraph-store-reader.mjs:39-40,106`): raw-SQL remainder. `getIndexBuildInfo()` supplies the codegraph `version` that built the index |
| Route nodes with targets | `getNodesByKind('route')` plus `getOutgoingEdgesFrom` give `references` edges with confidence 0.9-0.95. `getRoutingManifest(limit?)` (`index.d.ts:643`; the default of 40 is set at `bundle:db/queries.js:991`) is a summary that returns null under 3 routes outside test and generated files (`bundle:db/queries.js:1018-1022`) | SDK, from nodes and edges |
| Edge confidence | only in untyped `Edge.metadata` | read through the SDK's edge objects; typed column requested upstream |
| Unresolved references | per node and per file: `getUnresolvedReferencesFrom`, `getUnresolvedReferencesInFile` (`index.d.ts:523,531`); in batch: the root-exported `QueryBuilder.getUnresolvedReferences()`. No SDK object exposes `name_tail` (`bundle:db/schema.sql:99`) | SDK for the references; `name_tail` is raw-SQL remainder |
| Degrees filtered by excluded files | none | raw-SQL remainder |

Rules:
- **Remainder.** The raw-SQL remainder lives in the codegraph adapter alone, refuses a store outside the supported
  version range (schema and extraction), and shrinks as upstream exposes APIs.
- **Read-only queries.** Queries open the store with `CodeGraph.openSync(root, { readOnly: true })`
  (`index.d.ts:153`); only the indexing child process writes it. The store is in WAL mode, so an open still creates or
  touches its `-wal` and `-shm` sidecars: the store's directory must be writable, while the database bytes stay
  unchanged. A store whose `index_state` is not `complete` is refused like one outside the version range.
- **Parity.** A parity harness compares the adapter's answers with qayaba's store reader on real indexes before qayaba
  switches.
- **Indexing.** Indexing and `sync` run in a child process, never on a query event loop, started with
  `node --liftoff-only`, the guard against a V8 WebAssembly out-of-memory abort that codegraph names for "an embedded
  host that drives large indexing" (`npm-sdk.js:21-24`). The flag works only on the command line: a worker's `execArgv`
  rejects it and `NODE_OPTIONS` does not allow it (`bundle:extraction/wasm-runtime-flags.js:1-47`).
- **Bundle.** The adapter never calls codegraph's CLI shim, which can download bundles, and refuses any bundle not
  resolved from `node_modules`. Without the platform package the SDK loads a bundle the shim may have cached under
  `~/.codegraph/bundles`, outside the lockfile (`npm-sdk.js:38-75`); a missing platform package is a typed failure
  (`platform-package-missing`). The adapter resolves the platform package beside the main package itself and loads
  `lib/dist/index.js` from it, so the main package's entry point, and its fallback to the cache, is never reached.
- **Pin.** `@colbymchenry/codegraph` 1.6.2 is the latest stable release on 2026-10-30 and is pinned exactly
  ([ADR-0007](../adr/0007-dependency-versions.md)). Its six platform packages (`darwin`, `linux` and `win32`, each
  `x64` and `arm64`) are optional dependencies at the same version: npm installs the one for the host and the lockfile
  holds all six. None of the seven packages declares an install script or a runtime dependency (the bundle carries its
  libraries in `lib/node_modules`), checked with `npm view` on that date. A platform package is 250-300 MB unpacked.
- **Telemetry.** Every codegraph process runs with `DO_NOT_TRACK=1`, which turns telemetry and the update check off
  (`bundle:telemetry/index.js:210-218`, `bundle:upgrade/update-check.js:102-104`). Loading the SDK loads the
  telemetry and update-check modules, because `bundle:index.js` re-exports `./mcp`, but the SDK's index and open paths
  never construct the telemetry client nor open a socket (checked with network hooks and a network-denying sandbox on
  2026-10-30). The indexing child also runs with `NODE_DISABLE_COMPILE_CACHE=1`, since codegraph's workers otherwise
  write Node's compile cache under the system temporary directory.

## Where the store lives

codegraph keeps its store in a data directory inside the indexed root, `.codegraph/` by default. `CODEGRAPH_DIR` renames
it; the value is a single path segment, and an absolute or traversal value is ignored (`dist/directory.d.ts:14-33`).

| Trust mode ([ADR-0010](../adr/0010-trust-modes.md)) | Store |
|---|---|
| `trusted` | `.ye-ast-graph/` in the indexed root, through `CODEGRAPH_DIR` set only in ye-ast's processes; `ye-ast init` keeps it out of git ([RFC-0005](0005-transports.md)) |
| `untrusted` | the host's snapshot export: ye-ast builds the store from the export and later opens only a store the host hands over, never a `.codegraph/` or `.ye-ast-graph/` found in the repository. Without a host the store is an entry of the per-user index cache ([RFC-0006](0006-configuration.md) question 4), built from ye-ast's own export and never from the repository |

The adapter owns the layout. It indexes a snapshot by linking its files into the store directory (copying across file
systems), leaving out every `.gitignore`, a root `codegraph.json` and every `.git`, `.codegraph`, `.ye-ast` and
`.ye-ast-graph` entry, file or directory, compared in lower case since the engine reads names through the host's file system. It
runs the child there with `CODEGRAPH_DIR=.ye-ast-graph`, then removes the linked files: the store directory ends up
holding `.ye-ast-graph/` only, and the snapshot is never written. The child gets a minimal environment, with the
machine's global and system git configuration off and `GIT_CEILING_DIRECTORIES` at the store's parent, because
codegraph asks git about its root (`rev-parse`, `ls-files`, `config core.excludesFile`): neither a repository around
the store nor the global ignore file changes which files are indexed, and a `.git` inside the snapshot, which git
would honour (`core.fsmonitor` runs a command, `info/exclude` filters files), never reaches the staged copy. A store
inside the snapshot is refused (`stage-failed`). A staged file is never replaced: files are copied only across file
systems and never over an existing one, so two names that a case-insensitive store folds together (`a.ts` and `A.ts`
from a case-sensitive snapshot) fail the staging instead of leaving one file with the other's content. The directory name is the same under both trust
modes; indexing a trusted working tree in place is not built.

ye-ast does not reuse the user's `.codegraph/`. Another codegraph version could migrate a shared store under ye-ast's
pinned queries, and `uninitialize()` deletes the whole data directory (`index.d.ts:915`).

## Adapter notes

Measured on codegraph 1.6.2 (2026-10-30):

- `indexAll` stamps the version and extraction only when it indexed at least one file, so the index of a snapshot with
  no readable file is refused as `unsupported-store`: nothing can say which engine built it.
- `getUnresolvedReferencesInFile` returns at most 5,000 rows unless given a limit; the adapter passes none, so a file's
  references are never cut silently.
- `getFanIn` does not count a test's request onto a route (`synthesizedBy: 'test-request'`), and it leaves out nodes
  nothing points at, which the adapter reports as 0.
- The SDK takes the store directory name from `CODEGRAPH_DIR` in the process environment whenever it resolves a store
  path, which it does only inside synchronous calls (`isInitialized`, `openSync`). The adapter sets it, and
  `DO_NOT_TRACK=1`, for the synchronous open alone and restores the previous values, so a host that embeds the library
  and runs codegraph itself keeps its own settings.
- The engine leaves committed sources out of the index by its own rules, and reports none of them as skipped. Its
  built-in ignored directory names (`DEFAULT_IGNORE_DIRS` in `extraction/index.js` of the platform package: `out`,
  `target`, `build`, `dist`, `coverage`, `vendor`, `obj`, ...) match at any depth and are legal Java package names, so
  `com/acme/out/Outbound.java` and `com/acme/target/Targets.java` get no symbols while the summary says
  `filesIndexed: 1, filesSkipped: 0`. The one exception the engine makes is `build` under `src/*/java|kotlin|scala/`.
  The adapter does not change what is indexed, since the snapshot's own configuration is never honoured and ye-ast
  invents no engine configuration. It reports the gap: `IndexSummary.filesNotIndexed` lists, sorted and relative to
  the snapshot, every staged file whose language the engine supports (`isLanguageSupported(detectLanguage(path))`,
  both SDK exports) and that `getFiles()` does not return. The SDK has the call, so no raw SQL is involved. A fact
  built on such an index turns a non-empty list into a cut, never into "nothing there".
- Not built yet, waiting for the walk: `name_tail` on unresolved references and the degrees filtered by excluded
  files (the two raw-SQL needs of the table above).

## Index reuse across shas

A full index is kept by the content it was built from, not by sha ([ADR-0015](../adr/0015-index-reuse-by-content.md)): the
key is the content digest of the staged files, the codegraph version, the supported schema and extraction versions and
the version of ye-ast's staging rules (`STAGING_RULES_VERSION`, changed with any change to staging). The cache adapter
builds into a temporary directory inside the cache, writes the index summary beside the store, publishes with an atomic
rename and opens the published directory, so a fresh and a reused index are read the same way. The determinism check
that allowed this is in ADR-0015 (two builds of 10,429 nodes, 18,103 edges and 23,167 unresolved references, equal on
codegraph 1.6.2). What follows concerns `sync`.

An index is reused only by the codegraph version that built it in full, which `getIndexBuildInfo()` names (`sync` never
advances its stamp). A sha's index is derived from another sha's by `sync` only after the parity harness shows that
`sync` equals a fresh build on real repositories; until then each sha is built in full (open question 2). qayaba never
asserts that a `sync` equals a fresh build.

What is measured: fresh builds were identical across runs on a 29-file Angular repository (343 nodes, 562 edges), with 1,
2 and 8 workers and the native kernel on and off (experiment, 2026-10-29).

## Path confidence

codegraph scores an edge when a resolver resolves it and stores the score in `edges.metadata.confidence`: about
0.9-0.95 for the import resolver; 0.3-0.95 for name matching (0.9 for a unique exact match, 0.7 or 0.4 by path
proximity among same-named candidates, 0.5 for a fuzzy match, lower across languages:
`bundle:resolution/name-matcher.js:5956,5973,9593`); 0.6-1.0 for framework resolvers. The edges its synthesizers add
(Angular templates, HTTP clients, router links, callbacks, interface-to-implementation bridges) carry
`provenance: 'heuristic'` (`dist/types.d.ts:104`) and no score (for example
`bundle:resolution/callback-synthesizer.js:188-196`). An absent score means certain only on an edge that is not
heuristic. qayaba reads the score per edge (default 1), takes the maximum over parallel edges between two nodes, and
the minimum along the path that first reached a node in the breadth-first walk
(qayaba@4105c582 `qa-engine/src/shared-infrastructure/code-graph/codegraph-store-reader.mjs:222-310`).

| Stage | Confidence of a reached node | Gate |
|---|---|---|
| 1. Parity | qayaba's: the weakest edge on the first path found, the strongest of any parallel edges; a heuristic edge without a score counts 1, as in qayaba | the parity harness agrees with qayaba's reader on real indexes |
| 2. Widest path | the strongest weakest-edge over all paths within the depth bound (max-min), so a short heuristic path does not mask a longer certain one. The walk keeps, per node, the best confidence for each remaining depth and reports the depth of the chosen path; the shorter path wins a tie. In these fields a heuristic edge without a score counts the walk's heuristic score, by default 0.3, the lowest score codegraph 1.6.2 gives a resolved edge | after parity, as a minor schema version: new fields beside the first-path confidence ([RFC-0002](0002-facts-contract.md) rule 6) |

## Walk policy

The walk is ye-ast's, over the SDK's inbound primitives. Its bounds are optional caller budgets with no default
([RFC-0010](0010-impact-queries.md) "Bounds"); the values below are qayaba's own budget during the parity window.
They were measured on one Angular index (the seeds of a 3-commit run at depth 3, test-file callers excluded); that
index is the whole evidence, so none becomes a default before measurements on other stacks justify it (qayaba@4105c582 `qa-engine/src/shared-kernel/code/index.ts:78-98`).

| Bound | qayaba's value | Cut reported | Origin |
|---|---|---|---|
| Depth | 3 | `depth` | the depth of the measured walk |
| Hub fan-in limit | the index's p99 in-degree, test callers excluded, clamped to 10-64 | `hub` | p99 was 12 on the measured index: one hub, 13 of the change's 15 pages reached, where a limit of 5 (the p95 with test callers) loses 9; above 64 sit only app-wide services |
| Caller-query budget | clamp(1500 + 25 per seed, 1500, 4000) | `caller-budget` | a complete walk took 209 to 457 expansions |
| Hub-closure budget | 1500 caller queries for all hubs' closures together | `caller-budget` | the same index; the source gives no separate measurement |

Every bound that stops a walk is reported as a cut of a `partial` fact ([RFC-0002](0002-facts-contract.md)), the depth
bound included. qayaba's reader leaves the depth loop with a non-empty frontier and flags nothing
(`codegraph-store-reader.mjs:295`).

After parity, an interface-to-implementation bridge (`synthesizedBy: 'interface-impl'`,
`bundle:resolution/callback-synthesizer.js:1149`) spends no depth. codegraph adds it because a call through an
interface "dispatches at runtime to the implementing class's override", and accepts the over-approximation
(`:815-823`). On a hexagonal Spring service where that hop spends depth, 0 of 42 persistence methods reach a controller
within depth 3; with the hop free, 18 of the 25 that reach one do so within 3 (experiment, 2026-10-30).

## Upstream contributions: pending

The owner left this open on 2026-10-29. Candidates gathered so far, not committed to:

- export `registerFrameworkResolver` and make worker threads honour registered resolvers;
- a typed, indexed confidence column on edges, and a score on the edges its synthesizers add;
- `name_tail` on the SDK's unresolved references, and a batch API for loaders;
- Angular route nodes for arrays typed through an alias of `Route[]` or a type derived from `Route`;
- Java records among the class types (`bundle:extraction/languages/java.js:233`);
- directive and pipe edges from Angular templates, and references from `inject()`;
- export the schema and extraction versions and restamp the build info on `sync`.

## Open questions

The owner accepted these recommendations on 2026-10-30 (translated): "yes, I accept them all".

| # | Question | Recommendation |
|---|---|---|
| 1 | Under `trusted`, index an own copy or read the user's existing `.codegraph/` store read-only? | Own copy in `.ye-ast-graph/` (see Where the store lives): another codegraph version could migrate a shared store under ye-ast's pinned queries. Reading the user's store stays a later optimization, only within a supported version range |
| 2 | Does `sync` from another sha equal a fresh build on real indexes? | Decided by [ADR-0015](../adr/0015-index-reuse-by-content.md): full indexes are reused by staged content; a `sync`-derived index serves only live facts that record it, and the parity test runs with the first live slice |
