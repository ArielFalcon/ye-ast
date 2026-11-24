# ADR-0135: One owner types a TypeScript receiver in a fixed order of proofs, and every family asks it

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra sesion
  por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente tenga que
  tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less capable
  agent implements it in another session; everything must be explicit, leaving almost no room for that agent to take
  important decisions or invent implementations). The decision serves this sentence of the request of the same day:
  "Identificar los huecos de analisis de codigo, lo que el motor ignora, tanto de base como en sus implementaciones de
  java + spring y ts + angular. Identificar estos huecos y valorar cuales se pueden corregir, buscar que algoritmos de
  base tienen mas ROI para cubrir 1 o mas areas a la vez" (identify what the engine ignores, in the base and in its
  Java + Spring and TypeScript + Angular implementations, judge which gaps can be fixed, and find the base algorithms
  with the best return to cover one or more areas at once).
- Related: [RFC-0044](../rfc/0044-one-receiver-typing-reading-for-typescript.md) (the design),
  [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md) decisions 9 and 11,
  [ADR-0046](0046-a-call-binds-by-its-receivers-type.md) decision 4,
  [ADR-0075](0075-the-core-names-no-language-or-framework.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md) decisions 4, 5 and 7,
  [ADR-0090](0090-a-typescript-call-on-this-binds-through-the-hierarchy-of-the-class-it-is-written-in.md),
  ADR-0108, ADR-0133 (the external-call rule, proposed beside this one),
  [ADR-0136](0136-the-type-checker-types-a-typescript-receiver-over-the-repositorys-own-sources-only-where-its-answer-names-a-repository-declaration-or-a-language-global.md)
- Supersedes: ADR-0079 decision 7 ("TypeScript adds no rule") for a receiver other than `this` and `super`; the
  sentence of ADR-0133 "TypeScript: its pack never marks `noFunctionValue`" (decision 6 below states when it does).
  ADR-0029 decision 9 is not superseded: `declaredTypes` keeps its rule; decision 7 below extends its accepted
  limitation to every declared answer of the owner

**In short:** one module of the TypeScript adapters decides the type of a member call's receiver, by the first of
four proofs that settles, and answers through the receiver reading every family already asks. `trace` stops typing
receivers by itself. A value's class is trusted exactly; a declared type is trusted only as far as no repository
declaration of the member may run under it.

## Context

Verified at commit `62a41b28a`:

| Fact | Evidence |
|---|---|
| The TypeScript receiver reading answers only `this.m()` and `super.m()`; every other receiver is `unknown`, `capability-absent` | `accessOf` and `UNKNOWN`, `src/core/adapters/typescript/this-receiver-methods.ts:196`, `:22` |
| Seven readers type a receiver, each for one consumer | `localReceivers` (`function-value-calls.ts:32`); `declaredTypes` (`import-origins.adapter.ts:265`); `createThisReceiverReading`; the relations' origins (`angular-metadata.adapter.ts`); `createReceiverTypes` (`receiver-types.ts:26`); `createTypeBindings`; the annotated and constructed blocks of `trace-walk.ts:712-735` |
| `trace` applies type rules after the base binding answered, which ADR-0046 decision 4 forbids | `settleReceiver`, `trace-walk.ts:605-633`, against `proven`, `call-binding.ts:190-212` |
| The base binding asks the receiver reading for an unplaced receiver only in a nominal language | `bindCalls`, `call-binding.ts:272` |
| The guard of `declaredTypes` is keyed by the type's own name, so a repository class under a package type that extends the declared type is not seen | `subtypedTypes().has(typeKey(type))`, `import-origins.adapter.ts:275` |
| On the baseline ledger `trace`/typescript holds 31 `receiver-unproven` (22 `capability-absent`) and 8 `callee-unknown` cuts; `callers` and `impact` hold 38 typescript `name-only` cuts | corpus report of 2026-11-17 |

| Option | Verdict |
|---|---|
| Extend each of the seven readers to the forms it misses | Rejected: seven places for one fact, and each family would still see only its own reader |
| A new port method that returns receiver types to the application | Rejected: the application would decide language rules, and three families would gain a second question for a fact the receiver reading already carries |
| One adapter owner behind the existing receiver reading | Chosen |
| Type every receiver with the type checker | Rejected as the first proof: ADR-0018's cost, and nothing to say about a package without its declarations. Kept as the last proof under ADR-0136 |

