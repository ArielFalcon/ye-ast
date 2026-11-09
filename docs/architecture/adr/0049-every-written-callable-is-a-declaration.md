# ADR-0049: Every callable the source writes is a declaration

- Status: Accepted, 2026-11-09, owner
- Decision source: Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (settle every open question as recommended), after "aplica el orden que recomiendas" and "los ADR recogen decisiones mas acotadas referentes a un RFC".
- Related: [RFC-0027](../rfc/0027-declaration-model.md) designs this decision; ADR-0041, ADR-0042, ADR-0044, ADR-0045

**In short:** Object-literal members, factory-built members, anonymous-class bodies and method references become declarations or references the families can target, and a Java type target is `partial` until its type references are read.

## Context

Declaration-model items failed because a method reference is an opaque value, an anonymous class owns and defers its calls, TypeScript object-literal and factory members are only names, and a Java class used only as a field type answers `complete` with no dependent (a false fact on main). RFC-0027 holds the evidence and units.

## Decision

1. A declaration model spans index and syntax declarations, owned by the language packs' B1 stage and joined by one per-file model in `navigation`.
2. A function value that names a declaration is a reference (a dependence and a deferred step), never a call and never evidence of execution; ADR-0044's veto is unchanged.
3. A framework plugin may supply the container of the members its factory returns, through `FrameworkMemberBindings`; no language pack names a library.
4. A Java declaration's written types are references to those types' declarations (B4's Java step), and a Java type target stays `partial` until that step reads them. The containment (RFC-0027 U0) lands first.

## Consequences

- The delivery units, their order and their tests are in RFC-0027, and each unit names the units of other RFCs it waits for.

## Not decided here

- Reading a factory's return shape from library signatures.
