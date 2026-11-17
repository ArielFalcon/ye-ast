# RFC-0040: Resident snapshot generations, so an answer costs what depends on its question

- Status: Draft, 2026-11-17; decisions D1 to D5 approved by the owner on 2026-11-17 (translated): "I approve the
  decisions"; D6 to D8 open
- Related: ADR-0003, ADR-0005, ADR-0011, ADR-0015, ADR-0020, ADR-0021, ADR-0026, ADR-0028, ADR-0035, ADR-0040,
  ADR-0045, ADR-0077, ADR-0112, ADR-0121, RFC-0003, RFC-0005, RFC-0006, RFC-0010, RFC-0012, RFC-0037, RFC-0039

**In short:** a warm `callers` on a 1,210-file Java backend costs 4 to 5 s, and about 90 % of it depends on the
snapshot, not on the question. Each call re-reads the graph from SQLite one key at a time, re-parses the Java project,
decodes cached JSON again and proves freshness with work it already did. This RFC keeps the current state of a
repository resident as an immutable **generation**: the graph, the sources, the decoded per-file facts and the
assembled reading. The generation is built once and rebuilt only where its inputs changed, and freshness runs ahead of
the query. No fact changes; every step is proven byte-equal against `main`.

## 1. Targets

Owner, 2026-11-17 (translated):

> "Times must sit between a few hundred milliseconds and, for the most critical jobs, 3-5 s in specific cases; the p75
> should be below 1 s [...] without sacrificing functionality and quality."

> "When the project is installed, the heavy indexing work of everything is done in the background, so afterwards only
> what changes is reindexed and nothing is done on the fly."

- The targets hold in the **steady state**: a process is up, the index is built, and the tree may have been edited
  since.
- The first index of a repository with an empty cache has its own target. It runs in the background: priming at
  launch in phase 1, and the daemon started by `init` in phase 4 (§6).
- A Rust rewrite stays rejected (ADR-0003). A napi-rs module is allowed only for a profiled CPU-bound hot path of
  ours, and no profile below shows one.

## 2. Where the time goes (measured 2026-11-17, `main` `b87996785`, Apple M1 Max)

All rows are confirmed by two independent profiling passes: stdio MCP stage lines, CPU profiles, `node:sqlite`
statement counters, and a bulk read of the stores. The repositories are the corpus' Java backend (1,210 Java files;
26,582 nodes, 57,904 edges, 28,898 unresolved references) and an Angular frontend of 707 indexed files.

