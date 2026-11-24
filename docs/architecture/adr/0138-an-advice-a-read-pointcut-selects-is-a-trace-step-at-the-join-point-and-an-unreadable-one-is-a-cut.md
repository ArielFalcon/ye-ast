# ADR-0138: An advice a read pointcut selects is a trace step at the join point, and an unreadable one is a cut

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: the owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra
  sesion por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente
  tenga que tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less
  capable agent implements it in another session; everything explicit, almost no room for important decisions or
  invented implementations). It serves the request "Identificar los huecos de analisis de codigo, lo que el motor
  ignora, tanto de base como en sus implementaciones de java + spring y ts + angular" (identify the analysis gaps, what
  the engine ignores, in its base and in its Java + Spring and TypeScript + Angular implementations).
- Related: [RFC-0045](../rfc/0045-what-a-framework-invokes-is-declared-in-one-table-per-plugin.md) (rules R4–R7, units
  U6–U8), [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md),
  [ADR-0091](0091-only-advice-that-can-replace-a-body-vetoes-dispatch.md),
  [ADR-0137](0137-what-a-framework-invokes-without-a-written-call-is-a-row-of-one-table-per-plugin-and-an-unexplained-contract-is-never-silent.md)

**In short:** an advice whose pointcut the reader proves selects a method's execution is a trace step `via: "advice"`
of that execution when it is entered through a proxy, ordered by when the advice runs; an advice that may select it, or
any execution entered by self-invocation, is one `advice-undecided` cut per advice, and an unreadable pointcut is one
cut at the advice. In `callers` and `impact`, a method depends on every advice that may select it.

## Context

The advice reader reads only `@Around`, only to veto dispatch (`java-dispatch-targets.ts:26`, `adviceOf` at `:648-666`);
ADR-0091 records that no cut is added for the other advice kinds. A trace through a woven call therefore omits the
advice bodies without a cut, and `callers`/`impact` from an advice method reach nothing (Problem row 5 of RFC-0045).
Spring proxies advise only calls that enter through the proxy (not `this.m()`), and only non-private, non-static,
non-final methods of beans; AspectJ weaving advises more.

| Option | Why kept or dropped |
|---|---|
| Steps only for proven selections at proxied join points; a cut otherwise | Kept: a step is asserted only where both weaving modes run it |
| Steps for every possible selection | Dropped: asserts code that may not run |
| One cut per (advice, step) | Dropped: multiplies cuts; one cut per advice listing its steps is bounded |

## Decision

1. One reader (`src/core/adapters/spring/java-advice.ts`) answers, for a method body, `selects`, `may` or `no` per
   readable advice, over the closed designator subset of RFC-0045 R4; `no` is exactly today's veto test answering false.
2. `selects` requires the proof RFC-0045 R4 states for each designator, a body that is not private, static or final,
   and an aspect class that is a scanned bean; otherwise the answer is at most `may`.
3. The dispatch veto of ADR-0091 is unchanged: only `around` advice and introductions veto, with the same first-escape
   rule per aspect.
4. At a join point reached through a proxy (an entrypoint handler, a `call` step not through `this`, a dispatch of
   either), each `selects` advice body is a child step `via: "advice"`: `around` and `before` before the step's own
   children, `after-returning`, `after-throwing` and `after` after them. At a self-invoked join point every selecting
   advice is undecided. Each undecided advice yields one cut `advice-undecided` listing its place and the anchors of
   every step it was undecided for; each unreadable advice yields one cut at its place. Advice is not asked at a root
   that is not an entrypoint handler, nor at a construction.
5. `callers` and `impact` read one relation `advised-by` from each method to each advice whose selection is not `no`;
   an unreadable advice is one relation cut `advice-undecided` whose reach is the callers of the advice.
6. `CUT_REASONS` gains `advice-undecided` as its last member; `TraceVia` gains `advice`. Both are additive; no `SCHEMA`
   bump.

## Consequences

- Traces through advised services list the advice bodies and their effects; the cut row `advice-undecided` grows where
  pointcuts are narrow or calls are self-invoked.
- `callers` of an advice method reach the entrypoints of the methods it advises.
- The advice reading moves out of the dispatch reader; dispatch answers do not change (RFC-0045 U6 gate: none).

## Not decided here

- Order between aspects (`@Order`, `Ordered`) and the effect of `proceed()` on the body.
- Introductions (`@DeclareParents`, `@DeclareMixin`) beyond the existing veto.
- Advice at a root that is not an entrypoint handler.
