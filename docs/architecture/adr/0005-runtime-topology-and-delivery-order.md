# ADR-0005: Runtime topology (A1) and delivery order

- Status: Accepted, 2026-10-29, owner; decisions 2 and 3 superseded by
  [ADR-0011](0011-query-protocol-in-the-mvp.md) on 2026-10-30
- Decision source: the owner, 2026-10-29 (translated):
  - on the two modes: "installation -> generates a fixed layer of resources that help the AI agent [...] to understand
    the whole context, and MCP mode -> serves as a tool for the agent to consume the information on demand"
  - "can't it have both? a fixed layer that is updated with hooks and the MCP to interact? each one with its own
    responsibility"
  - "A seems fine to me to start; all the good practices and optimizations to take into account for the daemon must be
    very well defined"
  - "for now variant A1, a bit slower but simpler and more predictable, without authentication [...] I think the
    friction does not pay off for the benefit"
  - "fine, MVP first and then hooks and daemon"
- Related: [RFC-0005](../rfc/0005-transports.md), [ADR-0003](0003-implementation-language.md),
  [ADR-0011](0011-query-protocol-in-the-mvp.md)

**In short:** one engine behind several entrypoints. The MVP ships the library, the CLI with its fixed layer, and an
MCP server over stdio. Hooks and a long-lived daemon come after, in topology A1: one daemon owns all state, and the MCP
and hook processes are stateless clients over a local socket. No MCP over HTTP, no local authentication.

## Context

- Analysis logic lives in the core; a transport only translates requests and shapes answers. Modules are code units,
  processes are deployment units: the MCP module is the same code whichever process runs it.
- An MCP server over stdio is spawned by the client once per session and lives as long as the session, so it needs no
  daemon to answer fast.
- A hook of type `command` is spawned per event and pays a cold start each time. Claude Code also has `mcp_tool` hooks,
  which "call a tool on a configured MCP server" and whose "text output is treated like command-hook stdout", and
  `http` hooks; `SessionStart` at launch skips `mcp_tool` hooks because MCP servers are not up yet
  ([hooks](https://code.claude.com/docs/en/hooks)). [ADR-0011](0011-query-protocol-in-the-mvp.md) draws the consequence
  for the daemon.
- Several sessions on one repository each open their own graph.
- codegraph 1.6.2 already ships this topology for its own MCP (one detached daemon per project, a stdio proxy, a
  version handshake with in-process fallback, a writer lock, an idle timeout, named pipes on Windows). That code serves
  codegraph's own facts, so ye-ast copies the design, not the process.

| Variant | Processes | Configuration in the agent | Cost |
|---|---|---|---|
| **A1** | one daemon + one small stdio adapter per session | `command: ye-ast mcp` | one extra process per session |
| A2 (rejected) | the daemon serves MCP over streamable HTTP | `url: http://localhost:PORT/mcp` | a port, local authentication, the daemon running first |

## Decision

1. **Doors, each with its own responsibility:**
   - fixed layer (`ye-ast init` / `ye-ast map`): a snapshot of facts written to disk, stamped with its snapshot;
   - MCP: on-demand queries;
   - hooks (later): keep the fixed layer fresh and inject minimal context on edits;
   - CLI: the same queries for scripts and CI.
2. **Delivery order:**

   | Step | Ships | Daemon |
   |---|---|---|
   | MVP | library, CLI (`map`, `init`), in-process stdio MCP | no |
   | Next | hooks + daemon in topology A1 | yes |

3. **A1 when the daemon arrives:** the daemon owns open graphs, caches, the watcher, the single writer per store and
   the fixed-layer writer; the stdio MCP adapter and the hook client talk to it over a Unix socket (named pipe on
   Windows). Each query family has an in-process and a socket implementation with the same contract
   ([RFC-0001](../rfc/0001-architecture-and-layers.md)).
4. **No MCP over HTTP and no local authentication.**
5. The daemon's good practices and optimizations are defined in [RFC-0005](../rfc/0005-transports.md) and must be
   complete and agreed before the daemon slice starts.

## Consequences

- The MVP's MCP keeps its state for the session; moving to the daemon changes the implementation of the query
  families, from in-process to socket, not the MCP module.
- Indexing never runs on the event loop that answers queries.
