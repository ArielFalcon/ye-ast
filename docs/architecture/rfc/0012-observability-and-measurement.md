# RFC-0012: Observability and measurement

- Status: Draft, 2026-11-01 (revised after two independent reviews; steps 1 to 5 implemented)
- Related: [ADR-0001](../adr/0001-product-scope-and-priority.md), [ADR-0005](../adr/0005-runtime-topology-and-delivery-order.md),
  [ADR-0010](../adr/0010-trust-modes.md), [ADR-0011](../adr/0011-query-protocol-in-the-mvp.md),
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md), [ADR-0015](../adr/0015-index-reuse-by-content.md),
  [RFC-0001](0001-architecture-and-layers.md), [RFC-0002](0002-facts-contract.md), [RFC-0005](0005-transports.md),
  [RFC-0009](0009-extraction-from-qayaba.md), [RFC-0010](0010-impact-queries.md)

**In short:** ye-ast needs two records, not one stack of observability. The **fact** is deterministic, carries why the
engine asserted what it asserted, and is the only thing that reproduces. The **measurement record** is not
deterministic, carries what the fact cannot (wall clock, memory, store size, cache outcome) and belongs to the host,
never to the engine. A single line separates them: a signal reproducible from the same inputs goes inside the fact; a
signal that depends on the machine, the clock or the cache stays outside. OpenTelemetry, Tempo and Loki are the right
tool for the second record and the wrong tool for the first; qayaba's graders have no counterpart here because the
engine's truth is exact.

Line references in this document were verified against commit `8ba166d`, the commit this plan starts from. A commit and
a symbol age; a line number does not. Code is therefore cited as `file:line` at that commit next to the symbol that
survives it, and a document is cited by section, never by line.

## What existed at `8ba166d`

The starting point of this plan, verified before it was implemented: `npm run check` is green — typecheck, `arch:check` and 939 tests. The number is an observation
at that commit, not a promise: it moves with every commit, and a stale count discredits the section that carries it.

| Looked for | Result |
|---|---|
| a measurement harness or `scripts/` | absent |
| `performance.now()`, `Date.now()`, `durationMs` outside tests | zero occurrences |
| `core/ports/telemetry.port.ts` | absent; [RFC-0001](0001-architecture-and-layers.md) lists the port as planned |
| structured logging | only the error sink: `process.stderr.write` at `src/composition/process-host.ts:24` and `src/composition/main.ts:21` |
| a per-request measurement on any adapter | absent: `serve`, `mcp` and the CLI write facts to stdout and error lines to stderr, and nothing else |
| the cost a walk spent | absent: the walk computes it and drops it (see "Cost inside the fact") |

What a fact already carries, and is the whole foundation of this design
(`src/core/domain/shared/fact.ts`, `FactBase` at `:74`):

- `snapshot`: repository id and sha, or `live` with a state id (`SnapshotRef`, `:6`).
- `producer`: name and version. The version embeds the edge-policy digest (`src/composition/compose.ts:94`), so a
  policy change is a producer change.
- `inputs`: `trust`, `scope`, `content` and `config` digests, the declared scope in clear, and the version of every
  engine that took part (`FactInputs`, `:28`).
- `evidence`: `path:line` for each assertion.
- `status` and `cuts[]` with `kind`, `at` and `limit`.

**A digest identifies; it does not reveal.** The contract already shows the remedy: next to the scope digest travels
`declaredScope` in clear. The config digest therefore tells a consumer that *some* configuration produced the fact, not
which bounds. Anything a consumer must read — a budget, a profile — travels in clear beside its digest.

Measured, and worth recording as the first real evidence of the thesis: `map .` twice at `8ba166d` produced
byte-identical output (2 246 bytes, SHA-256 `a686cf4c…db72`) in 0.83 s and 0.92 s, including `tsx` start-up. The bytes
are reproducible at a commit; the digest is not reproducible across commits, because the snapshot moves. Scale beyond
this repository is a hypothesis, not a measurement.

## Two records, one line

| Record | Owner | Question | Deterministic |
|---|---|---|---|
| The fact | ye-ast | what was asserted, over which code, and why no more | yes, byte for byte |
| The measurement | the host | what it cost and how it behaved | no |

The line between them:

