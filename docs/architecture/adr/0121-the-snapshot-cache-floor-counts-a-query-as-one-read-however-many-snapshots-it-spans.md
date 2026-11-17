# ADR-0121: The snapshot cache floor counts a workspace query as one read, however many snapshots it spans

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-17: "todo lo que queda pendiente se debe ir integrando a medida que se pueda, lo haces
  de forma autonoma" (everything pending is integrated as it can be, autonomously), over the limitation ADR-0112's
  integration left open: a workspace read spans more than three snapshot reads, so it may still evict past the floor.
- Amends: [ADR-0112](0112-the-default-snapshot-data-budget-never-evicts-what-the-latest-reads-used.md) decisions 1 and 2
  (the unit the floor counts)
- Related: [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md),
  [ADR-0030](0030-live-captures-use-the-snapshot-data-cache.md),
  [ADR-0035](0035-derived-facts-are-retained-by-content.md)

**In short:** the floor of ADR-0112 protects the entries of the current read and the two before it, and a read was one
lookup of one snapshot. A query that reads more than three snapshots (a workspace of several repositories) therefore
evicted its own earlier members while it ran, and the next identical query evicted the rest of them in turn. The floor
now counts every read made while a snapshot preparation is open as one read, so a query holds what all of its member
reads used and an identical query asked again finds them.

## Context

Measured through the stdio MCP on a workspace of seven repositories read at their commits (a 1,340-file Java backend,
the shopizer admin, the petclinic REST and microservices backends and its Angular frontend, and a Nx frontend and
backend), `callers` on a declaration of the Java backend with the other six as `workspace.repos`, offline, the
default budget, main 3fd36839b, four identical calls in one process:

| Call | Query time | Wall | Cache hits / misses | Evictions | Evicted |
|---|---|---|---|---|---|
| 1 (cold) | 18.4 s | 32.7 s | 0 / 23 | 705 | 8.6 MB |
| 2, 3, 4 | 6.3-6.5 s | 13.7-14.0 s | 0 / 23 | 10,213-10,467 | about 148 MB |

- The retained set peaked at 147-149 MB against a 32 MiB floor, and a repeated call found none of it.
- The cause is the unit, not the budget. The cache counts one read per first lookup of a snapshot
  (`beginRead`, called from `snapshotRetention.lookup`), and ADR-0112 holds the current read and two before it, sized
  for the base and the head of a change query. A workspace query reads one snapshot per member repository and revision,
  all inside one `withSnapshotPreparation` operation. By the fourth member the first has left the window, and the next
  admission evicts it; the next call reads the members in the same order, so each member misses just after the one
  that would have kept it was evicted: the cyclic pattern ADR-0112 set out to remove.
- Workspaces whose entries fit in the floor never showed it: a `workspace` query over seven small repositories (a
  TypeScript webapp and six Java services) peaked at 4.7 MB and hit on every repeat.
- A snapshot preparation already is the query's lifetime: it opens when a workspace query plans its members and closes
  after every consumer of the operation has finished (workspace, decisions, trace over a workspace, callers and impact
  across members, contract consequences).

| Option | Verdict |
|---|---|
| Raise the number of held reads | Rejected: any number is below some workspace's member count, and it is the size threshold the pillar "signals, never size thresholds" refuses |
| Keep every entry of the last N snapshots by key | Rejected: the same constant, and it cannot say that two snapshots belong to one question |
| Count the reads of one preparation as one read | Chosen: the unit becomes the one the query already has |

## Decision

1. ADR-0112 decisions 1 and 2 are amended. The floor holds the entries of the current read and the two reads before it,
   where all the reads made while a snapshot preparation is open are one read. A query of any number of member
   snapshots therefore keeps what every member used, and the reads before it are counted as before.
2. The snapshot data cache gets `beginQuery()`, which returns the function that ends the query. Each query is one read,
   counted when it begins, and the reads that begin while a query is open count no further. Whatever was used since the
   oldest open query began is held until that query ends, so queries that overlap without pause hold only what the
   open queries used, never everything since the overlap began. A read that begins while no query is open counts
   alone, as before, and ending a query twice ends it once.
3. `withSnapshotPreparation` opens a query for the lifetime of its operation and ends it when the operation ends,
   whether it returns or throws. Nothing else opens one.
4. An explicit `snapshotCacheBytes` keeps ADR-0020's meaning and the hard cap does not look at reads. Keys, the
   admission of completed work only, deserialization afresh and the `cache` and `derived-facts` lines are unchanged.
   Eviction changes cost, never the answer.

## Consequences

- A workspace query repeated unchanged finds every member's entries and facts. On the measurement above, calls 2 to 4
  fell from 6.3-6.5 s to 3.2-3.3 s of query time (wall 13.7-14.0 s to 8.2-8.3 s), the evictions from about 10,200 to 0,
  and the cache from 0 hits to 14 hits and 0 misses; the cold call evicted nothing (705 to 0). The remaining time is
  work the cache does not hold (codegraph reads, projects built per read).
- The process may hold, past the floor, the working sets of the current query and the two reads before it, as ADR-0112
  said for three reads. A query over many large members is one such working set: 154 MB on the measurement. A host
  that needs a bound sets `snapshotCacheBytes`.
- What a read outside any preparation uses while a query is open is held until that query ends: bounded by the open
  query's lifetime, and released when it ends.
- A query that reads several snapshots without opening a preparation (a single repository's change query reads two)
  is counted as before; the first read of a query that opens one is counted when it begins.

## Not decided here

- Reads made outside a snapshot preparation by one question, for example the repeated reads of library sources that
  `createRevisionSources` makes while dependency paths remain. They are not measured to span more than three reads
  and keep the count of ADR-0112.
- The disk tier of ADR-0077 and a separate budget for derived facts, as ADR-0112 left them.
