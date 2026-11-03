# ADR-0010: Two trust modes for repository content

- Status: Accepted, 2026-10-30, owner
- Decision source: the owner, 2026-10-29 (translated): "ye-ast must not have a 'qayaba mode'; at most an untrusted
  mode and a trusted mode, as the documentation says, to tell apart running in a harness with your own code from
  running on a server with secrets etc. Evaluate whether this is the best way to approach it", and "the decisions must
  be based on evidence". This record is that evaluation; the owner accepted it on 2026-10-30 (translated): "both look
  fine to me", answering whether to accept this record and ADR-0011 as written.
- Related: [ADR-0001](0001-product-scope-and-priority.md), [ADR-0006](0006-qayaba-graph-state-per-run.md),
  [ADR-0011](0011-query-protocol-in-the-mvp.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0006](../rfc/0006-configuration.md)

**In short:** ye-ast keeps exactly two modes, `trusted` and `untrusted`, and no mode per host. A mode describes the
repository content ye-ast reads, not the machine it runs on. A server with secrets is a property of the environment:
ye-ast is safe there in both modes because it needs no secret, makes no network request and runs no repository code,
and isolating its process is the host's job. [ADR-0016](0016-remote-refresh-under-trusted.md) later allows `trusted` to
refresh declared remotes into ye-ast's own mirrors. The mode is declared outside the repository; nothing inside it can
raise it.

## Context

"Harness with your own code" against "server with secrets" mixes three questions, and ye-ast controls only the first:

| Question | Decided by | Evidence |
|---|---|---|
| Who wrote the bytes ye-ast parses, and may ye-ast honour the configuration they carry? | the repository's content | qayaba's repositories belong to the company, yet runs add LLM-written files ([ADR-0006](0006-qayaba-graph-state-per-run.md)); qayaba indexes a tree exported from `git ls-tree` at the sha, regular files only, without `.gitignore` or `codegraph.json` (qayaba@4105c582 `qa-engine/src/shared-infrastructure/code-graph/codegraph-workspace.ts:44-115`) |
| What can the process reach: secrets, network, other tenants? | the host: identity, file permissions, network | qayaba's `graph` profile runs as the sandbox uid with no egress lease and an allowlisted environment that carries no secret (qayaba@4105c582 `qa-engine/src/shared-infrastructure/process-sandbox/exec-env.ts:12,55,99,107-122`, `exec-sandbox.ts:143-144`) |
| Who receives the facts, and which secrets must not reach them? | the host or the agent | qayaba redacts run secrets by value, then patterns, only in the orchestrator (qayaba@4105c582 `qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter.ts:1`, `shared-kernel/run-secret-redaction.ts:59-125`) |

Deciding the mode by deployment gives the wrong answer in ordinary cases:

1. A developer's agent reviewing a pull request from a fork, or a freshly cloned dependency, on the developer's own
   laptop: a harness, untrusted content.
2. A CI server indexing a reviewed main branch: a server with secrets, content its owners trust.
3. qayaba's server: the repositories are the company's own, but they hold LLM-written files, so ownership does not
   imply trust. The profile name `own-repo` encodes exactly that confusion.

Precedent attaches a binary trust state to the content, decides it outside the content and restricts by default:

- git refuses to parse the configuration of a repository owned by someone else, and its exception list
  `safe.directory` "is only respected in protected configuration ... This prevents untrusted repositories from
  tampering with this value" ([git `Documentation/config/safe.adoc`](https://raw.githubusercontent.com/git/git/master/Documentation/config/safe.adoc)).
- VS Code opens a new folder "in Restricted Mode", which disables "AI agents, terminal, tasks, debugging, workspace
  settings, and extensions", to prevent "automatic code execution of any code in your workspace"
  ([Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust)).