| Signal | Inside the fact | Why |
|---|---|---|
| `status`, `cuts[]`, `evidence`, `inputs` | already there | reproducible |
| the inputs of a walk, in clear beside their digest | **proposed** | reproducible, and a digest cannot be read |
| how many expansions a walk spent | **proposed** | computed today and discarded; deterministic |
| wall clock, resident memory, store bytes | outside | not reproducible |
| index outcome (`built`, `synced`, `reused`) and build time | outside | depends on the cache, not on the input |

A consequence worth stating: **the fact is the answer to "why did this run", once it can be read.** `snapshot` says over
which code, `inputs` says with which scope, content, configuration and engines, `cuts` says what could not be seen and
exactly where. A trace of spans would say less, and would not reproduce.

## Cost inside the fact

`walkImpact` already counts what it spends: `expansions` is incremented at `src/core/application/impact/walk.ts:79` and
the function returns only `{ reached, cuts }` (`:111`). The number is not missing from the machine; it is thrown away.

Two things are wrong with a `WalkCost` copied from qayaba's reader:

- `closureExpansions` and `closureBudget` have no counterpart here: `closure` appears zero times under `src/`. qayaba
  expands hubs in a second pass; this walk prunes them.
- `budget: number` is the wrong shape. `ImpactBudget` is three independent optional bounds — `depth`, `hubFanIn`,
  `expansions` (`src/core/domain/impact/impact-fact.ts:9`) — each applied separately at `walk.ts:75-77`.

What the fact does *not* answer today: `cuts[]` records the bound that stopped the walk, but a walk that ran to
completion records no spend at all, so "1 200 of 1 500" is unanswerable.

### The config travels in clear and covers every family

The current digest is already incomplete and already inconsistent. At `8ba166d`, `factBaseOf`
(`src/core/application/impact/impact-queries.ts:66`) digests `{ exportBudget: deps.budget ?? null, ...config }`
(`:76`), so `exportBudget` enters every impact family; `callers` adds `targets` (`:181`) and `importers` adds `files`
(`:231`). `map` digests `configFingerprint` (`src/core/application/entrypoints/entrypoint-queries.ts:72`), which is a
plain `JSON.stringify` of `MapConfig` (`src/core/domain/map/entrypoint-map.ts:30`, `:49`). Two shapes of the same idea
already diverge: impact always writes `exportBudget`, `map` omits it when unset, and neither is readable from the fact.

Proposal, one shape for the four producers:

```ts
// src/core/domain/shared/fact.ts
interface FactInputs {
  config: string;                  // the digest of declaredConfig, and of nothing else
  declaredConfig: DeclaredConfig;  // the values that digest stands for, in clear
  /** Where the index this fact read came from (ADR-0015 decision 3); absent when it read none. */
  origin?: IndexOrigin;
}

// the four members the four families use today
interface DeclaredConfig {
  walk?: { depth?: number; hubFanIn?: number; expansions?: number };
  targets?: readonly string[];
  files?: readonly string[];
  exportBudget?: { maxEntries: number; maxBytes: number };
}
```

- `config = digest.of(canonical(declaredConfig))`, where `canonical` sorts object keys, so the digest never depends on
  the order a literal happened to be written in.
- A member is present only when its family used it: `map` sets `exportBudget`; `impact.ofChange` sets `exportBudget`
  and `walk`; `impact.callers` adds `targets`; `impact.importers` sets `exportBudget` and `files`. Absent means
  unbounded, never unknown.
- A family that needs a fifth member adds it to `DeclaredConfig` and to its digest in the same change. A member added
  to the clear object without entering the digest is the defect this section exists to prevent.

### The spend

```ts
// src/core/domain/impact/impact-fact.ts
interface ImpactValue {
  cost: { expansionsUsed: number };  // symbols whose callers the walk followed
}
```

- **Required, not optional.** `0` when no walk ran: `impact.ofChange` and `impact.callers` each answer a complete or
  partial fact without a walk when `!needsGraph` (`impact-queries.ts:156` and `:202`). "Every impact fact carries a
  cost" is false as a rule; "every impact fact that has a value carries one" is the rule, and an `unknown` fact has no
  `value` at all (`fact.ts:93`).
