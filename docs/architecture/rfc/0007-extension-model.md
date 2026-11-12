# RFC-0007: Extension model

- Status: Draft, 2026-10-29
- Related: [ADR-0008](../adr/0008-typescript-compiler-api-source.md), [ADR-0009](../adr/0009-route-data-in-two-levels.md),
  [ADR-0012](../adr/0012-foundation-before-qayaba-migration.md),
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md),
  [ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md), [RFC-0003](0003-codegraph-integration.md),
  [RFC-0004](0004-deterministic-map.md), [RFC-0006](0006-configuration.md)

**In short:** languages, frameworks and communication protocols are plugins behind fixed contracts, each declaring
which fact families it supports and at which level, each proven by conformance fixtures and measured applications.
codegraph gives the generic graph; a framework with its own extractor takes every fact from it. Unsupported means an
explicit `no-extractor`, never "no impact". v1 covers Angular and Spring, and this RFC holds their design per gap.

## Plugin kinds

| Kind | Contract | Example |
|---|---|---|
| Language | B1 callable declarations and spans; module syntax, statement syntax, decision syntax, test-file rule | TypeScript/JavaScript (compiler API), Java (tree-sitter) |
| Framework | entrypoints; injection and usage edges; configuration values; roots for unused files; resource declarations | Angular; Spring |
| Protocol | call-site and operation matchers for the stitcher; HTTP routes of the handlers that implement a contract-generated interface | HTTP + OpenAPI, events (publisher/subscriber), gRPC (proto), GraphQL (SDL) |

Protocols with a schema (OpenAPI, proto, SDL) fix the set of operations: the schema lists them, so that set is
deterministic. Matching a call site to an operation still carries a confidence, and a call site that matches no
operation is `unknown`. Pattern-based protocols (events, raw HTTP) are configured through `boundaries[]` data, not code.

B1's `declarations` comes from the existing member-name parse, with exact spans and proven container positions;
`callables` keeps its dispatch meaning. The shared declaration model joins syntax with index identities and containment
([RFC-0027](0027-declaration-model.md), U1); family consumption follows in U2.

### HTTP routes declared in a generated interface

When a handler implements an interface generated from the contract, the route annotations live in the generated
interface and codegraph emits no route node: an OpenAPI-codegen Spring app yields 0 route nodes (qayaba@4105c582
`odd/tasks/codegraph-migration.md:185`). The HTTP protocol plugin supplies those routes from the contract joined with
the classes that implement the generated interface ([ADR-0009](../adr/0009-route-data-in-two-levels.md) decision 4,
[RFC-0004](0004-deterministic-map.md)). The join covers only the handlers whose generated interface is absent from the
snapshot, so it never duplicates a route the Spring plugin reads (row S5 below).

## Angular plugin

[ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md) holds the sources, the evidence and the definition of
done. The plugin reads each file once with the TypeScript compiler API and each template once with `@angular/compiler`,
writes to ye-ast's own layer and joins codegraph's nodes by file and qualified name. Rows that start after the migration
reuse code that moves from qayaba ([ADR-0012](../adr/0012-foundation-before-qayaba-migration.md)). Costs are estimates
(hypothesis).

| # | Gap | Approach | Fixtures | Starts | Cost |
|---|---|---|---|---|---|
| A1 | Routes: 0 route nodes for 43 screens behind a derived type and a helper | qayaba's extractor and loader, plus the target (`component`, `loadComponent`, a default `@Component` export); identifier arrays and spreads, or an item `unknown`; NgModule lazy children through `RouterModule.forChild` and `@NgModule({ imports })` composition from the bootstrap module and from every lazily loaded module; guards and outlets per route. A budget that stops it is a cut | alias of `Route[]`; interface derived from `Route` (`extends Omit<Route, ...>`); helper function; identifier array with a spread; NgModule `forRoot`, `forChild` and lazy child; legacy `<path>#<Export>` lazy loading; lazy-loading helper, await and destructuring forms; named outlet; enum and template-literal paths; `matcher` | after the migration | 4-6 days |
| A2 | Injection: 0 of 668 `inject()` sites linked | Own `injects` edges for `inject(X)`, constructor parameter types, `@Inject`, functional guards and interceptors; an injection token is `unknown` until providers are read | `inject()` in a field; constructor; optional; token; `inject(Router)` in a guard; an `inject` that is not Angular's | now | 4-5 days |
| A3 | HTTP call sites: 0 of 86 linked | The HTTP protocol plugin's URL evaluator with Angular's receivers: pure helpers inlined; `this.prop` through base classes; `httpResource`, `HttpRequest` and `request(verb, url)`; parameter-flow summaries for wrappers, never "any call with a path", which would accept `router.navigateByUrl('/x/1')`; generated clients joined by method name and `operationId`. The base URL comes from the default environment file, else from `boundaries[]`, else it is `unknown`; an interceptor that rewrites URLs caps the confidence | a resource-URL helper behind a gateway prefix; literal; variable; wrapper; `httpResource` with a string, an arrow and an object; generated client; environment file absent from the snapshot; negatives | after the migration | 8-10 days |
| A4 | Templates: directives 0 of 156 and pipes 0 of 11 linked; `.html` not indexed | `@angular/compiler` parses inline and external templates; `uses-component`, `uses-directive` and `uses-pipe` edges scoped by standalone `imports` or NgModule declarations, plus `hostDirectives` read from the decorator; a parse error is `unknown` | attribute, class and `:not` selectors; `*ngIf`; `@if`, `@for`, `@defer`, `@let`; pipes; clashing selectors; inline template and `templateUrl`; `hostDirectives` | now | 5-7 days with A5 |
| A5 | Template reads: 36 of 95 DTO fields read only in templates | Field reads and writes of template expressions, joined to the consumer expectations | a field read only in a template; a two-way binding write | now | with A4 |
| A6 | Unused files: a file loaded only through `import()` has no importer | qayaba's dynamic loads and unlinked uses, with lazy route targets and template usage as importers | a module loaded only through `import()`; a lazy route target | after the migration | moves |

