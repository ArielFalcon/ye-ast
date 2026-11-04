# RFC-0005: Transports: CLI, query server, fixed layer, MCP, hooks and daemon

- Status: Draft, 2026-10-29
- Related: [ADR-0005](../adr/0005-runtime-topology-and-delivery-order.md),
  [ADR-0007](../adr/0007-dependency-versions.md), [ADR-0010](../adr/0010-trust-modes.md),
  [ADR-0011](../adr/0011-query-protocol-in-the-mvp.md), [RFC-0001](0001-architecture-and-layers.md),
  [RFC-0002](0002-facts-contract.md), [RFC-0006](0006-configuration.md)

**In short:** each door has one responsibility and no analysis logic. The MVP ships the CLI, the fixed layer, the query
server (`ye-ast serve`) and an in-process stdio MCP. Hooks and the daemon follow in topology A1, and hooks do not wait
for the daemon where the client can call the session's MCP server. The daemon's good practices below must be complete
and agreed before its slice starts.

## CLI (MVP)

| Command | Does |
|---|---|
| `ye-ast map` | Prints the deterministic map at a snapshot ([RFC-0004](0004-deterministic-map.md)) |
| `ye-ast init` | Records the user's trust declaration outside the repository, writes the fixed layer under `.ye-ast/`, ignores ye-ast's folders (`.ye-ast/`, `.ye-ast-graph/`) through `.git/info/exclude`, and prints the client configuration |
| `ye-ast serve` | Serves the query protocol on stdio to a host that runs ye-ast as a child process ([ADR-0011](../adr/0011-query-protocol-in-the-mvp.md)) |
| `ye-ast mcp` | Starts the stdio MCP server |
| `ye-ast --version`, `--help` | Exist today |

