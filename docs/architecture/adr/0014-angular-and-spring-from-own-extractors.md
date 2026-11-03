# ADR-0014: Angular and Spring from own extractors over parser libraries

- Status: Accepted, 2026-10-30, owner
- Decision source: the owner, 2026-10-30 (translated): "the coverage of Angular and of Java with Spring must be added
  solidly", deciding [RFC-0007](../rfc/0007-extension-model.md) Q1; then, on the plan built from that day's two
  coverage analyses: "Record the decisions on how to approach the implementation of Angular and Java with Spring, with
  all the information you obtained."
- Related: [ADR-0004](0004-codegraph-dependency-with-own-fact-layer.md), [ADR-0008](0008-typescript-compiler-api-source.md),
  [ADR-0009](0009-route-data-in-two-levels.md), [ADR-0010](0010-trust-modes.md),
  [ADR-0012](0012-foundation-before-qayaba-migration.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md),
  [RFC-0003](../rfc/0003-codegraph-integration.md), [RFC-0004](../rfc/0004-deterministic-map.md),
  [RFC-0006](../rfc/0006-configuration.md), [RFC-0007](../rfc/0007-extension-model.md)

**In short:** for Angular and Spring, codegraph gives only the generic graph, and every framework fact comes from
ye-ast's own extractors: the TypeScript compiler API with the standalone `@angular/compiler` for Angular, tree-sitter-java
for Spring. Nothing is built or run, and what the source cannot resolve is `unknown`. RFC-0007 holds the design per gap;
the coverage is done when the checklist below holds. Estimate (hypothesis): 21-28 days for Angular, 17-29 for Spring.

## Context

Measured on 2026-10-30 with codegraph 1.6.2 on `git archive` exports of five real applications, plus synthetic fixtures
for the constructs they lack: an Angular 21 standalone app (145 components, routes typed through a type derived from
`Route` and built by a helper); a JHipster-generated Angular 21 gateway over Spring WebFlux services; two
OpenAPI-codegen Spring services on Boot 3.5; and a Boot 4.0 microservices application. That is two Angular and four
Spring measurements. `bundle:` is codegraph's platform bundle `lib/dist/`.

| Family | Angular | Spring |
|---|---|---|
| Entrypoints | 0 route nodes for 43 screens: a route array is recognised only after `: Routes =`, `: Route[] =`, `forRoot` or `forChild`, `provideRouter`, `export default`, or before `as` or `satisfies Routes` (`bundle:resolution/frameworks/angular-router.js:106,350`). 50 of 57 on the other app, which loses single-`Route` constants and a named outlet. Guards are not read | A regular expression (`bundle:resolution/frameworks/java.js:203-286`). A class prefix that is not a literal drops every route of the file; a second class in a file inherits the first one's prefix; handlers are linked by method name (48 of 71 edges at 0.7 or below on one app); `method = {GET, POST}` keeps GET; composed annotations, `${...}` placeholders and Spring 7's `version` are lost; `@FeignClient` mappings become server routes; listeners are plain methods without their topic. Generated `*Api` interfaces are absent from a source snapshot, so both codegen services have 0 routes |
| Impact | `inject()`: 0 of 668 sites linked. Directives 0 of 156 and pipes 0 of 11 linked; `.html` files are not indexed | Records get no node (`bundle:extraction/languages/java.js:233`): a service with 50 records leaves 145 references and 39 instantiations unresolved. Interface-to-implementation bridges are heuristic edges that spend walk depth: 0 of 42 persistence methods reach a controller within 3 hops |
| Cross-service links | 0 edges from 76 `HttpClient` and 10 `httpResource` sites to 102 Spring routes: only a URL that starts with a quote or a backtick matches (`bundle:resolution/tier-synthesizer.js:162-173`) | `RestTemplate`, `WebClient`, `RestClient` and `@HttpExchange` sites stay unresolved text. Configuration values are dropped because "Config files routinely hold secrets" (`bundle:resolution/frameworks/java.js:331-337`): no context path, base URL, gateway route or profile |
| Consumer field reads | None; 36 of the 95 DTO fields read are read only in templates | None; records and annotation arguments (`@JsonProperty("x")`) are lost |
| Unused files | A file loaded only through `import()` has no importer | Beans look unused: stereotype beans are 15 of 22, 4 of 8 and 19 of 23 of the types without a static inbound edge |

What qayaba@4105c582 (`qa-engine/src/`) brings:
- **Angular.** Its shape-based route extractor read 62 of 62 entries, with 10 of 10 lazy children and their guards, but
  keeps no target (`component`, `loadComponent`), rejects identifier arrays, drops spreads silently, leaves NgModule
  lazy children unresolved and reads at most 4,000 files (`contexts/generation/infrastructure/route-table/`). Its URL
  evaluator has no call, arrow or object case (`.../consumer-expectation/typescript-expectations.ts:332`), so
  `getEndpointFor('api/x')` and `httpResource(() => ({ url }))` stay unresolved (hypothesis, from reading). The
  analysis counted 1,583 reusable lines in its Angular and TypeScript depth modules.