- Row A1, as built (`core/adapters/typescript`, the route extractor, its loader and the module
  resolver moved from qayaba, ADR-0014 decision 7). An Angular project is the directory of each
  `package.json`, at any depth outside `node_modules`, that names `@angular/core` or `@angular/router`; a source belongs
  to the nearest project above it and a source with none is not read. Each project whose manifest names
  `@angular/router` has every TypeScript source of it outside tests, declaration files and `node_modules` parsed once (`.ts`, `.mts`,
  `.cts`; JavaScript and TSX route files are not read; a folder named `build`, `out`, `tmp` or `vendor` is read); the map exports, reads and digests those sources, every `package.json`, every
  `tsconfig*.json` or `jsconfig*.json` and every `angular.json`. Nothing is built or run.
  - One `ui-route` item per route entry that shows a component (`component`, `loadComponent`, or the default export of a
    lazily loaded module), named as [RFC-0001](0001-architecture-and-layers.md) says. It carries the class the entry
    shows (file, symbol and line of the class declaration, or `unknown` when the sources do not name one class) and its
    guards: those of its ancestors, then its own, root first and without repeats. `canMatch`, `canActivate` and
    `canLoad` guard the entry and what is beneath it; `canActivateChild` guards what is beneath the entry, never the
    entry. Each is placed at the file that declares it (never at a barrel); a guard from an installed package is
    `external`; only a function written in place is `(inline)`. A guard list given as a name or with spreads
    (`canActivate: guards`, `[...guards, g2]`) resolves through the same declaration lookup as arrays of routes; one
    that cannot be read (an unresolved name, a conditional, a member access) makes the route, and every route beneath
    it, an `unknown` item with `unresolved` at the guard list and at the entry.
    A named outlet applies to the whole subtree of its entry (`/side/b (aux)`); a descendant that names a different
    outlet is `unknown` with `no-extractor`, and an outlet that is not text names no descendant.
  - A redirect is not an entrypoint; a parent without a component only adds its path to its children; `children`
    arrays, a named array of the file or of an imported module, and `loadChildren` with exactly one static dynamic
    `import()` (also through a top-level binding) are followed.
  - The caps of qayaba's code became signals: the child-table depth (8) and the re-export depth (12) are cycle
    detection (a table that loads a table above it is `unknown` with `unresolved` at the loading entry), the resolver's
    6 rounds run until the compiler asks for no new file, and the `MAY_HOLD_ROUTES` prefilter is gone, so shorthand
    `{ path, component }` is read. The 4,000-file route cap and the working-copy walk do not move.
  - Roots. The tables the router is configured with are the roots: the first argument of `provideRouter` and of
    `RouterModule.forRoot`, also inside `importProvidersFrom`, as an array literal, a named array or a helper called
    without arguments, when the call is imported from `@angular/router`; and the module graph the application boots, the
    class a `bootstrapModule(...)` call names. A table loaded by `loadChildren` is a root's child. A module class answers
    the aggregate of its `@NgModule({ imports })` graph: the `RouterModule.forChild` tables of the class itself, then
    those of every module its `imports` reach, depth first in source order, each class and each expanded array once. A
    `forChild` table is therefore named under the root that boots its graph (`/owners`) and under the route that loads it
    (`/auth/register`), and one graph registered both ways yields both prefixes. A graph that holds an `imports` operand
    the metadata reading could not resolve is not built at all. A lazy module whose graph holds no `forChild` table is an
    unresolved lazy section with `no-extractor` at the reference: silence would assert no routes. A `loadChildren` that
    imports a module with a default export, or a routes file with a default export, is followed. A file whose
    `@angular/core` resolves inside the snapshot (a local re-export, or a `paths` mapping to a vendored file) is not
    Angular code: its decorators are not recognised, so the module graph a class composes is not read and the lazy
    section that loads it is `unknown` with `unresolved` at the reference — an honest gap, never a silent empty answer.
    Recognising a decorator that reaches the file through a re-export or a path mapping is follow-up work.
    A table no declared root reaches (dead code, a `forChild` table nobody loads, or a root this extractor does not
    recognize, such as one configured through a namespace import) is never named and never an empty answer: each
    would-be `ui-route` of it is an `unknown` item at its entry, with `unresolved` (and the unresolved references as
    more evidence) while some child reference of the repository is unresolved, since that reference may be what loads
    it, and `no-extractor` otherwise. Identical evidence is one item. A declared root whose table cannot be followed
    is an `unknown` item at the call.
  - Without any declared router configuration the first rule holds: a table no table loads (or, for tables that only
    load each other or themselves, the first in file order) is a root, and while a child reference is unresolved no
    route is named: each would-be `ui-route` is `unknown` with `unresolved` at its entry and at the references.
  - Each table is built once however many entries load it. A table that loads a table above it is a cycle, `unknown`
    with `unresolved` at the loading entry.
  - Elements of a table. A name among the elements stands for the route object constant it names (a top-level `const`
    holding an object literal, local or imported), and the route is placed at that constant. An element that cannot
    be read as one route is an `unknown` item at the element: `unresolved` for a name that does not resolve,
    `no-extractor` for a conditional, a call, an object with spread properties (`{ path: 'x', ...base }`) or any
    other expression. A table is a route array when it holds a route object or its type annotation names `Route` or
    `Routes` (so `[home, about]` is read when typed). An array in a branch of a conditional expression
    (`env.prod ? [ ... ] : [ ... ]`) is not served unconditionally: its would-be routes are `unknown` with
    `no-extractor`.
  - Identifier arrays and spreads. `children: ROUTES`, `...ROUTES` and `...routes()` (a helper called without
    arguments) resolve through the same declaration lookup, local or imported through renames and barrels; a spread
    puts the entries at its position under the same parent, and `...[ ... ]` is inline. A spread that does not come
    down to one table is `unknown` at the spread: `no-extractor` for a call with arguments or a member call,
    `unresolved` for the rest and for a spread of a table into itself.
  - A table is a route array whatever type annotates it (alias of `Route[]`, interface derived from `Route`, `satisfies`,
    none); it is found by its shape. A helper `function f() { return [ ... ]; }` or `const f = () => [ ... ]` is the
    table named `f`.
  - Paths and outlets are text when they are string literals, template literals, enum members and `const`s (also an
    object literal's member, a `const` that aliases another, and a template whose substitutions are text), through
    imports; any other part makes the path `unresolved`. An enum member whose initializer is a template with
    substitutions is not read.
  - `unknown` with `unresolved`: a path or an outlet that is neither a literal nor a constant the sources hold, a
    `loadChildren` or `children` that does not come down to one table, a cycle among tables; with `no-extractor`: an
    entry with a `matcher`; with `source-unreadable` at line 1: a TypeScript source the compiler's parser rejects.
    The descendants of an entry whose path is unknown are not named.
  - Not detected: a route array built by a call (`[screen('home', Home)]`) or by concatenation; a helper called with
    arguments (`no-extractor`); an array of only spreads; a router configuration reached through a namespace import or
    a re-export of `provideRouter`; a route object constant that has spread properties or is built by a call; a guard that is a member access (`Guards.auth`) or a call whose callee is not a name; `forChild` inside a variable that an `@NgModule` imports; `RouterModule.forRoot`
    or `provideRouter` receiving something else than a table (a function call with arguments is `no-extractor`); the
    `matcher` function's paths (`no-extractor`); and JavaScript and TSX sources.
- Row A3, as built for the standard clients and wrappers (`core/adapters/typescript/http-call-sites.adapter.ts`, the
  `CallSiteReader` of `core/domain/topology`). The TypeScript compiler parses each in-scope source once; no program, no
  type checker, no build.
  - A call site is a call to an `HttpClient` verb (`get`, `head`, `post`, `put`, `patch`, `delete`, `options`, `request`)
    whose receiver is a field or constructor parameter typed `HttpClient` and imported from `@angular/common/http` — the
    name alone is not enough — or a call to a method of a class the repository injects somewhere whose method reaches such
    a verb, directly or through another method of the same class. `fetch(url)` is a `GET`; `request(METHOD, url)` takes
    its verb from the first argument when that is text.
  - The path is the text the first argument comes down to through string literals, template literals, `const`s, object
    literal members (`PATHS.token`), and calls to a function of the snapshot, whose parameters reach the path as `{}`; a
    `${expr}` span, a `:name` segment and a parameter are `{}`. The query string is dropped. Anything else is
    `target: unknown` with `unresolved` at the call, never a guessed path.
  - A base URL is the `baseUrl` member of the call's options object literal, when the snapshot decides it.
  - The body of a wrapper is not a call site: the request it makes is the one its caller asks for, and the caller's call
    is the place. A wrapper that also made a request of its own would lose it; none was measured.
  - Not detected: an interceptor that rewrites a URL, a receiver resolved through a type not declared in the snapshot (a
    library wrapper), `httpResource`, and `HttpRequest` constructed by hand. A class name two classes of the snapshot
    share makes a wrapper test ambiguous; the walk keeps it as a wrapper, which can only add a call site.
- Row A2, as built (`core/adapters/typescript`, the metadata reader; the relations are `core/domain/relations`). Per
  project, as in row A1 (the directory of each `package.json` naming `@angular/core`, the nearest project above a
  source claiming it, paths staying repository-relative, module resolution and `tsconfig` lookup from the file), every
  TypeScript source outside tests, declaration files and `node_modules` is parsed once, with nothing built or run. A call is Angular's `inject` only when the name is
  imported from `@angular/core` (also `core.inject` through a namespace import); a local function or another package's
  function of that name is not a relation.
  - One `injects` relation per pair of an owner and a class of the repository, at the first site that injects it
    (a `Finding<Relation>` with that site as evidence). The owner is the nearest enclosing class, else the top-level
    function declaration or top-level constant whose body holds the call: a functional guard or interceptor
    (`export const g: CanActivateFn = () => { inject(X) }`) is the owner of what it injects, and a call inside a
    method, a field or a decorator argument belongs to its class. The class is placed by the file, the name and the line
    of its name, the keys RFC-0010 "Entrypoint join" joins on.
  - Sites: `inject(X)` and `inject(X, { optional: true })`; the type of each constructor parameter of a class decorated
    with `@Component`, `@Directive`, `@Pipe`, `@NgModule` or `@Injectable` (a parameter property too; `X | null` and
    `X | undefined` name `X`); `@Inject(X)` on a parameter. A name resolves through imports, renames, barrels and
    namespace imports with the route extractor's module resolver and declaration lookup; a class of an installed
    package is not a relation of the repository and produces nothing.
  - `unknown` with `no-extractor`: the injection token is a constant, a member of a value, a string or any other
    expression (the providers are not read), an `inject()` with no enclosing class, function or constant, and a
    `forwardRef` argument. `unknown` with `unresolved`: a name that no import places or whose import names no file, and a
    constructor parameter typed by an interface or alias. A source the compiler's parser rejects is `unknown` with
    `source-unreadable` at line 1.
  - Not detected: a constructor of a class without an Angular decorator (also when it extends a decorated one), `inject`
    inside a function that is neither top-level nor in a class, `viewChild` and the other signal queries, the providers
    that satisfy a token, and `inject(this.token)`.
  - The declaration reader that seeds a component from a changed `templateUrl` or `styleUrl(s)` runs per project too.
  - Feeds the impact walk: each `complete` relation is an inbound edge into the injected class, from the injecting one
    (RFC-0010 "Edge policy"); an `unknown` item cuts an impact fact only in a file the walk reached.
- Row A4, as built, without A5 (`core/adapters/angular-compiler` parses templates; `core/application/relations` joins
  them to the classes the TypeScript reader found; `composition/angular-relations.ts` wires both). The compiler is
  ye-ast's own exact-pinned `@angular/compiler`, reached through one adapter (a dependency-cruiser rule keeps every
  other module from importing it); the analysed repository's copy is never loaded, and `engines.node` rises to
  `>=24.15.0` with it. The adapters stay independent: the TypeScript reader hands the use case plain class metadata,
  the use case computes each component's scope and hands the template adapter the text and the scope.
  - A template is the `template` of the decorator (a string or a template literal without substitutions) or the file
    `templateUrl` names, relative to the component's file; the file must be among the sources given, or the component is
    `unknown` with `source-unreadable` at the property. A `template` or `templateUrl` that is any other expression is
    `unknown` with `no-extractor`; a template the compiler reports an error for is one `unknown` item with
    `source-unreadable` at the line of the error, and no relation.
  - Scope. A component that no NgModule declares sees its `imports`: components, directives and pipes, and for an NgModule
    what it exports, re-exports through modules included. A component an NgModule declares sees that module's
    `declarations` and what the modules it imports export. A component is not in its own scope. Arrays and spreads in
    these lists are followed as in A2, `Module.forRoot()` stands for the module, and a class of an installed package is
    left out. An entry that cannot be placed is an `unknown` item with `unresolved` at it; the entries that can still
    scope the template. A component two NgModules declare is `unknown` with `unresolved` and has no scope.
  - Relations: `uses-component`, `uses-directive` and `uses-pipe` from the component to the class of its scope that its
    template uses, once per pair at the first use (the evidence is the line of the element, or of the template node that
    holds a pipe call, in the template file or the `.ts` file for an inline template); and a `uses-directive` from a
    component or directive to each directive its `hostDirectives` lists (evidence at the entry). Matching is the
    compiler's own selector matcher and target binder: tag, attribute, class and `:not` selectors, `*ngIf` and the other
    structural microsyntax through the desugared template, `@if`, `@for`, `@switch`, `@defer` and `@let`, and the
    pipes of every expression.
  - `unknown`: an element two components of the scope match (neither component is named, the directives still are), a pipe
    name two pipes of the scope share, a selector the compiler rejects (`no-extractor`, at its class), a `selector` or a
    pipe `name` that is not text (`unresolved`).
  - Not detected: a component used only by the router, `ngComponentOutlet` or `createComponent`; selectorless
    components; a component that uses itself; a directive reached only through the `exportAs` of another; the inputs
    and outputs of a directive (A5); `forwardRef` in a scope list; the `schemas` of a module; a template read from a
    constant.
  - The map's export and content digest include the `.html` and `.htm` files outside `node_modules`, so a template a
    `templateUrl` names is readable and a change to it invalidates the fact. Feeds the impact walk as A2 does: a
    `uses-component`, `uses-directive` or `uses-pipe` relation is an inbound edge into the class used, and an `unknown`
    item in a template cuts an impact fact when the walk reached a component that names the template. A changed
    `.html`/`.htm` file that no component claims through `templateUrl` is a `no-extractor` cut at that file.

