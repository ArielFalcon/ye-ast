# ADR-0157: One per-user daemon keeps the read query families warm for the CLI and the MCP server

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-17 (translated): "at install time the heavy indexing work is done in the background,
  so that later only what changes is reindexed and nothing is done on-the-fly", and "without sacrificing functionality
  and quality"; 2026-11-23 (translated): "apply all of this when the time comes; resolve the open decisions as you best
  understand them", under which the lead decided RFC-0040 D7 (§8): a minimal per-user daemon for the CLI and the MCP
  server, started on first use and by `init`, version handshake, one worker per repository, file lock unchanged.
  Amended 2026-11-23 by the lead after independent verification: "each installation gets its own daemon, keyed in the
  runtime directory by a short hash of the installation path; a different version at the SAME installation path still
  retires the old daemon after its in-flight requests (in-place upgrade)", and a pid file whose daemon does not answer
  is stale (decision 4).
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §6 phase 4, §8 D7;
  [RFC-0005](../rfc/0005-transports.md) "Daemon"; [RFC-0006](../rfc/0006-configuration.md);
  [ADR-0005](0005-runtime-topology-and-delivery-order.md) (decision 5), [ADR-0006](0006-qayaba-graph-state-per-run.md),
  [ADR-0010](0010-trust-modes.md), [ADR-0011](0011-query-protocol-in-the-mvp.md),
  [ADR-0016](0016-remote-refresh-under-trusted.md),
  [ADR-0152](0152-a-watcher-on-a-trusted-live-tree-only-triggers-the-launch-priming-refresh-ahead-of-the-next-query.md)

**In short:** `ye-ast daemon` is a supervisor, one per installation of ye-ast, that listens on a Unix socket in an
owner-only runtime directory and runs one worker process per repository and composition configuration. A worker holds one in-process composition of the read
query families, exactly the one the client would have built, so its snapshot cache, graph images, resident trees and
watcher outlive the client. The MCP server and the CLI query commands send each query to the worker of its repository
and get the port's result back unchanged; whenever the daemon is absent, of another version, retiring or gone
mid-request, the same call runs in process. The MCP server and `ye-ast init` start the daemon; `init` asks it to prime
the repository and returns at once.

## Context

- Phases 0-3 made a warm process fast (RFC-0040 §6), but every MCP session and every CLI command is a new process: its
  first call pays the composition, the graph image, the Java trees and the decoded tier again. The phase-4 target is the
  first call of a session at 0.3-0.6 s with the daemon up.
- RFC-0005 "Daemon" lists the practices the slice must define (lifecycle, versioning, isolation, security, socket path,
  degradation); ADR-0005 decision 5 requires them before the slice. codegraph 1.6.2's daemon is the reference design
  (`dist/mcp/daemon.d.ts`: detached, one-line hello with the exact version, pid lockfile created atomically, 300 s idle
  linger; `daemon-paths.d.ts`: a socket path over the platform limit falls back to a hashed path under the temporary
  directory). ye-ast reuses the design, never the code or the CLI shim.
- The query protocol of `ye-ast serve` (ADR-0011) is a host dialect: it accepts `untrusted` only, refuses `live`, and
  answers a fault as a redacted closed-set error whose detail may read `[path omitted]`. The MCP server and the CLI read
  trusted live trees, pass `onStale` callbacks and render each fault's own detail, so answers carried by that dialect
  would not be byte-equal to the in-process ones.
- CPU-bound work runs on the event loop of the process that holds the composition (a 0.9 s Java reading on
  shopizer/backend, ADR-0156); one shared event loop would serialize repositories.
- The composition options that change an answer differ by client: the MCP composes the index cache, the trust
  directory and the launch repository's build outputs; the CLI also composes the cache directory, which turns on the
  remote refresh of ADR-0016.