| Option | For | Against |
|---|---|---|
| A. A mode per host ("qayaba mode", "server mode") | Fits one host exactly | Rejected by [ADR-0001](0001-product-scope-and-priority.md); every new host would need a mode |
| B. Two modes named by deployment (harness = trusted, server = untrusted) | Easy to explain | Wrong in cases 1-3 above |
| **C. Two modes for the content, plus environment invariants that hold in both** | Each mode changes only what ye-ast honours; environment safety never depends on a flag | The host still isolates the process; the caller must declare the mode |
| D. Separate axes for content and environment (four combinations) | Explicit | With the invariants of C, the environment axis would change nothing ye-ast does |

## Decision

1. ye-ast has exactly two trust modes, `trusted` and `untrusted`. They describe the content of the analysed
   repository. There is no mode per host, deployment or machine.
2. Under `untrusted` ye-ast:
   - reads a snapshot exported from git at a sha: the regular files of the tree object, skipping symbolic links,
     submodules and special files, so `live` snapshots are not allowed;
   - honours no configuration from the repository: no ye-ast manifest, `.gitignore`, engine configuration
     (`codegraph.json`, `.codegraph/`) or pre-built index; the host passes the manifest;
   - opens only stores the host hands over, which ye-ast built from such an export
     ([ADR-0006](0006-qayaba-graph-state-per-run.md));
   - reads through the confined reader with the profile's limits, which the repository cannot raise.
3. Under `trusted` ye-ast reads the working tree (`live`) or a sha, honours the repository's ye-ast manifest and
   `.gitignore`, and follows symbolic links that stay inside the repository root.
4. Its network clause is superseded for `trusted` by [ADR-0016](0016-remote-refresh-under-trusted.md), which allows
   the refresh of declared remotes into ye-ast's own mirrors. In both modes ye-ast needs no secret to compute a fact,
   makes no network request (codegraph runs with
   `DO_NOT_TRACK=1`, which also turns its update check off; its CLI shim is never called; its platform bundle must
   resolve from `node_modules`), never executes repository code (no package scripts, builds or tests), writes only to
   its own store and fixed layer, and exposes no write to agents. Isolating the process (identity, file permissions,
   network) is the host's decision ([ADR-0006](0006-qayaba-graph-state-per-run.md) for qayaba).
5. Redaction runs where the secrets are. ye-ast always applies the redaction patterns to what it emits toward a host,
   and to every error line it prints. The success report `ye-ast init` writes for the user who runs it is not egress
   and carries the paths it names literally. By-value
   secrets are applied by the process that already holds them: ye-ast's own when a host runs it in that same zone,
   otherwise the host's process, using the same redaction module from the library. A host never passes secrets into a
   process it isolates from them.
6. The mode is declared outside the analysed repository: a host passes it through the library or the query protocol
   ([ADR-0011](0011-query-protocol-in-the-mvp.md)), with no default; a user declares it through `ye-ast init`, which
   writes a user-level record outside the repository, or with a command-line flag. Nothing inside the repository can
   raise the mode. Without a declaration the CLI and the MCP server run `untrusted`.
7. The profile values are `trusted` and `untrusted`; the names `own-repo` and `untrusted-repo` are retired.

## Consequences

- A host never configures "a server" in ye-ast: it isolates the process and declares the mode. qayaba declares
  `untrusted` for every run.
- The trust mode changes which files and which configuration a fact saw, so it is part of every fact's inputs
  ([RFC-0002](../rfc/0002-facts-contract.md)).
- A developer analysing a foreign checkout analyses its committed tree; uncommitted changes need `trusted`.
- The trust row of [ADR-0001](0001-product-scope-and-priority.md) decision 3 and decision 4 of
  [ADR-0006](0006-qayaba-graph-state-per-run.md) follow this record.

## Not decided here

- Where the user-level trust record lives on each platform and how it identifies a repository
  ([RFC-0006](../rfc/0006-configuration.md), open question).
- Who exports the snapshot, owns the store and supplies the scope when the CLI or the MCP server runs `untrusted`
  without a host ([RFC-0006](../rfc/0006-configuration.md), open question).
