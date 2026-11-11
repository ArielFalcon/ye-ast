# RFC-0026: Code a framework invokes is an entrypoint

- Status: Accepted, 2026-11-09. Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (every open question settled as recommended; see Resolved questions). ADR-0048 records its decisions.
- Reproductions: kept with the study run outside the repository (`evaluations/runs/20261108T2245Z-agent-usefulness-12f8/engine-gaps/designs/rfc-0026-framework-invoked-entrypoints/repro`).
- Related: [ADR-0045](../adr/0045-one-assembly-line-for-the-snapshot-reading.md) (the assembly line, B5, B11, decision 12),
  [ADR-0044](../adr/0044-one-implementation-closure-with-scoped-vetoes.md) (the one Java closure, decision 4 V2),
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) (coverage grows only with evidence),
  [ADR-0042](../adr/0042-completeness-is-relative-to-the-question.md) (completeness),
  [ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md), [RFC-0007](../rfc/0007-extension-model.md)
  (extension model, row S7 and Conformance), [RFC-0013](../rfc/0013-trace-and-patterns.md) (trace targets),
  [RFC-0002](../rfc/0002-facts-contract.md) (facts and cuts)

**In short:** a Java entrypoint plugin declares, as a data table, the library supertypes and annotations whose
implementations a framework invokes, with the entrypoint kind each produces and the member it calls; the Java pack's
one supertype closure decides which repository classes are those implementations, and the entrypoints family emits one
entrypoint per placed handler. `callers`, `impact` and `trace` already consume entrypoints by handler identity, so they
gain the callback origin without a new walk and without a new port. What the reader cannot prove is an explicit
`unknown` item, never silence.

## Problems

One mechanism, four studied items. Every `callers` answer below is `complete` with `reached entrypoints (0)`: the walk
reaches the method, and nothing says that method is what the framework calls.

| # | Study items | What the agent asked | What ye-ast answered | What the oracle says | Workspace evidence |
|---|---|---|---|---|---|
| P1 | CF-JHIPSTER-J-BUG | which endpoints reach `DomainUserDetailsService.createSpringSecurityUser` | `status: complete`, `reached entrypoints (0)`, impacted: `loadUserByUsername` at depth 1 | `loadUserByUsername` is the `UserDetailsService` callback Spring Security invokes during authentication; the chain ends at an authentication attempt, not at zero endpoints | `jhipster/application:src/main/java/io/github/jhipster/sample/security/DomainUserDetailsService.java:32-49`, `:51-56` |
| P2 | CF-PETCLINIC-J-BUG | which endpoints reach `PetAgeValidator.isValid` | `status: complete`, `reached entrypoints (0)`, `no dependent recorded; 1 containment row` | `isValid` is the `ConstraintValidator` callback Bean Validation invokes for `@PetAgeValidation` | `petclinic/backend-rest:src/main/java/org/springframework/samples/petclinic/rest/validation/PetAgeValidator.java:10-36` |
| P3 | N-realworld-J-CONFIG.A2-N2 | which entrypoints reach `JwtService.toToken` (through `MeDatafetcher.getUserPayloadUser`) | only HTTP routes; the GraphQL path never appears | the method carries `@DgsData(...)`: it is the resolver of a GraphQL field, an entry of its own | `realworld/backend:src/main/java/io/spring/graphql/MeDatafetcher.java:27-31`, `:49-60` |
| P4 | N-realworld-J-FLOW.A1-N4 (first mechanism) | the Bean Validation hop from a validated request body to its validator | invisible; the anonymous-class part of the item is a separate T1 mechanism | a `@Valid` parameter runs the `ConstraintValidator` of its type | `realworld/backend:src/main/java/io/spring/api/ArticlesApi.java:30-35` |

The evidence in `repro/` was reproduced on `main` 6d21e7bc — `plan-jhipster.json`, `plan-petclinic.json`,
`plan-realworld.json`, and the answers quoted in "Root cause" — and every `path:line` of this draft is re-checked on
`ebd12a4f` (ADR-0045 L2, L3 and L5a). Those units are gated on `importers`, `outline`, `contract-consequences` and
`trace`; the two plans read `callers` and `entrypoints`, which neither gate moves, so the answers are expected to
hold, but they were not re-run after the merge (**hypothesis**, and the first GREEN probe re-runs them). The shopizer
items that mention framework wiring
(`N-shopizer-J-FLOW.A2-N2`, `N-shopizer-J-FLOW.A2-N1`) are T5 first and are not this RFC's; shopizer's partial answer
(16 endpoints, 95 cuts) is the same *symptom* seen from a cut-heavy walk and is not evidence for this mechanism.

## Root cause

One mechanism, three writers of the same missing fact.

### R1 — The entrypoint vocabulary has no kind for a framework callback (confirmed)

`src/core/domain/entrypoints/entrypoint.ts:22` closes the union at `HttpRoute | UiRoute | Listener | Job`. Every
producer is a reader of an annotation or a call-shape (`listeners.ts:60-75`, `nats-listeners.ts`,
`spring-routes.adapter.ts:108-122`), and none reads a library contract. A `Finding<Entrypoint>` the map cannot express cannot reach `reachedEntrypoints`,
`changedEntrypoints`, `trace` or the renderer. This is why the two counterfactuals answer `complete` with zero
entrypoints: the fact is not wrong about the chains it walks; the vocabulary cannot state the origin.

### R2 — The Java hierarchy resolves library supertypes and then discards the name (confirmed)

`src/core/adapters/spring/java-dispatch-targets.ts:216-260` (`readHierarchy`) already resolves every written supertype
and classifies it. `src/core/adapters/spring/java-declared-types.ts:126-149` (`resolve` at `:126`, `resolveName` at
`:130`) answers
`{ kind: "platform", fqn }` for a type under `org.springframework.`, `java.`, `javax.`, `jakarta.` or `lombok.`
(`java-symbols.ts:140`). `readHierarchy` keeps only "is it a repository type" (`:237-241`) and drops the FQN. So the
one reader that could answer "which repository classes implement `UserDetailsService`" answers it internally and
throws the answer away. Confirmed by reading `:235-249`: `resolved.fqn` is never stored.

This is the mechanism behind P1 and P2. `DomainUserDetailsService` is `@Service` and writes
`implements UserDetailsService` (`:21-22`); `PetAgeValidator` writes
`implements ConstraintValidator<PetAgeValidation, LocalDate>` (`:8`). Both are visible to `resolve` and invisible to
every family.

### R3 — The only framework-invoked kinds are message listeners (confirmed)

`src/core/adapters/spring/listeners.ts:60-75` produces `Listener` and `Job` for messaging annotations and schedules.
ADR-0045 decision 2 names B11 as the only home of framework readers (`:229`), and RFC-0007 row S7 documents the same
scope (`rfc/0007-extension-model.md:376-412`). A repository-wide search over `src/core/adapters/` finds no occurrence
of `UserDetailsService`, `ConstraintValidator`, `DataFetcher` or `DgsData`, and no table of library contracts.

### Reproduction (confirmed on `main` 6d21e7bc; citations re-checked on `ebd12a4f`)

