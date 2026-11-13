# ADR-0078: Locating a declaration by name is a query family, and the fixed layer is readable as MCP resources

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados" (I approve
  every pending recommendation; leave them closed), after "estas propuestas de correccion y mejoras deben ser de forma
  transversal y no parches puntuales" (the corrections and improvements must be cross-cutting, not point patches).
- Related: RFC-0038 (design), ADR-0032, ADR-0051, RFC-0005, RFC-0029
- Under: ADR-0013 decision 1 (a new family needs an ADR; this is that ADR)

**In short:** a new query family, `locate`, answers the declarations and files a name or a path fragment designates,
with a match class and no score. A fault that rejects a coordinate carries the same answer. The fixed layer `ye-ast init`
writes is exposed as read-only MCP resources. No tool reads source text, and no default answer size is set.

## Context

Every tool takes a coordinate and none gives one. In the agent evaluation of 2026-11-08, 28% of calls faulted, all 29
`unknown-symbol` faults came from an invented path, and 52% of the addressable fallbacks to search happened where a
family covered the need and was not tried. The store already answers "every declaration of this name"
(`src/core/ports/code-graph.port.ts:102`), for trace only. The MCP registers no resource.

| Option | Verdict |
|---|---|
| Leave discovery to the agent's search tools | Rejected: the measured faults are the cost of that choice |
| A fuzzy symbol search with a rank | Rejected: a score is a guess, and its noise grows with the repository |
| An exact matcher with match classes, as a family | Chosen |

## Decision

1. `locate` is a query family: names and path fragments in; declarations and files out, each with a match class
   (`exact`, `qualified`, `case`).
2. It is deterministic and unranked. It matches no substring of a name.
3. Its declarations come from the shared declaration model, so every coordinate it returns is one the other families
   accept.
4. Its completeness follows the facts contract. A name with no declaration is a `complete` empty answer; an unindexed
   file is a cut.
5. With a declared workspace it searches every repository and states the repository of each match.
6. A fault that rejects a file or a symbol carries the matcher's answer for it. The one owner of fault text calls the
   same matcher.
7. The tool fits under the tested catalogue ceiling. The ceiling is not raised for it.
8. The entrypoints fact, its digest and the workspace overview are MCP resources: read-only projections of facts a
   family already answers, each stating its snapshot.
9. Decision 8 lands after the baseline of the outcome control (ADR-0071), which measures whether it changes adoption.
10. No default answer bound is added, and no prompt is registered.

## Consequences

- An agent that knows a name makes one call and holds a coordinate, or reads it from the fault.
- One more tool and one more family to expose on every surface (ADR-0032) and keep conformant per language pack.
- The MCP stays read-only: it still receives only read query families and the store port of the fixed layer.

## Not decided here

- Grouping test files in `impact` answers.
