# ADR-0133: A call on a receiver proven outside the repository that no repository declaration can run under is an external call

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra sesion
  por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente tenga que
  tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less capable
  agent implements it in another session; everything must be explicit, leaving almost no room for that agent to take
  important decisions or invent implementations). The decision serves this sentence of the request of the same day:
  "Mejorar la calidad de analisis de lo que ya existe, corregir problemas, optimizar recursos y aprovechar mejor los
  recursos que ya tiene disponible" (improve the quality of the analysis that exists, fix problems, optimise resources
  and make better use of the resources already available).
- Related: [RFC-0043](../rfc/0043-one-typed-expression-reading-settles-java-receivers-and-arguments.md) (the design),
  [RFC-0013](../rfc/0013-trace-and-patterns.md) rules R5, R6 and R8,
  [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md) decision 9,
  [ADR-0042](0042-completeness-is-relative-to-the-question.md),
  [ADR-0064](0064-a-supertype-outside-the-repository-redefines-no-java-name.md),
  [ADR-0073](0073-a-classpath-the-host-declares-is-a-library-signature-source.md),
  [ADR-0075](0075-the-core-names-no-language-or-framework.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md) decisions 4 and 5 and resolved
  question 2,
  [ADR-0087](0087-a-java-call-the-reading-cannot-read-is-unproven-and-a-call-on-super-runs-without-dispatch.md)
  decisions 3 and 4, [ADR-0132](0132-one-owner-types-a-java-expression-and-every-reader-of-a-receivers-or-an-arguments-type-asks-it.md)