- **Java.** No decision, statement or module syntax (`shared-kernel/language-id.ts:27,37-40`), and no route, DTO or
  configuration extractor. Call sites come from a regular-expression catalog with literal paths only, events from one
  custom library's shape, operations only from OpenAPI documents, matched with a fixed confidence of 1.0.

| Option | For | Against |
|---|---|---|
| A. codegraph's framework extractors, fixed upstream | No own extractor | They fail silently today; resolvers cannot be plugged in ([ADR-0009](0009-route-data-in-two-levels.md)); upstream work is deferred by the owner |
| B. Build the application, then read its compiler or its output (ngtsc, javac, JDT) | The fullest type semantics: ngtsc found 453 template usage pairs on the standalone app | Needs installed dependencies and a build, which [ADR-0010](0010-trust-modes.md) decision 4 forbids; on a snapshot without `node_modules` ngtsc found 6. Compiled output is private framework vocabulary: 164 hashed chunks older than HEAD, and factories that drop `inject()` dependencies (72 of 84 with `deps: []` in one chunk). No compiler yields routes, `inject()` edges or call links. Spring Tools and CodeQL's `build-mode: none` resolve Maven or Gradle dependencies first |
| **C. Own extractors over parser libraries** | No build; works on a git export at a sha. The standalone `@angular/compiler` found 422 of ngtsc's 453 pairs, all within ngtsc's set, in 0.36 s against 3.2 s; the other 31 are 26 self-references and 5 reached through `hostDirectives`. tree-sitter-java parsed 752 files in 257 ms with 0 errors | Syntax only: Java types come from imports and a project symbol table, and library meta-annotations stay `unknown`. `@angular/compiler` sits outside Angular's semantic versioning |