## Spring plugin

[ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md) holds the sources, the evidence and the definition of
done. The plugin parses each Java file once with tree-sitter-java, keeps a project-wide table of `static final String`
constants and in-repository meta-annotations, and skips test files by the Java test-file rule. Every row is new code and
starts now ([ADR-0012](../adr/0012-foundation-before-qayaba-migration.md) decision 2). Costs are estimates (hypothesis).

| # | Gap | Approach | Fixtures | Cost |
|---|---|---|---|---|
| S1 | No Java decision, statement or module syntax in qayaba | The Java language plugin: imports, statements, decisions and the test-file rule | one per syntax kind; a test file | not estimated |
| S2 | Records get no node | Type, component and field facts with their annotation arguments (`@JsonProperty`, validation) | compact constructor; nested record; generic record; Jackson and validation arguments | 1-2 days |
| S3 | Spring Data: the entity of `JpaRepository<E, ID>` is lost | Type arguments of `extends` and `implements` as references | a repository per entity | not estimated |
| S4 | Mappings from a regular expression | Exact handler span; prefix from class, interface and superclass; constants and concatenations from the project table; transitive in-repository meta-annotations; paths × verbs; `version` as part of the route's identity; an expression that does not resolve is an item `unknown`; `@FeignClient` interfaces are clients, not routes | non-literal prefix; constant from another file; two classes in one file; nested class that is not a controller; package-private handler; `method = {GET, POST}`; composed annotation; `${...}` in a path; `version`; `@FeignClient`; hand-written `*Api` interface; overloaded handlers | 3-5 days |
| S5 | Generated `*Api` absent: 0 routes on both codegen services | The HTTP protocol plugin joins each `operationId` to the `@Override` methods of the classes whose `implements *Api` does not resolve (15 of 15 matched, whatever the generator's grouping); where row S4 found a generator declared in a build file, the methods joined are the public ones, with or without `@Override`); base path from the contract's `servers` and the configuration; confidence from the overlap | a contract and its controller without the generated file; tagged and untagged contracts; partial overlap | 3-5 days |

Row S5 as built. A contract document is a YAML or JSON file with a path segment named `openapi` or `swagger`, whose root
declares `openapi: 3.x` or `swagger: "2.0"` (`core/domain/languages/openapi.ts`,
`core/adapters/openapi/contract-document.adapter.ts`); the map exports and digests those files. The Spring extractor
receives its operations through the `ContractRoutes` port, so no adapter reaches into another.
- One `http-route` per joined operation: the contract's verb and path, the overriding method as the handler, and the
  method's span followed by the `operationId`'s place in the document as evidence.
- The join holds only for a controller with exactly one supertype the sources do not give, that supertype an interface,
  no class mapping of the class's own, and an `@Override` method with no mapping of its own whose name equals an
  `operationId`. The contract is then the interface's source, so the absent-interface item is dropped only when the
  contract names every override; a partial overlap keeps it.
- An `operationId` two documents of the repository declare picks neither: the handler is `unknown` with `unresolved`, at
  the method and at each document.
- A document the parser rejects is one `unknown` item with `source-unreadable` at the error; a document that declares no
  operation contributes nothing. An operation with no `operationId` is still read, placed at its verb, but no override
  joins it, so a contract nothing implements makes no route.
- Each operation also carries its data: digests of the request (path-item and operation parameters, request body,
  `consumes`) and of the response (responses, `produces`), with `description`, `summary`, `example`, `examples` and
  `externalDocs` left out except as property names. Every `$ref` is followed, into the document or into another source
  of the snapshot, each place once whatever cycle leads back to it; a reference to a URL, outside the repository or to a
  place the sources do not hold is listed as unresolved, never read as unchanged. `impact.ofChange` compares them
  (RFC-0010 `changedContracts`).
- The contract's `servers` are not applied in this slice: a route's path is the contract's path and its base path is its
  module's configuration, as for row S6. A contract that declares a server prefix and a deployment that adds one are both
  deferred to the link bases of RFC-0011.
| S6 | Configuration values dropped | Key-by-key reader ([ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md) decision 6): `---` documents with `spring.config.activate.on-profile`; `${a:b}` placeholders; `spring.application.name`; context and servlet paths; gateway routes; `spring.http.serviceclient.<group>.base-url`. A team's own URL keys come from `boundaries[]` | multi-document YAML; profile override; placeholder default; a URL with credentials | 3-5 days |
| S7 | Listeners without their topic | `@KafkaListener`, `@RabbitListener`, `@JmsListener`, `@EventListener` and `@Scheduled` methods as entrypoints with their topic, queue, destination or cron, paired with `KafkaTemplate.send` and `publishEvent` by the events protocol plugin; custom event libraries through `boundaries[]`, where qayaba's event catalog moves | one per annotation; a custom event library | 3-5 days |
| S8 | Client call sites unresolved | The HTTP protocol plugin's Java matchers: `RestTemplate`, `WebClient`, `RestClient`; `@HttpExchange` with the base URL of its `@ImportHttpServices` group; Feign `name` and `url`. A team's wrappers come from `boundaries[]` | one per client; an unresolved URL | 3-5 days |
| S9 | Consumer field reads in Java: none | From a client call's response type, the record accessors, getters and fields the consuming code reads | one per client, with a record and a class response | not estimated |
| S10 | Interface hops spend walk depth; beans look unused | Interface-to-implementation hops spend no depth ([RFC-0003](0003-codegraph-integration.md)); `@Component`, the annotations meta-annotated with it and `@Bean` methods are roots for unused files | an interface with several implementations; a hexagonal chain; a bean with no static caller | 1-2 days |

Row S1's test-file rule as built (`core/domain/languages/java.ts`, shared by every JVM language): a file is a test
file when it sits in a Gradle or Maven test source set (`src/test/`, `src/testFixtures/`, or a suite named
`src/<name>Test/` such as `src/integrationTest/`), or when it is named like a test class (`*Test`, `*Tests`, `*IT`)
outside `src/main/`; a class in `src/main/` is production code whatever its name, since Spring serves it.

Row S4 as built (`core/adapters/spring`, over `core/adapters/tree-sitter`):
- An annotation is Spring's only when its name resolves through the file's imports to Spring's package, or to an
  annotation of the repository that composes one. Composed annotations pass attributes to the mapping only through
  `@AliasFor`, as Spring 7 does. Spring 6.2 also lets an attribute of a composed annotation override the same-named
  attribute of its meta-annotation without `@AliasFor` (removed in 7.0.0-M3, spring-framework #28761), and ye-ast does
  not know the Spring version of the analysed application: a composed annotation that declares `path`, or `method`
  where the meta-annotation is `@RequestMapping`, without `@AliasFor` leaves its handlers `unknown` with reason
  `unresolved`, since the route differs between the two. Any other same-name attribute, and `value`, changes nothing.
- A controller is a concrete class, a record included (JLS 8.10), whose type hierarchy carries a controller stereotype,
  searched as Spring's `isHandler` does (`hasAnnotation(Controller)` over the class, its interfaces, then its
  superclass, composed annotations unfolded). A class mapping alone does not make a handler: Spring 6.0 and later
  expect a type-level `@Controller`, so a `@Component` that only implements an interface carrying `@RequestMapping`
  (a Feign fallback) gives no route. An abstract class or an interface that carries a stereotype is never one
  itself: it makes its concrete subclasses and implementors controllers, and its handlers reach them. Component
  scanning, though, reads only a class's own annotations (`@Component` is not `@Inherited`): a controller whose own
  annotations hold neither a controller stereotype nor `@Component` or `@Service` is served only if a registration
  the sources may not show (`@Bean`, `@Import`) makes it a bean, so its handlers are `unknown` with reason
  `no-extractor`, with the class as the cause. A controller's
  handlers are the methods with a body in its class chain that
  no nearer class overrides, so a handler inherited from a superclass is a route of the subclass, and the default
  methods of its interfaces that nothing overrides (the delegate pattern of generated APIs). The mapping is searched on
  the method, then its interfaces, then its superclass; the first one found wins, and the class mapping is searched the
  same way. On one declaration, a resolved mapping wins over an annotation that is ambiguous or not read.
- An override is matched by name, arity and parameter types, compared by erased simple name; a parameter that is a type
  variable of its declaration matches any type, and an array matches an array of the same dimensions. A declaration
  that matches exactly wins over one that matches only through a type variable. When several declarations still match
  equally, the handler is `unknown` with reason `unresolved`, never a guess.
- A `@RequestMapping` that names no method is one route with method `ANY`; the methods of the class and of the handler
  are combined, as Spring does. A handler `version` replaces the class `version` (hypothesis; the documentation cited
  by ADR-0014 does not state the precedence).
- A string, a text block, a character, an integer constant or a concatenation of them is evaluated as the Java language
  specification defines it: escape sequences (§3.10.7, octal and `\s` included), Unicode escapes (§3.3, before the
  literal is read), the indentation and trailing white space of a text block (§3.10.6), `int` and `long` wrap-around,
  and string conversion of integers and characters; a constant converts to its declared type. Property placeholders
  (`${...}`, `#{...}`), a literal holding U+FFFD (source bytes that were not UTF-8, which the reader decodes
  leniently so the rest of the file is still read) and anything the sources do not give stay `unknown` with reason
  `unresolved`. A constant
  expression that is statically known but that the extractor does not evaluate (floating point, `boolean`, a ternary,
  a cast, arithmetic other than `+`) is `unknown` with reason `no-extractor`.
- A name that two files declare (modules of one repository may) is not resolved, since the sources do not say which is
  meant. A handler that an ambiguous superclass, interface, controller stereotype or mapping annotation affects is
  `unknown` with reason `unresolved`, with no route; a handler an ambiguous overload affects is too.
- Detected but not extracted, each `unknown` with reason `no-extractor` at the method:
  - a supertype of a controller, class or interface, that the sources do not give and the platform packages
    (`org.springframework`, `java`, `javax`, `jakarta`, `lombok`) do not own. A package the sources declare under one
    of those prefixes claims the prefix and its next segment for the repository (`org.springframework.samples.*` is
    the repository's, `org.springframework.web.*` stays the platform's), so its absent names are gaps: generated `*Api` interfaces and library
    base classes are usually absent from git, and the routes they carry are row S5. It is one item at its `extends` or
    `implements`; a route whose class mapping Spring's search could take from it (the supertype precedes the first
    class mapping in the search order, or no class mapping is found) is an item instead of a route, never a prefix
    guessed as empty; an `@Override` method without a mapping of its own is an item at the method. A name that no
    import mentions may be a type of the file's own package;
  - a class that shows no stereotype but has a mapped handler, when something the sources do
    not show may make it a handler: a library annotation on a type of its hierarchy, a Spring Data REST stereotype
    (`RepositoryRestController`, `BasePathAwareController`, which another handler mapping serves under a configurable
    base path), or a supertype the sources do not give (`no-extractor`) or declare twice (`unresolved`). Each mapped
    handler is one item and no route; a class with none of these is not a handler;
  - a component (`@Service`, `@Component`) that implements an interface the sources do not give: the generated
    delegate of a split controller, whose controller is generated too. Without a generator signal, the interface name
    must end in `Delegate` and each `@Override` method is one item. With the signal, a build file in the commit that
    declares a source generator, the interface may carry any name and each public method is one item, `@Override` or
    not, with the build file's declaration as the last span of its evidence. The signal is the Maven plugin
    `org.openapitools:openapi-generator-maven-plugin`, `io.swagger.codegen.v3:swagger-codegen-maven-plugin` or
    `io.swagger:swagger-codegen-maven-plugin` (a `groupId` and an `artifactId` element of the same file), or the
    Gradle plugin id `org.openapi.generator` or `org.hidetake.swagger.generator` as a quoted string, in a `pom.xml`,
    `build.gradle`, `build.gradle.kts` or a version catalog (`*.versions.toml`, where a plugin applied through
    `alias(...)` is declared) at any depth. The map exports, reads and digests those files beside the Java sources, so they are part of
    `inputs.content`, and a build file the export skipped cuts the section; the Spring extractor still parses only
    `.java`. Choices: the signal holds for every module of the commit, since a generated interface reaches a consumer
    module through a dependency that no source shows, and a false positive only adds items; comments are not excluded,
    for the same reason; a coordinate given by a property is not recognised, and when several build files declare one the first by path
    is cited. A controller that implements an absent interface is already one item per absent supertype and per
    unmapped `@Override` method, signal or not;
  - a type that declares endpoints through another server's API, resolved through imports like Spring's annotations:
    JAX-RS (`jakarta.ws.rs` or `javax.ws.rs`: `@Path` and the verb annotations), Micronaut
    (`io.micronaut.http.annotation`: `@Controller` and the verb annotations), Servlet (`@WebServlet`, either
    package) and Quarkus reactive routes (`io.quarkus.vertx.web.Route`, `Routes`). One item per endpoint method, or one
    per type when only the type is annotated;
  - a call of `addPathPrefix(String, Predicate)` (`PathMatchConfigurer`, in `configurePathMatch` or
    `configurePathMatching`) and a class that extends Spring's `RequestMappingHandlerMapping`, servlet or reactive:
    which routes a prefix reaches depends on a predicate this extractor does not evaluate, so every route becomes an
    item whose evidence ends with the call or the class. `setPathPrefixes` is not detected;
  - a method returning `RouterFunction` of `org.springframework.web.reactive.function.server` or
    `org.springframework.web.servlet.function`;
  - a method implementing an `@HttpExchange` or `@GetExchange` family interface method, and a handler of a class whose
    class mapping is an `@HttpExchange`;
  - a method of a controller with no mapping that carries an annotation neither declared in the sources nor owned by
    the platform packages (it may compose a mapping); a name that a library wildcard import may supply counts as one,
    since the sources do not say which import supplies it. A controller that carries such an annotation and has no class
    mapping keeps its routes and adds one item at the annotation. A library annotation beside a resolved mapping is
    ignored.
