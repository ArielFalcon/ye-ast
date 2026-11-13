# ADR-0077: Derived facts persist by content in ye-ast's own store

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados" (I approve
  every pending recommendation; leave them closed), after "estas propuestas de correccion y mejoras deben ser de forma
  transversal y no parches puntuales" (the corrections and improvements must be cross-cutting, not point patches).
- Related: RFC-0037 (design), ADR-0010, ADR-0020, ADR-0035, RFC-0012
- Extends: ADR-0035 (the same facts and keys, with a second tier)

**In short:** the derived facts ADR-0035 retains in memory gain a disk tier behind the same port, keyed by content and
reader version, in a directory a host may name. A process that starts and exits, as a pipeline job does, no longer
derives everything again. No fact changes, and the corpus gate proves it cold and warm.

## Context

Across processes ye-ast reuses only the codegraph index. Its own derivations are held in a 32 MiB memory cache
(`src/composition/compose.ts:94`) and lost at exit. The cache directory comes from the environment and no flag names
it (`src/composition/main.ts:13`). The `DerivedFacts` port already keys plain data by content and promises that a hit
and a miss answer the same value.

| Option | Verdict |
|---|---|
| Wait for the daemon | Rejected as the only answer: a daemon serves a session, not a job that starts and exits |
| A new store with its own schema | Rejected: a second mechanism beside a port that already fits |
| A disk tier behind `DerivedFacts` | Chosen |

## Decision

1. The implementation of `DerivedFacts` gains a disk tier. The port's contract is unchanged, and no reader changes.
2. A key is the slot, the version of the reader that owns it, and the content hash of every input. A value is plain
   data.
3. Only a completed derivation is stored. A fact cut by a wall-clock deadline never is.
4. An entry that does not verify is a miss and is removed. Writes are atomic.
5. The store is written only by ye-ast, from content it exported or read through the confined reader. Nothing in a
   repository seeds it. One store serves both trust modes: a key is content and reader version, whatever mode read
   the content.
6. `--cache <dir>` names the directory on every command and in the MCP registration. Without it, today's rule holds.
   The disk tier is on wherever the index cache is on.
7. Slots keyed by one file's content are stored first; aggregates are keyed by the fingerprint of their parts.
8. Per repository and snapshot, the inputs of the workspace join are one stored value.
9. What is stored, and in which order, follows a stage measurement of cold queries. Retention reuses the index cache's
   policy until a measurement shows a need.
10. The corpus gate, run with an empty store and with a warm one, expects no difference.

## Consequences

- A pipeline that restores one directory starts warm.
- Disk use grows by the stored entries; the measurement of decision 9 reports it.
- A reader that changes what it derives must bump its version; a test holds it.

## Not decided here

- Storing whole facts: not done. Derivations are stored; a fact is rebuilt from them.
- Anything about the daemon (RFC-0005).
