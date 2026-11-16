# ADR-0110: Every MCP answer is also written as a folder of files an agent can query without reading it whole

- Status: Accepted, 2026-11-16, owner
- Decision source: Owner, 2026-11-16, round 3 of the MCP evaluation b86cb1: "la solucion de entrega por archivo me
  parece perfecta ... la respuesta ... funcionar como un index ad-hoc de cada herramienta y su estructura de respuesta,
  es decir ser documentacion e index" (the delivery by file seems perfect to me ... the answer should work as an ad-hoc
  index of each tool and its response structure, that is, be documentation and index), with the folder
  "answers/<herramienta>/<input>-<hash>/[full.json|detail.txt|summary.txt]"; and "este mcp ES el IDE del agente, tiene
  que estar pensado para aguantar ese ritmo" (this MCP is the agent's IDE; it must withstand that pace).
- Related: [ADR-0109](0109-the-mcp-answer-states-each-repeated-part-once.md) (the full projection written here),
  [ADR-0027](0027-retention-of-immutable-index-entries.md) (retention reused), [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md)
  (reader versions; memoization stays later), [ADR-0024](0024-every-query-family-stamps-one-producer-version.md),
  [RFC-0002](../rfc/0002-facts-contract.md) rules 3 and 8, [RFC-0005](../rfc/0005-transports.md) "Live freshness",
  [RFC-0006](../rfc/0006-configuration.md) `store`, [RFC-0010](../rfc/0010-impact-queries.md) "Retention"

**In short:** When the MCP runs with ye-ast's per-user cache directory, each answer is also written, once, as a folder
`answers/<tool>/<key>/` holding `answer.json` (the full JSON projection of ADR-0109, with its guide as the first field),
`summary.txt` and `details.txt`, so an agent can run `jq` or `python` over the parts it needs instead of reading the
expensive `full` content into its context. The reply names the folder and the sections it holds. ye-ast never reads
these files back: they are a delivery artifact, and the key is proven complete by a shadow check before any reuse.

## Context

- A `mode: "full"` reply carries the whole structured answer in the agent's context; after ADR-0109 it is 10% smaller,
  and one answer can still be hundreds of kilobytes. `select` and `page` fetch a part of an answer only for three
  tools and three kinds of evidence. An agent with a shell can already query a file; what it lacks is the file.
- The MCP has no answer store: every call reruns the query. Reusing a stored answer is a separate decision (a stored
  answer must be valid for its exact inputs, and live answers move with the working tree); it is gated on measurements
  and is not taken here.
- The index cache (ADR-0015, ADR-0027) already owns a per-user directory, mode 0700, a retention rule by last use and
  bytes, and the habit of building an entry aside and publishing it by rename.

## Decision

1. **Layout.** `<cache root>/answers/<tool>/<key>/` holds `answer.json`, `summary.txt` and `details.txt`. `<tool>` is the
   query family (`entrypoints`, `impact`, `callers`, `importers`, `outline`, `trace`, `workspace`, `decisions`,
   `contract_consequences`); `<key>` is a hexadecimal digest. No label derived from the arguments is part of the name:
   an argument is an agent-supplied string, and a name built from it would need rules for traversal, separators,
   length and the names a file system reserves. `<cache root>` is the directory of the index cache (ADR-0077 decision 6,
   `--cache`). With no cache directory no file is written and every reply is unchanged.
2. **A write-only delivery artifact.** ye-ast never reads these files back as facts, and no query consults them. The
   folder is built in a temporary directory beside it and renamed into place, so a reader sees all three files or the
   folder is absent. When the folder already exists with the same `answer.json` it is kept; with other bytes it is
   replaced by the new answer (the old one is first moved aside under a build name, so the files a reply names are
   always the ones that reply was built from). The directories are created with mode 0700 and the files
   with 0600; a directory that is a symbolic link, belongs to another account or is open to the group or others is not
   written to (the rule of the index cache).
3. **The key** is the digest of the canonical JSON of: the tool; the semantic arguments of the call (those without
   `mode`, `select`, `page`, `expect` and `answerBytes`); the fact's `schema`, `producer`, `snapshot`, and the `trust`,
   `scope`, `content`, `config`, `engines` and `buildOutputs` of its `inputs`; and an engine identity. The producer
   version does not change between commits (ADR-0024), so the engine identity is what the build already versions: the
   package version, `SCHEMA`, the staging rules and written-universe versions, and the supported codegraph store range.
   It does not change when a rule inside a reader changes without bumping one of them. That gap is not covered by
   inventing a version: it is what decision 4 detects, and it is why nothing reuses these files yet.
