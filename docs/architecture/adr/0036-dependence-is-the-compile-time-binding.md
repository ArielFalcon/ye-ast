# ADR-0036: An index edge on a value receiver is a name match until a source proof binds it

- Status: Accepted, 2026-11-07, the owner through the tech lead
- Decision source: the owner, 2026-11-07 (translated): "launch one agent per improvement … and when it is approved each
  agent implements its own", and "resolve the open decisions as you recommend"; the tech lead approved this design that
  day.
- Related: [ADR-0019](0019-cuts-retired-on-a-proven-external-target.md),
  [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md), [RFC-0003](../rfc/0003-codegraph-integration.md),
  [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** ADR-0029 decision 11 held only for trace: a call codegraph resolved on a value receiver is not proof of
what runs. Impact and `callers` took the same edges as certain, so a call on Angular's `ParamMap.get` was listed as a
caller of the repository's only `get` at confidence 0.9. Every family that follows graph edges now settles such an edge
by ye-ast's own proofs: `proven` when a proof binds the receiver to the member's class, a `name-match` at the heuristic
confidence otherwise. For dependence, the binding the language makes at compile time is the proof.

## Context

On five Angular applications, of 4,878 call edges into members of repository classes and interfaces, the TypeScript
checker (with each application's `node_modules`) contradicts 116 that ye-ast presented as certain, and names a supertype's
declaration for 20 more. Every contradicted edge is a call on a value receiver. codegraph's own label cannot sort them:
its `instance-method` at 0.7 is "the only method of that name in the repository" and at 0.65 a guess scored on shared
words; its `exact-match` is right for 3,808 calls whose receiver needs no proof and wrong for 96 on a value receiver.
ye-ast's own proofs (member proofs, field and `inject()` local origins) were never contradicted.

Trace asks what code runs, so it needs a nominal class (decision 11). Impact asks what depends on a declaration's
contract: a call on a receiver declared `CrudService` depends on `CrudService.get` whatever object stands there at run
time, so the declared type proves the dependence even where the member proof refuses the call for run-time reasons.

| Option | False edges left certain | True edges dropped | Edges marked `name-match` |
|---|---|---|---|
| Today | 116 (+20 dispatch) | — | 0 |
| Only edges codegraph labels `exact-match` or `fuzzy` | 20 | 0 | 132 |
| Decision 11 on every edge, settled by ye-ast's proofs (chosen) | 2 | 0 | 226: 114 false, 91 true, 19 dispatch, 2 unjudged |

Measured with the shipped code (`EdgeTargets` and `followedEdge`) over the same indexes; 837 edges become `proven`, none
of them contradicted.

## Decision

1. `EdgeTargets` names the receiver of every kept edge of a TypeScript source into a member of a class or interface when
   that receiver is a value, by the rule of ADR-0029 decision 11. Trace keeps decision 11's scope, members of a class.
2. A family that holds the relations' proofs settles each such edge. It is `proven` when the member proof of the call
   names the member, or when, for an immediate receiver (`this.f.m`, `v.m`), a field's or an `inject()` local's origin,
   or the receiver's one store or declared annotation, names the member's class or a class below it. A receiver further
   down a chain (`this.f.g.m`) is bound by nothing.
3. A `proven` edge counts as ye-ast's own proofs do, confidence 1. Any other settled edge is a `name-match` and counts as
   a heuristic edge without a score, whatever score codegraph gave it. No settled edge is dropped.
4. The families that read no Angular relations, `importers` and `outline`, settle such an edge by the receiver's syntax
   alone (its one store or declared annotation): a file whose only edges into another are name matches is one of its
   `unresolvedNamers`, and a focused body's name-matched call is an `unresolved-link` cut, never a declared use. In a
   consequences reading a name-matched caller is an `ambiguous-caller` frontier, never followed.
5. Every dependence the impact walk reports carries its derivation: `proven`, `resolved` (the index through a binding or a
   structure ye-ast accepts) or `name-match` (a heuristic edge, or rule 3).
6. codegraph's resolution strategy is not part of any answer.

## Consequences

- A false caller no longer appears as certain; one that remains is visibly a name match, and whatever is reached only
  through it is no surer than it.
- 91 true edges on the corpus drop to 0.3: values ye-ast cannot bind, such as a local copied from a field
  (`const h = this.handler; h.m()`) or an unannotated parameter.
- Settling reads each source's syntax once per query, in the families that settle; a consequences reading settles every
  call edge of its TypeScript sources once, since its callers are asked synchronously.
- A file that reaches another only through a field's or an `inject()` local's origin, and imports nothing of it, is
  listed by `importers` as a namer: those families read no relations.

## Not decided here

- A proof for a local copied from a field, and the type of a receiver further down a chain: measured and left open.
- Languages other than TypeScript keep codegraph's resolution.
