# ADR-0139: Access rules a framework declares for a route are its guards, read from the sources or reported as unread

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: the owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra
  sesion por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente
  tenga que tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less
  capable agent implements it in another session; everything explicit, almost no room for important decisions or
  invented implementations). It serves the request "Identificar los huecos de analisis de codigo, lo que el motor
  ignora, tanto de base como en sus implementaciones de java + spring y ts + angular" (identify the analysis gaps, what
  the engine ignores, in its base and in its Java + Spring and TypeScript + Angular implementations).
- Related: [RFC-0045](../rfc/0045-what-a-framework-invokes-is-declared-in-one-table-per-plugin.md) (rule R10, unit U11),
  [ADR-0137](0137-what-a-framework-invokes-without-a-written-call-is-a-row-of-one-table-per-plugin-and-an-unexplained-contract-is-never-silent.md),
  [ADR-0051](0051-an-answer-never-hides-what-the-engine-knows.md), [RFC-0007](../rfc/0007-extension-model.md) row S7

**In short:** an HTTP route carries the access rules that annotations on its handler method and on its class declare,
with their values as written, under an optional `access` field that also names which rule sources were read and which
were not. An empty rule list means "none declared in the sources read", never "unguarded"; request filter chains stay an
explicitly unread source.

## Context

`HttpRoute` has no guard field (`src/core/domain/entrypoints/http-route.ts:60-72`); only `UiRoute` carries `guards`. No
source file reads `PreAuthorize`, `SecurityFilterChain` or `HttpSecurity`, although RFC-0007 (`:453`) states they are
detected and answered `unknown`. In the corpus, method-security annotations appear 47 times and matcher chains 61 times.
An answer that lists a route with no access information reads as an open route.

| Option | Why kept or dropped |
|---|---|
| New optional `access` with `read`/`unread` sources and the declared rules | Kept: additive, no `SCHEMA` bump; the type cannot say "unguarded" |
| Reuse `UiRoute.guards` shape | Dropped: a guard names a declaration, a rule is an annotation with expression values |
| Read matcher chains now | Dropped: needs value flow over lambda DSLs, first-match ordering and path-pattern semantics |
| Defer the whole decision | Dropped: the field is additive and the handler annotations are read with existing machinery |

## Decision

1. `HttpRoute` gains the optional field `access: RouteAccess` with `read` and `unread` source lists and `rules`, typed as
   RFC-0045 "Contract" writes them. The Java route reader sets it on every route it produces.
2. A rule is an annotation use whose type is an `access-rule` row of the plugin's table (ADR-0137), on the handler method
   (`on: "method"`) or on its class or a class of its repository chain (`on: "class"`), with its `value` expressions
   evaluated to text in written order, or `unread` when any is not a constant the reading evaluates.
3. `rules: []` means that the sources in `read` declare no rule. No field, text or rendering states that a route is
   unguarded or public; whether the application enables enforcement is not read, and the field's documentation says so.
4. Request filter chains are listed in `unread` on every route until a reader for them exists; that reader is a new
   decision.
5. Rendering lists the rules of a route with their source. It states "request filters not read" once per answer, not on
   every route (ADR-0109: a part that several places repeat is stated once); a route without declared rules prints no
   access line.

## Consequences

- The entrypoint answer and the workspace view show who may run each Spring route as far as the handler annotations say.
- The stored slot `java-entrypoints` changes version (ADR-0077).
- RFC-0007 row S7 is corrected: chains are not detected; every route says they are unread.

## Not decided here

- Reading `SecurityFilterChain`, `HttpSecurity` and `WebSecurityConfigurerAdapter.configure` matcher chains.
- Guards of other HTTP frameworks.
- Whether method security is enabled.