4. **Shadow check.** When the folder of a key exists and the new `answer.json` differs from its bytes, one line is
   written to stderr, naming the tool and the folder, the folder is replaced (decision 2), and the reply is unchanged
   and not failed. A key that never
   produces this line over real use is complete; the first line is a missing input to add to the key. Reuse of a stored
   answer waits for that evidence.
5. **What is never written.** An answer cut by a wall-clock deadline (a `deadline` cut or unknown reason anywhere in
   it) and an answer that holds an `unknown` with reason `index-unavailable` anywhere in it write no folder: they are
   outside the determinism promise (RFC-0002 rule 3, RFC-0010) and a reader of the folder could take them for the
   answer to the same inputs. The reply then names no folder.
6. **Redaction.** The files leave the process, so they hold exactly what the reply text holds: the files are built from
   the redacted public fact the reply is built from, never from the fact the core returned. A test holds it.
7. **The reply.** The `summary` and `details` text ends, before the `result JSON:` line, with one line:
   `answer files: <folder> — answer.json: <section> <count>, ...; summary.txt, details.txt`, where the sections are the
   non-empty lists of the answer's `value` (and of its nested facts' `value`) and its `cuts`. The same folder is a
   response-level sibling of the fact in `_meta` under `ye-ast/answer-files`, in every mode, like the live freshness
   signal (RFC-0002 rule 8): never a field of the fact, so the fact keeps its bytes. `answer.json` is compact JSON whose
   first field is `guide`, the text the `full` reply prints before its result JSON: the file documents itself, and no
   legend is a new artifact. `summary.txt` and `details.txt` are the text of those two modes.
8. **`mode: "full"`, `select` and `page` are unchanged.** *(`full` removed by [ADR-0113](0113-the-mcp-offers-no-full-mode-the-full-answer-is-the-answer-file.md), which supersedes this decision for it.)* Their bytes and fields stay as ADR-0109 left them; only the
   `_meta` sibling is added to a `full` reply, and a `select`/`page` reply and a composed answer write no folder. Removing
   `full` is decided later by the evaluation, once it shows agents read the files.
9. **Retention has its own budget.** `answers/` is swept once per written answer, after the write, by the rule the live
   tree and the index cache use (`retentionDiscards`): a folder unused for `unusedForMs` goes, then the least recently
   used until the logical bytes are within `maxBytes`; never the folder just written, which is published whole, and
   never failing the answer. Last use is the modification time of `answer.json`, refreshed when the same key is written
   again. A temporary directory unwritten for the debris bound (`DEBRIS_STALE_MS`) is removed. The values are those of
   the index cache (14 days, 512 MiB) by the same analogy as ADR-0027, and the budget is separate, so answers never
   evict indexes and indexes never evict answers. A host that composes the answer files passes its own budget, as it does `indexRetention` for the index cache.
10. **Architecture.** The core declares one driven port, `AnswerFiles`, in `core/ports/answer-files.port.ts`; an `fs`
    adapter implements it; composition builds it from the cache directory and hands it to the MCP beside the query
    families, never inside them. `QueryExecutionDeps` keeps its guarantee ("nothing here can write, by type"): the
    writer is a field of `McpDeps` only, and no read query family receives it. Writing ye-ast's own answer files is not
    a write an agent reaches: the MCP still exposes no write tool, an agent supplies no path, name or content of a file,
    and what is written is the answer to the agent's own read, in ye-ast's own directory, as the index cache and the
    fixed layer already are.

## Consequences

- An agent can answer a follow-up (the places of one cut, one repository's links) with a query over the file at the
  price of the query, not of the whole answer. How much that saves is measured by the next evaluation.
- Disk use grows by the answers of a session, bounded by decision 9.
- A reply carries one more line and one more `_meta` entry; both are absent without a cache directory.
- The write follows the answer, in the same process, within the call: it is local file I/O of the answer's size. A write
  that fails reports one stderr line and the reply goes out without the line; the query never fails because of it.
- The index cache's sweep keeps its own lease machinery for readers that hold a store open; the answer sweep needs none
  (a folder is published whole and never held open by ye-ast), so it shares the pure rule, not the loop. The two loops
  live in different adapters, which may not import each other.

## Not decided here

- Reusing a stored answer instead of rerunning the query (memoization through `DerivedFacts`, ADR-0077): gated on the
  shadow check of decision 4 and on the live burst measurement.
- A normalized or columnar format of `answer.json`: decided by the evaluation, which compares tokens and misreads.
- The measured retention values of `answers/`; 14 days and 512 MiB are carried over by analogy.
- The files of a composed answer.
