# ADR-0013: Coverage grows only with evidence

- Status: Accepted, 2026-10-30, owner
- Decision source: the owner, 2026-10-30 (translated): "Record the decisions on how to approach the implementation of
  Angular and Java with Spring, with all the information you obtained. Cover the general rules to consider for adding
  features to the compiler, and everything that must be in place to close these requirements." The rules were first
  proposed by that day's Angular coverage analysis.
- Related: [ADR-0007](0007-dependency-versions.md), [ADR-0009](0009-route-data-in-two-levels.md),
  [ADR-0010](0010-trust-modes.md), [ADR-0014](0014-angular-and-spring-from-own-extractors.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0006](../rfc/0006-configuration.md),
  [RFC-0007](../rfc/0007-extension-model.md)

**In short:** ye-ast's facts belong to five families, and a sixth needs an ADR. A framework, a protocol or a construct
enters only with a parser library or a grammar, fixtures that fail first, measured real applications and a parity
diff; an application's own idioms are data, never plugin code. What a plugin cannot resolve is `unknown`, and a
framework with its own extractor owns its facts, which narrows ADR-0009 decision 1.

## Context

- Coverage is a long tail. Parsing grows by one parser per framework, and the parsers exist as libraries:
  `@angular/compiler`, `@vue/compiler-sfc` and `svelte/compiler` ship standalone (npm, 2026-10-30). Semantics grow by
  application idiom, without a bound: route wrappers, URL helpers, base classes, custom event libraries.
- Breadth without depth fails silently. codegraph 1.6.2 covers about 20 frameworks, and its Angular and Spring route
  extractors match regular expressions against a fixed list of shapes ([ADR-0009](0009-route-data-in-two-levels.md)).
  On real applications, on 2026-10-30, an Angular app whose routes are typed through a type derived from `Route` got 0
  route nodes for 43 screens, and a Spring file whose class prefix is not a literal lost every route. Neither case
  answers `unknown`.
- Growth by application leaves thresholds and catalogs behind. qayaba's route extractor reads at most 4,000 files
  (qayaba@4105c582 `qa-engine/src/contexts/generation/infrastructure/route-table/route-tables.source.ts:24`); its call
  catalog matches literal paths only and its event catalog matches one custom library
  (`qa-engine/src/contexts/service-topology/infrastructure/{call,event}-pattern-catalog.ts`).

| Option | For | Against |
|---|---|---|
| A. Add a construct when a user reports a miss | Fast for the first application | Grows per idiom with no bound and no measure; a user finds the miss, not a fixture |
| B. Breadth first: shallow extractors for many frameworks | Wide coverage early | The silent failures above, and the breadth codegraph already gives |
| **C. Grow by evidence, inside fixed families** | Each addition is measured and bounded; a miss is explicit | A framework waits for its parser, its fixtures and its measurements |

## Decision

1. **Five families.** ye-ast's facts belong to five families: impact, entrypoints, cross-service links, consumer field
   reads and unused files (the [README](../../../README.md)'s "What it answers"). A new family needs an ADR. A framework
   whose coverage needs a family outside the five stops there, and its coverage is decided again.
2. **Parsers, never builds.** A plugin parses with a parser library of its language or framework (the TypeScript
   compiler API, `@angular/compiler`) or with a tree-sitter grammar, loaded from ye-ast's own dependencies, never from
   the repository. Nothing is installed, built, compiled or run ([ADR-0010](0010-trust-modes.md) decision 4). A
   framework without such a parser answers `no-extractor`.
3. **Pinned parsers.** Every parser is pinned exactly ([ADR-0007](0007-dependency-versions.md)). A parser outside its
   project's semantic versioning is treated as vendored: its upgrade runs every fixture of every framework major the
   plugin declares. A parse error is `unknown` with `source-unreadable`, never a crash.
4. **A framework or a protocol enters measured.** A plugin enters with conformance fixtures and at least two measured
   real applications. On each application, a parity diff per family against the strongest reference available
   (codegraph's breadth, a module moved from qayaba, a contract, or an offline oracle) accounts for every entry: found,
   `unknown` with its reason, or added with evidence. The plugin's section of [RFC-0007](../rfc/0007-extension-model.md)
   records the results and describes the applications by shape; their names stay outside the repository.
5. **A construct enters with a failing fixture.** A construct is one source shape an extractor reads. It enters with a
   fixture that fails first, taken from a measured application or from the framework's documented API. A shape that
   neither shows is not added.
6. **Idioms are data.** A team's wrappers, URL helpers, base URLs and event libraries are declared in the workspace
   manifest's `boundaries[]` ([RFC-0006](../rfc/0006-configuration.md)). A plugin's code covers the framework's
   documented API only.
7. **Fail loud.** A construct a plugin reads but cannot resolve is an item `unknown` with its reason, at its source
   location. A construct it detects but does not extract is an item `unknown` with `no-extractor`. A bound that stops
   it is a cut. No extractor drops an entry silently or compares a count of files or lines with a constant
   ([RFC-0002](../rfc/0002-facts-contract.md) rule 1).
8. **One owner per fact.** When a framework has its own extractor, that extractor owns the framework's facts, and
   codegraph's facts of the same family for that framework are not used. codegraph's generic graph (files, symbols,
   imports, calls, `implements`) stays the base. This narrows [ADR-0009](0009-route-data-in-two-levels.md) decision 1
   to frameworks without their own extractor.
9. **Declared level.** Each plugin declares its level per family in the capability matrix
   ([RFC-0007](../rfc/0007-extension-model.md)); a family at `none` answers `no-extractor`.
10. **Scope.** v1's depth covers Angular on TypeScript and Spring on Java
    ([ADR-0014](0014-angular-and-spring-from-own-extractors.md)). Any other framework enters through these rules.

## Consequences

- A plugin pays its measurement before it lands: fixtures, two applications and one parity diff per family.
- A framework outside v1 keeps codegraph's breadth where codegraph makes route nodes, and answers `no-extractor` for
  depth ([ADR-0009](0009-route-data-in-two-levels.md) decision 5).
- qayaba's call and event catalogs become `boundaries[]` data when they move
  ([RFC-0009](../rfc/0009-extraction-from-qayaba.md)), and its 4,000-file route cap does not move as a constant: a
  budget that stops an extractor is a profile value reported as a cut.
- A miss found on a real application becomes a fixture before it becomes a fix.

## Not decided here

- Which framework follows Angular and Spring.
- Contributions to codegraph that would shrink an own extractor: deferred by the owner
  ([RFC-0003](../rfc/0003-codegraph-integration.md)).