- Row S6, as built for the base path only. A route's `path` is the mapping the code declares; its `basePath` is a
  finding of its own, with its own evidence: `server.servlet.context-path`, `spring.mvc.servlet.path` and
  `spring.webflux.base-path` as the `application` files of the handler's module declare them
  (`<module>/src/main/resources/` and its `config/`, `.properties`, `.yml` or `.yaml`, with or without a profile), when
  that module declares a `@SpringBootApplication` class.
  The map exports, reads and digests those files; nothing else of them is kept, so no other value leaves the reader.
  - Values are reported as ADR-0014 decision 6 requires: the documents without a condition under `default`, and each
    profile's documents (an `application-<profile>` file, or a `---` or `#---` document with
    `spring.config.activate.on-profile`) under that profile's expression, holding only the keys they set. No profile is
    picked and the keys are not joined, since whether the application is servlet or reactive is not decided here. A
    key name binds in every form Spring accepts: nested or dotted YAML, kebab, camel or underscore case.
  - `.properties` documents split as Spring Boot's loader splits them, not as `java.util.Properties`: a `#---` or `!---`
    line at column 0, unless the line before is a comment of the same prefix; a comment that opens a document reopens
    the previous one.
  - `complete` with nothing set means neither the configuration files nor the code of the snapshot declare one; a
    deployment can still set a key outside it.
  - `unknown` with reason `no-extractor`, for every route: code that may set a base path anywhere in the commit
    (a `setContextPath` or `setDefaultProperties` call, a `@PropertySource`, a string literal naming one of the keys),
    and an `application.xml` file, which Spring loads as properties and this reader does not read.
  - `unknown` with reason `unresolved` at the declarations: a placeholder, a value that is not one string, two values for
    one key under one profile, a `.properties` value holding a character outside ASCII (Spring decodes the file as
    ISO-8859-1), a `spring.config.import`, a document condition other than one profile (a profile file's
    own condition included), an alias or merge key on the way to a key, a handler outside a main source set, and a handler
    whose module declares no `@SpringBootApplication`: a library module's routes are served under the configuration
    of an application the sources do not tie to it. A file the parser rejects (a duplicate key, a malformed `\u` escape) is `unknown` with reason
    `source-unreadable` at its error. YAML is read with `yaml` 2.9.1, `.properties` as `java.util.Properties` does.
  - Not built: `spring.application.name`, gateway routes and client base URLs of the same row.