- `walkImpact` returns it beside `reached` and `cuts`; the counter already exists at `walk.ts:79`.
- `expansionsUsed` counts expansions — symbols whose callers were followed — not reached nodes: a symbol stopped by
  `depth`, `hub` or `caller-budget` did not expand and does not count.

### One schema bump

`SCHEMA` (`fact.ts:4`) goes `0.1.0 → 0.2.0`; [RFC-0002](0002-facts-contract.md) rule 6 makes an added field a minor
change. The bump covers `declaredConfig`, `cost` and ADR-0015's `origin`, in one step. Two bumps would invalidate the
fixed layer twice for no reason: ADR-0015's consequences already say `FactInputs` gains the index origin for live
facts, and this RFC adds two more members to the same interface.

## How a real execution is measured

The host half of the two-record thesis had no channel. The MVP host is a process over stdio — `ye-ast serve` and
`ye-ast mcp`, both [RFC-0005](0005-transports.md) — and today it receives facts on stdout and error lines on stderr,
nothing that says what a call cost. That is the gap this section closes, and it is the difference between a design that
explains itself and a product that can be debugged where it runs.

**Who measures: the driving adapter, never the core.** The core reads no environment and knows no process
([AGENTS.md](../../../AGENTS.md)), and a clock is a process fact. `composition` therefore wraps the query families and
the index ports with a measurement decorator: it owns the clock, the stderr sink and the switch. No core module learns
that time exists.

**What it writes:** two kinds of line, both one JSON object on stderr, both through a closed registry — a field that
is not in the registry is not written, so the record cannot grow by accident.

A **query line**, one per completed request, measured around the call:

```json
{"ye_ast":{"event":"query","method":"impact.ofChange","duration_ms":2310,"outcome":"ok","status":"partial","cut_kinds":["hub","unresolved-link"],"bytes":18422,"schema":"0.2.0","trust":"untrusted","snapshot":{"kind":"sha","value":"8ba166d"}}}
```

| Field | Source |
|---|---|
| `event` | `query` |
| `method` | the query family method |
| `duration_ms` | the decorator's clock, around the call |
| `outcome` | `ok`, `threw`, or the fault code the call answered |
| `status`, `schema`, `trust` | copied from the fact, so a line and a fact join on them |
| `cut_kinds` | the distinct kinds that cut the fact, sorted; present only when it is `partial`, so the field answers "why partial" |
| `reason` | the reason of an `unknown` fact; present only then, so the field answers "why not" |
| `bytes` | the compact serialization of the answer; the CLI writes it indented, so this is a size, not the wire's exact length |
| `snapshot` | kind and value: the join key a host needs to correlate a reported bad answer |
| `cpu_ms` | the process CPU, user plus system, spent between the call and its answer; concurrent requests and indexer children are not separated out |
| `rss_bytes`, `heap_used_bytes` | the process memory when the answer settled, so a session's growth and its idle release can be read off the lines |

`cut_kinds` and `reason` are the two fields that make the line worth reading: `partial` without them says nothing about
which bound stopped the walk, and `unknown` without its reason is the least useful answer the engine can give.

An **index line**, one per build, measured around `graph.index` (`src/core/ports/code-graph.port.ts:127`):

```json
{"ye_ast":{"event":"index","outcome":"built","build_ms":1468,"store_bytes":7360741}}
```

A reused index writes no line. Reuse is the cheap case and its absence beside a query line is what says so; telling
the two apart would need a request-scoped context threaded through the whole call to survive concurrent requests, and
the event worth recording is the one that costs seconds. `store_bytes` is read once per build, never per request.

A live mirror writes the same line: `built` for its first or a recovering full build, `synced` for the incremental
sync of the paths that changed, so a session of edits never reads as a series of full builds.

A **stage line**, one per call of a reader a request runs over the whole snapshot (the export, opening the store,
entrypoint extraction, Angular declarations, relations, dynamic loads, module dependencies, Java imports, call sites):

```json
{"ye_ast":{"event":"stage","stage":"relations","outcome":"ok","start_ms":5230,"duration_ms":812}}
```

`start_ms` is when the call began, on the process monotonic clock (`performance.now()`, relative to the process start),
so stages that overlap, or that follow one another with a gap, can be told apart and the gap attributed. `outcome` is
`ok`, `threw`, or the fault a result answered. A stage line carries no request id: in the sequential use
of one agent it precedes its query line in order; under concurrent requests lines interleave and a host correlates them
by time only.

