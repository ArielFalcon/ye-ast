# ADR-0130: A call cut states the cause its binder established, never one derived from the candidate count

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra
  sesion por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente
  tenga que tomar decisiones improtantes o inventarse implementaciones" (translated: write every RFC and ADR needed so
  that a less capable agent implements it in another session; everything explicit, leaving almost no room for that agent
  to take important decisions or invent implementations). It serves the request of the same day: "revisa todo el motor
  de analisis de codigo del proyecto ... mejorar la calidad de analisis de lo que ya existe, corregir problemas ...
  desde la base hacia arriba" (translated: review the whole code analysis engine ... improve the quality of the analysis
  that exists, fix problems ... from the base upward).
- Related: [RFC-0042](../rfc/0042-a-call-cut-states-its-cause-and-the-corpus-declares-what-the-engine-can-read.md) (the design);
  [ADR-0074](0074-trace-walks-every-body-of-a-closed-set-and-a-cut-names-its-cause.md) decisions 6 and 7;
  [ADR-0071](0071-engine-investment-is-steered-by-a-cut-ledger-and-an-outcome-control.md);
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md); [ADR-0042](0042-completeness-is-relative-to-the-question.md);
  [ADR-0045](0045-one-assembly-line-for-the-snapshot-reading.md) decision 12;
  [ADR-0075](0075-the-core-names-no-language-or-framework.md);
  [ADR-0090](0090-a-typescript-call-on-this-binds-through-the-hierarchy-of-the-class-it-is-written-in.md)

**In short:** the sub-reason of a `receiver-unproven` or `callee-unknown` cut is the cause the call binder or its receiver
reading established, carried as a closed `CallCause` from the binding to the cut. It is never inferred from how many
candidates the cut lists. No `reason`, no status and no step changes.

## Context

`callCut` (`src/core/application/trace/trace-walk.ts`) chooses `receiver-unproven` when a cut lists candidates and
`callee-unknown` when it lists none. The binder knows more: `CallBinding.unbound` is built where a computed callee, an
unselected overload, an unbound bare name or an unsettled reading was found, and `settleDeclared` reads the flags
`repositoryWide` and `open` and the kinds `unproven`, `outside` and `unknown` of the receiver reading, then discards them.
Trace demotes `outside` and a type-variable bound to a bare `unproven` before the binder sees them. The only sub-reason a
call cut carries is `capability-absent`, copied from the reading's `reason`; the TypeScript adapter answers it for every
receiver it does not type although its pack implements the reading. The baseline ledger therefore holds two rows of
191 Java cuts (`receiver-unproven` 129, `callee-unknown` 62) that name no cause.

| Option | Verdict |
|---|---|
| Keep deriving the label from the list | Rejected: the label is a function of what the walk happened to list, so two different situations share a row |
| A new `basis` field on `Cut` (ADR-0074 decision 6) | Rejected: it says only typed or named, and two sub-reasons already say it |
| Extend the closed set `CUT_SUB_REASONS` and carry the cause in the binding | Chosen: every consumer already reads the set |

## Decision

1. **The cause is carried, not derived.** `CallBinding.unbound` has a required field `cause: CallCause`. The functions
   `causeOfReading`, `causeOfProof` and `causeOfBinding` in `src/core/application/navigation/call-binding.ts` are the
   only place where a receiver reading, a receiver proof or a binding becomes a cause. No code chooses a call cut's
   `subReason` from the length of a candidate list.
2. **The vocabulary is closed and sits in `src/core/domain/shared/fact.ts`.** `CALL_CAUSES` adds eight members to
   `CUT_SUB_REASONS`, placed before `unproven` so that a specific cause stands over `unproven` and over none at one place
   (`standsOver`): `binding-conflict`, `repository-wide`, `hierarchy-open`, `members-unselected`, `receiver-outside`,
   `receiver-untyped`, `callee-computed`, `callee-unbound`. `CallCause` is those eight and the existing `unproven` and
   `capability-absent`. The existing members keep their relative order.
3. **Definitions.**
   - `binding-conflict`: two framework bindings claim the declaration the call is written in.
   - `repository-wide`: the reading proves no call of the repository.
   - `hierarchy-open`: the receiver's hierarchy is open through a type outside the repository.
   - `members-unselected`: the receiver's type is established, the reading offers declarations of the name, none selected.
   - `receiver-outside`: the receiver's declared type, or the one supertype its hierarchy is open through, is outside the repository.
   - `receiver-untyped`: the reading established no type for the receiver.
   - `callee-computed`: the callee name is computed.
   - `callee-unbound`: a name written without a receiver that no declaration, import or library root binds.
   - `unproven`: nothing narrower is established. `capability-absent`: the language pack declares the stage absent.
4. **A cause is emitted only from the state that establishes it** (table "The states the binder is in" of the RFC); a
   state that establishes none emits `unproven`, never an omitted sub-reason.
5. **`reason`, status and steps do not change.** The `reason` of a call cut keeps its present choice (`receiver-unproven`
   when the cut lists candidates, `callee-unknown` otherwise); a cause never changes a status, a step, a candidate list or
   a reach. A change to this rule is a new decision with a ledger migration.
6. **ADR-0074 decision 6 is met by the sub-reason, not by a field.** A candidate list is `typed` exactly when its cut's
   sub-reason is `members-unselected` or `hierarchy-open`; every other list is `named`. `Cut` gains no `basis`.
7. **No new `cause` places.** The binder holds no place for these causes, so `Cut.cause` (ADR-0074 decision 7) keeps its
   dispatch constructs. The receiver-hierarchy places stay unbuilt.
8. **`capability-absent` keeps one meaning on a call cut:** the pack's own declaration (ADR-0045 decision 12). The
   TypeScript receiver reading, which exists for `this` and `super`, answers `unknown` with no reason for every other
   site (its answer was `capability-absent`), so those calls are `receiver-untyped`, or `callee-unbound` for a bare
   call. `dispatch`, `relation-unread` and `constructor-unsettled` keep `capability-absent` where their stage is declared absent.
9. **The consumers read the set, never a copy.** The cut ledger and the gate (`scripts/corpus-gate-ledger.ts`), the MCP
   schema (`src/mcp/composition-schema-parts.ts`) and the evidence selector read `CUT_SUB_REASONS`; a sub-reason outside the
   set stays a gate fault (RFC-0031 rule 1). The MCP prints the cause verbatim after the reason, `receiver-unproven (receiver-untyped)`.
10. **The unit guard.** Each unit that emits causes passes the corpus gate with the family declared (`--expect trace:±`,
    `callers:±`, `impact:±`) and with `Reasons whose total moved: none` in the report.

## Consequences

- The two largest rows of the ledger split by cause; the next investment is chosen from the split (RFC-0042 U8).
- A consumer that keyed on the absence of `subReason` on these cuts sees a value; the field is optional and additive, no
  schema version changes.
- One adapter answer changes (`this-receiver-methods.ts` `UNKNOWN` loses its reason) and five test expectations with it.
- A computed callee with homonyms reads `receiver-unproven (callee-computed)`: the pair is true, the reason is imprecise
  until a separate decision renames it.

## Not decided here

- The scope of `repository-wide`, which is one fact emitting one cut per call: RFC-0047.
- Whether the Java reader splits a bare `unproven` into typed and untyped receivers: RFC-0043.
- Whether `trace` of a TypeScript repository accepts a declared `node_modules`: RFC-0044.
- Renaming a call cut's `reason` from its cause.
