# ADR-0079: An unresolved reference is attributed by its receiver's type, not by the name it spells

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The recommended design and the recommended
  answer of each question below are adopted under it and reported to the owner afterwards. It settles ADR-0041 open
  question 7, which RFC-0024 resolved question 3 deferred until the receiver-typed candidates existed, under the bound
  it set: no answer's size grows and ADR-0045 M1 holds.
- Related: [ADR-0041](0041-one-call-reconciliation-for-every-family.md) decisions 4, 6, 8 and open question 7,
  [ADR-0046](0046-a-call-binds-by-its-receivers-type.md), [RFC-0024](../rfc/0024-receiver-typed-settlement.md),
  [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md) decisions 9 and 11,
  [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md),
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [ADR-0063](0063-a-jdk-the-host-declares-is-the-library-signature-source.md),
  [ADR-0064](0064-a-supertype-outside-the-repository-redefines-no-java-name.md),
  [ADR-0071](0071-engine-investment-is-steered-by-a-cut-ledger-and-an-outcome-control.md),
  [ADR-0073](0073-a-classpath-the-host-declares-is-a-library-signature-source.md),
  [ADR-0075](0075-the-core-names-no-language-or-framework.md)
- Amends: ADR-0041 decision 8 (index unresolved references join the reverse access by a signal) and,
  with unit U3 only, ADR-0063 decision 7 (`callers` and `impact` accept `--jdk`)

**In short:** `callers` and `impact` stop reading a qualified reference the index left unresolved as a possible call to
every reached declaration of its name. The references that would become a `name-only` cut, and only those, are bound by
the base binding chain that already binds recovered calls. A proof that names another target, or a receiver whose
declared type lies outside the repository and that no type at or below the reached declaration's owner can be, retires
the cut; a binding to a reached declaration becomes a dependence; anything the chain cannot settle keeps today's cut.
On today's corpus this can retire up to 217 of the 279 `name-only` cuts (78%) without a declared JDK.

## Context

### What the cut is today

`unresolvedLinkCuts` (`src/core/domain/impact/impact-cuts.ts:181-245`) reads every reference the index left
unresolved. A qualified reference with no index candidates is attributed to no declaration
(`impact-cuts.ts:221`), so when its name tail equals a reached declaration's name (`pointing`, `:214-220`) and no
proof settles it (`settledAt`, `:223-228`), it adds its place to one cut per caller file with the reason `name-only`,
whose reach is every reached declaration of that name (`:233-244`). The proofs it reads are TypeScript-only: the
member uses of the relations reader (`MemberReferenceProofs`, `src/core/application/impact/inbound-edges.ts:386`) and
the import proofs of `referenceProofsOf` (`src/core/application/navigation/reference-origins.ts:32-58`), which ask
`ImportOrigins.origins`, a method the Java pack answers `unknown` for every site
(`src/core/adapters/spring/java-name-bindings.adapter.ts:41`). `impactOf` also receives the relations reader's
`externalUses` (a call through a field proven to hold an outside type) and never reads them
(`src/core/application/impact/impact-queries.ts:667`). No Java receiver proof is asked for an index reference.

ADR-0041 open question 7 measured the obvious remedy: feeding every index unresolved reference to `into` added 1,068
cuts to each of two answers of one backend and took them from 3.6 s and 5.2 s to about 140 s, because an unbound
reference was attributed to every homonym instead of to the candidates at its receiver's type.

### Recount (corpus gate cache of main `6e022600`, 118 answers)

279 `name-only` cuts: Java 111 in `callers` and 111 in `impact`, TypeScript 56 in `impact` and 1 in `callers`. They
hold 1,217 places (Java 1,123, TypeScript 94). Each place was classified by reading the cited line and its declarations
in the repository's own sources (`git show <rev>:<path>`), by pattern matching, not by the engine. The classification
is therefore a **hypothesis per place**, spot-checked by hand on 15 places of the largest answer, all of which matched.
A cut retires only when all of its places settle, so the table counts a cut under a class when every place of it
belongs to that class; 41 cuts mix classes and are counted in the "touching" column of each.