| Option | Verdict |
|---|---|
| The worker hosts whole MCP sessions and CLI runs; the client relays stdio bytes (codegraph's proxy) | Rejected: the CLI would be forwarded as argv that the supervisor must parse to find the repository, and it contradicts ADR-0005 decision 3 (each query family has an in-process and a socket implementation with the same contract) |
| Socket-backed query families on the host dialect of `serve` | Rejected: lossy faults, no `trusted`, no `live`, so answers would differ |
| Socket-backed query families on a lossless dialect with ADR-0011's framing, hello and cancellation | Chosen |
| One daemon process for every repository | Rejected: CPU-bound work of one repository blocks another (D7) |
| One worker per repository with the first client's options | Rejected: a second client with other build outputs or another cache would be answered with the first one's |
| One worker per repository and composition configuration | Chosen |

## Decision

1. **Who uses it.** The stdio MCP server and the CLI query commands (`map`, `impact`, `callers`, `importers`,
   `outline`, `trace`, `workspace`, `decisions`, `contract-consequences`). `ye-ast serve` stays in process (ADR-0006,
   ADR-0011 decisions 2 and 4). `init` keeps writing the fixed layer in its own process. Nothing reachable through the
   daemon is a write: a worker's dispatch table holds the read operations of the eight query families and `warm`, and
   no `SnapshotAdmin`, `FixedLayerAdmin` or `Install` exists in a worker.
2. **Processes.** `ye-ast daemon` runs the supervisor in the foreground; a client starts it detached (its own session,
   stdio ignored, unreferenced). The supervisor forks one worker per key `(repository, configuration)`, where the
   repository is the request's `repo` (a workspace request's bound `repo.path`) and the configuration is everything the
   client would have composed: the index cache directory, the cache directory, the trust directory, and the build outputs
   the client declares for that repository (none for a repository other than the MCP launch repository). The worker
   composes exactly those options (`composeQueries`), so a request is answered by the composition the client would have
   built, a client never reads another client's build outputs or cache, and trust is read from the client's own record
   directory on every request, never widened. Build outputs a request declares travel in the request itself. The worker
   inherits the supervisor's environment, which is that of the client that started it.
3. **Runtime directory.** `$XDG_RUNTIME_DIR/ye-ast` when `XDG_RUNTIME_DIR` is absolute, otherwise
   `<os.tmpdir()>/ye-ast-<uid>`. When a daemon's socket path (decision 4) is longer than the platform's socket path limit (103
   bytes on macOS, 107 on Linux), the directory is `/tmp/ye-ast-<uid>-<first 16 hex of the SHA-256 of the preferred
   directory>`, so two environments with different temporary directories still meet different daemons. The directory is
   created with mode 0700 and refused, never repaired, when it is a symbolic link, belongs to another account or is
   open to the group or others (the `--cache` rule, `privateToOwner`); a refused directory means no daemon, and the
   client answers in process. A client checks the directory again before every attach, so it never connects through
   one that stopped being private. It holds each installation's socket and pid file (decision 4). Windows and any platform without account ids or
   Unix sockets answer in process.
4. **One instance per user and installation.** Each directory ye-ast is installed in runs its own daemon, whose files
   are `daemon-<h>.sock` and `daemon-<h>.pid`, `<h>` the first 16 hex of the SHA-256 of the installation path: two
   checkouts or installs used by one account never retire each other's daemon and warm workers. The names have one
   length whatever the installation, so decision 3's socket path rule holds for all of them. The supervisor takes its
   pid file by creating a temporary file and hard-linking it into place (atomic, the mirror lock's mechanism) with
   `{pid, version}`. A holder is stale when its file is unreadable, its pid is dead, or its socket does not answer the
   hello within 2 s (a reused pid after a reboot, or a process the account cannot signal); a holder that has the lock
   and is about to listen answers within that bound. A stale file is re-read and removed only if unchanged, then taken
   again. A running holder means another daemon of this installation runs: the new process exits 0. Holding the lock,
   the supervisor removes any socket left behind (it can only be stale) and listens. On exit it removes the pid file if
   it still names its own pid, and the socket only when it did not already remove it at retirement or stop, so it never
   removes the socket of a successor that took over meanwhile.
5. **Handshake.** The supervisor writes one hello line on every connection,
   `{"jsonrpc":"2.0","method":"hello","params":{"protocol":"ye-ast-daemon","version":1,"producer":"<producer>"}}`, where
   the producer is the ye-ast version and the directory it is installed in, so two checkouts or installs of one version
   never answer for each other. A client reaches only its own installation's socket, so a producer that differs is the
   same installation at another version: an in-place upgrade.
   The client then sends one `attach` request with its own protocol, version and producer, the repository and the
   configuration, and writes nothing more until it is answered. A protocol or producer that differs from the
   daemon's is answered `version-mismatch` and starts the daemon's retirement (decision 9); the client answers in
   process and says so in one stderr line. Otherwise the supervisor hands the socket to the worker of the key (spawning
   it when absent) and the worker answers the `attach` request; from then on the connection is the worker's.
6. **The dialect after `attach`.** ADR-0011's framing (JSON-RPC 2.0, UTF-8, one message per line) and cancellation (a
   `cancel` notification naming the request aborts its signal). A method is `<family>.<operation>` of
   `entrypoints.map`, `impact.ofChange|callers|importers`, `outline.outline`, `trace.walk`, `workspace.outwardNames`,
   `workspaceImpact.callers|ofChange`, `contractConsequences.ofHypotheses|ofChange` and `decisions.decisions`, whose
   params are the port's request without its signal and callbacks, and whose result is the port's `Result` unchanged
   (value or typed fault): the client is ye-ast itself and redacts at its own egress as in process. A request that
   carried `onStale` says so, and the worker sends the notice as a `stale` notification before the answer. `warm`
   (`{repo, repoId}`) runs decision 8. Lines the worker's composition writes (measurement lines, the trust-record fault
   line) reach the client of the call that wrote them as `line` notifications; lines no call wrote (priming started by
   the watcher) reach every client of the worker that asked for measurement. A worker's measured query line carries
   `"served":"daemon"`, so a bench or a differential tells which process answered; an in-process line is unchanged. The
   host dialect of `serve` does not change.
