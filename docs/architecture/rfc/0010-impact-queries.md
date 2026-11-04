# RFC-0010: Impact queries

- Status: Draft, 2026-11-01; revised the same day after an independent review, whose eight recommendations the owner
  accepted ("Si")
- Related: [ADR-0006](../adr/0006-qayaba-graph-state-per-run.md), [ADR-0010](../adr/0010-trust-modes.md),
  [ADR-0011](../adr/0011-query-protocol-in-the-mvp.md),
  [ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md), [ADR-0015](../adr/0015-index-reuse-by-content.md),
  [RFC-0001](0001-architecture-and-layers.md), [RFC-0002](0002-facts-contract.md),
  [RFC-0003](0003-codegraph-integration.md), [RFC-0005](0005-transports.md), [RFC-0006](0006-configuration.md),
  [RFC-0009](0009-extraction-from-qayaba.md)

**In short:** `ImpactQueries` answers, inside one repository, what depends on a change, a symbol or a file: the
symbols that reach it, the entrypoints they serve, the entrypoints the change adds, removes or alters, and how complete
that answer is. A change is two revisions read against their merge base; the walk is inbound, follows an explicit edge
policy, has no default bound, and turns every bound and every blind spot into a cut. Impact across repositories is a
composition in `TopologyQueries` with its own RFC.

## Why

RFC-0001 names the port (`ImpactQueries`: "impact walk, callers, importers with completeness"), RFC-0005 lists
"impact with completeness" and "change scope" among the MCP tools, and ADR-0011 names `impact.callers` as an example
method; no document defined the request, the fact or its completeness. qayaba's consumers of the walk are its
structural signal, blast-radius signal and change scope (qayaba@cfc69e3b
`engine/src/contexts/change-analysis/infrastructure/adapters/`).

## Operations

| Operation | Request | Answer |
|---|---|---|
| `impact.ofChange` | `repo`, `base`, `head` revisions | `Fact<ImpactValue>` seeded from the change |
| `impact.callers` | `repo`, `revision`, symbols (`file`, `symbol`) or line ranges (`file`, `start`, `end`) | `Fact<ImpactValue>` seeded from them |
| `impact.importers` | `repo`, `revision`, files | `Fact<ImportersValue>`: per file, importers, users, and files naming it in an unresolved reference |

Each `ofChange` and `callers` request may carry a `budget`; every request an `AbortSignal`. The CLI prints the fact like
`ye-ast map`, with its exit codes (RFC-0005); `--revision` and `--head` default to `HEAD`, `--repo-id` to the directory
name:

```
ye-ast impact <repo> --base <rev> [--head <rev>] [budget]
ye-ast callers <repo> [--revision <rev>] [budget] <file>:<symbol> | <file>:<start>-<end> ...
ye-ast importers <repo> [--revision <rev>] <file> ...
budget: [--depth <n>] [--hub-fan-in <n>] [--expansions <n>]
```

