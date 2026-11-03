# ADR-0003: TypeScript as the implementation language

- Status: Accepted, 2026-10-29, owner; decision 1 corrected on 2026-10-30 (Node 24's LTS phase and the `node:sqlite`
  floor) and confirmed by the owner the same day (translated): "I confirm the corrections"
- Decision source: the owner, 2026-10-29 (translated): "If pure TS is best, then TS. I said it because the hooks and
  the interactions with the MCP must be very fast", after the evaluation of Rust, Go, C and a partial native core.
- Related: [ADR-0005](0005-runtime-topology-and-delivery-order.md), [ADR-0008](0008-typescript-compiler-api-source.md),
  [ADR-0011](0011-query-protocol-in-the-mvp.md)

**In short:** ye-ast is written in TypeScript on Node. Hook and MCP latency is a process-start problem, solved by a
long-lived process, not by a lower-level language. A native module is allowed only for a profiled, CPU-bound hot path
that belongs to ye-ast.

## Context

Measured on 2026-10-29 on an Apple M1 Max (10 cores, 32 GB), Node 24.11.0, over qayaba's repository (318k lines,
2.1k files, a 208 MB codegraph store). One run per row: an order of magnitude, not a benchmark.

| Operation | Time |
|---|---|
| `node -e ""` cold start | 30-50 ms |
| codegraph SDK `require` | 97-186 ms |
| Open the graph | 40-77 ms |
| Search one symbol | 5.5-46 ms (warm vs cold disk cache) |
| Callers at depth 3, warm process | p50 3 ms |
| Whole cold process | 0.51 s |
| codegraph CLI, one process per query | 0.7-1.8 s |
| Resident memory, one process with the graph open | 132 MB |

Estimate for an average 4-core, 16 GB machine with 5 agents on large repositories (hypothesis): a hook through a
long-lived process costs 100-250 ms with a Node client and 15-50 ms with a native client; without a long-lived
process, 1-3 s.

Node facts behind decision 1:

| Fact | Source |
|---|---|
| Node 24 is Maintenance LTS since 2026-10-20 and reaches end of life on 2028-04-30; Node 26 became Active LTS on 2026-10-28 | [Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) |
| The latest 24.x is 24.22.2 (2026-10-27); 24.11.0 dates from 2025-10-28 and misses the security releases 24.13.0, 24.14.1, 24.17.0, 24.18.1 and 24.22.1 | [Node.js release index](https://nodejs.org/dist/index.json) |
| `node:sqlite` was added in 22.5.0 behind `--experimental-sqlite` and is unflagged from 22.13.0 and 23.4.0; Node 24.11.0 prints `ExperimentalWarning: SQLite is an experimental feature` | [`node:sqlite` history](https://nodejs.org/docs/latest-v24.x/api/sqlite.html); local run, 2026-10-29 |
| codegraph uses `node:sqlite` (`DatabaseSync`) | codegraph 1.6.2 platform bundle `lib/dist/db/sqlite-adapter.js:31` |
| The first host requires Node 24 or later: qayaba declares `"node": ">=24"` and its agents image is `node:24-bookworm` | qayaba@4105c582 `package.json:8`, `agents/Dockerfile:3` |

Rejected alternatives:

| Option | Why not |
|---|---|
| Rust, Go or C rewrite | Loses the TypeScript type checker the extractors need and the in-process codegraph SDK; rewrites tested capabilities; C adds memory-unsafe parsing of untrusted repositories |
| Native core with TypeScript as connector | The hot part (graph queries) is already native SQLite; an FFI/IPC boundary and two toolchains for no measured gain |
| Go to reuse TypeScript 7's compiler | No stable programmatic API ([ADR-0008](0008-typescript-compiler-api-source.md)) |

## Decision

1. TypeScript on Node 24, the runtime of the first host.
   - `node:sqlite`, which codegraph needs, does not set the version: it is unflagged from Node 22.13.0 and 23.4.0. The
     first host does: qayaba requires Node `>=24`.
   - `.nvmrc` names the latest 24.x patch.
2. Speed comes from the topology: a long-lived process that keeps graphs open and caches warm
   ([ADR-0005](0005-runtime-topology-and-delivery-order.md)).
3. A native module (Rust through napi-rs) only for a hot path that a profile shows is CPU-bound and ours.
4. A native hook client (about 100 lines) only if a measured hook budget on target hardware requires it.

## Consequences

- Profiling comes before any native code.
- The entry point of a hook client process imports nothing heavy.
- In a client whose hooks can call an MCP tool (Claude Code's `mcp_tool` hooks), a hook runs inside the session's MCP
  server, a long-lived process, and spawns nothing ([ADR-0011](0011-query-protocol-in-the-mvp.md)). Decision 4
  applies only to the other clients.
- The runtime moves with the first host; Node 24 reaches end of life on 2028-04-30.
