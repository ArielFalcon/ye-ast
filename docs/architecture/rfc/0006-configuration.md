# RFC-0006: Configuration

- Status: Draft, 2026-10-29
- Related: [ADR-0010](../adr/0010-trust-modes.md), [RFC-0001](0001-architecture-and-layers.md),
  [RFC-0002](0002-facts-contract.md), [RFC-0003](0003-codegraph-integration.md), [RFC-0005](0005-transports.md),
  [RFC-0007](0007-extension-model.md), [RFC-0009](0009-extraction-from-qayaba.md)

**In short:** one workspace manifest describes what to analyse, one profile describes how to run, and both are data. The
manifest describes repositories only; the snapshot a call reads is a call parameter, and the profile restricts the kinds
it may name. Under `untrusted` the manifest and the profile come from the host, never from the repository. In qayaba the
manifest is generated from the app's existing configuration, so qayaba stays the single source of truth.

## Workspace manifest

| Field | Holds |
|---|---|
| `repos[]` | id, path or `remote` URL (the only source of a URL ye-ast refreshes from, [ADR-0016](../adr/0016-remote-refresh-under-trusted.md)), role (`frontend`, `backend`, `library`), and an optional line mapping (`qa` read as `staging`) |
| `lines` | the team's long-lived branches in order (`main`, `qa`, `develop`) and patterns (`release/*`), and whether same-named branches coordinate across repositories (off unless declared); read by the snapshot rule of [RFC-0011](0011-cross-repository-impact.md) |
| `languages[]`, `frameworks[]` | declared scope; anything else answers `out-of-scope` |
| `include`, `exclude` | globs over repository paths. Until the manifest is read they are a request parameter (`scope` of the query protocol, `--include` and `--exclude` of the CLI), empty by default; an empty `include` means every path and `exclude` wins ([RFC-0002](0002-facts-contract.md) rule 4). A glob is relative, normalized and `/`-separated (no leading `./` or `/`, no `.` or `..` segment, no trailing `/`, no backslash); anything else is a usage error or `invalid-params`. `*` and `**` never match a dot-prefixed segment, so `vendor/**` does not exclude `vendor/.hidden/a.js` |
| `tests` | test-file patterns when the language default does not fit |
| `contracts.openapi` | OpenAPI document locations |
| `boundaries[]` | stitcher profiles: call patterns (a team's wrappers and URL helpers), event patterns (custom event libraries), operation prefixes, and base URLs the snapshot lacks ([ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) rule 6) |

The manifest names no snapshot: the sha or `live` is a parameter of each call
([RFC-0001](0001-architecture-and-layers.md)). qayaba generates it from `config/apps/<app>.yaml` (its `services[]`,
`openapi` hint and `boundaries[]`), one way.

Where the manifest and the profile come from follows the trust mode ([ADR-0010](../adr/0010-trust-modes.md)).
Under `trusted` ye-ast honours the repository's own manifest. Under `untrusted` the manifest and the profile come from
the host, never from the repository, so the repository cannot raise a limit.

## Profile

| Field | Values |
|---|---|
| `trust` | `trusted`, `untrusted`. A host must declare it, with no default; the CLI and the MCP server run `untrusted` without a user declaration |
| `snapshot` | The kinds of snapshot a call may name: `sha`, `live`. `untrusted` allows `sha` only |
| `walk` | depth, hub fan-in, caller-query budget, each optional with no default ([RFC-0010](0010-impact-queries.md)); the score of a heuristic edge without one ([RFC-0003](0003-codegraph-integration.md)) |
| `budgets` | per-call deadline, answer token budget, fixed-layer size, and the export budget (entries listed, bytes written; [below](#export-budget)). A deadline is wall-clock and not deterministic: a fact it cuts is never stored ([RFC-0002](0002-facts-contract.md) rule 3). Count budgets are deterministic |
| `redaction` | extra patterns, applied at egress with the built-in ones; by-value secrets only in a process that already holds them (ye-ast's own when the host runs it in that zone, otherwise the host's, with the library's redaction module), passed at run time and never stored. Stored facts are not redacted; the fixed layer applies the patterns only ([RFC-0002](0002-facts-contract.md) rule 7) |
| `store` | location, disk cap, retention. `.ye-ast/` under `trusted`, the host's location under `untrusted`; codegraph's data directory is `.ye-ast-graph/` ([RFC-0003](0003-codegraph-integration.md)). Without a host the CLI keeps full indexes in a per-user cache, by content ([ADR-0015](../adr/0015-index-reuse-by-content.md), question 4); that cache is retained by last use: `unusedForMs: 14 days` and `maxBytes: 512 MiB` of logical bytes, never an entry an open reader holds, a host overriding both through `indexRetention` ([ADR-0027](../adr/0027-retention-of-immutable-index-entries.md)). The live mirrors under `.ye-ast-graph/live/` are retained: `keepScopes: 3`, `unusedForMs: 14 days`, `maxBytes: 512 MiB` of logical bytes for the whole tree, the scope being answered and any scope a live pid holds never discarded, last use from the state file's mtime ([RFC-0010](0010-impact-queries.md) "Retention") |
| `daemon` (later) | memory caps, idle timeout, indexer concurrency, socket directory |
| `hooks` (later) | enabled events, latency budget, maximum injected tokens |
| `telemetry` | off by default; dependency telemetry always off |

## Export budget

The export of a commit ([ADR-0010](../adr/0010-trust-modes.md) decision 2) runs in the host's process, over bytes a
repository author chose, so the host sets what one export may take; the repository cannot raise it. Two count budgets,
passed to the core as typed values by composition:

| Budget | Counts | When it runs out |
|---|---|---|
| `maxEntries` | Entries of the commit listed (`git ls-tree -r`), of every kind: files, symlinks, submodules | The listing stops at the first entry beyond the budget |
| `maxBytes` | Bytes of file content the export writes to its directory, decided from blob sizes in git's order | The export stops before the first selected file that does not fit |

Both are deterministic count budgets ([RFC-0002](0002-facts-contract.md) rule 3): the entries are taken in git's order
and the size of a blob is known before a byte of it is written. Exhaustion is a cut, never a silent truncation and never
a crash: the export answers `ok` with the stop, everything before it is exported, and the map is `partial` with a
`caller-budget` cut at the first path not taken and `limit` the budget that ran out. The budget is a profile value, so
it is part of `inputs.config`: the same commit under another budget is another fact.

Both budgets are decided by the listing, which reads blob sizes without their content, so the stop is the same whether or
not the files are then written ([ADR-0028](../adr/0028-lazy-export-materialization.md)). Besides the budget, the export holds one chunk of one blob and one listing record at a time, and reads from git only the
files the caller selects (for the map, the in-scope sources), so a large asset costs nothing and the listing's bytes
are never buffered whole.

The CLI sets no budget: the owner decided on 2026-10-30 (translated) that limits are not set on speculation, "the
priority is that it works well, and then optimize it", so a default waits until measurements on real repositories
justify one. Without a budget the export takes the whole commit and `inputs.config` records none. A host that embeds
the library passes its own values. Measurements so far, as the evidence a future default starts from:

| Case | Peak resident memory |
|---|---|
| A commit with a 600 MB blob outside the map's scope | 118 MB for the whole `map`, since unselected blobs are never read |
| Listing 250,000 entries of repeated subtrees, export alone | 389 MB (538 MB at 500,000; Node starts near 100 MB) |
| 250,000 selected `.java` entries, read and parsed | 862 MB |

Without a budget, a commit whose subtrees repeat (10^6 entries listed from 8 objects) still grows the listing's
bookkeeping with the entry count, about 1 KB per listed entry; that is the case a host bounds today with `maxEntries`.

## Snapshot data retained between requests

[ADR-0020](../adr/0020-host-budgeted-snapshot-memory-cache.md) permits an optional in-memory cache for completed SHA
source reads and entrypoint extraction; [ADR-0026](../adr/0026-snapshot-data-may-retain-reader-outputs.md) adds the
serialized relations and whole-universe module-dependency outputs, each as its own entry. [ADR-0021](../adr/0021-enable-snapshot-memory-cache-by-default.md) enables it by default with 32 MiB. A host overrides
the budget with `composeQueries({ snapshotCacheBytes })` (also accepted by `composeCli`); an explicit zero disables it. It is a composition setting, never a repository setting
or an agent tool argument. Zero or an invalid byte budget disables retention.

The budget counts UTF-8 bytes of retained keys and serialized data, including metadata. Admission evicts the
least-recently-used entries until they fit; an entry larger than the whole budget is not admitted. The count excludes
Node's heap bookkeeping, in-flight query data and transient serialization buffers. The cache stores serialized bytes,
so it holds no source objects, ASTs, temporary-directory paths, open stores or final facts.

Every query still resolves its revision, reads current trust and lists the commit afresh; it writes the listed files
into a fresh temporary directory only when a reader needs them ([ADR-0028](../adr/0028-lazy-export-materialization.md)):
a source read that retained data does not serve, or an index build. Reuse additionally checks the declared scope, trust, export budget and the path and blob of every written file, never the SHA or the repository ([ADR-0031](../adr/0031-snapshot-data-is-keyed-by-the-written-files.md)); the listing and cuts a request reports are always its own current ones.
Only successfully completed stages are retained, without shared in-flight work or cancellation. A live query consults it only after the mirror is reconciled, keyed by the content hashes of its listing and never by HEAD ([ADR-0030](../adr/0030-live-captures-use-the-snapshot-data-cache.md));
export-only queries do not restore source data. The lifetime is one composition; dropping it releases retention.
Cache settings affect cost only and are not fact inputs. The default allocates entries lazily; it reserves no memory up front and retains no export on disk.

## Versioning

The manifest and profile carry a schema version. Every fact records the inputs it depends on
([RFC-0002](0002-facts-contract.md)): the trust mode; digests of the declared scope (which a fact also states), of everything of the
content that decides the fact ([RFC-0002](0002-facts-contract.md) rule 5) and of the profile values that change results
(walk bounds and count budgets, the export budget included); and the engine versions (codegraph,
its schema and its extraction version, and the TypeScript API version). The envelope also records the facts schema and
the producer version. A stored fact is valid while all of them equal the current ones.

## Open questions

The owner accepted these recommendations on 2026-10-30 (translated): "yes, I accept them all".

| # | Question | Recommendation |
|---|---|---|
| 1 | File format: YAML, JSON or TypeScript config? | YAML for humans plus a JSON schema; hosts pass objects |
| 2 | Should ye-ast propose `boundaries[]` itself? | No LLM inside ye-ast; it exposes the deterministic profile scorer, and a host (qayaba's onboarding) may pair it with an LLM proposer |
| 3 | Where does the user-level trust record live and how does it identify a repository? | The platform's user configuration directory: `$XDG_CONFIG_HOME/ye-ast/`, falling back to `~/.config/ye-ast/` ([XDG Base Directory](https://specifications.freedesktop.org/basedir/latest/): "If $XDG_CONFIG_HOME is either not set or empty, a default equal to $HOME/.config should be used"), and `%APPDATA%\ye-ast\` on Windows; keyed by the repository root's real path, so every spelling of one directory is one repository. As built: composition resolves the directory from the environment (a relative `XDG_CONFIG_HOME` is ignored, as for the index cache, through one shared rule) and hands the core a typed value. The record is one file per repository, `repositories/<sha256 of the real path>.json`, holding `{"version": 1, "repository": "<real path>", "trust": "trusted" \| "untrusted"}`, written by a rename of a temporary file of the same directory, so two installs of different repositories share no file and cannot lose each other's entry; `ye-ast init` replaces the file of its repository. A read checks that the stored `repository` equals the real path. The directories are created with mode 0700 and the file with 0600, and a directory or file that is a symbolic link, belongs to another account or is open to the group or others is refused on read and on write, never repaired (the rule the index cache applies to its directory); on Windows these checks are skipped. A record that is not valid JSON, has another version, names another repository or holds a value that is not a mode is an `unreadable` fault: `install` fails with it and never overwrites the file, and a read answers it as a typed fault, so the fact runs `untrusted` and the CLI and the MCP server write one stderr line per process naming the fault. A case-insensitive file system that spells one directory two ways is not handled: the two spellings would be two records, which fails toward `untrusted` |
| 4 | Under `untrusted` with no host (the CLI or the MCP server on a developer's machine), who exports the snapshot, owns the store and supplies the scope? | The process acts as its own host: it exports the requested sha (HEAD by default) into a new temporary directory, which it deletes at exit. The index is not temporary: it lives in a persistent per-user cache, mode 0700, that holds only indexes ye-ast built from its own git exports, keyed by the staged content ([ADR-0015](../adr/0015-index-reuse-by-content.md)). Decided by the owner on 2026-11-01 ("Caché por usuario"). The directory is `$XDG_CACHE_HOME/ye-ast/`, falling back to `~/.cache/ye-ast/` when unset, empty or relative, and `%LOCALAPPDATA%\ye-ast\` on Windows; composition resolves it from the environment and hands the core a typed value, and the same cache serves `trusted` CLI calls, since an entry depends on content alone. An entry is immutable: it is built in a temporary directory inside the cache and published by an atomic rename, a concurrent build that loses keeps the existing one, and an entry that cannot be opened or fails the version check is rebuilt in its place. A host that hands over its own store keeps doing so. The scope comes from command-line flags, by default every language of the installed plugins. The repository's manifest is never read; using it needs `trusted` |
