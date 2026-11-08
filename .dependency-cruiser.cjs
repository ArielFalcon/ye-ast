/** Layering of ye-ast: AGENTS.md "Architecture" and docs/architecture/rfc/0001-architecture-and-layers.md. */
const ENTRYPOINTS = "^src/(cli|mcp|protocol|hooks|daemon)/";
const TESTS = "\\.test\\.ts$";
const TEST_RUNNER = "^(node:)?(test|assert(/strict)?)$";

module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "domain-sees-only-the-domain",
      comment: "A domain test may import the test runner and nothing else from outside the domain.",
      severity: "error",
      from: { path: "^src/core/domain/" },
      to: { pathNot: ["^src/core/domain/", TEST_RUNNER] },
    },
    {
      name: "domain-holds-no-io",
      comment: "Node built-ins are I/O; they belong behind a port.",
      severity: "error",
      from: { path: "^src/core/domain/", pathNot: TESTS },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "ports-see-only-the-domain",
      severity: "error",
      from: { path: "^src/core/ports/" },
      to: { pathNot: "^src/core/(domain|ports)/" },
    },
    {
      name: "application-sees-only-the-core",
      comment: "Use cases see the domain, ports and other use cases; their tests also see the test runner.",
      severity: "error",
      from: { path: "^src/core/application/" },
      to: { pathNot: ["^src/core/(domain|ports|application)/", TEST_RUNNER] },
    },
    {
      name: "application-holds-no-io",
      severity: "error",
      from: { path: "^src/core/application/", pathNot: TESTS },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "application-never-imports-adapters",
      comment: "Use cases reach technology through driven ports only.",
      severity: "error",
      from: { path: "^src/core/application/" },
      to: { path: "^src/core/adapters/" },
    },
    {
      name: "one-query-family-never-imports-another",
      comment:
        "A use case answers one query family. To read a revision it goes through application/snapshot, never by composing another family's use case. The files exempted here import another family today; src/composition/assembly-line.fitness.test.ts pins those imports pair by pair, and the list only shrinks (ADR-0045 decision 10).",
      severity: "error",
      from: {
        path: "^src/core/application/(composition|contracts|decisions|entrypoints|impact|outline|topology|trace)/",
        pathNot: "^src/core/application/(contracts/consumer-callers(\\.test)?|contracts/consumer-sources|decisions/decision-queries(\\.test)?|topology/workspace-discovery-live\\.test|topology/workspace-queries\\.test|trace/trace-queries)\\.ts$",
      },
      to: { path: "^src/core/application/(composition|contracts|decisions|entrypoints|impact|outline|topology|trace)/", pathNot: "^src/core/application/$1/" },
    },
    {
      name: "adapters-never-import-use-cases",
      severity: "error",
      from: { path: "^src/core/adapters/" },
      to: { path: "^src/core/application/" },
    },
    {
      name: "adapters-are-independent",
      comment: "An adapter talks to one technology; composition combines adapters.",
      severity: "error",
      from: { path: "^src/core/adapters/([^/]+)/", pathNot: "^src/core/adapters/spring/" },
      to: { path: "^src/core/adapters/", pathNot: "^src/core/adapters/$1/" },
    },
    {
      name: "spring-reads-only-the-java-parser",
      comment: "The one frozen exception to adapters-are-independent: the Spring extractor walks the Java parser's syntax trees.",
      severity: "error",
      from: { path: "^src/core/adapters/spring/" },
      to: { path: "^src/core/adapters/", pathNot: "^src/core/adapters/(spring|tree-sitter)/" },
    },
    {
      name: "angular-compiler-stays-in-its-adapter",
      comment: "ye-ast's own @angular/compiler is a vendored parser reached through one adapter (ADR-0014 decision 4); the analysed repository's copy is never loaded.",
      severity: "error",
      from: { pathNot: "^src/core/adapters/angular-compiler/" },
      to: { path: "node_modules/@angular/compiler" },
    },
    {
      name: "core-never-imports-the-outside",
      comment: "The core is the library; entrypoints and composition depend on it, never the reverse.",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/", pathNot: "^src/core/" },
    },
    {
      name: "entrypoints-see-ports-and-domain-only",
      comment: "An entrypoint receives its query families injected by composition.",
      severity: "error",
      from: { path: ENTRYPOINTS },
      to: { path: "^src/core/(application|adapters)/" },
    },
    {
      name: "entrypoints-are-independent",
      comment: "An entrypoint never imports another one; composition wires them.",
      severity: "error",
      from: { path: "^src/(cli|mcp|protocol|hooks|daemon)/" },
      to: { path: ENTRYPOINTS, pathNot: "^src/$1/" },
    },
    { name: "not-to-unresolvable", severity: "error", from: {}, to: { couldNotResolve: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
