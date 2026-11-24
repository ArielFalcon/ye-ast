# RFC-0045: What a framework invokes is declared in one table per plugin

- Status: Accepted, 2026-11-17. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions); every question is settled as its "Resolved questions" table states.
- Related: [ADR-0137](../adr/0137-what-a-framework-invokes-without-a-written-call-is-a-row-of-one-table-per-plugin-and-an-unexplained-contract-is-never-silent.md),
  [ADR-0138](../adr/0138-an-advice-a-read-pointcut-selects-is-a-trace-step-at-the-join-point-and-an-unreadable-one-is-a-cut.md),
  [ADR-0139](../adr/0139-access-rules-a-framework-declares-for-a-route-are-its-guards-read-from-the-sources-or-reported-as-unread.md),
  [RFC-0026](0026-framework-invoked-entrypoints.md) and [ADR-0048](../adr/0048-a-framework-invoked-implementation-is-an-entrypoint.md)
  (the `callback` kind this RFC extends), [ADR-0044](../adr/0044-one-implementation-closure-with-scoped-vetoes.md) and
  [ADR-0091](../adr/0091-only-advice-that-can-replace-a-body-vetoes-dispatch.md) (advice vetoes),
  [ADR-0100](../adr/0100-an-unknown-entrypoint-item-says-what-it-stands-for-and-a-registration-through-an-unread-type-is-never-silent.md)
  and [ADR-0103](../adr/0103-a-type-reference-written-in-a-member-is-the-members-and-an-unknown-item-claims-a-kind-only-with-evidence.md)
  (unknown entrypoint items), [RFC-0007](0007-extension-model.md) row S7, [RFC-0035](0035-closing-the-extension-model.md) and
  [ADR-0075](../adr/0075-the-core-names-no-language-or-framework.md), [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md),
  [ADR-0051](../adr/0051-an-answer-never-hides-what-the-engine-knows.md) decision 7, [ADR-0077](../adr/0077-derived-facts-persist-by-content-in-ye-asts-own-store.md)
  (stored slot versions)

**In short:** every code path a framework runs without a written call — a contract method, an annotated method, an
advice, a function passed to a framework call — becomes a row of one declarative table per framework plugin, read through
one port (`FrameworkInvocations`) that names no framework; the Java callbacks reader, the advice reader and the
TypeScript deferred-value reader all read it, and a framework-owned supertype or method annotation that no row explains
is an `unknown` entrypoint item instead of silence. It replaces `INVOKED_CONTRACTS`, `FrameworkDeferrals` and the row
names duplicated in `KNOWN`, and adds advice steps to `trace`, advice dependence to `callers`/`impact`, route-run
resolvers to Angular routes and handler access rules to Spring routes. It moves the "reached entrypoints (0)" answers of
`callers`/`impact` for code only a framework reaches, adds the cut row `advice-undecided`, and lowers TypeScript
`effect-unplaced`.

## Problem

| # | Evidence | Source |
|---|---|---|
| 1 | The Java plugin's table of framework-invoked contracts holds four rows: `UserDetailsService`, `ConstraintValidator` (two packages), `DgsData`. | `src/core/adapters/spring/invoked-contracts.ts:8-13` (`INVOKED_CONTRACTS`) |
| 2 | The same row names are written a second time as literals in the annotation vocabulary, so a new annotation row needs two edits. | `src/core/adapters/spring/request-mapping.ts:116-118` (`KNOWN`: `Bean`, `DgsData`, `DgsComponent`), `src/core/adapters/spring/callbacks.ts:181` (literal `org.springframework.context.annotation.Bean`) |
| 3 | The TypeScript deferral table holds five RxJS combinators, argument 0; its only consumer is the deferred-value reader, read only by trace's effect placement. `map`, `tap`, `filter`, `catchError`, `finalize`, Angular `effect` have no row, so an effect written inside their function argument is an `effect-unplaced` cut. | `src/core/adapters/frameworks/rxjs/rxjs.plugin.ts:7-12` (`FUNCTION_TAKERS`, `RXJS_DEFERRALS`); `src/core/adapters/typescript/http-call-sites.adapter.ts:148-175` (`createDeferredValueReader`); `src/composition/compose.ts:346`; `src/core/application/trace/trace-effects.ts:69,94-97`; `src/core/domain/shared/owning-body.ts:51-56` (`executionIn`) |
| 4 | Two shapes of "what a framework invokes" exist as two unrelated port types: `FrameworkDeferrals` (a function) and the adapter-local `InvokedContract` (data). | `src/core/ports/framework-deferrals.port.ts:6-9`; `src/core/adapters/spring/invoked-contracts.ts:4-6` |
| 5 | The advice reader reads only `@Around` advice, and only to veto dispatch; no reader places an advice body anywhere. A trace through a woven call omits the advice with no cut: ADR-0091 records "no new cut is added". | `src/core/adapters/spring/java-dispatch-targets.ts:26` (`BODY_REPLACING_ADVICE`), `:648-666` (`adviceOf`, `if (name !== BODY_REPLACING_ADVICE) continue`), `:591-609` (`globalVeto`); ADR-0091 "Consequences" |
| 6 | A scanned bean that extends a framework-owned base is never an item: the unread-base rule excludes platform packages, and a test pins `extends org.springframework.web.filter.OncePerRequestFilter` as no item. | `src/core/adapters/spring/listeners.ts:84-88` (`unreadBaseOf`, `gap.kind === "missing"`); `src/core/adapters/spring/spring-routes.adapter.test.ts:2824` |
| 7 | `@PostConstruct`, `@PreDestroy`, `@ExceptionHandler` and `@Transactional` on a controller are pinned as "no finding". | `src/core/adapters/spring/spring-routes.adapter.test.ts:1282-1301` |
| 8 | `HttpRoute` carries no guard field; only `UiRoute` carries `guards`. No source file names `SecurityFilterChain`, `HttpSecurity` or `PreAuthorize`, although RFC-0007 says those guards are "detected meanwhile and answered `unknown` with `no-extractor`". | `src/core/domain/entrypoints/http-route.ts:60-72`; `src/core/domain/entrypoints/ui-route.ts:18-28`; `rg -n 'SecurityFilterChain\|HttpSecurity\|PreAuthorize' src -g '!*.test.ts'` → no match; `docs/architecture/rfc/0007-extension-model.md:453` |
| 9 | An Angular route's resolvers are read for route data but not put on the route, and the reached-entrypoint join reads only `guards`: code reached only through a resolver or a `canDeactivate` guard reaches no entrypoint. | `src/core/adapters/typescript/angular-router.extractor.ts:38,309-324` (`RawEntry.resolvers`); `:110` (`GUARD_KEYS` without `canDeactivate`); `src/core/domain/impact/reached-entrypoints.ts:33-34` |
| 10 | Spring's readers are not a `FrameworkPlugin`: composition builds the Spring extractor directly, and the registered plugins are Angular, the signals store and RxJS. | `src/composition/compose.ts:184`; `src/composition/framework-plugins.ts:11-13` |
| 11 | Every derivation of the Java callbacks and entrypoints is persisted by slot version; a reader that changes what it derives must bump its slot. | `src/core/domain/snapshot/stored-derived-facts.ts:6-28` (`java-callbacks`, `java-entrypoints`, `java-relations` at 1); `src/composition/stored-derived-facts.test.ts:78` (`PINNED`) |
| 12 | Corpus prevalence over the four workspaces (Java sources outside `/test/`; TypeScript outside `*.spec.ts` and `node_modules`), counted with `rg -e '<pattern>' -g '*.java' -g '!**/test/**' <workspace> \| wc -l`, per workspace of shape A (Spring REST, ~140 files), B (Spring REST + GraphQL, ~90), C (generated monolith, ~80), D (multi-module, ~1,170): see the table below. | read-only `rg` over the corpus, 2026-11-17 |

| Construct | A | B | C | D | Construct | A | B | C | D |
|---|---|---|---|---|---|---|---|---|---|
| `extends OncePerRequestFilter` | 0 | 1 | 1 | 1 | `@ExceptionHandler` | 3 | 3 | 1 | 9 |
| `implements … Filter` | 0 | 0 | 0 | 1 | `@ControllerAdvice` / `@RestControllerAdvice` | 1 | 1 | 1 | 3 |
| `extends HandlerInterceptorAdapter` | 0 | 0 | 0 | 1 | `@PostConstruct` | 0 | 0 | 1 | 7 |
| `implements … WebMvcConfigurer` | 0 | 0 | 2 | 2 | `@Bean` | 15 | 4 | 13 | 33 |
| `implements … HandlerMethodArgumentResolver` | 0 | 0 | 0 | 2 | `@PreDestroy`, `@InitBinder`, `@ModelAttribute` (method) | 0 | 0 | 0 | 0 |
| `implements … AuthenticationEntryPoint` | 0 | 0 | 0 | 2 | `@Aspect` | 1 | 0 | 1 | 2 |
| `implements … AccessDeniedHandler` | 0 | 0 | 0 | 2 | `@Around` | 1 | 0 | 1 | 0 |
| `implements … ApplicationListener` | 0 | 0 | 0 | 2 | `@After…` / `@AfterReturning` / `@AfterThrowing` | 0 | 0 | 1 | 9 |
| `implements … ServletContextListener` | 0 | 0 | 0 | 1 | `@PreAuthorize` | 37 | 0 | 9 | 1 |
| `implements … InitializingBean` | 0 | 0 | 0 | 2 | `requestMatchers(` / `antMatchers(` / `mvcMatchers(` | 0 | 6 | 20 | 35 |
| `extends WebSecurityConfigurerAdapter` | 0 | 1 | 0 | 5 | `@Async` | 0 | 0 | 5 | 11 |
| `extends StdSerializer` / `JsonSerializer` | 0 | 2 | 0 | 0 | `@Cacheable` | 2 | 0 | 2 | 8 |
| `AuthenticationProvider`, `CommandLineRunner`, `ApplicationRunner`, `DisposableBean`, `Converter`, `JsonDeserializer`, `GenericFilterBean` | 0 | 0 | 0 | 0 | `@Transactional` | 39 | 1 | 12 | 10 |
| TS `catchError(` | 31 | 1 | 7 | 4 | TS `resolve: {` | 1 | 4 | 14 | 0 |
| TS `tap(` | 0 | 7 | 9 | 0 | TS `canDeactivate` | 0 | 0 | 0 | 5 |
| TS `finalize(` | 0 | 1 | 6 | 1 | TS `effect(` | 0 | 3 | 15 | 0 |
| TS `.subscribe(` | 5 | 1 | 57 | 380 | TS `@HostListener` / `host: {` | 1 | 0 | 1 | 1 |

The TypeScript columns count the same four workspaces' front ends; `map(`/`filter(` counts mix arrays and RxJS and are
not given.

**Root cause.** The engine has no single model of "code a framework runs without a written call". Each reader that
needed one wrote its own: a Java table of two row shapes in one adapter, a TypeScript function-shaped vocabulary in a
port, advice knowledge as constants inside the dispatch reader, and literal annotation names in the annotation
vocabulary. Because no model exists, there is no place to ask "does any row explain this framework-owned supertype or
annotation?", so what no row covers is silent: the entrypoint map answers `complete` without it, `callers` and `impact`
answer "reached entrypoints (0)", and `trace` omits advice bodies with no cut.

## Design

### Owner

| Fact | Owner | Why that module |
|---|---|---|
| The row model (what kinds of invocation exist, their fields) | `src/core/ports/framework-invocations.port.ts` (new) | A contract every family reads and every plugin supplies is a port (AGENTS.md placement rule 5); it names no framework (ADR-0075 decision 1). |
| The Spring, servlet, validation, security, Jackson and AOP rows | `src/core/adapters/spring/spring-invocations.ts` (new; replaces `invoked-contracts.ts`) | The Java plugin's framework knowledge already lives in this folder (RFC-0026 "The data"); Spring is not yet a `FrameworkPlugin` (Problem row 10) and this RFC does not move it. |
| The RxJS rows | `src/core/adapters/frameworks/rxjs/rxjs.plugin.ts` (`RXJS_INVOCATIONS`, replaces `RXJS_DEFERRALS`) | The plugin owns its vocabulary (ADR-0045 decision 12). |
| The Angular rows | `src/core/adapters/frameworks/angular/angular.plugin.ts` (`ANGULAR_INVOCATIONS`) | Same. |
| Which repository classes implement a supertype row, which methods carry an annotation row, and what no row explains | `src/core/adapters/spring/callbacks.ts` (`callbacksOfFile`) and `src/core/adapters/spring/unexplained-contracts.ts` (new, called only by `callbacksOfFile`) | `callbacksOfFile` is the one reader of the Java hierarchy for contracts (RFC-0026); the never-silent rule reads the same clauses and the same table, so it is part of the same derivation and the same stored slot (`java-callbacks`). |
| Which advice a pointcut selects at a body | `src/core/adapters/spring/java-advice.ts` (new; the advice reading moves there from `java-dispatch-targets.ts`) | One reader serves the dispatch veto (ADR-0091), the trace port (ADR-0138) and the dependence relations, so the three never disagree about a pointcut. |
| Which function value a framework call runs later | `src/core/adapters/typescript/http-call-sites.adapter.ts` (`createDeferredValueReader`) | Unchanged owner; it now reads argument rows and value cells. |
| Advice steps in trace | `src/core/application/trace/trace-walk.ts` (`walkTrace`) | The one walk that decides steps. |
| Advice dependence | `src/core/adapters/spring/java-relations.adapter.ts` emits `advised-by` relations; `src/core/domain/impact/edge-policy.ts` (`followsRelation`) admits them | Relations are the existing seam by which a read fact becomes dependence (`inbound-edges.ts:211`, `relatedTo`). |
| Route access rules | `src/core/adapters/spring/spring-routes.adapter.ts` (`readHandler` and `contractJoin`) | The route reader already holds the handler and its controller. |
| Route-run declarations of an Angular route | `src/core/adapters/typescript/angular-router.extractor.ts` and `route-table.loader.ts` (`guardsOf`) | The reader that already reads guards places resolvers with the same function. |