Plans in `repro/` (`plan-jhipster.json`, `plan-petclinic.json`, `plan-realworld.json`), run through
`scripts/driver.mjs` with a private `YE_STATE_DIR`, Node 24.22.2, no network:

```
jhipster  ye_ast_callers DomainUserDetailsService.createSpringSecurityUser
  status: complete / reached entrypoints (0) / impacted: DomainUserDetailsService (contains),
  loadUserByUsername [method] (depth 1, confidence 0.9, via createSpringSecurityUser at 40, 47)
  snapshot: application @ 6b000b5d23a36c45e01472471b84a44fa2464044

jhipster  ye_ast_entrypoints (summary)
  findings: 75 known, 0 unknown   (kinds present: http-route, job; no callback)

petclinic ye_ast_callers PetAgeValidator.isValid
  status: complete / reached entrypoints (0) / evidence view: no dependent recorded; 1 containment row
  snapshot: backend-rest @ 5180cc9bd0163393c4e628bedc1bc4c27cfaab1b

petclinic ye_ast_entrypoints (summary)
  findings: 37 known, 9 unknown   (kinds present: http-route and one no-extractor item; no callback)

realworld ye_ast_callers MeDatafetcher.getUserPayloadUser
  status: complete / reached entrypoints (0) / 1 containment row
  snapshot: backend @ ee17e31aafe733d98c4853c8b9a74d7f2f6c924a
```

The jhipster answer is the proof for P1: the walk already reaches `loadUserByUsername`; only the origin is missing.
The petclinic answer is the proof for P2: nothing in the sources calls `isValid`, and the framework is the caller.
The realworld answer is the proof for P3: `getUserPayloadUser` is invoked by the GraphQL runtime, and the map holds no
kind that could say it.

## Reach

The same mechanism, searched over all of `src/` for the broad form (the written supertype resolved and then discarded,
and the closed `Entrypoint` union):

| Place | What it does today | Variant it produces |
|---|---|---|
| `java-dispatch-targets.ts:216-260` | resolves every written supertype, keeps only repository types | any library supertype with a repository implementation: security callbacks, validators, `ApplicationListener.onApplicationEvent`, `Converter.convert`, `HandlerInterceptor.preHandle`, `MessageListener.onMessage`, `Filter.doFilter`, `DataFetcher.get` |
| `java-declared-types.ts:70-81` (`subtypedTypes`) | resolves every supertype to prove a platform type is not overridden | the same repositories lose `declaredTypes` answers because a library supertype exists — the mirror image of the same fact, owned elsewhere |
| `java-symbols.ts:531-559` (`hierarchy`) | resolves supertypes in Spring order, reports only non-platform gaps | the third reader of the same declaration |
| `listeners.ts:82-87`, `spring-routes.adapter.ts:216-221` | a construct detected but not read is `unknown` | the precedent for the completeness answer this RFC uses |
| `foreign-endpoints.ts:12-22`, `request-mapping.ts:99-109` | another server's endpoint annotations are already data (`FOREIGN_METHOD_ENDPOINTS`, `FOREIGN_TYPE_ENDPOINTS`) and answer `no-extractor` | the precedent for "the plugin's framework knowledge is a table" |
| `entrypoint.ts:22`, `composition-schema-parts.ts:112`, `trace-queries.port.ts:18` | the closed union and its surfaces | every consumer that must learn the new kind |

Variants beyond the four items: a class extending a repository abstract base that implements the contract (inherited
body); a contract implemented through a repository interface that extends it; a `@Bean` factory returning a lambda; a
repository annotation that composes the framework's own; a wildcard-imported supertype; two overloads of the invoked
member.

## Design

### Where it lands on the assembly line (ADR-0045)

