# ADR-0111: A write the compiler proves cannot reach a class neither refuses its member proof nor is cited

- Status: Accepted, 2026-11-16, owner
- Decision source: Owner, 2026-11-16, on the `reassignable` causes of ADR-0108, verbatim: "para afinarlo hay que
  preguntarle al compilador de TypeScript si ese objeto puede ser de la clase en cuestión". Translated: to refine it,
  ask the TypeScript compiler whether that object can be of the class in question. Confirmed the same day by "Haz lo
  que recomiendas" (do what you recommend), whose recommendation was checker assignability as the next fix, and by the
  standing instruction of 2026-11-13, "No te detengas más a preguntarme, escoge tú la opción recomendada".
- Related: [ADR-0108](0108-a-call-of-an-own-instance-property-is-proven-at-the-property-and-a-reassignable-one-is-a-cut-that-says-where.md)
  (decision 3 amended), [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md),
  [ADR-0008](0008-typescript-compiler-api-source.md), [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md),
  [ADR-0037](0037-host-declared-build-outputs.md) (the confined host), [ADR-0013](0013-coverage-grows-only-with-evidence.md)

**In short:** A write `x.m = ...` (and a mutation API call naming `m`) whose object the syntax does not place reached the
member `m` of every class, so it refused the proof of that member and was cited in the `reassignable` cause. It now
reaches a class only when the TypeScript checker cannot rule it out: when the class instance type is not assignable to
the declared type of the written object, the write is neither a refusal nor a cited place for that class. Whatever the
checker cannot bound stays as before.

## Context

An evaluation answer listed `pull-to-refresh-indicator.component.ts:186 reassignment` as the cause of a `reassignable`
cut on `this.user.value`, the property `value` of an injected store. Line 186 is `motion.value = target` inside
`private move(motion: Motion, ...)`, where `Motion` is a local interface `{ value: number; velocity: number }`. The
reader cannot place `motion`, so ADR-0108's gates reached the member name `value` on every class of the repository.
9 of the 64 cuts of that answer had the same shape. The reader is purely syntactic; the one question it cannot answer is
the one the compiler answers: which values can a variable hold.

A probe over the 715 non-test TypeScript files of the repository at its pin, with the compiler's own libraries and no
configuration, measured 609 ms to build the program (364 ms with no library) and 55 ms to type the 103 objects of
`x.m = ...` writes, at 147 MB of heap while the program lives. The program is internal to the adapter and kept for one
read.

| Option | Result |
|---|---|
| Keep reaching by name | The cause and the refusal name writes that cannot reach the class; one homonym member kills the property proof of every class |
| Compare the declared type's name with the class | Not TypeScript: it is structural, a class satisfies an interface it never names |
| Match by an annotation the reader finds in the parameter | Misses a variable, a field, an inferred type and an imported one, and decides the language's assignability alone |
| **Ask the checker whether the class instance type is assignable to the receiver's type** | Chosen: structural, exact for the cases the compiler decides, and fail-closed where it does not |

## Decision

1. **A write whose named member `m` has an object with a declared type the class instance type is not assignable to does
   not reach that class.** For that class it neither refuses the proof of `m` nor appears in a `reassignable` cause. It
   applies to a property and to a method, since both proofs read the same writes (ADR-0108 decision 1, ADR-0079). This
   amends ADR-0108 decision 3: the cause names the places that write the property and can reach the class.
2. **The test is assignability, never a name.** The instance type of the class, declared in the repository, is checked
   with the compiler's relation against the declared type of the object (the type of the variable, not the one control flow
   narrows it to); a type the class satisfies structurally refuses the proof and is cited.
3. **Whatever the checker cannot bound keeps today's behaviour.** The write reaches the class when the object is `any`,
   `unknown`, `never`, of a type the program cannot read, a type parameter or inside a generic scope (a type argument the
   caller picks), a union or intersection with such a member or with a member the class is assignable to, or reached
   through a type assertion; and when the class has type parameters or a base class, however far up, the checker cannot
   read. Writes of members no syntax names (`Object.assign` of a spread, a computed key, a prototype) keep reaching every
   class their file names.
4. **One program per read, in the adapter.** It is built on the first question, over the snapshot's TypeScript sources
   outside tests and the compiler's libraries, through the confined host of ADR-0037 with no declared directory, no
   `tsconfig` and the default options (the most permissive assignability, so a class is excluded only when no mode of the
   language accepts it). Every use of the compiler stays in `core/adapters/typescript` (ADR-0008); the lexical binder's
   resolver (ADR-0029) still asks symbols only.
5. **The proof is as strong as the types the program reads.** A type it cannot read, through an installed package or a
   `paths` alias the program is not given, is an unresolved type and falls under decision 3.

## Consequences

- `callers` and `impact` gain proven callers for property and method members whose only homonym writes go through typed
  objects the class cannot be. The corpus gate declares `--expect callers:+`, `--expect impact:±` and
  `--expect-cuts reassignable:-`.
- The read pays one program build, only when a proof asks about a write that carries an object; none for a repository with
  no unplaced named write.
- The metadata port is unchanged; the reader keeps the offsets of each write's object beside its place.

## Not decided here

- Reading the repository's `tsconfig` `paths` for the program, so a type imported through an alias is read; today it
  stays unresolved and the write keeps reaching the class.
- Writes of members no syntax names (decision 3 keeps them): a typed object there is also out of the class's reach, but
  the prototype and passed-instance gates read them as opaque and need their own decision.
- A value typed `any` at the call site that passes an instance into a typed parameter: the checker does not follow it,
  as for any proof drawn from TypeScript's types.
