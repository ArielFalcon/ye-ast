# ADR-0160: An MCP answer is written by one writer from a presentation model each family maps its fact to

- Status: Accepted, 2026-11-24
- Decision source: Owner, 2026-11-24: "las soluciones a estos problemas se deben plantear de forma transversal,
  adaptable a cada herramienta mediante mecanismos de herencia o composicion segun mejor sea, pero no como parche
  ad-hoc para cada caso. Deben ser soluciones "de abajo hacia arriba" a nivel de arquitectura, eficientes y
  robustas." (the solutions must be cross-cutting, adaptable to each tool through inheritance or composition,
  whichever is better, never an ad-hoc patch per case; bottom-up at the architecture level, efficient and robust).
  And, on the target: "el objetivo es que al menos el 90% de la respuesta sea util" (at least 90% of the answer must
  be useful).
- Related: [RFC-0041](../rfc/0041-presentation-model-for-mcp-answers.md) §3.1 to §3.4, §4, §5;
  [ADR-0109](0109-the-mcp-answer-states-each-repeated-part-once.md) (extended to the text),
  [ADR-0051](0051-an-answer-never-hides-what-the-engine-knows.md), RFC-0017, RFC-0030

**In short:** the text of an MCP answer is no longer built by each tool. Each family maps its fact to a neutral
presentation model (sections with a role, rows with a fact key, a place, a label, qualifiers, evidence and children),
and one writer turns any presentation into text. Every rule that applies to all tools (a path once, no restated
evidence, counted elisions, order) lives in that writer, so a family gets it by producing rows.

## Context

Measured on 127 replies of the evaluation of 2026-11-23 (RFC-0041 §2): repeated paths are 17.8 % of reply bytes and
restated evidence 5.8 % of `details`; 43 % of the median `entrypoints` details reply is repetition. The cause is
structural: `src/mcp/render.ts` (2,107 lines) and `render-composition.ts` (944 lines) go from fact to string per
family, a place is always printed in full (`render.ts:62-64`), and de-duplication is about 30 local comparisons of
two candidate texts, one per block. ADR-0109 stated each repeated part once in the JSON projection; the text was
reduced only where a rule was written by hand.

| Option | For | Against |
|---|---|---|
| Keep per-family renderers and add rules where measured | No refactor | The same work per block for ever; the next family repeats the defect |
| A base renderer the families extend (inheritance) | One skeleton | The families share no skeleton (a tree, lists over repositories, nested answers); each difference becomes an override that writes text again |
| **A model the families map to and one writer (composition)** | Rules written once; a family is a pure mapping; rows are attributable to facts, which the metric and the tests need | A large migration of one 156 KB file |

## Decision

1. A presentation model lives in `src/mcp/presentation/model.ts`: `Presentation`, `Section` (role `answer`,
   `completeness` or `context`; layout `by-file`, `list` or `tree`), `Row` (key, place, label, qualifiers,
   evidence, children, tier) as RFC-0041 §3.2 specifies. It holds no behaviour and no mode.
2. Each query family provides one pure function from its fact to a `Presentation`, composed from shared row builders
   (declaration, entrypoint, link, call site, cut, name). A family returns no text and does not branch on the mode.
3. One writer (`src/mcp/presentation/writer.ts`) renders every presentation. It owns rules W1 to W8 of RFC-0041
   §3.4: section order by role, a path once per group, a common prefix, evidence equal to the row's place omitted,
   shared qualifiers once, one form of counted elision that is never longer than what it hides (RFC-0017 rule 1),
   stable order, indentation. It is a pure function: identical input gives identical bytes.
4. A row key is derived from the identity of the fact (repository, path, line, symbol, kind, name), never from an
   index-internal id or a list position. A fact is one row of one section.
5. An architecture rule forbids `src/mcp/presentation/families/**` from importing the writer. The model and the
   writer stay in `src/mcp`: they shape an answer and decide no fact.
6. The migration is family by family behind the unchanged renderer signature, under invariants I1 to I7 of RFC-0041
   §5 (no fact lost, `summary` within `details`, determinism, every row resolves to `answer.json`).
7. The core fact, the CLI, the library and the query protocol keep their output.

## Consequences

- The local size comparisons and the per-family text helpers of `render.ts` and `render-composition.ts` are deleted
  as each family migrates.
- A new family or section costs a mapping; it cannot ship a reply that repeats paths or restates evidence.
- Each printed row is attributable to a fact, so the evaluation can score replies by identity instead of by substring.
- ADR-0109 is extended: "a repeated part is stated once" holds for the text as a property of the writer.

## Not decided here

- The envelope (ADR-0161), the modes and paging (ADR-0162), where guidance lives (ADR-0163), the signature (ADR-0164).
- Whether the CLI gains a text presentation; if it does, the model's placement is decided then.