**One placement: a reader called by the entrypoints extractor today.** `callbacksOf` is invoked inside
`spring-routes.adapter.ts`'s extraction, which already builds one `JavaProject` per map call (`:108-124`). It is **not**
a stage wired into `BaseReading`: the entrypoints map is not assembled by the line yet (ADR-0045's family matrix lists it
as extractor-only). In ADR-0045's vocabulary this work is the Java entrypoint plugin's B11 contribution ("framework
readers"), and it becomes a B11 stage row only when the entrypoints family moves onto the line; that move is not this
RFC. **No port is added** for the reader, **no family changes**, and **ADR-0045's stage table is not amended** — the
amendment is RFC-0007's row S7, which gains the contract rows and their limits.

| Item | Owner | Place today |
|---|---|---|
| The table of invoked contracts (library types, annotations, member, registration, kind) | the Java entrypoint plugin, as data next to `request-mapping.ts`'s framework tables | a module the plugin imports; not a line stage |
| Which repository types have an invoked supertype | the Java pack, in the one hierarchy reader `java-dispatch-targets.ts` | B5 output (`Hierarchy`), extended — not a new reader |
| The emitted `Finding<Entrypoint>` | the entrypoints family's extractor | inside `spring-routes.adapter.ts` |
| Consuming the kind | `reachedEntrypoints`, `changedEntrypoints`, `trace`, the renderer | unchanged families |

It requires ADR-0044's `readHierarchy` to exist (it does, `:216`), not ADR-0044 V0a–V4, and not ADR-0045 L2/L3. It
depends on one cross-draft seam, stated in U3: RFC-0025 U4 changes `EntrypointExtractor.extract` to answer
`EntrypointExtraction`, and that lands before this RFC's U3.

This RFC extends ADR-0013 decision 5 (a construct enters with a failing fixture) and decision 7 (fail loud) and adds no
family (decision 1) and no new parser (decision 2). It does not contradict an accepted ADR.

### The vocabulary

`src/core/domain/entrypoints/entrypoint.ts`:

```ts
/** Code a framework invokes because of what it is or what it is annotated with: `<library type>.<member>` or `<annotation>`. */
export interface FrameworkCallback {
  kind: "callback";
  /** The contract label `trace` takes: `<fully qualified type>.<member>`, or `<fully qualified annotation>`. The kind is not repeated in it. */
  name: string;
  /** The contract the framework invokes: the library type its implementations are, and the member it calls when a supertype row named it. */
  contract: { type: string; member?: string };
  handler: Handler;
}

export type Entrypoint = HttpRoute | UiRoute | Listener | Job | FrameworkCallback;

/** `<type>.<member>`, or `<type>` when the contract is an annotation: the bare label, never prefixed with the kind. */
export function callbackName(type: string, member?: string): string {
  return member === undefined ? type : `${type}.${member}`;
}
```

The name is deterministic and collision-free because it is the fully qualified library name, as `event <qualified type
name>` is (`entrypoint.ts:4`); it is the label alone, because `entrypointLine` prints the kind and then the name
(`render.ts:274-277`), exactly as `http-route POST /orders` prints the kind once. Two classes implementing the same
contract produce two findings with one name and different handlers, exactly as two listeners on one topic do;
`trace --entrypoint callback:<name>` roots at both, which is the established semantic of an entrypoint name.

### The data (ADR-0013: idioms are data, coverage grows only with evidence)

`src/core/adapters/spring/invoked-contracts.ts` (new). A closed table the plugin owns; a row enters only with a failing
fixture (ADR-0013 decision 5), never as a per-interface branch in a reader:

```ts
/** How the framework obtains the implementation: it constructs it, it reads the plugin's own bean stereotypes, or it reads its own marker annotation. */
export type Registration = "none" | "scanned-bean" | { readonly annotation: string };

/** One library contract a Java entrypoint plugin knows a framework invokes. */
export type InvokedContract =
  | {
      readonly by: "supertype";
      /** Fully qualified name of the library type the code implements. */
      readonly type: string;
      /** The member the framework invokes, by the name and the arity its documented signature declares. */
      readonly member: { readonly name: string; readonly arity: number };
      readonly registration: Registration;
    }
  | {
      readonly by: "annotation";
      /** Fully qualified name of the annotation the framework reads on the method it invokes. */
      readonly type: string;
      readonly registration: Registration;
    };

/** The rows the Java entrypoint plugin reads. U3 lands the three supertype rows. */
export const INVOKED_CONTRACTS: readonly InvokedContract[] = [
  { by: "supertype", type: "org.springframework.security.core.userdetails.UserDetailsService", member: { name: "loadUserByUsername", arity: 1 }, registration: "scanned-bean" },
  { by: "supertype", type: "jakarta.validation.ConstraintValidator", member: { name: "isValid", arity: 2 }, registration: "none" },
  { by: "supertype", type: "javax.validation.ConstraintValidator", member: { name: "isValid", arity: 2 }, registration: "none" },
];
```

U5 appends exactly one row, with its fixture:
`{ by: "annotation", type: "com.netflix.graphql.dgs.DgsData", registration: { annotation: "com.netflix.graphql.dgs.DgsComponent" } }`.

Why each field is data and not a rule:

- `member.arity` — the library's sources are never read, so the signature is the framework's documented one. The arity
  is the smallest fact that makes an overload choice decidable.
- `registration` — a `UserDetailsService` is invoked only as a bean, a `ConstraintValidator` is constructed by the
  validation provider without one (`PetAgeValidator` carries no stereotype, confirmed at `:8`), and DGS reads only the
  methods of its own `@DgsComponent` classes. `scanned-bean` reuses `isScannedBean` (`spring-routes.adapter.ts:264-267`),
  the rule listeners already state; `{ annotation }` resolves the framework's own marker through the file's imports,
  exactly as the contract itself is resolved.
- `by: "annotation"` names the annotation; the plugin resolves it by fully qualified name through the file's imports.

The table is the plugin's framework knowledge, not an application idiom, so it does not live in the workspace manifest
(ADR-0013 decision 6 governs wrappers, URL helpers and event libraries, not a framework's own API). The precedent is
already in the plugin: `FOREIGN_METHOD_ENDPOINTS` and `FOREIGN_TYPE_ENDPOINTS` (`request-mapping.ts:99-109`) are other
servers' annotations held as data. The GraphQL row is the same kind of row; resolved question 1 admits it in this plugin,
and U5 lands it with its own fixture.

### The closure projection (the Java pack's output)

`src/core/adapters/spring/java-dispatch-targets.ts`, the one hierarchy reader ADR-0044 owns, is extended and exported.
`receiverMethods` is not the owner here: it binds a call to the declaration it names and answers nothing about which
types implement a library interface. `dispatchTargets`'s `readHierarchy` is, because it is the only reader that already
resolves every written supertype with the strict reading and knows every concrete type below it. Nothing else changes
in it:

```ts
export interface Hierarchy {
  // …every existing field unchanged (subtypes, supertypes, superclasses, outside, unsettled, unplaced,
  // functionValues, signatureOf)…
  /** Every repository type with an invoked supertype above it, directly or through repository supertypes: each `platform` and `library` FQN `resolve` settles, not only the packages `isPlatformName` calls platform. Each list sorted by file and start line. */
  readonly invokedSupertypes: ReadonlyMap<string, readonly TypeDecl[]>;
  /** The written supertype simple names the strict reading leaves unsettled, by the type that writes them. */
  readonly unsettledSupertypes: ReadonlyMap<TypeDecl, readonly string[]>;
  /** Anonymous and local classes; `fqns` names the library supertypes each written type resolves to. */
  readonly unplaced: readonly { types: readonly TypeDecl[]; names: readonly string[]; fqns: readonly string[] }[];
}

/** The declared hierarchy of the sources, by the strict reading of every supertype a declaration writes. */
export function readHierarchy(files: readonly JavaFile[], project: JavaProject): Hierarchy;
```

`readHierarchy` calls `resolve(..., true)` once per written supertype and keeps the existing `names`/`outside`
decisions unchanged, so `dispatchTargets` answers the same bytes; the FQN it now records — `platform` **and** `library`
alike, since `org.springframework.…` is a platform prefix and `graphql.schema.…` is not — is what the callbacks stage
reads. `unsettledSupertypes` is the per-type counterpart of the existing global `unsettled` set, needed to place the
`unresolved` item at the declaration that writes the name.

### Recognising a library supertype without the library's sources

Java settles a type name outside the compilation unit only through the file itself (JLS 7.5, 6.5.5): a single-type
import, an on-demand import, `java.lang`, or a qualified name. The engine already owns that resolution and this RFC
reads it, never a second copy:

- `resolve(node, file, project, scope, node, libraries = true)` (`java-declared-types.ts:126-149`) answers
  `{ kind: "repository" }`, `{ kind: "platform"; fqn }`, `{ kind: "library"; fqn }` or `undefined`.
  `java-symbols.ts:232-239` (`qualifiedTypeName`) and `:216-225` (`externalNames`) decide the candidate from the file's
  own imports: a single-type import wins alone; `java.lang` for a JDK name; otherwise every on-demand import plus the
  file's own package.
- The contract matches only when the resolved FQN **equals** the row's `type`. A simple-name match is never used, so a
  repository type with the same simple name cannot be confused with the library's.
- `undefined` means the snapshot does not settle the name (two on-demand imports, no import and no qualified form,
  an ambiguous name). The type is then a candidate only when its written simple name equals the row's simple name, and
  it becomes the `unresolved` item of the completeness table below.
- `libraries = true` is what makes a supertype outside the platform package list resolvable (`graphql.schema.DataFetcher`
  is not under `org.springframework.`/`java.`/…). Passing `true` changes nothing else: `resolve` still classifies every
  other name the same way, so `Hierarchy.supertypes`, `outside` and `unsettled` stay byte-identical (U2's gate is
  `none`).

### Algorithm

New reader `src/core/adapters/spring/callbacks.ts`:

```ts
export function callbacksOf(
  project: JavaProject,
  contracts: readonly InvokedContract[],
  annotations: SpringAnnotations,
  hierarchy: Hierarchy,          // from java-dispatch-targets.ts, the Java pack's one hierarchy
): Finding<FrameworkCallback>[];
```

1. **Order.** Read `contracts` in table order, and inside a contract walk `project.types` in declaration order; the
   candidates are collected in that order and sorted once, in step 6.
2. **Supertype row.** `hierarchy.invokedSupertypes.get(row.type)` answers every repository type with that supertype
   above it, directly or through repository supertypes, sorted by file and start line. For each type:
   - skip a type whose `kind` is not `"class"` and every abstract type: no such declaration is a bean by itself, and a
     concrete subclass of it is found by the same map;
   - `row.registration` is not `"none"` and its proof fails → `unknown("no-extractor", [type span])` with the row's
     `type` as `via`, exactly as `listeners.ts:83` answers for a listener that needs a bean. The proof is
     `isScannedBean(type, annotations)` for `scanned-bean`, and the resolved FQN of one of the type's own annotations
     for `{ annotation }` (resolved like the contract, never by simple name);
   - find the invoked member by name and arity: first walk the class and its superclass chain nearest first, because
     a class declaration takes precedence over an interface default. The nearest class level with matching methods
     decides the candidate. If no class declares one and its superclass chain leaves the repository, the body is
     `unknown("no-extractor", [type span])`: an unread superclass may take precedence. Otherwise search repository
     interfaces breadth-first, nearest first. Exactly one matching method with a body at the first level is the
     candidate; multiple matches there give `unknown("unresolved", [type span, each competitor's span])`. If no body
     is found, an outside supertype gives `unknown("no-extractor", [type span])`; otherwise it is
     `unknown("unresolved", [type span])`;
   - otherwise emit a candidate `{ status: "complete", value: { kind: "callback", name:
     callbackName(row.type, row.member.name), contract: { type: row.type, member: row.member.name },
     handler: methodSite(body) }, evidence: [supertype span] }`.
3. **Annotation row.** For every non-abstract class of the project, for every method with a body, each annotation use
   whose `annotations.keyOf` is the row's `type` yields one candidate whose handler is that method, with the
   annotation's span as evidence. The row's `registration` reads like step 2's. A use of a row's annotation on the
   type rather than on a method is `unknown("no-extractor", [use span])`: which method the framework invokes is the
   framework's, and the sources do not say. A use whose annotation the repository declares and whose own
   meta-annotations include a row's annotation is `unknown("no-extractor", [use span])`, detected with the recursion
   `listeners.ts:100-106` already implements.
4. **One finding per handler.** Group the candidates of steps 2 and 3 by their value's identity —
   `(kind, name, contract.type, contract.member, handler.path, handler.symbol, handler.line, handler.endLine)` — and
   keep **one** finding per group: the first in `sortFindings` order, whose `evidence` becomes the union of every
   member's evidence, deduplicated and sorted by path then line. Two classes that inherit the same body therefore
   produce one finding whose evidence names both implementation sites; this is the only deduplication step, and
   `sortFindings`'s own JSON dedup runs after it and finds nothing left to merge.
5. **Completeness (see next section).**
6. **Determinism.** `invokedSupertypes` lists are sorted by file and start line; step 4 sorts the evidence it merges;
   the emitted findings go through `sortFindings` (`finding-order.ts:5-17`, evidence location then kind and name), which
   also keeps two identical findings once; no index-internal id, no clock and no budget takes part, so the same sources
   give the same bytes (RFC-0002 rule 5, ADR-0042).

The handler is the body that runs, so one body is one entrypoint however many beans share it (step 4); the span of an
entrypoint's evidence is the implementation site of every type that uses it: the written supertype for a supertype row,
the annotation use for an annotation row.

### Completeness: what cannot be proven is an item, never a cut

The entrypoints fact states its completeness with items and export cuts (`entrypoint-map.ts:83-120`); a construct the
extractor detects and cannot resolve is an `unknown` `Finding`, not a `Cut` — the rule `listeners.ts:72`, `:82-87`, `:100-106` and `foreign-endpoints.ts:12-22` already follow. This stage adds these items, each with the
contract's FQN as `Evidence.via` so an agent sees what was not proven:

| Situation | Item |
|---|---|
| A written supertype whose simple name equals a row's simple name and whose FQN does not settle (`hierarchy.unsettledSupertypes`) | `unknown("unresolved", [type span, supertype span])`, `via` the row's FQN |
| A `@Bean` method, a field, an initializer or a local whose written type resolves to a contract and whose value is a lambda or a method reference | `unknown("no-extractor", [the value's span])`, `via` the row's FQN: the framework may invoke a function value the reader does not place |
| An anonymous class (`new UserDetailsService() { … }`) whose type resolves to a contract (`hierarchy.unplaced[].fqns`) | `unknown("no-extractor", [the creation expression's span])` |
| A class implementing a contract whose `registration` proof fails (no own stereotype, or not the framework's marker annotation) | `unknown("no-extractor", [type span])` — the listener rule, and RFC-0007 records it as a limit |
| A member not placed in the repository, or several at one level | `unknown("no-extractor"` / `"unresolved"`, as step 2 states) |
| A file the grammar rejects | the existing `source-unreadable` item (`spring-routes.adapter.ts:112-115`) |

The function-value item is the only branch that reads a written context rather than a declaration. It is not a
repository-wide veto: a lambda passed to `Stream.map` cannot become the framework's implementation without a written
context that makes it one (a bean factory's return, a field, an initializer), and those contexts are what the sources
state. Reading only those keeps a `Stream`-heavy repository from losing every class-based callback, which a global
function-value veto would do (jhipster alone holds many lambdas).

No `Cut` is added and no export rule changes: a partial export already cuts the map (`entrypoint-map.ts:96-120`) and
the stage never reads outside the sources it was given.

### What does not change

- **The entrypoint map's shape.** `EntrypointMap`, `contentFingerprint`, `declaredScope`, `exportCuts` and `basePath`
  are untouched. Callbacks carry no base path, as listeners and jobs do not (`render.ts:283-293`).
- **`callers` and `impact`.** `reachedEntrypoints` (`reached-entrypoints.ts:21-53`) joins a finding's handler to the
  nodes the walk reached by path, line span and symbol name. A seed that is a callback handler is a depth-0 node
  (`walk.ts:91`); a reached method that is one keeps its depth. No walk, no edge rule and no cut changes.
  `changedEntrypoints` (`changed-entrypoints.ts:27-56`) gains added/removed/altered callbacks automatically.
- **Cross-repository families.** `link-match.ts:186`, `consumer-sources.ts:227` and `workspace-impact.ts:408` select
  `http-route` only, so a callback is inert there. No link kind, gateway or contract-consequence rule changes.
- **`trace`.** `entrypointHandlers` (`trace-queries.ts:229-245`) roots at `handler` for every kind but `ui-route`; a
  callback target needs the kind's admission and nothing else.
- **Reading.** No parser, no build output, no manifest, no network: the contract's own signatures are data (ADR-0013
  decision 2, ADR-0010).

### Relation to ADR-0044 V2 (call-local framework narrowing)

ADR-0044 decision 4 (V2) narrows **what runs below a call**: at a dispatch site whose receiver is proven to be a
single-valued injection point, `@Qualifier`, `@Primary` and named `@Bean` select among a closed set of bodies. It
answers "which of these proven bodies".

This RFC answers a different question at a different place in the answer: **which declared methods are entry points at
all**. It reads ADR-0044's closure (the same `Hierarchy`, the same `resolve`) so the two never disagree about what the
sources declare, and it owns no dispatch answer, no selection and no veto of ADR-0044's.

| | ADR-0044 V2 | RFC-0026 |
|---|---|---|
| Question | which body of this call runs | which methods the framework invokes |
| Input | a binding, its closed set, the call's place, an injection point | the plugin's table, the hierarchy's library supertypes |
| Output | `dispatchTargets` selection, read by trace | a `Finding<Entrypoint>` in the map |
| Stage | a Spring stage over B2b's `dispatchTargets` answer | a B11 stage over B5's declaration hierarchy |
| Vetoes | closure vetoes decide whether selection is possible | none of them: entrypoints are declarations, not execution |

It is **not the same stage and not the same fact**. They are siblings over the Java pack. Merging them would make
`callers` depend on dispatch closure vetoes, which ADR-0044 decision 3 forbids ("no closure veto ever cuts the
dependence families"): a lambda anywhere would then hide a callback origin. The completeness answer differs too — a
dispatch question asks for a closed body set, an entrypoints question asks for the declarations the sources state.

The one place they touch: a `registration: "scanned-bean"` or `{ annotation }` contract is invoked only as a bean, and a
bean registered through a `@Bean` factory is exactly the case ADR-0044 V2's injection-point proof reads for calls. This
RFC does not reuse that proof; it states `unknown/no-extractor` instead (the listener precedent), and records the
`@Bean`-registered implementation as a limit of RFC-0007's row. When ADR-0044 releases the function-value veto with a
declared signature source, the function-value branch of this stage can narrow with it — that is a follow-up, not a
prerequisite.

## Delivery units

Six units, each one behavior, each with its fixtures failing first and `npm run check` green. `npm run check` is the
gate for every unit; the corpus gate runs once per feature before it reaches `main` (ADR-0039, ADR-0045 decision 8).
Land them in the table's order. The prerequisites are code on `main` ebd12a4f (ADR-0045 L1b's packs, L2/L3/L5a, and
ADR-0044's `readHierarchy`); no pending ADR-0044 V unit and no pending ADR-0045 L unit blocks these. One cross-draft
order is fixed: **RFC-0025 U4 lands before U3**, because it changes `EntrypointExtractor.extract` to answer
`EntrypointExtraction` (`rfc-0025…/rfc.md` U4; `entrypoint-extractor.port.ts:18` today). U1 and RFC-0029 U6 both touch
entrypoint rendering but different surfaces — U1 the kind and the identity unions, U6 the `ReachedEntrypoint` field —
so either order works and U1 does not touch `ReachedEntrypoint`.

| Unit | Behavior | Files | Size | Gate |
|---|---|---|---|---|
| U1 | The kind exists and every surface exposes it; no producer | 14 edit + 2 tests + docs | ~180 | `none` |
| U2 | The Java hierarchy exposes invoked supertypes and unsettled supertype names | 1 edit + 1 test | ~140 | `none` |
| U3 | A supertype row is read: class implementations, bean rule, unresolved and overloaded members, one finding per body | 5 edit/create + fixtures | ~320 | `entrypoints:+`, `callers:+` |
| U4 | An implementation the declarations do not place is an item | 1 edit + fixtures | ~140 | `entrypoints:+` |
| U5 | An annotation row is read | 4 edit + fixtures | ~210 | `entrypoints:+`, `callers:+`, `impact:+` |
| U6 | Measurement and the consumers' own probes | docs + corpus queries, no source | ~60 | `trace:+`, `impact:+` |

### U1 — The entrypoint kind and its surfaces

- **Prerequisites:** none.
- **Create:** `src/core/domain/entrypoints/callback.test.ts`.
- **Edit:** `src/core/domain/entrypoints/entrypoint.ts`; `src/mcp/composition-schema-parts.ts:112,116-125`
  (`entrypointKind`, `entryData`); `src/mcp/composition-schema.ts:51-54` (`entryIdentity`);
  `src/core/ports/evidence-composition.port.ts:317-322` (`EntryIdentity`);
  `src/core/application/composition/compose-evidence.ts:732-743` (`entryIdentity`);
  `src/core/application/composition/composition-normalize.ts:311-330` (`entryData`'s `default` branch);
  `src/mcp/select-evidence.ts:23,74-77` (identity union and its branch); `src/mcp/render-composition.ts:452-458,854`;
  `src/core/ports/trace-queries.port.ts:18` (`ENTRYPOINT_KINDS`); `src/core/ports/entrypoint-extractor.port.ts:11-17`
  (the doc comment's closed list only; its `extract` type is RFC-0025 U4's); `src/cli/main.ts:85` and the `trace` help;
  `src/mcp/server.ts:56,71` (tool text); `README.md:260,271`; `docs/architecture/rfc/0007-extension-model.md`
  (row S7's closed list).
- **The two identities, exactly:** `EntryIdentity` gains
  `{ kind: "callback"; contract: { type: string; member?: string }; handler: EntityId }`, and `EntrypointEvidenceIdentity`
  gains `Pick<Extract<Entrypoint, { kind: "callback" }>, "kind" | "name" | "contract" | "handler">`. Both drop `name`
  where the existing kinds drop it and keep it where the kind reads it; no other field is added.
- **Do not touch:** `entrypoint-map.ts`, `reached-entrypoints.ts`, `walk.ts`, `inbound-edges.ts`, `link-match.ts`,
  `consumer-sources.ts`, `workspace-impact.ts`, `java-dispatch-targets.ts`, `request-mapping.ts`,
  `adapters/spring/findings.ts`.
- **RED test:** `callback.test.ts` — `callbackName("a.b.C", "m")` is `"a.b.C.m"`, `callbackName("a.b.A")` is
  `"a.b.A"`, and `sortFindings` places a callback before an `http-route` at one location and keeps two identical
  findings once. In `src/core/application/trace/trace-queries.test.ts` add one test: the fake map (`:78-84`) holds one
  callback finding and the trace target `{ kind: "callback", name: "a.b.A" }` roots at its handler's line. In
  `src/mcp/entrypoints-presentation.test.ts` add one: a callback item renders
  `  - callback a.b.C.m -> <path>:<line> <symbol>` — the name is the bare label, so the kind appears once, as
  `entrypointLine` composes it (`render.ts:274-277`). Why they fail today: `Entrypoint["kind"]` has no member, the zod
  enums reject it, and `entrypointHandlers` has no name to match.
- **Variant beyond the observed case:** a callback finding whose handler is a class-level symbol is still rendered by
  `entrypointLocation` without a `basePath` branch (`render.ts:270-293`).
- **GREEN acceptance:** the three tests pass; `npm run check` green; the corpus gate is `none` — no producer exists, so
  every answer is byte-identical.
- **Corpus gate:** `--expect none`, because the unit adds vocabulary and surfaces only.
- **Docs:** the same list above; RFC-0007 row S7 gains one sentence: the entrypoint kind `callback` exists and its row
  is RFC-0026.
- **Risk:** item 3 — the MCP output schema's `entrypointKind` enum is a published contract others consume; a client
  that validated the old enum sees one more member. `Risk: item 3 (published output schema gains an enum member)`.

### U2 — The Java hierarchy exposes invoked supertypes

- **Prerequisites:** none.
- **Edit:** `src/core/adapters/spring/java-dispatch-targets.ts` (`Hierarchy` gains
  `invokedSupertypes: ReadonlyMap<string, readonly TypeDecl[]>` and
  `unsettledSupertypes: ReadonlyMap<TypeDecl, readonly string[]>`; `unplaced` entries gain
  `fqns: readonly string[]`; `readHierarchy` calls `resolve(..., true)`, records the FQN of every `platform` and
  `library` answer into `invokedSupertypes` and keeps the same `names`/`outside` decisions; export `readHierarchy`).
  The name is `invokedSupertypes`, not `librarySupertypes`: `org.springframework.…` resolves as `platform`
  (`java-symbols.ts:140`) and `graphql.schema.…` as `library`, and both are contracts a framework may invoke.
- **Create:** `src/core/adapters/spring/java-invoked-supertypes.test.ts`.
- **Do not touch:** `createJavaDispatchTargets`, `targetsOf`, `hierarchyOf`, `globalVeto`, `java-symbols.ts`.
- **RED test** (inline sources, nothing on disk; the file writes only under `os.tmpdir()` if a parser needs one):
  1. `class A implements UserDetailsService` with `import org.springframework.security.core.userdetails.UserDetailsService`
     → `invokedSupertypes.get("…UserDetailsService")` holds `A`;
  2. `interface V extends ConstraintValidator<X, Y>` and `class B implements V` → the same map holds `B` (transitive
     through a repository interface);
  3. `class C` whose repository superclass implements the contract → holds `C`;
  4. two on-demand imports and a written `implements UserDetailsService` → `unsettledSupertypes.get(C)` holds
     `"UserDetailsService"` and no FQN list holds `C`;
  5. `new UserDetailsService() { … }` → the `unplaced` entry's `fqns` holds the contract;
  6. a non-platform library (`graphql.schema.DataFetcher`) settled by a single import → holds its FQN.
  Why it fails today: `readHierarchy` stores neither, and `fqns` does not exist.
- **Variant beyond the observed case:** `class D implements UserDetailsService` written with a qualified name
  (`implements org.springframework.security.core.userdetails.UserDetailsService`) and no import.
- **GREEN acceptance:** the six tests pass; **every existing `java-dispatch-targets.test.ts` answer is unchanged** and
  the corpus gate is `none`.
- **Corpus gate:** `--expect none`; any difference is a defect of the extension and must be fixed, never accepted.
- **Docs:** none (an internal reader's output). ADR-0045's B5 row needs no edit.
- **Risk:** item 3 — the same reader feeds `dispatchTargets`, a contract trace consumes. The unit is additive by
  construction (`resolve(..., true)` classifies every other name identically) and proves it with the corpus gate.
  `Risk: item 3 (shared reader behind trace's dispatch)`.

### U3 — A supertype row is read

- **Prerequisites:** U1, U2, and **RFC-0025 U4** on `main`: it changes `EntrypointExtractor.extract` to answer
  `EntrypointExtraction { findings, cuts? }` (`rfc-0025…/rfc.md` U4; today `entrypoint-extractor.port.ts:18` answers
  `readonly Finding<Entrypoint>[]`). U3 writes against the new shape; it does not touch the port.
- **Create:** `src/core/adapters/spring/invoked-contracts.ts` (the `Registration`/`InvokedContract` types and the three
  supertype rows only — U5 appends the annotation row); `src/core/adapters/spring/callbacks.ts`;
  `src/core/adapters/spring/callbacks.test.ts`; `src/core/adapters/spring/fixtures/callbacks/security/` and
  `…/validation/` (a minimal Java repository each, plus `expected.json`); see "Conformance fixtures" below.
- **Edit:** `src/core/adapters/spring/spring-routes.adapter.ts` — `extractRoutes` (post-RFC-0025 U4) answers
  `EntrypointExtraction`: it **appends** `callbacksOf(project, INVOKED_CONTRACTS, annotations, readHierarchy(parsed,
  project))` to the `Finding<Entrypoint>[]` that `withBasePaths` returns (`:123-124` on `ebd12a4f`), sorts the union, and
  answers `{ findings }` with **no `cuts` of its own** (the callbacks add no cut; `cuts` stays whatever the route reader
  answered). Also move `isScannedBean` to `request-mapping.ts` where `SCANNED_STEREOTYPES` lives, to avoid a cycle; and
  move `methodSite` from `listeners.ts` to `findings.ts` and export it, so a callback and a listener build the same
  handler (`listeners.ts:154-157`).
- **Do not touch:** `spring-payload-shapes.adapter.ts`, `api-delegates.ts`, `foreign-endpoints.ts`,
  `nats-listeners.ts`, `java-symbols.ts`, `java-declared-types.ts`, `entrypoint-extractor.port.ts`.
- **RED test:** `callbacks.test.ts` over `fixtures/callbacks/security` and `…/validation`:
  1. a `@Service class Users implements UserDetailsService` with `loadUserByUsername(String)` → one `complete`
     finding `callback org.springframework…UserDetailsService.loadUserByUsername`, handler `Users.loadUserByUsername`;
  2. a class implementing `ConstraintValidator<A, T>` with `isValid(T, ConstraintValidatorContext)` and no stereotype →
     one callback (a `registration: "none"` row needs no bean);
  3. a class implementing the Security contract without a stereotype → one `unknown("no-extractor")` at the type, no
     callback;
  4. **the dedup rule:** two concrete subclasses of one repository abstract base that declares
     `loadUserByUsername(String)` → **exactly one** `complete` finding whose handler is the base method and whose
     `evidence` deep-equals the two written supertype spans, sorted by path then line (the step-4 group key). Today two
     would be emitted and `sortFindings`'s JSON key would keep both (`finding-order.ts:8-9`);
  5. two same-arity `isValid` overloads on one validator → `unknown("unresolved")` with both spans;
  6. a wildcard-imported `implements UserDetailsService` → `unknown("unresolved")` with the FQN as `via`;
  7. a repository interface named `UserDetailsService` written as a supertype → no item, no callback;
  8. a class whose repository supertype chain reaches `outside` before the member → `unknown("no-extractor")` at the
     type.
  Why they fail today: `extractRoutes` never asks for a contract, and `callbacksOf` does not exist.
- **Variant beyond the observed case:** a `javax.validation.ConstraintValidator` implementation (the pre-Jakarta row)
  and a service that implements both `UserDetailsService` and a repository interface.
- **GREEN acceptance:** the eight tests pass; the map on `jhipster/application` answers `entrypoints` with one
  `callback …UserDetailsService.loadUserByUsername` item whose handler is
  `security/DomainUserDetailsService.java:32-49 loadUserByUsername`; `callers DomainUserDetailsService.createSpringSecurityUser`
  answers `reached entrypoints (1)` at that handler; the same for `petclinic/backend-rest` and
  `PetAgeValidator.isValid` (`reached entrypoints (1)` at depth 0). Re-run `repro/plan-jhipster.json` and
  `repro/plan-petclinic.json` and diff the answer text.
- **Corpus gate:** `--expect entrypoints:+ --expect callers:+` — both answers gain one element and lose none, so the
  direction is `+`; the report must attribute every moved answer to one of the two rows. `impact:+` only if a diff
  query reaches a callback handler; the unit states which.
- **Docs:** RFC-0007 row S7 gains a "framework-invoked callbacks" block: the three supertype rows, the bean rule, the
  `unknown` items and the limits (`@Bean`-registered implementations, XML beans, a library auto-configuration);
  `README.md:271` says "routes, listeners, jobs and framework callbacks"; `src/mcp/server.ts:56` likewise.
- **Risk:** item 3 — `isScannedBean` and `methodSite` move between files that the route reader also uses.
  `Risk: item 3 (shared helpers move)`.

### U4 — An implementation the declarations do not place is an item

- **Prerequisites:** U1, U2, U3.
- **Edit:** `src/core/adapters/spring/callbacks.ts` (the `@Bean` function-value branch and the anonymous-class branch of
  the completeness table); `callbacks.test.ts`; new fixtures `security/lambda-bean/` and `validation/anonymous/`.
- **Do not touch:** U3's member lookup, `invoked-contracts.ts`, `spring-routes.adapter.ts`.
- **RED test:**
  1. a `@Bean` method whose written return type resolves to `UserDetailsService` and whose body is `this::load` or a
     lambda → one `unknown("no-extractor")` at the value, `via` the FQN;
  2. a `@Bean` method returning a lambda while every class implementation is a bean → the class callbacks stay and the
     item is added;
  3. `new ConstraintValidator<>() { … }` → one `unknown("no-extractor")` at the creation expression, and the other
     validator callbacks of the fixture stay;
  4. a lambda in a `Stream.map` argument and a lambda in a local of an unrelated type → no item.
  Why they fail today: the branches do not exist and the implementations are silent.
- **Variant beyond the observed case:** a `@Bean` method returning a method reference to a repository method of the
  contract's arity; a lambda inside a nested lambda returned by the factory.
- **GREEN acceptance:** the four tests pass; the two fixtures answer exactly their `expected.json`; no other fixture's
  answer moves.
- **Corpus gate:** `--expect entrypoints:+`; the report lists any measured application whose factory registers a
  contract this way, with the item it now states.
- **Docs:** RFC-0007's S7 block's limits list gains the two "not placed" items.
- **Risk:** none.

### U5 — An annotation row is read

- **Prerequisites:** U1, U3.
- **Edit:** `src/core/adapters/spring/invoked-contracts.ts` (append the row
  `{ by: "annotation", type: "com.netflix.graphql.dgs.DgsData", registration: { annotation: "com.netflix.graphql.dgs.DgsComponent" } }`);
  `src/core/adapters/spring/callbacks.ts` (step 3 of the algorithm); `request-mapping.ts` (`KNOWN` gains
  `com.netflix.graphql.dgs.DgsData`); `callbacks.test.ts` and `fixtures/callbacks/graphql/`.
- **Do not touch:** U3's supertype branch, U4's completeness branches, `invoked-contracts.ts`'s supertype rows.
- **RED test:** over `fixtures/callbacks/graphql`:
  1. `@DgsComponent class Me` with a `@DgsData` method with a body → one callback, name
     `com.netflix.graphql.dgs.DgsData`, handler that method, rendered `- callback com.netflix.graphql.dgs.DgsData`;
  2. the annotation on the type → `unknown("no-extractor")` at the use;
  3. the annotation on an abstract method → `unknown("no-extractor")` at the method;
  4. a repository-declared annotation whose own meta-annotation is `@DgsData` on a method →
     `unknown("no-extractor")` at the use;
  5. `@DgsData` on a method of a class with no `@DgsComponent` → `unknown("no-extractor")` at the type, because the row's
     `registration: { annotation: "com.netflix.graphql.dgs.DgsComponent" }` proof fails; the same fixture with
     `@DgsComponent` present answers the callback (test 1).
  Why it fails today: step 3 does not exist and `keyOf` returns `undefined` for the annotation.
- **Variant beyond the observed case:** two methods of one class, each `@DgsData`, produce two callbacks with one name
  and two handlers; `sortFindings` keeps both.
- **GREEN acceptance:** the five tests pass; on `realworld/backend`, `entrypoints` answers two callback items whose name
  is `com.netflix.graphql.dgs.DgsData` at `MeDatafetcher.java:27` and `:49`, and
  `callers MeDatafetcher.getUserPayloadUser` answers `reached entrypoints (1)` at depth 0.
- **Corpus gate:** `--expect entrypoints:+ --expect callers:+ --expect impact:+` (a diff query can gain a reached
  callback).
- **Docs:** RFC-0007's "Not detected" list drops "GraphQL resolvers", its S7 block gains the annotation row, and
  resolved question 1 records the admission.
- **Risk:** none.

### U6 — Measurement and the consumers' own probes

- **Prerequisites:** U1–U5.
- **Edit:** `docs/architecture/rfc/0007-extension-model.md` (the parity section: the four measured applications, the
  items closed, the rest explained), `docs/architecture/rfc/0013-trace-and-patterns.md` (the entrypoint kinds a trace
  target may name), and the corpus manifest outside the repository (one `trace --entrypoint callback:…` query per
  landed row, one `callers` query per counterfactual).
- **Do not touch:** `src/`.
- **RED test:** none in `src/`; the RED artifact is the corpus manifest change, whose first run must show the new
  queries differing from their base answers with the expected direction, and the study plans in `repro/` re-run with
  the expected text. If the gate reports no difference for a new trace query, the query does not exercise the handler
  and is fixed before the unit closes.
- **GREEN acceptance:** the three study plans (four items) answer as "Measurement" states; the corpus report
  attributes every moved answer; `npm run check` green.
- **Corpus gate:** `--expect trace:+ --expect impact:+` for the new queries; the four pre-existing families stay as U3
  and U5 declared.
- **Docs:** the two RFCs above and the parity table.
- **Risk:** none.

### Conformance fixtures (RFC-0007 "Conformance")

Each row owns a minimal repository under `src/core/adapters/spring/fixtures/callbacks/<row>/`: the `.java` sources and
`expected.json`, the findings the extractor must answer (status, kind, name, handler file, line and symbol, or reason
and evidence). Fixtures required by the units:

| Fixture | Row | Unit | Expected |
|---|---|---|---|
| `security/bean-implements/` | UserDetailsService | U3 | one callback, handler `Users.loadUserByUsername` |
| `security/no-stereotype/` | UserDetailsService | U3 | one `unknown(no-extractor)` at the type |
| `security/inherited-body/` | UserDetailsService | U3 | one finding for the two subclasses, handler the base's method, evidence both supertype spans |
| `security/wildcard-import/` | UserDetailsService | U3 | one `unknown(unresolved)`, `via` the FQN |
| `security/same-simple-name/` | UserDetailsService | U3 | no item |
| `security/lambda-bean/` | UserDetailsService | U4 | one `unknown(no-extractor)` at the value |
| `validation/jakarta/`, `validation/javax/` | ConstraintValidator | U3 | one callback each, no bean needed |
| `validation/overloads/` | ConstraintValidator | U3 | one `unknown(unresolved)`, both spans |
| `validation/anonymous/` | ConstraintValidator | U4 | one `unknown(no-extractor)` at the creation |
| `graphql/annotated-method/` | DgsData | U5 | one callback, handler the method |
| `graphql/annotated-type/`, `graphql/composed/`, `graphql/abstract-method/` | DgsData | U5 | one `unknown(no-extractor)` each |

Every fixture is seen failing first (ADR-0013 decision 5). A fixture a later row needs is added with that row, never
ahead.

## Measurement

| Unit | Study items it should close | How to re-check |
|---|---|---|
| U3 | CF-JHIPSTER-J-BUG, CF-PETCLINIC-J-BUG, and the Bean Validation half of N-realworld-J-FLOW.A1-N4 | the two counterfactual plans in `repro/`: `callers` must answer a `callback` entrypoint whose handler is `DomainUserDetailsService.loadUserByUsername` / `PetAgeValidator.isValid`; `entrypoints` must hold one item per placed body (one each here) |
| U5 | N-realworld-J-CONFIG.A2-N2 | `plan-realworld.json`: `callers MeDatafetcher.getUserPayloadUser` answers a `callback com.netflix.graphql.dgs.DgsData` entrypoint; `entrypoints` holds two |
| U6 | none new: it makes the four observable in the corpus gate | the gate's family table gains the new `trace` queries and the report names each moved answer |

U4 closes no studied item: it is the completeness guard that stops the new fact from answering `complete` over a
factory-registered or anonymous implementation. N-realworld-J-FLOW.A1-N4 stays partially open by design: its second
mechanism (an anonymous-class body, T1) is not this RFC's. N-shopizer-J-FLOW.A2-N2 stays with ADR-0044 (T5). Nothing on
the 2026-11-08 list is promised beyond these four.

## Review responses

Findings from `designs/review-entrypoints.md` (RFC-0026 rows 10–19).

| # | Severity | Response |
|---|---|---|
| 10 | blocker | **Fixed.** The algorithm gains step 4, **one finding per handler**, grouped by `(kind, name, contract.type, contract.member, handler.path, handler.symbol, handler.line, handler.endLine)`; the group's evidence is every implementation span, deduplicated and sorted. U3's test 4 asserts exactly one finding with both supertype spans for two subclasses of one abstract base, and the sentence after the algorithm says one body is one entrypoint. `sortFindings`'s JSON key (`finding-order.ts:8-9`) then finds nothing to merge. |
| 11 | major | **Fixed.** `registration: "bean"` is gone; the union is `"none" \| "scanned-bean" \| { annotation }`. U5's test 5 describes the `{ annotation: "com.netflix.graphql.dgs.DgsComponent" }` proof failing, and the ADR-0044 comparison names both non-`"none"` forms. |
| 12 | major | **Fixed.** `name` is the bare contract label (`callbackName` returns `<FQN>.<member>` or `<FQN>`), so `entrypointLine` (`render.ts:274-277`) renders `- callback <FQN>.<member>`; U1's render test and trace target use the bare value. |
| 13 | major | **Resolved by the owner's decision** of 2026-11-09 ("resolve every open question as recommended"): resolved question 1 admits the GraphQL row, so U5 is no longer `BLOCKED BY Q1`. |
| 14 | major | **Fixed.** RFC-0025 U4 is U3's stated prerequisite (it changes `EntrypointExtractor.extract` to `EntrypointExtraction`, `rfc-0025…/rfc.md` U4, today `entrypoint-extractor.port.ts:18`). U3 appends callbacks to the `Finding<Entrypoint>[]` that `withBasePaths` returns and the adapter answers `{ findings }`; callbacks add no cut. |
| 15 | major | **Fixed.** Renamed to `invokedSupertypes` and stated to hold every `platform` **and** `library` FQN: `org.springframework.…` is platform (`java-symbols.ts:140`) and `graphql.schema.…` is library (`java-declared-types.ts:148`). U2's edit records both. |
| 16 | major | **Fixed.** One placement: a reader called inside `spring-routes.adapter.ts`'s extraction, **not** a `BaseReading` stage; no port, no family change, and ADR-0045's stage table is not amended. B11 is named only as where it will sit when the map moves onto the line; RFC-0007 row S7 is what this RFC amends. |
| 17 | major | **Fixed.** U3 creates `invoked-contracts.ts` with the three supertype rows only; U5 appends the annotation row with its fixture. No deferral inside `callbacksOf` is needed. |
| 18 | minor | **Accepted, fixed by a different edit.** The `MappedEntrypoint` change is removed: callbacks are concatenated **after** `withBasePaths` returns `Finding<Entrypoint>[]` (`spring-routes.adapter.ts:123-124`), so `findings.ts` is untouched. The port's doc comment (`entrypoint-extractor.port.ts:11-17`) is added to U1; its `extract` type stays RFC-0025 U4's. |
| 19 | minor | **Fixed on the new baseline.** `java-declared-types.ts:126-149` (`resolve` at `:126`, `resolveName` at `:130`); `changed-entrypoints.ts:27`; plus `compose-evidence.ts:732-743`, `trace-queries.ts:229-245`, `README.md:271`, `select-evidence.ts:74-77`. One citation is kept against the review: `listeners.ts:60` is `listenersOf` on `ebd12a4f` (`git show ebd12a4f:src/core/adapters/spring/listeners.ts` → line 60), not `:61`. |

## Resolved questions

The owner decided on 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (resolve every open question as
you recommend). Each decision below is the recommendation the draft already carried, and every unit is written for it.

| # | Question | Decision |
|---|---|---|
| 1 | May the GraphQL annotation row enter the Java entrypoint plugin on one measured application, or does it wait for a GraphQL framework plugin with ADR-0013 decision 4's two measured applications? | **It enters this plugin**, landed by U5 with its fixture. RFC-0007 row S7 already holds other servers' APIs here, the fixture proves the construct, and the second measured application is the trigger to keep the row rather than a prerequisite to add it. RFC-0007 records that it rests on one application. |
| 2 | Should a `registration` proof treat a class registered only by a `@Bean` factory as `unknown`, as listeners do, or should it read the factory? | **Keep the listener precedent** (`unknown/no-extractor`), landed by U4. Reading factory registration is a second fact with its own vetoes; the explicit item tells the agent what to inspect and never claims a completeness the sources do not show. |
| 3 | Should the name be the fully qualified contract label or a shorter one? | **The bare fully qualified contract label**: `<FQN>.<member>` for a supertype row, `<FQN>` for an annotation row, with the kind never repeated in it. A simple name collides across packages, and `event <qualified type name>` sets the fully qualified precedent. |
| 4 | Does a newly appearing callback belong in `impact`'s `changedEntrypoints` without further work? | **Yes, with no extra rule.** A callback added between base and head is an added entrypoint; suppressing it would need a rule that says some entrypoints are not changes, and no evidence supports one. |

## Decisions recorded in ADR-0048

- **A framework-invoked implementation is an entrypoint.** One ADR: the kind `callback`, the plugin's data table, the
  Java pack's supertype closure as the only implementation source, the one-finding-per-body rule, and the rule that what
  cannot be proven is an `unknown` item. It points here for the design and amends RFC-0007 row S7; ADR-0045 B11 is where
  it will sit once the entrypoints map moves onto the line, which this RFC does not do.