The stages also cover the live lifecycle, each port call `openLive` makes: `live-lock`, `live-read-state`,
`live-list` (the working-tree listing, both the refresh and the staleness re-list; `start_ms` tells them apart),
`live-discard`, `live-reconcile`, `live-write-state`, `live-materialize`, `live-prune`, `live-touch`,
`live-release` (the lock release), `live-staleness-compare`, and the retention sweep as `live-usage`,
`live-discard-idle` and `live-discard-debris`. `unresolved-references` is one read of the opened store's unresolved
references. The edge readers (`incomingEdges`, `outgoingEdges`, `symbolsInFiles`) are per-symbol calls, many per request,
and stay unmeasured.

A **cache line**, one per decision of the snapshot data cache ([ADR-0020](../adr/0020-host-budgeted-snapshot-memory-cache.md)), when
measurement is configured:

```json
{"ye_ast":{"event":"cache","outcome":"evicted","entry_bytes":182340,"retained_bytes":8412770,"start_ms":5231}}
```

`outcome` is `hit` or `miss` for a lookup, and for a store `admitted`, `evicted` (one line per entry the admission
displaced) or `oversize-skipped` (the entry alone exceeds the budget and is not kept). `entry_bytes` is the charge of
the entry concerned (key plus serialized payload) and is absent on a `miss`; `retained_bytes` is what the cache holds
after the decision. The key never appears: it names a repository state.

The entries of the cache are the sources and findings of a snapshot and, since
[ADR-0026](../adr/0026-snapshot-data-may-retain-reader-outputs.md), the serialized output of the relations and the
whole-universe module-dependencies readers, each its own entry. A served output has no line of its own: its lookup is a
`hit` and the reader's stage (`relations`, `module-dependencies`) is absent from that request.

An **index-cache line**, one per kept index the cache's retention removes
([ADR-0027](../adr/0027-retention-of-immutable-index-entries.md)), when measurement is configured:

```json
{"ye_ast":{"event":"index-cache","outcome":"discarded","entry_bytes":94371840,"retained_bytes":402653184,"start_ms":5231}}
```

`entry_bytes` is the logical bytes the removed index occupied and `retained_bytes` what the cache holds after the
removal. The key never appears. Retention controls disk growth only; a later query that needs the removed index builds
it again, and that build shows as an `index` line.

**Child CPU is not measured.** `process.cpuUsage()` covers only the ye-ast process, so `cpu_ms` excludes the git and
indexer children, and Node exposes neither `RUSAGE_CHILDREN` nor the resource usage of a `spawn`ed child. The cost of a
child shows in the wall-clock of the stage or index line around it (`export`, `built`, `synced`), which is the figure a
host can act on.

**What the line cannot tell.** A host that cancels and a deadline that elapses both reach the query family as one
aborted signal, so both read `outcome: "aborted"`; the elapsed `duration_ms` beside the deadline the host itself set is
what separates them. A `live` query may also write the `stale:` line [RFC-0005](0005-transports.md) "Live freshness"
defines, so two stderr lines can describe one answer. A measurement channel that throws never fails the query it
describes: the host may have closed stderr.

**What it must not carry:** paths, symbol names, the repository id, or any content. Cardinality and redaction both
forbid it, and the host already knows which repository it asked about. The redaction patterns apply to the line like
to any other egress ([RFC-0002](0002-facts-contract.md) rule 7).

**Where it is on:** `serve` and `mcp`, the two long-lived adapters, by default; the one-shot CLI writes it only with
`--measure`, which every query command accepts and `serve` and `mcp` keep refusing, since they take no arguments. stdout carries only protocol lines, which
`src/protocol/query-server.test.ts:441` already asserts and which this section does not relax. Under `untrusted` a
stderr line is a local pipe, never a network call ([ADR-0010](../adr/0010-trust-modes.md)).

**What it does not answer:** an answer already given. A `live` fact is not stored (`SnapshotRef` `live`, `fact.ts:6`)
and its state id expires at the next sync, so a host that reports a wrong answer a week later has the measurement line
and the join key, and must recompute with that same state before it can say more. The record says what a call cost and
how it ended; it does not recreate the graph. The limit is stated here because a production complaint meets it first.

