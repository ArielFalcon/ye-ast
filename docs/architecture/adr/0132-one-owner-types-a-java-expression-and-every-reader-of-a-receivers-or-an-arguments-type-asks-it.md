# ADR-0132: One owner types a Java expression, and every reader of a receiver's or an argument's type asks it

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra sesion
  por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente tenga que
  tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less capable
  agent implements it in another session; everything must be explicit, leaving almost no room for that agent to take
  important decisions or invent implementations). The decision serves this sentence of the request of the same day:
  "buscar que algoritmos de base tienen mas ROI para cubrir 1 o mas areas a la vez" (find the base algorithms with the
  best return to cover one or more areas at once).
- Related: [RFC-0043](../rfc/0043-one-typed-expression-reading-settles-java-receivers-and-arguments.md) (the design),
  [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md) decision 5,
  [ADR-0051](0051-an-answer-never-hides-what-the-engine-knows.md) decision 7,
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [ADR-0063](0063-a-jdk-the-host-declares-is-the-library-signature-source.md),
  [ADR-0064](0064-a-supertype-outside-the-repository-redefines-no-java-name.md),
  [ADR-0075](0075-the-core-names-no-language-or-framework.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md),
  [ADR-0087](0087-a-java-call-the-reading-cannot-read-is-unproven-and-a-call-on-super-runs-without-dispatch.md),
  [ADR-0119](0119-the-receiver-methods-of-a-java-file-are-kept-by-the-questions-they-asked-over-the-names-the-sources-write.md)
- Amends: ADR-0064 decision 4 (who reads the assumption), ADR-0087 decision 1 (the expression forms the receiver
  reading answers `unproven` for)

**In short:** the type of a Java expression is decided by one module of the Java adapters, over the repository's
declarations and the library signatures the host declared. The receiver reading, the overload selection, the
library-call reading of the function-value proof and the data-effect selection ask it and type nothing themselves. Its
answer is a sum type whose `unknown` member always names its cause, so "not typed" never reads as a type.

## Context

Verified at commit `62a41b28a`:

| Fact | Evidence |
|---|---|
| The receiver reading types a receiver in its own function: none or `this`, a call that names a repository method, or a name with an `annotated` binding | `receiverOf`, `src/core/adapters/spring/java-receiver-methods.ts:881-904` |
| A second typer reads library signatures, parentheses, casts, constructions and chains, and serves only the function-value proof | `receiverOf`, `writtenType`, `variableOrTypeName`, `chainOf`, `src/core/adapters/spring/java-library-calls.ts:176-362` |
| A third reading types the qualifier of a method reference | `referenceOf`, `java-receiver-methods.ts:1045-1068` (lines 1053-1058) |
| A fourth reading types call arguments: four literal kinds and a local with a stated non-generic type | `readArgumentSignature`, `src/core/adapters/spring/java-symbols.ts:1080-1115` |
| Two modules resolve a local variable's declaration: the flow-scoped owner and a member-wide scan | `variableInScope`, `src/core/adapters/tree-sitter/java-declared-variables.ts:102`; `declarationsOf`, `java-library-calls.ts:308-335` |
| The declared JDK reaches the dispatch reading and not the receiver reading | `src/core/adapters/spring/java-name-bindings.adapter.ts:58-59` |
| The receiver reading answers `unproven` for a receiver that is a parenthesized, cast or conditional expression, an array element, a literal or an object creation | `receiverMethodOf`, `java-receiver-methods.ts:240-242`; ADR-0087 decision 1 |

| Option | Verdict |
|---|---|
| Extend `receiverOf` of the receiver reading with each missing form | Rejected: a fifth copy of the rules the library-call reading already holds, and the two would drift |
| Make the library-call reading the owner as it is | Rejected: its answer is `Receiver | undefined`, which gives no cause, and its local-variable scan is a copy of the scoping owner |
| One new module that the existing readings are moved into and ask | Chosen |
| A compiler or a language server | Rejected by ADR-0010 and ADR-0073's context: nothing of the repository is run and no JVM is added |

## Decision

