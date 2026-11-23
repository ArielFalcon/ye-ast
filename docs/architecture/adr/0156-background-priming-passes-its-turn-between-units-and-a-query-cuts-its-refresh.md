# ADR-0156: Background priming passes its turn to a query between bounded units, and a query cuts priming's refresh under the lock

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
runs again on a new capture, where what it kept for an unmoved state is found kept. A query that starts while priming
holds the mirror lock for its refresh and pin cuts them through priming's signal: the lock is released at the refresh's
next abort check, the query refreshes the tree itself, and priming pins again after it. No timer, no threshold, no
second lock; a query never waits for a background step or a background refresh to end.

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
| Cut priming's refresh and pin when a query starts while priming holds the lock | Chosen for the lock: a cut refresh is the deadline path every refresh already has (`pending` paths, nothing committed half) |

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
4. **The cut under the lock.** Priming passes the mirror capture a signal of its own that a query of the process
   starting aborts, from the capture's start until the capture is pinned; then it is withdrawn and decision 2 applies.
   A cut before the lock is the decline of L32; a cut while priming lists, reconciles, syncs or pins aborts them at
   their next abort check, which releases the lock, and the query, next in the in-process line (ADR-0148), refreshes
   the tree itself. Priming waits for the queries and pins again. A cut refresh is the refresh a deadline cuts: what it
   wrote is recorded as `pending`, nothing is committed half, and the next refresh resumes it.
5. **Observable.** The data effects write their own stage line (`data-effects`, RFC-0012), so the second half of the
   call-sites step and its derivation after a cut are visible. `prime` keeps its `yields` count, which now counts a
   turn inside a step and a cut refresh too.

## Consequences

- A query that arrives during priming waits for at most one unit of priming's work, not a step or a refresh.
- A paused step holds its capture (the pinned store reader, its parse hold and its trees) while the query runs.
- A cut refresh repeats under the query what priming had listed and reconciled; when priming's refresh was the full
  build of a missing store, the query builds it again from the start.
- The sync path for queries is unchanged: every unit runs at once, in the same order.

## Measured

To be completed with the bench and the differential of L21.

## Not decided here

- Units for the other whole-snapshot readings (entrypoint extraction, relations, the typed reading), until a stage
  line shows one of them holding the event loop on a query's path.
- A query joining a derivation priming has in flight instead of deriving it again.