## The fixed layer is not the measurement record

The fixed layer landed at `0b228fd`: `FixedLayerAdmin` writes `entrypoints.json` and `README.md` under `.ye-ast/`
([RFC-0005](0005-transports.md), "Fixed layer (MVP)"). It is a read cache for an agent's session start, excluded
through `.git/info/exclude` so no tracked file is edited, and [RFC-0005](0005-transports.md) "Pending decisions" leaves
committing it a configuration choice.

Two consequences an earlier draft missed:

**The layer's "unchanged" test ignores the schema.** `sameInputs`
(`src/core/application/fixed-layer/fixed-layer-admin.ts:51`) compares `inputs` and `producer` only, through
`JSON.stringify` (`:54`), and `schema` is not part of `FactInputs` — it lives on `FactBase` (`fact.ts:74`). Bumping
`SCHEMA` leaves a stored `entrypoints.json` stamped with the old version while the engine emits the new one, and
nothing validates `schema` on read. Today that is latent because the schema has not moved since the layer landed. The
first change that adds a field to every fact — which this RFC proposes — turns it into a silent wrong answer. **Fixing
`sameInputs` is a prerequisite of the change above, not a follow-up.**

**The comparison must be canonical.** `JSON.stringify` of two objects with identical values and a different key order
is two different strings, so the predicate can rewrite a layer that did not change. Compare a key-sorted form of
`[schema, inputs, producer]`, and keep `schema` in it.

**A committed baseline is a new egress boundary.** [RFC-0002](0002-facts-contract.md) rule 7 redacts on the way out of
the process. A baseline file that stores `snapshot.repo` and `path:line` evidence from another repository moves that
data into this repository, and nothing today says whether the patterns apply. The baseline must be written through the
same redaction as any other egress, and the rule must be stated where the baseline lives.

## Reproduction by input identity

The engine reproduces a fact from its inputs, not from a log:

```
(scope, content, config, engines)  →  the same fact, the same bytes
```

An earlier draft proposed `ye-ast verify` printing `identical (content 9dcac1…)`. That is the **input** digest: it
proves the inputs matched, not that the fact did. There is no digest of a fact anywhere in the tree, so `verify` as
written cannot detect the failure it promises — same inputs, different answer.

Two honest options:

1. **Record the fact digest** where a fact is recorded (`fixed-layer-admin` already writes the fact; a sibling digest
   costs one file), then `verify` compares it.
2. **Let the harness own it.** Its first assertion is already "identical bytes across two runs", and it captures the
   output, so it needs no new verb.

Recommendation: option 2 until a host asks to verify a fact it received. A verb with no consumer is a layer with no
owner, and today `verify` would depend on a storage decision this document has not settled yet.

Either way, the digest is taken at the commit the harness records. A new commit changes the snapshot and therefore the
bytes, which is why a baseline is keyed by `(commit, request)` and never by "the same request".

## Where a measurement record lives

| # | Where | Survives | Cost |
|---|---|---|---|
| a | CI artifact | per pipeline run | no repository noise; comparisons live in the CI UI |
| b | Committed baseline in ye-ast | forever, reviewable | grows; needs a pruning policy — qayaba uses this shape for `config/benchmarks/suite-snapshots/*.json` |
| c | The host's database | as long as the host keeps it | a store inside a library that must stay deterministic and read-only toward agents |
| d | Commit `.ye-ast/` | forever | regeneration noise in every consumer PR, and it contradicts why `install` excludes it |

Recommendation: **(a) for the full corpus and (b) for a minimal stable one** — two repositories, one pinned sha each,
`map` plus one `impact` — so a regression becomes a readable diff in a ye-ast PR. **(d) is rejected.**

A baseline that simply diffs bytes is red on every legitimate upgrade. It must declare what is compared and what is
normalized, before it is written:

| Field | In the comparison | Why |
|---|---|---|
| `snapshot.sha` | yes, as the row's identity | a different code state is a different row |
| `inputs.content`, `inputs.scope`, `inputs.config`, `inputs.declaredConfig` | yes | the fact's identity |
| `value`, `status`, `cuts` | yes | the answer under review |
| `producer.version` | **no** | it embeds the edge-policy digest (`compose.ts:94`), so every policy change would fail |
| `inputs.engines` | **no** | it changes with every dependency release |

