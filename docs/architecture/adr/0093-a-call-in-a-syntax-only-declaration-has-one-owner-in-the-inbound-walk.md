# ADR-0093: A call written in a syntax-only declaration has one owner in the inbound walk

- Status: Accepted, 2026-11-14, owner; extends [ADR-0049](0049-every-written-callable-is-a-declaration.md)
- Decision source: the owner, 2026-11-14, accepting the transversal fix plan of evaluation run `20261114T125655Z-c68fc8`
  (unit U3, cause C3) and its decisions D1 to D8: "Acepto".
- Related: [ADR-0017](0017-owner-of-a-member-expands-only-whole-type-edges.md),
  [ADR-0049](0049-every-written-callable-is-a-declaration.md), [RFC-0027](../rfc/0027-declaration-model.md)

**In short:** trace owns a call written in an object-literal member at that member (RFC-0027 U2); the inbound walk owned
it at the indexed declaration around it, so one call had two owners depending on the direction. The inbound walk now
places a caller at the member that writes the call when a holder names that member, and a syntax-only declaration no holder
names hands its dependence to the declaration that contains it.

## Context

Measured on two corpus repositories (run `20261114T125655Z-c68fc8`):

- A `callers` request over the lines of an Angular component that pass a callable to a framework call
  (`rxResource({ stream: ... })`) seeded the object-literal member `stream`. The walk looked up the callers of a member
  called `stream`, found none, and answered `complete` with no dependent, while the request for the symbol the call uses
  reached the declaration that holds the resource and eight routes.
- A `callers` request for a declaration an `@ngrx/signals` store method calls reached the store constant, because the index
  and the written-call reading place the call at the enclosing constant. Every user of the store became a dependent at
  confidence 1: six routes whose components never use the method.

The declaration model already names the owner of each written call (`callsByOwner`), and the framework binding already
says which object-literal members a holder names.

## Decision

1. A named member is a syntax-only declaration that a holder names: a literal a variable or field holds, or a member a
   framework binding places under its holder with project proof. Every other syntax-only declaration is a callable
   handed to something else: a member of a literal written as an argument or returned, or one whose holder is not proven.
2. A caller that the walk reads at an indexed declaration is placed at the named member that owns the call written at its
   line (the owner `callsByOwner` gives); a line no named member owns stays with the indexed declaration. One dependence
   whose lines belong to different owners is one dependence per owner.
3. A named member reached by the walk, as a seed or as a caller, is reached by the uses of that member, as for any
   syntax-only target, and its holder is entered at the same depth through a member (ADR-0017): the holder follows no row
   that opens the whole of what it declares.
4. A syntax-only declaration no holder names hands its dependence to the innermost declaration whose span contains it, at
   the same depth, with basis `contains`, entered as a declaration whose code changed. The container may itself be a
   syntax-only declaration, which decides again by this decision.
5. A syntax seed that is no named member and has no declaration around it is a `no-symbols` cut at the seed; the answer is
   never `complete` and empty for it.

## Consequences

- `callers` and `impact` over a call written in a store member list the users of that member, not the users of the
  store; over a callable handed to a framework call, they list what the declaration around it reaches, so a line request
  and a symbol request over the same call reach the same declarations.
- A member the walk reaches is a syntax declaration in the answer's symbols, already true for syntax seeds.
- A named member whose uses the base binding cannot prove keeps its cut (`receiver-unproven`) instead of the dependence of
  the whole holder.

## Not decided here

- Where the TypeScript pack places the members of a literal written as an argument (under the class around it today).
  This decision reads the declaration model as it is.
