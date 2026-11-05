# ADR-0025: A template call through an injected field joins as a call of the component

- Status: Accepted, 2026-11-05, owner
- Decision source: the owner, 2026-11-05, on the open decisions of the Angular template expression investigation:
  "Aplica las soluciones que recomiendes para las decisiones abiertas" (apply the solutions you recommend for the open
  decisions). The recommended solution is option 1 of "Needs owner decision" in
  `docs/superpowers/plans/2026-11-05-analysis-coverage-task-02-template-expressions.md`.
- Related: [ADR-0017](0017-owner-of-a-member-expands-only-whole-type-edges.md) and its amendment,
  [ADR-0013](0013-coverage-grows-only-with-evidence.md), [ADR-0014](0014-angular-and-spring-from-own-extractors.md),
  [RFC-0010](../rfc/0010-impact-queries.md), [RFC-0002](../rfc/0002-facts-contract.md)

**In short:** a template call `api.archive()` on a component whose own `api` field is `inject(ArchiveApi)` makes the
component a caller of `ArchiveApi.archive`, with the template file and line as evidence. It amends the ADR-0017
amendment, which admits only symbols that hold a graph reference: a template holds none.

## Context

The ADR-0017 amendment joins a member use through an injection's binding only at a graph reference row named
`this.b.m` or `b.m`. Angular templates have no graph rows, so a method used only from a template had no caller, no
entrypoint and no cut: the answer was `complete` and wrong. The investigation reproduced it and showed that
`R3TargetBinder.getExpressionTarget` tells a component member (`null`) from a template local.

## Decision

1. The template reader reports `field.member(...)` (and `this.field.member(...)`) when the binder binds `field` to the
   component. Template locals, safe calls, callable fields and signal reads are not reported. The template's writes and
   the fields it passes on are reported too, and are risks of the component like its class's own.
2. The Angular metadata adapter proves each reported call through the same checks as the class's own
   `this.field.member()` calls, scoped risks and the behavior rule of RFC-0010 included, and requires that the field's
   origin is `inject()`. The proof is a `MemberUseOrigin` with `template: true`.
3. The inbound join admits it without a graph reference, for a unique owner, receiver and method member whose owner is
   the receiver, outside test files: the component is the caller, at the relation confidence, with basis `call`. It
   settles no `unresolved-link` place.
4. `ImpactedSymbol.via.resource` names the template file when it is not the component's own; `via.lines` are lines of
   that file. Fact schema `0.17.0`.

## Consequences

- Answers gain the component and its routes for a template-only use, with no new relation kind and no second walk.
- The rule inherits the scoped member-proof risks. Measured on two real Angular applications once those risks were scoped
  to the receiver and member they reach, it admits 16 hand-verified template proofs in one and none in the other. Once
  instances passed on became risks of writes on objects the syntax does not place, 6 of 13 remain on a later revision
  of the first application.

## Not decided here

- Member proofs for signal-store members that are not class methods.
- Truthful-uncertainty cuts for template uses that cannot be proven (option 2 of the investigation).