- Row S7, as built for the entrypoints only. The `entrypoints` section holds `HttpRoute | Listener | Job | Callback` items told
  apart by `kind`, each with the `name` of [RFC-0001](0001-architecture-and-layers.md): a route `METHOD path` with
  ` v<version>`, a listener `kafka <topic>`, `rabbit <queue>`, `jms <destination>` or `event <qualified type name>`, a
  job `scheduled <attribute>=<value>`. Listeners and jobs carry no base path. Findings at one location are ordered by
  kind, then by name. Framework callbacks carry no base path.
  - Framework-invoked callbacks: `UserDetailsService.loadUserByUsername` requires a scanned bean; Jakarta and
    Javax `ConstraintValidator.isValid` require no bean. Each placed body gives one callback, with evidence for each
    implementing class. An unresolved supertype or ambiguous member is `unknown/unresolved`; a missing body outside
    the repository or an implementation without a proven scanned bean is `unknown/no-extractor`. Factory-registered
    beans, XML beans and library auto-configuration are not proven by this reader. An anonymous implementation and
    a function value returned by a `@Bean` method with the contract as its written return type are `unknown/no-extractor`
    at the creation or value; their bodies are not placed as callbacks.
    DGS `@DgsData` methods on `@DgsComponent` classes are callbacks; type-level uses, composed annotations, abstract
    methods and unproven registration remain `unknown/no-extractor`.
  - One `listener` per destination of `@KafkaListener` (`topics`), `@RabbitListener` (`queues`) and `@JmsListener`
    (`destination`), on a method or, for Kafka and Rabbit, on the class, whose handler is then the class that
    dispatches to its `@KafkaHandler` or `@RabbitHandler` methods; the containers `@KafkaListeners`,
    `@RabbitListeners` and `@JmsListeners` and a repeated annotation give one per annotation.
  - One `listener` per event type of `@EventListener`, `@TransactionalEventListener` and Spring Modulith's
    `@ApplicationModuleListener` (`org.springframework.modulith.events`): each class of `classes` or
    `value`, else the type of the method's single parameter, without its type arguments. The type is named when a
    source declares it, or when a single import, a qualified name or `java.lang` names it. A dotted name is named
    only when its first segment is a single import (`Imported.Created`) or a package, lowercase by Java's naming
    convention (`com.shop.OrderShipped`); `Holder.Created` with `Holder` unimported is `unresolved`, since `Holder` may
    be a type of the file's package or of a wildcard import.
  - One `job` per `@Scheduled`, also inside `@Schedules`, for its one trigger: `cron`, `fixedDelay`, `fixedRate`,
    `fixedDelayString` or `fixedRateString`, the `long` attributes as decimal values. `initialDelay` and `timeUnit`
    are not part of the name. `cron = "-"`, Spring's disabled marker, is no job.
  - Destinations and triggers are evaluated as route paths are: literals and constants, with a placeholder, a SpEL
    expression or U+FFFD left unresolved.
  - A listener needs a bean: a class whose own annotations carry `@Component`, `@Service`, `@Repository`,
    `@Configuration` or a controller stereotype, the same list the controller rule reads.
  - `unknown` with reason `unresolved`: a placeholder, SpEL or constant the sources lack; a listener that names no
    destination; an event type no source or import decides (a simple name a wildcard import or the package may supply,
    a type two files declare, a method with no single parameter).
  - `unknown` with reason `no-extractor`: `topicPattern`, `topicPartitions`, `bindings` and `queuesToDeclare`; a
    `@Scheduled` with no trigger (a one-time task) or with several; a trigger expression this extractor does not
    evaluate; `@StreamListener` (`org.springframework.cloud.stream.annotation`), `@SqsListener`
    (`io.awspring.cloud.sqs.annotation`) and `@PulsarListener` (`org.springframework.pulsar.annotation`), bean or
    not; an annotation the repository declares that composes a listener annotation; a listener annotation of a class
    that is not a bean of its own, with the class as cause; and a listener annotation a bean inherits from a
    supertype, at that annotation and the bean, since Spring searches the hierarchy differently per annotation.
  - Not detected: Spring Cloud Stream functional beans (`Consumer`, `Function` and their bindings), other listener
    annotations composed by a library, listener methods a supertype absent from the sources may declare, the retry
    topics and dead-letter handlers of `@RetryableTopic` and `@DltHandler`, `autoStartup = "false"`, and the
    pairing of listeners with `KafkaTemplate.send` or `publishEvent`, which waits for the events protocol plugin.
