# ADR-0134: A Java overload is selected by the applicability the language defines, and kept as candidates where it is not decidable

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra sesion
  por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente tenga que
  tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less capable
  agent implements it in another session; everything must be explicit, leaving almost no room for that agent to take
  important decisions or invent implementations). The decision serves this sentence of the request of the same day:
  "Mejorar la calidad de analisis de lo que ya existe, corregir problemas" (improve the quality of the analysis that
  exists, fix problems).
- Related: [RFC-0043](../rfc/0043-one-typed-expression-reading-settles-java-receivers-and-arguments.md) (the design),
  [RFC-0024](../rfc/0024-receiver-typed-settlement.md),
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md) decision 5,
  [ADR-0084](0084-a-calls-argument-count-excludes-the-homonyms-that-cannot-take-it.md),
  [ADR-0086](0086-a-java-call-only-the-class-chain-can-declare-is-selected-under-an-open-hierarchy.md),
  [ADR-0132](0132-one-owner-types-a-java-expression-and-every-reader-of-a-receivers-or-an-arguments-type-asks-it.md)
- Amends: the selection rule the receiver reading documents ("a member whose stated parameter types equal the
  arguments' settled signature binds it", `src/core/adapters/spring/java-receiver-methods.ts:72-74`)

**In short:** among the declarations of one name that a call's argument count admits, the one the call binds is
selected by the three phases of JLS 15.12.2 over the argument types the typed-expression owner proves. Each argument is
applicable, not applicable or not decided; a selection is made only when every other candidate is proven not
applicable or proven less specific, and otherwise the candidates are the answer. One module owns the rule.

## Context

Verified at commit `62a41b28a`:

| Fact | Evidence |
|---|---|
| The receiver reading selects among same-arity members only by an exact match of stated parameter types, or when every member states one signature | `selectAmong`, `exactCandidate`, `java-receiver-methods.ts:1157-1186` |
| The argument reading types four literal kinds and a local with a stated non-generic type; a field, a call result, a construction, a cast or a generic type leaves the whole signature unread | `readArgumentSignature`, `src/core/adapters/spring/java-symbols.ts:1080-1115` |
| No boxing, widening or subtype applicability is read, and a member with variable arity withholds every selection | `java-receiver-methods.ts:1107`, `:1144`, `:1214` |
| The data-effect reading repeats the selection with its own calls to the same three functions and answers "unplaced" unless exactly one overload matches | `src/core/adapters/spring/data-effects.adapter.ts:86-97` |
| Two more readings filter overloads by argument count alone | `declared`, `src/core/adapters/spring/java-library-calls.ts:375-387`; `lenientSelections`, `src/core/adapters/spring/java-call-site-owner.ts:192-229` |

| Option | Verdict |
|---|---|
| Keep the exact match and add one conversion at a time where a cut is observed | Rejected: a chain of special cases; each consumer would grow its own |
| The language's own phases with a three-valued applicability, in one module | Chosen |
| Select the only candidate that is not proven inapplicable | Rejected: a candidate whose applicability is not decided may be the one the compiler selects in an earlier phase |

## Decision

1. **The owner.** `src/core/adapters/spring/java-overloads.ts` decides which of several declarations of one name a
   call's arguments select. The receiver reading, the data-effect reading, the library-call reading and the call-site
   owner ask it; none compares argument types itself. A fitness test holds it
   (`src/core/adapters/spring/java-typing.single-rule.test.ts`).
2. **Applicability has three values.** For an argument type and a parameter type: `yes`, `no` or `undecided`. The
   conversions read are the ones JLS 5.3 allows in an invocation context: identity, widening primitive conversion
   (JLS 5.1.2), widening reference conversion by the declared hierarchy of the repository and the declared library
   signatures, boxing and unboxing between the eight pairs of JLS 5.1.7 and 5.1.8, and variable arity. An argument whose
   type the typed-expression owner answers `unknown` for, a parameter that is a type variable, and a subtype question
   over a hierarchy that is open or not held are `undecided`. A parameter that states type arguments is decided by its
   erasure only towards `no`: an argument whose erasure is not below the parameter's erasure is not applicable, and one
   that is below it is `undecided`.
3. **The phases are the language's.** Phase 1 allows no boxing and no variable arity (JLS 15.12.2.2), phase 2 adds
   boxing and unboxing (15.12.2.3), phase 3 adds variable arity (15.12.2.4). A phase is reached only when every
   candidate is proven not applicable in the phases before it.
4. **When a member is selected.** In the first phase in which a candidate is applicable with every argument `yes`: if
   another candidate is `undecided` in that phase, nothing is selected; otherwise the most specific of the applicable
   ones (JLS 15.12.2.5) is selected when each of its parameter types is proven below the corresponding one of every
   other applicable candidate. Declarations that state one signature are one candidate, and the member among them is
   the one the receiver reading already picks (the type's own, else the nearest up its class chain). One case needs no
   verdict on the others: a candidate whose parameter types are the arguments' own types is selected in phase 1, since
   any other candidate applicable in that phase takes each argument by a conversion from that same type and is
   therefore less specific. Decision 8 rests on it.
5. **When nothing is selected.** The answer is the candidates that are not proven inapplicable in every phase. A
   consumer treats it as it treats today's unselected overloads: the receiver reading answers `unproven` with those
   candidates, the data-effect reading answers "unplaced".
6. **Variable arity no longer withholds a closed hierarchy.** A member with variable arity is a candidate of phase 3.
   The guards that depend on what an unread supertype may declare (ADR-0086 decision 3) are unchanged: under an open
   hierarchy a call with arguments is not selected.
7. **Nothing is selected by elimination against an unread declaration.** Every guard of the selection that exists today
   holds: a private member outside its class, a member whose reach from the call's file is unknown, a static member
   reached through an instance, a source with a call-rewriting annotation.
8. **The bound.** A call selected before this decision is selected the same way: an exact match is the applicable
   candidate of phase 1 that is most specific.

## Consequences

- Calls that pass a field, a call result, a construction, a subclass instance or a boxed value select their overload.
- The seven `effect-unplaced` cuts of the baseline ledger are candidates to move; the measurement of RFC-0043 unit U0
  says how many are overloads.
- `readArgumentSignature` is deleted; `readSignature` and `sameSignature` stay for the override reading, which
  compares two declarations and not a call.

## Not decided here

- Applicability of a lambda or a method reference argument beyond "not decided" (JLS 15.12.2.1 potential
  compatibility): tracked in RFC-0043 "Not covered".
- Inference of a generic method's type arguments: out of scope (ADR-0132 decision 3).
