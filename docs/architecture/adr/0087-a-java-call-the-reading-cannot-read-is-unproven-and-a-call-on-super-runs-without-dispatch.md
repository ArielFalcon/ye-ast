# ADR-0087: A Java call the reading cannot read is unproven, and a call on super runs without dispatch

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md),
  [ADR-0081](0081-a-syntax-error-confined-to-a-body-leaves-its-sources-declarations-read.md),
  [ADR-0086](0086-a-java-call-only-the-class-chain-can-declare-is-selected-under-an-open-hierarchy.md),
  [RFC-0013](../rfc/0013-trace-and-patterns.md)

**In short:** the Java receiver reading answers `unknown` for a call it has nothing to say about, and a family then
keeps the edge the index holds for the call. The index binds a call by its name. Wherever the reading answers `unknown`
for a form whose binding the name does not decide, the answer names a callee nobody proved, with status `complete`.
The reading now answers `unproven` for every such form, and reads the one form among them the sources settle: a call
on `super`.

## Context

Reproduced, each with a fixture in which the name's edge and the language's binding differ:

| Written form | Why the reading answers `unknown` | What the answer says |
|---|---|---|
| `super.m()` where the class declares `m` | `super` is no value the reading types | `trace`: a step in the class's own `m`; `callers` of that `m`: this call, `complete` |
| `super.m()` inside an anonymous class of an unread type | the same | a step in the enclosing class's `m` |
| `X.class.getName()` where a repository type declares `getName` | a class literal is no form the reading types | a step in the repository homonym; a false caller |
| `a.get().get()` | the two calls share one site key (the start of the expression and the name) | one step, in the inner call's method; the second call is neither a step nor a cut |

Measured on the largest Java repository of the corpus: 95 calls on `super`, 58 of them steps today. One reads
`super.update(x)` as the class's own `update`, which makes a cycle that does not exist; thirty name an interface's
method. Three chains of one name in that repository lose their second call.

A call on `super` is not a virtual call (JLS 15.12.4.4): it runs the member the superclass holds, whatever overrides
it below.

## Decision

1. **`unknown` is kept for what a name decides.** For a call whose receiver is an expression other than a name
   (`super`, a parenthesized, cast, conditional or `switch` expression, an array element, a literal, a class literal,
   an object creation), the reading answers a method, a generated member, an outside receiver, candidates or
   `unproven`, never `unknown`. `unknown` stays the answer where another reader of the binding chain owns the form: a
   receiver that is a name, which the name bindings root at a variable, a repository type or a type outside the
   repository (ADR-0079); a call without a receiver for which the search of the language finds no type (the search of
   an anonymous class); and a language whose pack declares the capability absent. The search of a call without a
   receiver is the language's (JLS 15.12.1): the innermost type around the call that has a member of the name, a
   superinterface's static method and a supertype's private method being no member (JLS 8.4.8), then the one
   repository type a single-static-import of the name names (JLS 6.4.1); a call neither settles is `unproven`.
2. **Calls that share a site and read differently are `unproven`.** A site several calls share whose readings differ
   answers `unproven`; calls that share a site and read alike keep that reading. This amends the second exception of
   ADR-0041 decision 3: the record of `store.getCurrency().getCurrency()` is still kept by the alignment, and the
   binding chain then reads it as every other kept record.
3. **A class literal is a receiver outside the repository.** `X.class` is of the platform's class type (JLS 15.8.2):
   the answer is the outside receiver of ADR-0079 decision 4 for that type. In the reverse families an index edge
   whose reading is an outside receiver is judged by ADR-0079 decision 5: where the edge's target cannot run under that
   type the edge is not followed; where it may, or the answer is unknown, today's treatment of the edge stays.
4. **A call on `super` is read in the superclass.** `super.m(...)` is selected among the members of the direct
   superclass of the type `this` denotes there, by the selection of a declared receiver, ADR-0086 included. It is the
   outside receiver, marked not virtual, when that superclass is a type outside the repository the name bindings name
   by its qualified name, or the root class of a class that names no superclass (JLS 8.1.4): no repository declaration
   is its target, so an index edge at the call is not followed. A record, an enum, an enum constant's body and an
   anonymous class of an interface keep `unproven`. It is
   `unproven` when the superclass is neither, or the selection settles no one member. `T.super.m(...)` and
   `Outer.this.m(...)` keep today's `unproven`.
5. **The selected member runs without dispatch.** The answer of decision 4 states that the call is not virtual. `trace`
   places the member as the step and reads no dispatch below it. The reverse families move the index's edge at the call
   to the selected declaration. A declaration that overrides it still reaches the call through the dispatch bridge of
   its contract, as it does for every call of the contract; excluding it there is not decided here.
6. **No reason and no entry kind is added.** A form that was a wrong step becomes the right step or a
   `receiver-unproven` cut; a false caller leaves, with a `hidden-caller` cut where the binding is not proven.
7. **The bound.** A call the reading settled before this decision is settled the same way. A call that was a cut is a
   cut or, on `super`, a step.

## Alternatives considered

- **Close only the forms reproduced.** Dropped: the cause is the meaning of `unknown`, and the next unread form would
  be the next false `complete`.
- **Make `unknown` a cut in every family.** Dropped: for a call without a receiver in a named type the name does
  decide the search, and a pack without the capability must keep the index's reading; both would lose answers that are
  proven today.
- **Answer `unproven` for `super` and stop.** Dropped as the end state: the sources settle the call, and 58 steps of
  one repository would become cuts. It remains the answer where decision 4 selects nothing.
- **Give the site of the port the column of the called name.** Deferred: it removes the shared key of decision 2 at
  its cause, and needs the index to place a call by that column, which is not established.

## Consequences

- The method answer of the receiver reading gains an optional mark for a call that is not virtual; trace's dispatch
  reading and the reverse attribution read it.
- A repository whose calls on `super` named the wrong method loses false cycles in `trace` and false callers in
  `callers` and `impact`.

## Not decided here

- **A call in a source no reader parses.** ADR-0041 decision 3 keeps the index's record of such a source as the index
  has it (its `unread` class), and `trace` answers `complete` through it. The audit behind this record reproduced a
  wrong callee there (a call inside an anonymous class of an unread type, bound to the enclosing class by name). The
  recommended change keeps the steps and adds one cut at each reached body of an unread source; it reverses a decision
  the owner accepted, so it waits for the owner.
