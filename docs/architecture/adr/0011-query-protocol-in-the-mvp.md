# ADR-0011: One query protocol, served over stdio from the MVP

- Status: Accepted, 2026-10-30, owner
- Decision source: the owner, 2026-10-30 (translated): "both look fine to me", answering whether to accept this record
  and ADR-0010 as written. Raised while correcting the design records, which the owner asked for on 2026-10-29
  (translated): "fix every error, contradiction and design gap found; the decisions must be based on evidence". It
  supersedes decisions 2 and 3 of [ADR-0005](0005-runtime-topology-and-delivery-order.md).
- Related: [ADR-0005](0005-runtime-topology-and-delivery-order.md), [ADR-0006](0006-qayaba-graph-state-per-run.md),
  [ADR-0010](0010-trust-modes.md), [RFC-0001](../rfc/0001-architecture-and-layers.md),
  [RFC-0005](../rfc/0005-transports.md)

**In short:** the query families get one wire protocol in the MVP: JSON-RPC 2.0, one message per line, over any byte
stream. `ye-ast serve` speaks it over stdio for a host that runs ye-ast as a child process, which is how qayaba has to
run it; the daemon later speaks the same protocol over a Unix socket. Hooks do not wait for the daemon where the
client's hooks can call the session's MCP server.

## Context

- qayaba is the first consumer ([ADR-0001](0001-product-scope-and-priority.md)) and must run ye-ast out of process: its
  orchestrator holds secrets and must not parse repositories with LLM-written files, so ye-ast runs as a per-run child
  under the sandbox uid, "answering the orchestrator over a pipe" ([ADR-0006](0006-qayaba-graph-state-per-run.md)).
- [ADR-0005](0005-runtime-topology-and-delivery-order.md) gives the query families a wire implementation only with the
  daemon, after the MVP. Of the MVP's deliveries qayaba uses the library and `map`, not `install` and not the agent MCP
  (its agents never reach ye-ast, [ADR-0006](0006-qayaba-graph-state-per-run.md) decision 3).
- qayaba has no request channel to a sandboxed child: every codegraph call is a one-shot spawn, arguments in and stdout
  out (qayaba@4105c582 `qa-engine/src/shared-infrastructure/code-graph/codegraph-engine.ts:56-65`,
  `shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts:32-88`). Its only long-lived child is
  Chromium over file descriptors 3 and 4
  (`qa-engine/src/contexts/test-execution/infrastructure/agent-browser/chromium-sandbox.launcher.ts:61-67`); its launcher
  accepts a custom `stdio` (`shared-infrastructure/process-sandbox/exec-sandbox.ts:91`); loopback TCP is closed to the
  sandbox uid (qayaba@4105c582 `docs/execution-sandbox.md:197`).
- MCP's stdio binding is "newline-delimited messages" of UTF-8 JSON-RPC, and custom transports over a reliable byte
  stream "SHOULD reuse the stdio framing rather than defining a new one"
  ([MCP 2026-07-28, transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)).
- codegraph's daemon opens every connection with a one-line hello and requires the exact same version on both sides;
  on a mismatch the client falls back to direct mode (codegraph 1.6.2 `mcp/proxy.js`, `runProxy`).
- Claude Code hooks can be `mcp_tool`: they "call a tool on a configured MCP server" and "the tool's text output is
  treated like command-hook stdout"; `SessionStart` at launch skips them because MCP servers are not up yet
  ([hooks](https://code.claude.com/docs/en/hooks)). Such a hook spawns no process and needs no daemon.

| Option | For | Against |
|---|---|---|
| **A. ye-ast's own query protocol: JSON-RPC 2.0 with MCP's stdio framing; one method per query-family operation** | Mirrors the ports one to one; the daemon reuses it; the host adds no dependency; a JSON encoder escapes newlines, so the framing cannot break | ye-ast owns a small protocol and its version |
| B. MCP as the host protocol (facts as tool results) | One protocol for agents and hosts | Two tool sets on one server, since `SnapshotAdmin` must never reach an agent; results shaped for models; the host contract follows MCP's revisions (2026-07-28 dropped the initialize handshake of earlier ones); qayaba declares no MCP package today |
| C. Each host writes its own RPC around the library | Nothing to build in ye-ast | A second implementation of the same contract per host, which [ADR-0001](0001-product-scope-and-priority.md) rejects |
| D. Wait for the daemon, as [ADR-0005](0005-runtime-topology-and-delivery-order.md) stands | No change | The first consumer cannot integrate until after the MVP |

## Decision

1. The query families and `SnapshotAdmin` have one wire protocol: JSON-RPC 2.0, UTF-8, one message per line, over any
   reliable byte stream. A method is one query-family operation (for example `impact.callers`); a result is a fact
   ([RFC-0002](../rfc/0002-facts-contract.md)); an error carries a code from a closed set.
2. A connection opens with a one-line hello carrying the protocol version and the ye-ast version. On a mismatch a host
   client stops and says why; the MCP adapter and the hook client, once the daemon exists, answer in process and say
   so.
3. Cancellation is a notification naming the request, mapped to the call's `AbortSignal`; a deadline travels as a
   parameter.
4. A server started for a host (`ye-ast serve`, over stdio) exposes the query families and `SnapshotAdmin`; nothing an
   agent reaches exposes `SnapshotAdmin`. The host declares the trust mode in the hello
   ([ADR-0010](0010-trust-modes.md)).
5. Delivery order:

   | Step | Ships | Daemon |
   |---|---|---|
   | MVP | library; CLI (`map`, `init`, `serve`); the stdio query server; the in-process stdio MCP server | no |
   | Next | hooks; the daemon in topology A1, serving the same protocol over a Unix socket (named pipe on Windows) | yes |

6. A hook runs through the session's MCP server where the client can call MCP tools from hooks; a hook client process
   is used only where a client cannot. Hooks do not depend on the daemon. The session-start hook is a command that runs
   `ye-ast init`, which rewrites only the fixed-layer facts whose inputs changed; a hook that goes through the MCP
   server reaches only its read tools.
7. The protocol server and its client live in one driving adapter, `src/protocol/`. Composition wires it to stdio now
   and to the daemon's socket later, so neither the daemon nor the MCP adapter imports it.

## Consequences

- qayaba runs `ye-ast serve` once per run through its launcher with a custom `stdio`, as it already does for Chromium,
  and keeps one request channel for the whole run.
- The daemon slice adds lifecycle, sharing one graph between sessions and agents, the watcher and the single writer;
  hook latency is not its justification in clients with `mcp_tool` hooks.
- [ADR-0005](0005-runtime-topology-and-delivery-order.md) decision 2 (delivery order) and decision 3 (where the socket
  implementation lives) follow this record.

## Not decided here

- Method names, the error-code set and the hello's fields, which the first slice settles in
  [RFC-0005](../rfc/0005-transports.md).
- Which clients other than Claude Code can call an MCP tool from a hook (verified at the hooks slice).