| Mechanism | Evidence | Cost per warm call |
|---|---|---|
| M1. The graph is read through SQL one key at a time and never kept | `codegraph.adapter.ts:293-323` forwards to SDK batch methods that `prepare` per call. A `callers` issues 30,020 `prepare` and 32,541 `SELECT` returning 335,986 rows, about 4 times the graph. A bulk read of the whole store takes 250-430 ms once | `callers` 1.0-2.0 s (39-42 %); `importers` 0.58 s |
| M2. Every Java reader outside recorded reads parses the whole project per query | trees are freed at the end of a read (`java-parser.adapter.ts:49-80`, ADR-0040). `rootOrigins` (`java-name-bindings.adapter.ts:67-90`), Java imports (`java-imports.adapter.ts:23,39-47`, a `WeakMap` keyed by a new array), call sites (`java-call-sites.adapter.ts:32-60`), declared types, root bindings, dispatch targets, data effects. `createJavaProject` runs 2-4 times per query | parse 0.39-0.45 s in every family; call sites 1.1-1.3 s per `trace`; `rootOrigins` 0.55-0.80 s |
| M3. The memory cache stores bytes and thrashes | `snapshot-data-cache.ts:82-110` runs `JSON.parse` on every hit. Keys are `sha256(canonicalJson(...))` over contents (`derived-facts.ts:35-41`, `trace-queries.ts:185`, `java-project.ts:85-96`). The budget is 32 MiB (`compose.ts:99`) against a working set of 106-125 MB | 0.23-0.33 s of serde and keys. A mixed session doubles `callers` (3.1 s to 6.7 s, 2,071 evictions) |
| M4. Whole-repository passes where a lookup would do | `implementedContractsOf` over every method (`implemented-contracts.ts:13`). `alignRecords` is O(records × calls) per file (`reconciled-calls.ts:255-277`) | 0.26-0.33 s alignment plus navigation 0.18-0.23 s |
| M5. A live store has no identity | `retained` exists only with an index digest (`base-reading.ts:305`). Index-dependent facts are recomputed on every live query (reconciled calls for 242 files instead of 49) | Part of the 1.1 s between live `callers` (4.1 s) and the same query at a revision (3.0 s). That gap is about 329 ms of alignment, removed by M4's repair, plus about 470 ms of SQL, removed by the graph image. What a live digest adds beyond both is unmeasured |
| M6. The live floor | two listings, two `lstat` sweeps, a retention sweep and two store opens per call (`live-tree.ts:74,126,131,138,185,223`); HEAD is resolved twice (`head-reading.ts:103,158`) | 200-250 ms on every live call; 80-100 ms at a revision (`export` and `store-open`) |
| M7. Sync is a child process per call | `codegraph.adapter.ts:167-185`, `sync-mirror.child.ts` | 0.98-1.13 s per edited call; 0.47-0.52 s in a process that stays up |
| M8. The lock covers the answer | exclusive mirror lock from refresh to answer, with a 50 ms poll (`live-tree.ts:103-119`, `live-mirror.adapter.ts:25,262`) | 3 servers give the throughput of 1; 62 % of wall time waiting (burst run, `99687a70b`) |
| M9. Whole-listing stages after any edit | Angular metadata and relations, TypeScript entrypoints (`prepared-snapshot.ts:64`) | 1.1-1.6 s on the frontend after one edit |

What is not the problem: MCP rendering, redaction and answer files cost 3-58 ms per call.

## 3. Design

### 3.1 The generation

A generation is an immutable value: the snapshot identity, the listing, the sources, the graph image, and later the
trees. It has two identities:
- **Content identity**: the `stateId` for live or the content fingerprint for a sha. It is the same value the fact
  records and it keys everything derived from sources alone.
- **Store generation**: for live, a token the refresh writes to the mirror state on **every** committed build or sync.
  It keys everything that reads the index. The token is needed because `stateId` is a digest of the source content
  (`live-tree.ts:196`). A synthesized request rebuilds the store in full at the same `stateId` (`live-tree.ts:242`,
  `:278-284`), and ADR-0015 records that a synced store and a full build of the same content differ in their graph.
  For a sha, the store generation is the kept index's content key. The token never reaches a disk key (open question
  2).

A generation is built beside the current one and published by swapping one reference. A query **pins** the
generation it proved current, reads nothing else, and releases it. A generation that has no pin and has a successor
is retired: its native trees are freed exactly once.

Derived values are not owned by a generation. They live in the content-keyed tier and are shared by every generation
whose inputs match, which is what makes an edit cost the change. Nothing in memory is named by a counter that reaches
a fact.

### 3.2 Layers