| # | Receiver class | Places | Cuts only this class | Cuts touching |
|---|---|---:|---:|---:|
| J1 | Java value receiver (parameter, local, field) declared as a `java.*` type: `Map` 404, `Optional` 144, `List` 38 | 664 | 108 | 142 |
| J2 | Java value receiver declared as a library type outside `java.*` | 30 | 10 | 10 |
| J3 | Java static call on a platform type name (`Paths.get`) | 54 | 2 | 10 |
| J4 | Java receiver that is the result of one repository call whose declared return type is a platform type (`config.getKeys().get(k)`) | 270 | 28 | 58 |
| J5 | Java receiver that is a longer chain through library calls (`x.stream().filter(..).findFirst().get()`) | 44 | 12 | 22 |
| J6 | Java receiver of a repository type whose member is supplied outside (an inherited Spring Data operation, `Enum.equals`) | 6 | 5 | 5 |
| J7 | Java receiver typed by inference (a lambda parameter); `var`: none on the corpus | 10 | 2 | 8 |
| J8 | Java receiver that is a static field path (`Constants.TABLE.get`) | 5 | 3 | 5 |
| J9 | Java unqualified type name (the relations reader's unresolved type references, `impact-queries.ts:705`; hypothesis) | 40 | 12 | 12 |
| T1 | TypeScript field or local of a repository class (`inject(C)`) whose called member is a property | 25 | 15 | 16 |
| T2 | TypeScript field or local typed by a repository call's result (`resource<T>(...)`) | 29 | 11 | 12 |
| T3 | TypeScript field declared and initialized with a package type (`new DataSource()`) | 32 | 24 | 24 |
| T4 | TypeScript parameter typed by a platform type or `any` | 3 | 3 | 3 |
| T5 | TypeScript receiver that is a call result | 2 | 1 | 1 |
| T6 | TypeScript bare callback parameter or lazy import | 3 | 2 | 2 |

The reached declarations these cuts name are few (34 distinct) and mostly plain: controllers and facades with no
supertype outside the repository, an interface, a configuration class with its own `equals`, `hashCode` and
`toString`. The whole volume comes from common member names (`get` alone: 284 of the 314 chained places) meeting a
reached declaration of that name.

### Reproductions (run on fixtures under `mktemp -d`, main `6e022600`)

A Java fixture declares `Api.get(String)`, `Api.save(Api)` and `Api.equals(Object)`, a `Holder` whose `values()`
returns `Map<String, String>`, a `MyMap extends HashMap<String, String>` overriding `get`, an `ApiRepository extends
JpaRepository<Api, Long>`, an enum `Kind`, a `Constants.TABLE` map, and callers of each shape. A TypeScript fixture
declares `Page.isOnline()`, `Table.get/load/value`, a `StatusService` and callers.

| Class | Command (`npm run -s cli -- callers <fixture> ...`) | Cut produced |
|---|---|---|
| J1 | `src/main/java/com/acme/Api.java:get` | `name-only` at `Service.java:15 map.get`, `:19 opt.get` |
| J2 | same | `name-only` at `More.java:23 node.get` (`com.lib.Node`) |
| J3 | same | `name-only` at `Service.java:23 Paths.get` |
| J4 | same | `name-only` at `Service.java:27 holder.values().get` |
| J5 | same | `name-only` at `Service.java:40 names.stream().findFirst().get` |
| J6 | `src/main/java/com/acme/Api.java:equals` | `name-only` at `More.java:19 kind.equals` |
| J7 | `src/main/java/com/acme/Api.java:get` | `name-only` at `Service.java:36 row.get` (a lambda parameter of `List<Map<..>>`) |
| J8 | same | `name-only` at `More.java:27 Constants.TABLE.get` |
| `var` | same | `name-only` at `Service.java:32 local.get` |
| Control | `src/main/java/com/acme/MyMap.java:get` | the same places; `map.get` may run `MyMap.get` and must stay cut |
| T1 | `src/app/page.ts:isOnline` | `name-only` at `helper.ts:14 this.status.isOnline` (inject), `:18` (annotated), `:22` (`new`), only when `isOnline` is a property; as a method the answer is `complete` |
| T2 | `src/app/table.ts:value` | `name-only` at `lists.ts:13 this.resource.value` |
| T3 | `src/app/table.ts:load` | `name-only` at `lists.ts:9 this.source.load` (`private readonly source: DataSource = new DataSource()`) |
| T4 | `src/app/table.ts:get` | `name-only` at `helper.ts:32 map.get` (`map: Map<string, string>`) |

Two side observations, outside this decision: with `Api.get` the only repository `get`, the index resolved
`row.get(...)` inside the lambda into `Api.get` (`derivation: "resolved"`), and `repository.save(api)` on the Spring
Data interface into `Api.save`. Both are over-reports (a false dependence), not false `complete` answers.

### What already owns each question

| Question | Owner today |
|---|---|
| Which declaration a call the index left unresolved binds to | `CallBindings.boundCalls` (`src/core/application/navigation/call-binding.ts:76-89`), ADR-0041 decision 4; it accepts an index reference as an `UnboundCall` |
| The method a Java member call names by its receiver's declared type, and a repository call's declared return type | `ImportOrigins.receiverMethods` (`src/core/ports/import-origins.port.ts:105`, `src/core/adapters/spring/java-receiver-methods.ts:69-122`); today a receiver declared outside the repository answers `unproven` with no candidates |
| A static call rooted at a type outside the repository | the chain's root link, from `rootOrigins` (`java-name-bindings.adapter.ts:48-66`); trace already places `Paths.get` as an external leaf |
| A call through a TypeScript field proven to hold an outside or repository type | `ExternalMemberUseOrigin` and `MemberUseOrigin` (`src/core/domain/relations/member-use.ts`), read by `provenCallsOf` |
| A Java type's declared hierarchy, its gaps and the memberless platform interfaces | the Java pack's resolver (`java-receiver-methods.ts:241-292`, `MEMBERLESS_PLATFORM_INTERFACES`) |
| The types that may run a method below its owner (generators, proxies, anonymous and local classes) | `ImportOrigins.dispatchTargets` (`java-dispatch-targets.ts`), ADR-0044 |
| Library supertypes, return types and finality | `LibrarySignatureSource`: the declared JDK (ADR-0063) and classpath (ADR-0073) |

## Decision

1. **Which references are asked.** In `callers` and `impact`, an index unresolved reference is asked only when today's
   rule would put it in a `name-only` cut: it is qualified, the index gives it no candidate, its name tail equals the
   name of a reached declaration of a kind the reference can reach, and no existing proof settles it. The signal is the
   set of reached declaration names, read from an in-memory index of the read's unresolved references by name tail.
   No size, count or sample decides which references are asked.
2. **One owner binds them.** They are bound by `CallBindings.boundCalls`, the chain ADR-0041 decision 4 already applies
   to recovered calls, from inside the reverse walk's fixpoint beside `into` (ADR-0041 decision 8), so a reference that
   binds into a declaration reached in a later round is asked in that round. No family binds them itself (ADR-0041
   decision 6), and the rules below are written against the binding's kinds, not against a language (ADR-0075).
3. **What settles a reference.** By the binding the chain answers:

   | Binding | Outcome | Why it cannot hide a dependent |
   |---|---|---|
   | A target that is a reached declaration (`declaration`, or `receiver` with a `target`) | A dependence edge into it, `proven` or `typed` (ADR-0036); the walk continues from the caller | It is the compile-time binding |
   | `generated`, or `outside` (a root outside the repository) | No cut from this reference | Dependence is the compile-time binding (ADR-0036), and neither names a declaration of the repository |
   | A target that is another declaration | No cut from this reference when every declaration the binding names was reached, or when the reached declaration's language pack proves it neither implements nor overrides that target (`implementedDeclarations` answers `declarations` without it); otherwise today's cut | A reached target holds the caller in its own answer. An unreached one may still dispatch to the reached declaration, and the walk's upward bridge is not a proof of the contrary: the index records no supertype edge for a generic supertype (measured in U1), so only the pack's reading of the hierarchy retires the cut |
   | `receiver`, or a nominal pack's `unproven`, with candidates the receiver's type offers | Attributed among them: one `hidden-caller` cut per reached candidate, none if no candidate is reached | The candidates are the whole hierarchy's declarations of the name at the call's arity, given only when the reading read that whole hierarchy (`import-origins.port.ts:193-198`) |
   | A receiver declared outside the repository (decision 4) | Today's `name-only` cut, its reach narrowed to the reached declarations that may dispatch from it (decision 5); no cut when none may | Decision 5 keeps every declaration a value of that type may run, and the cut keeps today's shape (resolved question 1) |
   | `unbound`, `unknown`, `unproven` without candidates, `capability-absent` | Today's `name-only` cut, unchanged | Nothing changes |

   An unbound reference is never attributed to the homonyms of its name. That is what produced the 1,068 cuts of open
   question 7.
4. **An outside receiver is an answer, not an absence.** `ReceiverMethod` gains one variant, `{ kind: "outside"; type:
   string }`: the receiver's type, settled by the strict reading with the assumptions of ADR-0062 and ADR-0064, is the
   type of that qualified name outside the repository, so the call names that type's member. It covers a parameter, a
   local, a field and a type-variable bound declared with such a type, and the declared return type of the repository
   method a receiver call names (`f().m()`, RFC-0013 R5). The pack answers it only where it answers today, under
   `provesBinding` (`java-receiver-methods.ts:236-238`). A static call on a type name outside the repository is not this
   variant: the chain's root link already binds it `outside`. Nor is a receiver declared as a platform interface that
   decision 6 leaves out of its list (`java.io.Serializable id; id.toString()`): a class implementing it would not be
   seen below it, so the pack answers as today and the reference keeps its cut. The base maps the variant to a
   `receiver` binding with `outside: true` and the attributed set of decision 5. Trace reads the variant as it reads
   today's `unproven` answer, so trace's answers do not change.
5. **Who may run under an outside type.** A reached method `D`, declared in type `O`, may run when a member `m` of an
   outside type `T` is called, unless one of these proofs excludes it:
   - `D` is static: an instance call never dispatches to a static method;
   - `ImportOrigins.outsideSupertypes` (new, decision 6) answers, for `D`'s place, the qualified names of the supertypes
     outside the repository of every type at or below `O`, and with no library signatures that list is empty and `T` is
     not the language's root type (`java.lang.Object`), the implicit superclass of every class;
   - with library signatures (decision 8), each listed supertype's library closure is held in full and excludes `T`, or
     the signatures state `T` final, so no type of the repository is below `T`.

   `D` stays attributed when the answer is `unknown`. That covers a supertype the strict reading leaves unsettled at or
   below `O`, a set of types below `O` that the dispatch reading cannot close (a declared source generator, a dynamic
   implementation, an anonymous or local class extending a type at or below `O`, a function value that may implement
   a functional interface at or below `O`, an unread JVM source), an aspect member that introduces a supertype
   (`@DeclareParents`, `@DeclareMixin`), an owner the reader cannot place, and a language that types structurally
   (decision 7). An annotation on `O` or on `D` and the advice of an aspect do not make the answer `unknown`, although
   `dispatchTargets` reads both as code that may replace a body: under the assumption that a proxy or a generated
   subclass of a repository type adds no supertype the type's own methods run under (as ADR-0064 assumes for names), a
   value of `T` is no such class unless `O`'s declared hierarchy says so. Measured on the largest Java repository of
   the corpus: with both conditions read as `unknown` no place of 1,017 left its cut; without them 332 did, each a
   call on a JDK collection. An enum or a record has an implicit outside supertype (`java.lang.Enum`, `java.lang.Record`), so it is listed and
   keeps `D` attributed without signatures. Every rule excludes `D` only by a proof that no runtime class running `D`
   can be a `T`, so none produces a false `complete`. The fixture's `MyMap.get` keeps its cut by the second rule:
   `java.util.HashMap` is listed.
6. **The port gains one member, read by the hierarchy's owner.** `outsideSupertypes(sites: readonly ImplementingSite[])`
   answers `{ kind: "types"; types: readonly string[]; root?: string; static?: true } | { kind: "unknown"; reason?:
   capability-absent }`, read by the Java pack from the same resolver and the same subtype closure that
   `receiverMethods` and `dispatchTargets` read, with `MEMBERLESS_PLATFORM_INTERFACES` left out as `createResolver`
   leaves them out today. `root` names the language's root type and `static` says the method takes no receiver: the
   two facts decision 5 reads that the base cannot state itself (ADR-0075 decision 1). The member is optional on the
   port, and the router of language packs answers `capability-absent` for a pack without it. It is asked lazily, once per
   reached method that an outside-typed reference names, and memoized for the read. `implementedDeclarations` keeps its
   meaning: its `unknown` stays "any contract may apply".
7. **TypeScript adds no rule.** A structural language cannot prove that a class is not assignable to a type from its
   declared heritage, so its pack answers `outsideSupertypes` with `capability-absent`. A TypeScript reference settles
   only through the proofs the chain already reads: a member proof of the relations (a property member included, T1),
   `ExternalMemberUseOrigin` for a field that holds an outside value (T3), ADR-0029 decision 9 for an annotated receiver
   (T4), and the type checker with a declared `node_modules` (ADR-0037 decision 10), which is the only owner of T2.
8. **Library signatures are optional and only narrow.** Without `--jdk` and without a classpath, decision 5 excludes a
   declaration only by an empty list. With them (U3), `LibrarySignatureSource` supplies supertype closures, finality and
   the return types a library call in a chain declares (J5). `callers` and `impact` then accept `--jdk`, which amends
   ADR-0063 decision 7; ADR-0073 already lets them accept `--classpath`. A declaration the source does not hold proves
   nothing, so its supertype stays unsettled.
9. **The bound.** For every reference, the reach of the cut it produces is a subset of today's, and a reference that
   produced no cut produces none. The only new dependents are callers a binding proves. That is RFC-0024 resolved
   question 3's bound, and the corpus gate checks it (`--expect-cuts name-only:-`).

## Cost

- **Asked:** at most the places of today's `name-only` cuts in that answer, plus those whose tail names a declaration
  reached in a later round. On the largest answers this is 528 places in 98 files, against a gate wall time of 11.4 s
  (`callers`) and 18.6 s (`impact`). Open question 7 bound every unresolved reference of every read source through
  `into`'s name index and attributed every unbound one. This decision binds only the pointed references and attributes
  none of the unbound ones. Hypothesis, to measure in U1: the added time is under a second on that repository, since the
  Java project is held once per read (ADR-0040) and `receiverMethods` reads one file per asked site.
- **Retained:** `receiverMethods` answers as derived facts keyed by the layout and the sites (ADR-0035,
  `java-receiver-methods.ts:133-145`); bindings and `outsideSupertypes` answers memoized for the read; the name-tail
  index of the read's unresolved references in memory only. Nothing new is persisted.

## Units

Ordered. Each unit carries its tests and docs, passes the corpus gate on its own, and states its ledger rows (ADR-0071
decision 3). The estimates are upper bounds from the recount: every cut whose places all fall in the unit's classes,
assuming the walked owners' hierarchies are closed and `provesBinding` holds on each repository (hypotheses).

| Unit | Behavior | Files | RED fixture | Ledger estimate | Must-not controls |
|---|---|---|---|---|---|
| U1 | Pointed index references are bound by the base chain inside the reverse fixpoint (decisions 1-3, 7, 9); `impactOf` reads the proofs it already receives | `navigation/reverse-calls.ts`, `impact/impact-queries.ts` (`walkInside`), `domain/impact/impact-cuts.ts` (a settled set beside `settledAt`), their tests | Java `Paths.get` and `repository.save` on a Spring Data interface with two `save` homonyms; TypeScript `this.status.isOnline()` on a property member and `this.source.load()` on a private `new DataSource()` field: no `name-only` | `name-only:-` 49 (Java 7: J3, J6; TypeScript 42: T1, T3, T4; T3's 24 assume the relations reader proves the corpus fields, a hypothesis) | `row.get` with two `get` homonyms keeps its cut; a reference proven to bind to the reached declaration becomes an edge, never a retired cut; no cut's reach grows; trace answers byte-identical |
| U2 | `ReceiverMethod.outside`, `ImportOrigins.outsideSupertypes` and the dispatch-attributed set (decisions 4-6) | `ports/import-origins.port.ts`, `adapters/spring/java-receiver-methods.ts`, `adapters/spring/java-name-bindings.adapter.ts`, `adapters/typescript/import-origins.adapter.ts` (`capability-absent`), `adapters/spring/java-dispatch-targets.ts` (the reader, beside the hierarchy it reads), `application/snapshot/language-packs.ts` (the router), `navigation/call-binding.ts`, `navigation/reverse-calls.ts`, `domain/impact/impact-cuts.ts`, trace's mapping of the variant to today's `unproven`, their tests | The Java fixture's `map.get`, `opt.get`, `holder.values().get`, `node.get` against `Api.get`: `complete` | `name-only:-` 168 (J1, J2, J4), fewer where a reached homonym stays attributed: the cut then keeps its place and narrows its reach | `MyMap.get` keeps a cut for `map.get`; a class implementing `java.io.Serializable` keeps the cut of a call on a receiver declared as that interface; an enum owner and a record owner stay attributed without signatures; `T = Object` attributes every owner; a declared generator keeps `D` attributed; trace's corpus answers byte-identical |
| U3 | Library signatures in the reverse families (decision 8): supertype closures, finality, return types through library calls; `--jdk` on `callers` and `impact` | `adapters/spring/java-receiver-methods.ts`, the `outsideSupertypes` reader, `cli` and `mcp` option tables, ADR-0063 decision 7 text, help and AGENTS.md command lines | `names.stream().findFirst().get()` with a declared JDK: no cut; `opt.get()` against `MyMap.get` with a JDK: no cut | 0 on today's manifest, which declares no `--jdk` for these families; up to 22 (J5) once it does | Without a declaration every answer is byte-identical; `map.get` against `MyMap.get` keeps its cut with the JDK |

After U3, about 40 cuts remain: J9 (12, owned by the relations reader), T2 (11, the type checker's), lambda parameters
(J7), static field paths (J8), and a few TypeScript call results and callbacks.

## Alternatives considered

| Option | Verdict |
|---|---|
| Feed every index unresolved reference to `into` | Rejected: measured +1,068 cuts per answer and about 140 s (open question 7) |
| Drop the `name-only` cut for every qualified reference without candidates, as ADR-0041 decision 8 does for recovered calls | Rejected: a false `complete` wherever a repository type below the receiver's type overrides the member (the `MyMap` control) |
| Read ADR-0029 decision 9's external-leaf proof (`declaredTypes`) for Java | Rejected as the owner of this question: its snapshot-wide guard (any lambda, method reference or anonymous class) answers what runs, which trace needs, so it would settle nothing on a repository with lambdas (hypothesis: every corpus backend). The reverse question is asked per reached declaration |
| A list of final or never-implemented JDK types | Rejected: a second vocabulary for what the declared JDK states (ADR-0063) |
| A rule per framework or per repository | Rejected: the classes above are language shapes, and ADR-0071's decision source asks for cross-cutting fixes |
| A `hidden-caller` cut at each declaration an outside dispatch may run | Rejected at implementation (resolved question 1): it repeats every place once per declaration, 1,017 places as 8,558 entries on a corpus repository |

## Consequences

- About three quarters of today's "cannot tell" answers of the reverse families become `complete` or narrower without
  any declared build output. The ledger's `name-only` row is the target row of U1 and U2.
- A Java receiver declared outside the repository becomes an answer of the port. Trace keeps today's reading until a
  record decides otherwise.
- One port member and one `ReceiverMethod` variant are added. Both are additive, with no schema version change.
- Follow-up 2026-11-13 (U1): the references were already bound by `into`; U1 makes the cut read those bindings, so it
  adds no call to the binder. A consumer that must tell `generated` from `unknown` reads `bindCalls`,
  `receiverMethods` and `settleDeclared`, as trace does, because `boundCalls` folds both. A TypeScript member that is
  a property (T1) keeps its cut: the TypeScript pack answers `implementedDeclarations` as `unknown`, so nothing proves
  the reached declaration does not override the bound one. An edge a receiver proof makes retires no cut; only a
  compile-time `declaration` binding the walk follows does. Found and left for its own record: the index holds no
  `implements` edge for a Java generic supertype, so `impact` does not bridge from such an implementation up to the
  interface method.
- Residual risk, accepted under the repository-compiles promise: a runtime class that routes an outside type's member to
  a repository method of the same name by reflection (an invocation handler calling `getMethod(name)` on a target of
  another type) is outside the promise, as reflection is in ADR-0029.

## Resolved questions

Each was open in the proposal; its recommended answer is adopted (decision source above).

1. **Reason of an attributed outside dispatch.** Resolved first as `hidden-caller`, and revised at implementation
   (2026-11-14) to today's `name-only` cut with its reach narrowed. A `hidden-caller` cut is one per declaration and
   repeats every place: measured on the largest Java repository of the corpus, 1,017 marked places became 8,558
   entries across 74 cuts, with no place released. The `name-only` cut of a file lists each place once and reaches
   only the declarations a reference of the file is not bound away from.
2. **Trace reading `outside` as an external leaf.** Resolved: a separate record after U2's corpus result, since a
   trace leaf states what runs and needs the dispatch closure of every implementation of `T`, not only the reached ones.
3. **Static field paths (J8) and lambda parameters (J7).** Resolved: J8 joins U2 only if the receiver bindings
   already type a static field read through a type name; J7 waits for library signatures, because a lambda parameter's
   type is the functional parameter of a library method.
4. **The corpus manifest declaring `--jdk` for Java `callers` and `impact`.** Resolved: yes, with U3, as a manifest
   change outside the repository, so U3's row can move.
5. **The index's name-matched edges on Java value receivers** (`row.get` and `repository.save` resolved into a lone
   homonym). Resolved: a separate record; they are over-reports, and ADR-0029 decision 11 states the TypeScript
   counterpart.
6. **T2, a TypeScript receiver typed by a repository call's structural result.** Resolved: no syntax rule; the type
   checker with a declared `node_modules` owns it (ADR-0037 decision 10).
