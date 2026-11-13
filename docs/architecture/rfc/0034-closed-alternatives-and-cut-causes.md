# RFC-0034: Trace walks every body of a closed set, and a cut names the places of its cause

- Status: Draft, 2026-11-13
- Related: ADR-0036, ADR-0041, ADR-0042, ADR-0044 (decisions 1, 3, 4, 5), ADR-0046, ADR-0051, RFC-0002, RFC-0013 (R7),
  RFC-0031, RFC-0032, ADR-0074 (the decision this RFC designs)

**In short:** the answer model has two outcomes for a call: one proven target, or a cut. Two cases in between are
facts the engine already holds and does not use. When the declared hierarchy proves that a call runs exactly one of
`n` bodies, trace lists them and stops; it should walk each as a branch. And when a proof is refused, the cut lists
candidates without saying whether they are all the possible targets or only homonyms, nor what blocked the proof. Both
are closed with the data the owners already compute.

## Problem

| Fact | Evidence |
|---|---|
| A body-less method with one proven body is walked; with several proven bodies it is a cut | `src/core/application/trace/trace-walk.ts:284` (`several-bodies`) |
| The closed set is already in the answer, as `alternatives` | `src/core/domain/trace/trace-fact.ts:64-65`, ADR-0044 decision 4: "one body expands, several cut" |
| An overridable method with a body and overriders below is a cut, and the owner of closures is not asked | `src/core/application/trace/trace-walk.ts:286-288` |
| A cut's candidates travel in `at`, after the place, with no statement of their basis | `callCut`, `src/core/application/trace/trace-walk.ts:701-702` |
| A refused dispatch carries one of three reasons as text and no place | `DISPATCH_UNKNOWN_REASONS`, `src/core/domain/shared/fact.ts:146` |
| The cut of an unread-source veto carries no sub-reason at all | reproduced at `db49322d` (RFC-0032) |
| In the 2026-11-07 evaluation, one answer had 15 cuts of which 2 were informative, and candidates included declarations of another language and configuration keys | `docs/evaluations/trace-quality/2026-11-07-findings.md:41-43,59-60` |

The first three rows lose depth the sources prove. The last four leave the agent with a list it cannot act on.

## Part A: a closed set is walked

### Rule

When the owner of dispatch proves the closure and names `n > 1` bodies, each body is a step below the call, marked as
a branch. The answer asserts "this call runs exactly one of these bodies", which is what the sources prove.

| Element | Rule |
|---|---|
| Step | `via: "dispatch"`, as today, plus `branch: { of: n }` on each of the `n` steps |
| Order | the order of `alternatives`: by file, then line. Deterministic |
| Effects | an effect under a branch step is conditional on its branch. It keeps its place and gains nothing else: the path of steps above it already states the branch |
| Completeness | the `several-bodies` cut is retired. An answer with no other degrading cut is `complete`, and what it asserts changes from "what runs" to "what may run, with every alternative stated" (ADR-0042) |
| Selection | where ADR-0044 decision 4 selects one body by an injection proof, that body is the step and the rest stay `alternatives`, as today |
| Unknown closure | unchanged: a cut. Nothing is walked on a set the owner did not prove closed |

### Budget and noise

A walk that branches can grow. No new limit is introduced: the walk already has a depth and an expansion budget, and a
budget that runs out is an explicit cut.

1. Branch steps are expanded after the steps of the certain spine at the same depth, so a budget is spent first on
   what certainly runs.
2. The summary projection shows a branch as one line with its count; `details` and `full` show the steps.
3. Before the rule lands, the corpus is measured: the distribution of `n` over closed sets, and the growth in steps
   and bytes per answer. The ledger (RFC-0031) reports the `dispatch` rows and the step counts side by side. If the
   growth hides the spine in real answers, the rule ships behind the selection of decision 4 only, and this RFC is
   revised.

### Scope

- Java only. A language that types structurally answers `capability-absent` for dispatch and keeps its cut.
- The dependence families are unchanged. They already hold whatever the closure (ADR-0044 decision 3).
- An overridable method with a body asks the same owner. When the closure is proven, the method's own body and its
  overriders are the closed set, and the `overridable` cut is retired for that call.

## Part B: a cut names its cause

### Candidates state their basis

A cut that lists declarations says which of two things the list is:

| Basis | Meaning | Emitter |
|---|---|---|
| `typed` | every declaration the receiver's declared type offers at the call's arity, from a hierarchy read whole. The target is one of them | `receiverMethods` answering `unproven` with candidates |
| `named` | declarations that share the name. The target may be none of them | the name fallback (`settleByName`), and every list built from the index |

Rules:

1. A `named` list never holds a declaration of another runtime, nor a place that is not a declaration (a configuration
   key, a test asset). Where a fixture shows today's output already satisfies this, the fixture pins it.
2. The basis is one optional field on the cut. Additive; no schema version change.

### The cause has places

`Cut` gains an optional `cause`: the sorted places that blocked the proof, from data the emitter already holds.

| Sub-reason | `cause` holds |
|---|---|
| `aspect may replace the body` | the declarations of the advice that may apply |
| `generated implementation` | the annotation or the outside supertype that signals the generator |
| `dispatch not proven` | the unsettled supertype clause, the anonymous class, or the function value that may implement the type |
| `unread-source`, `unparsed-source` (new, RFC-0032) | the files |
| `unproven` on a receiver | the supertype clause that leaves the hierarchy open |

An agent that receives "the call reaches this implementation unless one of these two advices replaces it" can read two
declarations. Today it receives a list and a sentence.

### What Part B does not do

It never upgrades a status. The engine does not accept an agent's or a host's statement that a cause does not apply.
A fact conditioned on a declared assumption was considered and is not proposed (open question 3).

## Slices

| # | Slice | Gate expectation |
|---|---|---|
| 1 | Measure `n`, steps and bytes on the corpus with the rule in a probe | none: no behavior on `main` |
| 2 | Branch steps for a proven closure of a body-less method | `trace:+` |
| 3 | The overridable case asks the owner | `trace:+` |
| 4 | `basis` on candidate lists; rule 1 fixtures | `trace:±`, `callers:±` (detail only) |
| 5 | `cause` for the dispatch sub-reasons and the receiver hierarchy | detail only |

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Is "may run, every alternative stated" still `complete`? | Yes. The answer hides nothing and asserts exactly what is proven. A `partial` here would say the engine stopped, which it did not. This changes what trace asserts and needs the owner's acceptance |
| 2 | Is there a count of alternatives above which the walk does not branch? | No constant. The existing budgets bound the walk and say so. A threshold would decide behavior by size, which the design pillars forbid |
| 3 | May a host declare that a cause does not apply, so the answer is complete under that assumption? | Not now. It lets a guess enter a fact. First deliver the cause places and measure, with the outcome control, whether agents settle cuts by reading them |
| 4 | Does `impact` gain the same branch marking? | No. Dependence already includes every implementation through its bridges |
