# RFC-0002: Facts contract

- Status: Draft, 2026-10-29
- Related: [RFC-0001](0001-architecture-and-layers.md), [RFC-0003](0003-codegraph-integration.md),
  [RFC-0005](0005-transports.md), [RFC-0006](0006-configuration.md), [ADR-0010](../adr/0010-trust-modes.md)

**In short:** every answer is a `Fact<T>` whose status decides its shape: `complete` carries a value, `partial`
carries a value and the cuts that bounded it, `unknown` carries a typed reason and no value. Each fact records the
snapshot it reflects, its evidence and every input that could change it. Facts are byte-deterministic unless a wall
clock cut them, and they are invalidated by their inputs, never by age or file-name heuristics.

## Envelope

```ts
type Fact<T> = CompleteFact<T> | PartialFact<T> | UnknownFact;

interface FactBase {
  schema: `${number}.${number}.${number}`;
  snapshot: SnapshotRef;
  producer: { name: string; version: string };
  inputs: FactInputs;
  evidence: Evidence[];
}

interface CompleteFact<T> extends FactBase { status: "complete"; value: T }
interface PartialFact<T> extends FactBase { status: "partial"; value: T; cuts: Cut[] }
interface UnknownFact extends FactBase { status: "unknown"; reason: UnknownReason }

type UnknownReason =
  | "no-extractor" | "out-of-scope" | "index-unavailable" | "source-unreadable" | "unresolved" | "deadline";

interface Cut {
  kind:
    | "depth" | "hub" | "caller-budget" | "node-cap" | "unresolved-link" | "build-output" | "deadline" | "section"
    | "not-exported" | "no-extractor";
  at: string[];
  limit?: number;
  reason: CutReason;                  // ADR-0042 decision 1: why the cut exists, one closed member per emitter situation
  subReason?: CutSubReason;           // why a dispatch was not proven, or "capability-absent"
  reach: CutReach;                    // ADR-0042 decision 2: what the cut could hide
}

type CutReach =
  | { kind: "anything"; runtime?: "java" | "typescript" }
  | { kind: "callers-of"; declarations: string[] }
  | { kind: "call-at"; place: string }
  | { kind: "module"; importer: string; specifiers: { specifier: string; package?: boolean }[] }
  | { kind: "call-site"; transport: string; method?: string; template?: string };

interface DeclaredScope {
  languages: string[]; frameworks: string[]; include: string[]; exclude: string[];
  ignored?: "git";                    // live facts only
}

interface FactInputs {
  trust: "trusted" | "untrusted";
  scope: string;
  declaredScope: DeclaredScope;
  content: string;
  config: string;
  engines: Record<string, string>;
  buildOutputs?: DeclaredBuildOutputInput[];   // ADR-0037 (proposed): only when a host declared one
}

type SnapshotRef =
  | { repo: string; kind: "sha"; sha: string }
  | { repo: string; kind: "live"; head: string; stateId: string };

interface Evidence { path: string; line: number; endLine?: number; via?: string; confidence?: number }
```

