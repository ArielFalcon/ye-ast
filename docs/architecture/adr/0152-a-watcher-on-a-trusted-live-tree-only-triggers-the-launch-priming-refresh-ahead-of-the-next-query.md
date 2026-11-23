# ADR-0152: A watcher on a trusted live tree only triggers the launch priming refresh ahead of the next query

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040 §3.3 step 1: "**Trigger.** A
  watcher (trusted only), the launch, or a query. A trigger only says 'look'", step 2: "The proof is never cached and a
  watcher never replaces it", and §5: "A watcher misses or coalesces an event | The watcher is never the proof; a test
  runs with the watcher silenced"; and 2026-11-17: "everything pending is integrated as it can be, autonomously". The
  targets it serves (translated): "at install time the heavy indexing work is done in the background, so that later
  only what changes is reindexed and nothing is done on-the-fly", and "caches with robust stale policies".
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §3.3, §3.5, §5, L20;
  [ADR-0010](0010-trust-modes.md),
  [ADR-0144](0144-the-mirror-lock-covers-the-refresh-and-the-pin-and-a-live-query-derives-from-the-pinned-capture.md)
  (decision 7, launch priming yields to the queries of its process),
  [ADR-0148](0148-acquisitions-of-one-process-take-a-mirror-lock-in-line-and-only-another-process-is-polled.md)

**In short:** the process that warmed a trusted repository's live tree keeps one recursive file-system watcher on it.
An event inside the declared scope, or on `.git/HEAD` or `.git/index`, marks the repository dirty; when no refresh of
the watcher runs and no query of the process is in flight, the dirty flag starts launch priming again. Priming takes the
mirror lock, syncs and pins exactly as a query does and derives what no target narrows, yielding to queries as before.
The next query still proves freshness itself, so a lost, late or silenced event costs time and never an answer.

## Context

After phase 2 an edit is paid by the first query that follows it: the sync, the image reload and the re-derivation of
the changed files all run on the query's path (`edit-now` on shopizer/backend `callers` about 2.9 s, RFC-0040 L23
profile). Launch priming (ADR-0144 decision 7, L32) already does that work ahead of the first query after a launch, and
yields to the queries of its process before it takes the lock and between steps. Nothing starts it after an edit.

| Option | Verdict |
|---|---|
| A new refresh path the watcher calls (sync only, or sync and derive) | Rejected: a second writer of the mirror beside the query and priming, with its own yielding rules |
| A debounce interval or an event count before refreshing | Rejected: AGENTS.md "Signals, never size thresholds"; a timer guesses when a burst ends |
| Polling the tree's listing | Rejected: a listing per interval whether or not anything changed, and an interval constant |
| A dirty flag that starts launch priming when no refresh of the watcher runs and no query is in flight | Chosen: the refresh, the lock, the sync worker and the yielding are the ones priming has; a burst coalesces into the refresh it meets plus at most one follow-up |
| Trusting the watcher to skip the query's proof | Rejected: RFC-0040 §3.3 "the proof is never cached"; an event can be lost, late or coalesced by the platform |

## Decision

1. **Where.** `warmLive` (the launch warming of the MCP server, ADR-0144 decision 7) opens one watcher per repository
   and composition, after it found the repository `trusted` and before it builds the mirror. Under `untrusted`, or when
   the trust record cannot be read, no watcher is opened: nothing reads the working tree (ADR-0010). A one-shot CLI
   command never warms and never watches.
