# ADR-0163: The MCP states its protocol once, publishes flattened schemas, and accepts the launch repository named again

- Status: Proposed, 2026-11-24
- Decision source: Owner, 2026-11-24: "Se debe analizar este problema en transversal y no caso a caso, para detectar
  los problemas de base estructurales y empezar a trabajar desde aqui con soluciones robustas, con algoritmos
  eficientes y aprovechando todo lo que se pueda lo que ya tenemos." (analyse this across the board and not case by
  case, find the structural problems and work from there with robust solutions, efficient algorithms and reusing all
  we already have). And: "reducir al maximo que se pueda el tamaño de las respuestas sin sacrificar calidad".
- Related: [RFC-0041](../rfc/0041-presentation-model-for-mcp-answers.md) §3.9;
  amends [ADR-0022](0022-typed-query-replay-and-selective-evidence.md) decision 1 (how a selection is described) and the
  `duplicate-repository` rule of RFC-0029 (ADR-0051) for one case; RFC-0005

**In short:** instructions about how to call the tools leave the replies and live once in the tool descriptions and
the server instructions. The published schemas are flattened with the existing compaction, without `$ref`. A `repos`
entry that names the launch repository at its own root is that repository, not a fault.

## Context

- Guidance is 6.9 % of reply bytes pooled, 14 % in `callers` and 25 to 27 % in `impact`: lookup lines, selector JSON
  on rows, pointers to the other mode, a guide that restates the request. In 133 agent calls `select` was used 3 times
  (1 success) and `expect` and `replay` never.
- tools/list is 35,454 bytes before the first call. `select`, `page`, `expect`, `replay`, `answerBytes` and
  `budget` are 10,105 of them; `workspace` is one schema repeated in four tools (3.7 KB); keywords that say nothing
  (`maximum: 9007199254740991` 31 times, nested `additionalProperties: false`) are about 3 KB.
- `answerBytes` was sent in 23 calls with values such as 200000, read as a way to get more.
- 8 of 28 invalid calls are `duplicate-repository` for the launch repository listed again in `repos`
  (`src/core/application/topology/workspace-plan.ts:173-181`).

| Schema option | For | Against |
|---|---|---|
| `$defs` and `$ref` | Standard | A definition is local to one tool's schema, so nothing is shared across tools; client support in tool schemas is not verified |
| **Flatten: opaque rarely-used fields, prune empty keywords** | Uses `compact-schema.ts` as it is; validation stays in zod | A model may write an opaque field wrong more often |

## Decision

1. A reply carries no instruction on how to call a tool. Selection examples, index conventions and reading rules are
   in the description of the parameter or tool they concern, once, or in the server instructions.
2. A reply may carry `next:` lines only for a cut or gap of that answer, each naming the parameter or tool that lifts
   it, once per distinct cause.
3. A section a selection addresses prints numbered rows in `details`; index markers on rows are removed.
4. The published input schemas are flattened: `select`, `workspace`, `budget` and the items of compose `queries` are
   published as opaque objects with a one-line shape and example; keywords that carry no information are pruned. The
   server validates with the full schemas and answers a wrong shape with the typed fault it has today. `$ref` is not
   used.
5. `answerBytes` is described as an upper bound that never adds content. It is not renamed.
6. An entry of `repos` whose id is the launch repository's and whose root is the launch repository's root is the
   launch member; its `revision`, when given, is the launch repository's for that call, and a different top-level
   `revision` is the existing conflict. The same id at another root, and one id twice among `repos`, stay
   `duplicate-repository`.
7. Rule 6 changes behaviour under `src/core` and passes the corpus gate; rules 1 to 5 are in `src/mcp`.

## Consequences

- Guidance falls from 6.9 % of reply bytes to an estimated 1 %; tools/list from 35.4 KB to under 24 KB; the
  instructions from 4.4 KB to about 3 KB while gaining the repository roots and the cache root (ADR-0161).
- 8 of 28 invalid calls disappear with rule 6 (14 more with ADR-0162 decision 6).
- An agent learns a selection from the schema description, not from each answer.

## Not decided here

- Removing `expect`, `replay` or `select`: they stay; only their cost in every reply and schema is cut.
- `$ref` once client support is verified.