A budget flag takes a positive integer and has no default. `<start>-<end>` are 1-based, inclusive, `start <= end`;
what follows the last colon and starts with a digit is a range, since no declaration name does. A malformed argument is
a usage error. The protocol and the MCP expose the same names when built (ADR-0011 decision 5). A live working tree
replaces `head` or `revision` under `trusted` only ([Live head](#live-head-slice-3)).

## The change

- The change is `merge-base(base, head)..head`; the fact records the merge base's sha. A `base` branch that moved on
  therefore adds nothing that `head` did not change.
- ye-ast reads it with plumbing and every option pinned, under the export's hardened environment plus an empty user and
  system configuration (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), so neither the machine nor the
  repository changes the hunks: `git diff-tree -r -p --no-ext-diff --no-textconv --no-renames --text --unified=0
  --no-color --src-prefix=a/ --dst-prefix=b/ <merge-base> <head>`. `--text` defeats a `.gitattributes` that marks a
  source `-diff` or `binary`; an in-scope file git still reports as binary is seeded whole.
- The diff parser's core moves from qayaba (RFC-0009 "Change structure"); `changedElements` stays in qayaba.

### Seeds

| Touched line | Seed |
|---|---|
| inside a symbol | the innermost symbol whose span holds it |
| inside a file's symbols but in none (imports, top-level statements) | the file's top-level symbols |
| in a file with touched lines and no symbol at all (a Java `record`, which codegraph gives no node) | none; a `no-extractor` cut at the file |
| in `templateUrl` or `styleUrl(s)` of a component | that component, read from decorator metadata ([ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md) decision 2) |
| removed with its symbol | none at `head`: its former callers changed too in a consistent commit and are seeds themselves; a caller left behind shows as an unresolved reference naming it. The same holds for a declaration removed from a symbol that survives (a method of a class): the holder seeds, and every name the removed lines declared, in any hunk, that no added line of the file declares again (a rename loses its name, an edited signature keeps it) also leads an `unresolved-link` cut at the references that still name it |

`Seed.basis` is `lines`, `top-level` or `resource`, or `requested` for a symbol `impact.callers` was asked for by name.
A requested line range seeds through the rows above, as the added lines of a file; a requested symbol seeds every
seedable node of its file with that simple name (the join below), so overloads all seed; a symbol that is both requested
and inside a requested range is one seed, `requested`.

A deleted component resource is also read through the merge base's decorator metadata. An owner that survives at the
same file and declaration name seeds at its **head** location, even when it now names another resource. A lost owner is
accounted for only when the selected change includes its declaration removal; that removal follows the unresolved-name
rule above, not a fabricated head seed. Every former owner must be accounted for. A same-named component at another path
does not establish identity, and an orphan resource or an owner excluded by `changed` keeps the template's `no-extractor`
cut. The base metadata is read only when the selected change deletes a non-source file.

Removed-declaration cuts list unresolved **candidates**, not proven broken dependencies. They reuse the same exact
external, ambient and reached-settlement proofs as the ordinary walk. A bare import proven to bind another repository
file cannot be attributed to the removed homonym. An unknown binding remains a candidate; a proof for one rooted name or
settled reference never suppresses another reference on the same line. Proofs identify the full graph occurrence
(file, raw line and column, source ID, full name and kind), with unique syntax and graph matches. A bare call proven
to bind a supported callback parameter excludes a removed homonym in another file only; it does not resolve the callback
target or add a call edge. Missing or ambiguous coordinates leave the candidate. A type settlement retires a cut only
when its uniquely joined target was expanded and its joined source reached by the walk.

### Entrypoints of the change

ye-ast's own extractors run at the merge base as well as at `head`; they need no index. Entrypoints the change adds,
removes or alters (a different name, handler or base path) are reported at depth 0, keyed by kind, name and handler.
A removed route is the change that breaks its consumers.

## The walk

Inbound over `head`'s index; a node is expanded once, so the walk ends on any graph.

### Edge policy

The walk follows an edge only when a row allows it. The table is part of the producer version (RFC-0002 rule 5), so a
change to it invalidates facts.

| Edge into a reached node | Followed | Why |
|---|---|---|
| `calls`, `instantiates` from a function, method, class or the initializer of a class field | yes | behaviour depends on the target |
| an unresolved `this.<member>` or `this.<member>.<rest>` inside the class that declares the member | yes | the class's own code uses the member |
| `references` into a function, method, value or class | yes | the source uses it |
| `references` into an interface or type alias (a DTO) | yes | a type change breaks its users; qayaba does not follow these |
| `extends`, `implements` into a class or interface | yes | a subtype depends on its supertype |
| interface method → implementation method of the same name, derived by ye-ast from `implements`/`extends` | yes, both ways | dispatch at run time; codegraph's `interface-impl` bridges are not used, since they stop silently after 40 per class-supertype pair (`bundle:resolution/callback-synthesizer.js:24,1131`) |
| a reached method → its type, at the same depth | yes; from that type only `extends`/`implements` and `uses-component`/`uses-directive`/`uses-pipe` | routes, components and class-level listeners name the class, not the method; [ADR-0017](../adr/0017-owner-of-a-member-expands-only-whole-type-edges.md) keeps the class and stops it expanding into whoever injects or imports it |
| `imports` into a file node | no; `imports` into a symbol: yes when the importing file's top-level code uses it | a file node leads nowhere |
| an injectable class with no caller → its importers' top-level code | yes | injection without a static call (qayaba `codegraph-store-reader.mjs:248`) |
| `injects`, `uses-component`, `uses-directive`, `uses-pipe` between two classes or components, read by ye-ast from the Angular sources ([RFC-0007](0007-extension-model.md) rows A2 and A4) | yes, confidence 1 | the source injects or renders the target; the relation is read from the code, not guessed |
| `navigates` | no | a router link is navigation, not dependence |
| codegraph's heuristic `angular-template` and `angular-event` edges | no | ADR-0014 decision 1; rows A4 and A2 bring ye-ast's own |
| any edge from a test file | no | tests are not callers; the declared scope says so |
| containment | no | structure, not dependence |

Edges ye-ast derives (interface bridges, and the Angular injection and template relations of rows A2 and A4) enter through one port of
inbound edges that codegraph's edges also feed, so a new row never changes the walk.

Exact member evidence uses the same `MemberUseOrigin` value for a direct fixed field, a supported constant local,
and an inline Angular `inject(Class).method()` call. The TypeScript adapter owns syntax, import/token binding and
source-visible stability checks. The application uniquely joins owner, receiver, own concrete method and full
occurrence to the graph. The domain excludes only the corresponding candidate; the actual method must be expanded
before its occurrence can settle. The per-query index stores one actual target per occurrence and a set of expanded
anchors, rather than one proof per homonym/site combination.

When the native member channel is present, including an empty array, it alone authorizes member settlements.
Existing field-origin edges remain potential impact paths, but cannot settle a reference or exclude another target.
Local origins may also carry source-certified direct call sites for an unambiguous constant binding within its owner
and block. These sites add potential callers without settling references or excluding candidates, even when exact
member proof is unavailable. Older injected readers that omit the channel retain the legacy behavior. These optional
metadata values do not change the public fact or graph schema.

New proofs require a fully staged, unfiltered source selection, successful parsing and an unambiguous Angular project.
Provider substitutions, shadowing, observable receiver/member mutation, escape and unsupported syntax withhold proof.
A constructor with an explicit value-return cannot establish exclusive instance identity; returns in nested
functions do not invalidate the enclosing constructor. Potential local call sites require lexical binding evidence
independently of project-wide member stability and refuse dynamic binding constructs such as direct eval/with.
The current checks conservatively refuse some valid uses across a whole file or project; they do not simulate runtime
DI configuration. Missing evidence remains a cut. `EDGE_POLICY.referenceProofVersion` is 4 and participates in the
existing producer digest; syntax and proof changes invalidate derived facts without rebuilding an unchanged graph.

### Confidence and fan-in

Each reached symbol carries the widest-path confidence: the strongest weakest edge over all paths, with a heuristic
edge without a score counted 0.3 ([RFC-0003](0003-codegraph-integration.md) stage 2; without a depth bound this is a
plain max-min search). Each carries its `fanIn`, so a renderer can rank or collapse hubs without the fact cutting
them.

### Entrypoint join

One owner function joins a graph node to ye-ast's facts, used by entrypoints, derived edges, call sites and seeds: same
file, the fact's line inside the node's span, same simple name. codegraph's qualified names (`pkg::Owner::method`) and
overloads never decide it. A reached handler or component names its entrypoint; a reached handler of an entrypoint the
extractor reported `unknown` is reported by its location. A reached guard names every UI route that declares it (its
own `canMatch`, `canActivate` or `canLoad`, which the route extractor already carries to the routes beneath): a guard
records no line, and as a top-level declaration it is unique by name in its file, so it joins by file and name.

### Bounds

No bound has a default. Each is an optional `budget` field; each yields the cut [RFC-0002](0002-facts-contract.md)
names: `depth` (cut `depth`, at the open frontier), `hubFanIn` (cut `hub`, at the hubs), `expansions` (cut
`caller-budget`, at the open frontier). qayaba's measured values (RFC-0003 "Walk policy") are qayaba's own budget
during parity. A rendering budget cuts what is shown, never the fact.

## The fact

```ts
interface ImpactValue {
  mergeBase?: string;                       // ofChange only
  seeds: Seed[];
  changedEntrypoints?: ChangedEntrypoint[]; // ofChange only
  symbols: ImpactedSymbol[];
  entrypoints: ReachedEntrypoint[];
}

interface Seed { file: string; symbol: string; line: number; endLine?: number; basis: "lines" | "top-level" | "resource" | "requested" }

interface ChangedEntrypoint { change: "added" | "removed" | "altered"; kind: Entrypoint["kind"]; name: string; handler: Handler }

interface ImpactedSymbol {
  file: string; symbol: string; kind: string; line: number; endLine?: number;
  depth: number; confidence: number; fanIn: number;
  /** lines are every place inside this symbol's file where it depends on the symbol it was reached through. */
  via?: { file: string; symbol: string; lines?: readonly number[]; basis: "call" | "reference" | "contains" | "dispatch" | "relation" | "import" };
}

interface ReachedEntrypoint {
  kind: Entrypoint["kind"]; name?: string; handler: Handler;
  depth: number; confidence: number; seeds: number[];
}
```

`endLine` is the declaration's last line and is present only when the declaration spans more than one line, the
convention `Evidence` already follows. `via.lines` are **every** place inside the reached symbol's own file where it
depends on the symbol that reached it, in line order: a symbol that calls another three times is three places to change.
`via.basis` says what the dependence is — `call` when a call or an instantiation is among the merged edges, `reference`
when it only names the symbol, and `contains`, `dispatch`, `relation` or `import` for the structural dependences the walk
follows — so a place with no line is never silent.

`ImportersValue` (`impact.importers`), per requested file in path order, each list sorted and repo-relative, the file
itself never listed:

```ts
interface ImportersValue { files: ImportedFile[] }

interface ImportedFile {
  file: string;
  importers: string[];        // files with an `imports` edge into the file or a symbol it declares, tests included
  users: string[];            // files with an edge of any kind but `contains` into them, tests included
  unresolvedNamers: string[]; // files with an unresolved reference naming the file's stem or a symbol it declares
}
```

`importers` and `users` are reported information, not walk edges, so tests count and the policy table does not apply;
`users` is broader than the followed edges so that it contains qayaba's `importersOf`
(qayaba@cfc69e3b `codegraph-store-reader.mjs:144`, which reads `imports`, any-kind and unresolved-name matches the same
way). A name matches when the reference's name or its tail is a declared name, or the reference's name holds the file's
stem. The snapshot, `inputs.content` and `inputs.config` are `head`'s sha, the in-scope files of the revision and the
requested targets (sorted) with the budget.

`ReachedEntrypoint.seeds` indexes the top-level `seeds` array; `ImpactedSymbol` carries none, because nothing consumes
it and it outweighed the rest of the answer. Order: symbols by depth, file, line, symbol; entrypoints by kind,
name, handler; seeds by file, line, symbol. `name` is absent for a reached entrypoint the extractor reported `unknown`.
The snapshot is `head`'s sha; `inputs.content` covers both trees' in-scope files and `inputs.config` the budget.

### Completeness

`complete` only when the frontier emptied and nothing that could add a caller was unseen. Otherwise `partial`, one cut
per cause:

| Cause | Cut |
|---|---|
| a budget stopped the walk | `depth`, `hub` or `caller-budget` |
| a non-test unresolved reference whose name tail and kind match a walked symbol, or a file that loads modules by a computed name | `unresolved-link`, at those references (a loader: its file, then the call); the count per symbol is kept. A load whose specifier a TypeScript reader read as a string literal names its module like a static import and raises no cut; a place the reader saw some load compute keeps it, and a language with no reader keeps it as before |
| an Angular injection or template use the relation reader named but could not place (`unknown`), in a file the walk reached or in a template a reached component names | `unresolved-link`, at that file, led by it and followed by each `file:line reason` |
| a changed file with no symbol; a staged file the index did not hold or could not parse (`IndexSummary.filesNotIndexed`, limited to the paths the head export wrote) | `no-extractor` |
| a changed `.html`/`.htm` that no component names through `templateUrl` | `no-extractor`, at that file |
| a changed or walked file outside the declared scope, or left out of the export | `no-extractor` or `not-exported` |

`unknown` when no answer is possible: the index cannot be built or opened (`index-unavailable`) or the diff cannot be
read (`source-unreadable`); an unresolvable revision is a typed fault, as for `map`. A symbol `impact.callers` was asked
for that names no node at the revision is the typed fault `unknown-symbol`, listing every such entry with the seedable
declarations of its file (sorted, once each, empty when the file declares none or is not indexed), so the caller sees
what it could have asked for; the CLI exits as
for an unresolvable revision. A requested line range in a file that is not a covered source (a test, an uncovered
language, a template no component names) is a `no-extractor` cut at that file, never an empty answer.

`impact.importers` is `complete` unless a cut applies: a requested file outside the declared scope or that the index
holds no node of (`no-extractor`, with no entry for it), a file that loads modules by a computed name outside the tests
(`unresolved-link`, and a load the reader read with a string-literal specifier is no cut, as for impact), a staged file
the index did not hold (`no-extractor`), or an export cut. `unresolvedNamers` are reported in
the value, not cut. Not yet read by `users`: the Angular injection and template relations of rows A2 and A4, and
references from files outside the declared scope. An Angular impact whose relations
were all read carries no cut for them. Measured on one Angular store, about 15 % of the project's method names
collide with an unresolved reference outside test files, so `unresolved-link` cuts will be frequent; they stay, since dropping them gives false `complete` facts, and receiver scoping waits for measurements.

## Reuse and freshness

| What | Keyed by | Served from cache |
|---|---|---|
| the index | the staged content digest plus engine versions ([ADR-0015](../adr/0015-index-reuse-by-content.md)) | always; immutable |
| per-index tables: entrypoint join, unresolved references by name tail, fan-in, derived bridges | the index key plus the map's inputs | always; immutable |
| a fact at a sha | its `inputs` | yes, unless a deadline cut it; never an `unknown(index-unavailable)` |
| a fact on a live tree | `stateId` | never in this slice; the mirror is refreshed on every query ([Live head](#live-head-slice-3)); its inputs record the index origin |
| a moved `base` | resolved to a sha on every call | the `head` index is reused; only the seeds are recomputed |

No closure or reverse adjacency is precomputed: codegraph indexes edges by target and kind, and a walk is cheap
(about 10 ms unbounded on 18,004 nodes); the build is the cost, which the content key removes.

## Placement

| Piece | Where |
|---|---|
| diff parser core, seeds, `BlastRadius` | `core/domain/change/` |
| edge policy, walk, cuts, entrypoint join | `core/application/impact/` and `core/domain/impact/` (the policy table and the join are pure) |
| inbound edges port; codegraph's feed | `core/ports/`; the codegraph adapter |
| derived interface bridges | `core/application/impact/`, over `implements`/`extends` edges and symbol names |
| `git diff-tree` | `core/adapters/git/` behind `Vcs` |
| content-keyed store | the per-user index cache behind the `IndexCache` port ([ADR-0015](../adr/0015-index-reuse-by-content.md)); `SnapshotAdmin` later |
| `ye-ast impact` | `cli`, wired in `composition` |

## Live head (slice 3)

A `live` snapshot is the working tree of a `trusted` repository. One rule governs it: a live fact describes bytes
ye-ast copied and hashed, and the graph it reads is the graph of those same bytes. The engine never walks the
repository.

**Request.** The four read operations (`entrypoints.map`, `impact.ofChange`, `impact.callers`,
`impact.importers`) take an explicit `live` selector instead of a revision. For `ofChange`, `live` replaces `head`;
`base` stays required. The CLI flag is `--live`; passing it together with `--head` or `--revision` is a usage error.
The MCP tools take a boolean `live` with the same exclusion. A revision named `live` is never special, because it
can be a branch name. Under `untrusted`, `live` is refused before anything is read with a typed fault,
`live-requires-trusted`, that names `ye-ast init --trust trusted`: the CLI exits 1, as for any typed fault
(RFC-0005), and the MCP tool answers `isError`. The fixed layer stays at a sha. `ye-ast serve` keeps refusing
`trusted` in this slice: its host builds every snapshot, and `SnapshotAdmin` does not exist yet (RFC-0005 "First
index"). A repository whose object format is not SHA-1 is refused with a typed fault in this slice, since the blob
ids below are computed in process.

**The live listing and `stateId`.**

- **The paths.** git enumerates them with `ls-files -z --cached --others --exclude-standard`, so the repository's
  `.gitignore` files apply (ADR-0010 decision 3). Its local `info/exclude` applies too, by this design's choice: it
  is the user's own declaration and already holds ye-ast's folders.
  - git runs with the user's configuration, like `resolveCommit` (which keeps `safe.directory`), plus
    `-c core.excludesFile=/dev/null -c core.attributesFile=/dev/null -c core.fsmonitor=false` and
    `GIT_OPTIONAL_LOCKS=0`. An empty configuration would not be enough: both files have built-in defaults under
    `$XDG_CONFIG_HOME/git/`. With these settings no global ignore narrows the listing, ye-ast never writes the
    user's index, and git starts no program named in configuration.
  - The declared scope filters the listing, as it filters an export. `declaredScope` gains `ignored: "git"` on
    live facts: completeness is relative to what git ignores, since an ignored in-scope file is neither listed nor
    cut (RFC-0002 rule 4). It is a minor schema change.
- **The content.** ye-ast reads it itself; git never does, because `diff-files` and `status` re-hash files through
  clean filters defined in configuration.
  - Each listed path is checked with `lstat`.
  - A regular file keeps its recorded blob id when its size and nanosecond mtime match the mirror's manifest.
    Otherwise it is copied into the mirror and its git blob id is computed in process over the copied bytes, so the
    listing and the mirror agree by construction.
  - A symbolic link, a submodule, an unsafe path or a collision is a skipped entry with the export's own reason
    (`symlink`, `submodule`, `unsafe-path`, `collision`; `vcs.port.ts:11-14`), which the map reports as a
    `not-exported` cut, exactly as at a sha. ADR-0010 decision 3 permits following links inside the root; this
    slice follows none, so both snapshot kinds read one rule.
  - A special file is a skipped entry too. A tracked path missing on disk is a deletion.
- **`stateId`.** It is the digest of `contentFingerprint` over the live listing, the function a sha's
  `inputs.content` uses (RFC-0002 rule 5).
  - On a clean tree without conversion attributes, `stateId` equals HEAD's content digest, and the live `value`
    equals the sha `value` byte for byte. That equality is an acceptance test.
  - A fact over a change digests both sides, as `ofChange` already does (`impact-queries.ts:144`): the merge base's
    content and the `stateId`.
  - An edit that keeps a file's size and nanosecond mtime goes unseen, by ye-ast and by codegraph's `sync`
    (codegraph 1.6.2 `extraction/index.js:3183-3200`). The fact never claims more freshness than the index holds.

**The change.** The change is `merge-base(base, HEAD)` against the live listing: staged, unstaged and untracked
files all count. A moved HEAD is just a new merge base.

- The changed paths are those whose blob id differs between the merge base's `ls-tree` and the live listing, leaving out
  `.gitignore` and the root `codegraph.json`, which the mirror records but does not hold.
- ye-ast exports the merge base's version of those paths (a second export of that commit with a plan that writes
  only them) and copies their live version from the mirror (`LiveMirror.materialize`) into two scratch directories. It diffs them with `git diff --no-index` and RFC-0010's pinned options, run outside
  any repository with the empty configuration plus `-c core.attributesFile=/dev/null`, so no attribute, filter,
  textconv or diff setting applies. Exit 1 means the trees differ and is not a fault; any other non-zero exit is
  `git-failed`.
- An untracked file is an added file, and a removed file is a deletion. Renames are a deletion plus an addition, as
  at a sha.
- Changed entrypoints compare the merge base's map with the map extracted from the mirror.

**The mirror.**

- **What it is.** A persistent copy of the in-scope live listing plus its codegraph store, at
  `<repo>/.ye-ast-graph/live/<digest of the declared scope>/` (RFC-0006 `store`; `ye-ast init` already excludes
  the folder). The store is the mirror root's `.ye-ast-graph/` (`CODEGRAPH_DIR`).
- **What it copies.** The copy applies `stageSnapshot`'s drops: engine entries (`.git`, `.codegraph`, `.ye-ast`,
  `.ye-ast-graph`) at every depth, every `.gitignore`, and the root `codegraph.json`. The listing and the
  fingerprint still record those files, as an export does. So repository content cannot configure the engine or
  hide a file from it.
- **Copies, not hard links.** Files are copied (a copy-on-write clone where the volume supports it), never
  hard-linked: an editor that writes in place would otherwise change bytes behind the manifest during a read.
- **Who reads it.** Extractors, the walk and codegraph read the mirror, never the repository. That removes four
  things codegraph would do on the repository itself (codegraph 1.6.2 `extraction/index.js:398-452`,
  `:1443-1495`, `:1562-1585`, `:2297`): read its `codegraph.json`, follow links that point out of the root,
  rediscover the outer `.git`, and index ignored files. The child runs with `GIT_CEILING_DIRECTORIES` set to the
  mirror's parent, as the full build already does (`codegraph.adapter.ts:152`).
- **Refusals.** A `.ye-ast-graph` that is a symbolic link is refused, and so is a mirror directory that is not
  private to the account. That is the rule of the index cache (`privateToOwner`).
- **The state file.** It lives beside the lock, at `live/<scope digest>.state.json`, not inside the mirror: a full build
  deletes the engine's store, and `discard` removes the mirror and the state but never the lock. It records:
  - the codegraph version, the range of `SUPPORTED_STORE` as one string and `STAGING_RULES_VERSION`;
  - the manifest (path, size, mtime, blob id) and the skipped entries;
  - the files the store does not hold;
  - the `stateId` of the last full build (empty while none has completed) and the current `stateId`;
  - `pending`: the mirror paths the store may not reflect yet.
- **Version mismatch.** A version mismatch or an unreadable state file discards the mirror and rebuilds it in full. A
  store the engine cannot update (`sync` fails for any reason but an abort) is rebuilt in full over the same files.
  Nothing is repaired.
- **The first build.** It is an `indexAll`, because `sync` never advances `getIndexBuildInfo`
  (`index.js:655-664`). Only a query that reads the store builds it; `map` copies files only.
- **Retention.** Each distinct declared scope keeps its own mirror, and every live query sweeps the others once its answer
  is built and its lock released. The policy is a typed value the core decides and a host may override through
  composition, never a flag: the scope being answered plus the two most recently used (`keepScopes: 3`), a mirror nobody
  used for more than 14 days (`unusedForMs`), and 512 MiB of logical bytes for the whole `live/` tree (`maxBytes`), each
  scope measured from its state's manifest plus its store's own entries. Last use is the state file's modification time,
  which every successful refresh moves with `utimes`, without changing the state's shape or forcing a rebuild after an
  upgrade. Eviction order: a mirror built by other engines, then one unused past the bound, then the count, then the byte
  cap in least-recently-used order. The scope being answered and a mirror whose lock a live pid holds are never
  discarded, so the cap is best effort and a single mirror over it stays; a state file with no directory, a directory
  with no state and a leftover temporary file are debris and go as well. The sweep is `readdir` and `stat` plus each
  state file's own bytes, never a mirrored file's content, and a sweep that cannot read or remove a mirror leaves it in
  place: it never fails a query and never changes a fact. ADR-0015's garbage collection of kept indexes is a different
  store and stays undecided; [RFC-0006](0006-configuration.md) carries this policy in its `store` row.

**One live query.** A live query holds ye-ast's lock from its refresh until its answer is built.

1. **The lock.** It lives beside the mirror, at `live/<scope digest>.lock`, so a rebuild that discards the mirror
   never discards it. It is an exclusive create with the pid, stale only when that pid is dead, the primitive
   codegraph uses (`utils.js:269-330`). A query that finds the lock held waits for it within its deadline. Holding
   it through the answer means no query ever reads a mirror whose sources and store are mid-update, at the cost of
   serializing live queries on one mirror.
2. **The changed paths.** It lists the tree and compares the listing with the manifest. Added, modified and deleted
   paths all count. When none changed and `pending` is empty, it skips steps 3 to 5: `sync` without paths is a full
   reconcile (`index.js:841`). A query that reads no store (`map`) stops after copying: it adds the changed paths to
   `pending` and leaves the engine alone, so the next query that reads the store syncs them.
3. **`pending`.** It writes the new manifest and the changed paths, with the paths still pending, to the state file as
   `pending`. The next refresh copies them again whatever their stat says.
4. **The update.** It copies or deletes those paths in the mirror and runs `sync({ paths })` with all of them,
   deletions included, in the child started with `--liftoff-only`. `sync` removes only the tracked paths it is
   handed (`extraction/index.js:3119-3160`). It then recomputes the files the store does not hold, with the full
   build's `unindexedFiles` (`codegraph.adapter.ts:128`), plus `sync`'s `failedFilePaths`. That summary covers the
   whole mirror, so the answer cuts only a path the live export staged: each of those is a `no-extractor` cut, as
   after a full build.
5. **Commit.** It writes `state.json` with the new manifest, the files not held and the `stateId`.
6. **The answer.** It builds the answer from the mirror, then releases the lock.
7. **The sweep.** Once the answer is built and the lock released, it sweeps the mirrors of other scopes as
   "Retention" describes, when the staleness check has run.

A refresh cut by the deadline or an interruption, or a lock still held when it arrives, answers `unknown` with reason
`index-unavailable`; the fact has no field for the cause, so none is recorded. The next refresh resumes from `pending`.
The snapshot of such a fact names HEAD and a `stateId` that is the digest of `[head]`, since no state was read. A
family whose answer has no `unknown` form, `map`, answers an `aborted` fault.

**Index origin.** A live fact that read the store carries `inputs.origin`: `{ kind: "full" }` when the
current `stateId` equals the last full build's, otherwise `{ kind: "sync", base: <the last full build's stateId> }`
(ADR-0015 decision 3). A live `map` reads no store and carries none.

**Staleness.** After the answer is built, the query takes the listing again and compares each path's size and
modification time with the manifest (`LiveMirror.changedSince`), reading no content. If any differs, the request's
`onStale` is called with the `stateId` the answer reflects and the changed paths; the transport says the answer is stale
as a response-level sibling of the fact — under `live` beside it on the CLI's stdout, and beside the fact in the MCP's
`structuredContent` and `_meta` (RFC-0002 rule 8; RFC-0005 "Live freshness"). The state the tree is in now is not
named, since only hashing the changed files would tell. The fact itself is unchanged.

**No live fact cache.** This slice keeps none: a walk costs about 10 ms and the refresh dominates. RFC-0002 allows an
in-memory cache keyed by `stateId` but does not require one.

**The `sync` parity test** (ADR-0015 decision 4).

- **The gate test.** A fixture repository: a full build, then the change shapes below, then `sync` through the
  mirror, compared with a fresh full build of the same content. The comparison works on what facts read and ignores
  ids and row order:
  - symbols `(path, kind, name, qualifiedName, span)`;
  - edges `(source, target, kind, line, column, confidence, provenance, synthesizedBy)`, keyed by path and symbol;
  - unresolved references with their candidates;
  - the files the store does not hold.

  The change shapes:
  - add, modify and delete a file;
  - rename a symbol used elsewhere;
  - add a definition that a previously unresolved reference in an unchanged file now names;
  - remove a definition from a surviving file whose callers stay;
  - move HEAD.

  The two definition shapes are the risky class. No index difference turns a fact `partial`, so a difference is
  either a missing caller (a falsely `complete` fact) or an extra one.
- **The measurement.** On one large Java repository and one large Angular repository, replay the last 20
  first-parent commits through the mirror and compare each step with a full build. The run is recorded in ADR-0015,
  like its determinism check.
- **What the result decides.**
  - **Equality** on every shape and every step, on what facts read (the edge kinds the walk follows), lets live facts
    use `sync`, and lets the owner decide whether `sha` facts may read `sync`-derived indexes. The measurement found
    one difference outside that projection, a synthesized `navigates` edge after a template-only change, which no
    fact reads (ADR-0015); a policy that starts following that kind reopens the result.
  - **Any difference** refuses `sync` for live facts as well: each new `stateId` rebuilds the mirror's store in
    full until the engine is fixed, and the difference is recorded. This is stricter than ADR-0015 decision 3, which
    allowed `sync`-derived live facts before the test existed.

  The gate test pins the result, so an engine upgrade that changes it fails the gate.

**First live index.** The first live query that finds no usable mirror builds it under the lock.

- The CLI has no deadline and builds it in the foreground.
- `ye-ast mcp` under `trusted` also starts the build in the background at launch. A live query meanwhile waits for the
  lock within its deadline and then answers `unknown` with `index-unavailable`.
- `ye-ast map --live` needs no index: it reads the mirror's files and carries no `inputs.origin`. It still takes the lock,
  so it waits while a build holds it. The `value` of a live map equals the sha map's entrypoints; the nested facts carry
  the live snapshot and scope, so the whole `value` does not equal byte for byte.
- `ye-ast init` does not build it (RFC-0005 "First index" is revised).
- **Deferred optimisation.** When the clean tree's content key is already in the per-user index cache, the first
  mirror's store could be seeded from that cached index. That is left for when first-build latency is measured.

**Placement.**

| Piece | Where |
|---|---|
| Live export from a state, changed paths, live declared scope | `core/domain/snapshot/` (pure) |
| `stateId` (the digest of the live export's `contentFingerprint`), the refresh, staleness | `core/application/live/` |
| Working-tree port (enumerate, `lstat`, confined copy) | `core/ports/working-tree.port.ts`; adapters in `core/adapters/git/` (enumeration) and `core/adapters/fs/` (stat and copy) |
| Mirror store (lock, state file, copy, stat-only staleness, delete) | `core/ports/live-mirror.port.ts`; adapter in `core/adapters/fs/` |
| `sync` | `CodeGraph.sync(root, paths, signal)` on the code-graph port; the child beside `index-snapshot.child.ts` |
| `diff --no-index` over two scratch trees | `VcsChanges` gains it; adapter in `core/adapters/git/` |
| Refresh and the live branch of each query | `core/application/live/` and the existing query use cases |

## Slices

| Slice | Delivers | Accepted by |
|---|---|---|
| 1 | `impact.ofChange` through `ye-ast impact`: the pinned diff against the merge base, seeds, changed entrypoints, the edge policy with derived bridges, widest-path confidence, fan-in, the entrypoint join, every cut above | a fixture per seed rule, edge row and cut; byte-identical output on two runs; containment parity with qayaba's reader, except the expansion through the type that declares a reached member, which [ADR-0017](../adr/0017-owner-of-a-member-expands-only-whole-type-edges.md) supersedes: on a real repository, everything qayaba's reader reaches under qayaba's budget is reached under the same budget, each extra node traces to a row, and a node qayaba reaches only by expanding an owner reached through a member may be absent |
| 2 | `impact.callers`, `impact.importers`; content-keyed index reuse with its determinism test | fixtures; importers contain qayaba's `importersOf` |
| 3 | protocol and MCP methods; a live `head` under `trusted` with the `sync` parity test | RFC-0005's first protocol slice; ADR-0015 decision 4 |
| 4 | Angular templates (A4) and injection (A2) as derived edges. Delivered early, with slice 1: the relations enter the walk through the inbound-edges port, `.html` templates join the map's export and digest, and the A2/A4 cut narrows to relations the reader reported `unknown` and is an `unresolved-link` cut: the walk could not follow a relation, which is not a file in a language with no extractor | RFC-0007 rows A4 and A2 |

Deferred until the base is measured: receiver or import scoping of `unresolved-link`; a cut for name-matched edges
that point at the wrong target; indexing the merge base; Spring Data derived queries, AOP, `List<Bean>` injection,
`@Qualifier`, reflection; references through chained calls.

## Across repositories

Out of `ImpactQueries`: a composition in `TopologyQueries` (RFC-0001), over links from a call site in one repository
to an entrypoint in another, upstream (who calls what changed) and downstream (what an event a change publishes
reaches). Its facts carry one section per repository and the workspace's list of snapshots. RFC-0011 designs it; this
RFC's per-repository pieces (changed entrypoints, `impact.callers` by line range, the join) are what it composes.

## Decisions

The owner accepted the recommendations below on 2026-11-01: first "apply the 4 you recommend", then "Si" to the
review's eight.

| # | Question | Decision |
|---|---|---|
| 1 | Two revisions or diff text? | Two revisions; ye-ast reads git |
| 2 | Index the merge base for removed symbols? | Not now; the merge base is extracted (no index) for changed entrypoints |
| 3 | Ship Angular impact before A2 and A4? | Yes, with their `no-extractor` cut; A4 and A2 follow (slice 4) |
| 4 | RFC-0003's walk values as defaults? | No; optional budgets only |
| 5 | Parity: equality or containment? | Containment, with the edge-policy table |
| 6 | codegraph's heuristic synthesized edges? | Template and event edges excluded; interface bridges derived by ye-ast |
| 7 | Test files? | Not callers; stated in the declared scope |
| 8 | Two-dot diff or merge base? | Merge base |
| 9 | A live working tree as `head`? | Later slice, `trusted` only |
| 10 | Index cache key? | Staged content ([ADR-0015](../adr/0015-index-reuse-by-content.md)) |
| 11 | Live facts on a `sync`-derived index? | Allowed with the origin in `inputs`; `sync` parity test brought forward (ADR-0015) |
| 12 | Cross-repo envelope? | Per-repository sections plus a snapshot list, settled in RFC-0011 |

Slice 3's design ([Live head](#live-head-slice-3)) was crossed from three independent plans on 2026-11-01 and
corrected by two independent reviews the same day; the owner asked for it ("hazlo como recomiendas").