1. **The owner.** `src/core/adapters/spring/java-expression-types.ts` decides the type of a Java expression, of a
   written type and of a declared variable. No other module under `src/core/adapters` names an expression node kind to
   derive a type from it. A fitness test holds it (`src/core/adapters/spring/java-typing.single-rule.test.ts`).
2. **The answer is a sum type.** A repository type with the type arguments that are settled; a library type by its
   qualified name with its basis (`declared-jdk` when the declared signatures hold it, `named` when only its identity
   is proven); a primitive; an array; `null`; a type name (the expression names a type, not a value); or `unknown`
   with one cause of a closed set. No consumer receives `undefined` for "not typed".
3. **What proves a type.** Only a declaration the sources write (a local, parameter, field, record component, method
   return type, constructor), a literal, the language's own typing rule for the form (JLS chapter 15), or a member
   signature the declared library signatures state, with the type-variable substitution those signatures and the
   receiver's written type arguments give. Nothing is inferred beyond that: a type that needs the compiler's inference
   (a method's own type variable that no argument fixes, a diamond, a poly expression) is `unknown`.
4. **A local variable is resolved by the scoping owner.** The declaration of a simple name is the one
   `variableInScope` (`java-declared-variables.ts`) answers; the member-wide scan `declarationsOf` of
   `java-library-calls.ts` is deleted.
5. **Names are read under ADR-0064, by this owner.** ADR-0064 decision 4 is amended: the reader of
   `JavaProject.importedTypeSources` is the typed-expression owner, and every reader that asks the owner inherits the
   assumption. Its scope is ADR-0064's, unchanged: a simple name that no declaration of the repository binds, bound by
   a single-type import or resolved to a `java.*` type the declared JDK holds. The risk is the one ADR-0064 decision 5
   states.
6. **The readers that ask.** The receiver reading (`receiverOf`, `outsideReceiverOf`, `referenceOf`,
   `creationOf`), the overload selection (ADR-0134), the library-call reading (`libraryParameterClasses`) and the
   data-effect selection ask the owner. The receiver reading keeps deciding the member a typed receiver names; the
   owner never selects a member except to read the return type of a call that is itself a receiver or an argument.
7. **A repository type that types a receiver is a class, an interface, a record or an enum.** An enum whose constants
   declare no class body types a receiver like a class whose hierarchy is closed below it: a call on it names the enum's
   member. An enum with a constant that declares a class body keeps today's `unproven`, since that body may override
   the member. An annotation type keeps `unproven`.
8. **A construction is an exact receiver.** A receiver that is `new C(...)` without a class body, read through
   parentheses, is an instance of exactly `C` (JLS 15.9), so the member the selection names is marked not virtual when
   it has a body.
9. **Library signatures are an input of the receiver reading.** `libraries` reaches `createJavaReceiverMethods`, and
   the digest of the signatures used for a file is part of the subject its kept derivation is stored under
   (ADR-0119). Without declared signatures every answer that needs none is unchanged.
10. **ADR-0087 decision 1 is amended.** A receiver that is a parenthesized, cast or conditional expression, an array
    element, a literal, an object creation or a class literal is read by the owner; `unproven` is kept where the owner
    answers `unknown`.
11. **The core does not change.** The owner lives behind `ImportOrigins`; no type of `src/core/domain`,
    `src/core/application` or `src/core/ports` names a Java construct (ADR-0075).

## Consequences

- One rule per expression form, tested once in the owner's own test file; the readers' tests keep only their wiring.
- The function-value proof (ADR-0044 decision 5) reads pattern variables and flow-scoped locals as the scoping owner
  does, so it may release vetoes the member-wide scan withheld; the corpus gate states the difference.
- The receiver reading types call results through library members, constructions, casts and conditionals, which are
  the largest receiver shapes of the cut ledger (RFC-0043 "Problem").
- The slot `java-receiver-sites` changes its subject, so its pinned version is bumped (ADR-0119 consequence 4).

## Not decided here

- When a call on a receiver typed outside the repository leaves it as an external call: ADR-0133.
- How one of several overloads is selected: ADR-0134.
- Signatures of libraries other than the JDK: ADR-0073, scheduled by RFC-0043's last unit.