| Layer | Content | Where | Key | Rebuilt when |
|---|---|---|---|---|
| Graph image (D1) | nodes by id, file and name; edges by source and target, grouped by kind; unresolved references by file. Pre-sorted in the port's orders (`codegraph.adapter.ts:355-375`), frozen | Memory, in the codegraph adapter | Kept index: its content key (ADR-0015). Live: store identity plus committed store generation | Another key. Always a full re-read, never a patch: a sync re-synthesizes edges anywhere |
| Decoded tier (D2) | Values after their one serialization round trip (ADR-0026 decision 7), deep-frozen | Memory | Today's keys, with the git blob id as file identity instead of `sha256(content)`, trust kept | Never: content-addressed. Evicted by budget |
| Recorded-read verification | `verifiedAt` and `changedAt` per kept derivation (salsa red-green, early cutoff) | Memory | The derivation key; `verifiedAt` is the fingerprint of the declaration index that answered (its sources **and** its inputs such as `unreadJvm`, `java-kept-reads.ts:62`), never a per-generation counter, because families ask the index over different paths (`trace-queries.ts:141`) | A question whose answer's `changedAt` is newer than `verifiedAt` |
| Per-file Java readers | the readers of M2, kept per file by recorded reads (RFC-0039 pattern) | Memory and the ADR-0077 store | Slot, reader version, path, content identity, questions and answers | A recorded answer differs |
| Stage outputs of the assembled reading | the **plain frozen outputs** of each ADR-0045 stage. Never the `BaseReading` object: it closes over the request's signal, the parse hold and the store (`base-reading.ts:246,303,312,332`), and the hold is released after each query (`head-reading.ts:123`) | Memory | Per stage: content identity or store generation (whichever it reads), scope, trust, configuration, validated build-output identities, narrowing | New generation; stages rebuilt lazily over green parts |
| Answer memo (D3) | the fact before redaction and rendering | Memory only | Family, canonical request, content identity, store generation, `head`, trust, engine versions, schema, and the **validated identities** of declared build outputs (content and availability, as `type-bindings.adapter.ts:115-117` re-checks them), never only their declared paths | Dropped with its generation |

Two rules bind the table:
- Nothing cut by a deadline or an abort is admitted anywhere. This is today's `keepExtraction` rule
  (`prepared-snapshot.ts:71-73`), with one test per new tier.
- Every memory key keeps the trust mode. The disk key stays content plus reader version (ADR-0077).

### 3.3 Freshness: trigger, proof, refresh

1. **Trigger.** A watcher (trusted only), the launch, or a query. A trigger only says "look".
2. **Proof**, on every query: one listing and one stat sweep against the manifest. The proof is never cached and a
   watcher never replaces it. Equal means the pinned generation is current. Different means the changed paths are the
   refresh's input.
3. **Refresh and pin**, one operation, single flight per repository and scope, under the mirror lock:
   - copy and hash the changed paths;
   - sync in a long-lived worker;
   - commit the `stateId` and a new store generation;
   - load the graph image and the sources of that committed state coherently;
   - pin the result.
4. **Next generation**, after the lock is released: derive the changed files, mark red what asked a question whose
   answer changed, and rebuild lazily.
5. **After the answer:** the stale notice of RFC-0005, unchanged.

The lock covers only step 3 (D4). The image and the sources are loaded inside it, because the three statements of a
bulk read must see one committed store. After that, a pinned reader touches neither the store nor the mirror files, so
a later sync cannot change what it reads. Derivation runs outside the lock.

### 3.4 A query that finds the index behind

| Situation | Behaviour |
|---|---|
| Proof equal, generation resident | Answer |
| Proof differs | Join the refresh, then answer on the new generation |
| Index current, background derivation unfinished | Compute what the query needs, with priority |
| Refresh not done within the call's deadline, or no index yet | `unknown` with `index-unavailable` (RFC-0005, unchanged) |
| Tree moves while answering | Answer plus the stale notice (RFC-0005, unchanged) |

An older generation is never served as current. No answer becomes partial because the index lags.

### 3.5 Trust modes

| | `trusted`, live | `untrusted` and every sha snapshot |
|---|---|---|
| Identity | manifest digest per file, `stateId` | git blob id per file, content fingerprint |
| Trigger | watcher on the tree, `.git/HEAD`, `.git/index` | the requested sha; nothing reads the working tree |
| Index | sync of changed paths | full build per content, kept by content |
| Memory | keyed with the trust; a trust-record change drops that repository's generations | same |
| Network | ADR-0016 refresh only | none |

No repository file configures the watcher, the worker or the pipeline, and none of them runs repository code.

### 3.6 Demand-driven reads (D5)

Once the image exists, inverted indexes answer by lookup what a scan answers today: name to unresolved references,
type to supertype closure, method to the declarations it implements. `callers` of X asks which references may name X.
Rule: every lookup returns a **superset** of what the scan returned, so completeness is unchanged. A property test
asserts index ⊇ scan on every corpus repository. This amends ADR-0045, under which one reading feeds every stage.

## 4. Proof the corpus gate does not give