`Cut.at` names where the computation stopped, in one grammar: `at[0]` is the anchor, a repository-relative `path` or
`path::symbol` (for a `section` cut, the section name); every following entry is a place, `path:line`, optionally followed
by one space and the reason it is named: for a reference the index could not attribute, that reason is the reference as
written (`req.context.get`), the one datum that lets the reader settle the place without opening the file. A cut over
several anchors is one cut per anchor. A consumer reads the file of a
cut from `at[0]` and its call sites from the rest, without parsing anything else. What each kind puts there: for a
`not-exported` cut, the in-scope path that the export of the snapshot left out because it is a symlink, an unsafe path
or a case collision, or any submodule, since its content may hold in-scope files, so the answer never looks complete
without it; for a `no-extractor` cut, a source file of the commit whose language has no extractor yet, such as Kotlin,
Groovy or Scala outside test paths, or JavaScript (an Angular project need not be TypeScript), by the same classifier
`map` and `impact` share, so a service in that language never answers complete and empty; for a
`caller-budget` cut of the export, the first path of the commit, in git's order, that a budget the host set did not
let the export take, and `limit` the budget that ran out: entries listed or bytes written, which the host knows by its
own values). Nothing at or after that path was exported, so the facts built on the export are `partial`;
`scope` digests the declared scope (languages, frameworks, include and exclude) and `declaredScope` states that scope
in the fact itself ([rule 4](#rules)); `content` digests everything of the commit that decides the fact
([rule 5](#rules)); `config` digests the profile values that change results (walk bounds and count budgets, the export
budget of the map included); `engines` maps the package name of each engine that produced the fact to its installed
version, and holds only those engines of the operation that built it (the entrypoints map: `web-tree-sitter`,
`tree-sitter-java` and `typescript`; an impact fact adds codegraph, and `@angular/compiler` when its operation reads
Angular declarations and templates: `ofChange` and `callers`, not `importers`). `declaredScope.ignored` is `"git"` on a
fact over a live working tree only: git's ignore rules decide which paths are listed, so completeness is relative to them
and an ignored in-scope file is neither listed nor cut. `inputs.origin` names where the index a fact read came from: `{ kind: "full" }` when the store was built in full from
the state the fact reflects, `{ kind: "sync", base }` when `sync` brought it up to date from the full build whose
`stateId` is `base` ([RFC-0010 "Live head"](0010-impact-queries.md#live-head-slice-3)); a live `map` reads no store and
carries none. `SnapshotRef.repo` is a stable repository name the
host chooses, by default the directory name of the main worktree of the repository a query is bound to, and the directory
name of the path for a repository a workspace request names without an `id`; never a path, so identical inputs give
identical bytes on every machine and every worktree of the repository a query is bound to keeps one name.
`inputs.buildOutputs` lists each build output a host declared for the fact ([ADR-0037](../adr/0037-host-declared-build-outputs.md), proposed): its kind, the
repository-relative directory it stands for, whether the snapshot's lockfile verified it, and the digest of what the
fact read from it; a fact without a declaration carries no field, so its bytes do not change. A `build-output` cut names a
declared output an answer did not read: each package the snapshot's lockfile states at another version, each link that
led out of the declared directory, or the directory itself on a live tree.
`index-unavailable` means the snapshot has no usable index yet: no store, a store codegraph does not report `complete`
or that another codegraph version built, or a build still running ([RFC-0005](0005-transports.md#first-index)).
`unresolved` means the source names a value that cannot be known statically: a non-constant expression, a `${...}`
placeholder, or a constant that is not in the snapshot. Field
names are settled in the first slice; the union, the cuts and the inputs are the contract.

## Rules

1. **No silent empties.** A fact that could not be computed is `unknown` with its reason. A fact a bound cut is
   `partial` and lists every cut, including a depth cut. `complete` with an empty value means "verified none within the
   scope".
2. **Composite facts.** A value made of sections, such as the map ([RFC-0004](0004-deterministic-map.md)), holds a fact
   per section; the composite is `complete` only when every section is, otherwise `partial` with one `section` cut per
   incomplete section, whose own fact carries its cuts or its `unknown` reason. A collection whose items can fail independently (an entrypoint whose target cannot be resolved) holds item
   facts. An item fact carries only what can differ per item (`status`, `value` or `reason`, and `evidence`); its schema,
   snapshot, producer and inputs are the collection's. Such a collection is `complete` when nothing bounded it, even if some of its items are `unknown`: an item
   says what could not be known at its place, and a cut says what the computation never reached. A bound, and a source file in a
   language with no extractor, is a cut; a construct that an extractor reads but cannot resolve or extract is an
   `unknown` item ([ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) rule 7). A reading can also stop at a place
   the sources do not let it cross (a route reference it cannot follow): that place is a `cut` of the section, never an
   item, so the section is `partial` ([RFC-0025](0025-angular-route-tables.md), U4).
3. **Determinism.** Sorted collections, repo-relative paths, no engine-internal ids and no timestamps in the value: the
   same inputs give the same bytes. Count budgets are deterministic, as qayaba's walk budgets are (qayaba@4105c582
   `qa-engine/src/shared-kernel/code/index.ts:84-98`). A wall-clock deadline is not: the same query can finish in a
   warm process and be cut in a cold one. A fact with a `deadline` cut or reason is therefore outside the
   byte-determinism promise and is never stored nor written to the fixed layer.
4. **Completeness is relative to a scope.** "Complete" means complete within the declared scope; anything outside it
   answers `out-of-scope`. A fact states its scope in `inputs.declaredScope`, beside the digest, so a reader sees what
   `complete` is relative to: the entrypoints map that answers `complete` for `{ languages: ["java"], frameworks:
   ["spring"] }` says nothing about a Kotlin controller or a JAX-RS resource, and an empty value is "none within that
   scope", never "no HTTP entrypoints at all". The declared scope is part of the inputs, so a change of scope
   invalidates the stored fact. `DeclaredScope` is `{ languages, frameworks, include, exclude }`: `languages` and
   `frameworks` are ye-ast's own, and `include` and `exclude` are globs over repository-relative paths that the caller
   supplies as a request parameter, each list sorted and without duplicates, empty by default. An empty `include`
   means every path, and a path any `exclude` glob matches is outside the scope. An excluded path is not exported,
   indexed, cut or used as a seed, and `content` covers only the files in scope, so excluding a path changes both
   `scope` and `content`. `include` selects the content an answer is about; the configuration that interprets that
   content — the manifest that names a project's framework, the compiler configuration that resolves a module specifier,
   the JVM build file that declares a source generator, the Spring configuration that declares a base path, the contract
   document the code implements — is read whatever the scope selects, because without it an extractor cannot place what
   it reads. An entrypoints map also reads TypeScript sources outside a narrowing `include` to resolve route
   configuration; findings and framework reading cuts remain bounded by the caller's selection. `exclude` wins over
   both, and the export's content digest covers that reading. An export budget can stop this wider reading and its
   caller-budget cut remains visible even outside the selection. A `callers` or
   `importers` request naming a target outside the declared scope is answered `unknown` with reason `out-of-scope` and
   evidence naming each such target (`path:line`, line 1 for a file or symbol, the range for a line range), with no
   partial answer for the others, even for a configuration file the export read; a file inside the scope in a language
   with no extractor stays a `no-extractor` cut.
5. **Invalidation by inputs.** A stored fact is valid while every field of its `inputs` and the producer version equal
   the current ones, so two facts with equal `inputs` are equal. `content` therefore covers everything of the snapshot
   that decides the fact, not only the files in the evidence: "this symbol has no callers" depends on files that are
   not in its evidence, so a caller added in a new file must invalidate it, and a cut depends on entries that are not
   in any file the producer reads. For a `sha` snapshot the content digest is computed from what `git ls-tree -r`
   lists, not from file contents: the blob id and path of every in-scope file, and of every configuration file the
   export read whatever the scope selected (rule 4). For the entrypoints map that is the Java sources, the
   `pom.xml`, `build.gradle`, `build.gradle.kts` and `*.versions.toml` files, since a declared source generator decides
   the items, and the Spring `application` files of a main resources directory, since they declare the base path, with
   the blob ids standing for the content;
   the path and blob id of every source file that produces a `no-extractor` cut; every entry the export skipped, with
   its path and reason; and the path where a budget stopped the export. Entries outside all of these (a README, an
   image) leave the digest unchanged. Each part is encoded unambiguously (a path cannot imitate another entry) and
   sorted, so the digest does not depend on the order of the listing. For `live` it is the snapshot's `stateId`. Finer
   invalidation, by the files a fact actually read, waits for a measured need.
   A fact that read no content, an `unknown` answered before the commit was exported (the diff failed),
   digests the revisions it was asked about instead; every other fact of a snapshot, `unknown` ones included, carries the
   same content digest.
   qayaba's map-validity rule is not reused: it compares two git trees with a file-suffix rule and a 14-day age limit
   built for an LLM-written map (qayaba@4105c582
   `qa-engine/src/contexts/run-orchestration/domain/context-map-validity.ts:2-14,35-40`,
   `qa-engine/src/shared-kernel/telemetry/context-provenance.ts:24-25`).
6. **Versioning.** `schema` is semver: a field added is a minor change; a meaning changed or a field removed is a major
   change and invalidates stored facts. `0.2.0` adds `declaredConfig`, `cost` and `origin`; `0.3.0` adds `declaredScope.ignored`;
   `0.5.0` removes `ImpactedSymbol.seeds`, so a consumer of the older shape is told rather than reading a field that is gone.
   `0.10.0` adds optional `CallSite.ancestors`: named AST declaration spans used to select outgoing calls from a changed declaration.
   `0.13.0` adds `RepoImpact.unresolved`: the unresolved call sites of a workspace impact section, as its repository's
   discovery read them. `0.14.0` adds optional `ImpactValue.changedContracts`: the contract operations whose request or
   response data a change added, removed or altered. `0.15.0` adds optional `ChangedContract.handlers`, the handlers of
   the routes joined to an altered or removed operation, and optional `ImpactedLink.operations`, the altered or removed
   operations the handler a workspace link lands in serves. `0.16.0` adds optional `ImpactedSymbol.via.substitutes`: the
   classes a provider may inject instead of the receiver a proven member call names, each with the provider's site.
   `0.17.0` adds optional `ImpactedSymbol.via.resource`: the file `via.lines` are in when it is not the symbol's own, the
   template of a component whose template calls `via` through an injected field. `0.18.0` adds `WorkspaceValue.links`, the
   links the join admits between the repositories a workspace read holds, and `WorkspaceValue.unlinked`, the call sites it
   reached without one; `WorkspaceValue.workspace.gateways` carries the inferred gateways beside the declared ones, each
   with its `basis`; a published destination is an outward name, and `NameCandidate.basis` adds `event-destination`.
   `0.19.0` adds optional `OutlineDeclaration.children`, the declarations a `contains` edge places directly inside one, and
   `OutlineFile.declarations` now holds only the top level, so a consumer of the flat list finds members under their
   container. `0.20.0` adds unresolved call-site reasons, causal evidence and typed diagnostics, and the reason of an
   unresolved-link cut. Source availability describes whether an intermediary was read; it does not assert that an
   unreadable library file declares that intermediary. `0.21.0` makes `OutlineValue` either the listing (`files`,
   `unheld`) or a focus (`focus`, `unheld`): each `OutlineFocus` names the `file`, the `selector` asked, the
   declaration's dotted `path`, its `ancestors` outermost first, the `declaration` with its subtree and `omitted`,
   the count of the file's declarations left out; `inputs.declaredConfig.focus` records the selectors.
   `0.22.0` lets an unresolved HTTP site's `stated` retain its established method without a path. An omitted path is
   unknown, never empty; an incompatible method can exclude the site from another operation while a compatible method
   with no path keeps it in question. `0.23.0` adds optional `scopeSelection` output: unmatched include globs and the
   count of selected paths when only part of an include matches. It is not an input, a cut, or part of fact identity.
   `0.24.0` requires original unknown observations on a reached unknown entrypoint and retains their evidence through
   composition. Outline declarations may carry `placement: {kind: "unplaced", reason: "unresolved-container", at}`;
   absence is used only for established placement. Anonymous lexical ancestry and framework binding are separate.
   Request occurrence knowledge may coexist with unresolved enumeration; no execution or exclusivity is implied
   (ADR-0052, RFC-0030). Derived-fact keys include the schema so older representations cannot supply new proofs.
7. **Redaction at egress.** Values and evidence pass redaction when they leave ye-ast's process toward a host: the
   patterns always, by-value secrets only in the process that already holds them
   ([ADR-0010](../adr/0010-trust-modes.md)). The success report `ye-ast init` writes for the user who ran it is not
   egress and keeps the paths it names; every error line passes the patterns. Stored facts
   are not redacted, so a change in the secret set invalidates nothing. The fixed layer applies the patterns only and
   stays deterministic. `ye-ast map` applies the patterns to every string it prints, object keys included, and to its
   error lines.
8. **Snapshot and staleness.** A fact states the snapshot it reflects. An answer about a live tree that moved on after
   the last index is stale; the transport says so and names the changed paths ([RFC-0005](0005-transports.md)).
   Staleness is not a status: a stale fact can be `complete` for the state it reflects.
9. **Confidence.** Graph-derived evidence carries the path confidence defined in
   [RFC-0003](0003-codegraph-integration.md).

## Open questions

The owner accepted these recommendations on 2026-10-30 (translated): "yes, I accept them all".

| # | Question | Recommendation |
|---|---|---|
| 1 | Should `live` facts of a dirty tree be cached? | Only in memory, keyed by `stateId`; never on disk |
| 2 | Is `confidence` a number or a band (`certain`/`resolved`/`heuristic`)? | Keep the number; bands are rendering |
