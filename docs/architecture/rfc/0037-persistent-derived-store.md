# RFC-0037: Derived facts persist by content in ye-ast's own store

- Status: Accepted, 2026-11-13. Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados"
  (I approve every pending recommendation; leave them closed); every open question is settled as recommended (see
  Resolved questions). ADR-0077 records its decisions.
- Related: ADR-0010, ADR-0020, ADR-0030, ADR-0035, RFC-0003, RFC-0005, RFC-0012, RFC-0033, RFC-0036, ADR-0077 (the
  decision this RFC designs)

**In short:** between two processes ye-ast keeps one thing, the codegraph index. Everything it derives itself, the
part that makes its answers better than the index, lives in a 32 MiB memory cache and is lost when the process ends.
A pipeline job therefore starts cold every time, and so does every CLI call on a developer's machine. The port that
retains derived facts by content already exists and already promises that a hit and a miss answer the same value. This
RFC adds a disk tier behind that port and lets a host name its directory. No fact changes.

## Problem

| Fact | Evidence |
|---|---|
| The codegraph index is reused across processes, keyed by content | `src/composition/compose.ts:211`, `src/core/ports/index-cache.port.ts` |
| Derived facts are retained by content, in memory, within one process | ADR-0035, `src/core/ports/derived-facts.port.ts`, `SNAPSHOT_CACHE_BYTES`, `src/composition/compose.ts:94` |
| The cache directory comes from the environment only; no flag names it | `src/composition/main.ts:13`, `src/composition/index-cache-directory.ts` |
| A lexical binding of one file builds a compiler program on each call | `src/core/adapters/typescript/lexical-bindings.ts:28-45` |
| The key of a Java project is the serialization of every source's content | `src/core/adapters/spring/java-project.ts:78-80` |
| One trace on the largest Java backend of the 2026-11-07 evaluation took 18 to 55 s on a loaded host | `docs/evaluations/trace-quality/2026-11-07-findings.md:63` |
| The first corpus gate runs measured a median query of 1.7 s and a slowest trace of 12.7 s | `docs/evaluations/corpus-gate/2026-11-08-first-run.md:53` |
| There is no daemon; RFC-0005 schedules it after the MCP | `AGENTS.md`, "Status" |

An agent in a pipeline issues a handful of queries and exits. Each pays the full derivation again.

## Design

### 1. A disk tier behind the existing port

`DerivedFacts` (`ofFile`, `ofInputs`, `fingerprint`) keeps its contract. Its implementation gains a second tier:

| Tier | Holds | Lifetime |
|---|---|---|
| Memory | what ADR-0035 and ADR-0020 already hold, under the host's byte budget | the process |
| Disk | the same plain JSON values, one entry per key | across processes, under a retention policy |

| Rule | Detail |
|---|---|
| Key | the slot, the version of the reader that owns the slot, and the content hash of every input the value depends on. Exactly the key the memory tier uses, plus the reader version |
| Value | plain data. Never a syntax tree or an object that holds one, as the port already requires |
| Admission | only a derivation that completed. A fact cut by a wall-clock deadline is never stored (the determinism invariant) |
| Read | an entry whose key or shape does not verify is a miss, and is removed |
| Write | atomic: a temporary file renamed into place, so two processes never read half an entry |

No reader changes. A reader that already calls the port gains the tier.

### 2. Trust

The store is ye-ast's own. It is written only by ye-ast, from content ye-ast exported or read through the confined
reader, and keyed by that content. Nothing in a repository seeds it. This is the rule the index cache already follows
under `untrusted` ("stores it built itself from its own export, keyed by content"), applied to a second kind of entry.

### 3. The directory is a host input

`--cache <dir>` on every command, and in the MCP registration `ye-ast init` prints. Without it, today's rule holds
(the user's cache directory, from the environment, read by composition only). A pipeline restores and saves that
directory between jobs with its own cache step.

### 4. What is stored first

Stored first are the slots whose key is one file's content, because one edit invalidates one entry:

| Slot | Today |
|---|---|
| Lexical bindings of a file | a compiler program per call |
| Declarations and written calls of a file | derived per snapshot read |
| The decoded index of a declared jar or JDK archive (RFC-0033, ADR-0063) | per process |

Then the aggregates, keyed by the fingerprint of their parts instead of by their concatenated content. The Java
project's key becomes the fingerprint of the per-file keys.

The order inside each group is set by measurement (section 6), not by this table.

### 5. The workspace join reads only what changed

Per repository and snapshot, the inputs of the join (the call sites and the entrypoints) are one stored value. A
workspace query over `n` repositories derives them only for the repositories whose snapshot changed, then joins. The
join itself is cheap and is not stored in the first slice.

### 6. Measure, then store

| Step | Output |
|---|---|
| A stage breakdown of cold queries on the corpus, with the measurement record of RFC-0012; the trace walk gains the stage the 2026-11-07 findings note it lacks | which derivations dominate a cold query |
| The same queries cold and warm with the tier | wall time before and after, entry count and bytes on disk |
| Retention | the index cache's policy is reused as it is; its numbers change only on a measurement that shows a need |

### 7. Proof that nothing changes

1. The corpus gate run with an empty store and again with a warm one expects no difference in any family.
2. A test corrupts an entry and expects a miss and a correct answer.
3. A test bumps a reader version and expects a miss.

## Relation to the daemon

A daemon (RFC-0005) keeps syntax trees and programs alive, which a store of plain data cannot. The two are
complementary: the store serves a process that starts and exits, the daemon serves a session. The daemon, when built,
reads the same store. This RFC decides nothing about it.

## Rejected

| Option | Why |
|---|---|
| A new store with its own schema and query language | The port and its key discipline already exist; a second mechanism is a second owner |
| Persisting syntax trees or compiler programs | Not plain data, not stable across versions, and the port forbids it |
| Reading a store a repository ships | Untrusted content would steer the answer |
| A `warm` command | Any query warms the store; a command adds surface with no new capability |

## Resolved questions (owner, 2026-11-13: "apruebo todas las recomendaciones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | Is the disk tier on by default? | Yes wherever the index cache is on today. It follows the same directory and the same trust rule, and a host that passes no directory in a sandbox gets today's behavior |
| 2 | Is the store shared between trust modes? | Yes. A key is content and reader version; the mode that read the content does not change what is derived from it |
| 3 | Do answers (whole facts) get stored? | No, not in this RFC. A fact's inputs include the snapshot and declared outputs; storing derivations gets most of the gain with a key that is easy to prove |