### Contract

#### `src/core/ports/framework-invocations.port.ts` (new)

```ts
/** How a framework obtains the implementation it invokes. */
export type Registration =
  /** The framework constructs it from a reference the sources write elsewhere (a constraint annotation names its validator). */
  | "none"
  /** The class is a component the framework registers because of its own annotations, as the plugin's reader decides. */
  | "scanned-bean"
  /** The class itself carries one of these annotations, each by its fully qualified name. */
  | { readonly annotations: readonly string[] };

/** One member of a contract type that the framework invokes, by its documented signature. */
export interface InvokedMember {
  readonly name: string;
  /** The documented parameter types, erased, by simple name; `*` for a parameter typed by a type variable. Its length is the arity. */
  readonly parameters: readonly string[];
  /** The contract itself holds a body for it (a default method, a method of a library base class): a class that declares none runs no repository code for it. */
  readonly defaulted: boolean;
}

/** What the framework does with a method that carries the annotation of an annotation row. */
export type AnnotationInvocation =
  /** It invokes the method when a handler throws. */
  | "exception-handler"
  /** It invokes the method once after construction or once before destruction. */
  | "lifecycle"
  /** It invokes the method at startup to build a component. */
  | "factory"
  /** It invokes the method before the handlers of a request. */
  | "request-preparation"
  /** It invokes the method to resolve a field of a query. */
  | "resolver"
  /** It wraps the written calls to the method and invokes nothing on its own. */
  | "intercepts-call"
  /** It decides who may run the method and invokes nothing on its own (ADR-0139). */
  | "access-rule"
  /** It reads the annotation and invokes nothing because of it. */
  | "marker";

/** The annotation invocations that make the annotated method an entrypoint of kind `callback`. */
export const ENTRY_INVOCATIONS: readonly AnnotationInvocation[] = ["exception-handler", "lifecycle", "factory", "request-preparation", "resolver"];

/** When an advice runs relative to the join point it selects, in the order a trace lists them. */
export const ADVICE_RUNS = ["around", "before", "after-returning", "after-throwing", "after"] as const;
export type AdviceRuns = (typeof ADVICE_RUNS)[number];

/** One thing a framework runs without a written call, or one name it reads and runs nothing for. */
export type InvocationRow =
  /** Members of a library type that the framework invokes on the repository classes that extend or implement it; `members: []` for a type the framework runs nothing of. */
  | { readonly by: "supertype"; readonly type: string; readonly members: readonly InvokedMember[]; readonly registration: Registration }
  /** An annotation the framework acts on when it is written on a method. */
  | { readonly by: "annotation"; readonly type: string; readonly invocation: AnnotationInvocation; readonly registration: Registration }
  /** The annotation that marks a class whose members may be advice. */
  | { readonly by: "aspect"; readonly type: string }
  /** An annotation that makes a member of an aspect an advice, run at the join points its pointcut selects. */
  | { readonly by: "advice"; readonly type: string; readonly runs: AdviceRuns }
  /** An annotation that makes a member of an aspect add supertypes to the types its pattern selects. */
  | { readonly by: "introduction"; readonly type: string }
  /** A function-valued argument of an export of a package that the export runs later, if at all. */
  | {
      readonly by: "argument";
      readonly module: string;
      /** The export, then the members written after it (`["map"]`). */
      readonly path: readonly string[];
      readonly argument: number;
      /** The property names of an object literal written at that argument whose function values the export also runs later; empty when only a function is read there. */
      readonly observerKeys: readonly string[];
    };

/** One framework's table of what it invokes. */
export interface FrameworkInvocations {
  /**
   * Package prefixes, each ending in `.`, whose supertypes and method annotations a reader reports when no row and no
   * other reader of the plugin explains them (ADR-0137 decision 4). Empty: none is reported.
   */
  readonly owns: readonly string[];
  readonly rows: readonly InvocationRow[];
}
```

`src/core/ports/framework-plugin.port.ts`: `FrameworkPlugin` loses `deferrals?: FrameworkDeferrals` and gains
`invocations?: FrameworkInvocations`. `src/core/ports/framework-deferrals.port.ts` keeps `DeferredValues` and
`DeferredValueReader` and deletes `FrameworkDeferrals`.

#### Entrypoint values (domain)

`src/core/domain/entrypoints/ui-route.ts`, `UiRoute` gains two optional fields (ADR-0137 decision 6):

```ts
  /** The resolvers of the entry (`resolve`), placed like guards; absent when the entry declares none. */
  resolvers?: readonly RouteGuard[];
  /** The guards that run when the route is left (`canDeactivate`), placed like guards; absent when the entry declares none. */
  exitGuards?: readonly RouteGuard[];
```

`src/core/domain/entrypoints/http-route.ts` gains (ADR-0139):

```ts
/** Where the access rules of a route may be declared. */
export type AccessSource =
  /** Annotations on the handler method and on its class. */
  | "handler-annotations"
  /** Rules a request filter chain states by path pattern, outside the handler. */
  | "request-filters";

/** An access rule an annotation declares on a route's handler or on its class, as the sources write it. */
export interface AccessRule {
  /** The fully qualified name of the annotation. */
  annotation: string;
  on: "method" | "class";
  /** The values it states, each evaluated to its text, in written order; `unread` when one of them is not a constant the reading evaluates; empty when it states none. */
  values: readonly string[] | "unread";
}

/**
 * The access rules read for one route. `read` names the sources the reading read and `unread` the sources that may also
 * declare rules for the route and were not read. An empty `rules` means that no rule was declared in the sources of
 * `read`: never that the route is unguarded. Whether the application enables the framework's enforcement of the rules is
 * not read.
 */
export interface RouteAccess {
  read: readonly AccessSource[];
  unread: readonly AccessSource[];
  /** Method rules first, then class rules; each group sorted by annotation, then by the values as JSON. */
  rules: readonly AccessRule[];
}
```

and `HttpRoute` gains `access?: RouteAccess` (present on every route the Java reader produces from U11 on; absent
before).

#### Trace, cuts and relations

- `src/core/domain/trace/trace-fact.ts`: `TraceVia` gains `"advice"` (a step an advice selects at the join point of its
  parent step; no `at`).
- `src/core/domain/shared/fact.ts`: `CUT_REASONS` gains `"advice-undecided"` as its **last** member (after
  `"section-unknown"`), so no existing rank changes.
- `src/core/domain/relations/relation.ts`: `RelationKind` gains `"advised-by"` (from an advised method to the advice
  method that runs at its execution).
- `src/core/ports/import-origins.port.ts`:

```ts
/** A method with a body, by its file, a 1-based line from its declaration's first token to its name, and its name. */
export interface AdvisedSite {
  file: string;
  line: number;
  name: string;
}

/** An advice method the reading proves runs at a site, and the annotation that makes it an advice. */
export interface AdviceBody {
  runs: AdviceRuns;
  file: string;
  start: number;
  nameLine: number;
  /** `<path>:<line> advice`, the place of the advice annotation. */
  place: string;
}

/**
 * What runs at the execution of a site besides its body. `advice`: proven to run, sorted by `ADVICE_RUNS` order, then
 * file, then start. `undecided`: places of advice whose pointcut may select the site and is not proven to. `unread`:
 * places of advice whose pointcut the reading cannot read, which may select any site. `capability-absent`: the language
 * pack reads no advice.
 */
export type AdviceAt =
  | { kind: "read"; advice: readonly AdviceBody[]; undecided: readonly string[]; unread: readonly string[] }
  | { kind: "unknown"; reason?: typeof CAPABILITY_ABSENT };
```

and `ImportOrigins` gains the optional member
`advice?(sites: readonly AdvisedSite[], signal?: AbortSignal): Promise<readonly AdviceAt[]>` (one entry per site, in the
order received). `AdviceRuns` is imported from `framework-invocations.port.ts`.

### Rules

#### R1 — Supertype rows (extends RFC-0026's algorithm step 2)

For each supertype row, each repository class whose supertype closure names `row.type` (`supertypeEdges(...).invokes`,
unchanged), concrete and not abstract, and each `member` of the row, in row order:

