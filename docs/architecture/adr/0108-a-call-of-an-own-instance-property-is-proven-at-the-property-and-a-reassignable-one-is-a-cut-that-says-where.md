# ADR-0108: A call of an own instance property is proven at the property, and one a write may have replaced is a cut that says where

- Status: Accepted, 2026-11-16, owner
- Decision source: Owner, 2026-11-16, on whether property member evidence (W5b) applies or is dropped, verbatim: "Lo
  que realmente determina si se puede aplicar o se descarta es: con que fiabilidad podemos determinar hasta cuando
  seguir el rastro y cuando se reasigna (si es alta, cortamos justo ahi, si es baja se puede marcar la llamada y
  enriquecer el resultado con "puede haberse reasignado" y si sabes donde lo agregamos)". Translated: what really
  decides whether it applies or is dropped is how reliably we can tell how far to follow the trail and when it is
  reassigned; if that is high, cut exactly there; if it is low, mark the call and enrich the result with "may have been
  reassigned", and, if you know where, add it. Standing instruction of 2026-11-13, "No te detengas más a preguntarme,
  escoge tú la opción recomendada" (stop asking me; pick the recommended option), for the choices below.
- Related: [ADR-0025](0025-template-member-calls-join-as-component-calls.md) (decision 1 superseded),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md) (unit U1 amended),
  [ADR-0042](0042-completeness-is-relative-to-the-question.md) (decision 1: one reason per emitter situation),
  [ADR-0013](0013-coverage-grows-only-with-evidence.md), [ADR-0074](0074-trace-walks-every-body-of-a-closed-set-and-a-cut-names-its-cause.md)
  (`cause` places)

**In short:** A call through an injected field or local to a unique own instance property of the class it holds
(`save = () => ...`, `items = computed(...)`, `this.store.hasData()`, a template `api.archive()`) is proven at the
property's declaration, under the gates that prove a method. The proof stops there: the initializer is not followed.
When a gate refuses it because code may have replaced the property, the call is no longer a plain `name-only` cut: it is
a `reassignable` cut, whose `cause` names the places that write the property when the reader places them.

## Context

ADR-0025 decision 1 left callable fields out of the template reader and the member proofs covered methods only, so a call
through a property stayed a `name-only` cut of every homonym. ADR-0079 T1 counted 25 such places in 16 cuts and its
follow-up kept the cut for a property member; `this.store.hasData()` on a signal-holding property is the common shape.

The proof gates already detect, for a method, the ways its value may change: a write `obj.p = ...`, `this.p = ...`
anywhere, `delete`, `Object.assign`, `Object.defineProperty`, `Reflect.set` (also through `as any`), a subclass that
shadows the member, a template write, a provider that substitutes the class, and an instance that escapes. A property is
different from a method in one respect only: its value is assigned at run time, so those risks are real for it rather
than rare. That reliability, not the kind of member, is what decides whether the call can be proven (the owner's rule).

| Option | Result |
|---|---|
| Keep callable fields unproven (ADR-0025 decision 1) | Every property call stays a name-only cut of every homonym, whether or not anything writes the property |
| Prove the property under the method gates and refuse silently | Removes the noise, but a refused call is again a plain name-only cut that says nothing about why |
| **Prove it under the gates; a refused call is a cut that says it may have been reassigned, and where** | Chosen: high reliability cuts at the property, low reliability marks the call |

## Decision

1. **A call of an own instance property is proven at the property.** The member proof of ADR-0025 decision 2 admits a
   unique, non-static, undecorated own instance property of the receiver class, as it admits a method, under the same
   gates: the provider, mutation, subclass and escape risks, scoped to the receiver and member they reach. This replaces
   ADR-0025 decision 1's exclusion of callable fields. A template call of such a property joins as a call of the
   component like a method's.
2. **The proof stops at the property declaration.** The member the proof names is the property; its initializer is not
   followed, whatever it holds (an arrow function, `computed(...)`, a reference to another function). The call is a
   dependence of the property, never of what the initializer references.
3. **A property whose proof a gate refuses is a `reassignable` cut.** A call whose property member the proof gates
   refuse, on the receiver and member they reach, is no proof. Its `name-only` place moves to a cut with the reason
   `reassignable`, the same anchor and the same reach (ADR-0042 decision 1: one emitter situation, one reason; the
   outline's `use-unproven` is not reused). The cut's `cause` is the sorted places that write the property, each
   `path:line reassignment`, when the reader places the write. A gate that has no place (a provider that replaces the
   token, a subclass that shadows it, an instance that escapes, a write in a template, a write the reader cannot place
   in any file) leaves the cause out; the cut still says the property may have been replaced. A method refused by the
   same gates stays `name-only`.
4. **The answer says so.** The MCP detail text of a `reassignable` cut says "may have been reassigned at" followed by its
   cause places. The reason needs no other presentation: schemas and the status line read the closed reason list.
5. **ADR-0079 U1 is amended**: a TypeScript member that is a property (T1) no longer keeps a `name-only` cut by default.
   It is proven, or it is `reassignable`; the `name-only` cut of a property call is left to the reasons ADR-0079 gives
   for any call.

## Consequences

- `callers` and `impact` gain proven callers for property members and lose the `name-only` cuts of the unwritten ones.
  The corpus gate declares `--expect callers:+`, `--expect impact:±`, `--expect-cuts name-only:-` and
  `--expect-cuts reassignable:+`.
- `Cut.reason` gains `reassignable` and `CutCause` gains `reassignment`; both are additive, so no schema version moves.
- The adapter keeps the places of the writes its gates already read; the port gains `reassignedUses`, the calls whose
  property proof a write refused, next to `memberUses`.
- `trace` is unchanged by this decision: it reads proven member uses only.

## Not decided here

- A refused template property call has no reference to hang a cut on, as before; a cut for it is the "truthful
  uncertainty" option ADR-0025 left open.
- Whether a refused property call should also carry the places of a provider substitution or a subclass shadow in its
  cause. Those places are known to the reader; the cause here names writes only.
