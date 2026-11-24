# ADR-0137: What a framework invokes without a written call is a row of one table per plugin, and an unexplained contract is never silent

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: the owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra
  sesion por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente
  tenga que tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less
  capable agent implements it in another session; everything explicit, almost no room for important decisions or
  invented implementations). It serves the request "Identificar los huecos de analisis de codigo, lo que el motor
  ignora, tanto de base como en sus implementaciones de java + spring y ts + angular" (identify the analysis gaps, what
  the engine ignores, in its base and in its Java + Spring and TypeScript + Angular implementations).
- Related: [RFC-0045](../rfc/0045-what-a-framework-invokes-is-declared-in-one-table-per-plugin.md) (design and units),
  [RFC-0026](../rfc/0026-framework-invoked-entrypoints.md), [ADR-0048](0048-a-framework-invoked-implementation-is-an-entrypoint.md),
  [ADR-0100](0100-an-unknown-entrypoint-item-says-what-it-stands-for-and-a-registration-through-an-unread-type-is-never-silent.md),
  [ADR-0103](0103-a-type-reference-written-in-a-member-is-the-members-and-an-unknown-item-claims-a-kind-only-with-evidence.md),
  [ADR-0075](0075-the-core-names-no-language-or-framework.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md)

**In short:** every code path a framework runs without a written call — a contract member, an annotated method, an
advice, a function passed to a framework call — is a row of one declarative table per framework plugin, typed by one
port that names no framework and read by every family that needs it. A framework-owned supertype or method annotation
that no row explains is an `unknown` entrypoint item, never silence. The Java contract table, the TypeScript deferral
vocabulary and the row names written twice in the Java annotation vocabulary are replaced by those tables.

## Context

The engine holds three unrelated models of "the framework runs this": `INVOKED_CONTRACTS` (four Java rows,
`src/core/adapters/spring/invoked-contracts.ts:8-13`), `FrameworkDeferrals` (a function port, five RxJS rows,
`src/core/ports/framework-deferrals.port.ts:6-9`, `src/core/adapters/frameworks/rxjs/rxjs.plugin.ts:7-12`) and advice
constants inside the dispatch reader (`java-dispatch-targets.ts:26-28`). Row names are repeated as literals in `KNOWN`
(`request-mapping.ts:116-118`) and in `callbacks.ts:181`. With no single table there is no place to ask whether a
framework-owned name is explained, so a scanned bean extending a framework filter base, a `@PostConstruct` method or an
`@ExceptionHandler` method is pinned by tests as "no finding" (`spring-routes.adapter.test.ts:1282`, `:2824`), and
`callers`/`impact` answer "reached entrypoints (0)" for code only the framework reaches.

| Option | Why kept or dropped |
|---|---|
| One port, one closed union of rows, one table per plugin | Kept: one owner per framework's knowledge; one place to ask "explained?" |
| One port per shape (contracts, deferrals, advice) | Dropped: keeps today's split and the duplicated names |
| Report every library supertype not explained | Dropped: data types and third-party bases would flood the answer (owner: noise is worse than no fix) |

## Decision

1. The port `src/core/ports/framework-invocations.port.ts` declares `FrameworkInvocations { owns; rows }` and the closed
   union `InvocationRow` with exactly the variants `supertype`, `annotation`, `aspect`, `advice`, `introduction` and
   `argument`, as RFC-0045 "Contract" writes them. It names no framework and no language.
2. Each framework's rows live in exactly one table owned by its plugin folder; a fully qualified row name appears as a
   literal in no other production file. A `*.single-rule.test.ts` enforces it per table.
3. Every reader that needs framework-invoked knowledge reads the rows: the Java callbacks reader (supertype and
   annotation rows), the Java advice reader (aspect, advice and introduction rows), the TypeScript deferred-value reader
   (argument rows). The Java annotation vocabulary derives its row names from the table.
4. A table's `owns` lists the package prefixes the plugin answers for. A Java class that writes an owned supertype no
   row explains, and is a scanned bean or writes `@Override` on a method no repository supertype declares, is an
   `unknown` item `no-extractor` with `subject.raisedBy` the supertype; a method with a body carrying an owned
   annotation that no row and no entrypoint reader explains, and no entrypoint annotation, is the same item at the
   method. Neither states a `candidate` (ADR-0103 decision 2).
5. A prefix enters `owns` only when a measurement over the corpus classifies every name under it that the rule would
   report (RFC-0045 U0); a type the framework documents as invoking nothing enters as a row with `members: []`, an
   annotation that invokes nothing as an `intercepts-call`, `access-rule` or `marker` row.
6. A contract member is matched by name and its documented erased parameter types (`*` for a type variable). A member
   the contract itself implements (`defaulted`) yields no finding when the class and its repository ancestors have no
   outside supertype other than the row's type and memberless platform interfaces.
7. A route-run declaration that a router reads beside its guards (an Angular route's resolvers and leave guards) is
   placed on the route like a guard and joined like a guard by the reached-entrypoint join.
8. `FrameworkPlugin.deferrals` and `FrameworkDeferrals` are removed; `FrameworkPlugin.invocations` replaces them.

## Consequences

- `callers` and `impact` gain reached entrypoints for code reached only from filters, interceptors, configurers,
  exception handlers, lifecycle callbacks, bean factories and the other rows; the entrypoint map gains callbacks and
  `unknown` items where it was silent.
- The stored slot `java-callbacks` changes version with each row group (ADR-0077); RFC-0045 names the bumps.
- RFC-0007 row S7 records U0's measurement and the prefixes in `owns`.
- ADR-0100 decision 3 (unread bases exclude platform packages) stays; decision 4 here covers what it excluded.

## Not decided here

- Moving Spring's readers into a `FrameworkPlugin` (ADR-0075 decisions 3 and 5).
- Rows whose receiver must be typed first (`Observable.subscribe`), tracked in RFC-0044.
- Registration through factories or programmatic calls (ADR-0048 decision 4).
- Advice as trace steps (ADR-0138) and route access rules (ADR-0139).
