# ADR-0156: Background priming passes its turn to a query between bounded units, and gives the mirror lock up wherever that costs nothing

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 L21: "The next generation is
  built in the background with query priority, yielding between files", and §3.3 row "Index current, background
  derivation unfinished | Compute what the query needs, with priority"; and 2026-11-17: "everything pending is
  integrated as it can be, autonomously". The targets it serves (translated): "at install time the heavy indexing work
  is done in the background, so that later only what changes is reindexed and nothing is done on-the-fly", and "without
  sacrificing functionality and quality".
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.3, L20, L21;
  [ADR-0144](0144-the-mirror-lock-covers-the-refresh-and-the-pin-and-a-live-query-derives-from-the-pinned-capture.md)
  (decision 7, launch priming yields to the queries of its process),
  [ADR-0148](0148-acquisitions-of-one-process-take-a-mirror-lock-in-line-and-only-another-process-is-polled.md),
  [ADR-0152](0152-a-watcher-on-a-trusted-live-tree-only-triggers-the-launch-priming-refresh-ahead-of-the-next-query.md)

**In short:** the long whole-snapshot readings priming runs (the Java call sites and data effects) are split into
bounded units: one source parsed, one type's calls read, one file a reader walks. Between two units priming lets the
process's waiting events run and, when a query of its process is in flight, waits until none is; a step that waited
runs again on a new capture, where what it kept for an unmoved state is found kept. Under the mirror lock priming asks
for the queries of its process at every point where giving the capture up costs nothing: once the listing is compared
with the mirror (before the store is opened or written), and once a store write it began commits (before the pin). A
query therefore waits for at most a listing or a store write priming began, and takes that write over instead of
writing it again. No timer, no threshold, no second lock, no new signal: the decline of L32, asked at more points.

## Context

ADR-0152 made the watcher start launch priming after every edit. Priming already waits for the queries of its process
before it takes the lock, once it holds it and between steps (ADR-0144 decision 7, L32). Two residuals remained, both
measured in ADR-0152:

1. A step is a synchronous whole-snapshot reading: on shopizer/backend the Java call sites take about 0.9 s of one
   event-loop turn. A query that arrives during it is not even read until it ends (`edit-idle` `outline` 1,480 →
   2,421 ms).
2. Once priming holds the mirror lock, a query that arrives waits in the lock line (ADR-0148) for priming's whole
   refresh and pin, and then proves the tree again under its own turn (`edit-now` `entrypoints` 170 → 301 ms on
   petclinic/backend-rest). After a query of the bench the watcher's refresh usually proves a tree the query already
   synced, so the wait buys nothing.

| Option | Verdict |
|---|---|
| Run priming in a worker thread | Rejected: a second copy of the parsers, the stores and the caches, and every kept value crosses a thread boundary |
| Yield every N files or every N ms | Rejected: AGENTS.md "Signals, never size thresholds"; a count or an interval guesses what a query costs |
| Abort a step when a query arrives and start it again | Rejected for steps: an edit-idle query that does not move the tree would throw away up to a whole step; pausing keeps it |
| Split the readings into units and pass the turn between them; a step that waited runs again on a new capture | Chosen for steps |
| Let the query wait for priming's refresh under the lock and take its result | Rejected: the query waits for the rest of a refresh that is usually redundant, then proves the tree anyway (measured below) |
| Cut priming's refresh and pin through an abort signal when a query starts | Measured and rejected: the lock wait goes (873 → 2 ms), but a cut that lands in the store sync retires the mirror's sync worker (ADR-0125 decision 4), so the query starts a new one (petclinic/backend-rest `workspace` sync 117 → 175 ms) |
| Give the capture up at the points where it costs nothing: after the listing is compared, and after a store write commits | Chosen for the lock: a query waits for at most a listing or a write it then reuses; nothing is aborted |

## Decision

1. **Units.** A reading that walks the whole snapshot in one synchronous pass is written as a generator of units
   (`core/domain/shared/work-units.ts`): each `yield` ends one bounded unit, the return is the value. Run at once it is
   the reading as before, so a query's answer cannot change; run with a turn it awaits `between` after each unit. This
   decision splits the Java call sites (each source parsed, each type's calls and the methods they select, each file
   the HTTP and event readers walk) and the Java data effects (each source parsed, each file's receiver bindings, each
   type walked). The fixpoint of a reader's method flow stays one unit.
2. **The turn.** `LibraryCallSiteOptions.between` and the data-effect reader's `between` carry the turn; a query
   passes none. Priming's turn (`PrimingTurns.passTurn`) first lets the process's waiting events run, so a request that
   reached the process starts its query, then waits while a query of the process is in flight. A turn that finds
   priming aborted rejects; the reading closes its generator (its trees are freed) and the rejection reaches the
   derivation, which keeps nothing (ADR-0144 decision 7: nothing an abort cut is admitted).
