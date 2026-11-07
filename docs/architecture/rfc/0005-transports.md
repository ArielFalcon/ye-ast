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
| `ye-ast contract-consequences` | Prints the contract consequences fact of written hypotheses or of a contract diff ([RFC-0023](0023-consequences-surfaces.md)) |
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

**Batch installation.** `ye-ast init --trust trusted|untrusted --repo <id> <path> ... <launch-repo>` selects the
positional launch and each explicit binding. Paths resolve against the invocation directory; the launch is required when
`--repo` is used. A binding of the canonical launch root chooses its ID, otherwise the normal repository name is used.
Aliases of the same root and ID coalesce; conflicting roots or IDs fail preflight before writes. A supplied workspace
manifest is persisted only on launch and does not add trust targets. Each root is installed sequentially and independently;
failures can leave earlier trust records in place. The first stdout line is a redacted JSON report. Only when every target
completes with a written or unchanged layer does the second line give `{ "command", "args" }` for a complete MCP
registration. A `not-attempted` target is unverified; an empty launch ID in a preliminary failure means its identity
has not yet been established. A rejected batch call leaves all selected writes unknown. Incomplete batches exit `1`,
malformed syntax `2`, cancellation `130`, and unexpected failures `70`.

**Trust declaration.** The trust mode ([ADR-0010](../adr/0010-trust-modes.md)) is declared outside the
analysed repository: by a user through `ye-ast init`, which writes a user-level record, or with a command-line flag;
by a host through the library or the hello of the query protocol. Nothing inside the repository can raise it. Without a
declaration the CLI and the MCP server run `untrusted`. The record is one file per repository,
`repositories/<sha256 of the real path>.json`, in the user's configuration directory
([RFC-0006](0006-configuration.md) open question 3). A directory or file of the record that is a symbolic link, belongs
to another account or is open to the group or others is refused, never repaired; a record that cannot be used reads as
no declaration, the fact runs `untrusted`, and the CLI and `ye-ast mcp` write one line naming the fault on stderr. The CLI and
`ye-ast mcp` read it for the repository they run on and record the mode in every fact's `inputs.trust`; `ye-ast serve`
ignores it, since its host declares the mode with `trust.declare`, and keeps refusing `trusted`. Committed reads use
a git export. Trusted CLI/MCP reads may use `live` through ye-ast's working-tree mirror as described in
[RFC-0010](0010-impact-queries.md#live-head-slice-3); `serve` continues to refuse `trusted`.

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
| `trace.walk` | request | `repo`, `repoId`, `revision`, `targets`, `scope?`, `budget?` | the trace fact |
| `contractConsequences.ofHypotheses` | request | `repo`, `repos?`, `gateways?`, `hypotheses` (non-empty), `scope?` | the contract consequences fact ([RFC-0023](0023-consequences-surfaces.md)) |
| `contractConsequences.ofChange` | request | `repo`, `repos?`, `gateways?`, `base`, `head?`, `scope?` | the contract consequences fact |

`source` on `impact.callers` is an optional snapshot read location supplied by a host composing workspace reads.
`repo` remains the declared clone whose trust applies; omitting `source` reads that clone. MCP does not expose this
internal workspace choice as a tool argument.

`budget` is `{depth?, hubFanIn?, expansions?}`, positive integers. `scope` is `{include?, exclude?}`, lists of non-empty globs over repository-relative paths ([RFC-0002](0002-facts-contract.md) rule 4); the CLI takes them as the repeatable `--include <glob>` and `--exclude <glob>` of `map`, `impact`, `callers` and `importers`. `changed` is a list of non-empty globs over the changed paths ([RFC-0018](0018-change-selection.md)); the CLI takes it as the repeatable `--changed <glob>` of `impact`. A result is the fact, redacted at egress.

`workspace.outwardNames` accepts optional `replay` and returns optional `workspaceReplay` beside its fact. The context
is `{version: 1, declaration: "ws-r1:<64 lowercase hex>", snapshots}` with unique repository IDs sorted by repository.
Each snapshot is `{repo, kind: "sha", sha}` or `{repo, kind: "live", head, stateId}`; it includes a known SHA even for
an unavailable member. Preserve omitted membership arguments when replaying persisted membership. Pins grant neither
membership nor trust: current declarations and authority are checked again. A changed declaration, member set or live
capture returns `workspace-replay-mismatch` (-32016), with a redacted error and no result. Malformed contexts are
`invalid-params`; decisions do not accept replay. Live replay checks a newly captured state rather than retaining old
working-tree contents. Per-repository stale or unavailable observations travel in `workspaceLive` beside the fact;
unavailable diagnostic paths are omitted and all result fields pass through the secret redactor.

The query protocol accepts revision or `live: true` per workspace member and mixed workspace replay contexts;
this is a transport contract, not a trust grant. The default `ye-ast serve` ignores user trust records, accepts only
an untrusted handshake, and refuses live workspace reads with `live-requires-trusted`. Local query RPCs remain
revision-based and there is no workspace-impact RPC. The CLI `workspace` and `decisions` commands accept committed
revisions only; MCP and the library support live workspace members subject to repository trust. Protocol workspace
results retain `repositorySources` host read-location metadata for existing clients, outside deterministic facts.

### Errors

An error is `{code, message, data: {kind}}`; `kind` names the code and `data` adds `entries` for `unknown-symbol`, each
`{file, symbol, candidates}`, or `{file, start, end, candidates}` for a line range that selects no declaration, where `candidates` holds the dotted containment paths of the seedable declarations of the file, sorted and once each,
`entries` for `unknown-entrypoint`, each `{kind, name, candidates}` with the names the map holds of that kind, sorted
and once each, and `globs` for `unknown-change-path`. The set is closed:

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
| `unknown-symbol` | -32007 | a target names no symbol, or a line range selects no declaration |
| `deadline` | -32008 | `deadlineMs` elapsed |
| `trust-unsupported` | -32009 | the declared trust mode has no path yet |
| `trust-not-declared` | -32010 | a query came before `trust.declare` |
| `unreadable` | -32011 | the path does not exist, is not a directory, or the account cannot read it |
| `unknown-change-path` | -32015 | a `changed` glob selects no path the change touches |
| `workspace-replay-mismatch` | -32016 | the current workspace declaration, membership or captured state does not match replay |
| `duplicate-workspace-source` | -32017 | selected repository paths alias the same canonical source |
| `workspace-capture-unavailable` | -32018 | a selected live workspace capture failed; data identifies its repository and typed cause |
| `live-requires-trusted` | -32019 | a live read was requested without repository trust |
| `unsupported-object-format` | -32020 | live capture does not support the repository object format |
| `live-mirror-failed` | -32021 | a live mirror operation failed |
| `unknown-entrypoint` | -32023 | a trace target names an entrypoint kind and name the map at that revision does not hold |
| `invalid-hypothesis` | -32024 | a contract consequences hypothesis is malformed or unsupported; data holds its `index` and refusal |
| `contradictory-revisions` | -32025 | the bound repository's revision contradicts the change's `head` |

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

The read-only MCP server uses the stable v2 TypeScript SDK. `ye-ast mcp [<launch-root>] [--repo <id> <root>]...`
selects a canonical launch root and an external catalog of existing worktree roots. Each query family accepts an exact `repo`
ID; omission selects launch. Repeated identical ID/root declarations coalesce, while aliases and collisions fail at
startup. A declaration for the launch root may choose its ID. Availability does not grant trust or workspace membership;
only launch is warmed. Workspace reads retain each repository's own trust and snapshot. A foreign follow-up uses its
owner ID and recorded snapshot, or requires updated registration when absent. Selective evidence follows
[ADR-0022](../adr/0022-typed-query-replay-and-selective-evidence.md).

| Tool | Question | Main arguments besides `mode` |
|---|---|---|
| `ye_ast_entrypoints` | Where are routes, listeners and jobs handled? | `revision`, `live`, `scope` |
| `ye_ast_impact` | What depends on a diff? | `base`, `head`, `live`, `changed`, `scope`, `budget`, `workspace`, `offline` |
| `ye_ast_callers` | What depends on a declaration or range? | `targets`, `revision`, `live`, `scope`, `budget`, `workspace`, `offline` |
| `ye_ast_importers` | Which files import or name a file? | `files`, `revision`, `live`, `scope` |
| `ye_ast_outline` | Which declarations, spans and imports are in selected files? | `files`, `revision`, `live`, `scope` |
| `ye_ast_workspace` | Which outward names and candidate repositories are recorded? | `repos`, `gateways`, `revision`, `live`, `offline`, `scope` |
| `ye_ast_decisions` | Which workspace configuration gaps need user input? | `repos`, `gateways`, `revision`, `live`, `offline`, `scope` |
| `ye_ast_trace` | What do declarations execute, in source order, with their effects? | `targets`, `revision`, `live`, `scope`, `budget` |
| `ye_ast_contract_consequences` | What does a request/response contract change break in consumers and producers? | `hypotheses` or `base`/`head`, `revision`, `live` (hypotheses only), `scope`, `workspace` |
| `ye_ast_compose` | Which related observations can share entities and evidence? | `queries`, `expect`, `deadlineMs` |

The composition operation extends the seven original families. It accepts 1–16 typed semantic queries, validates all
arguments and declared primary repositories before executing, and deduplicates identical queries. Sources execute
sequentially in canonical order through the same query runner as the individual tools. The request is limited to
1,048,576 UTF-8 bytes of canonical JSON; a deadline is optional. There is no generic pipeline, recursive compose,
variable substitution, result handle or final-result retention. Acquiring coordinates for a dependent query remains the
consumer's responsibility. This is an explicit extension beyond ADR-0022's original selective-recovery scope, while
preserving its verified-reexecution strategy.

Each family's typed adapter normalizes only public redacted facts. A pure union preserves observations and supports;
materialization identifies exact compatible entities and applies closed connection rules. Snapshot identity includes
repository and full SHA, or live head and stateId. Ambiguity, redacted coordinates and incompatible snapshots block
joins. Analysis scope, provenance, cuts, unknowns and query-specific observations remain attached to their reads.
Importer categories and declaration dependencies retain distinct meanings; neither composition nor reachability proves
breakage. Changed contract operations, unresolved workspace call sites and the changed operations a link calls stay
attached to their reads; calling a changed operation does not establish that the changed data is read. The same fixed
evidence set materializes identically across input order and duplication. Execution over
moving live state or external configuration does not promise atomicity or identical observations.

Composition uses the same single content block as the original tools. Summary/details put explained findings in the
presentation and `kind: "composition-receipt"` in the result JSON line; full puts `kind: "composition"` there, with
normalized tables under `graph`. Both include `compositionSchema: 1`, `mode`, `verification` and complete safe
`requests`. The text modes put findings, source states and limits in text only; `S#` indexes `requests[#-1]`. Full
additionally retains `coverage` and `counts`. Coverage has per-read states and issues, with no aggregate complete status. Original `Fact.schema` is
unchanged. IDs reference shared records; relations retain contextual attestations. Full validates graph and issue
references at runtime. Source and batch assertions fail before delivery, and source faults fail the entire batch.

Recovery-capable sources expose pinned repeat queries with their original `mcp-r1` assertion. The other four families
expose safe fresh-read queries. Root `expect` asserts the composed `mcp-c1` identity; unavailable identity fails
explicitly. Composition has no `select`/`page`, and nested presentation controls are invalid; original source tools
retain their selective APIs. Reexecution can cost more than reading existing answers. Discovery publishes only the
input guide; the server validates every composition against its complete runtime output schema before delivery.
Size and utility claims require measured evidence.

All tools accept optional `repo` and `mode: "summary" | "details" | "full"`. Summary is the default and identifies findings and
limits; details adds recorded explanatory evidence and locations; full returns the complete redacted public fact
with a brief contextual JSON guide rather than repeating the family listing. All modes can be selected directly and
leave the query, snapshot, analysis coverage and traversal bounds unchanged. Replace the former `detail: "summary"`,
`detail: "full"` and `full: true` with `mode: "summary"`, `mode: "details"` and `mode: "full"`, respectively.
Strict input schemas reject those former controls, including `full: false`; no compatibility alias exists.
Older RFC-0014 and RFC-0018 descriptions of `detail: "full"` predate this migration; the contract in this section
supersedes those references.

Every successful result uses one text content block: presentation (summary/details findings, full navigation), followed
by one `result JSON: ` line containing the result fields. This is a server convention, not MCP-defined framing; the
whole block is not itself JSON. Clients can read the presentation and parse the final line. No `structuredContent` or
`outputSchema` is published. Consequently clients cannot obtain machine-readable output types from discovery or validate
responses against a server-advertised schema. The server validates the complete canonical result with its per-family Zod
schema before delivery, including selected responses. The exported full schemas remain available to local consumers.

Unselected summary/details result fields form a strict receipt with `mode`, `status`, `snapshot` and `reason` exactly for
unknown status. A SHA snapshot carries `repo`, `kind`, `sha`; a live snapshot carries `repo`, `kind`, `head`,
`stateId`. Full carries the fact and `mode`, plus applicable `repositoryRoots`, `freshness`, `resolution`, `live` and `workspaceLive`
response siblings. Workspace notices also appear in `_meta["ye-ast/workspace-live"]` in every mode, naming the repository and captured snapshot, with stale paths or a typed unavailable cause. A stale notice is also in `_meta["ye-ast/live"]`. Known full facts require a value; partial facts
also require cuts; unknown facts require a reason and no value. Full permits additive public fields. Per-family
Server runtime validation covers the common envelope, identities and principal containers/coordinates: entrypoints,
local or workspace impact/callers, importers, outline, workspace, and decisions. It does not duplicate every domain
union. Internal workspace repository reads and `repositorySources` are excluded from public output. Faults are
`isError` responses with redacted typed metadata under `_meta["ye-ast/fault"]`, not success receipts. Their text names
the kind and detail, adds a correction when the reported cause supports one, and ends with one `fault fields: ` JSON line holding the remaining public fault fields
(such as `reason`, `stage`, `expected`, `actual`, `cause`), because some clients drop `_meta` or deliver only text.

Continuation guidance is contextual across validation errors, faults and successful answers. It names only controls
supported by the current tool and the observed condition; a sufficient answer needs no next-step footer. Input
validation remains SDK validation and identifies the invalid field or control combination. Runtime fault guidance uses
typed causes and the query family, without inferring causes from message text. A composition source failure identifies
the failed query indices and presents the correction once, at its cause.

Presentation omissions count recorded data; analysis cuts describe missing coverage. Changing mode can recover recorded
evidence but cannot extend analysis. A cut kind alone does not identify a query budget: export and traversal limits can
share a kind. Parameter-specific advice requires evidence of the relevant limit's origin. Starting a new query after a
replay refusal does not retrieve the historical result; accepting a changed identity is an explicit caller choice.
Guidance is deterministic and does not suppress itself based on previous requests or session history.

Input discovery retains a root object with named properties and publishes the declared cross-field dependencies and
conditions using the installed SDK's JSON Schema 2020-12 dialect. Selection/page pairing, supported owner branches and
live/revision exclusions are checked against actual listed schemas as well as runtime validation. Explicitly opaque
replay and composition argument objects still rely on the original server validators for their internal structure.
These offline schema checks do not establish how every live client presents or interprets the constraints.

`ye_ast_entrypoints`, `ye_ast_callers`, and `ye_ast_impact` deliver recovery metadata once, in
the `recovery` result field in the text's result JSON line, for ordinary and selected responses in all modes. The presentation text points to that field rather than copying its JSON; unavailable
recovery states its reason.
Available metadata contains a versioned opaque result identity
and a normal query recipe. Entrypoints and callers pin the actual revision; impact pins the recorded merge base and
head. Live recipes request fresh live content and do not preserve historical working-tree content.

Callers and impact workspace recipes preserve the original workspace selectors and add a versioned declaration and
sorted actual snapshot vector. Clients echo that vector unchanged. Draft-7 validates its structure and rejects identical duplicate items; the server validates sorted order and unique repository IDs before invoking core. Only these two workspace consumers accept replay. Current membership and trust are
checked again; a changed context produces a redacted `result-changed` error at `workspace-replay` without a source
fact. Explicit external member paths may occur in recipes; internal mirror roots do not. Identity excludes machine
roots and presentation sidecars.

Recovery can instead be unavailable due to `deadline`, `unresolved-context`, or `redacted-context`.

Entrypoints accepts `entrypoint-evidence` by finding index and `cut-places` for the fact or entrypoints section.
Local callers accepts handler origins and fact cuts; local impact also accepts module origins. Workspace callers and
impact accept section handler origins, fact/section/indexed-read cuts and link reach evidence by ID; only impact accepts
section module origins. Other tools reject these controls. Handler selection names the exact owner and path/symbol/line;
module selection names owner, file and base/head side. Indexes are zero-based positions in the public source.

A lookup example merges the returned recovery recipe arguments with:

```json
{
  "select": { "kind": "handler-origins", "owner": { "kind": "local" },
    "handler": { "path": "src/controller.ts", "symbol": "Controller.run", "line": 12 } },
  "page": { "limit": 1 },
  "expect": "<recovery.resultIdentity>",
  "mode": "full"
}
```

`select` and `page` are paired and the limit is an explicit positive safe integer; no default size or byte cap is
imposed. Continue with `page.cursor` from `nextCursor`, the same selection and limit, and the original recipe.
`expect` may assert an unselected query; with a cursor it must match the cursor's identity. Every page reexecutes the
query and verifies source identity before delivering selected data. A changed source returns a typed failure. Live
replay captures current state; neither old live captures nor final answers are retained.

Selected full returns a projection with context and records; summary/details return projection receipts and render the
page in text. Full text guides navigation to the complete structured page and retains source limits, continuation and
the recovery recipe. Presentation may share identical context across associated rows, retaining literal selector
examples and the coordinates needed for each row. Source analysis and owner-grouped limits remain separate from page availability. An available zero total
is distinct from an unavailable source or owner, which retains its actual reason and evidence. These controls do not
change analysis scope or traversal bounds. The existing public redaction boundary applies to evidence and recipes;
internal source sidecars are not exposed.

Selected source text retains root context, read owners and analysis (including unknown reasons), and owner limits. Reads explicitly inherit matching snapshot, trust, declared scope and configuration; overrides are printed. Complete provenance catalogs remain in the `source` result field. Handler and module categories provide literal selector examples; each row keeps its named JSON coordinate, distinct span/depth/confidence and origin facts. Shared origin headings apply only to the stated following rows. Category recovery rules cover recorded counts/examples without adding presentation caps. Structured provenance, recovery and pagination contracts are unchanged.

Each success carries the presentation and result fields once. These are wire contracts, not measured model adoption.

Text-mode investigation footers appear only when recorded evidence or analysis limits need follow-up context. Owner
guidance appears for evidence crossing repository boundaries. Text modes locate snapshots in their repository listing
and retain literal base-module repository, file and revision coordinates; navigation through fact JSON paths belongs to
full mode. Category-specific omission counts and valid selector examples remain beside their records.

A selected page with `nextCursor` states how to continue beside its page metadata: repeat the recovery query with the
same selection and limit, pass `nextCursor` as `page.cursor`, and assert `recovery.resultIdentity` with `expect`. A final
page adds no continuation instruction. A partial analysis remains partial regardless of page availability. Parameter
advice for depth or hub cuts requires the owning walk's declared bound to match the recorded cut limit; a `caller-budget`
cut alone does not distinguish export limits from traversal expansions.

`scope` changes analysis coverage; excluded paths are unknown, not counted presentation omissions. `changed` selects
diff paths that seed impact while in-scope consumers elsewhere remain eligible. `budget` limits traversal work and
records cuts; a presentation omission counts recorded items and does not itself make the fact partial. A related
callers, outline or importers query answers a new question, not a filter over an existing impact. Importer links are
path-only; unresolved names are candidates, not verified dependencies. Workspace links keep their owners, basis,
confidence and direction; an outgoing destination is not automatically an affected consumer.

`live: true` requires the repository’s current trusted declaration and excludes revision/head for that repository. Workspace and decisions accept a top-level choice and member choices; callers and impact accept the same through `workspace`. Offline may coexist with workspace live selections and prevents committed remote refresh; a live member never refreshes its remote. Local-only live retains the exclusion of offline. Captures are not one atomic instant. A live replay captures again and compares head and stateId; it cannot retrieve an earlier working tree. The CLI and query protocol continue to expose their existing fact formats and are not governed
by MCP presentation mode.

## Shared MCP presentation ownership

Response shaping remains in the driving adapter, as defined by RFC-0001.

| Layer / concern | Owner | Production consumers | Rules retained by family |
|---|---|---|---|
| Request, redaction, receipt and recovery assembly | `src/mcp/server.ts` | Seven registered tools | Existing schemas and dispatch |
| Runtime fault guidance | `fault-presentation.ts`: `faultContext`, `renderFault` | Ordinary tools and composition source failures through `server.ts` | Closed public fault types, query-family controls, persisted versus explicit members, optional corrections and unchanged fault metadata |
| Ordinary status/scope/change/snapshot and selected provenance | `presentation-context.ts`: `renderFactHeader`, `renderFactStatus`, `renderSourceContext` | All seven ordinary tools; selected entrypoints/callers/impact through `render-evidence.ts` | Ordinary field eligibility; selected read owner, analysis and overrides |
| Exact context equality and complete UTF-8 layout scoring | `presentation-sharing.ts`: `shareExactContext`, `preferShorterText`, `blockBytes` | Family blocks in `render.ts` | Row membership, order, multiplicity, equality keys and tie rules |
| Category recovery wording | `presentation-guidance.ts`: `categoryRecovery` | Entry point profiles/guards; impact/callers origins; workspace names/unserved; decisions dependencies | Counts, eligible modes, category meaning, own guards, permissions |
| Literal typed selectors | `presentation-guidance.ts`: `literalSelection` | Handler/module origins and cut coordinates | `canSelect` checks actual recovery, owner and supported capabilities against evidence schemas |
| Family projections | `render.ts`, `render-evidence.ts` | All seven tools and selected pages | Association versus call chain, via/typeOnly/base/head, importer overlap, workspace exact equality, decision option associations |

Outline shares context and layout policy; it has no supported evidence selection or omitted inventory policy.
Importer path-omission wording remains in its family renderer; its placement is once per category. Handler, module and cut selector eligibility all consult the shared `canSelect` policy.
Presentation primitives never select domain records or infer query capabilities. Importer recovery is printed once
per response category while each target keeps its existing counts and chosen listing membership.

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
   `live` beside it, and writes one redacted stderr line with both, exit code unchanged. MCP summary/details open their text with a `stale:` line and retain a minimal receipt; full carries a redacted
   `live` sibling beside the fact and references it in the guide. Every mode carries the same redacted
   `{ stateId, changed }` in `_meta` under `ye-ast/live`.
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