- An unknown item's evidence holds distinct lines only: a span that starts on the line of an earlier span and ends no
  later is not repeated (a JAX-RS method that begins at its annotation holds the method span once).
- An unexpected throw never ends the extraction: a file whose parsing or declarations throw is `unknown` with reason
  `source-unreadable` at line 1, a type whose reading throws is `unknown` with reason `unresolved` at the type, and a
  handler whose reading throws is too, at the handler. A `+` chain, nested parentheses, nested type declarations and
  the supertype search are walked with loops, so 20,000 terms, 20,000 parentheses and 5,000 nested classes read like
  small ones; deeper recursion elsewhere (nested ternaries or casts, constants referring to constants) ends as the
  handler's item.
- A file the grammar rejects is `unknown` with reason `source-unreadable`, failing loud. tree-sitter-java 0.23.5, the
  latest on npm, rejects `import module java.base;` (JEP 511), statements before `super(...)` (JEP 513) and Unicode
  escapes with more than one `u`.

Later, each detected meanwhile and answered `unknown` with `no-extractor`: Spring Security `SecurityFilterChain` guards
and `RouterFunction` routes (3-5 days each). Not measured: Kotlin, Gradle multi-module builds, and Boot 4 configuration
keys beyond the documentation ADR-0014 cites.

