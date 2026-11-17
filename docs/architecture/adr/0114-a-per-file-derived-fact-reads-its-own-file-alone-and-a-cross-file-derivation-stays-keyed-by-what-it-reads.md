# ADR-0114: A per-file derived fact reads its own file alone; a cross-file derivation stays keyed by what it reads

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-16, on the live-burst measurement: "este mcp ES el IDE del agente, tiene que estar
  pensado para aguantar ese ritmo de cargas muy grandes y rapidas de trabajo de forma tranquila y controlada" (this MCP
  is the agent's IDE; it must hold that pace of very large, fast loads calmly and in a controlled way).
- Amends: [ADR-0031](0031-snapshot-data-is-keyed-by-the-written-files.md) (what a one-file edit
  reuses in live mode; the key itself is unchanged)
- Related: [ADR-0035](0035-derived-facts-are-retained-by-content.md),
  [ADR-0040](0040-a-snapshot-read-parses-each-java-source-once.md),
  [ADR-0112](0112-the-default-snapshot-data-budget-never-evicts-what-the-latest-reads-used.md),
  [RFC-0010](../rfc/0010-impact-queries.md) "Live head"

**In short:** a derived fact that a reader computes from one file's syntax tree and nothing else is kept by that file's
content (ADR-0035), so a one-file edit derives it again for that file only. A derivation that resolves names, types or
members across files is not split by a content key over its own file: it stays keyed by every input it reads, since no
cheaper key has been shown to name them. Whatever one read computes over one project it computes once, not once per
reader.

## Context

Measured through the stdio MCP, live, after one edit to one file, on a Java backend of 1,340 files (runs
`20261116T203056Z-u1-cache` and this unit's `callers` calls, `callers` p50 with the edit versus without):

| Stage of a one-edit `callers` call | ms |
|---|---|
| `receiver-methods` (13 calls) | 4,400 |
| `relations` | 2,200 |
| `entrypoints` | 1,800 |
| everything an unchanged call also pays (codegraph reads, held project, reconciliation) | about 7,500 |

The three stages are keyed by the whole listing or by a fingerprint of every Java source (ADR-0031, the `layout` of
`receiver-methods`), so one changed blob misses them all. Inside them, three costs are not that:

- `provesBinding` (does the strict binding prove anything over these sources) scans every tree and was recomputed by
  every reader of one read, by several readers of an unchanged call and again for each of the 13 `receiver-methods` calls of a one-edit call
  (`java-receiver-methods.ts`, `java-receiver-fits.ts`, `java-dispatch-targets.ts`, `java-call-site-owner.ts`,
  `java-name-bindings.adapter.ts`), over the same held project.
- `projectKey` serialized every source to JSON on every `heldJavaProject` call, about 0.35 s per call.
- `javaReceiverBindings` walks one syntax tree and reads nothing else; it took about 1.4 s per one-edit call and was
  recomputed for every file with a site.

What decides whether a derivation may be keyed by one file: its inputs. `javaReceiverBindings` takes a root node, so its
inputs are the file's content. `relations`, `entrypoints` and the resolution of a receiver call take the project: a name
resolves through the imports, the types, the member signatures and the class hierarchy of other files, and several
readers also read other files' bodies (an anonymous class that extends a type in another file, a lambda that may
implement a port, a base class that subscribes in a method body). A key made of the file's content and a digest of
every file's declarations would be cheaper than the whole listing, but a body edit elsewhere would still be able to
change an answer the key calls unchanged; no audit of every reader of the project has shown it cannot.

| Option | Verdict |
|---|---|
| Key every per-site or per-file result by the file's blob plus a digest of the declarations of all files | Rejected: unsound wherever a reader of the project reads another file's body, and "an answer is byte-identical to a cold run" is the rule |
| Record which files each derivation consulted and key by their blobs | Not taken here: needs the project to report its reads, a design of its own |
| Per-file facts only for derivations that read one tree | Chosen |
| Compute once per read what every reader recomputed | Chosen |

## Decision

1. A reader may keep a derived fact by a file's content (`DerivedFacts.ofFile`, ADR-0035) only when its derivation
   takes that file's syntax tree and no other input. A derivation that reads the project, the listing or another file is
   kept by every input it reads, as before.
2. The receiver bindings of a Java file (`receiverBindingsOf`, slot `java-receiver-bindings`) are such a fact. The
   `receiver-methods` and `receiverFits` readers read them through it; `call-site-owner` reads the same helper without
   facts, so the derivation has one owner.
3. `provesBinding` answers once per project and inputs: a second call over the same project, the same files, the same
   unread sources and the same `unreadJvm` returns the first answer without reading a tree; any other input is read
   again.
4. The held project's key joins one fragment per source, each serialized once for the lifetime of the source object.
5. The answers are the bytes a cold read gives: the facts of an unchanged file are the values a derivation of its
   content answers, and the memo returns what the same computation answered over the same inputs.

## Consequences

- A one-edit live call derives the receiver bindings of the edited file only; the facts of the other files hit. A read
  computes `provesBinding` and the project key once instead of once per reader.
- Measured through the stdio MCP on the 1,340-file Java backend, `callers` p50 on this tree against the tree before it
  (two passes each): unchanged 7.2–8.6 s → 6.2 s, after one edit 15.5–16.6 s → 11.4 s, cold 18.3–19.5 s → 14.8–15.1 s.
  `impact` and the 1,736-file Angular webapp stay within noise.
- `relations`, `entrypoints` and the resolution of receiver calls are still re-derived over every file after any edit.
  They are the remaining cost of a one-edit call: about 5 s over an unchanged one on the Java backend.
- A new per-file fact asks one question of its derivation: what does it take besides the tree.

## Not decided here

- Per-file reuse of `relations`, `entrypoints` and receiver resolution: it needs the project to report which files a
  derivation read (a dependency record), or a proof that no reader of the project reads another file's body.
- The disk tier of ADR-0077 (unit U7).