The gate runs each query in a new process at a sha, so it never sees a warm cache, a generation change or a watcher.
Every unit that touches a cache or a generation also passes the **warm differential**:

1. Replay first-parent commits of each corpus repository through the live mirror in one long-lived process, and the
   same commits as sha queries (the untrusted path, which qayaba uses first).
2. Between commits, apply and revert single-file edits: a body edit, a signature edit, a new file, a deletion, a
   rename, and a file that stops parsing and parses again. Also exercise:
   - a commit that does not change the tree;
   - a synthesized query (`importers`) after an edit that leaves a file unparsed;
   - a declared build output installed at the same path after a run without it;
   - a change of the trust record.
3. At each step, run the gate's queries in the long-lived process and in a **cold oracle**: a new process with empty
   memory, a new derived-fact store and a new index cache. The oracle shares only the raw inputs (the mirror content,
   or the sha). It must not share the disk store: `ofReads` accepts a persisted entry whose recorded questions still
   hold (`derived-facts.ts:96-108`), so a shared store would hide a dropped recorded read in both processes.
4. The answers must be byte-equal. A difference is a blocker; its reproduction is the step and the query.
5. The long-lived process reports its RSS after each step. The RSS slope over 200 edits is part of the result and
   must not rise between units.

The differential lives under `scripts/`, reads the manifest from outside the repository, and runs once per integration
with the gate. It answers RFC-0039 open question 6.

## 5. Regression traps and their guards

| Trap | Guard |
|---|---|
| A consumer mutates a shared value: an in-place `sort` or `push`, or `javaCallSitesOf` writing `diagnostic`, `propagatedThrough` or `column` (`java-call-sites.adapter.ts:45-58`) | Freeze every admitted value. The suite and the gate run with freezing on, so a mutation throws |
| The image answers in another order, de-duplicates differently, or caps a result | Method-by-method conformance of the image against the SDK reader over every corpus store, before any consumer switches |
| A live store is mutated in place by a sync, or rebuilt at the same `stateId` | Key the image by the committed store generation; load it under the lock; refuse it while `pending` is not empty |
| A held SQLite handle answers from the SDK's node cache after another process synced (the store is WAL, so the file's identity need not change) | No store handle outlives the operation that opened it, except the image's own load; the floor reuses the reader the existence check opened |
| A long-lived sync worker keeps SDK caches while another process syncs the same store | The worker reopens on a foreign store generation; a two-process test; chained syncs through one worker compared with a fresh build |
| A typed stage or a memo hit skips the content re-check of declared build outputs | Keys carry validated build-output identities; a test installs a dependency at the same declared path |
| A kept stage retains a request-bound reader, parse hold or signal | Only plain frozen outputs are kept; a test runs a second query with other targets after the first released its hold |
| A watcher misses or coalesces an event | The watcher is never the proof; a test runs with the watcher silenced |
| A half-built generation is visible | Build beside, publish by one swap, pin before reading |
| A memo key misses an input | A fitness test enumerates the request fields against the key builder |
| Memory grows: RSS already reaches 2.2 GB steady and 3.1 GB after twelve edits on the Java backend; WASM memory never shrinks | A byte charge per layer, eviction that frees natives, a 200-edit leak test, and RSS in the bench |
| Trust-mode poisoning | Trust in every memory key; the disk rule is restated in each ADR |
| A 0.3 s graph read blocks the event loop and delays cancellation | Read in a worker or yield between chunks; a cancellation test during the pipeline |
| Stage lines disappear and the harness reads zero as fast | The bench asserts the presence of each stage line; RFC-0012 is updated with each unit |

## 6. Phases and forecast

The units are tracked outside the repository (`odd/tasks/latency-program.md`). All figures are estimates; the bench of
phase 0 replaces them with measurements.