- Supersedes: the last sentence of ADR-0079 decision 4 ("Trace reads the variant as it reads today's `unproven`
  answer"), which ADR-0079 resolved question 2 left to "a separate record"; this is that record

**In short:** `trace` stops reading an outside receiver as `unproven`. A call the receiver reading answers `outside`
for is an external call when it is not virtual, or when no repository declaration of the called name can run under
that type and the language pack proves that no function value can be the receiver. Anything less keeps the cut, with
its candidates narrowed to the declarations that may still run.

## Context

Verified at commit `62a41b28a`:

| Fact | Evidence |
|---|---|
| The receiver reading answers `outside` with a qualified type name for a receiver declared with a type outside the repository, a class literal and `super` over an outside superclass | `ReceiverMethod`, `src/core/ports/import-origins.port.ts:340`; `outsideReceiverOf`, `src/core/adapters/spring/java-receiver-methods.ts:913` |
| `trace` maps that answer to `unproven` before it decides anything | `unprovenOutside`, `executed`, `src/core/application/trace/trace-walk.ts:304-306`, applied at `:693` and `:746` |
| The call is then a cut that lists every declaration of the name in scope (`receiver-unproven`), or none (`callee-unknown`) | `settleDeclared`, `src/core/application/navigation/call-binding.ts:336-348`; `settleByName`, `trace-walk.ts:540-550`; `callCut`, `trace-walk.ts:991` |
| `callers` and `impact` already ask, per declaration, whether it may run under an outside type | `mayRunUnder`, `call-binding.ts:371-382` (ADR-0079 decision 5); `edge-targets.ts:374-376` |
| A static call on a type name outside the repository and a construction of an outside class are rooted by `rootOrigins` only when the strict reading binds the name to nothing; inside a class with a supertype outside the repository the name is `unsettled` and the call is a cut | `chainRootOf`, `src/core/adapters/spring/java-name-bindings.adapter.ts:118-123`; pinned at `java-receiver-methods.test.ts:175-179` |
| The other proof of a Java external leaf (`declaredTypes`) is refused for the whole snapshot by one lambda, method reference, anonymous class or outside supertype | `subtypedTypes`, `src/core/adapters/spring/java-declared-types.ts:85-97` |
| On the baseline ledger `trace`/java holds 129 `receiver-unproven` and 62 `callee-unknown` cuts | corpus report of 2026-11-17, 118 answers, 436 cuts |

An external call states what runs: nothing of the repository. ADR-0079 resolved question 2 named what the proof needs:
"the dispatch closure of every implementation of `T`, not only the reached ones".

| Option | Verdict |
|---|---|
| Every `outside` answer is an external call | Rejected: false where a repository class below the type overrides the member (a class extending a library map and overriding `get`) or a function value is the receiver |
| Keep the snapshot-wide guard of `declaredTypes` | Rejected: one lambda anywhere refuses every proof; the question is per call |
| Per call: not virtual, or no repository declaration of the name may run under the type and no function value can be the receiver | Chosen |
| Only receivers whose library type is a class | Rejected: a receiver declared with a collection interface would never leave its cut; decision 4 states the assumption that replaces it and its risk |

## Decision

1. **An outside receiver is an answer `trace` reads.** `trace` no longer maps `outside` to `unproven`. The rules
   below decide the call; they are written against the port's answer and name no language (ADR-0075).
2. **A call that is not virtual leaves.** An `outside` answer marked `exact` is an external call. The language pack
   marks it for: a call on `super` over an outside superclass (ADR-0087 decision 4, unchanged); a static call through a
   type name the typed-expression owner proves outside the repository; a construction `new T(...)` without a class
   body of such a type; a constructor reference `T::new` of such a type; and a call without a receiver inside an
   anonymous class of an outside type `T` whose body declares no method of the name, when the declared signatures hold
   `T` and every type above it and state a member of the name (the anonymous class is final, so what runs is the member
   it inherits).
3. **A virtual call leaves when nothing of the repository can run.** An `outside` answer not marked `exact` is an
   external call when both hold:
   - **Name closure.** Every declaration of the called name that a value can be, in scope from the call's file, is
     proven unable to run under the type by `mayRunUnder` (ADR-0079 decision 5), and every source that declares the
     name in a value position holds only such declarations: each callable of the name its syntax states is one of
     them. A declaration `mayRunUnder` keeps, or a callable the index does not place, keeps the cut.
   - **No function value.** The pack marks the answer `noFunctionValue`: the declared signatures hold the type and
     every type above it, and either the type is a class, an enum or a record other than the language's root type, or
     it is an interface and the member the call names is not its single abstract method.
4. **The assumption behind "no function value", scoped.** For an interface `T` the declared signatures hold, the engine
   assumes that no type outside the repository narrows `T` into a functional interface whose single abstract method
   is a member the signatures do not state as `T`'s single abstract method: no sub-interface outside the repository
   gives defaults to the other abstract methods of `T`, and none makes a default method of `T` abstract. A repository
   interface that does either is a repository declaration of the name and is read by the name closure. The residual:
   a library interface that narrows another, with a repository lambda converted to it and passed where `T` is
   declared, would run that lambda under a call this rule reports as external. The lambda's body is still a deferred
   step where it is written (RFC-0013 R8).
5. **Without declared signatures a virtual call keeps its cut.** A type the signatures do not hold (no JDK declared for
   the file, or a library that is not the JDK) is never marked `noFunctionValue`. Its call is a cut whose candidates
   are the declarations the name closure keeps; with none left it is a cut with no candidate. RFC-0043's last unit
   counts these cuts to schedule ADR-0073.
6. **What an external call is listed under.** The pack states the module of the type (for Java, its package); the
   call is `{ kind: "import", module, name }`, the shape a rooted call already has. An answer without a module is
   listed `unnamed`.
7. **A reference to an outside member runs nothing where it is written.** A method reference the reading answers
   `outside` for is dropped, as a `generated` answer is today, when decision 2 or 3 holds; otherwise it keeps its cut.
8. **The reverse families.** `callers` and `impact` read the new `exact` answers as they read `super` today
   (ADR-0087 decision 4): the index edge at the call is not followed and its reference produces no `name-only` cut.
   For a virtual call nothing changes: ADR-0079 decision 5 already attributes it.
9. **R6 is not widened.** The closed-world rule of RFC-0013 R6 and its documented limitation stay as they are; this
   decision adds a proof beside it and removes none.
10. **The bound.** A call that is a step today is the same step. A call that is an external call today stays one. A
    cut becomes an external call, or a cut whose candidates are a subset of today's.

## Consequences

- The cuts of `trace` on JDK collections, strings, optionals and streams leave when a JDK is declared; the corpus
  manifest declares `--jdk` on few queries today, so the ledger moves with the manifest (RFC-0043 unit U0).
- Constructions and static calls of library types leave without any declared signature, including inside a class whose
  supertype the snapshot does not hold.
- `ReceiverMethod`'s `outside` variant gains two optional fields (`noFunctionValue`, `module`). Additive; no schema
  version changes.
- The `outsideSupertypes` reader gains the library closure ADR-0079 decision 5 already describes, so a declaration
  whose owner implements an unrelated library interface stops keeping the cut when signatures are declared.

## Not decided here

- Tightening RFC-0013 R6's limitation for a receiver typed with a library functional interface: not in this record.
- Library signatures beyond the JDK: ADR-0073.
- TypeScript: its pack never marks `noFunctionValue`; RFC-0044 owns its receivers.