7. **Fallback.** A client answers the same call in process (its own composition, built on first need) when the daemon
   is absent, refused, of another version or retiring, when the connection closes before the answer, or when the
   worker answers an internal error. An answer is never empty and never different: in-process and daemon answers are
   the same composition's. A connection lost mid-request is said in one stderr line; the next call attaches again,
   which restarts a crashed worker.
8. **Start and warm.** The MCP server starts the daemon at launch when it finds none, and again at most once a minute
   while it finds none; `ye-ast init` starts it once its install succeeded; a one-shot CLI command only uses a running
   one. `warm` runs the launch priming of the repository (`warmLive`, ADR-0152) once per `(repository, repoId)` for the
   worker's life, under the worker's own stop signal, so its watcher serves every later session; a second `warm`
   awaits the first. Under `untrusted` it follows the untrusted rules (no live read, no watcher). The MCP launch sends
   `warm` through the daemon when it attached, in process otherwise. `init` waits for the daemon to accept the `warm`
   (at most 10 s for a starting daemon) and returns without waiting for the priming; the worker does not stop it when
   the connection closes.
9. **Lifecycle.** A worker exits after 30 minutes with no attached connection, no call in flight and no `warm` running;
   the supervisor exits after 30 minutes with no worker and no attach pending. SIGTERM and SIGINT stop the supervisor cleanly: workers abort their calls and exit, the socket and pid file
   are removed, and clients answer in process. Retirement (decision 5) stops listening and removes the socket at once,
   answers new calls on existing connections `retiring`, lets the calls in flight finish, then exits; the new version's
   client starts its own daemon, which takes the lock once the retiring one no longer answers and serves while the old
   one finishes. A worker that
   crashes takes only its own connections down; the supervisor forgets it and the next `attach` of its key forks a new
   one.
10. **Idle period.** 30 minutes, a constant, not a size rule. codegraph lingers 300 s so back-to-back runs do not
    repay startup; ye-ast's warm state is worth more than its startup (a shopizer/backend first query costs seconds cold
    against hundreds of milliseconds warm, RFC-0040 §8), and agent sessions on one repository are separated by human
    review measured in minutes. The memory a worker holds stays bounded by the budgets of one process (ADR-0147,
    ADR-0124, ADR-0125); 30 minutes without a call returns it. RFC-0006's `daemon` profile can make it configurable when
    a host needs it.
11. **Opting out and isolation.** `YE_AST_DAEMON=off`, read by the composition root only, makes every client answer in
    process and start nothing: a harness compares the two paths with it, and a host that must leave no process behind
    (ADR-0006's reasoning) sets it. Tests inject the runtime directory, the spawn and the clock and never reach the
    user's runtime directory; harnesses give each run its own `TMPDIR` (and so its own runtime directory), run in process
    unless asked (`--daemon` on the latency bench and the warm differential, whose oracles stay in process), and stop
    the daemon whose pid their directory's pid file of the engine's installation names.

## Consequences

- The first call of an MCP session or a CLI command on a repository a worker holds is answered from resident state; a
  socket round trip and one JSON encoding of the answer are added to every daemon answer.
- Memory moves from short-lived processes to workers that live up to 30 minutes idle; two clients of one repository
  with different configurations hold two workers.
- The mirror lock stays: two daemons (different temporary directories), or a client in fallback, may write the same
  mirror.
- The core does not know the daemon: `src/daemon/` is a driving adapter and process host (sockets, lock, lifecycle,
  supervisor, workers), the dialect lives in `src/protocol/`, and composition wires both (ADR-0011 decision 7).

## Not decided here

Deferred against ADR-0005 decision 5 and RFC-0005 "Daemon": hooks and their priority queue, multi-user hosts, a
remote transport, Windows named pipes, a daemon-wide memory cap and eviction across workers, structured daemon logs
and OTLP, and the packed derived store (RFC-0040 D8).
