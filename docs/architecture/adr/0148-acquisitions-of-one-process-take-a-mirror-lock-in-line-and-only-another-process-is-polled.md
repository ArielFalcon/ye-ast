# ADR-0148: Acquisitions of one process take a mirror lock in line, and only a holder in another process is polled

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-23 (translated), over RFC-0040 §8 "Late units", L29: "Lock acquisition without a
  poll for in-process waiters [...] First identify it [...] if it is another process, an in-process queue does not
  help and the cause is fixed where it lives. Otherwise: an in-process queue per lock file in front of the file lock,
  woken on release; the woken waiter still goes through `tryCreateLock`, so cross-process exclusion and stale-holder
  recovery are unchanged." The targets it serves (translated): "Times must sit between a few hundred milliseconds and,
  for the most critical jobs, 3-5 s in specific cases; the p75 should be below 1 s."
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §8 (L29), L19;
  [ADR-0144](0144-the-mirror-lock-covers-the-refresh-and-the-pin-and-a-live-query-derives-from-the-pinned-capture.md)
  decisions 1 and 7; [RFC-0010](../rfc/0010-impact-queries.md) "Live head"

**In short:** every acquisition of a scope's mirror lock in one process joins a line kept in that process, and only
the head of the line contends for the lock file. A release hands the lock to the next acquisition of the line at once,
so a waiter of the same process never waits for a poll; a holder in another process is still found through the file
and polled every 50 ms, as before.

## Context

After ADR-0144 a single server still showed `live-lock` at about 54 ms per query. A timeline of the stage lines of one
MCP process on petclinic/backend-rest, with the caller of each acquisition recorded, named the holder:

| ms | Acquisition | Event |
|---|---|---|
| +0 | the query (`withLiveCapture` from the MCP query runner) | takes the lock |
| +3 | launch priming (`primeLive`, resumed when the previous query settled) | finds the lock held by its own pid, sleeps 50 ms |
| +28 | the query | releases the lock after its refresh and pin |
| +58 | launch priming | wakes from the poll and takes the lock |

Both acquisitions belong to one process. The waiter saw a live holder in the lock file, which named its own pid, and
slept the poll whatever the holder's remaining time: 30 of its 54 ms were spent after the release. The same race runs
the other way after an edit, when priming starts its capture first and the query waits for the priming's sync plus up
to a poll. No other process and no worker thread held the lock in a single-server run.

| Option | Why it was not taken |
|---|---|
| A shorter poll | Trades the waiter's latency for file-system churn in every waiter, and still sleeps after the release |
| A process-wide line keyed by the lock file alone | Two mirrors that name different pids in one process (the tests' stand-ins for two processes) would share a line and stop contending through the file |
| A line per mirror instance | Two compositions of one process (a library host that composes twice) would still poll each other |

## Decision

1. **One line per lock file and pid.** The process keeps one line for each pair of a scope's lock file and the pid
   the mirror writes into it. `lock` joins the line once the scope's directories are ready; the idle reservations of
   the retention sweep and of the debris cleanup take a free line without waiting and are a no-op when the line is
   taken, as they are when the lock file exists.
2. **Only the head contends.** The head of the line takes the lock file exactly as before: it creates the file, treats
   a dead or unreadable holder as stale, and polls a live holder every 50 ms. A live holder the head finds is therefore
   another process, or a part of this one outside the line (a worker thread). The other acquisitions of the line wait
   for their turn without polling.
3. **A release hands the turn on.** Releasing a lock removes the file while it still names this pid, then gives the
   turn to the next acquisition of the line, in the order they joined. A release runs once per lock: a second call of
   the same handle does nothing, so it can neither remove the file the next holder created with the same pid nor hand
   the turn on twice.
4. **No turn is lost.** An acquisition aborted while it waits in the line leaves it and answers `aborted`; one that
   fails or throws while it contends for the file hands the turn on before it answers; a release hands the turn on even
   when removing the file fails.

## Consequences

- A query and the launch priming of the same process no longer wait for a poll on each other; each waits only for the
  other's refresh and pin.
- Acquisitions in other processes are unchanged: exclusion, stale-holder recovery and the 50 ms poll go through the
  lock file. A process whose line holds the lock hands it within itself before another process's next poll, so the
  three-server cell of the bench is the check that no process starves the others.
- The line is memory of one process: it is never persisted and needs no recovery after a crash, which the stale-holder
  rule of the file already covers.

## Not decided here

- ~~Whether launch priming should give up a capture it waited for while a query of its process is in flight, before its
  refresh rather than after its pin (ADR-0144 decision 7); measured as a separate cost.~~ Decided in L32: it asks for
  the queries before it takes the lock and once it holds it, and ADR-0144 decision 7 says so. A query that arrives
  after priming started its refresh still waits for that refresh (a query cannot pass the lock holder).
- The single flight of a refresh ahead of the query (RFC-0040 L19), which reuses the line.