3. **A step that waited runs again.** A step during which the turn waited ends priming's capture once it completes,
   and priming pins a new one when the queries are done: it primes the state they left. What the completed step kept
   for an unmoved state is found kept on the new capture; for a moved state the step derives again.
4. **The lock given up where it costs nothing.** `OpenLive.declined`, which priming answers with whether a query of its
   process is in flight (ADR-0144 decision 7, L32), is asked before the lock, once it is held, and now also once the
   listing is compared with the mirror (before the serving store is opened or any write begins), once a store write
   commits (before the pin opens the store) and once the refresh returns (before the pin reads the sources). A decline
   releases the lock; the query, next in the in-process line (ADR-0148), refreshes the tree itself, or finds the write
   priming committed and writes nothing again. A store write that began always finishes: it is the write the query would
   make, and cutting it would retire the sync worker.
5. **Observable.** The data effects write their own stage line (`data-effects`, RFC-0012), so the second half of the
   call-sites step and its derivation after an abort are visible. `prime` keeps its `yields` count, which now counts a
   turn inside a step too.

## Consequences

- A query that arrives during priming waits for at most one unit of priming's work, not a step or a refresh.
- A paused step holds its capture (the pinned store reader, its parse hold and its trees) while the query runs.
- A declined refresh repeats under the query what priming had listed and reconciled (tens of ms); a query that arrives
  during a store write priming began waits for that write and does not repeat it.
- The sync path for queries is unchanged: every unit runs at once, in the same order.

## Measured

The latency bench on the stdio MCP over clones of the corpus, five rounds of every family per scenario, p50 in ms,
Apple M1 Max, one run each: `main` `0261d1f5e`, ADR-0152 alone (`fc5a7bb37`), and this decision (`34149bd52`).
`edit-settled` exists only with the watcher; its "before" is `main`'s `edit-now`.

| Repository, scenario, family | main | ADR-0152 | this decision |
|---|---|---|---|
| shopizer/backend, edit-idle, `outline` | 1,480 | 2,433 | 1,557 |
| shopizer/backend, edit-idle, `callers` | 3,120 | 4,126 | 3,317 |
| shopizer/backend, edit-idle, `importers` | 2,235 | 3,401 | 1,383 |
| shopizer/backend, edit-idle, `workspace` | 2,524 | 3,699 | 1,590 |
| shopizer/backend, edit-idle, `trace` | 4,370 | 2,996 | 3,800 |
| shopizer/backend, edit-now, `entrypoints` | 1,896 | 2,646 | 1,889 |
| petclinic/backend-rest, edit-now, `entrypoints` | 172 | 305 | 170 |
| realworld-nx/frontend, edit-now, `entrypoints` | 96 | 249 | 99 |
| shopizer/backend, edit-settled (main: edit-now), `trace` | 4,277 | 690 | 701 |
| petclinic/backend-rest, edit-settled (main: edit-now), `callers` | 419 | 190 | 184 |
| realworld-nx/frontend, edit-settled (main: edit-now), `callers` | 362 | 131 | 133 |

- The event loop: the longest stretch the watcher's priming held it in one step after an edit on shopizer/backend went
  from 2,523-2,662 ms (the call-sites step) to 79-80 ms; the steps it now leaves longest are the entrypoint extraction
  (520-544 ms) and the relations (about 250 ms). The call-sites step takes about 200 ms longer in the background
  (2,523 → 2,743 ms), and an edit settles about 0.2 s later on shopizer/backend.
- The lock: the `live-lock` wait of `edit-now` `entrypoints` went 873 → 1 ms on shopizer/backend, 143 → 1 on
  petclinic/backend-rest and 168 → 1 on realworld-nx/frontend. The abort cut tried first gave the same wait but cost
  `workspace` on petclinic/backend-rest 327 → 380 ms (a retired sync worker); the declines cost none (323).
- Every other `edit-now` cell is within +6 % of `main` (the largest, shopizer/backend `impact` 2,195 → 2,329, `callers`
  3,003 → 3,120), and `edit-idle` on shopizer/backend `callers` +6 %, `outline` +5 %; in the same runs the `unchanged`
  cells, which priming never meets, moved -2 % to -23 % against `main`. `edit-idle` `trace` on shopizer/backend gives
  back part of ADR-0152's gain (2,996 → 3,800, `main` 4,370): a query that arrives during the call-sites step now
  derives them itself instead of waiting for priming to keep them.
- The warm differential on petclinic/backend-rest and realworld-nx/frontend passed 55 steps with 0 differing.

## Not decided here

- Units for the other whole-snapshot readings (entrypoint extraction, relations, the typed reading), until a stage
  line shows one of them holding the event loop on a query's path.
- A query joining a derivation priming has in flight instead of deriving it again.