The row's key cannot be `snapshot.repo`: that is the caller's `repoId` (`impact-queries.ts:66`), so two hosts name the
same repository differently and `<repo>@<sha>` both collides and duplicates. The corpus names each row itself, in a
manifest beside the baselines.

## What this design rejects

- **Log shipping to Loki from the engine.** A library does not open a network connection, and under `untrusted`
  [ADR-0010](../adr/0010-trust-modes.md) forbids one.
- **A wall clock inside a fact.** It breaks the determinism the product promises. The clock lives in the adapter that
  wraps the call, never in the core.
- **Free-form metric attributes.** `repo` and `sha` explode cardinality; they belong to the fact, not to a metric. Copy
  the closed registry idea of `platform/telemetry/instrument-table.ts` in qayaba (an undeclared instrument records
  nothing).
- **Graders over model output.** There is no model output. The grade is exact: `complete`, `partial` with cuts, or
  `unknown` with a reason. The quality question — did the engine see the truth — is answered by the parity diff
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) already requires, not by a judge.
- **Copying a shape from the reference implementation because it exists there.** qayaba's reader expands hub closures;
  this walk does not. A field without a consumer here is the symptom [AGENTS.md](../../../AGENTS.md) warns about.

## Implementation order

1. **`sameInputs` compares the schema, canonically.** Without it, step 2 leaves the fixed layer asserting a schema the
   engine no longer emits. Independent of everything else and testable today.
   - A stored fact with identical `inputs` and `producer` but an older `schema` yields `written`.
   - Identical values in a different key order yield `unchanged`.
   - The `not-written` reasons are unchanged.
2. **`declaredConfig`, `cost` and `origin`, in one bump to `0.2.0`.** Both impact families and both other producers.
   - An `unknown` fact has no `value` and therefore no `cost`.
   - `impact.ofChange` and `impact.callers` on a change that needs no graph answer `cost.expansionsUsed === 0`.
   - `callers` carries `declaredConfig.targets`, `importers` carries `files`, `map` carries `exportBudget`, and a walk
     carries `walk`.
   - `config` equals `digest.of(canonical(declaredConfig))`, pinned by one test.
   - Two consecutive `callers` runs are byte-identical.
   - A fixed layer written at `0.1.0` is rewritten at `0.2.0`.
3. **The measurement decorator and its stderr line**, in `composition`: on for `serve` and `mcp`, behind `--measure`
   for the CLI.
   - One parseable line per completed request, with exactly the registry's fields and no path, symbol or repository id.
   - stdout is unchanged; the existing protocol test still proves it.
   - `outcome` carries the fault code when the call fails.
   - A build writes its own line with `build_ms` and `store_bytes`; a reused index writes none.
   - `untrusted` changes nothing except that no network is involved.
4. **The measurement harness**, outside the product: per `(repo, rev)` run `map`, `impact`, `callers` and `importers`,
   record the facts, an observation (`wall_ms`, `max_rss`, `store_bytes`, index outcome and build time) and the
   normalized comparison above.
   - Two runs produce identical bytes.
   - The normalized diff against the previous baseline is empty for an unchanged commit.
5. **The transport harness**, a script: the real environment is a host over stdio, so this is the only step that
   exercises `serve` and `mcp`, and the only one that provokes the failures nobody should discover in production:
   missing store, schema outside range (`src/core/adapters/codegraph/store-version.ts:4`), incomplete index, deadline,
   `out-of-scope`, `no-extractor`.
   - Each failure is provoked and answered with the code [RFC-0005](0005-transports.md) assigns it.
6. **`verify`**, only with a real consumer and only against a recorded fact digest.
7. **The telemetry port**, only when a host embeds the library: minimal shape (`span`, `counter`, `histogram`,
   `gauge`, total, injected clock), two adapters (`noop` by default, `otel` injected by composition), closed attribute
   registry.

Steps 1 to 5 need no OpenTelemetry dependency and no new port.

## The parity oracle, for the record