| Situation | Answer |
|---|---|
| Registration proof fails (`registered`, unchanged for `"none"`/`"scanned-bean"`; `{ annotations }`: one of the class's own annotations has `keyOf` equal to one of the names) | one `unknown("no-extractor")` at the class, subject `{ candidate: "callback", symbol, raisedBy: row.type }`, once per class and row (identical items merge in `sortFindings`) |
| `memberOf` finds exactly one method with a body | `complete` callback `{ name: callbackName(row.type, member.name), contract: { type: row.type, member: member.name }, handler }` (unchanged shape) |
| no method found, `member.defaulted`, and every outside supertype of the class and of its repository ancestors is `row.type` or a member of `MEMBERLESS_PLATFORM_INTERFACES`, with no unsettled supertype name | no finding: the library's own body runs |
| no method found otherwise | unchanged: `unknown("no-extractor")` when a supertype is outside, else `unknown("unresolved")` |
| several methods at one level | unchanged: `unknown("unresolved")` with every span |

A method matches a member when `method.name === member.name`, `method.parameterTypes.length ===
member.parameters.length`, and for every index `i`, `member.parameters[i] === "*" || member.parameters[i] ===
method.parameterTypes[i]` (`parameterTypes` are erased simple names, `java-symbols.ts:1004-1013`).

#### R2 — Annotation rows (extends RFC-0026's algorithm step 3)

Only rows with `invocation` in `ENTRY_INVOCATIONS` produce findings, through the existing annotation branch of
`callbacksOfFile` (`callbacks.ts:141-172`), unchanged except that the registration proof reads `{ annotations }`. Rows
with `intercepts-call`, `access-rule` or `marker` produce nothing in `callbacksOfFile`; they explain names for R3 and
their annotation names enter `KNOWN`. The callback name of an annotation row is `callbackName(row.type)`.

#### R3 — Never silent (ADR-0137 decision 4)

Read per Java file inside `callbacksOfFile`, for the union of `owns` of the tables passed (only `SPRING_INVOCATIONS`
today). Definitions:

- *Owned*: a fully qualified name that starts with one of the `owns` prefixes.
- *Row-explained supertype*: `row.by === "supertype" && row.type === fqn` for some row.
- *Explained annotation*: `annotations.keyOf(use) !== undefined` (after U1 `KNOWN` holds every annotation row type and
  every registration annotation, besides the route, listener, job and stereotype names it holds today), or the use
  names a repository annotation (`project.lookupType(use.name, use.scope)` is an object).
- *Entry annotation*: `keyOf(use)` is in the new `ENTRYPOINT_ANNOTATIONS` set exported by `request-mapping.ts` (every
  `VERBS` key, every `EXCHANGES` member, `KAFKA_LISTENER`, `RABBIT_LISTENER`, `JMS_LISTENER`, `EVENT_LISTENERS`,
  `SCHEDULED`, `LISTENER_CONTAINERS`, `FOREIGN_LISTENERS`, `FOREIGN_METHOD_ENDPOINTS`) or is the type of an annotation
  row whose `invocation` is in `ENTRY_INVOCATIONS`.

| Shape | Reported when | Item |
|---|---|---|
| S. A type declaration of kind `"class"` (abstract or not) writes a supertype clause that `supertypeClausesOf` resolves to `platform` or `library` with an owned FQN that no row explains | the class is a scanned bean (`isScannedBean`) **or** declares at least one method with `overrides === true` (it writes `@Override`) whose name and arity no repository supertype of the class declares | `unknown("no-extractor")`, evidence `[class span with via fqn, ...each such @Override method span with via fqn]`, subject `{ symbol: type.qualifiedName, raisedBy: fqn }`; one item per (class, fqn) |
| A. An annotation use on a method with a body (`hasBody`) of a type of kind `"class"`, not explained, whose candidates (`externalNames(use.name, use.scope.file, false)`) include an owned name | the same method carries no entry annotation | `unknown("no-extractor")`, evidence `[method span with via raisedBy]`, subject `{ symbol: "<type.qualifiedName>.<method.name>", raisedBy }`, where `raisedBy` is the one owned candidate when exactly one candidate is owned and `use.name` otherwise; one item per (method, annotation use) |

No `candidate` is stated (ADR-0103 decision 2: an item claims a kind only with evidence). Interfaces, enums, records,
annotation types, abstract methods, fields, parameters and type-level annotations are outside the rule. Test files are
not read (unchanged). The rule never adds a `complete` finding and never removes one.

#### R4 — Advice selection (ADR-0138 decisions 1–3)

`java-advice.ts` reads every type declaration carrying an `aspect` row's annotation, matched by the simple name of the
row's type exactly as `isAspect` does today (`java-declared-types.ts:127-129`), and every member annotation of it whose
simple name is the simple name of an `advice` or `introduction` row. For an advice it reads the pointcut with
`pointcutText` and `parsePointcut` (moved unchanged). Each designator answers a three-valued `Selection`:

```ts
type Selection = "selects" | "may" | "no";
```

| Designator (closed subset, unchanged) | `no` when | `selects` when (the proof), else `may` |
|---|---|---|
| `execution(<words> <declaring>.<name>(<params>))` | today's test (`executionOf`) is false | `words` is exactly `["*"]` (return `*`, no modifier), `<params>` is exactly `..`, and the test holds for the body (declaring pattern matches `body.owner.fqn` or is absent) |
| `@annotation(<Q>)` | today's test is false | `<Q>` contains a `.` and one annotation of the body method resolves with `qualifiedTypeName(name, scopeOf(body.owner), project)` to `<Q>` |
| `within(<pattern>)` | today's test is false | the pattern matches `body.owner.fqn` and `belowOf(body.owner, hierarchy)` is empty |
| `@within(<Q>)`, `within(@<Q> *)` | today's test is false | `<Q>` contains a `.`, an annotation of `body.owner` resolves to `<Q>`, and `belowOf(body.owner, hierarchy)` is empty |

`&&`: `no` if any part is `no`, `selects` if every part `selects`, else `may`. `||`: `selects` if any part `selects`,
`no` if every part is `no`, else `may`. A parenthesis passes its inner value. "Today's test" is the existing `JoinPoints`
predicate applied to `advisedCallOf(body, hierarchy)` (today's `advisedBy` call construction: the owner, the types below
it and every type above those).

An advice whose pointcut `parsePointcut` rejects is *unread*. The proof is additionally refused (the selection becomes
`may`) when the body method has a `private`, `static` or `final` modifier, or when the aspect class is not a scanned bean
(`isScannedBean`): a proxy advises neither, and only a weaver the sources do not declare would.

#### R5 — Dispatch veto (ADR-0091 unchanged)

`globalVeto` keeps its answer byte for byte: per aspect, in member order, the first member that is an introduction or an
unread `around` advice is the aspect's escape; any escape gives the repository-wide veto; otherwise the scoped advice of
the veto is every readable `around` advice, and `advisedBy` keeps today's boolean (`selection !== "no"`).

#### R6 — Advice steps in trace (ADR-0138 decisions 1, 2, 4)

The walk asks `origins.advice` for a step whose declaration is an indexed callable (`CALLABLE_KINDS`) and is not a
construction, with a *join point* computed from how the step was reached:

| How the step was reached | Join point |
|---|---|
| a root that is the handler of an entrypoint target (`TraceWalkInput.entered` holds its id) | `proxied` |
| a child with `via: "call"` and no `thisCall` | `proxied` |
| a child with `via: "dispatch"` | the join point of its parent step |
| a child with `via` `"own-member"`, `"reference"`, `"member"`, `"template"`, a child with `thisCall`, or a dispatch read late (`readOwedDispatch`) | `self` |
| any other root; a construction; an advice step itself | `none` (advice is not asked) |

| Answer | Join point `proxied` | Join point `self` |
|---|---|---|
| `read`, each `advice` body the store places (`placedMethod`) | a child step `via: "advice"`; `around` and `before` bodies before the step's own children, `after-returning`, `after-throwing` and `after` bodies after them (after the dispatch child too), each group in the answer's order | its `place` is recorded as undecided for this step |
| `read`, an `advice` body the store does not place | its `place` is recorded as undecided for this step | same |
| `read`, `undecided` | each place recorded as undecided for this step | same |
| `read`, `unread` | each place recorded as unread | same |
| `unknown` without reason | one cut `callCut(placeAt(file, startLine, name), [], "advice-undecided")` at the step | same |
| `unknown` with `capability-absent`, or `origins.advice` absent | nothing | nothing |

At the end of the walk: one cut per undecided advice place, `{ kind: "unresolved-link", at: [place, ...sorted step
anchors], reason: "advice-undecided", reach: { kind: "anything", runtime: "java" } }`, the anchors being
`placeAt(file, startLine, name)` of every step it was recorded for; and one cut per unread place,
`{ kind: "unresolved-link", at: [place], reason: "advice-undecided", reach: { kind: "anything", runtime: "java" } }`.
Cuts are sorted by `at[0]`. An advice step is walked like any child (depth, budget, `seen`).

#### R7 — Advice dependence (ADR-0138 decision 5)

For every readable advice and every method with a body of a repository class whose selection is not `no`, the Java
relations reader emits one `advised-by` relation `from` the advised method `to` the advice method (`SymbolRef`s built
with `named(path, nameNode)`), `at` the advice annotation's place. An unread advice adds one cut to
`LanguageRelations.cuts`: `{ kind: "unresolved-link", at: [place], reason: "advice-undecided", reach: { kind:
"callers-of", declarations: [declarationAnchor(adviceFile, adviceMethodName)] } }`. `EDGE_POLICY` gains
`advice: { kinds: ["advised-by"], from: ["method"], to: ["method"], confidence: 1 }` and `followsRelation` admits a
relation of that kind between those kinds; `relatedTo` then reaches the advised method from the advice method, and the
walk continues to the advised method's callers and entrypoints.

#### R8 — Function-argument rows and value cells (TypeScript)

`createDeferredValueReader(invocations, cells)` spans, for each call whose callee is a package export
(`packageExportOf`, unchanged):

| Callee | Argument at `row.argument` (unwrapped) | Deferred spans |
|---|---|---|
| an `argument` row with `module` and `path` equal to the export | an arrow function or function expression | the argument (unchanged) |
| same | an object literal and `row.observerKeys` not empty | each property whose name is in `observerKeys` and whose value (unwrapped) is an arrow function or function expression, and each method declaration of such a name |
| no argument row, and some `cells.runOf(export)` answers `{ kind: "callback", argument }` | an arrow function or function expression at `argument` | the argument |
| anything else | — | none (unchanged) |

#### R9 — Angular route-run declarations (ADR-0137 decision 6)

The router extractor reads `canDeactivate` with `guardsOfKeys(["canDeactivate"])` into `RawEntry.exitGuards`, and each
element of `RawEntry.resolvers` whose value is written gains `ref: RawGuard` (`guardsOfElement(value, span of the
property)[0]`). The table loader resolves both with `guardsOf` into `resolvers` and `exitGuards` of the route, present
only when not empty, after `withoutRepeats`. `reachedEntrypoints` joins a UI route's `guards`, `resolvers` and
`exitGuards` by `path` and `name`, exactly as it joins `guards` today. `canActivateChild` stays as it is.

#### R10 — Route access rules (ADR-0139)

For a route of a handler method `m` of controller class `c` (`readHandler` and `contractJoin`):

1. *Method rules*: each annotation use on `m` whose `keyOf` is the type of an `access-rule` row, `on: "method"`.
2. *Class rules*: the same on `c`'s own annotations and on each class of `project.classChain(c)` after `c`, `on:
   "class"`.
3. `values`: the `value` attribute's expressions in order (an array initializer gives its elements), each evaluated with
   `project.evaluate`; any gap makes `values` `"unread"`; no `value` attribute gives `[]`.
4. `access = { read: ["handler-annotations"], unread: ["request-filters"], rules }`, rules sorted method first, then
   class, then by `annotation`, then by `JSON.stringify(values)`.

### Soundness

| Rule | Why it cannot assert something false | Input that would break it, and how it is excluded |
|---|---|---|
| R1 member match | A member is matched by name, arity and every documented non-variable parameter type; Java dispatches by signature (JLS 8.4.8), so a method with another erased parameter type cannot implement the member. | Two overloads with the same erased simple names in different packages (`a.Request` vs `b.Request`): both match, so the existing "several at one level" rule answers `unknown("unresolved")`. |
| R1 defaulted | No finding only when nothing but the contract itself or a memberless platform interface can hold a body: the body that runs is the library's, which is no repository code. | An unread superclass that overrides the member: excluded, because any outside supertype other than the row's type keeps the `no-extractor` item. |
| R2 | Unchanged from RFC-0026: a callback needs the annotation resolved to the row's FQN and the registration proof. | — |
| R3 | It only adds `unknown` items; it never asserts an entrypoint. | — (noise is bounded by U0's decision table, not by soundness) |
| R4 `selects` | Each proof is a case where AspectJ weaving and a Spring proxy agree that the advice runs at the execution: `execution` with return `*` and parameters `..` matches every method of a matching declaring type; `@annotation` with a qualified name present on the very body; `within`/`@within` on a type with no subtype, so the target class is the declaring class. A private, static or final method, or an aspect that is not a bean, would be advised only by a weaver, so the proof is refused. | An `execution` whose return or parameter pattern narrows (`void`, `(String)`): stays `may`. A `@within` on a base class with a subclass in another package (a proxy matches on the subclass): `belowOf` is not empty, so `may`. A self-invocation (`this.m()`), which a proxy does not advise: join point `self`, so undecided. |
| R4 `no` | `no` is today's veto test answering false; that test is already the over-approximation ADR-0044 decision 5 relies on for soundness of the veto. | — |
| R6 | A step `via: "advice"` is added only for a `selects` answer at a `proxied` join point, where both weaving modes run it. Every other selection is a cut, never silence. | Ordering between two aspects is not established (`@Order` is not read); the RFC states the listing order only. |
| R7 | Dependence families are "may depend" answers; a relation for `may` adds a possible dependent and never removes one. An unread pointcut is a cut, not a relation to every method. | — |
| R8 | An export listed as running its argument later runs it only when the observable is subscribed or the signal is read: "later, if at all" is the stated meaning of `deferred` (`trace-fact.ts:31-34`). | `map` imported from a package other than `rxjs`/`rxjs/operators`: `packageExportOf` names the real module, so the row does not match. `Array.prototype.map`: a member call, never a package export. |
| R9 | A resolver and a leave guard run only on navigation to or from the route; joining them to the route adds the route as a reached entrypoint of code they run. | — |
| R10 | Rules are reported as declared, with `read`/`unread`; the type never states "unguarded", and an unevaluated value is `unread`. | An application that does not enable method security: the rule is still declared; the type's doc says enforcement is not read. |

### What this design deliberately does not do

- It does not make Spring a `FrameworkPlugin` and does not move `adapters/spring/` (ADR-0075 decisions 3 and 5 own that).
- It does not read registration through `@Bean` factories, `FilterRegistrationBean`, `addInterceptor(new …)`,
  `@JsonSerialize(using = …)` or `addSerializer(…)` (ADR-0048 decision 4 keeps them `unknown`).
- It does not evaluate `SecurityFilterChain`/`HttpSecurity` matcher chains (`request-filters` stays `unread`).
- It does not decide aspect order, `@Order`, or the effect of `proceed()` on the body.
- It does not change `@Async`, `@Cacheable` or `@Transactional` semantics in any family.

## Delivery units

| Unit | Behavior | Size | Corpus gate |
|---|---|---|---|
| U0 | Measure what the never-silent rule would report, per workspace, and settle `owns` and the known rows | script outside the repository | none (no source change) |
| U1 | One invocation port; the four Java rows, the RxJS rows and the `KNOWN` names move into tables; no fact changes | ~250 | `--expect none` |
| U2 | Request-pipeline contracts: servlet filters, interceptors, MVC configurer, argument resolvers, security handlers; parameters and defaulted members | ~300 | `entrypoints:+ callers:+ impact:+` |
| U3 | Annotated methods the framework invokes: exception handlers, lifecycle callbacks, bean factories | ~250 | `entrypoints:+ callers:+ impact:+` |
| U4 | Application and configuration contracts: application listeners, servlet context listeners, initializing beans, security configurer adapter, JSON serializers | ~220 | `entrypoints:+ callers:+ impact:+` |
| U5 | Known rows and the never-silent rule | ~350 | `entrypoints:± callers:± impact:±` |
| U6 | One advice reader with three-valued selection; the veto unchanged | ~250 | `--expect none` |
| U7 | Advice is a trace step at a proxied join point; undecided and unread advice are cuts | ~350 | `trace:+`, `--expect-cuts advice-undecided:+` |
| U8 | An advised method depends on its advice in `callers` and `impact` | ~250 | `callers:+ impact:+`, `--expect-cuts advice-undecided:+` |
| U9 | RxJS and Angular argument rows; value cells that run a callback defer it | ~200 | `trace:+`, `--expect-cuts effect-unplaced:-` |
| U10 | Angular resolvers and leave guards are on their route and join it | ~250 | `entrypoints:± callers:+ impact:+` |
| U11 | Spring routes carry the access rules of their handler annotations | ~300 | `entrypoints:± workspace:±` |

Order: U0 and U1 first (either order); U2, U3, U4 after U1 in that order; U5 after U0, U2, U3 and U4; U6 after U1; U7
and U8 after U6; U9 after U1; U10 independent; U11 after U5.

### Rules for every unit

1. **First step:** merge `main`, then locate by name every symbol the unit's "Locate" list names (`rg -n '<symbol>'`).
   If one is gone or renamed, stop and report; never re-create it.
2. Write the RED test, run only that test file, and keep the failing output. If it passes before the change, stop.
3. Implement; run the touched test files; then `npm run typecheck`, `npm run arch:check`, and `npm run check` once.
4. **Stored slots:** a unit that changes what a stored slot's reader derives (named in the unit) bumps that slot by one in
   `STORED_DERIVED_FACT_VERSIONS` (`src/core/domain/snapshot/stored-derived-facts.ts`) and in `PINNED`
   (`src/composition/stored-derived-facts.test.ts`), and sets `PINNED`'s digest to the one the test reports.
5. Any existing test whose assertion changes and that the unit does not name is a stop condition: report it with its
   output, never adjust it.
6. Corpus gate: `node --import tsx scripts/corpus-gate.ts --corpus <manifest> --base main --candidate <branch>` with
   the unit's `--expect`; every difference is attributed to a rule of the unit; a family not declared that moves is a
   stop condition.
7. Commit with a Conventional Commit message and the `Corpus-Gate:` trailer the gate prints; no attribution line.

### U0 — Measure what the never-silent rule would report

- **Goal:** count, per workspace, the items R3 would report once U2–U5's rows exist, and decide the `owns` prefixes
  and the known rows from that count.
- **Prerequisites:** none.
- **Files:** none in the repository. One script in a `mktemp -d` directory outside the repository; delete it at the end.
- **Locate:** `createJavaParser`, `withJavaSources`, `createJavaProject`, `externalNames`, `scopeOf`,
  `supertypeClausesOf`, `annotationUses`, `isScannedBean`, `createSpringAnnotations`.
- **Steps:**
  1. `SCRATCH=$(mktemp -d)`; write `$SCRATCH/measure-unexplained.ts` with the content below, replacing nothing.
  2. For each workspace directory `W` of the corpus (never the excluded one), run from the repository root:
     `YE_AST_CHECKOUT=$PWD node --import tsx $SCRATCH/measure-unexplained.ts <W> >> $SCRATCH/out.jsonl`.
  3. Apply the decision table to `out.jsonl`; record the result (counts per workspace shape, never names) in the U5
     report and in RFC-0007 row S7 when U5 lands.
  4. `rm -r "$SCRATCH"` only after checking the variable is not empty.

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.YE_AST_CHECKOUT;
const workspace = process.argv[2];
if (root === undefined || root === "" || workspace === undefined) throw new Error("usage: YE_AST_CHECKOUT=<checkout> measure-unexplained.ts <workspace>");
const { createJavaParser } = await import(`${root}/src/core/adapters/tree-sitter/java-parser.adapter.ts`);
const { withJavaSources } = await import(`${root}/src/core/adapters/spring/java-project.ts`);
const { createJavaProject, externalNames, scopeOf } = await import(`${root}/src/core/adapters/spring/java-symbols.ts`);
const { supertypeClausesOf } = await import(`${root}/src/core/adapters/spring/java-dispatch-targets.ts`);
const { annotationUses, isScannedBean, createSpringAnnotations } = await import(`${root}/src/core/adapters/spring/request-mapping.ts`);

/** Candidate owned prefixes; U0 decides which enter `owns`. */
const PREFIXES = ["org.springframework.", "jakarta.servlet.", "javax.servlet.", "com.fasterxml.jackson.databind."];
/** Every supertype row type of RFC-0045's tables (U1–U5), the known rows included. */
const ROW_SUPERTYPES = new Set<string>([/* paste every `type` of the "Spring rows" supertype table, U1–U5 */]);
/** Every annotation row type and every registration annotation of RFC-0045's tables (U1–U5), the known rows included. */
const ROW_ANNOTATIONS = new Set<string>([/* paste every `type` and registration annotation of the "Spring rows" annotation table, U1–U5 */]);
/** The route, listener and job annotation names `ENTRYPOINT_ANNOTATIONS` will hold (R3). */
const ENTRY = new Set<string>([/* paste the members R3 lists for ENTRYPOINT_ANNOTATIONS, from request-mapping.ts */]);

const owned = (fqn: string) => PREFIXES.find((prefix) => fqn.startsWith(prefix));
const paths = (readdirSync(workspace, { recursive: true }) as string[]).filter((path) => path.endsWith(".java") && !path.split("/").includes("test") && !path.includes("node_modules"));
const sources = paths.map((path) => ({ path, content: readFileSync(join(workspace, path), "utf8") }));
const counts = { supertypes: {} as Record<string, number>, annotations: {} as Record<string, number> };
const add = (table: Record<string, number>, key: string) => void (table[key] = (table[key] ?? 0) + 1);
withJavaSources(await createJavaParser(), (parse) => {
  const { files } = parse(sources);
  const project = createJavaProject(files);
  const annotations = createSpringAnnotations(project);
  for (const type of project.types.filter((candidate) => candidate.kind === "class")) {
    const overriding = type.methods.some((method) => method.overrides);
    const bean = isScannedBean(type, annotations);
    for (const clause of supertypeClausesOf(type.node, type.file, project)) {
      const fqn = clause.resolved?.kind === "platform" || clause.resolved?.kind === "library" ? clause.resolved.fqn : undefined;
      if (fqn !== undefined && owned(fqn) !== undefined && !ROW_SUPERTYPES.has(fqn) && (bean || overriding)) add(counts.supertypes, fqn);
    }
    for (const method of type.methods.filter((candidate) => candidate.hasBody)) {
      const uses = annotationUses(method.node, scopeOf(type));
      const keyOf = (use: (typeof uses)[number]) => annotations.keyOf(use) ?? externalNames(use.name, use.scope.file, false).find((name: string) => ROW_ANNOTATIONS.has(name) || ENTRY.has(name));
      if (uses.some((use) => ENTRY.has(keyOf(use) ?? "") || ROW_ANNOTATIONS.has(keyOf(use) ?? ""))) continue;
      for (const use of uses) {
        if (typeof project.lookupType(use.name, use.scope) === "object" || keyOf(use) !== undefined) continue;
        const candidates = externalNames(use.name, use.scope.file, false).filter((name: string) => owned(name) !== undefined);
        if (candidates.length > 0) add(counts.annotations, candidates.length === 1 ? candidates[0] : use.name);
      }
    }
  }
});
console.log(JSON.stringify({ workspace, javaFiles: sources.length, ...counts }));
```

  The `ROW_ANNOTATIONS` co-location check in the script (`uses.some(...)`) is an over-count bound: it treats every row
  annotation as an entry annotation, which only removes items; R3 removes them only for entry annotations. The script
  therefore counts at most what U5 reports for shape A, and the decision table below uses it only to classify names.

- **Decision table** (read `out.jsonl`; one decision per fully qualified name, then per prefix):

| What the output shows for a name | Decision |
|---|---|
| The framework's documentation says it invokes a member of the type, or the annotated method, and the name is a supertype | add a supertype row to U4's table with the documented members (U4 grows; its RED test gains one class per added row) |
| Same, and the name is an annotation | add an annotation row with the documented `invocation` to U3's table, same rule |
| The documentation says the type is a value or an exception type, or the annotation wraps written calls, states access, or is a marker | add a known row to U5's table (`members: []`, or `intercepts-call` / `access-rule` / `marker`), citing the documentation page in the commit body |
| The documentation does not settle it | it stays unexplained: U5 reports it; list it in the U5 report |
| Every name under a prefix is decided by the three rows above | the prefix enters `SPRING_INVOCATIONS.owns` in U5 |
| A name under a prefix stays unsettled and appears in two or more workspaces | the prefix does **not** enter `owns`; record why in RFC-0007 row S7; U5 proceeds with the other prefixes |

  Default if U0 is skipped by the owner: `owns` is `["org.springframework.", "jakarta.servlet.", "javax.servlet."]` and
  the known rows are exactly U5's table.
- **RED test:** none: a measurement.
- **Acceptance:** `out.jsonl` has one line per workspace; every name in it carries a decision; the decisions are in the
  U5 report.
- **Corpus gate expectation:** not run (no source change).
- **Risk:** none.
- **Stop conditions:** a script import fails because a symbol moved (locate it, report, do not edit the repository); a
  workspace parse throws.

### U1 — One invocation port and one table per plugin

- **Goal:** move every existing "framework invokes" row into the `FrameworkInvocations` model with no fact changed.
- **Prerequisites:** none.
- **Locate:** `INVOKED_CONTRACTS`, `InvokedContract`, `Registration`, `callbacksOfFile`, `mergeCallbacks`, `memberOf`,
  `registered`, `KNOWN`, `FrameworkDeferrals`, `RXJS_DEFERRALS`, `FUNCTION_TAKERS`, `createDeferredValueReader`,
  `FrameworkPlugin`, `deferredValues` (in `compose.ts`).
- **Files to create:** `src/core/ports/framework-invocations.port.ts` (the contract above, all of it);
  `src/core/adapters/spring/spring-invocations.ts`.
- **Files to edit:**
  - `src/core/ports/framework-plugin.port.ts`: replace `deferrals?: FrameworkDeferrals` by
    `invocations?: FrameworkInvocations`; replace the import.
  - `src/core/ports/framework-deferrals.port.ts`: delete `FrameworkDeferrals` and the `CellFactory` import if unused.
  - `src/core/adapters/spring/callbacks.ts`: `callbacksOfFile` and `mergeCallbacks` take
    `rows: readonly InvocationRow[]` and work on `callbackRowsOf(rows)` (new, exported from `callbacks.ts`:
    `rows.filter((row) => row.by === "supertype" || (row.by === "annotation" && ENTRY_INVOCATIONS.includes(row.invocation)))`);
    the supertype branch iterates `row.members` and matches with R1's member rule; `registered` takes the port's
    `Registration` and reads `{ annotations }` as "some own annotation's `keyOf` is in the list"; the callback of a
    member is `callbackName(row.type, member.name)`. Do not implement `defaulted` handling yet.
  - `src/core/adapters/spring/spring-routes.adapter.ts`: replace every `INVOKED_CONTRACTS` (import, `mergeRoutes`,
    `routesOver`, `keptByReads`) by `SPRING_INVOCATIONS.rows`.
  - `src/core/adapters/spring/request-mapping.ts`: in `KNOWN`, replace the literals `"com.netflix.graphql.dgs.DgsData"`
    and `"com.netflix.graphql.dgs.DgsComponent"` by `...invocationAnnotationNames(SPRING_INVOCATIONS)`, a new function
    exported by `spring-invocations.ts` that answers every `annotation`, `aspect`, `advice` and `introduction` row type
    and every name of every `{ annotations }` registration, sorted and unique. Keep `"org.springframework.context.annotation.Bean"`
    (U3 removes it).
  - `src/core/adapters/frameworks/rxjs/rxjs.plugin.ts`: replace `RXJS_DEFERRALS` by
    `RXJS_INVOCATIONS: FrameworkInvocations = { owns: [], rows }` where `rows` is, for `module` in `["rxjs",
    "rxjs/operators"]` and `name` in `["defer", "switchMap", "mergeMap", "concatMap", "exhaustMap"]` in that order,
    `{ by: "argument", module, path: [name], argument: 0, observerKeys: [] }`; `createRxjsPlugin` returns
    `invocations: RXJS_INVOCATIONS`.
  - `src/core/adapters/typescript/http-call-sites.adapter.ts`: `createDeferredValueReader(invocations: readonly
    FrameworkInvocations[])`; `run` is the first row with `by === "argument"`, `row.module === exported.module` and
    `row.path` equal element-wise to `exported.path`; nothing else changes.
  - `src/composition/compose.ts:346`: `createDeferredValueReader(typescriptFrameworks.flatMap((plugin) => plugin.invocations ?? []))`.
  - Tests: `src/composition/framework-plugins.conformance.test.ts` (`plugin.deferrals` → `plugin.invocations`);
    `src/core/adapters/typescript/http-call-sites.adapter.test.ts` (`DEFERRALS` becomes
    `{ owns: [], rows: [{ by: "argument", module: "later-lib", path: ["later"], argument: 1, observerKeys: [] }] }`
    typed `FrameworkInvocations`).
- **Delete:** `src/core/adapters/spring/invoked-contracts.ts`.
- **`spring-invocations.ts` content:** `SPRING_INVOCATIONS: FrameworkInvocations = { owns: [], rows }` with exactly the
  four migrated rows:
  `{ by: "supertype", type: "org.springframework.security.core.userdetails.UserDetailsService", members: [{ name: "loadUserByUsername", parameters: ["*"], defaulted: false }], registration: "scanned-bean" }`;
  `{ by: "supertype", type: "jakarta.validation.ConstraintValidator", members: [{ name: "isValid", parameters: ["*", "*"], defaulted: false }], registration: "none" }`;
  the same for `javax.validation.ConstraintValidator`;
  `{ by: "annotation", type: "com.netflix.graphql.dgs.DgsData", invocation: "resolver", registration: { annotations: ["com.netflix.graphql.dgs.DgsComponent"] } }`.
  `parameters` of `"*"` keep today's arity-only match, so no answer moves.
- **Do not touch:** `java-dispatch-targets.ts`, `listeners.ts`, the stored slot versions.
- **RED test:** none: a refactor. Its guard is that every existing test passes unchanged, in particular
  `callbacks.test.ts`, `spring-routes.adapter.test.ts`, `spring-routes-kept.adapter.test.ts`,
  `framework-plugins.conformance.test.ts`, `http-call-sites.adapter.test.ts` (deferral tests) and
  `stored-derived-facts.test.ts` with **no** digest change.
- **Fitness function:** create `src/core/adapters/spring/spring-invocations.single-rule.test.ts`: for every row of
  `SPRING_INVOCATIONS` whose `by` is not `argument`, the literal `"<row.type>"` appears in no production file under
  `src/` other than `spring-invocations.ts` (the existing `request-mapping.ts` `Bean` literal is listed in a `pending`
  array that U3 empties). In `src/composition/framework-plugins.single-rule.test.ts` add: "no export is both an argument
  row and a value cell": for every registered plugin's argument row, every registered `cells.runOf({ module, path })`
  answers `undefined`.
- **Acceptance:** owner `spring-invocations.ts` and the plugins' tables; contract: `InvocationRow` is a closed union;
  no second path: `INVOKED_CONTRACTS`, `FrameworkDeferrals` and the two DGS literals are gone; no special case: one
  match rule; fitness: the two tests above.
- **Corpus gate:** `--expect none`.
- **Risk:** item 3 (`FrameworkPlugin.deferrals` is renamed; only in-repository plugins implement it).
- **Stop conditions:** a stored digest changes; any answer of the corpus gate differs.

### Spring rows

Every row comes from the framework's documented API (ADR-0013 decision 5). Column "Unit" is where it lands; "Deferred"
rows stay unexplained and, when their package is owned, are reported by R3.

**Supertype rows** (`by: "supertype"`; `parameters` erased simple names; `d` = `defaulted: true`):

| Type | Members | Registration | Unit |
|---|---|---|---|
| `org.springframework.security.core.userdetails.UserDetailsService` | `loadUserByUsername(*)` | scanned-bean | U1 |
| `jakarta.validation.ConstraintValidator`, `javax.validation.ConstraintValidator` | `isValid(*, *)` | none | U1 |
| `jakarta.servlet.Filter`, `javax.servlet.Filter` | `doFilter(ServletRequest, ServletResponse, FilterChain)`; `init(FilterConfig)` d; `destroy()` d | scanned-bean | U2 |
| `org.springframework.web.filter.OncePerRequestFilter` | `doFilterInternal(HttpServletRequest, HttpServletResponse, FilterChain)`; `shouldNotFilter(HttpServletRequest)` d | scanned-bean | U2 |
| `org.springframework.web.servlet.HandlerInterceptor`, `org.springframework.web.servlet.handler.HandlerInterceptorAdapter` | `preHandle(HttpServletRequest, HttpServletResponse, Object)` d; `postHandle(HttpServletRequest, HttpServletResponse, Object, ModelAndView)` d; `afterCompletion(HttpServletRequest, HttpServletResponse, Object, Exception)` d | scanned-bean | U2 |
| `org.springframework.web.servlet.config.annotation.WebMvcConfigurer` | each `d`: `configurePathMatch(PathMatchConfigurer)`, `configureContentNegotiation(ContentNegotiationConfigurer)`, `configureAsyncSupport(AsyncSupportConfigurer)`, `configureDefaultServletHandling(DefaultServletHandlerConfigurer)`, `addFormatters(FormatterRegistry)`, `addInterceptors(InterceptorRegistry)`, `addResourceHandlers(ResourceHandlerRegistry)`, `addCorsMappings(CorsRegistry)`, `addViewControllers(ViewControllerRegistry)`, `configureViewResolvers(ViewResolverRegistry)`, `addArgumentResolvers(List)`, `addReturnValueHandlers(List)`, `configureMessageConverters(List)`, `extendMessageConverters(List)`, `configureHandlerExceptionResolvers(List)`, `extendHandlerExceptionResolvers(List)`, `getValidator()`, `getMessageCodesResolver()` | scanned-bean | U2 |
| `org.springframework.web.method.support.HandlerMethodArgumentResolver` | `supportsParameter(MethodParameter)`; `resolveArgument(MethodParameter, ModelAndViewContainer, NativeWebRequest, WebDataBinderFactory)` | scanned-bean | U2 |
| `org.springframework.security.web.AuthenticationEntryPoint` | `commence(HttpServletRequest, HttpServletResponse, AuthenticationException)` | scanned-bean | U2 |
| `org.springframework.security.web.access.AccessDeniedHandler` | `handle(HttpServletRequest, HttpServletResponse, AccessDeniedException)` | scanned-bean | U2 |
| `org.springframework.context.ApplicationListener` | `onApplicationEvent(*)` | scanned-bean | U4 |
| `jakarta.servlet.ServletContextListener`, `javax.servlet.ServletContextListener` | `contextInitialized(ServletContextEvent)` d; `contextDestroyed(ServletContextEvent)` d | scanned-bean | U4 |
| `org.springframework.beans.factory.InitializingBean` | `afterPropertiesSet()` | scanned-bean | U4 |
| `org.springframework.security.config.annotation.web.configuration.WebSecurityConfigurerAdapter` | `configure(HttpSecurity)` d; `configure(WebSecurity)` d; `configure(AuthenticationManagerBuilder)` d | scanned-bean | U4 |
| `com.fasterxml.jackson.databind.JsonSerializer`, `com.fasterxml.jackson.databind.ser.std.StdSerializer` | `serialize(*, JsonGenerator, SerializerProvider)` | `{ annotations: ["org.springframework.boot.jackson.JsonComponent"] }` | U4 |
| `org.springframework.web.filter.GenericFilterBean`, `org.springframework.security.authentication.AuthenticationProvider`, `org.springframework.boot.CommandLineRunner`, `org.springframework.boot.ApplicationRunner`, `org.springframework.beans.factory.DisposableBean`, `org.springframework.core.convert.converter.Converter`, `com.fasterxml.jackson.databind.JsonDeserializer` | — | — | Deferred (0 in the corpus) |

**Annotation rows** (`by: "annotation"`):

| Type | Invocation | Registration | Unit |
|---|---|---|---|
| `com.netflix.graphql.dgs.DgsData` | resolver | `{ annotations: ["com.netflix.graphql.dgs.DgsComponent"] }` | U1 |
| `org.springframework.web.bind.annotation.ExceptionHandler` | exception-handler | `{ annotations: ["org.springframework.web.bind.annotation.RestController", "org.springframework.stereotype.Controller", "org.springframework.web.bind.annotation.ControllerAdvice", "org.springframework.web.bind.annotation.RestControllerAdvice"] }` | U3 |
| `jakarta.annotation.PostConstruct`, `javax.annotation.PostConstruct`, `jakarta.annotation.PreDestroy`, `javax.annotation.PreDestroy` | lifecycle | scanned-bean | U3 |
| `org.springframework.context.annotation.Bean` | factory | `{ annotations: ["org.springframework.context.annotation.Configuration", "org.springframework.stereotype.Component", "org.springframework.stereotype.Service", "org.springframework.stereotype.Repository", "org.springframework.stereotype.Controller", "org.springframework.web.bind.annotation.RestController", "org.springframework.boot.autoconfigure.SpringBootApplication", "org.springframework.boot.SpringBootConfiguration"] }` | U3 |
| `org.springframework.transaction.annotation.Transactional`, `org.springframework.scheduling.annotation.Async`, `org.springframework.cache.annotation.Cacheable`, `…CachePut`, `…CacheEvict`, `…Caching`, `org.springframework.security.access.prepost.PreFilter`, `…PostFilter`, `org.springframework.validation.annotation.Validated`, `org.springframework.retry.annotation.Retryable` | intercepts-call | none | U5 |
| `org.springframework.security.access.prepost.PreAuthorize`, `…PostAuthorize`, `org.springframework.security.access.annotation.Secured`, `jakarta.annotation.security.RolesAllowed`, `…PermitAll`, `…DenyAll`, `javax.annotation.security.RolesAllowed`, `…PermitAll`, `…DenyAll` | access-rule | none | U5 |
| `org.springframework.lang.Nullable`, `org.springframework.lang.NonNull` | marker | none | U5 |
| `org.springframework.web.bind.annotation.InitBinder`, `org.springframework.web.bind.annotation.ModelAttribute` (method-level), `org.springframework.retry.annotation.Recover` | — | — | Deferred (0 in the corpus; R3 reports them) |

**AOP rows** (U6): `{ by: "aspect", type: "org.aspectj.lang.annotation.Aspect" }`; `{ by: "advice", type:
"org.aspectj.lang.annotation.Around", runs: "around" }`, `Before` → `before`, `AfterReturning` → `after-returning`,
`AfterThrowing` → `after-throwing`, `After` → `after`; `{ by: "introduction", type:
"org.aspectj.lang.annotation.DeclareParents" }` and `DeclareMixin`.

**`owns`** (U5): the prefixes U0 settles; default `["org.springframework.", "jakarta.servlet.", "javax.servlet."]`.

**Existing tests that pin "no finding", with their new expectation:**

| Test | Unit | New expectation | Why the change is right |
|---|---|---|---|
| `spring-routes.adapter.test.ts` "annotations of the platform and of the repository are not library annotations" (`:1282`) | U3 | replace `assert.deepEqual(findings, [])` by `assert.deepEqual(unknowns(findings), [])`, `assert.deepEqual(routes(findings), [])` and the callbacks `["jakarta.annotation.PostConstruct@Orders.start", "jakarta.annotation.PreDestroy@Orders.stop", "org.springframework.web.bind.annotation.ExceptionHandler@Orders.handle"]` (as `` `${name}@${handler.symbol}` ``, in finding order) | The test guards that platform annotations are not library annotations (no unknown item), which still holds; the three methods are invoked by the framework, and "no finding" was the silent defect. `@Transactional` stays no finding (U5 makes it a known `intercepts-call` row). |
| same file, "a base class the platform owns, a class that is no bean and a controller leave no unread-base item" (`:2824`) | U2, U5 | unchanged: it filters items without `candidate`; after U2 `Platform` gets one item with `candidate: "callback"` (no `doFilterInternal`), which the filter excludes; after U5 `OncePerRequestFilter` is row-explained, so R3 adds nothing | The unread-base rule (ADR-0100) is still correct for platform bases; the class is now covered by the contract row instead. |
| same file, "interfaces of the platform packages are not gaps" (`:871`) | U4 | `assert.deepEqual(gaps(findings), [])` and callbacks `["org.springframework.beans.factory.InitializingBean.afterPropertiesSet@Plain.afterPropertiesSet"]` | `afterPropertiesSet` of a bean is invoked by the container. |
| same file, "a repository under a platform package does not claim the platform's other packages" (`:903`) | U4 | `assert.deepEqual(gaps(findings), [])` and the same callback for `Plain` | Same. |
| `callbacks.test.ts` "callback conformance: security/lambda-bean" | U3 | `fixtures/callbacks/security/lambda-bean/expected.json` gains one more `{ "status": "unknown", "reason": "no-extractor" }` (four entries); the lambda-specific assertion filters `findings.filter((f) => f.status === "unknown" && f.evidence[0]?.via === via)` | `Config` carries no registration annotation, so its `@Bean` methods are an item, never silence. |
| `framework-plugins.conformance.test.ts` "an RxJS export outside the closed list, or one from another module, owns no function value" (`:497`) | U9 | remove `map(() => 1); ` from its content; `DEFERRAL_ENTRIES` (`:486`) gains `map`, `tap`, `filter`, `catchError`, `finalize` | `map` is in the closed list now; the test keeps its meaning for the remaining exports. |

### U2 — Request-pipeline contracts

- **Goal:** the U2 supertype rows of the table produce callbacks, with parameter matching and defaulted members (R1).
- **Prerequisites:** U1.
- **Locate:** `callbacksOfFile`, `memberOf`, `supertypeEdges`, `edgesOf`, `MEMBERLESS_PLATFORM_INTERFACES`, `SPRING_INVOCATIONS`.
- **Files to edit:** `spring-invocations.ts` (append the U2 rows, in table order); `callbacks.ts` (R1's defaulted row of
  the table: after `memberOf` answers no method, compute `outsideOf(type, edges)` — new function: the union of
  `edges.of(t).invoked` over `t` in the class and its repository ancestors, and `true` for "unsettled" when any
  `edges.of(t).unsettled` is not empty — and skip the member when it is `defaulted`, nothing is unsettled and every name
  is `row.type` or in `MEMBERLESS_PLATFORM_INTERFACES`); `callbacks.test.ts`.
- **Stored slot:** `java-callbacks` (rule 4).
- **Do not touch:** the annotation branch, `listeners.ts`, `request-mapping.ts`.
- **RED tests** (add to `callbacks.test.ts`; each source is one file `src/main/java/app/<Name>.java` extracted with
  `createSpringRoutesExtractor(await createJavaParser()).extract([...])`; `callbacks` below means
  `findings.flatMap((f) => f.status === "complete" && f.value.kind === "callback" ? [`${f.value.name}@${f.value.handler.symbol}:${f.value.handler.line}`] : [])`
  and `items` means `findings.filter((f) => f.status === "unknown" && f.subject?.candidate === "callback")`):
  1. "a contract member with a library body is an entrypoint only where the repository declares it":

     ```java
     package app;
     import jakarta.servlet.http.HttpServletRequest;
     import jakarta.servlet.http.HttpServletResponse;
     import org.springframework.stereotype.Component;
     import org.springframework.web.servlet.HandlerInterceptor;
     @Component class Audit implements HandlerInterceptor {
       public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) { return true; }
     }
     ```

     Today `callbacks` is `[]`. After: `["org.springframework.web.servlet.HandlerInterceptor.preHandle@Audit.preHandle:7"]`
     and `items` is `[]`.
  2. "a defaulted member is an item when an unread superclass may declare it": the same source with
     `class Audit extends lib.Base implements HandlerInterceptor`. After: the same callback, and `items` holds exactly one
     item, reason `no-extractor`, subject `{ candidate: "callback", symbol: "Audit", raisedBy: "org.springframework.web.servlet.HandlerInterceptor" }`
     (the two missing members give identical items, kept once).
  3. "a member is matched by its documented parameter types":

     ```java
     package app;
     import jakarta.servlet.Filter;
     import jakarta.servlet.FilterChain;
     import jakarta.servlet.ServletRequest;
     import jakarta.servlet.ServletResponse;
     import org.springframework.stereotype.Component;
     @Component class Gate implements Filter {
       public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain) {}
       public void doFilter(String a, String b, String c) {}
     }
     ```

     After: `callbacks` is `["jakarta.servlet.Filter.doFilter@Gate.doFilter:8"]`, `items` is `[]`.
  4. "a contract implementation that is no bean is an item": source with
     `class Entry implements AuthenticationEntryPoint { public void commence(HttpServletRequest request, HttpServletResponse response, AuthenticationException failure) {} }`
     and imports `jakarta.servlet.http.HttpServletRequest`, `jakarta.servlet.http.HttpServletResponse`,
     `org.springframework.security.core.AuthenticationException`, `org.springframework.security.web.AuthenticationEntryPoint`.
     After: `callbacks` `[]`; `items` one item with subject `{ candidate: "callback", symbol: "Entry", raisedBy: "org.springframework.security.web.AuthenticationEntryPoint" }`.
     With `@org.springframework.stereotype.Component` on the class: `callbacks` is
     `["org.springframework.security.web.AuthenticationEntryPoint.commence@Entry.commence:<line of commence>"]`.
  5. "a filter base's abstract member is the entrypoint and its defaulted member is not": `@Component class Jwt extends
     OncePerRequestFilter { protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
     FilterChain chain) {} }` with the imports it needs. After: one callback `…OncePerRequestFilter.doFilterInternal@Jwt.doFilterInternal`,
     `items` `[]`.
- **Sibling behavior:** every existing test of `callbacks.test.ts` and `spring-routes.adapter.test.ts` passes unchanged
  (`:2824` included, see the table above).
- **Acceptance:** owner `callbacksOfFile`; contract: the defaulted case is a third outcome beside "found" and "item",
  decided in one place; no second path; no special case per contract (the rule reads `defaulted`); fitness: the U1
  single-rule test covers the new literals.
- **Corpus gate:** `--expect entrypoints:+ --expect callers:+ --expect impact:+`. Expected: shape D gains its filter,
  interceptor, configurer, argument-resolver and security-handler callbacks or items; B and C their filters and
  configurers. Callers/impact answers whose walk reaches those handlers gain reached entrypoints.
- **Risk:** item 1 (stored slot `java-callbacks` bumped).
- **Stop conditions:** a test not named here changes; the gate moves `trace`.

### U3 — Annotated methods the framework invokes

- **Goal:** the U3 annotation rows produce callbacks (R2).
- **Prerequisites:** U1, U2.
- **Locate:** `callbacksOfFile` (annotation branch), `returnedValues`, `KNOWN`, the `Bean` literal in `callbacks.ts`.
- **Files to edit:** `spring-invocations.ts` (append the U3 rows); `request-mapping.ts` (delete the `Bean` literal from
  `KNOWN`; it now comes from `invocationAnnotationNames`); `callbacks.ts` (the function-value branch reads the `Bean`
  name as `rows.find((row) => row.by === "annotation" && row.invocation === "factory")?.type` instead of the literal);
  `spring-invocations.single-rule.test.ts` (empty its `pending` array); the two tests and one fixture the table above
  names; `callbacks.test.ts`.
- **Stored slot:** `java-callbacks`.
- **RED test** (`callbacks.test.ts`, "annotated methods the framework invokes are callbacks of their registered class"),
  one file `src/main/java/app/Wiring.java`:

  ```java
  package app;
  import jakarta.annotation.PostConstruct;
  import jakarta.annotation.PreDestroy;
  import org.springframework.context.annotation.Bean;
  import org.springframework.context.annotation.Configuration;
  import org.springframework.web.bind.annotation.ControllerAdvice;
  import org.springframework.web.bind.annotation.ExceptionHandler;
  @ControllerAdvice class Errors {
    @ExceptionHandler(IllegalStateException.class) String conflict() { return "conflict"; }
  }
  @Configuration class Wiring {
    @Bean Object clock() { return new Object(); }
    @PostConstruct void start() {}
    @PreDestroy void stop() {}
  }
  class Plain {
    @PostConstruct void start() {}
  }
  ```

  Today: `callbacks` `[]`. After: `["org.springframework.web.bind.annotation.ExceptionHandler@Errors.conflict:9",
  "org.springframework.context.annotation.Bean@Wiring.clock:12", "jakarta.annotation.PostConstruct@Wiring.start:13",
  "jakarta.annotation.PreDestroy@Wiring.stop:14"]` and `items` exactly one, subject `{ candidate: "callback", symbol:
  "Plain", raisedBy: "jakarta.annotation.PostConstruct" }`.
- **Acceptance:** as U2; fitness: the single-rule test now has no pending literal.
- **Corpus gate:** `--expect entrypoints:+ --expect callers:+ --expect impact:+`. Expected: every workspace gains `@Bean`
  callbacks (≈65 in total) and exception-handler callbacks (≈16), shape D its `@PostConstruct` ones.
- **Risk:** item 1 (`java-callbacks`).
- **Stop conditions:** as U2.

### U4 — Application and configuration contracts

- **Goal:** the U4 supertype rows produce callbacks, plus any row U0's decision table added to U4.
- **Prerequisites:** U2.
- **Files to edit:** `spring-invocations.ts`; `callbacks.test.ts`; the two `spring-routes.adapter.test.ts` tests the table
  names (`:871`, `:903`).
- **Stored slot:** `java-callbacks`.
- **RED tests** (`callbacks.test.ts`):
  1. "lifecycle and configuration contracts are callbacks, matched by parameter type", file `src/main/java/app/Warmup.java`:

     ```java
     package app;
     import org.springframework.beans.factory.InitializingBean;
     import org.springframework.context.ApplicationListener;
     import org.springframework.context.event.ContextRefreshedEvent;
     import org.springframework.security.config.annotation.web.builders.HttpSecurity;
     import org.springframework.security.config.annotation.web.builders.WebSecurity;
     import org.springframework.security.config.annotation.web.configuration.WebSecurityConfigurerAdapter;
     import org.springframework.stereotype.Component;
     import org.springframework.context.annotation.Configuration;
     @Component class Warmup implements ApplicationListener<ContextRefreshedEvent>, InitializingBean {
       public void onApplicationEvent(ContextRefreshedEvent event) {}
       public void afterPropertiesSet() {}
     }
     @Configuration class Security extends WebSecurityConfigurerAdapter {
       protected void configure(HttpSecurity http) {}
       public void configure(WebSecurity web) {}
     }
     ```

     After: `callbacks.toSorted()` is `["org.springframework.beans.factory.InitializingBean.afterPropertiesSet@Warmup.afterPropertiesSet:12",
     "org.springframework.context.ApplicationListener.onApplicationEvent@Warmup.onApplicationEvent:11",
     "org.springframework.security.config.annotation.web.configuration.WebSecurityConfigurerAdapter.configure@Security.configure:15",
     "org.springframework.security.config.annotation.web.configuration.WebSecurityConfigurerAdapter.configure@Security.configure:16"]`,
     `items` `[]`.
  2. "a serializer is a callback only with its registration annotation", file `src/main/java/app/Writers.java`:

     ```java
     package app;
     import com.fasterxml.jackson.core.JsonGenerator;
     import com.fasterxml.jackson.databind.SerializerProvider;
     import com.fasterxml.jackson.databind.ser.std.StdSerializer;
     import org.springframework.boot.jackson.JsonComponent;
     @JsonComponent class MoneyWriter extends StdSerializer<Object> {
       MoneyWriter() { super(Object.class); }
       public void serialize(Object value, JsonGenerator out, SerializerProvider provider) {}
     }
     class LooseWriter extends StdSerializer<Object> {
       LooseWriter() { super(Object.class); }
       public void serialize(Object value, JsonGenerator out, SerializerProvider provider) {}
     }
     ```

     After: `callbacks` `["com.fasterxml.jackson.databind.ser.std.StdSerializer.serialize@MoneyWriter.serialize:8"]`;
     `items` one, subject `{ candidate: "callback", symbol: "LooseWriter", raisedBy: "com.fasterxml.jackson.databind.ser.std.StdSerializer" }`.
- **Acceptance, corpus gate, risk, stop conditions:** as U2 (`--expect entrypoints:+ --expect callers:+ --expect impact:+`).

### U5 — Known rows and the never-silent rule

- **Goal:** R3 reports every owned supertype and method annotation no row explains.
- **Prerequisites:** U0 (its decisions), U2, U3, U4.
- **Locate:** `callbacksOfFile`, `FileCallbacks`, `mergeCallbacks`, `isScannedBean`, `supertypeClausesOf`,
  `externalNames`, `KNOWN`, `VERBS`, `EXCHANGES`.
- **Files to create:** `src/core/adapters/spring/unexplained-contracts.ts` exporting
  `unexplainedOfFile(file: JavaFile, project: JavaProject, invocations: FrameworkInvocations, annotations: SpringAnnotations): Finding<never>[]`,
  implementing R3 in the order: types of the file in `project.typesOf(file)` order; per type, shape S items in clause
  order, then per method in declaration order, shape A items in annotation order.
- **Files to edit:** `spring-invocations.ts` (append the U5 known rows, U0's additions, and `owns`);
  `request-mapping.ts` (export `ENTRYPOINT_ANNOTATIONS` as R3 defines it); `callbacks.ts` (`FileCallbacks` gains
  `unexplained: Finding<never>[]`; `callbacksOfFile` takes `invocations: FrameworkInvocations` instead of `rows` and
  fills it by calling `unexplainedOfFile`; `mergeCallbacks` appends every file's `unexplained` before `sortFindings`);
  `spring-routes.adapter.ts` (pass `SPRING_INVOCATIONS` whole); `callbacks.test.ts`.
- **Stored slot:** `java-callbacks`.
- **RED test** (`callbacks.test.ts`, "a framework-owned supertype or method annotation that no row explains is an
  item"), file `src/main/java/app/Hooks.java`:

  ```java
  package app;
  import org.springframework.core.Ordered;
  import org.springframework.messaging.handler.annotation.MessageMapping;
  import org.springframework.stereotype.Component;
  import org.springframework.transaction.annotation.Transactional;
  import org.springframework.web.bind.annotation.GetMapping;
  import org.springframework.web.bind.annotation.RestController;
  @Component class Ranked implements Ordered {
    @Override public int getOrder() { return 1; }
  }
  class Value implements Ordered {
    public int getOrder() { return 1; }
  }
  @Component class Chat {
    @MessageMapping("/chat") void chat() {}
    @Transactional void save() {}
  }
  @RestController class Web {
    @GetMapping("/a") @MessageMapping("/a") void both() {}
  }
  ```

  Expected `findings.filter((f) => f.status === "unknown" && f.subject?.candidate === undefined).map((f) => [f.subject?.symbol, f.subject?.raisedBy, f.evidence.map((e) => e.line)])`:
  today `[]`; after:
  `[["Ranked", "org.springframework.core.Ordered", [8, 9]], ["Chat.chat", "org.springframework.messaging.handler.annotation.MessageMapping", [15]]]`.
  `Value` is no bean and writes no `@Override` (shape S not met); `save` carries a known `intercepts-call` row; `both`
  carries an entry annotation.
- **Acceptance:** owner `unexplainedOfFile` (only `callbacksOfFile` calls it); contract: items only, never a `complete`
  finding; no second path: `unreadBaseOf` keeps owning non-owned bases and the two never report the same class for the
  same name (an owned FQN is never `missing` in `project.hierarchy` gaps, which hold only non-platform names); no
  special case: exclusions are stated rules, not names; fitness: extend `spring-invocations.single-rule.test.ts` with
  "every `owns` prefix ends in `.`" and "no row type is outside every `owns` prefix and also absent from `KNOWN`'s
  derivation" (each annotation row type is returned by `invocationAnnotationNames`).
- **Corpus gate:** `--expect entrypoints:± --expect callers:± --expect impact:±`. The U5 report lists the item count per
  workspace shape and compares it with U0's output; any difference is explained or the unit stops.
- **Risk:** item 1 (`java-callbacks`), item 3 (new unknown items in the published entrypoints answer).
- **Stop conditions:** the items exceed what U0 measured for any workspace; a name U0 classified as known is reported.

### U6 — One advice reader

- **Goal:** move the advice reading out of `java-dispatch-targets.ts` into `java-advice.ts`, read every advice kind, and
  answer three-valued selections; the dispatch veto keeps its bytes (R4, R5).
- **Prerequisites:** U1.
- **Locate:** `globalVeto`, `adviceOf`, `advisedBy`, `pointcutText`, `parsePointcut`, `designatorOf`, `annotationName`
  (the one in `java-dispatch-targets.ts`), `executionOf`, `typePattern`, `globOf`, `annotatedWith`, `annotationsOf`,
  `simpleName`, `belowOf`, `causeAt`, `INTRODUCTIONS`, `BODY_REPLACING_ADVICE`, `isAspect`.
- **Files to create:** `src/core/adapters/spring/java-advice.ts`, `src/core/adapters/spring/java-advice.test.ts`.
- **Files to edit:** `java-dispatch-targets.ts` (delete the moved functions and constants; export `belowOf` and
  `causeAt`; `globalVeto` calls `readAspects` and derives R5); `spring-invocations.ts` (append the AOP rows).
- **`java-advice.ts` content:**

  ```ts
  export type Selection = "selects" | "may" | "no";
  export interface Advice { runs: AdviceRuns; place: string; method: MethodDecl; aspect: TypeDecl; select(body: MethodDecl, hierarchy: Hierarchy): Selection; mayJoin(call: AdvisedCall): boolean }
  export interface UnreadAdvice { runs: AdviceRuns; place: string; method: MethodDecl }
  export interface AspectReading { advice: readonly Advice[]; unread: readonly UnreadAdvice[]; escapes: readonly string[] }
  /** Every aspect of the files: its readable advice, its unread advice, and per aspect the first introduction or unread `around` advice in member order (R5). */
  export function readAspects(files: readonly JavaFile[], project: JavaProject, rows: readonly InvocationRow[]): AspectReading;
  ```

  `mayJoin` is today's `JoinPoints` predicate; `select` implements R4 over `advisedCallOf(body, hierarchy)` (today's
  `advisedBy` construction, moved and renamed) plus the proof column and the refusals (modifier, scanned bean). The
  advice kinds are recognised by the simple name of the `advice` rows' types, the introductions by the `introduction`
  rows, the aspect by `isAspect` (unchanged).
- **RED test:** `java-advice.test.ts`, "a pointcut selects, may select or does not select a body", sources:

  `src/main/java/app/OrderService.java`:

  ```java
  package app;
  import org.springframework.stereotype.Service;
  @Service public class OrderService {
    public void place(String id) {}
    private void check() {}
    @Audited public void cancel(String id) {}
  }
  ```

  `src/main/java/app/Audited.java`: `package app;\npublic @interface Audited {}`

  `src/main/java/app/AuditAspect.java`:

  ```java
  package app;
  import org.aspectj.lang.annotation.*;
  import org.springframework.stereotype.Component;
  @Aspect @Component public class AuditAspect {
    @Before("execution(* app.OrderService.*(..))") public void before() {}
    @AfterReturning("@annotation(app.Audited)") public void audited() {}
    @After("within(app..*)") public void after() {}
    @Around("execution(public * app.OrderService.place(String))") public Object around(org.aspectj.lang.ProceedingJoinPoint p) throws Throwable { return p.proceed(); }
    @Before("named()") public void unreadable() {}
  }
  ```

  With `readAspects` over the three parsed files and `readHierarchy`: `advice` places are lines 5, 6, 7, 8; `unread` is
  the advice at line 9; `escapes` is `[]`. Selections (`[before, audited, after, around]`) at `place` are
  `["selects", "no", "selects", "may"]`, at `check` `["may", "no", "may", "no"]`, at `cancel`
  `["selects", "selects", "selects", "no"]`. The test fails today because the module does not exist.
- **Sibling behavior:** every test of `java-dispatch-targets.test.ts` whose name contains "aspect", "advice" or
  "pointcut" passes unchanged.
- **Acceptance:** owner `java-advice.ts`; contract `Selection` separates proven from possible; no second path (the veto
  reads `readAspects`); fitness: add to `spring-invocations.single-rule.test.ts` "advice kinds are named only in the
  table": no production file other than `spring-invocations.ts` holds the literals `"Around"`, `"Before"`,
  `"AfterReturning"`, `"AfterThrowing"`, `"After"`, `"DeclareParents"`, `"DeclareMixin"`.
- **Corpus gate:** `--expect none`.
- **Risk:** item 3 (the reader behind trace's dispatch veto moves).
- **Stop conditions:** any dispatch answer differs (a dispatch test, or the gate).

### U7 — Advice steps in trace

- **Goal:** R6.
- **Prerequisites:** U6.
- **Locate:** `TraceVia`, `CUT_REASONS`, `ImportOrigins`, `DispatchSite`, `walkTrace`, `visit`, `readOwedDispatch`,
  `childAt`, `placedMethod`, `pageRoots`, `createJavaNameBindings`, `importOrigins` (in `language-packs.ts`),
  `outsideSupertypes` routing.
- **Files to edit:**
  - `src/core/domain/trace/trace-fact.ts` (`TraceVia` gains `"advice"`; update its doc comment).
  - `src/core/domain/shared/fact.ts` (`CUT_REASONS` gains `"advice-undecided"` last).
  - `src/core/ports/import-origins.port.ts` (`AdvisedSite`, `AdviceBody`, `AdviceAt`, `advice?`).
  - `src/core/application/snapshot/language-packs.ts` (route `advice` exactly like `outsideSupertypes`, default
    `{ kind: "unknown", reason: CAPABILITY_ABSENT }`).
  - `src/core/adapters/spring/java-advice.ts` (`createJavaAdvice(parser, sources, paths, hold, build, libraries):
    NonNullable<ImportOrigins["advice"]>`, built like `createJavaDispatchTargets`: parse or hold, `readHierarchy`,
    `readAspects`; per site, the method with a body of a type of `site.file` whose declaration spans `site.line` and
    whose name is `site.name` (`spansLine`), else `{ kind: "unknown" }`; a read with no aspect answers
    `{ kind: "read", advice: [], undecided: [], unread: [] }` for every site; otherwise for each readable advice,
    `selects` → `advice`, `may` → `undecided`, and every unread advice place → `unread`).
  - `src/core/adapters/spring/java-name-bindings.adapter.ts` (add `advice: createJavaAdvice(...)`).
  - `src/core/application/trace/trace-walk.ts`: `TraceWalkInput` gains `entered?: ReadonlySet<GraphNodeId>`; `Child`
    keeps `thisCall`; `visit` gains a last parameter `joinPoint: "proxied" | "self" | "none" = "none"`; after the line
    that pushes the dispatch child, compose `body.children = [...before, ...body.children, ...after]` from the advice
    answer as R6 states; the children loop computes each child's join point by R6's first table; `readOwedDispatch`
    passes `"self"`; the root loop passes `input.entered?.has(root.id) ? "proxied" : "none"`; the walk collects
    undecided and unread places and returns their cuts with the others.
  - `src/core/application/trace/trace-queries.ts` (pass `entered: pageRoots` to `walkTrace`).
  - `src/mcp/composition-schema-parts.ts:335` (`via` enum gains `"advice"`).
- **RED tests** (`trace-walk.test.ts`, built on the input of "a written reference is deferred…"): a store with
  `fakeNode("place", "method", use, 1, 3)` and `fakeNode("before", "method", aspect, 5, 5, "before")`,
  `fakeNode("after", "method", aspect, 7, 7, "after")` (`aspect = "src/main/java/p/AuditAspect.java"`); `origins.advice`
  answers `[{ kind: "read", advice: [{ runs: "before", file: aspect, start: 5, nameLine: 5, place: `${aspect}:5 advice` },
  { runs: "after", file: aspect, start: 7, nameLine: 7, place: `${aspect}:7 advice` }], undecided: [`${aspect}:9 advice`], unread: [`${aspect}:11 advice`] }]`
  and counts its calls.
  1. "an advice a pointcut selects at an entered handler is a step around its body": `entered: new Set([place.id])`.
     After: `result.roots[0].children.map((c) => [c.declaration.name, c.via])` is `[["before", "advice"], ["after", "advice"]]`;
     cuts with reason `advice-undecided` are `[[`${aspect}:11 advice`], [`${aspect}:9 advice`, `${use}:1 place`]]`
     (sorted by `at[0]`). Today: no children, no such cut.
  2. "a root that is no entrypoint asks no advice": no `entered`. After: no children, no cut, advice asked 0 times.
  3. In `java-advice.test.ts`: `createJavaAdvice` over U6's sources answers, for the site of `place` (line 4),
     `advice` with `[before (line 5), after (line 7)]` in that order, `undecided` `["src/main/java/app/AuditAspect.java:8 advice"]`,
     `unread` `["src/main/java/app/AuditAspect.java:9 advice"]`.
- **Acceptance:** owner `walkTrace` for steps, `java-advice.ts` for selections; contract `AdviceAt` separates proven,
  undecided and unread; no second path; fitness: the U6 test; the walk's join-point table is one function
  (`joinPointOf(child, parent)`), unit-tested by test 1 and 2.
- **Corpus gate:** `--expect trace:+ --expect-cuts advice-undecided:+`; `workspace`, `decisions` and
  `contract-consequences` read Java flow through the adapter, not the trace walk, so they must not move.
- **Risk:** item 3 (published trace schema gains a `via` member and a cut reason).
- **Stop conditions:** a dispatch cut changes; a non-Java trace gains an advice cut.

### U8 — Advice dependence in callers and impact

- **Goal:** R7.
- **Prerequisites:** U6.
- **Locate:** `RelationKind`, `EDGE_POLICY`, `followsRelation`, `relatedTo`, `assemble`, `keptByReads` and
  `createJavaRelations` (`java-relations.adapter.ts`), `named`.
- **Files to edit:** `relation.ts` (`"advised-by"`); `edge-policy.ts` (`advice` row and `followsRelation` branch:
  `kind === "advised-by"` → `EDGE_POLICY.advice.from.includes(sourceKind) && EDGE_POLICY.advice.to.includes(targetKind)`);
  `java-relations.adapter.ts` (new `advisedRelations(files, project, hierarchy): { relations: Finding<Relation>[]; cuts: Cut[] }`
  over `readAspects(files, project, SPRING_INVOCATIONS.rows)`; called once per extraction after the per-file loop, in
  both the held (`keptByReads`, over `heldOver()`'s project) and the direct path, outside the `java-relations` slot;
  `assemble` takes the extra relations and cuts); every place a `RelationKind` union is mirrored (run
  `rg -n '"uses-pipe"' src` and add `"advised-by"` where a closed list of relation kinds is spelled out for output).
- **Stored slot:** none (computed outside the slot).
- **RED test** (`java-relations.adapter.test.ts`, "an advised method depends on the advice its pointcut may select"):
  U6's three sources. Expected `advised-by` relations as `[from.symbol, to.symbol]`, sorted:
  `[["cancel", "after"], ["cancel", "audited"], ["cancel", "before"], ["check", "after"], ["check", "before"],
  ["place", "after"], ["place", "around"], ["place", "before"]]`, and one cut reason `advice-undecided`,
  `at: ["src/main/java/app/AuditAspect.java:9 advice"]`, reach `{ kind: "callers-of", declarations:
  ["src/main/java/app/AuditAspect.java::unreadable"] }` (use the anchor `declarationAnchor` builds). In
  `inbound-edges.test.ts`, one test: a relation `advised-by` from method `place` to method `before` makes `place` an
  inbound edge of `before` with basis `relation`; today none.
- **Acceptance:** owner `advisedRelations` reading `readAspects`; contract unchanged (`Relation`); fitness: the
  edge-policy row is the only admission of the kind.
- **Corpus gate:** `--expect callers:+ --expect impact:+ --expect-cuts advice-undecided:+`.
- **Risk:** item 3 (relation kinds and edge policy shared by `callers` and `impact`).
- **Stop conditions:** a relation of another kind changes.

### U9 — RxJS and Angular argument rows

- **Goal:** R8 with the rows below.
- **Prerequisites:** U1.
- **Rows:** `RXJS_INVOCATIONS` gains, for `module` in `["rxjs", "rxjs/operators"]`: `map`, `filter`, `catchError`,
  `finalize` (argument 0, `observerKeys: []`) and `tap` (argument 0, `observerKeys: ["next", "error", "complete",
  "subscribe", "unsubscribe", "finalize"]`). `ANGULAR_INVOCATIONS = { owns: [], rows: [{ by: "argument", module:
  "@angular/core", path: ["effect"], argument: 0, observerKeys: [] }] }`, returned by `createAngularPlugin` as
  `invocations`. `computed` and `linkedSignal` stay cells (`ANGULAR_CELLS`), read through R8's third row; `toSignal`
  takes no function and stays a `nothing` cell.

| Module | Export | Argument | Deferred | Owner of the row |
|---|---|---|---|---|
| `rxjs`, `rxjs/operators` | `defer`, `switchMap`, `mergeMap`, `concatMap`, `exhaustMap` (U1) | 0 | yes | `RXJS_INVOCATIONS` |
| `rxjs`, `rxjs/operators` | `map`, `filter`, `catchError`, `finalize` | 0 | yes | `RXJS_INVOCATIONS` |
| `rxjs`, `rxjs/operators` | `tap` | 0, function or observer object | yes | `RXJS_INVOCATIONS` |
| `@angular/core` | `effect` | 0 | yes | `ANGULAR_INVOCATIONS` |
| `@angular/core` | `computed`, `linkedSignal` | 0 | yes | `ANGULAR_CELLS` (callback cell) |
| `@angular/core/rxjs-interop` | `toSignal` | none | — | `ANGULAR_CELLS` (`nothing`) |
| `rxjs` `Observable` member | `subscribe(next, error, complete)`, `subscribe({ next, error, complete })` | 0–2, observer | yes | Not covered (needs a receiver type, see "Not covered") |
| `@angular/core` | `afterNextRender`, `afterEveryRender` | 0 | yes | Deferred (0 in the corpus) |

- **Files to edit:** `rxjs.plugin.ts`, `angular.plugin.ts`, `http-call-sites.adapter.ts`
  (`createDeferredValueReader(invocations, cells: readonly FrameworkValueCells[] = [])`, R8), `compose.ts:346` (pass
  `typescriptFrameworks.flatMap((plugin) => plugin.cells ?? [])` as the second argument), the conformance and adapter
  tests named below.
- **RED tests:**
  1. `http-call-sites.adapter.test.ts`, "an observer object at a listed argument defers the functions of its listed
     keys": row `{ by: "argument", module: "later-lib", path: ["later"], argument: 0, observerKeys: ["next", "error"] }`,
     content `import { later } from 'later-lib'\nlater({\n  next: () => 1,\n  error() { return 2 },\n  other: () => 3,\n})`;
     start lines today `[]`, after `[3, 4]`.
  2. Same file, "a value cell that runs a callback defers it": no argument row; cells
     `{ runOf: ({ module, path }) => (module === "later-lib" && path[0] === "cell" ? { kind: "callback", argument: 0 } : undefined), projections: new Set() }`;
     content `import { cell } from 'later-lib'\ncell(() => 1)`; today `[]`, after `[2]`.
  3. `framework-plugins.conformance.test.ts`: `DEFERRAL_ENTRIES` gains the five names (each module), and a new test
     "the Angular export effect owns the function value it is given": package `{"dependencies":{"@angular/core":"21.0.0"}}`,
     content `import { effect } from '@angular/core';\neffect(() => 1);`, lines `[2]` with the registered plugins and
     `[]` with none; the test at `:497` loses `map(() => 1); `.
- **Acceptance:** owner `createDeferredValueReader`; no second path (the U1 fitness test "no export is both an argument
  row and a value cell" holds); fitness: that test.
- **Corpus gate:** `--expect trace:+ --expect-cuts effect-unplaced:-`.
- **Risk:** item 3 (`createDeferredValueReader` gains a parameter; composition is its only caller).
- **Stop conditions:** a Java trace moves.

### U10 — Angular resolvers and leave guards join their route

- **Goal:** R9.
- **Prerequisites:** none.
- **Locate:** `RawEntry`, `guardsOfKeys`, `guardsOfElement`, `GUARD_KEYS`, `guardsOf` (`route-table.loader.ts`),
  `withoutRepeats`, `uiRoute` (`angular-routes.adapter.ts`), `reachedEntrypoints`, `entrypointContext` (`render.ts`),
  `entryData` (`composition-schema-parts.ts`).
- **Files to edit:** `ui-route.ts` (the two fields); `angular-router.extractor.ts` (`RawEntry.exitGuards: RawGuard[]`
  from `guardsOfKeys(["canDeactivate"])`; each `resolvers` element gains `ref?: RawGuard`); `route-table.loader.ts`
  (the loader entry gains `resolvers: RouteGuard[]` and `exitGuards: RouteGuard[]` resolved with `guardsOf`);
  `angular-routes.adapter.ts` (`uiRoute` adds each field only when not empty, after `withoutRepeats`);
  `reached-entrypoints.ts` (join `[...guards, ...(resolvers ?? []), ...(exitGuards ?? [])]`; update the doc comment);
  `composition-schema-parts.ts` (ui-route arm: `resolvers` and `exitGuards`, each the guard object array,
  `exactOptional()`); `render.ts` (`entrypointContext`: after the guard lines, `    resolvers (n):` and
  `    leave guards (n):` lists in the guard line format, printed only when present).
- **RED tests:**
  1. `angular-routes.adapter.test.ts`, "a resolver and a leave guard of an entry are on its route, placed like guards":
     header `import { orderResolver } from './order.resolver';\nimport { unsavedGuard } from './unsaved.guard';\n`, body
     `  { path: 'orders/:id', component: Order, resolve: { order: orderResolver, inline: () => 1 }, canDeactivate: [unsavedGuard] },`,
     files `src/app/order.resolver.ts` = `export const orderResolver = () => 1;\n`, `src/app/unsaved.guard.ts` =
     `export const unsavedGuard = () => true;\n`. After: `route.resolvers` is
     `[{ name: "orderResolver", path: "src/app/order.resolver.ts" }, { name: "(inline)" }]` and `route.exitGuards`
     `[{ name: "unsavedGuard", path: "src/app/unsaved.guard.ts" }]`; a route without them has neither key. Today both
     are `undefined`.
  2. `reached-entrypoints.test.ts`, "code reached only through a resolver reaches its route": a complete ui-route
     finding with `guards: []` and `resolvers: [{ name: "orderResolver", path: "src/app/order.resolver.ts" }]`, and a
     reached node `orderResolver` in that file; after: one reached entry of kind `ui-route`; today none.
- **Sibling behavior:** `fixtures/routes/named.json` and `namespace.json` answer unchanged (no resolver, no leave guard).
- **Acceptance:** owner the router extractor and `guardsOf`; no second path (resolvers are placed by `guardsOf`).
- **Corpus gate:** `--expect entrypoints:± --expect callers:+ --expect impact:+`.
- **Risk:** item 3 (published ui-route schema gains two optional fields).
- **Stop conditions:** a route's `guards` change.

### U11 — Spring route access rules

- **Goal:** R10 (ADR-0139).
- **Prerequisites:** U5 (the `access-rule` rows).
- **Locate:** `readHandler`, `routesOfHandler`, `contractJoin`, `annotationUses`, `scopeOf`, `classChain`, `evaluate`,
  `entryData` (schema), `entrypointContext`.
- **Files to edit:** `http-route.ts` (the types and `HttpRoute.access?`); `findings.ts` (`MappedRoute` keeps
  `Omit<HttpRoute, "basePath">`, so it gains `access`); `spring-routes.adapter.ts` (new `accessOf(method, controller,
  annotations, project): RouteAccess` implementing R10, called for every `MappedRoute` value `readHandler` and
  `contractJoin` build); `composition-schema-parts.ts` (http-route arm: `access: z.strictObject({ read:
  z.array(accessSource), unread: z.array(accessSource), rules: z.array(z.strictObject({ annotation: z.string(), on:
  z.enum(["method", "class"]), values: z.union([z.array(z.string()), z.literal("unread")]) })) }).exactOptional()`, with
  `accessSource = z.enum(["handler-annotations", "request-filters"])`); `render.ts` (`entrypointContext` for http-route:
  nothing when `rules` is empty, else `    access rules (n):` followed by
  `      - @<simple name>(<values joined by ", ">) on <method|class>` per rule, `unread` printed as `(values not read)`.
  The unread source is stated once per answer, never per route (ADR-0109, ADR-0139 decision 5): where the text of an
  answer lists entrypoints and at least one listed http-route has `access.unread` containing `"request-filters"`, the
  line `access rules are read from handler and class annotations; request filters are not read` is printed once,
  directly under the heading of that entrypoint list. Locate the function that prints that heading by following the
  callers of `entrypointContext`; if entrypoints are listed under more than one heading in one answer, print the line
  under the first only. Add one assertion to the rendering test of that list: the line appears exactly once in an
  answer with two http-routes).
- **Stored slot:** `java-entrypoints`.
- **RED test** (`spring-routes.adapter.test.ts`, "a route carries the access rules its handler and class declare, and
  says the filter chain is not read"):

  ```ts
  const findings = await extractor.extract([app("Orders", `@RestController @PreAuthorize("isAuthenticated()") class Orders {
    @GetMapping("/orders") void list() {}
    @PreAuthorize("hasRole('ADMIN')") @DeleteMapping("/orders/{id}") void remove(@PathVariable String id) {}
    @Secured({"ROLE_A", "ROLE_B"}) @PostMapping("/orders") void create() {}
    @PreAuthorize(Rules.ADMIN) @PutMapping("/orders") void update() {}
  }`, "import org.springframework.security.access.prepost.PreAuthorize; import org.springframework.security.access.annotation.Secured; import com.lib.Rules;"), MAIN]);
  ```

  Expected, per route label: `GET /orders` → `[{ annotation: PRE, on: "class", values: ["isAuthenticated()"] }]`;
  `DELETE /orders/{id}` → `[{ annotation: PRE, on: "method", values: ["hasRole('ADMIN')"] }, { annotation: PRE, on:
  "class", values: ["isAuthenticated()"] }]`; `POST /orders` → `[{ annotation: SECURED, on: "method", values: ["ROLE_A",
  "ROLE_B"] }, { PRE class }]`; `PUT /orders` → `[{ annotation: PRE, on: "method", values: "unread" }, { PRE class }]`;
  every route `read: ["handler-annotations"]`, `unread: ["request-filters"]`. A controller with none answers
  `rules: []`. Today `access` is `undefined`.
- **Existing tests:** an assertion comparing a whole http-route value now also holds `access`; update only those whose
  sole difference is the added `access` with `rules: []`, and list them in the report.
- **Acceptance:** owner `accessOf`; contract `RouteAccess` keeps read and unread apart and never states "unguarded";
  fitness: `access-rule` names come only from the table (the U1 single-rule test).
- **Corpus gate:** `--expect entrypoints:± --expect workspace:±`.
- **Risk:** item 1 (`java-entrypoints`), item 3 (published http-route schema gains an optional field).
- **Stop conditions:** a route name, handler or base path changes.

## Not covered

| Construct | What the engine answers | Why it stays |
|---|---|---|
| `SecurityFilterChain` / `HttpSecurity` matcher chains (`requestMatchers`, `antMatchers`, `authorizeHttpRequests`) | every Spring route's `access.unread` holds `request-filters`; the `@Bean` method that builds the chain is a `callback` (U3) | Reading them needs value flow over lambda DSLs, ordering (first match wins) and path-pattern semantics; ADR-0139 decision 4 |
| `@Async`, `@Cacheable`, `@Transactional` semantics | known `intercepts-call` rows: no item; a call to such a method stays a synchronous `call` step | The brief's scope ends at the entry; a step's timing is not changed without a design of its own |
| `@Query`, JPA relationships | data effects as today | Another program (query strings, ORM mapping) |
| Quartz jobs (`org.quartz.Job.execute`), reflection | nothing (package not owned) | Not in the corpus; `org.quartz.` enters `owns` only with a row group |
| Registration through `@Bean` factories, `FilterRegistrationBean`, `addInterceptor(new …)`, `@JsonSerialize(using = …)`, `addSerializer(…)` | `unknown("no-extractor")` at the class, candidate `callback` | ADR-0048 decision 4 |
| Deferred Spring rows (supertype and annotation tables) | owned: an R3 item; `com.fasterxml.jackson.databind.JsonDeserializer` when Jackson is not owned: nothing | 0 occurrences in the corpus; each enters with a fixture |
| RxJS `subscribe(…)` (positional and observer forms) | an effect in its function argument is an `effect-unplaced` cut | `subscribe` is a member of a value; proving the receiver is an `Observable` needs RFC-0044's TypeScript receiver typing |
| Angular `afterNextRender`, `afterEveryRender` | `effect-unplaced` cut for an effect inside | 0 in the corpus |
| Angular `@HostListener` and `host` listener metadata | the method is a member step of its page at the "other members" rank (`pageOrder`, `trace-walk.ts`); `callers`/`impact` reach the component through its member | Not silent; ordering it as an event handler is a page-plan change, 3 occurrences |
| Angular lifecycle hooks | already steps of a page in the framework's order (`page-plans.ts:59-60`) | Delivered by RFC-0013 R9 |
| `canActivateChild` | not joined to the entry | It guards what is beneath the entry (`angular-router.extractor.ts:47-48`) |
| Advice at a root that is not an entrypoint target | no advice step and no cut | The question asks what the body runs, not what wraps a call to it |
| Order between aspects (`@Order`, `Ordered`) | steps listed by `ADVICE_RUNS` order, then file, then line | Not read |
| Whether method security is enabled | rules reported as declared | `RouteAccess` doc states it |

## Resolved questions

(owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | One port for every invocation shape, or one per shape? | **One `FrameworkInvocations` with a closed union of rows.** One per shape would keep today's split (Problem rows 1–4) and leave no single place to ask whether a name is explained (R3). |
| 2 | Must listener, job and route annotations move into the table too? | **No.** Their rows carry attribute semantics (destinations, triggers, paths) the row model does not state; they keep one owner each in `request-mapping.ts`/`listeners.ts`, and R3 reads them through `KNOWN`/`ENTRYPOINT_ANNOTATIONS`. The fitness test keeps each name in exactly one table. Discarded: a `listener` row variant, which would duplicate `DESTINATIONS`. |
| 3 | Make Spring a `FrameworkPlugin` now? | **No.** ADR-0075 decisions 3 and 5 own that move; this RFC keeps the table beside the readers that consume it and types it with the port. Owner may overturn. |
| 4 | Never-silent scope: every library supertype, or only owned packages? | **Owned packages a plugin declares.** Every library supertype would report data types (`Serializable`, `Comparable`) and any third-party base; the owned set is bounded by U0's measurement. |
| 5 | How are data types and markers excluded without a list of observed names? | **By stated rules:** shape S needs a scanned bean or a written `@Override` (exceptions and value types write neither); shape A excludes annotations on methods that carry an entry annotation; known rows come from documentation, classified in U0. |
| 6 | Should a never-silent item claim `candidate: "callback"`? | **No** (ADR-0103 decision 2): extending a framework type is not evidence that the framework invokes the class. |
| 7 | Contract members: arity only, or parameter types? | **Erased parameter simple names, `*` for type variables.** Arity alone cannot tell `configure(HttpSecurity)` from `configure(WebSecurity)`; migrated rows use `*` so U1 changes no answer. |
| 8 | A default member the class does not override: item or nothing? | **Nothing, when only the contract can hold the body** (R1). An item per unimplemented default member would mark every interceptor and configurer (owner preference: noise is worse). |
| 9 | Advice steps for `may` selections? | **No: a cut per advice listing the steps.** A step must run (soundness); a cut per (advice, step) would multiply; one cut per advice is bounded. |
| 10 | Advice dependence for `may` selections? | **Yes, a relation.** Dependence answers are "may depend"; leaving a possible dependent out would be silence. Unread pointcuts become one cut, not a relation to every method. |
| 11 | Spring route guards: reuse `UiRoute.guards` or a new field? | **A new optional `access` field.** An Angular guard names a declaration; a Spring rule is an annotation with expression values. One field name with two meanings would mislead. Additive and optional: no `SCHEMA` bump. |
| 12 | Read `SecurityFilterChain` matchers now? | **Deferred, as `unread: ["request-filters"]` on every route** (ADR-0139 decision 4). |
| 13 | `@Bean` methods as callbacks (≈65 entries)? | **Yes.** They are invoked by the container; code reached only from a factory otherwise answers "reached entrypoints (0)". |
| 14 | `subscribe` rows now? | **No: they wait for a TypeScript receiver proof** (RFC-0044); a member row without it would match any `.subscribe`. |
| 15 | `canDeactivate` and resolvers on the route? | **Yes, as two optional fields joined like guards.** Code they reach otherwise reaches no entrypoint. |