## Decision

1. **One owner.** `src/core/adapters/typescript/receiver-typing.ts` is the only module that turns a TypeScript
   receiver expression into a type. Its answers are a closed sum: a repository declaration, a package export by
   module and name, a language global, a framework value with its listed members, or `unknown` with one cause of a
   closed list. No other module of the TypeScript adapters, and no module of the application, derives the type of
   a receiver; the readers it calls (the source reader's bindings, the type-node reader, the heritage reader, the
   framework table, the sources-only program) each keep their single fact.
2. **A fixed order.** The owner answers by the first level that settles: (P1) the value: a construction, a
   literal, or a binding whose every store holds one kind and whose value stays in its function and is not written
   through; (P2) the declared type: the declaration's annotation, or without one the type of its initialiser;
   (P3) a framework value factory listed by a composed framework plugin; (P4) the type checker over the
   repository's own sources, as ADR-0136 bounds it. A later level is asked only when every earlier one refuses.
3. **Value and declaration are different proofs.** An answer from P1 states the class of the object itself and is
   marked exact. An answer from any other level states what the declaration promises and is never exact. A
   reassigned binding keeps its declared type and loses its value proof. A type assertion is no proof at either
   level.
4. **Every family asks it through the receiver reading.** The owner answers behind `ImportOrigins.receiverMethods`:
   an outside type as `outside`, a nominal repository class with a wholly proven hierarchy as `unproven` with its
   candidates, anything else as `unknown`. The base binding asks the reading for a receiver its own proof placed
   nothing for, in any language; an index edge called on a value receiver bound only by name asks it too. The rules
   in the application name no language (ADR-0075).
5. **`trace` keeps no type rule of its own.** `trace` settles an outside receiver by ADR-0133's rule (exact, or no
   repository declaration of the name able to run and no function value). Its own reading of an annotated or a
   constructed receiver as a type outside the repository is deleted. The step at a nominal repository class
   (ADR-0029 decision 11) stays.
6. **When the TypeScript pack marks "no function value".** For every member except `call`, `apply` and `bind`: only
   those run the receiver when it is a function. The object-literal and assigned-property cases are held by
   ADR-0133's name closure, not by the mark.
7. **The trust in a declared type, stated.** A declared outside type is trusted against a repository class that
   declares the member, has no supertype outside the repository and reaches the receiver only through structural
   assignability, `any` or a cast. This is the limitation ADR-0029 accepts for an annotated receiver; it now holds
   for every declared answer and for no other case. A repository class with any supertype outside the repository
   keeps the call open.
8. **Framework values are data.** What a framework factory returns, and which members that value offers, is one
   table owned by the framework's plugin and read through the framework plugin port. The owner reads the composed
   table; no TypeScript adapter names a framework's factory.
9. **The heritage refusal stays, scoped where provable.** An unproven heritage entry keeps refusing every
   outside-supertype answer of the snapshot, except an entry that is a member path of a package the repository does
   not write through: that one is an outside supertype of the class that writes it and of no other.
10. **The bound.** A call that is a step today stays that step. A cut becomes an external call, a step at the one
    body a nominal hierarchy proves, or a cut whose candidates are a subset of today's. An external call that
    `trace`'s deleted rules reported may become a cut where a repository declaration of the name may run under the
    type or a source names the member in a form the index does not place.

## Consequences

- `callers` and `impact` stop listing a homonym as `name-only` where the receiver's type is outside the repository
  and the homonym's class has no outside supertype.
- `trace` reports external calls for receivers typed by an unannotated initialiser, a public field, a call result
  of a repository function and a framework value, which no reader typed before.
- `ReceiverMethod`'s `outside` variant gains the optional `global`; `FrameworkValueCells` gains the optional
  `typeOf`. Additive; no schema version changes.
- Some external calls of today become cuts (decision 10): the previous rule did not see a transitive outside
  supertype nor an object literal that supplies the member.
- In an application with many classes that implement a package interface, their homonym members stay candidates:
  without the package's declarations nothing proves that interface unrelated to the receiver's type.

## Not decided here

- Reading a package's declarations to narrow decision 7 and the last consequence: ADR-0037 owns the declared
  directory.
- The provider graph, template bindings and store dispatch: RFC-0044 "Not covered".
- The cause shown on a cut the owner does not settle: RFC-0042.
