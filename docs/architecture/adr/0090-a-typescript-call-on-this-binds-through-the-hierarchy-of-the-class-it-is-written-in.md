# ADR-0090: A TypeScript call on `this` binds through the hierarchy of the class it is written in

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md),
  [ADR-0089](0089-an-index-edge-the-receiver-reading-does-not-prove-is-judged-as-the-reference-at-its-place.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** ADR-0089 left TypeScript unmeasured. Measured, the hole exists there: `callers` and `impact` keep an
index-resolved call on `this` with no check at all, and the index binds an inherited or abstract member by its name to a
class the caller's hierarchy does not hold. The member the language binds then answers `complete` without its caller.
Such a call is now read as the receiver reading of a nominal language is: through the class the call is written in and
the classes above it.

## Context

Reproduced on `callers`, each `complete` on both sides:

| The sources | What the index binds `this.save()` to | Answers |
|---|---|---|
| `class Sub extends Store { run() { this.save(); } }` beside a class `Other` with a `save` | `Other.save` | `Store.save` lists no caller; `Other.save` lists `run` as `resolved` |
| the same call in a class whose superclass a package supplies | the `save` of a repository class outside the hierarchy | that `save` lists `run` as `resolved` |

Measured on two TypeScript repositories of the corpus, over 18 `callers` answers (1,350 call edges judged):

| | An application | An admin application |
|---|---|---|
| Calls on `this` into the class they are written in | 469 | 296 |
| Calls on `this` into another class | 19 | 0 |
| of those, into a class of the caller's hierarchy | 15 | — |
| of those, into a class outside it (an abstract member two subclasses implement) | 4 | — |

On the first repository `callers` of an implementation of that abstract member answers `complete` with no caller.

A call on `this` is not a value receiver, so ADR-0036 does not settle it; and the TypeScript pack answers the receiver
reading with `unknown` at every place, so no rule of ADR-0089 reaches it.

## Decision

1. **The TypeScript pack reads a call on `this` or on `super` written in a class member.** The binding is the nearest
   declaration of the member's name in the class the call is written in and up its `extends` chain, as far as the sources
   declare that chain; for `super`, from the class above. An abstract declaration is a binding: its implementations are
   reached as those of an interface member are.
2. **What the reading answers**, with the answers the port already has:

   | The chain | The answer |
   |---|---|
   | A class of it declares the name | That declaration |
   | No class of it declares the name, and it ends at one supertype a package supplies, written as a plain name | An outside receiver of that type |
   | Anything else: a supertype the sources do not settle, a heritage that is an expression or carries type arguments, an interface of the class's own name that may add members, a member the reading cannot place | `unproven`, without candidates |

3. **The verdict of the edge is the one of ADR-0089 decision 1**, which now holds for every language whose pack answers
   the reading: kept or moved to the declaration; not followed under an outside receiver the target cannot run under;
   kept with a `name-only` cut toward the other reached declarations of the name where the reading is `unproven`. An
   `unknown` answer, which the pack keeps for every other receiver, leaves today's verdict.
4. **The bound.** A call on `this` into the class it is written in answers as today. A dependent leaves an answer only
   where the reading proves another declaration or an outside member. The unit reports, on the measured repositories, the
   edges moved, the edges not followed and the `name-only` cuts added; the measurement predicts none of the last.

## Not decided here

- **A value receiver the sources do not type** (`x.m()` where the index names the only `m` of the repository): ADR-0036
  keeps the edge as a visible `name-match` and drops none. Measured: 37 and 29 such edges on the two repositories, of
  which at least 24 and 29 are calls on an object of a package's type. Their proof is the checker with the build output
  a host declares (ADR-0037); a drop by the receiver's root alone is unsound, since a package's generic member may
  return a repository type.
- **The other side of a `name-match` edge**: a declaration the language binds answers without the caller the index bound
  elsewhere. A cut for it marks 208 pairs over 30 edges on one repository, most of them package calls. It waits for the
  recovery of the receivers the repository itself types (a chain through declared field types).

## Alternatives considered

- **A cut on every index edge no reading proves.** Dropped: 208 to 3,385 pairs per repository, and a call whose name is
  unique in the repository gets no cut by it.
- **Run the checker for every `callers` and `impact` answer.** Dropped as the first step: it needs the build output to
  judge a package's types, and the hierarchy of a class is already in the sources. It stays the exact proof where a host
  declares that output.

## Consequences

- The edge reading asks the receiver reading of every pack, no longer of the nominal ones alone; a pack that answers
  `unknown` changes nothing.
- `callers` of an implementation of an abstract member lists the callers of the abstract declaration, where it answered
  `complete` with none.
- Cost: one read of the class chain per call on `this` or `super` an edge is judged for, from syntax the pack already
  holds.