2. **What it watches.** The repository root, recursively, with the platform's watcher (`fs.watch`). An event is kept
   when its path is `.git/HEAD` or `.git/index`, or when no segment of it is an engine entry (`.git`, `.codegraph`,
   `.ye-ast`, `.ye-ast-graph`, which the listing never holds) and it is inside the declared scope's export selection
   (the selection the mirror's listing applies). The mirror itself lives under `<repo>/.ye-ast-graph/live/`, so without
   the engine-entry rule every refresh would write events that start the next one. An event without a path is kept.
   Paths git ignores are not filtered: git decides them at the listing, and such an event costs one refresh that proves
   the tree unchanged.
3. **Dirty flag, no timer.** A kept event sets the repository dirty and, when no refresh of the watcher runs, starts
   one: it waits until no query of the process is in flight (the turns priming already takes), clears the flag and runs
   launch priming. When priming ends and the flag is set again, it runs once more; otherwise it reports `settled`. Events
   during the launch build and priming set the flag, and the follow-up runs after them. There is no interval, no
   debounce and no count: a burst of any size costs the refresh in flight plus at most one follow-up.
4. **The refresh is launch priming, unchanged.** It pins a capture under the mirror lock (the lock line of ADR-0148, the
   sync worker of RFC-0040 §3.3), derives the facts no target narrows on the pinned capture, asks for the queries before
   the lock, once it holds it and before each step, and keeps nothing an abort cut. No second lock, no new refresh path.
5. **Never the proof.** Every live query still lists and compares the tree against the mirror under the lock (RFC-0040
   §3.3 step 2). The watcher changes when the work happens, never what a query answers.
6. **Closing.** The watcher closes when the composition's signal or `warmLive`'s signal is aborted (server shutdown),
   and when a refresh it would start finds the repository no longer `trusted`: trust is read again before each refresh,
   so the first event after a trust change closes it before anything is read. It never keeps a process alive by
   itself (the stdio server does): it is opened non-persistent, which also covers the per-directory watchers a platform
   without a native recursive watcher opens for directories created later (amended 2026-11-23 after the phase-3
   review).
7. **Failure turns it off.** A watcher that cannot open (an unsupported platform, `EMFILE`, `ENOSPC`) or that reports an
   error later is closed, and one `watch` line with outcome `off` and the redacted reason goes to the host's measurement.
   No query fails or waits for it; queries keep proving freshness themselves.
8. **Observable.** Each refresh the watcher starts writes the `prime` line with `trigger: "watch"` (launch priming writes
   `trigger: "launch"`); a refresh loop that drains writes one `watch` line with outcome `settled` (RFC-0012).

## Consequences

- An edit followed by enough idle time is synced and re-derived before the next query, which then pays the proof, the
  pin and what depends on its question. Figures: see "Measured" below.
- A query that arrives while the watcher's priming runs finds it either not started (it yields before the lock),
  holding the lock (the query waits its turn in the lock line, as with launch priming), or in a step (the query shares
  the process with that step until it ends). The last two cost a query time that it would not pay without the watcher.
- Activity under paths git ignores (a build writing `target/` or `dist/`) runs refreshes back to back while it lasts,
  each proving the tree unchanged; the cost is one listing and the kept priming steps per refresh.
- A linked worktree's `.git` is a file, so its HEAD and index events are not seen; its file events still are.

## Measured

The latency bench on the stdio MCP over clones of the corpus, `main` `0261d1f5e` against this decision, five rounds of
every family per scenario, p50 in ms, Apple M1 Max. `edit-settled` is new: the edit, then the call once the server's
`watch` line reports `settled`; every one of its 105 edits settled (none hit the bench's one-minute guard).

| Repository, family | unchanged | edit-now, before | edit-settled, after | edit-idle (2 s), before → after |
|---|---|---|---|---|
| shopizer/backend, `callers` | 179 | 2,972 | 1,866 | 3,073 → 4,180 |
| shopizer/backend, `trace` | 175 | 4,181 | 686 | 4,234 → 2,942 |
| shopizer/backend, `outline` | 176 | 1,429 | 135 | 1,480 → 2,421 |
| shopizer/backend, `entrypoints` | 195 | 1,820 | 165 | 1,938 → 2,447 |
| shopizer/backend, `workspace` | 1,452 | 2,277 | 1,412 | 2,398 → 3,721 |
| petclinic/backend-rest, `callers` | 79 | 413 | 197 | 438 → 211 |
| petclinic/backend-rest, `trace` | 67 | 294 | 55 | 331 → 75 |
| petclinic/backend-rest, `outline` | 65 | 214 | 54 | 227 → 63 |
| realworld-nx/frontend, `callers` | 70 | 345 | 133 | 416 → 157 |
| realworld-nx/frontend, `importers` | 68 | 279 | 83 | 327 → 104 |
| realworld-nx/frontend, `outline` | 69 | 208 | 59 | 230 → 69 |

- From the edit to `settled`: shopizer/backend about 4.3 s, petclinic/backend-rest about 0.39 s, realworld-nx/frontend
  about 0.35 s. On shopizer/backend `callers`, `impact` and `importers` still derive after a settled edit what priming
  does not cover (the target's own derivation); `outline`, `entrypoints` and `workspace` answer at the unchanged cost.
- Idle with the watcher on: 10 ms of CPU over 10 s and 24 open files, the same as before (macOS keeps one FSEvents
  stream and no descriptor per directory).
- `edit-now` is unchanged within 30 ms except where the query arrives after the watcher's priming took the lock: it
  waits for that refresh (`entrypoints` 170 → 301 ms on petclinic/backend-rest, 96 → 236 on realworld-nx/frontend,
  1,820 → 2,557 on shopizer/backend).
- `edit-idle` on shopizer/backend regresses by 0.5-1.3 s: a query that arrives 2 s after the edit meets the watcher's
  priming in the middle of a step it does not leave (the `call-sites` step, about 860 ms, shows inside the query's
  window), so the two share the process. This is the residual of ADR-0144 decision 7 ("a query shares the process with
  at most the step that runs"), now met after every edit; yielding inside a step is RFC-0040 L21.
- The warm differential on petclinic/backend-rest and realworld-nx/frontend passed 55 steps with 0 differing, its
  trust-record change included.

## Not decided here

- Watching repositories other than the launch repository of an MCP server.
- Filtering events by git's ignore rules before they set the flag.
- Building the next generation in the background with query priority beyond what priming derives (RFC-0040 L21).