Facts the decision rests on:
- `@angular/compiler` 22.2.4 depends only on `tslib` and requires Node `^22.22.3 || ^24.15.0 || >=26.0.0` (npm registry,
  2026-10-30). Angular 22 requires TypeScript `>=6.0.0 <6.1.0` (https://angular.dev/reference/versions), which the 6.0.3
  pin meets ([ADR-0008](0008-typescript-compiler-api-source.md)).
- Angular's public API excludes it: "The `@angular/compiler` package is explicitly excluded from this list. The compiler
  is generally considered private/internal API and may change at any time"
  (https://github.com/angular/angular/blob/main/contributing-docs/public-api-surface.md, lines 17-18).
- The template measurement loaded the application's own `@angular/compiler` 21.2.25. Under `untrusted`, loading the
  repository's copy would run repository code.
- tree-sitter-java ran on the runtime and grammar that codegraph 1.6.2 bundles (`web-tree-sitter` 0.25.10,
  `tree-sitter-wasms` 0.1.13).
- Spring Tools resolves dependencies through Maven before it reads request mappings
  (https://github.com/spring-projects/spring-tools/tree/main/headless-services/spring-boot-language-server/src/main/java/org/springframework/ide/vscode/boot/java/requestmapping),
  and CodeQL's `build-mode: none` queries Gradle or Maven for dependencies "but not to invoke a build"
  (https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages).
- In both codegen services, `operationId` equals the name of the controller's `@Override` method in 15 of 15
  operations, whatever the generator's grouping (by tag in one, by first path segment in the other).
- Spring Framework 7's request mappings take a `version` attribute: a fixed version (`"1.2"`), a baseline (`"1.2+"`)
  or none (https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html). Spring
  Boot reads the base URL of an HTTP service group, imported with `@ImportHttpServices`, from
  `spring.http.serviceclient.<group>.base-url` (https://docs.spring.io/spring-boot/reference/io/rest-client.html).
- An application may keep `src/environments/environment.ts` out of git and generate it at build from a secrets
  manager; a snapshot then has no environment base URL.

## Decision

1. **Only the generic graph from codegraph.** For Angular and Spring, codegraph supplies files, symbols, imports, calls
   and `implements`. Every framework fact comes from ye-ast's own extractors
   ([ADR-0013](0013-coverage-grows-only-with-evidence.md) rule 8), joined to codegraph's nodes by file and qualified
   name; codegraph's route nodes, template edges and HTTP edges for these frameworks are not used.
2. **Angular.** The TypeScript compiler API 6.0.3 reads the TypeScript side: route tables, decorator metadata
   (`selector`, `imports`, `templateUrl`, `hostDirectives`), injection and HTTP call sites. The standalone
   `@angular/compiler` parses templates (`parseTemplate` and its selector matching). Each parser reads a file once.
3. **Spring.** tree-sitter-java reads the Java side, with a project-wide table of `static final String` constants and of
   in-repository meta-annotations; no JVM. A type resolves through imports and that table, or it is `unknown`.
4. **ye-ast's own parsers.** `@angular/compiler`, `web-tree-sitter` and the Java grammar are ye-ast's own exact-pinned
   dependencies. The repository's copies are never loaded, since that runs repository code
   ([ADR-0010](0010-trust-modes.md) decision 4), and codegraph's bundled grammar is not reached into, since codegraph is
   used only through its adapter. `@angular/compiler` is a vendored parser
   ([ADR-0013](0013-coverage-grows-only-with-evidence.md) rule 3).
5. **No build.** Nothing is installed, built, compiled or run. ngtsc is only an offline oracle that measures the
   template extractor on fixtures and measured applications, never part of a query.
6. **Configuration key by key.** Spring's `application*.yml` and `application*.properties` and Angular's environment
   files are read through the confined reader, only for the keys a fact needs. A URL keeps its scheme, host, port and
   path, never its credentials or query. A Spring value is reported per profile: the default document, then each
   document a profile activates; no fact picks a profile. A value the snapshot lacks is `unknown`, unless the workspace
   manifest declares it in `boundaries[]` ([RFC-0006](../rfc/0006-configuration.md)).
7. **Timing** ([ADR-0012](0012-foundation-before-qayaba-migration.md)). New code starts now: the Spring plugin, and
   Angular's templates, template reads and injection. Code that moves from qayaba waits for its migration unless it is
   rewritten under ADR-0012 decision 2: the Angular route extractor and its loader, module resolution with dynamic
   loads, and the URL evaluator. The confidence cap and the free interface hops follow the codegraph adapter's parity
   stage ([RFC-0003](../rfc/0003-codegraph-integration.md)).
8. **Done.** Angular and Spring coverage is complete when every item of the definition of done holds.

## Definition of done

- [ ] Every row of the plugin's table in [RFC-0007](../rfc/0007-extension-model.md) is closed by its fixtures, each seen
  failing first.
- [ ] No construct is lost: one the source cannot resolve is an item `unknown` with its reason, and one detected but not
  extracted is an item `unknown` with `no-extractor`.
- [ ] On each measured application, each family's parity diff accounts for every entry against its reference:
  codegraph's breadth and qayaba's route extractor for routes, the OpenAPI contract for the routes of generated
  interfaces, ngtsc run offline for template usage. RFC-0007 records the results and marks the constructs proven only
  by fixtures, such as NgModule routing and Kafka, RabbitMQ and JMS listeners.
- [ ] Both plugins declare `depth` for the five families in the capability matrix, which `ye-ast --help` and the MCP
  status tool show.
- [ ] A heuristic edge without a score is not certain, and an interface-to-implementation hop spends no walk depth
  ([RFC-0003](../rfc/0003-codegraph-integration.md)).
- [ ] No extractor compares a count of files or lines with a constant; qayaba's 4,000-file route cap does not move.
- [ ] `engines.node` reads `>=24.15.0` from the change that adds `@angular/compiler`. The pinned compiler parses every
  template of the measured Angular applications with 0 errors, and the template fixtures pass for each Angular major the
  plugin declares, 21 and 22 at least.
- [ ] Every fixture and measurement runs under `untrusted` on a git export at a sha: nothing installed, built or run,
  no network.
- [ ] Two runs on the same snapshot and configuration give identical bytes for every fact of both plugins.
- [ ] A codegraph upgrade runs every fixture of both plugins before it lands.
- [ ] `npm run check` passes with every fixture in it.

## Consequences

- `@angular/compiler`, `web-tree-sitter` and a Java grammar enter with the first code that needs each
  ([ADR-0007](0007-dependency-versions.md)); `engines.node` rises to `>=24.15.0` with the compiler.
- [ADR-0009](0009-route-data-in-two-levels.md) lists the route gaps above;
  [RFC-0003](../rfc/0003-codegraph-integration.md) scores heuristic edges as uncertain and frees interface hops;
  [RFC-0004](../rfc/0004-deterministic-map.md)'s first slice takes Angular and Spring entrypoints from these plugins.
- The estimate is a hypothesis, not a measurement: 21-28 days for Angular and 17-29 for Spring, without the later items.

## Not decided here

- Later: Spring Security `SecurityFilterChain` guards and `RouterFunction` routes (3-5 days each, hypothesis). Until
  then each is detected and answered `unknown` with `no-extractor` ([RFC-0007](../rfc/0007-extension-model.md)).
- Not measured: Kotlin, Gradle multi-module builds, Boot 4 configuration keys beyond the cited documentation, Angular
  environments other than the default file, selectorless components.
- Contributions to codegraph (records among its class types, routes typed through derived types, directive and pipe
  edges, `inject()` references): deferred by the owner ([RFC-0003](../rfc/0003-codegraph-integration.md)).
