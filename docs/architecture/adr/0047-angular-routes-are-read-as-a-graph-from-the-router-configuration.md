# ADR-0047: Angular routes are read as a graph from where the router is configured

- Status: Accepted, 2026-11-09, owner
- Decision source: Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (settle every open question as recommended), after "aplica el orden que recomiendas" and "los ADR recogen decisiones mas acotadas referentes a un RFC".
- Related: [RFC-0025](../rfc/0025-angular-route-tables.md) designs this decision; ADR-0041, ADR-0042, ADR-0044, ADR-0045

**In short:** The route reader walks a graph of root configurations, `@NgModule` classes and route tables from the router's configuration, so `forChild` tables, string `loadChildren` and module imports yield routes with their real prefix; an `include` narrows only the answer.

## Context

The study's route items failed on three mechanisms: route tables are seeded only from `forRoot`/`provideRouter`, `loadChildren` is read only as a dynamic `import()`, and an `include` narrows the export so the root table is never read. RFC-0025 holds the evidence and units.

## Decision

1. The Angular router's configuration is read as a graph from where the router is configured, never by file name; a table's path prefix comes from the graph.
2. `@NgModule({ imports })` has one owner, the Angular metadata extractor; the route reader consumes its output and follows spreads through it, failing closed on an unreadable operand.
3. A narrowing `include` narrows a fact's answer, never the configuration that interprets it: a family may read beyond the selection to interpret it, and reports only what the selection covers (extends ADR-0042 rule 4).
4. The entrypoint map carries the cuts of its reading: a place where the route walk stopped is a cut with a reason and a reach, never only an `unknown` item (extends ADR-0042 decision 6).

## Consequences

- The delivery units, their order and their tests are in RFC-0025, and each unit names the units of other RFCs it waits for.

## Not decided here

- The cost of reading the whole Angular configuration for `map` under an `include` is measured in RFC-0025 U5, not decided here.