| Phase | Content | Java backend `callers` unchanged | After an edit, then idle | Equal mix p50 / p75 / p95 |
|---|---|---|---|---|
| Today | | 4.1-5.0 s | 7.0 s | 2.4 / 4.1 / 6.5 s |
| 0 | Bench and warm differential | | | |
| 1 | Floor, sync worker, graph image (kept and live), alignment repairs, Java whole-project readers by recorded reads (`keptByFile` already exists, `java-kept-reads.ts:60-91`), default budget sized from the measured working set, launch priming, one index per content | 1.4-1.8 s | 4.0-4.3 s | about 0.9 / 1.6 / 4.0 s |
| 2 | Decoded tier, working-set floor, red-green verification, resident stage outputs, answer memo, lock scope | 0.4-0.7 s | 2.5-3.5 s | about 0.4 / 0.8 / 3.0 s |
| 3 | Refresh ahead of the query, per-file TypeScript and Angular splits, demand-driven reads, resident trees (D6) | 0.25-0.4 s | 0.3-0.6 s | about 0.2 / 0.4 / 1.0-1.5 s |
| 4 | Daemon started by `init` and packed derived store (D7, D8) | same | same | first call of a session 0.3-0.6 s with the daemon up |

The p95 stays near the after-edit cost until phase 3 moves the sync and the re-derivation off the query path. Before
phase 3, the after-edit call is the critical case that the owner allows 3-5 s.

What remains in the steady state:
- 30-60 ms of freshness proof per live call.
- 0.47 s of codegraph sync per batch of edits. It is engine-internal and stays off the query path unless a call
  races its own edit (1-2 s).
- 50-200 ms of walk and render that depend on the question.
- The first index of a repository, which is a background job (a 2.6-4.7 s codegraph build and about 15 s of CPU of
  per-file derivations on the Java backend).

## 7. Decisions

| # | Decision | Status | Supersedes or amends |
|---|---|---|---|
| D1 | The codegraph adapter reads a store's graph in bulk into an immutable in-memory image; raw SQL stays in the adapter, version-checked | Approved 2026-11-17 | RFC-0003 "Access" |
| D2 | The memory tier keeps decoded, frozen objects and a working-set budget, with git blob ids as file identity | Approved 2026-11-17 | ADR-0020 d2 and d5, ADR-0021, ADR-0035 d1 and d4, ADR-0112, ADR-0121 |
| D3 | An answer is kept in memory for its generation | Approved 2026-11-17 | ADR-0020 d2; ADR-0077 "Not decided here" |
| D4 | The mirror lock covers the refresh only; a query computes on a pinned generation | Approved 2026-11-17 | RFC-0010 "Live head", RFC-0005 "Live freshness" |
| D5 | Demand-driven reads through inverted indexes, under the superset rule and its property test | Approved 2026-11-17 | ADR-0045 |
| D6 | Trees and TypeScript source files owned by the generation | Open. It is decided at the close of phase 2 with RSS data, or earlier if a stage output of L16 cannot be made plain data without trees | ADR-0040 d1 |
| D7 | The daemon slice starts, and `ye-ast init` starts the daemon that indexes in the background | Open: decided at the close of phase 2 | ADR-0011 d5, ADR-0005 d5 |
| D8 | A packed derived store read in one piece | Open: with D7 | ADR-0077 d4, RFC-0037 |

Launch priming is not part of D8. The launch already runs `warmLive` (`compose.ts:279-289`), which builds the index
and primes nothing; priming the snapshot-only derivations there is phase 1 work.

Each approved decision lands as an ADR written by the first unit that needs it, citing this RFC and the owner's words.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Keep the listing of a commit by its resolved sha (`export` costs 55-204 ms on every revision query)? | Yes. A tree is immutable by sha and the revision is still resolved on every request. Amends ADR-0020 d4 and ADR-0028; it follows from D2's content addressing |
| 2 | May the live generation token give index-dependent facts a disk key? | No. Two sync histories that end at the same `stateId` are not proven to give the same store; the token is memory-only |
| 3 | Ask codegraph upstream for a sync that does not re-run whole-graph synthesis (the 0.47 s residual)? | Yes, as a request; upstream contributions stay the owner's call (RFC-0003) |
| 4 | A query that finds the index behind: wait, or answer the older state with a notice? | Wait within the deadline, then `index-unavailable` (today's rule). An agent that just edited needs the new state |
