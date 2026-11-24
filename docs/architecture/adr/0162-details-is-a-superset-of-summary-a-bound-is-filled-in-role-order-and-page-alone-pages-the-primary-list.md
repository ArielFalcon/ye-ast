# ADR-0162: `details` is a superset of `summary`, a byte bound is filled in role order, and `page` alone pages the primary list

- Status: Proposed, 2026-11-24
- Decision source: Owner, 2026-11-24: "el objetivo es que al menos el 90% de la respuesta sea util, ya sea eliminando
  lo inutil, agregando info util que se desaprovecha o no se tiene hoy, restructurando lo que haga falta." (at least
  90% of the answer must be useful, by removing what is useless, adding useful information that is wasted or missing
  today, restructuring what is needed). And: "reducir al maximo que se pueda el tamaño de las respuestas sin
  sacrificar calidad" (reduce the size of the answers as much as possible without sacrificing quality).
- Related: [RFC-0041](../rfc/0041-presentation-model-for-mcp-answers.md) §3.5 to §3.7;
  amends [ADR-0113](0113-the-mcp-offers-no-full-mode-the-full-answer-is-the-answer-file.md) decisions 1 and 7 (what the
  two modes mean; `page` without `select`),
  [ADR-0022](0022-typed-query-replay-and-selective-evidence.md) decision 6 ("page controls apply only with a supported
  select"), [ADR-0051](0051-an-answer-never-hides-what-the-engine-knows.md) decision 3 (how a bound is met);
  RFC-0017 section 1, RFC-0005 "Presentation modes"

**In short:** both modes are readings of one presentation: `summary` prints the rows, `details` prints the same rows
plus their evidence and every upper tier. A declared byte bound is filled answer rows first, with every omission
counted and continued by a cursor. `page` without `select` pages the tool's primary list, on every read tool.

## Context

- `details` is not a superset today: in `callers`, `summary` holds facts `details` lacks in 10 of 11 pairs and is
  the larger reply in 9 (`render.ts:708-730`); `importers` and `outline` print the same facts in both. Agents asked
  for `details` in 121 of 133 calls, and 7 % of `summary` bytes point to the other mode.
- What is listed is decided per section: a workspace summary counts its links and lists every place of a name
  (`render.ts:1448-1453`, `1638-1666`); 81 % of its oracle identities are only in `answer.json`.
- `answerBytes` is applied after rendering: all, else the summary, else a refusal (`render-budget.ts:28-35`).
- 14 of 28 invalid agent calls are `page` without `select` (`evidence-schema.ts:118`).

## Decision

1. A family builds one presentation for both modes (ADR-0160). `summary` prints every tier-0 answer row; upper tiers
   are listed when the section has at most `LISTED_ITEMS` rows and counted by tier otherwise; evidence beyond a row's
   own place is a count on the row; completeness is one line per cut kind and cause; a context section lists up to
   `LISTED_ITEMS` rows. `details` prints every row, the evidence and the cut places.
2. Every row `summary` prints, `details` prints. A test holds it for every family. Where a family has nothing more to
   show, the two modes are equal and the reply does not mention the mode.
3. No reply points to the other mode. An omission is one counted line naming the member of `answer.json` that holds
   the rest and, when one exists, the cursor that continues it; it is used only when shorter than what it replaces.
4. No new presentation constant is added. `LISTED_ITEMS` keeps its value; it never counts tier-0 answer rows.
5. A byte bound (`answerBytes`, request or host) is filled in order: status and completeness lines, answer rows
   (tier 0 first), completeness places, context. Rows that do not fit are counted (rule 3). When the status, the
   completeness lines and the count lines do not fit, the reply is the existing `answer-over-bound` refusal. The
   result is a function of the presentation and the bound.
6. `page: { limit, cursor? }` without `select` pages the presentation's primary section; each of the nine read tools
   declares one. The cursor is the existing one (result identity, selection digest, limit, offset) and needs an
   available recovery. `select` with `page` is unchanged.
7. `mode` keeps `summary | details` and its default.

## Consequences

- A `details` reply of `callers` or `impact` grows where it used to drop rows, and shrinks by the repetition the
  writer removes.
- A workspace summary lists its links; a trace summary lists its steps.
- A bounded reply keeps its answer rows instead of falling back wholesale; ADR-0051 decision 3 holds because the
  shorter projection counts every omission and nothing is truncated.
- `page` is added to the schemas of six tools; the largest class of invalid calls disappears.

## Not decided here

- A default bound on answer rows: none is added without measurements on real repositories.
- Paging of a section other than the primary one without `select`.