Both plugins also depend on [RFC-0003](0003-codegraph-integration.md)'s score for heuristic edges (hours).

## Capability matrix

Each plugin publishes a row: fact family × level (`none`, `breadth`, `depth`). The matrix is shown by `ye-ast --help`
and returned by the MCP status tool, so an agent knows what is not covered. Once a plugin is built, its section in this
RFC records the parity results of its measured applications
([ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) rule 4).

### Measured Java callback parity (RFC-0026 U6)

The fixed-revision counterfactuals now expose the framework entrypoint independently of HTTP routes:

| Application | Observable result | Study scope |
|---|---|---|
| JHipster | `callers createSpringSecurityUser` reaches `UserDetailsService.loadUserByUsername` at depth 1; callback trace selects its handler | CF-JHIPSTER-J-BUG |
| Petclinic | `callers PetAgeValidator.isValid` reaches `jakarta.validation.ConstraintValidator.isValid` at depth 0; callback trace is complete | CF-PETCLINIC-J-BUG |
| RealWorld | `callers JwtService.toToken` reaches the DGS resolver at depth 1; the map contains 22 DGS callbacks, including both `MeDatafetcher` methods. `callers DuplicatedArticleValidator.isValid` reaches the Javax validation callback at depth 0 | N-realworld-J-CONFIG.A2-N2 and the callback-discovery part of N-realworld-J-FLOW.A1-N4 |
| Shopizer | The Javax validation trace selects four placed validator bodies | Additional row coverage; N-shopizer-J-FLOW.A2-N2 remains with ADR-0044 |

