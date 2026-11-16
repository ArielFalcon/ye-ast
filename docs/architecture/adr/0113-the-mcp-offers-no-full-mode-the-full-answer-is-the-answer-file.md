# ADR-0113: The MCP offers no `full` mode: the full answer is the answer file

- Status: Accepted, 2026-11-17, owner
- Decision source: Owner, 2026-11-16, round 3 of the MCP evaluation: "quita que el agente pida el modo full y se agrega
  esas lineas al final de summary y detail" (remove the agent's ability to ask for the full mode, and add those lines
  to the end of summary and details).
- Related: [ADR-0110](0110-every-mcp-answer-is-also-written-as-a-folder-of-files-an-agent-can-query.md) (decision 8
  superseded), [ADR-0022](0022-typed-query-replay-and-selective-evidence.md) (where it names `full`),
  [ADR-0109](0109-the-mcp-answer-states-each-repeated-part-once.md) (the projection `answer.json` holds),
  [RFC-0005](../rfc/0005-transports.md) "Presentation modes" and "Answer files",
  [RFC-0017](../rfc/0017-answer-size-and-outline.md)

**In short:** `mode` accepts `summary` and `details` only. The full JSON projection of ADR-0109 is no longer a reply: it
is `answer.json` in the answer folder of ADR-0110, and every `summary` or `details` reply ends with one line that names
that folder, says `answer.json` is the full result and that `jq` queries it. A reply with no folder says in one line
why none was written. `ye_ast_compose` writes its full composition to an answer folder the same way.

## Context

- The agent-track evaluation of round 4 (24 sessions) is the evidence. The MCP was selected in 2 of the 10 eligible
  sessions; both requested `mode: "full"` (one with `answerBytes: 200000`, one with `select` and `page`), never saw the
  `answer files:` line because a `full` reply carried none (ADR-0110 decision 7 put the line in `summary` and `details`
  only), read no answer file, and cost 890k tokens on average against 282k for the control.
- ADR-0110 decision 8 kept `full` unchanged "until the evaluation shows agents read the files". The evaluation shows
  the opposite order: the cheap, file-based path is invisible to an agent that asks for `full` first.
- `full` never had a use the file does not cover: `answer.json` holds the same bytes (its guide as the first field,
  then the fields of the full reply), and an agent queries the part it needs instead of reading the whole answer into
  its context.

## Decision

1. **The public `mode` is `summary | details`.** A call with `mode: "full"` is rejected by the input schema, which
   lists the accepted modes. This applies to the nine read tools and to `ye_ast_compose`. No alias exists, and the
   change needs no schema version: the MCP has no consumers yet.
2. **The full answer is `answer.json`.** Its bytes are those of ADR-0110 decision 7 and ADR-0109: the guide first, then
   the fields the `full` reply carried (including its `mode: "full"` field, the name of the projection). Nothing
   about the file changes.
3. **The reply line.** Every `summary` and `details` reply that wrote a folder ends with
   `answer files: <folder> — answer.json (the full result, queryable with jq): <sections>; summary.txt, details.txt`,
   where `<sections>` are the non-empty lists of ADR-0110 decision 7. The folder stays in `_meta` under
   `ye-ast/answer-files`.
4. **A reply without a folder says why.** When no folder was written (the server has no cache directory, the answer was
   cut by a deadline or holds `index-unavailable` (ADR-0110 decision 5), or the folder could not be written) the reply
   is `summary` or `details` and ends with `no answer file written: <reason>` in place of the line above. No other
   delivery of the full result exists.
5. **Hints point to the file.** A model-visible hint that named `mode: "full"` as the way to retrieve what a presentation
   omits names `answer.json`, with the path in it where the hint already named one.
6. **`ye_ast_compose`** writes its full composition (`kind: "composition"`, with its guide) as `answer.json` and its
   summary and details as `summary.txt` and `details.txt` under `answers/compose/<key>/`, through the same port and
   rules as the read tools (ADR-0110 decisions 1, 2, 4, 6, 9, 10), and its replies carry the same line and `_meta`
   sibling. The key is the digest of the composition's identity (`verification.identity`, which covers every read and
   its snapshot) and of its delivery sidecars. A composition whose verification is unavailable (a deadline, or a
   redacted or unresolved context) has no identity and writes no folder (decision 4). This answers ADR-0110 "Not
   decided here: the files of a composed answer".
7. **`select` and `page` stay for `summary` and `details`.** A selected reply carries its records in text, as its
   summary and details always did; the projection fields only `full` returned (context and items) are not delivered
   inline. A selected reply is a projection of one answer and writes no folder (ADR-0110 decision 8 stands for it);
   the answer it selects from is the plain query.
8. **Supersedes** ADR-0110 decision 8. **Amends** ADR-0022 decision 2: where it says `full` returns the complete
   fact or the whole selected page, that data is `answer.json` of the unselected query, and a selected page is read
   from its text records. RFC-0005 and RFC-0017 are updated where they name the mode.

## Consequences

- An agent can no longer pull a whole answer into its context in one call; the cheapest path is the only path.
- Every reply is one of two bounded presentations plus one line. A server with no cache directory loses the structured
  full answer entirely, and says so on every reply; the stdio MCP of the CLI has the per-user cache directory unless
  the platform gives none.
- `answerBytes` bounds the text of `summary` and `details` as before; it no longer has a `full` reply to shorten.
- The exported output schemas still describe `answer.json`; the server validates the full fields against them before
  writing the file.

## Not decided here

- The removal of `select` and `page`, decided by the next agent-track evaluation.
- A normalized or columnar format of `answer.json` (ADR-0110 "Not decided here").
- Reusing a stored answer instead of rerunning the query.