**Exit codes and signals.** `0` ok; `1` the query answered with a typed fault (unknown revision, a path that is not a
repository root, a blob missing from a partial clone, a failed write of the export); `2` usage; `70` an internal fault
(an unexpected crash, one stderr line); `130` the query was aborted. SIGINT and SIGTERM abort the running query through
its `AbortSignal` ([ADR-0011](../adr/0011-query-protocol-in-the-mvp.md) decision 3): the git process is killed, the
temporary export is removed and the process exits with 128 plus the signal number (130, 143). A fact that the export
budget cut ([RFC-0006](0006-configuration.md#export-budget)) is still an answer: it is printed with exit `0` and its
`caller-budget` cut says where the export stopped.

**`ye-ast init` as built.** `ye-ast init --trust trusted|untrusted [<repo>]` (`<repo>` defaults to the working
directory; `--trust` is required and has no default, since a security declaration is never guessed: a missing or other
value is a usage error, exit `2`). In this order it checks that `<repo>` is a repository root with a `HEAD`; records the
declaration in the user-level record (below); appends `.ye-ast/` and `.ye-ast-graph/` to the repository's local exclude
file, located through the user's own `git rev-parse --git-path info/exclude` so a linked worktree or a `.git` file
works, adding only the lines that are absent and editing no tracked file, and refusing a file that is a symbolic link
or whose real location is outside git's common directory; and writes the fixed layer at `HEAD` through
`FixedLayerAdmin`. When a step after the record fails, the CLI first says that the trust was recorded.
It prints the trust mode, the lines it added to the exclude file, one line per layer file (`written` or `unchanged`) or
`not written` with its reason, and the command that registers the MCP server with Claude Code, which it never runs:
`claude mcp add ye-ast -- npx --yes tsx <ye-ast>/src/composition/main.ts mcp <repo>`. A second run changes nothing.
Building the index is not part of it yet ([First index](#first-index)). Only the CLI receives the install use case; the
MCP server and the query protocol never do.

**Trust declaration.** The trust mode ([ADR-0010](../adr/0010-trust-modes.md)) is declared outside the
analysed repository: by a user through `ye-ast init`, which writes a user-level record, or with a command-line flag;
by a host through the library or the hello of the query protocol. Nothing inside the repository can raise it. Without a
declaration the CLI and the MCP server run `untrusted`. The record is one file per repository,
`repositories/<sha256 of the real path>.json`, in the user's configuration directory
([RFC-0006](0006-configuration.md) open question 3). A directory or file of the record that is a symbolic link, belongs
to another account or is open to the group or others is refused, never repaired; a record that cannot be used reads as
no declaration, the fact runs `untrusted`, and the CLI and `ye-ast mcp` write one line naming the fault on stderr. The CLI and
`ye-ast mcp` read it for the repository they run on and record the mode in every fact's `inputs.trust`; `ye-ast serve`
ignores it, since its host declares the mode with `trust.declare`, and keeps refusing `trusted`. Every read still goes
through the git export at a sha, and the live tree and the repository's manifest are outside this slice, so today a
`trusted` record changes `inputs.trust` and nothing else. Slice 3 of [RFC-0010](0010-impact-queries.md#live-head-slice-3)
adds the `live` selector, which reads the working tree through ye-ast's mirror and only under `trusted`; `serve` keeps
refusing `trusted` in that slice.

## Query server (MVP)

`ye-ast serve` is the door for a host that runs ye-ast as a child process. It speaks the query protocol of
[ADR-0011](../adr/0011-query-protocol-in-the-mvp.md) on stdio; the daemon later speaks the same protocol over a Unix
socket.

| Part | Contract |
|---|---|
| Framing | JSON-RPC 2.0, UTF-8, one message per line, over any reliable byte stream: MCP's stdio framing, which custom transports over a reliable byte stream "SHOULD reuse the stdio framing rather than defining a new one" ([MCP 2026-07-28, transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)) |
| Hello | The first line of a connection carries the protocol version and the ye-ast version; the host then declares the trust mode with `trust.declare` before any query. On a mismatch a host client stops and says why |
| Methods | One method per query-family operation (for example `impact.callers`); a result is a fact ([RFC-0002](0002-facts-contract.md)); an error carries a code from a closed set |
| Cancellation | A notification naming the request, mapped to the call's `AbortSignal`; a deadline travels as a parameter |
| Reach | The server exposes the query families and `SnapshotAdmin` to the host; nothing an agent reaches exposes `SnapshotAdmin` |
| Code | `src/protocol/` holds the server and its client; composition wires them to stdio now and to the daemon's socket later ([RFC-0001](0001-architecture-and-layers.md)) |

### Hello and trust

The server writes the hello as a notification before it reads anything:
`{"jsonrpc":"2.0","method":"hello","params":{"protocol":"ye-ast-query","version":1,"producer":"<ye-ast version>"}}`.
Right after it the host declares the trust mode with `trust.declare` (`{"mode":"trusted"|"untrusted"}`). Every query
before that is refused with `trust-not-declared`. `trusted` is refused with `trust-unsupported` until a `trusted` path
exists ([ADR-0010](../adr/0010-trust-modes.md)).

### Methods

Params are strict objects: an unknown key is `invalid-params`. Every query method also takes `deadlineMs`, a positive
integer of at most 2147483647 (the largest delay a timer honours); when it elapses the call is aborted and answered
`deadline`.

| Method | Kind | Params | Result |
|---|---|---|---|
| `hello` | notification, server to host | `protocol`, `version`, `producer` | none |
| `trust.declare` | request | `mode` | `{"trust": "untrusted"}` |
| `cancel` | notification, host to server | `id`, the request to abort | none; the request is answered `aborted` |
| `entrypoints.map` | request | `repo`, `repoId`, `revision`, `scope?` | the entrypoints fact |
| `impact.ofChange` | request | `repo`, `repoId`, `base`, `head`, `changed?`, `scope?`, `budget?` | the impact fact |
| `impact.callers` | request | `repo`, `source?`, `repoId`, `revision`, `targets` (`{file, symbol}` or `{file, start, end}`), `scope?`, `budget?` | the impact fact |
| `impact.importers` | request | `repo`, `repoId`, `revision`, `files`, `scope?` | the impact fact |

`source` on `impact.callers` is an optional snapshot read location supplied by a host composing workspace reads.
`repo` remains the declared clone whose trust applies; omitting `source` reads that clone. MCP does not expose this
internal workspace choice as a tool argument.

`budget` is `{depth?, hubFanIn?, expansions?}`, positive integers. `scope` is `{include?, exclude?}`, lists of non-empty globs over repository-relative paths ([RFC-0002](0002-facts-contract.md) rule 4); the CLI takes them as the repeatable `--include <glob>` and `--exclude <glob>` of `map`, `impact`, `callers` and `importers`. `changed` is a list of non-empty globs over the changed paths ([RFC-0018](0018-change-selection.md)); the CLI takes it as the repeatable `--changed <glob>` of `impact`. A result is the fact, redacted at egress.

### Errors

An error is `{code, message, data: {kind}}`; `kind` names the code and `data` adds `entries` for `unknown-symbol`, each
`{file, symbol, candidates}` where `candidates` names the seedable declarations of the file, sorted and once each, and
`globs` for `unknown-change-path`. The set is closed:

| Kind | Code | Meaning |
|---|---|---|
| `parse-error` | -32700 | the line is not JSON |
| `invalid-request` | -32600 | not a JSON-RPC 2.0 request, or the id is still in flight |
| `method-not-found` | -32601 | no such method |
| `invalid-params` | -32602 | the params are not valid for the method |
| `internal-error` | -32603 | the call threw |
| `unknown-revision` | -32000 | the revision does not exist |
| `git-failed` | -32001 | git failed |
| `not-repository-root` | -32002 | the path is not a repository root |
| `object-missing` | -32003 | a git object is missing |
| `no-merge-base` | -32004 | base and head share no history |
| `export-write-failed` | -32005 | the snapshot export could not be written |
| `aborted` | -32006 | the call was aborted by `cancel` or by shutdown |
| `unknown-symbol` | -32007 | a target names no symbol |
| `deadline` | -32008 | `deadlineMs` elapsed |
| `trust-unsupported` | -32009 | the declared trust mode has no path yet |
| `trust-not-declared` | -32010 | a query came before `trust.declare` |
| `unreadable` | -32011 | the path does not exist, is not a directory, or the account cannot read it |
| `unknown-change-path` | -32015 | a `changed` glob selects no path the change touches |

## Fixed layer (MVP)

- Lives in `.ye-ast/` at the repository root. `ye-ast init` excludes it through `.git/info/exclude`, where git's
  documentation puts patterns "specific to a particular repository but which do not need to be shared"
  ([gitignore](https://git-scm.com/docs/gitignore)), so ye-ast edits no tracked file.
- Files of facts (JSON) plus a Markdown digest rendered from them for agents, each stamped with snapshot, producer,
  schema and completeness.
- Written by a core use case behind `FixedLayerAdmin`, through the driven port `FixedLayerStore`: temporary file, then
  rename. Only the library and `ye-ast init` reach it, and the daemon once it exists; `ye-ast serve` exposes the
  query families and `SnapshotAdmin` only ([ADR-0011](../adr/0011-query-protocol-in-the-mvp.md) decision 4); no
  transport facing an agent reaches it.
- Never written from a fact cut by a deadline ([RFC-0002](0002-facts-contract.md) rule 3). Redaction applies the
  patterns only, so the layer stays deterministic (rule 7).
- Invalid when a fact's `inputs`, its `schema` or the producer version differ from the current ones (rule 5); the
  digest is read before the facts. [RFC-0012](0012-observability-and-measurement.md) makes `schema` part of that test.
- No size budget: the layer holds the whole fact and a digest of it, since no measurement yet justifies a bound
  (nothing in ye-ast bounds an output without one). The layer is `entrypoints.json` (the redacted fact) and `README.md`
  (the digest: snapshot, producer, schema, completeness with every cut and its places, and each entrypoint with its
  `path:line`). `FixedLayerAdmin.refresh` rewrites both only when the stored `inputs` or producer differ, and writes
  neither for a fact cut by a deadline or unknown for `index-unavailable`.

## MCP (MVP: in-process stdio)

- Built on `@modelcontextprotocol/server`, the stable v2 line of the MCP TypeScript SDK
  ([ADR-0007](../adr/0007-dependency-versions.md)).
- Receives only read query families; a write is impossible by type. No tool asks for a reindex: a `live` snapshot stays
  fresh through [Live freshness](#live-freshness).
- Tools answer questions codegraph's own MCP does not: impact with completeness, entrypoints reaching a symbol, route
  table, consumers and contract of an operation, change scope, status. No duplicate of `codegraph_explore`.
- Answers rendered from structured facts with a token budget, `path:line` evidence and explicit `unknown`. qayaba's
  `explore-answer.ts` is not reused: it parses codegraph's Markdown output.
- Keeps its snapshot open for the session.
- Takes no `scope` yet: its tools run with the empty `include` and `exclude`.

| Tool | Params | Answers |
|---|---|---|
| `ye_ast_entrypoints` | `revision?` or `live?` | the entrypoints of the repository |
| `ye_ast_impact` | `base`, `head?` or `live?`, `budget?` | what depends on the change from the merge base to the head |
| `ye_ast_callers` | `revision?` or `live?`, `targets`, `budget?` | the callers of symbols or line ranges |
| `ye_ast_importers` | `revision?` or `live?`, `files` | the importers of files |

`live` is a boolean that reads the working tree ([Live freshness](#live-freshness)); the strict schema refuses it
together with `revision` (or `head`). Under `untrusted` the tool answers `isError` with `live-requires-trusted`.

Every tool also takes `full`, a host's opt-in: by default `structuredContent` carries the envelope alone, and `true`
adds the whole fact, every impacted symbol and every cut place included.

All tools are read-only, take strict schemas and are bound to the repository given at launch. The text is what an agent
reads; `structuredContent` carries the redacted envelope without the family's `value` and without the cut places the
text already prints — `schema`, `snapshot`, `producer`, `inputs`, `status`, `reason` when the answer is unknown, and
`evidence` — so a `partial` status stays machine-checkable while its places live in the text. Duplicating the fact
cost a measured answer 1.5× to 6× its text (683 771 characters of fact against 144 691 of text), and a machine that
needs the whole fact has the library and `serve`; `full: true` puts it back beside the same text, byte for byte. The
text rendering opens with the status, the declared scope that status is relative to and the snapshot,
states `path:line` evidence, the span of every declaration longer than one line (`src/a.ts:3-9`), and every place where a
reached symbol depends on the one that reached it (`via src/b.ts:B.user at 14, 21, 33`), naming the dependence instead
when the store places no line for it (`(call)`, `(reference)`, `(contains)`, `(dispatch)`, `(relation)`, `(import)`), counts
the cuts by kind on the status line and closes with their full list, so the answer is
read before the price of its completeness. The response-level statuses a fact must not carry — staleness and a refresh —
open the text with a `stale:`, `remote:` or `pinned:` line, the same statuses `_meta` and the fact's siblings carry, so
the text alone loses nothing. A fault is an `isError` result: its text names the kind on the first line and `_meta`
carries `{ kind, detail, entries? }` under `ye-ast/fault`, never `structuredContent`, which is the fact envelope every
tool declares as its `outputSchema`.

The server answers `initialize` with `instructions`: when each tool earns a call (orientation, before changing a symbol,
before moving a file, the whole change at once before reporting it done, because the impact answer repeats what the
callers answer already said about the symbols it stays inside) and how to read `complete`, `partial`, `unknown` and the
cut list that closes every answer. Each tool description repeats its own "use it when". Every tool declares the fact envelope as its `outputSchema` (an
object root, extra members allowed, `value` and `cuts` optional and left to the family), and the SDK checks each answer
against it; that optionality is what lets the default envelope and the `full` one both conform.

## Live freshness

A `live` snapshot exists under `trusted` only and is designed in
[RFC-0010 "Live head"](0010-impact-queries.md#live-head-slice-3). Every live query, through the CLI or the MCP server,
refreshes ye-ast's mirror of the working tree before it answers:

1. Under ye-ast's lock, held until the answer is built, it copies or deletes the added, modified and deleted paths in
   the mirror and runs codegraph's incremental `sync` on them, or nothing when no path changed (codegraph 1.6.2 `dist/index.d.ts:184`), in a child process
   started with `--liftoff-only`, within the call's deadline. The flag works only on a Node command line, not in `NODE_OPTIONS` or a worker's `execArgv` (codegraph
   1.6.2 platform bundle `lib/dist/extraction/wasm-runtime-flags.js:19-38`). The fact records the index's origin
   ([ADR-0015](../adr/0015-index-reuse-by-content.md)); whether `sync` may serve at all is decided by its parity test
   (RFC-0010 "Live head").
2. A refresh the deadline cuts, or a lock another process still holds at the deadline, answers `unknown` with reason
   `index-unavailable`; the fact records no cause. A mirror in the middle of an update is never served as the last indexed state,
   since its sources and its store may disagree.
3. After the answer the query lists the tree again and compares each path's size and modification time with the mirror's
   manifest, reading no content; when any differs, the answer is stale. The notice names the state the answer reflects
   (`stateId`) and the changed paths; the state the tree is in now is not named, since only hashing the changed files
   would tell. It is a response-level sibling of the fact, never a field of it, so the fact keeps the bytes of the
   answer for the state it reflects. The CLI keeps the fact on stdout, prints the redacted `{ stateId, changed }` under
   `live` beside it, and writes one redacted stderr line with both, exit code unchanged. The MCP tool opens its text
   with a `stale:` line, adds the redacted `live` sibling to `structuredContent` beside the untouched fact, and carries
   the same `{ stateId, changed }` in the result's `_meta` under `ye-ast/live`.
4. No tool asks for a reindex, so the MCP stays read-only.

Staleness is a property of the response, not a fact status ([RFC-0002](0002-facts-contract.md) rule 8). qayaba measured
a one-file `sync` at 0.68 s on a 17 717-node index (qayaba@4105c582 `odd/tasks/codegraph-migration.md:230`).

## First index

A clone starts with no index and no fixed layer, since `ye-ast init` keeps `.ye-ast/` and `.ye-ast-graph/` out of
git. The first build is the same operation as every later one with nothing to reuse
([RFC-0002](0002-facts-contract.md) rule 5), so there is no onboarding mode.

A store counts as an index only when codegraph reports its last full run `complete` and the codegraph version ye-ast
pins built it ([RFC-0003](0003-codegraph-integration.md#index-reuse-across-shas)). On a fresh store the bulk build trades
crash durability for speed, so a run killed mid-index leaves the state `indexing` and a store codegraph treats as
disposable (codegraph 1.6.2 `dist/index.d.ts:294-303`; platform bundle `lib/dist/index.js:463-466,498`). Any other
store, or one that cannot be opened, counts as no index, and the next build starts from scratch.

| Entrypoint | With no index |
|---|---|
| `ye-ast init` | Builds nothing; the first live query builds the live mirror ([RFC-0010 "Live head"](0010-impact-queries.md#live-head-slice-3)) |
| CLI `--live` | Builds the live mirror in full in the foreground under ye-ast's lock; the CLI has no deadline. `map --live` copies the files and builds nothing; the first query that reads the index builds it |
| MCP server | Under `trusted`, starts the live mirror's full build at launch in a child process with `--liftoff-only`, as for `sync`; a live query before it ends waits for ye-ast's lock within its deadline and then answers `index-unavailable` (the fact has no place yet for the cause). Until an index exists, whichever process builds it, every query answers `unknown` with reason `index-unavailable` ([RFC-0002](0002-facts-contract.md) rule 1), never an empty result |
| `ye-ast serve` | Builds nothing on its own: the host builds or hands over each snapshot through `SnapshotAdmin` ([ADR-0011](../adr/0011-query-protocol-in-the-mvp.md) decision 4); a query on a snapshot without an index answers `index-unavailable` |
| Session-start hook | Runs `ye-ast init` within its timeout. When it does not finish, the hook says so in one line and the previous fixed layer, if any, stays; each fact in it whose inputs changed reads as invalid |

## Hooks (after the MVP)

Candidate events (exact client semantics to verify when the slice starts): session start (refresh the fixed layer,
then status and summary), before an edit (advisory blast radius of the file), after an edit (bring the index up to
date). A hook never blocks the agent: it has a strict timeout and, when it cannot answer, says so in one line.

Hooks do not wait for the daemon ([ADR-0011](../adr/0011-query-protocol-in-the-mvp.md)). A hook runs through the
session's MCP server where the client can call MCP tools from hooks; a hook client process serves only a client that
cannot. In Claude Code ([hooks](https://code.claude.com/docs/en/hooks)):

| Event | Hook type | Why |
|---|---|---|
| Before and after an edit | `mcp_tool` | It calls "a tool on a configured MCP server", and "the tool's text output is treated like command-hook stdout". The session's MCP server is already running, so no process is spawned and no daemon is needed. The after-edit hook queries the `live` snapshot, which reaches the rule of [Live freshness](#live-freshness) |
| Session start | `command` | `SessionStart` at launch skips `mcp_tool` hooks because MCP servers are not up yet; a `command` hook pays one cold start per session. It runs `ye-ast init`, which rewrites only the fixed-layer facts whose inputs changed, so hooks keep the fixed layer fresh ([ADR-0005](../adr/0005-runtime-topology-and-delivery-order.md) decision 1) without a write on the MCP server |
| None | `http` | It would need a local port, which [ADR-0005](../adr/0005-runtime-topology-and-delivery-order.md) rejects (decision 4: no MCP over HTTP, no local authentication) |

## Daemon (after the MVP, topology A1)

The daemon is justified by sharing one graph between sessions and agents, the watcher and the single writer, not by hook
latency ([ADR-0011](../adr/0011-query-protocol-in-the-mvp.md)).

### Responsibilities

- Own the open snapshots, caches, the file watcher and the single writer per store.
- Write the fixed layer, through `FixedLayerAdmin`.
- Serve the query protocol over a Unix socket (named pipe on Windows) to the stdio MCP adapter, the hook client and the
  CLI.

### Good practices to define completely before the slice

| Area | Practice |
|---|---|
| Lifecycle | Started on first use by any client; detached from the client; idle timeout; clean shutdown on signal; stale socket and pid detection |
| Versioning | Hello on connect with the protocol and ye-ast versions; on a mismatch the MCP adapter and the hook client answer in process and say so, and a host client stops and says why |
| Isolation | Indexing in child processes, never on the query event loop; a crash per project does not take down other projects |
| Concurrency | One writer per store, immutable sha stores, leases for open snapshots |
| Consistency | Every answer names the state it reflects (the snapshot, and the state id for `live`); a client may wait within its deadline for the state of its last edit |
| Memory | Caps per snapshot and in total; eviction by lease and least-recent use; graceful refusal over the cap |
| Priority | Queue where hook queries go before indexing |
| Security | Socket in a 0700 directory, Windows pipe ACL, local only, no network listener |
| Socket path | A Unix socket path has a length limit: the socket sits in the project's data directory and falls back to the temporary directory over 100 characters, as codegraph's does (codegraph 1.6.2 `mcp/daemon-paths.js:78,113-122`), inside a 0700 directory as the Security row requires |
| Degradation | Unavailable daemon → in-process answer that says so; never an empty fact |
| Observability | Structured logs, optional OTLP, per-query cost; dependency telemetry off |
| Platforms | macOS, Linux, Windows paths and pipes |

codegraph's daemon already solves most of this for its own process and is the reference design (`dist/mcp/daemon.d.ts`,
`daemon-paths.d.ts`, `writer-lock.d.ts`, `version.d.ts` in codegraph 1.6.2). codegraph spawns its daemon through its own
CLI (`serve --mcp`, codegraph 1.6.2 `mcp/index.js:286`) and ye-ast never calls codegraph's CLI shim, so ye-ast reuses
the design, not the code.

## Open questions

The owner accepted these recommendations on 2026-10-30 (translated): "yes, I accept them all".

| # | Question | Recommendation |
|---|---|---|
| 1 | Is `.ye-ast/`, excluded through `.git/info/exclude`, the right default for the fixed layer, or should it be committed? | Excluded by default; committing is a configuration choice |
| 2 | Which clients other than Claude Code can call an MCP tool from a hook? | Verify at the hooks slice; a hook client process is the fallback for a client that cannot |
