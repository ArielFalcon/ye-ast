# ADR-0142: When the owner of a rule answers "not established", no consumer substitutes a by-name set as if it were the owner's answer

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra sesion
  por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente tenga que
  tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less capable
  agent implements it in another session; everything must be explicit, leaving almost no room for that agent to take
  important decisions or invent implementations). The decision serves this sentence of the request of the same day:
  "Mejorar la calidad de analisis de lo que ya existe, corregir problemas, optimizar recursos y aprovechar mejor los
  recursos que ya tiene disponible" (improve the quality of the analysis that exists, fix problems, optimise resources
  and make better use of the resources already available).
- Related: [RFC-0047](../rfc/0047-an-unproven-reading-reaches-only-what-its-cause-can-reach.md) (the design, U5),
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md) decisions 1 and 4,
  [ADR-0042](0042-completeness-is-relative-to-the-question.md),
  [ADR-0051](0051-an-answer-never-hides-what-the-engine-knows.md),
  [ADR-0086](0086-a-java-call-only-the-class-chain-can-declare-is-selected-under-an-open-hierarchy.md),
  [ADR-0087](0087-a-java-call-the-reading-cannot-read-is-unproven-and-a-call-on-super-runs-without-dispatch.md),
  [ADR-0089](0089-an-index-edge-the-receiver-reading-does-not-prove-is-judged-as-the-reference-at-its-place.md) decision 1,
  [ADR-0106](0106-a-trace-call-runs-what-its-readings-candidates-leave-on-the-receiver-the-walk-entered-through.md) decision 1,
  [RFC-0024](../rfc/0024-receiver-typed-settlement.md) rule 2
- Supersedes: ADR-0106 decision 1, second clause ("the name-based list stays where the reading offers none"), and
  RFC-0024 rule 2, third bullet, first case, for an answer `unproven` without candidates on the nominal receiver path
  of `memberOfReceiver` only. Every other case of those records stands.

**In short:** when the owner of the Java receiver reading answers `unproven` with no candidates, it says it could not
read the receiver's whole hierarchy. `memberOfReceiver` replaced that answer by the members of the proven type's
hierarchy (`binder.membersAbove`), a list the owner did not establish and that may miss the member a type outside the
repository declares. The consumer now lists nothing in its place and marks the binding `unproven`; the reverse
families keep the by-name edge through their own channel (ADR-0089).

## Context

Verified at commit `62a41b28a`:

| Fact | Evidence |
|---|---|
| For a nominal language, an `unproven` answer with no `candidates` returns `binder.membersAbove(type, member)` as the member's candidates | `memberOfReceiver`, `src/core/application/navigation/call-binding.ts` (`return { candidates: offered ?? binder.membersAbove(type, member) }`) |
| The same function takes the owner's candidates when it offers them, and the owner's `method` answer as the target | same function, the `answered.kind === "method"` and `offered` lines |
| `unproven` without candidates is the answer for a hierarchy that is open or whose members the reading cannot settle | `ReceiverMethod`, the `unproven` variant, `src/core/ports/import-origins.port.ts` (`candidates`: "present only when the reading read that whole hierarchy") |
| `CallBindings` is the one owner of what a call binds to for every family; a family reads the binding and never binds a call elsewhere | `CallBindings`, `src/core/application/navigation/call-binding.ts`; ADR-0041 decisions 1 and 4 |
| The reverse families keep the edge for an `unproven` answer without candidates and add `name-only` cuts | ADR-0089 decision 1; `declaredMethodsOf`, `src/core/application/navigation/edge-targets.ts` |
| `settleDeclared` also falls back to the declarations of the called name in scope when the answer is `unproven` without candidates; `trace` converts `outside` and a type-variable `method` into `unproven` before the binding reads them | `settleDeclared`; `unprovenOutside`, `executed`, `src/core/application/trace/trace-walk.ts` |
| No fitness test guards the fallback; the single-rule test covers other concepts | `src/composition/edge-targets.single-rule.test.ts` (`RULES`) |

Options weighed:

| Option | Verdict |
|---|---|
| Keep `membersAbove` as the unproven receiver's candidates | Dropped: a consumer presents a list the owner did not establish as the owner's answer; the roadmap audit (finding 5) names it |
| Keep it and label it by-name | Dropped for now: the candidate `basis` field of RFC-0034 Part B is not built, and building it is a contract change of its own |
| List nothing in its place, mark the binding, keep the reverse families' own by-name channel | Chosen |

## Decision

1. **The owner's "not established" is not replaced.** When the owner of a rule answers that it did not establish the
   fact, no consumer substitutes a set it computed by name as if the owner had answered it. This ADR applies it to the
   nominal receiver path of `memberOfReceiver`: an `unproven` answer without `candidates` returns no candidates and
   marks the receiver binding `unproven`.
2. **The mark carries the reason.** A binding marked `unproven` is cut with the reason `receiver-unproven` whatever its
   candidate count; the ADR-0042 reason table row "`receiver-unproven` when candidates are listed" reads "or when the
   receiver reading answered `unproven`". `callee-unknown` stays for a call no reading placed.
3. **What the owner offers is kept.** An `unproven` answer with `candidates`, a `method` answer, and the answers of
   other readers (`unknown`, `capability-absent`, `generated`, `supplied`, `outside`) are unchanged: the structural
   path, whose owner is the binder, is unchanged.
4. **The reverse families keep their channel.** A call attributed to no declaration keeps the edge and the `name-only`
   cut of ADR-0089 decision 1; this decision removes no edge and no cut from them, only the candidate list the
   unproven binding carried.
5. **One place holds the rule.** The declarations a member call may run when its receiver's type is proven are decided
   in `call-binding.ts`; a fitness test forbids `binder.membersAbove(` outside it, and a second forbids a direct call of
   `origins.receiverMethods(` outside it (RFC-0047 U1 and U5).
6. **ADR-0051 holds.** The cut still states that the receiver's type was proven and the call was not, with its place; no
   fact the engine established is dropped, only a by-name guess that was not an established fact.

## Consequences

- A `receiver-unproven` cut over a hierarchy the reading could not read lists fewer places (none when the owner
  offered none); its reason does not change.
- A member that a type outside the repository declares is no longer hidden among the members of the proven type.
- `settleDeclared`'s by-name fallback is not changed by this decision (see below); `trace`'s per-call cuts for those
  calls are as before.
- The ledger rows `receiver-unproven` of the Java and TypeScript families may move in `at` lists; RFC-0047 U5 declares
  the gate expectation.

## Not decided here

- `settleDeclared`'s fallback to `namedDeclarations` for an `unproven` answer without candidates. ADR-0106 decision 1
  stands for it, because `trace` converts `outside` and a bound `method` into `unproven` locally, so the binding cannot
  tell the owner's answer from the conversion. It can move when those conversions move to the owner (ADR-0133 and
  RFC-0043 are the records that may do it).
- The candidate `basis` field of RFC-0034 Part B.
- The structural path's `membersAbove`: its owner is the binder, which answers a target by its member rule.
