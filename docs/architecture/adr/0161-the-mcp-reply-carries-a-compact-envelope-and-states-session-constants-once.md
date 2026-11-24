# ADR-0161: The MCP reply carries a compact envelope and states session constants once

- Status: Proposed, 2026-11-24
- Decision source: Owner, 2026-11-24: "Parte del proceso este es tambien reducir al maximo que se pueda el tamaño de
  las respuestas sin sacrificar calidad. buscar ese equilibrio." (part of this process is also to reduce the size of
  the answers as much as possible without sacrificing quality; find that balance). And, 2026-11-16 (ADR-0109): "Una
  respuesta no debe contener informacion que no es util para la funcion que realiza" (an answer must not contain
  information that is not useful for the function it performs).
- Related: [RFC-0041](../rfc/0041-presentation-model-for-mcp-answers.md) §3.8;
  amends [ADR-0110](0110-every-mcp-answer-is-also-written-as-a-folder-of-files-an-agent-can-query.md) decision 7,
  [ADR-0113](0113-the-mcp-offers-no-full-mode-the-full-answer-is-the-answer-file.md) decision 3,
  [ADR-0022](0022-typed-query-replay-and-selective-evidence.md) decision 3 (where the result identity is delivered);
  RFC-0002 rule 8, RFC-0005 "Answer files"

**In short:** a reply opens with its status and snapshot and closes with one short pointer to `answer.json`. The
`result JSON:` line, the recovery pointer, the absolute folder with its inventory, the repository roots and the
declared scope leave the text: what is constant for the session is said once in the server instructions, and what a
client or a replay needs is in `_meta` and in `answer.json`.

## Context

The envelope is 14.8 % of reply bytes pooled and 26 % of the median `summary` reply (RFC-0041 §2, M1).
`result JSON:` (`src/mcp/server.ts:49-54`) repeats the mode, the status and the snapshot of the first lines and
echoes the request as `recovery.query`; in 133 agent calls `expect` and `replay` were never used. The
`answer files:` line (`answer-files.ts:64-67`) is about 350 bytes with an absolute host path, which agents copied
into their answers; 14 of 40 sessions opened the folder. `repository root:` and `declared scope:` are the same on
every reply of a session (121 of 127 for the scope).

## Decision

1. The text of a `summary` or `details` reply is: the status line, one `snapshot:` line per repository read with its
   full sha (`merge base:` on `impact`), the narrowing lines only when the caller narrowed, the sections, and one
   closing line.
2. The closing line is `answer: answers/<tool>/<key>/answer.json`, relative to the cache root the server instructions
   name once. The absolute folder stays in `_meta` under `ye-ast/answer-files`. The section inventory is not
   printed; an omitted part is named by the elision line of its section (ADR-0160).
3. A reply with no folder keeps `no answer file written: <reason>` (ADR-0113 decision 4).
4. The fields `mode`, `status`, `snapshot`, `recovery` and an unknown `reason` are delivered in `_meta` under
   `ye-ast/result`, with or without a byte bound, and remain in `answer.json`. The `result JSON:` line and the
   recovery pointer line are removed. The recovery recipe and the result identity are read from `answer.json`.
5. The server instructions list every declared repository with its root, the declared scope of the launch repository
   and the cache root of the answer folders. A reply prints a root only for a repository neither the instructions nor
   the request named, and a declared scope only when it differs from the one the instructions state.
6. A property of a tool (for example that `callers` and `impact` list no test dependents) is stated in the tool's
   description, not in its replies.
7. One function builds the envelope for every family. Redaction applies as before to everything that leaves the
   process.

## Consequences

- About 800 bytes less per `summary` reply; transport falls from 14.8 % to an estimated 2 to 3 %.
- No host path appears in the reply text.
- An agent that replays or asserts an identity opens `answer.json`; a client that branches on the result reads
  `_meta`. A client that parsed the `result JSON:` line must change; the MCP has no consumers yet.
- The snapshot stays in every answer (RFC-0002), and the facts keep their bytes.

## Not decided here

- Whether the pointer falls back to an absolute path: RFC-0041 open question 1, settled by the evaluation after the
  unit lands.
- The shape of a selected reply (`select` with `page`) beyond its header and closing line (ADR-0113 decision 7).