The external corpus adds four callback traces and four counterfactual caller queries, preserving its original 105
answers. All eight new answers differ from the pre-producer baseline: four formerly unknown trace targets now enter
handler bodies, and each caller answer gains the expected callback. The caller facts also cross the schema
0.21-to-0.22 boundary; this version change is separate from callback discovery.

At the declared trace depth of 1, Petclinic is complete; JHipster, RealWorld and Shopizer remain partial with explicit
cuts. Discovering a validation callback does not establish an execution edge from an HTTP validation site to it.
The anonymous-class body mechanism in N-realworld-J-FLOW.A1-N4 remains open. Lambda, method-reference and anonymous
implementations retain U4's explicit unknown evidence; their bodies are not placed by this RFC.

## Conformance

- Every plugin ships fixtures: a minimal repository and the expected facts.
- Known gaps are fixtures too: each row of a plugin's table names its fixtures, and each fixture is seen failing first.
- A codegraph upgrade runs every fixture. An upgrade of a vendored parser (`@angular/compiler`) runs the fixtures of
  every framework major the plugin declares.
- ngtsc may measure the Angular template extractor offline; no oracle runs during a query.

## Growth control

The rules for adding a family, a framework, a protocol or a construct are
[ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md): five fixed families, parsers and never builds, entry
measured on real applications, a failing fixture first, application idioms as data, explicit `unknown` and
`no-extractor`, one owner per fact.

## Open questions

The owner accepted the recommendation of Q2 on 2026-10-30 and decided Q1 otherwise (translated): "the coverage of
Angular and of Java with Spring must be added solidly".

| # | Question | Recommendation |
|---|---|---|
| 1 | v1 scope: TypeScript/JavaScript and Java (qayaba's declared scope), with Java marked partial? | Decided: v1 covers Angular on TypeScript and Spring on Java, both completely. The DGS annotation row is admitted on one measured application with a conformance fixture; a second measured application is the trigger to retain it ([RFC-0026](0026-framework-invoked-entrypoints.md), resolved question 1). The approach and the definition of done are [ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md); the design per gap is above. Java starts with no statement syntax, no decision syntax and no module syntax in qayaba (`decisions: null`, `statements: null` and no entry among the module syntaxes: qayaba@4105c582 `qa-engine/src/shared-kernel/language-id.ts:27,37-40`), which row S1 adds |
| 2 | Are plugins in-repo packages or separately published? | In-repo until a third party needs to publish one |

### Trace data-access rows (RFC-0013 R12)

The Spring adapter owns the syntax vocabulary for data effects, separate from cross-service call-site transports.
Conformance fixtures live under `src/core/adapters/spring/fixtures/data-effects/`.

| Row | Proven API | Reported fact and limits |
|---|---|---|
| Spring Data repositories | Repository, CrudRepository, ListCrudRepository, PagingAndSortingRepository, ListPagingAndSortingRepository, JpaRepository; project generic specializations | Standard CRUD operations and declared derived queries; @Query is read, @Modifying is write. Only a unique proven project method signature supplies annotations/body semantics; overload ambiguity is a cut. A proven method with a body stays project code. Generic substitution through lexical identity may prove an entity; raw or conflicting entity types yield no target. |
| Spring JDBC | JdbcTemplate/JdbcOperations, NamedParameterJdbcTemplate/NamedParameterJdbcOperations, SimpleJdbcInsert/Operations | Query methods read, update/batchUpdate and insert methods write; arbitrary execute/call has unknown access. No SQL-table inference. Configuration getters are absent. |
| JPA | javax.persistence and jakarta.persistence EntityManager, Query, TypedQuery | find/refresh read; persist/merge/remove/flush write; query terminal methods read or executeUpdate writes. Direct createQuery/createNamedQuery/createNativeQuery chains and standard Query configuration members (setParameter, bounds, hints and modes) are recognized at execution. Query construction alone is absent. Only a find class literal proves its entity. |

Evidence: the REST backend has Spring Data specializations, JDBC implementations and Jakarta EntityManager calls;
the commerce backend has Spring Data specializations and javax EntityManager calls; the acceptance service has a
JpaRepository specialization. MyBatis mapper interfaces and calls occur in one other backend and remain a deferred
row under ADR-0013. Mongo/Redis templates and TypeScript ORMs were not found; no row is added for them.
Project wrappers remain code the trace walks, never vocabulary entries. Each admitted site is subject to slice 4's
exact-position and function-value rules. Reads remain visible with their access class; no entity getter is a data row.
The data effect union and compose schema are extended in place under the owner's no-bump rule (MCP has no consumers).

### Framework member contributions

The registered signals-store plugin extends TypeScript declarations through `FrameworkMemberBindings`. Its per-reading
factory reuses B1 source trees, selects by nearest `@ngrx/signals` manifest dependency and runtime file imports, and
binds members returned by `withMethods` to the declaration receiving `signalStore`. It contributes source positions
and framework evidence; the shared model owns containment, path uniqueness and conflicts. Removing the registry entry
removes this contribution while preserving the language's literal declarations.

Angular build replacement evidence reads workspace `angular.json`, Nx `nx.json` defaults and Nx `project.json`
configurations. Nx project replacement paths are resolved from their enclosing workspace root, not from the project
file's directory. Missing workspace scope for an explicitly Nx-scoped project or unreadable configuration withholds
member proof. These files remain interpretation inputs under a narrowed include; explicit excludes still win.
This safety rule neither selects a build configuration nor establishes an injected provider's scalar value.