The containment harness of [RFC-0010](0010-impact-queries.md) slice 1 already ran: `odd/tasks/impact-slice-1.md` marks
it done, and its log records 0 missing nodes on `spring-petclinic-microservices` and `jhipster-store` over 8 runs
under qayaba's budget, with every extra node tracing to a policy row.

Its known weakness is the oracle: it was a SQL port of qayaba's walk written in ye-ast, not qayaba's reader, because no
qayaba store existed on the machine. Both sides are pinned to the same store — binary `codegraph` 1.6.2 and SDK
`@colbymchenry/codegraph` 1.6.2, schema 11, extraction 27 (`src/core/adapters/codegraph/store-version.ts:4`) — so
pointing the real reader at a store the engine built is feasible today. The work is mapping seeds (`file::symbol`) to
the reader's node ids on that store. The reader's own path belongs to qayaba's repository and is not verifiable from
this one.

## Open questions

| # | Question | Answer |
|---|---|---|
| 1 | Does the bounds object travel as `inputs.declaredConfig` or inside `value.cost`? | Resolved: `inputs.declaredConfig`, mirroring `declaredScope` beside the scope digest. |
| 2 | Is the schema bump taken with the fixed layer already writing? | Resolved: yes, after step 1, and as a single `0.2.0` that also carries ADR-0015's origin. |
| 3 | CI artifact or committed baseline for the measurement record? | Resolved: both — CI for the full corpus, a named two-repository corpus as the reviewable baseline. |
| 4 | Does `verify` belong to the CLI, the protocol, or neither yet? | Neither yet: the harness owns the determinism assertion until a host asks to verify a received fact. |
| 5 | Does the transport harness ship as a test or as a script? | A script: it needs a real repository and a real store, and [AGENTS.md](../../../AGENTS.md) forbids a committed test that reads a fixed commit. |
| 6 | Is a telemetry port in scope before a host embeds the library? | No: `noop` is indistinguishable from absent, and a port with one caller is a layer with no consumer. |
| 7 | Does the index cache need its own measurement? | Yes, and step 3 provides it: `index.outcome`, `build_ms` and `store_bytes` are the data a later cap and eviction decision needs ([ADR-0015](../adr/0015-index-reuse-by-content.md)). |
| 8 | Is the measurement line on by default? | Resolved: on for `serve` and `mcp`, `--measure` for the one-shot CLI. |
| 9 | What does a measurement line cost per request? | Open, and cheap to answer once step 3 exists: measure the line and its stderr write against a no-op sink before deciding whether it stays on by default for very large answers. |

## Review brief

Hand-off prompt for an independent model asked to criticise this RFC. It is not part of the design contract.

> You are reviewing a design for observability and measurement in `ye-ast`, a deterministic code-truth engine. Read
> `AGENTS.md`, `docs/architecture/rfc/0002-facts-contract.md`, `docs/architecture/adr/0015-index-reuse-by-content.md`,
> this RFC, and the code it cites **at the commit named in its header**, in a clean checkout — not in a working tree
> someone else is editing.
>
> The project answers questions about a codebase with facts that carry evidence, the snapshot they were computed on,
> and whether they are complete. It is a library with CLI, stdio protocol (`ye-ast serve`) and stdio MCP entrypoints,
> extracted from a larger QA engine (`qayaba`) whose observability stack is OpenTelemetry with Tempo and Loki, plus
> graders and evals over model output.
>
> Answer in neutral Spanish (tuteo, no voseo). Support every claim with data: a `path:line` at that commit, or a
> measurement you ran or can reproduce. Mark anything unverified as a hypothesis. Do not implement, do not write files,
> do not commit. Read and run read-only commands only.
>
> Report at most 120 lines of Markdown, answering:
>
> 1. Where this RFC is wrong, with evidence.
> 2. What it is missing for the goal it names: being able to analyse a real execution of `ye-ast` in production and
>    find out why an answer came out wrong.
> 3. What is over-engineered, or solves a problem that does not exist yet.
> 4. Your implementation order, if it differs, and why.
> 5. Concrete risks in the real environment: a host calling over stdio, large repositories, several repositories, a
>    long-lived session, untrusted content, and the noise the instrumentation itself can add to the output.
>
> Be hard on the design, not on the author. If the two-record thesis is right, say so in one line and spend the rest on
> where the details fail.
