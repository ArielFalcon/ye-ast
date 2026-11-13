# ADR-0074: Trace walks every body of a proven closed set, and a cut names the places of its cause

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados" (I approve
  every pending recommendation; leave them closed), after "estas propuestas de correccion y mejoras deben ser de forma
  transversal y no parches puntuales" (the corrections and improvements must be cross-cutting, not point patches).
- Related: RFC-0034 (design), ADR-0042, ADR-0044, ADR-0051, RFC-0002, RFC-0013
- Amends: ADR-0044 decision 4, only its last rule ("one body expands, several cut")

**In short:** when the declared hierarchy proves a call runs one of several bodies, trace walks each as a branch and
the answer stays `complete`: it asserts what may run and states every alternative. A cut that lists candidates says
whether they are all the possible targets or only homonyms, and names the declarations or files that blocked the
proof. No status is ever raised by a statement from outside.

## Context

`src/core/application/trace/trace-walk.ts:284` walks a body-less method with one proven body and cuts one with
several, although ADR-0044 decision 4 already returns the closed set as `alternatives`. The depth is proven and not
used. Cuts list candidates in `at` with no basis, and a refused dispatch carries one of three sentences and no place.
The 2026-11-07 evaluation found answers where 2 of 15 cuts were informative.

| Option | Verdict |
|---|---|
| Keep "several bodies cut" | Rejected: it reports as "stopped" a walk the sources allow |
| Walk the candidates of an unproven closure too | Rejected: that walks a guess |
| Accept a declared assumption to complete an answer | Rejected for now: it lets a guess into a fact (RFC-0034, resolved question 3) |
| Walk only proven closed sets, and give every cut its basis and its cause | Chosen |

## Decision

1. A call whose closure the dispatch owner proves, with `n > 1` bodies, expands every body as a step `via:
   "dispatch"` carrying `branch: { of: n }`. The `several-bodies` cut is retired.
2. Such an answer, with no other degrading cut, is `complete`. Trace asserts what may run, with every alternative
   stated.
3. Where ADR-0044 decision 4 selects one body by an injection proof, that body alone is the step.
4. No new numeric limit. Branch steps are expanded after the certain steps of the same depth, under the existing
   budgets, whose exhaustion is an explicit cut.
5. An overridable method with a body asks the same owner; a proven closure retires its `overridable` cut. The
   dependence families gain no branch marking: they already include every implementation (ADR-0044 decision 3).
6. A candidate list states its basis: `typed` (the receiver's type offers exactly these) or `named` (homonyms). A
   `named` list holds no declaration of another runtime and no place that is not a declaration.
7. `Cut` gains an optional `cause`: the sorted places that blocked the proof, from data its emitter holds.
8. The engine never raises a status because an agent or a host states that a cause does not apply.
9. The rule lands after the corpus measurement of alternatives, steps and bytes per answer (RFC-0034, slice 1).

## Consequences

- Controller-to-service walks through an interface with several implementations continue instead of stopping.
- Answers grow where sets are wide; the measurement of decision 9 is the guard, and the summary shows a branch as one
  line.
- Two additive fields on a cut, one on a step. No schema version change.

## Not decided here

- Conditioned facts on declared assumptions stay out. They are reconsidered only after the outcome control shows
  whether agents settle cuts by reading the cause places.
- Dispatch for a structurally typed language: it keeps `capability-absent`.
