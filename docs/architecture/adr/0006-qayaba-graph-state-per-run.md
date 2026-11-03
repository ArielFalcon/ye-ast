# ADR-0006: In qayaba, graph state lives per run

- Status: Accepted, 2026-10-29, owner; decisions 2 and 4 corrected on 2026-10-30 (index reuse per sha until `sync`
  parity is shown; under `untrusted`, only stores the host hands over) and confirmed by the owner the same day
  (translated): "I confirm the corrections"
- Decision source: the owner, 2026-10-29 (translated): "as you say it is not in the MVP, but for now I lean towards
  per-run execution", answering whether a long-lived ye-ast process on qayaba's server should run under a dedicated
  identity or graph state should stay per run.
- Related: [ADR-0001](0001-product-scope-and-priority.md), [ADR-0005](0005-runtime-topology-and-delivery-order.md),
  [ADR-0010](0010-trust-modes.md), [ADR-0011](0011-query-protocol-in-the-mvp.md),
  [RFC-0009](../rfc/0009-extraction-from-qayaba.md)

**In short:** on qayaba's server, ye-ast's graph process lives inside one run, under qayaba's sandbox, and dies with
the run. Indexes are still reused across runs through qayaba's store cache, by the codegraph version that built them in
full. A dedicated identity for a long-lived process is reconsidered only when the daemon exists and a measurement
justifies it.

## Context

qayaba separates processes by Unix identity: the orchestrator holds secrets; anything an LLM can influence (specs,
installs, lint, indexing) runs as the sandbox uid with a closed network. A process that outlives runs needs an
identity:

| Identity | Effect |
|---|---|
| Sandbox uid | Unsafe: run N's specs share the uid and could tamper with the store or socket, poisoning run N+1's facts. It also breaks the protection of qayaba's store cache (the sandbox uid cannot reach the data directory) and "the sandbox uid reads one mirror at a time" (qayaba@4105c582 `AGENTS.md:676`) |
| Orchestrator user | Unsafe: parses repositories holding LLM-written files with access to secrets |
| Dedicated uid or container | Warm indexes across runs; costs a new trust zone that must be configured and proven (file-boundary check, mirror sealing) |
| **Per run** | No new trust zone; loses only re-opening the graph and warming caches, tenths of a second to seconds against runs of 25-60 minutes |

qayaba's codegraph adapter deliberately keeps codegraph's own daemon unreachable
(qayaba@4105c582 `qa-engine/src/shared-infrastructure/code-graph/codegraph-engine.ts:1-6`).

qayaba's store cache today:

| Fact | Evidence (qayaba@4105c582) |
|---|---|
| One mutable store per (app, repository) at `<data>/code-graph/<app>/<repoKey>/{codegraph.db,meta.json,lock}` | `qa-engine/src/shared-infrastructure/code-graph/codegraph-store-cache.ts:32-34,57-78` |
| The store is synced to each run's sha and accepted on engine name, scope digest, engine version and pinned schema | `qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts:216-226` |
| No content hash and no seal; the only digest is a 16-hex digest of the scope | `qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts:156-159` |
| The sandbox uid cannot reach the data directory | `src/server/file-boundary.ts:43-45` |
| The store is published before agent code runs | `qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts:251-263` |
| The copy is strict and follows no links | `qa-engine/src/shared-infrastructure/code-graph/codegraph-store-cache.ts:217-287` |
| The main branch has one sandbox uid; per-lane uids exist only on the unmerged branches `feat/parallel-runs` and `pr2/slots` | `Dockerfile:126` |

Reusing an index across shas by `sync` is unproven: qayaba never asserts that `sync` equals a fresh build, and its
adapter tests replace the engine with a recorded store
(qayaba@4105c582 `qa-engine/test/shared-infrastructure/code-graph/codegraph-code-graph.adapter.test.ts:1-4`). In an
experiment (2026-10-29), fresh builds were identical across runs on a 29-file Angular repository (343 nodes, 562 edges),
with 1, 2 and 8 workers and with the native kernel on and off.

## Decision

1. On qayaba's server, one long-lived ye-ast graph process per run, launched by qayaba's execution launcher under the
   graph profile, answering the orchestrator over a pipe and ending with the run.
2. Superseded by [ADR-0015](0015-index-reuse-by-content.md). An index is reused only for the same (repository, sha, scope) and only by the codegraph version that built it in
   full. A sha's index is derived from another sha's by `sync` only after the parity harness shows, on real
   repositories, that `sync` equals a fresh build ([RFC-0003](../rfc/0003-codegraph-integration.md)); until then each
   sha is built in full. The host's store cache keeps the stores between runs, the role qayaba's cache plays today.
3. qayaba's agents never reach ye-ast directly; the orchestrator admits each query and binds it to the run's
   repositories.
4. Under `untrusted` ([ADR-0010](0010-trust-modes.md)) ye-ast opens only a store the host hands over and
   ye-ast built from a snapshot export, never a store found inside a repository (a `.codegraph/` inside a watched
   repository could be planted).

## Consequences

- The per-run child removes today's one-process-per-query cost without a new trust zone.
- Decision 2 differs from qayaba's cache today, which syncs one mutable store to each run's sha (Context).
- The pipe of decision 1 carries the query protocol of [ADR-0011](0011-query-protocol-in-the-mvp.md): the
  orchestrator runs `ye-ast serve` as the run's child and keeps one request channel for the whole run.
- Host requirement (hypothesis): within a run, the graph process and the specs share the sandbox uid, and the workspace
  store sits in a directory that uid can write (qayaba@4105c582
  `qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts:279-282`), so a spec could alter the
  store that later queries read. The host makes the store read-only to that uid before agent code runs.
- A future dedicated identity is a new ADR with a measurement, and extends qayaba's file-boundary proof.
