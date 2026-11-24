# RFC-0042: A call cut states its cause, and the corpus declares what the engine can read

- Status: Accepted, 2026-11-17. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions); every question is settled as its "Resolved questions" table states.
- Related: ADR-0130 and ADR-0131 (the decisions this RFC designs); RFC-0031 and ADR-0071 (the cut ledger); RFC-0034 and
  ADR-0074 (cut causes, candidate basis); ADR-0037 and ADR-0063 (declared build outputs); ADR-0039 (the corpus gate);
  ADR-0041 (one call reconciliation); ADR-0042 (completeness); ADR-0075 (the core names no language); ADR-0079, ADR-0087,
  ADR-0090 (receiver readings); RFC-0043, RFC-0044 (receiver typing, other authors); RFC-0047 (scoping of repository-wide
  causes, other author)

**In short:** `callCut` picks `receiver-unproven` or `callee-unknown` from the number of candidates it lists, and the
binder's own knowledge of why a call did not bind is dropped before the cut exists. This RFC carries that knowledge
through a closed `CallCause` to the cut's `subReason` (eight new members, two reused), changes no `reason` and no
status, and fixes the TypeScript label that says "capability absent" where the receiver type is not established. Part B
makes the corpus the gate runs declare the JDK of every Java trace and the `node_modules` of every TypeScript
`impact` and `callers` query that has an install, as a second arm, so each ledger row shows its value without and with
them; the four `--depth 1` queries lose the flag. It must split the rows `trace/java/receiver-unproven` (129) and
`trace/java/callee-unknown` (62), and it must split `trace/typescript/receiver-unproven` (9 + 22).

## Problem

| Evidence | Source |
|---|---|
| The reason of a call cut is `receiver-unproven` when the cut lists candidates and `callee-unknown` when it lists none; no other input chooses it | `callCut`, `src/core/application/trace/trace-walk.ts` (line 991 at this commit) |
| Baseline ledger of the unchanged tree: 118 answers, 436 cuts; `trace/java/receiver-unproven` 129 (54.43 per 100 steps), `trace/java/callee-unknown` 62 (23.48), `trace/java/depth` 36, `trace/typescript/receiver-unproven` 9 without sub-reason and 22 with `capability-absent`, `trace/typescript/callee-unknown` 8; no `receiver-unproven` or `callee-unknown` row has any other sub-reason | the gate report of the base tree of 2026-11-17, kept outside the repository, "Cut ledger / Rows" |
| The binder knows why a call stays unbound and does not say: `CallBinding.unbound` carries `form`, `candidates`, `attributed` and nothing else | `CallBinding`, `src/core/application/navigation/call-binding.ts:41-46` |
| `settleDeclared` collapses the receiver reading into `{unbound, candidates}`: `repositoryWide`, `open` and the kind (`unproven`, `unknown`, `outside`) are read and discarded | `settleDeclared`, `call-binding.ts:336-348` |
| Trace additionally demotes `outside` and a type-variable `method` to a bare `unproven` before the binder sees them | `unprovenOutside` and `executed`, `trace-walk.ts:304-306` |
| The edge reader drops the same flag: `repositoryWide` is tested and not recorded | `declaredMethodsOf`, `src/core/application/navigation/edge-targets.ts:376` |
| The only sub-reason a call cut carries today is `capability-absent`, copied from the receiver reading's `reason` of the typed queue | `typed` loop, `trace-walk.ts:785-807` (`absent`), `settleBinding` and `settleByName` (`subReason` parameter) |
| The TypeScript pack implements the receiver reading for `this` and `super`, and answers every other site `{kind: "unknown", reason: "capability-absent"}`; the pack declares only `dispatchTargets` and `implicitChains` absent | `UNKNOWN`, `src/core/adapters/typescript/this-receiver-methods.ts:22`; `absent: ["dispatchTargets", "implicitChains"]`, `src/composition/language-packs.ts:17` |
| So a TypeScript call on `port: A` (a repository class, structural typing) is cut as `receiver-unproven (capability-absent)` although the stage is present and the receiver type is what is unestablished | `src/composition/cut-reasons.e2e.test.ts`, the test "a member call whose receiver only the absent receiver stage could settle keeps receiver-unproven and names the absence" |
| RFC-0034 Part B designed a candidate `basis` (`typed` / `named`) and the receiver-hierarchy `cause`; neither is built: `Cut` has `reason`, `subReason`, `cause` (dispatch constructs only) and no `basis` | `Cut`, `src/core/domain/shared/fact.ts:197-222`; RFC-0034 "Slices" (slice 4 not built, slice 5 built for dispatch only) |
| The producers of `receiver-unproven` / `callee-unknown`: `trace-walk.ts` (every `callCut` and `unresolvedAt` site without an explicit reason) and `reverse-calls.ts:257` (`intoDeclarations`, always `receiver-unproven`, no sub-reason, reach `anything`); no other file under `src/core` emits either reason | `rg -n "receiver-unproven\|callee-unknown\|callCut\(" src/core --glob '!*.test.ts'` |
| The corpus manifest declares `--node-modules` in 0 queries and `--jdk` in 2; each of the two writes the machine path of a JDK into the manifest | the manifest, outside the repository: `rg -c -- '"--node-modules"\|"--jdk"'` |
| Four queries pass `--depth 1`; they hold all 36 `trace/java/depth` cuts; the engine has no default depth | `src/cli/main.ts` usage line "budget: ... none has a default"; the manifest |
| `trace` accepts `--jdk` and refuses `--node-modules`; `impact` and `callers` accept `--node-modules` and refuse `--jdk`; `map`, `importers`, `outline`, `workspace`, `decisions`, `contract-consequences` accept neither | `parseTraceRequest` (options without `NODE_MODULES_OPTION`), `parseImpactRequest`, `parseCallersRequest`, `src/cli/main.ts` |
| Of the five TypeScript repositories of the corpus, 3 hold a lockfile at the pinned commit; none has an installed `node_modules` today (`fd -HI -t d -d 3 '^node_modules$'` over the four workspaces printed nothing) | `git cat-file -e <sha>:package-lock.json` per repository; the command above |
| The gate pairs answers by id and compares them byte for byte between a base and a candidate engine; it has no notion of two arms of one query | `report`, `compareAnswers`, `scripts/corpus-gate.ts` |

**Root cause.** A cut is built where the walk gives up, from the candidate list at hand, so the reason and the label are
functions of the list's length. The knowledge that decides the label (which link of the binder's chain failed, which
flag the receiver reading set) lives one layer below and has no field to travel in: `CallBinding.unbound` has no cause,
and the readings' flags are consumed inside `settleDeclared`. Separately, the corpus asks the engine its questions
without the two inputs the engine is designed to read (ADR-0037, ADR-0063), so the ledger measures a state no user
runs, and it cannot tell a gap of the engine from a gap of the input.

## Design

### Part A: a call cut states its cause

#### The owner

`src/core/application/navigation/call-binding.ts` owns the cause: it already owns "what a call the index left without a
target binds to, for every family" (ADR-0041 decisions 1 and 4), it is the one place where a `ReceiverMethod` answer
and a `ReceiverProof` meet a form, and trace and the reverse walk both read its output. The trace walk and
`reverse-calls.ts` only copy the cause into the cut. The vocabulary lives in `src/core/domain/shared/fact.ts`, beside
the closed sets the ledger, the MCP schema and the protocol already read, so no consumer needs a translation.

#### The states the binder is in (complete table)

"Today" is the cut as it leaves the walk now; "After" changes only `subReason` (the `reason` of every row stays).

| # | State (the exact situation) | Held at | What the binder knows | Today | After (`subReason`) |
|---|---|---|---|---|---|
| S1 | The callee name is computed: `x[k](...)`, `(f)(x)` | `bindCalls`, the `callee.form === "computed"` branch; `unbound` form `computed` | `calleeOf` found no identifier | trace: `callee-unknown`, none; callers/impact: `receiver-unproven`, none | `callee-computed` |
| S2 | `this.m(...)`, the class declares several `m`, no overload rule selects one | `bindCalls`, `members.length > 1` branch; `unbound` form `own` | the members of the name in the class | `receiver-unproven`, none | `members-unselected` |
| S3 | A name written without receiver that no import, no declaration of its file and no library root binds | `bindCalls`, bare branch for a non-nominal language (`unbound` form `bare`); `settleDeclared` for a nominal bare call answered `unknown` | `rootBindings` and `origins` found nothing | `receiver-unproven` when homonyms exist, else `callee-unknown`; none | `callee-unbound` |
| S4a | Reading `unproven` with `repositoryWide` | `ReceiverMethod`, `import-origins.port.ts:319` | the reading proves no call of the repository | `receiver-unproven`, none (flag dropped) | `repository-wide` |
| S4b | Reading `unproven` with `open` (and candidates) | same | the hierarchy is open through a type outside the repository | `receiver-unproven`, none | `hierarchy-open` |
| S4c | Reading `unproven` with a non-empty `candidates`, not `open` | same | the receiver's type is established, its hierarchy read whole, and the type offers these declarations | `receiver-unproven`, none | `members-unselected` |
| S4d | Reading `unproven` with no list (or an empty one), not `repositoryWide` | same | a typed or value-held receiver, or an expression receiver, whose member the reading did not settle | `receiver-unproven` with the homonyms, or `callee-unknown`; none | `unproven` |
| S4e | Reading `outside` | same; trace demotes it (`unprovenOutside`) | the receiver's declared type, or the one supertype its hierarchy is open through, is outside the repository | `receiver-unproven`, none | `receiver-outside` |
| S4f | Reading `unknown` with `reason: capability-absent` | same | the language pack declares the stage absent | `receiver-unproven` or `callee-unknown`, `capability-absent` | `capability-absent` (TypeScript: S4g after U6) |
| S4g | Reading `unknown` without reason | same | the reading established no receiver obligation (site not placed, receiver a name with no declared type) | none | form `member`: `receiver-untyped`; form `bare`: `callee-unbound` |
| S4h | A chaining call (`super(...)`, `this(...)`), form `chain`, reading not settled | `settleDeclared` chain branch | the constructors of the class, or none | `receiver-unproven` or `callee-unknown`, none | `unproven` (`capability-absent` when the reading says so) |
| S5 | A member call with a receiver proof the walk could not turn into a step | `settleReceiver`; table `causeOfProof` below | the proof's link and holds | `receiver-unproven` or `callee-unknown`, none | per `causeOfProof` |
| S6 | A resolved index edge whose receiver root is a parameter or a lexical binding | `bodyOf`, `verdict.root.kind` `local-parameter` or `lexical` | the root binds a name no declaration types | `receiver-unproven`, none | `receiver-untyped` |
| S7 | A resolved index edge or a call dropped under an external or global root the repository replaces | `bodyOf` `leafUnlessReplaced` callbacks; `syntaxBody` outside branch | the root is replaced by repository code | `receiver-unproven` or `callee-unknown`, none | `unproven` |
| S8 | A declaration two framework bindings claim | `bodyOf`, `bindingConflict` branch | the claims' places | `receiver-unproven` (places listed) or `callee-unknown`, none | `binding-conflict` |
| S9 | A constructed receiver whose class root is neither ambient nor external | `bodyOf`, `constructed` loop | the root origin is unknown | `receiver-unproven`, none | `receiver-untyped` |
| S10 | A receiver whose reading was settled by name because a nominal annotated type did not prove the member | `bodyOf`, `annotated` loop, `type?.kind === "nominal"` | the class is nominal; execution of the member is not proven | `receiver-unproven`, none | `unproven` |

Producers outside trace: `reverse-calls.ts` `intoDeclarations` (callers and impact) cuts every `unbound` binding and every
`receiver` binding with neither a target nor a proven outside receiver, always as `receiver-unproven`; it receives S1
to S4 and S5 through the same `SettledBinding`. `edge-targets.ts` `declaredMethodsOf` turns readings into `UnprovenCall`
values that become `name-only` cuts (another reason), not call cuts; it is not changed.

#### The contract

`src/core/domain/shared/fact.ts`:

```ts
/** The causes a call cut states as its sub-reason, one per state the binder or its receiver reading establishes. */
export const CALL_CAUSES = [
  "binding-conflict",   // two framework bindings claim the declaration the call is written in
  "repository-wide",    // the reading proves no call of the repository, so its answer says nothing of this call
  "hierarchy-open",     // the receiver's hierarchy is open through a type outside the repository
  "members-unselected", // the receiver's type is established and offers declarations of the name; no rule selects one
  "receiver-outside",   // the receiver's declared type, or the one supertype its hierarchy is open through, is outside the repository
  "receiver-untyped",   // the reading established no type for the receiver
  "callee-computed",    // the callee name is computed
  "callee-unbound",     // a name written without receiver that no declaration, import or library root binds
] as const;

/** The sub-reasons of a call cut; `unproven` states that nothing narrower is established, `capability-absent` that the pack declares the stage absent. */
export type CallCause = (typeof CALL_CAUSES)[number] | "unproven" | typeof CAPABILITY_ABSENT;

export const CUT_SUB_REASONS = [...DISPATCH_UNKNOWN_REASONS, "several-bodies", "overridable", ...CALL_CAUSES, "unproven", CAPABILITY_ABSENT] as const;
```

`CallCause` is a subset of `CutSubReason`, so a cause is a sub-reason without translation. The new members sit before
`unproven` because `factOfCuts` keeps, at one place with equal reach and reason, the sub-reason that comes first
(`standsOver`, `fact.ts:357`): a specific cause must stand over `unproven` and over no sub-reason. The relative order of
the existing members does not change.

`src/core/application/navigation/call-binding.ts`:

```ts
import type { CallCause } from "../../domain/shared/fact.ts";

export type CallBinding =
  | { kind: "declaration"; target: GraphSymbol; link: "own-member" | "chain" | "import" | "file" | "declared-receiver" | "bound-receiver" | "overload" }
  | { kind: "receiver"; proof: ReceiverProof; target?: GraphSymbol; declaration?: ModelDeclaration; outside?: true; dispatch?: OutsideDispatch; candidates: readonly GraphSymbol[]; attributed: readonly GraphSymbol[] }
  | { kind: "outside"; form: "bare" | "chain"; origin: Outside }
  | { kind: "unbound"; form: "own" | "computed" | "bare" | "member" | "chain"; candidates: readonly GraphSymbol[]; attributed: readonly GraphSymbol[]; cause: CallCause }
  | DeclaredBinding;

/** What a settled call left unproven, as a cut states it: the cause of an `unbound` binding, or the one its receiver proof or outside dispatch establishes. */
export function causeOfBinding(binding: Extract<CallBinding, { kind: "unbound" | "receiver" }>): CallCause;
/** What a receiver proof establishes about a member call the walk could not follow. */
export function causeOfProof(proof: ReceiverProof): CallCause;
/** What the receiver reading's answer establishes for a call of this form; `undefined` is an answer that never came. */
export function causeOfReading(answer: ReceiverMethod | undefined, form: DeclaredBinding["form"]): CallCause;
```

`cause` is required on `unbound`: every construction site must state one, and the compiler lists the sites. There is no
"unstated" member: `unproven` is the not-established member, and it is an answer, not an omission.

`causeOfReading` (the one rule for a reading; ordered, first row that matches):

| Answer | `form` | Cause |
|---|---|---|
| `unknown`, `reason: capability-absent` | any | `capability-absent` |
| `unproven`, `repositoryWide: true` | `member`, `bare` | `repository-wide` |
| `unproven`, `open: true` | `member`, `bare` | `hierarchy-open` |
| `unproven`, `candidates` with at least one entry | `member`, `bare` | `members-unselected` |
| `outside` | `member`, `bare` | `receiver-outside` |
| `unknown` (no reason) or `undefined` | `bare` | `callee-unbound` |
| `unknown` (no reason) or `undefined` | `member` | `receiver-untyped` |
| anything else (`unproven` with no list, `method`, `generated`, `supplied`, any answer at `form: "chain"`) | any | `unproven` |

`causeOfProof` (the one rule for a receiver proof; first row that matches):

| Proof | Cause |
|---|---|
| `link: "none"` | `receiver-untyped` |
| `link: "field"` or `"local"`, `replaceable` not set, `holds` without `external`, `type` undefined and `holds.class` undefined | `receiver-untyped` |
| `link: "syntax"`, `replaceable` not set, `holds.kind` `computed` or `returned` | `receiver-untyped` |
| every other proof (`member`, `external`, a `replaceable` proof, a field or local whose type is placed, a syntax proof of another kind) | `unproven` |

`causeOfBinding(binding)`: `unbound` returns `binding.cause`; `receiver` returns `receiver-outside` when
`binding.outside === true && binding.dispatch !== undefined`, otherwise `causeOfProof(binding.proof)`.

The soundness of each cause, and the input that would break it:

| Cause | Why it cannot be false | The input that would break it, and how it is excluded |
|---|---|---|
| `callee-computed` | emitted only from `calleeOf(...).form === "computed"`, a syntactic fact | none: the spelling is the evidence |
| `callee-unbound` | emitted only where `rootBindings` and `origins` answered nothing for the name, or the reading is `unknown` for a bare call | a name bound by a construct the readers do not model would be labelled unbound: the label says "no declaration, import or library root binds it" as the readers read it; it states the reading, never the world |
| `receiver-untyped` | emitted only from `unknown`, a `none` proof, a proof whose type is unplaced, or an expression no rule binds: in each, the reading established no type | an answer `unknown` for a site the reader could not place (a file it did not parse) is also "no type established": true, and the cut still lists the declarations of the name |
| `receiver-outside` | emitted only from the `outside` answer, whose contract is "the declared type, or the one supertype the hierarchy is open through, is outside the repository" | a reading wrongly answering `outside` is the reading's defect, not the label's |
| `members-unselected` | emitted only from `unproven` with a non-empty list the reading read from a whole hierarchy (port contract) | a list read from a hierarchy not read whole: the port states `candidates` are present only then |
| `hierarchy-open` | emitted only from `open: true`, set only with a candidate list | none |
| `repository-wide` | emitted only from `repositoryWide: true` | none |
| `binding-conflict` | emitted only from `bindingConflict` | none |
| `unproven`, `capability-absent` | the first says nothing beyond the answer; the second needs the reading's own `reason` | none |

The label never changes what the walk does: no step, no status, no `reason` depends on a cause (rule 3 of ADR-0130).

#### Where each state reaches the cut: the changed functions

`src/core/application/navigation/call-binding.ts`

1. `bindCalls`, the `members.length > 1` branch: the `unbound` form `own` gets `cause: "members-unselected"`.
2. `bindCalls`, the computed branch: `cause: "callee-computed"`.
3. `bindCalls`, the non-nominal bare branch: `cause: "callee-unbound"`.
4. `settleDeclared`: both `unbound` returns of the `form === "chain"` branch get `cause: causeOfReading(answered,
   form)`; the final
   `unbound` gets `cause: causeOfReading(answered, form)`. `answered` is the argument as received, before the local
   demotion of `generated`, `supplied` and `outside` to `unproven`; the demotion stays and only builds `method`.
5. New exported functions `causeOfBinding`, `causeOfProof`, `causeOfReading` as above.

`src/core/application/trace/trace-walk.ts` (locate by symbol)

6. `settleReceiver`: after the early return for `declaration`, `const why = causeOfProof(proof);`; every call of
   `settleByName` in its body (inside `step`, inside `outside`, the `replaceable` branch, the `returned` branch twice,
   the `literal` branch, the final fallthrough) passes `why` as the fifth argument (`subReason`). `settleByName`
   already accepts it and forwards it to both of its cuts.
7. `settleBinding`: the third parameter becomes `cause?: CallCause` (was `absent?: CutSubReason`). The `outside` branch's
   two cuts pass `"unproven"`. The `member` branch calls `settleByName(reference, name, binding.candidates, false, cause
   ?? binding.cause)`; the last line
   calls `unresolvedAt(reference, binding.candidates, undefined, cause ?? binding.cause)`. At those two lines `binding` is
   `unbound` by narrowing.
8. The `unproven` edge loop: its `unproved` callback becomes `() => void cuts.push(unresolvedAt(reference, named,
   undefined, "receiver-untyped"))`.
9. The `references` loop: `callCut(place, candidates, undefined, binding.kind === "unbound" ? binding.cause :
   binding.kind === "receiver" ? causeOfBinding(binding) : undefined)`.
10. The `constructed` loop: the replaced branches pass `"unproven"` and the final `settleByName(reference, name, named)`
    passes
    `"receiver-untyped"`; the `annotated` loop passes `"unproven"` in its three `settleByName` calls.
11. The receiver readings: keep the raw answers. Where `found` is built (`receiverSites.length === 0 ? [] : (await
    origins.receiverMethods(receiverSites, signal)).map(executed)`),
    build `const read = receiverSites.length === 0 ? [] : await origins.receiverMethods(receiverSites, signal);`, then
    `const found = read.map(executed);`
    (as today) and
    ```ts
    const formOf = (index: number): DeclaredBinding["form"] => (index < placedCalls.length ? "member" : typed[index - placedCalls.length]!.declared?.form ?? "member");
    const causes = read.map((answer, index) => causeOfReading(answer, formOf(index)));
    ```
    (`causes` is computed from the answer before `executed` demotes `outside` and a type-variable `method`, which is why
    it is not computed
    from `found`.) In the resolved-edge loop the cut of the `receiver !== undefined && receiver.kind !== "unknown" &&
    proven === undefined`
    branch passes `causes[placedCalls.indexOf(followed)]` as the sub-reason (`placedCalls.indexOf(followed)` is the
    index the
    existing `receivers` map was built with: build a `causeOf` map beside `receivers` with the same keys); the two
    `verdict.root` branches pass
    `"receiver-untyped"` (`local-parameter`, `lexical`) and `"unproven"` (external or global root replaced): these two
    causes are facts of the
    verdict's root, not readings.
12. The typed loop: `absent` is deleted. `const cause = causes[placedCalls.length + index]!`; `unresolvedAt(reference,
    runs.candidates, undefined, cause)`;
    `settleBinding(reference, settled, cause)`; `settleByName(reference, name, named, false, cause)`.
13. `syntaxBody`: the outside-replaced cut passes `"unproven"`; the final cut passes
    `binding.kind === "unbound" ? binding.cause : binding.kind === "receiver" ? causeOfBinding(binding) : undefined`.
14. The `bindingConflict` cut passes `"binding-conflict"`.
15. `callCut` keeps its parameters and its reason default: the candidate count still chooses the `reason`
    (rule 3 of ADR-0130), and no code path chooses a `subReason` from it.

`src/core/application/navigation/reverse-calls.ts`

16. `intoDeclarations`: the cut gets `subReason: causeOfBinding(binding)`; the condition of the `if` is unchanged, and
    `binding` is narrowed to `unbound | receiver` by a local `const open = binding.kind === "unbound" || (...)`.

`src/core/adapters/typescript/this-receiver-methods.ts`

17. `UNKNOWN` becomes `{ kind: "unknown" }`, and its comment says: a site this reading does not type. The pack
    implements the reading;
    `capability-absent` is the pack's declaration (ADR-0045 decision 12) and no longer this adapter's answer.

#### Consumers that learn the new members

| File | Change |
|---|---|
| `src/core/domain/shared/fact.ts` | `CALL_CAUSES`, `CallCause`, `CUT_SUB_REASONS` as above |
| `scripts/corpus-gate-ledger.ts` `keyOf` | none: it validates against `CUT_SUB_REASONS`; a sub-reason outside the set stays a `CutLedgerError` (RFC-0031 rule 1) |
| `scripts/corpus-gate.ts` | none for the vocabulary; U7 adds the causes table |
| `src/mcp/composition-schema-parts.ts` `cut` | none: `z.enum(CUT_SUB_REASONS)` |
| `src/composition/mcp-composition-schema.test.ts` | none: it loops over `CUT_SUB_REASONS` |
| `src/mcp/presentation-context.ts` `cutReasonText` | none: it prints `reason (subReason)` |
| `src/mcp/render.ts` `traceCallGroupLines`, `COUNTED_CAUSES` | none: groups by the printed `why`, which now includes the sub-reason; the collapse tests the first word, the reason |
| `src/mcp/select-evidence.ts` | none: forwards `subReason` |
| CLI (`src/cli/main.ts`), protocol, `src/mcp/server.ts` | none: no enumeration of sub-reasons (`rg -n subReason src` lists only the files above and `impact-cuts.ts`) |
| `src/composition/cut-reasons.e2e.test.ts` | two tests change in U6 |
| `src/core/adapters/typescript/this-receiver-methods.test.ts` | three expectations change in U6 |
| every test that fakes an `unbound` binding | gains `cause`: `trace-walk.test.ts` (three fakes), `base-reading.test.ts`, `reverse-calls.test.ts` (five), `call-binding.test.ts` summary helper |

How the MCP text names each cause: the sub-reason is printed in parentheses after the reason, verbatim, by
`cutReasonText`; the identifier is the phrase. The exact phrases an agent reads:

| Printed | Reads as |
|---|---|
| `receiver-unproven (receiver-untyped)` | the reading established no type for the receiver |
| `receiver-unproven (members-unselected)` | the type is known, several declarations of the name remain |
| `receiver-unproven (hierarchy-open)` | the hierarchy is open through a type outside the repository |
| `receiver-unproven (receiver-outside)` | the receiver's type is outside the repository |
| `receiver-unproven (repository-wide)` | the reading proves no call of the repository |
| `receiver-unproven (unproven)` | nothing narrower is established |
| `receiver-unproven (callee-unbound)` | no declaration, import or library root binds the name |
| `callee-unknown (callee-computed)` | the callee name is computed |
| `receiver-unproven (binding-conflict)` / `callee-unknown (binding-conflict)` | two framework bindings claim the declaration |

The summary groups each printed `why` on its own line and the existing collapse (`receiver-unproven: N calls in F files,
M names`)
applies per `why`; no gloss line is added, so a summary stays as long as today's.

#### Noise: one cause that is one cut per call

`repository-wide` is the repository-wide case: one fact (the reading proves no call of the repository) emits one cut per
call. This RFC labels it and nothing more. The ledger already keys rows by sub-reason and records `answersWith` per
row, so the cause count is the number of answers holding the row, not the number of cuts; U7 prints it as the column
`Answers`. Whether the cut is emitted once per answer, and where its scope ends, is RFC-0047's design; this RFC does
not change how many cuts exist.

#### The TypeScript label

The `typed` queue of a TypeScript call reaches the receiver reading only after the proof and `declaredTypes` established
nothing (an annotation of a repository class proves no class under structural typing: ADR-0029 decision 9). The pack's
reading covers `this` and `super` and answers `unknown` elsewhere. Rule: the answer `unknown` with no reason means the
receiver is untyped (S4g); `capability-absent` stays what ADR-0045 decision 12 defines, the pack declaring the stage
absent, which no pack does for `receiverMethods` today. So:

| Site | Sub-reason today | After U6 |
|---|---|---|
| a typed-queue call, reading `unknown` (TypeScript pack, any receiver but `this`/`super`) | `capability-absent` | `receiver-untyped` |
| the same call, form `bare` | `capability-absent` | `callee-unbound` |
| a typed-queue call whose reading is `unproven` (a `this` member with several declarations) | none | S4b–S4d |
| `dispatch` cut of the TypeScript pack (`dispatchTargets` declared absent) | `capability-absent` | unchanged |
| `relation-unread` and `constructor-unsettled` with `capability-absent` | `capability-absent` | unchanged |

#### What Part A deliberately does not do

- It changes no `reason`, no status, no step, no candidate list. `callCut` still chooses `receiver-unproven` or
  `callee-unknown` by the list, which leaves a computed callee with homonyms as `receiver-unproven (callee-computed)`;
  the pair states both honestly, and renaming the reason is a separate decision with a ledger migration.
- It adds no `cause` places: the binder holds none for these causes (`ReceiverMethod` carries a hierarchy flag, not
  the supertype clause). RFC-0034 slice 5 for the receiver hierarchy stays unbuilt, with the answer stated in "Not
  covered".
- It does not build RFC-0034's candidate `basis` field. ADR-0074 decision 6 is met by the sub-reason (ADR-0130 rule 5):
  a list is `typed` exactly when its cut's sub-reason is `members-unselected` or `hierarchy-open`.

### Part B: the corpus declares what the engine can read

#### What each command accepts (verified in `src/cli/main.ts`)

| Command | `--jdk` | `--node-modules` |
|---|---|---|
| `trace` | yes, repeatable, `[<at>=]<path>` | no (usage error) |
| `impact`, `callers` | no (usage error) | yes, repeatable, `[<at>=]<path>` |
| `init`, `mcp` | yes | yes |
| `map`, `importers`, `outline`, `workspace`, `decisions`, `contract-consequences` | no | no |

Consequences for the corpus: only `trace` over a repository with Java sources can declare `--jdk`; only `impact` and
`callers` over a repository with an install can declare `--node-modules`. A TypeScript `trace` cannot declare it
(not covered; RFC-0044 owns that question).

#### The manifest

`scripts/corpus-gate.ts` `ManifestSchema` gains two optional parts; both are additive and a manifest without them is read
as today.

```ts
buildOutputs: z.strictObject({
  /** A JDK home, absolute or relative to the manifest's directory. */
  jdk: z.string().min(1).optional(),
  /** Per repository id, an installed node_modules directory, absolute or relative to the manifest's directory. */
  nodeModules: z.record(Id, z.string().min(1)).optional(),
}).optional()   // top level, beside `groups`
```

and, on a query:

```ts
/** This query is the declared twin of the query `of` of its group: the same question with outputs declared. */
declares: z.strictObject({ of: Id }).optional()
```

Placeholders in `argv`, expanded where `{repo:...}` is expanded (`runGroup`, the `argv` map): `{jdk}` becomes the resolved
`buildOutputs.jdk`; `{node-modules:<repo-id>}` becomes the resolved `buildOutputs.nodeModules[<repo-id>]`. The `argv`
recorded in an answer stays declared (with placeholders), so no report names a machine path. The gate environment is
unchanged (it already passes only `PATH` and its own `HOME`); the paths are argv, not environment.

Validation at read (`readManifest`), each a `GateFault("invalid-manifest", ...)`:

1. `{jdk}` in an `argv` requires `buildOutputs.jdk`.
2. `{node-modules:<id>}` requires `buildOutputs.nodeModules[<id>]` and `<id>` a repository of the query's group.
3. `declares.of` names another query of the same group with the same `family`, which has no `declares` and whose `argv`
   holds no output placeholder; the twin's `argv` holds at least one.

Validation before any run (`checkBuildOutputs`, beside `checkCorpusRevisions`), `GateFault("missing-build-output",
detail)`
(a new member of `GateFaultCode`): the JDK directory holds `lib/ct.sym`; each node_modules path is a directory.

#### Which queries declare what (the generator's rule, over git alone)

| Query | Declared twin when | Argument added after the command word |
|---|---|---|
| `trace` with a target `{repo:<id>}` that is not a `--workspace` query | the repository holds at least one tracked `.java` file at its pinned commit | `--jdk {jdk}` |
| `impact`, `callers` | `<outputs>/<group>/<id>/node_modules` exists | `--node-modules {node-modules:<id>}` |
| every other query, and every `trace --workspace {workspace}` query | never | none (it refuses the flag, or its launch repository has nothing to declare) |

A twin has the id `<id>.declared` (ids allow `.`), the family of the original, `trusted` as the original, and `declares:
{ of: "<id>" }`.
The two queries that carry a machine-path `--jdk` today become the undeclared originals plus a twin, so the machine path
leaves their `argv`.

The JDK is one declaration for the whole corpus: `buildOutputs.jdk`, written by the generator from the environment
variable `GATE_JDK_HOME` (required; the generator fails without it). The repository never holds the path. A JDK
whose feature release is lower than a release a build file states makes the declaration unusable: the answer carries
a `jdk-older-than-build` `build-output` cut (ADR-0063), which is what the declared arm exists to show.

#### The two arms and where the comparison is produced

Duplicate, do not switch. Switching would change what the ledger measures with no way to see the difference; the
declared arm is the experiment and the undeclared arm is the control, and the ledger must show both per row.

| Option | Cost | Verdict |
|---|---|---|
| Switch every query to its declared form | no extra time; the baseline row `trace/java/receiver-unproven 129` stops being comparable with history and the effect of the inputs is invisible | rejected |
| Twin each declarable query (chosen) | 20 Java `trace` twins plus 7 to 12 `impact`/`callers` twins (7 for the three repositories whose commit holds a lockfile, up to 12 if the other two install), counted on the manifest: 27 to 32 more answers on the 118 of the baseline (+23% to +27% by count); trace answers dominate the 171 s of the last run, so U13 reads the real figure; no extra code in the engine | chosen |
| Run the gate twice, with two manifests | doubles the time and splits the report in two files | rejected |

Ledgers. The main ledger of each side counts every answer of a query that has no `declares` (as today, comparable with
history; the originals of twins stay in it). A second pair of ledgers counts only the twins (`with`) and only the
originals that have a twin (`without`); their difference per row is the new report section. The gate compares twin
answers base against candidate like any answer: they count in `answers`, `differing` and the family summaries.
`--expect` and `--expect-cuts` act on the whole comparison and the main ledger respectively, never on the declared pair.

`scripts/corpus-gate-ledger.ts` gains, pure and with no I/O:

```ts
/** The twins of a side's answers: `twins` maps a twin's answer id to the id of its original. */
export interface DeclaredArms { without: readonly Answer[]; with: readonly Answer[]; rest: readonly Answer[] }
export function declaredArms(answers: readonly Answer[], twins: ReadonlyMap<string, string>): DeclaredArms;

/** One ledger key's values in the pair of arms; `null` where the arm holds no cut of the key. */
export type DeclaredPairRow = LedgerKey & { without: LedgerValues | null; with: LedgerValues | null };
export function declaredPairs(without: CutLedger, withOutputs: CutLedger): DeclaredPairRow[];
```

`rest` holds every answer that is neither an original of a twin nor a twin; the main ledger is built from `rest` and
`without` (all the undeclared answers). `declaredPairs` merges the rows of the two ledgers by `keyText`, sorted by it, as
`ledgerDifference` does.

The report body (`ReportBody` in `corpus-gate.ts`) gains

```ts
declared: { base: DeclaredSection; candidate: DeclaredSection }
interface DeclaredSection { pairs: number; without: CutLedger; with: CutLedger; rows: DeclaredPairRow[] }
```

and `report.md` gains, after `## Cut ledger` and before `## Value ledger`:

```
## Declared build outputs

N queries ran twice, without and with the declared JDK and node_modules (candidate side). Answers complete/partial/unknown, without → with.

| Family | Without | With |
|---|---|---|
| trace | 3/9/0 | 4/8/0 |

### Rows

| Family | Language | Kind | Reason | Sub-reason | Without | With |
|---|---|---|---|---|---|---|
| trace | java | unresolved-link | receiver-unproven | hierarchy-open | 30 (12.4/100 steps) | 22 (9.1/100 steps) |

### Base side

(the same two tables for the base engine)
```

A row one arm lacks prints `—`. The `build-output` rows of the "with" arm are the visible cost of an output the engine
could not
use. With no twin in the manifest the section prints `No query declares build outputs.`.

#### The `--depth 1` distortion

The four queries that pass `--depth 1` are callback entrypoint traces, one per Java repository with a callback entrypoint.
They hold all 36 `trace/java/depth` cuts, at 163.64 per 100 steps: the largest per-step row of the ledger, produced by
the manifest. Decision: **the four lose the flag.** A bound the manifest does not ask for never occurs (no budget has a
default), so the row disappears with the input that made it, and no ledger block for "bounds the manifest asked for"
is built (it would stay empty). The risk is that a callback trace without a bound does not finish; U12 measures each
of the four alone before the edit and states the table: all four finish with `exit 0` and a `partial` or
`complete` fact, the flag is removed; any that does not, stop and report (the owner decides a measured `--expansions`).

#### What is committed and what is not (ADR-0039 decision 2)

| Committed in the repository | Not committed (outside the repository) |
|---|---|
| `scripts/corpus-gate.ts`, `scripts/corpus-gate-ledger.ts`, their tests | the manifest `corpus.json`, `generate.mjs`, `groups.json`, the new `prepare-outputs.mjs` |
| `src/**` of Part A with tests | the installed `node_modules` trees and the JDK path |
| ADR-0130, ADR-0131, this RFC | every gate report |

## Delivery units

| Unit | Goal | Prerequisites | Gate expectation |
|---|---|---|---|
| U1 | Measure the base ledger and the gate's cost on the unchanged tree | none | none (no change) |
| U2 | The eight causes exist in the closed set, ordered | U1 | `--expect none` |
| U3 | The binder states a cause on every `unbound` binding | U2 | `--expect none` |
| U4 | Trace writes the cause as the sub-reason of every call cut | U3 | `--expect trace:±` |
| U5 | Callers and impact write it on their `receiver-unproven` cuts | U3 | `--expect callers:± --expect impact:±` |
| U6 | The TypeScript receiver label says the receiver is untyped | U4 | `--expect trace:±` |
| U7 | The gate report prints the causes and the reasons that moved | U2 | none (scripts) |
| U8 | Measure the ledger after Part A | U4, U5, U6, U7 | none (no change) |
| U9 | The gate reads declared build outputs and expands their placeholders | none | none (scripts) |
| U10 | The gate pairs twins and prints the declared section | U9 | none (scripts) |
| U11 | The manifest declares the JDK and the installs (outside the repository) | U10 | measurement |
| U12 | The four callback queries lose `--depth 1` (outside the repository) | U11 | measurement |
| U13 | Record the first declared run | U12, U8 | measurement |

Part A comes first and changes no answer's status and no `reason`: the gate expectation is "detail only", checked by the
report line U7 adds. Part B starts after U8 so that the ledger split of Part A is measured on the unchanged manifest.

Every unit that edits code runs `npm run check` and, for the changes under `src/core/`, the corpus gate once, before the
merge (AGENTS.md "Scope and verification"): `node --import tsx scripts/corpus-gate.ts --corpus <manifest> --base main
--candidate <branch>`
with the `--expect` of its table. Copy the `Corpus-Gate:` line into the commit that brings the unit to `main`.

### U1: measure the base ledger and the cost of the gate

**Goal.** Record, on the unchanged tree, the numbers the next units are checked against.

**Prerequisites.** None.

**Files.** None edited. Output: one report directory outside the repository, named in the unit's commit message of the
following unit.

**Steps.**
1. In the checkout, `git status` is clean and `git log -1` names the tip of `main` that holds this RFC. Run
   `node --import tsx scripts/corpus-gate.ts --corpus <manifest> --base <tip> --candidate <tip> --out <dir>`
   with the same value for both revisions. If the gate refuses equal revisions, use the tip as base and a candidate
   that differs only by a document (the tree then differs and both engines are the same code).
2. From `<dir>/report.json` read, per side, `ledger.candidate.rows`: the cuts of the rows
   `trace/java/receiver-unproven`, `trace/java/callee-unknown`, `trace/typescript/receiver-unproven` (both
   sub-reason variants), `trace/typescript/callee-unknown`, `impact/*/receiver-unproven`, `callers/*/receiver-unproven`;
   the total cuts; the answers by family.
3. From the gate's stderr lines `candidate <id> exit=<n> <ms> ms` sum the wall time of the queries that U11 will twin:
   every `trace` of a Java repository (not `--workspace`) and every `impact` and `callers` of the repositories that
   will hold an install. Record the sum `S` and the run's total `T`.
4. Record the numbers in the pull request description of U2. Nothing is committed.

**RED test.** None: a measurement, no behavior.

**Acceptance and decision table.**

| Number read | Decision |
|---|---|
| total cuts = 436 and `trace` answers = 28 | the baseline of the 2026-11-17 report stands: U8 compares against it |
| total cuts ≠ 436, or an answer count differs | record the new numbers and U8 compares against them; also report the difference to the owner |
| `receiver-unproven` + `callee-unknown` cuts of `trace/java` = 191 (129 + 62) | U8 expects the same sum split over sub-reasons |
| `S` and `T` | no decision depends on them; U13 compares the real cost of the twins with `S` |

**Corpus gate expectation.** None: no change.

**Risk.** none.

**Stop conditions.** The gate faults (`dependencies-differ`, `missing-revision`): report the fault; do not edit the
manifest.

### U2: the eight causes exist in the closed set, ordered

**Goal.** Add `CALL_CAUSES` and the type `CallCause`, and place them in `CUT_SUB_REASONS` before `unproven`.

**Prerequisites.** U1.

**Files to edit.** `src/core/domain/shared/fact.ts` (symbol `CUT_SUB_REASONS`), `src/core/domain/shared/fact.test.ts`
(beside the test "two cuts at one place with reaches of equal width leave the one whose reason, then sub-reason, comes
first"),
`src/mcp/render.test.ts` (beside the test using `capability-absent` receiver cuts). Do not touch `scripts/` or any
`src/mcp` production file.

**Steps.**
1. In `fact.ts` add the `CALL_CAUSES` constant and `CallCause` type of "The contract", with the one-line comments given
   there
   as the doc comments of the members (the file's style documents each closed set; a member's meaning is not evident
   from its name).
2. Replace the definition of `CUT_SUB_REASONS` by `[...DISPATCH_UNKNOWN_REASONS, "several-bodies", "overridable",
   ...CALL_CAUSES, "unproven", CAPABILITY_ABSENT] as const`.
3. Update the doc comment above it: "What narrows a reason: why a dispatch was not proven, the cause of a call cut, or
   that the stage which would settle the cut is absent."

**RED test.** `src/core/domain/shared/fact.test.ts`, name "a specific call cause stands over unproven and over no
sub-reason at one place, whatever the order of emission":
```ts
import { CALL_CAUSES, factOfCuts, type Cut } from "./fact.ts";
const at = "src/a.ts:3 port.save";
const cut = (subReason?: Cut["subReason"]): Cut => ({ kind: "unresolved-link", at: [at], reason: "receiver-unproven", ...(subReason === undefined ? {} : { subReason }), reach: { kind: "call-at", place: at } });
for (const cause of CALL_CAUSES) {
  for (const order of [[cut("unproven"), cut(cause), cut()], [cut(), cut(cause), cut("unproven")]]) {
    assert.deepEqual(factOfCuts(BASE, null, order).cuts?.map(({ subReason }) => subReason), [cause]);
  }
}
```
(`BASE` and the import style are the file's own; reuse its fact base.) Before the change `CALL_CAUSES` is not exported:
the
test fails with a missing export. After: it passes. Sibling path: the existing ordering test over the dispatch
sub-reasons stays unchanged and passes.

`src/mcp/render.test.ts`, name "a trace summary prints a call cut's cause after its reason and counts each cause on its
own line": three
`receiver-unproven` cuts at three places with sub-reasons `hierarchy-open`, `receiver-untyped`, `receiver-untyped` (the
fixture shape of the existing
test with `capability-absent`): `renderTrace(fact)` includes `    receiver-unproven (hierarchy-open): ...` and
`    receiver-unproven (receiver-untyped): ...` as two lines, never merged. This test passes before and after; it pins
the grouping by printed `why`.

**Acceptance.**
- Owner: `fact.ts` is the one definition of the vocabulary. Contract: written above. No second path: `rg -n
  '"receiver-untyped"' src` finds only `fact.ts`, tests and (after U3) `call-binding.ts`.
- No chain of special cases: the order is data. Fitness function: `fact.test.ts` iterates `CALL_CAUSES`, so a member
  added later without its place in the order is exercised.
- `npm run check` passes; `scripts/corpus-gate-ledger.test.ts` and `src/composition/mcp-composition-schema.test.ts` pass
  unchanged (they read `CUT_SUB_REASONS`).

**Corpus gate expectation.** `--expect none`: no emitter uses a member, every answer is identical.

**Risk.** none (additive members of a closed set no emitter uses yet).

**Stop conditions.** `CUT_SUB_REASONS` no longer matches the definition above (another branch changed it): stop and
report.

### U3: the binder states a cause on every `unbound` binding

**Goal.** `CallBinding.unbound` carries `cause`, and the three reading rules exist and are tested.

**Prerequisites.** U2.

**Files to edit.** `src/core/application/navigation/call-binding.ts`; tests:
`src/core/application/navigation/call-binding.test.ts`,
and the fakes in `src/core/application/trace/trace-walk.test.ts`, `src/core/application/snapshot/base-reading.test.ts`,
`src/core/application/navigation/reverse-calls.test.ts` (each `kind: "unbound"` literal gains `cause: "unproven"`),
`src/composition/edge-targets.single-rule.test.ts`. Do not touch `trace-walk.ts`, `reverse-calls.ts` or
`edge-targets.ts`.

**Steps.**
1. Add the `cause: CallCause` field to the `unbound` variant of `CallBinding`; import `CallCause`, `CAPABILITY_ABSENT`
   from `../../domain/shared/fact.ts`.
2. Add `causeOfReading`, `causeOfProof`, `causeOfBinding` as exported functions (tables in "The contract"), above
   `createCallBindings`.
   Pseudocode for `causeOfReading(answer, form)`:
   ```
   if answer?.kind === "unknown" && answer.reason === CAPABILITY_ABSENT: return "capability-absent"
   if form === "chain": return "unproven"
   if answer?.kind === "unproven":
       if answer.repositoryWide === true: return "repository-wide"
       if answer.open === true: return "hierarchy-open"
       if (answer.candidates?.length ?? 0) > 0: return "members-unselected"
       return "unproven"
   if answer?.kind === "outside": return "receiver-outside"
   if answer === undefined || answer.kind === "unknown": return form === "bare" ? "callee-unbound" : "receiver-untyped"
   return "unproven"
   ```
3. In `bindCalls` set the three `unbound` literals' causes (steps 1 to 3 of "the changed functions"). In
   `settleDeclared` set the causes of
   the three `unbound` returns (step 4). The order of the code is not changed.
4. Fix every compile error the new required field raises in the production code (`rg -n 'kind: "unbound"' src` lists the
   sites; only the four above are production).

**RED tests** (`call-binding.test.ts`, using the file's `bound(world, body, calls)` harness and a `cause` projection:
`const causeOf = (binding: SettledBinding) => causeOfBinding(binding as Extract<SettledBinding, { kind: "unbound" |
"receiver" }>)`):
1. "a call the reading answers states the cause its answer establishes, whatever the candidates": the world of the test
   "an unsettled receiver's candidates are the members of its type, not the homonyms"
   (class `A` with two `save` members, `B.save`, call `factory().save` at line 8), run once per row with `receivers: {
   save: <answer> }`:

   | `receivers.save` | expected `causeOf` |
   |---|---|
   | (none: the harness answers `{ kind: "unknown" }`) | `receiver-untyped` |
   | `{ kind: "unknown", reason: "capability-absent" }` | `capability-absent` |
   | `{ kind: "unproven" }` | `unproven` |
   | `{ kind: "unproven", repositoryWide: true }` | `repository-wide` |
   | `{ kind: "unproven", candidates: [{ file: "src/a.ts", start: 3, nameLine: 3 }], open: true }` | `hierarchy-open` |
   | `{ kind: "unproven", candidates: [{ file: "src/a.ts", start: 3, nameLine: 3 }] }` | `members-unselected` |
   | `{ kind: "outside", type: "lib.Base" }` | `receiver-outside` (a `receiver` binding with `dispatch`) |

   Today `causeOfBinding` does not exist: the test fails. The two rows `unproven` with a list of one and a list of two
   entries must give the same cause (add a row with two entries): the cause is not a count.
2. "a bare name nothing binds, a computed callee and several own overloads state their own cause": the worlds of the
   existing tests "a bare call nothing binds is attributed only to the declarations of its own file..." (call `save`:
   `callee-unbound`), the same world with a call
   `handlers[kind]` (`unbound` form `computed`, `callee-computed`), and `overloadedOwnCall([false, false, false])` with
   `this.save` (`members-unselected`).
3. `causeOfProof`, a pure table test: `{ link: "none" }` → `receiver-untyped`; `{ link: "field", holds: { class: { path:
   "src/b.ts", symbol: "B", line: 1 } } }` → `unproven`;
   `{ link: "field", holds: { class: ... }, replaceable: true }` → `unproven`; `{ link: "syntax", holds: { kind:
   "computed" } }` → `receiver-untyped`;
   `{ link: "syntax", holds: { kind: "token", name: "S", line: 2, column: 20 } }` → `unproven`; `{ link: "member",
   proof: {...}, }` → `unproven`. (Use the field shapes of `ReceiverProof`.)
4. Sibling: the existing assertions of `call-binding.test.ts` (`summary(...)`) keep passing unchanged: `summary` does
   not read `cause`.

**Acceptance.** Owner: `call-binding.ts`. No second path: no function outside it maps an answer to a cause.
Fitness function: add to `RULES` in `src/composition/edge-targets.single-rule.test.ts` the entry
`{ concept: "the cause a receiver reading's repository-wide flag establishes", pattern: /\.repositoryWide === true/,
owner: "core/application/navigation/call-binding.ts", pending: [] }`
(today no source file matches, so the test fails; after the unit exactly `call-binding.ts` matches; `edge-targets.ts`
reads the flag as `!== true` and is not a holder).
The table test 1 enumerates every answer kind; a new `ReceiverMethod` kind falls to `unproven` by the last row of
`causeOfReading`, and the unit that adds the kind extends the table. `npm run check` passes.

**Corpus gate expectation.** `--expect none`: no cut reads `cause` yet.

**Risk.** none (an internal field; no emitter reads it).

**Stop conditions.** `settleDeclared` or `bindCalls` no longer have the branches named (rebased code); a production site
constructs `unbound` outside `call-binding.ts`.

### U4: trace writes the cause as the sub-reason of every call cut

**Goal.** Steps 6 to 15 of "the changed functions".

**Prerequisites.** U3.

**Files to edit.** `src/core/application/trace/trace-walk.ts`; tests: `src/core/application/trace/trace-walk.test.ts`,
`src/composition/trace-receivers.e2e.test.ts`, and the expectations that now see a sub-reason (see Acceptance). Do not
edit `call-binding.ts`.

**Steps.**
1. Import `causeOfBinding`, `causeOfProof`, `causeOfReading` and `CallCause` from the navigation module and the domain.
2. Apply steps 6 to 15 of "The changed functions" in the order listed. Locate each by the symbol named.
   `settleBinding`'s third parameter changes type; its callers
   are the typed loop and the `references` and `unsettled` loops (the latter two pass nothing).
3. Delete the now unused `absent` constant of the typed loop.
4. The typed-entry form for `causeOfReading`: an entry pushed with `declared` uses `declared.form`; an entry without it
   (the `annotated` fallback) uses `"member"`.

**RED tests.**
1. `trace-walk.test.ts`, name "a call cut states the cause its binding states, never one its candidate count suggests":
   copy the harness of the test "a Java receiver is settled by the binding, not by a second rule in the walk"
   with four unresolved references at lines 3 to 6, named `a.load`, `b.load`, `handlers[k]` and `run`, and `bindCalls`
   answering, in that order,
   `[{unbound, form:"member", candidates:[siblingMethod], attributed:[], cause:"members-unselected"}, {unbound,
   form:"member", candidates:[siblingMethod], attributed:[], cause:"hierarchy-open"}, {unbound, form:"computed",
   candidates:[], attributed:[], cause:"callee-computed"}, {unbound, form:"bare", candidates:[], attributed:[],
   cause:"callee-unbound"}]`.
   (A `member` binding with no candidates and nothing declared is an external leaf, not a cut, so the empty-list cases
   use the forms that always cut.)
   Assert `result.cuts.map((cut) => [cut.at[0], cut.reason, cut.subReason])` equals, after sorting by `at[0]`, the four
   places `<file>:3 a.load`, `:4 b.load`, `:5 handlers[k]`, `:6 run` with
   `["receiver-unproven","members-unselected"]`, `["receiver-unproven","hierarchy-open"]`,
   `["callee-unknown","callee-computed"]`, `["callee-unknown","callee-unbound"]`.
   The first two have the same candidates and different causes; the last two have the same (empty) list and different
   causes. Today every `subReason` is `undefined`: fails.
2. `trace-receivers.e2e.test.ts`, name "a call on a receiver open through an outside superclass states hierarchy-open":
   the `typed` fixture and `trace(typed, "Uses", "Uses.merge")` of the test
   at "a call on a receiver of a declared type that cannot be proven lists only the declarations of that type's
   hierarchy"; assert `fact.cuts![0]` has `reason === "receiver-unproven"` and `subReason === "hierarchy-open"`.
   Today `subReason` is `undefined`.
3. `trace-walk.test.ts`, name "a resolved edge on a parameter receiver is cut as untyped": a unit with a `verdictsOf`
   fake answering `{ kind: "drop", root: { kind: "lexical", name: "p" } }` for one called edge; assert the cut's
   `subReason` is `receiver-untyped`.
4. `trace-walk.test.ts`, name "a binding conflict is cut as a conflict": a node with `bindingConflict: true` and
   `bindingEvidence` of two places walked as a step; its cut has `subReason === "binding-conflict"`.
5. Sibling paths: the TypeScript tests of `cut-reasons.e2e.test.ts` that assert `capability-absent` keep passing
   unchanged in this unit (the reading says it); `dispatch`, `constructor-unsettled`, `unowned`, `function-value`,
   `page-unplanned` cuts keep their sub-reasons.

**Acceptance.**
- Owner and contract as above; no second path: `rg -n 'callCut\(|unresolvedAt\('
  src/core/application/trace/trace-walk.ts` lists only sites that pass a cause or an explicit reason.
- No chain of special cases: each site passes the value its owner computes; no site compares a list length to choose a
  sub-reason (`rg -n 'length > 0 \?|\.length === 0 \?' src/core/application/trace/trace-walk.ts` shows none that picks a
  `subReason`).
- Fitness function: the ownership of the derivation is guarded by the `edge-targets.single-rule.test.ts` entry U3 adds;
  that a binding's cause reaches its cut is a data flow no import rule can see, so `trace-walk.test.ts` test 1 is its
  guard (two bindings with equal candidates and different causes, two with equal empty lists and different causes).
- Every other test that deep-equals a whole `receiver-unproven` / `callee-unknown` trace cut gains the sub-reason of its
  fixture. The implementer lists them with
  `rg -ln 'receiver-unproven|callee-unknown' src --glob '*.test.ts'` and runs each file; a failure that is not "a
  `subReason` now present" is a stop condition.

**Corpus gate expectation.** `--expect trace:±`, no `--expect-cuts`. Rows that must move: `trace/java/receiver-unproven`
(no sub-reason, 129) splits over `hierarchy-open`, `members-unselected`, `receiver-outside`, `receiver-untyped`,
`repository-wide`, `unproven`, `callee-unbound`;
`trace/java/callee-unknown` (62) splits over `callee-computed`, `callee-unbound`, `receiver-untyped`, `unproven`; the
TypeScript rows keep `capability-absent` until U6. The sums per reason stay equal; statuses of every answer stay equal.

**Risk.** item 3 (a public cut field is populated where it was absent; additive, but a consumer keyed on its absence
sees a value).

**Stop conditions.** A call cut that has no cause at any site (a producer of `receiver-unproven` or `callee-unknown` the
table above lacks); a test that fails for a reason other than the new sub-reason; the gate shows a status or reason
change.

### U5: callers and impact write the cause on their `receiver-unproven` cuts

**Goal.** Step 16.

**Prerequisites.** U3.

**Files to edit.** `src/core/application/navigation/reverse-calls.ts` (symbol `intoDeclarations`);
`src/core/application/navigation/reverse-calls.test.ts`.

**Steps.**
1. In `intoDeclarations`, compute `const unproven = binding.kind === "unbound" || (binding.kind === "receiver" &&
   binding.target === undefined && (!binding.outside || binding.dispatch !== undefined));`
   and, when it holds and `declaration === undefined`, push the cut with `subReason: causeOfBinding(binding)`
   (TypeScript narrows `binding` to the two variants through a type guard
   `function isUnproven(binding: SettledBinding): binding is Extract<SettledBinding, { kind: "unbound" | "receiver" }>`
   written beside it). Keep `reason`, `at`, `reach` as they are.

**RED test.** `reverse-calls.test.ts`, name "an unproven call of the reverse walk states the cause its binding states":
with the file's `setup(nodes, edges, written, bind)` where `bind` answers
`{ kind: "unbound", form: "member", candidates: [symbol("C.save"), symbol("D.save")], attributed: [], cause:
"hierarchy-open" }` (as in the test at line ~91), `reverse.intoDeclarations([declared])` yields one cut with `reason:
"receiver-unproven"` and `subReason: "hierarchy-open"`; a second call answered
`{ kind: "unbound", form: "computed", candidates: [], attributed: [], cause: "callee-computed" }` yields `subReason:
"callee-computed"` and, with the first, shows two causes with equal candidate counts differ. Today `subReason` is
`undefined`.
Sibling: the existing assertions on `found` and on cuts' `at` and `reach` stay unchanged.

**Acceptance.** Owner: `call-binding.ts` computes, `reverse-calls.ts` copies. `npm run check` passes.

**Corpus gate expectation.** `--expect callers:± --expect impact:±`. Rows: `callers/java/receiver-unproven` and
`impact/*/receiver-unproven` (today without sub-reason: 1 in `impact/typescript`) split by cause; no other reason moves.

**Risk.** item 3 (as U4).

**Stop conditions.** `intoDeclarations` has another producer of `receiver-unproven`.

### U6: the TypeScript receiver label says the receiver is untyped

**Goal.** The typed-queue TypeScript cuts stop saying `capability-absent`.

**Prerequisites.** U4.

**Files to edit.** `src/core/adapters/typescript/this-receiver-methods.ts` (symbol `UNKNOWN`);
`src/core/adapters/typescript/this-receiver-methods.test.ts`
(the three `{ kind: "unknown", reason: "capability-absent" }` expectations); `src/composition/cut-reasons.e2e.test.ts`
(the two TypeScript receiver tests); `docs/architecture/adr/0090-*.md` is not edited.

**Steps.**
1. Change `const UNKNOWN: ReceiverMethod = { kind: "unknown", reason: CAPABILITY_ABSENT };` to `{ kind: "unknown" }`,
   delete the `CAPABILITY_ABSENT` import if unused, and replace its comment by "A site this reading does not type: the
   answer of a reader that establishes no receiver obligation."
2. Update the doc comment of `createThisReceiverReading` ("is `unknown` as `capability-absent`, the answer the pack
   gives where it has no receiver reading") to "is `unknown`".
3. Change the three expectations of `this-receiver-methods.test.ts` and the two tests of `cut-reasons.e2e.test.ts` to
   the values of the table "The TypeScript label": the `port: A` test expects `receiver-unproven` with
   `receiver-untyped`; the `holder.port.save()` test expects `receiver-unproven` with `receiver-untyped`; rename both
   tests so the titles no longer say "absent" ("a member call on a receiver the TypeScript reading does not type is cut
   as untyped").

**RED test.** The two renamed e2e tests assert `subReason === "receiver-untyped"`; today they get `capability-absent`:
fail. Sibling: the test "a dispatch the TypeScript pack declares absent stays a dispatch cut that names the absence"
(same file) keeps passing unchanged, which proves `capability-absent` is still emitted where the pack declares the stage
absent.

**Acceptance.** Owner: the TypeScript adapter states what it answers; the binder states the cause. No second path: `rg
-n 'CAPABILITY_ABSENT' src/core/adapters/typescript` shows no use in `this-receiver-methods.ts`. `npm run check` passes.

**Corpus gate expectation.** `--expect trace:±`. Rows: `trace/typescript/receiver-unproven/capability-absent` (22) falls
to 0 and `trace/typescript/receiver-unproven/receiver-untyped` (or `callee-unbound` for bare calls) rises by the same
count, `callers`/`impact` rows unchanged except where a TypeScript `impact` cut had no sub-reason; reason totals equal.

**Risk.** item 3 (an existing sub-reason value changes on existing cuts).

**Stop conditions.** A consumer other than `trace-walk.ts` reads the `reason` of a `receiverMethods` `unknown` (`rg -n
'reason === CAPABILITY_ABSENT|\.reason' src/core/application`): report it.

### U7: the gate report prints the causes and the reasons that moved

**Goal.** Make "detail only" checkable and count the causes by answers.

**Prerequisites.** U2.

**Files to edit.** `scripts/corpus-gate-ledger.ts`, `scripts/corpus-gate.ts` (`readableLedger`, `ReportBody`),
`scripts/corpus-gate-ledger.test.ts`, `scripts/corpus-gate.test.ts`.

**Steps.**
1. In `corpus-gate-ledger.ts` add
   ```ts
   export interface CallCauseRow { family: string; language: string; reason: string; subReason: string | null; cuts: number; answers: number; share: number }
   /** The cuts of the call reasons by cause: `share` is the cause's cuts over the reason's, in percent with one decimal. */
   export function callCauseRows(ledger: CutLedger): CallCauseRow[];
   /** The reasons whose total cuts differ between two ledgers, sorted. */
   export function reasonsMoved(base: CutLedger, candidate: CutLedger): string[];
   ```
   `callCauseRows` takes the rows whose `reason` is `receiver-unproven` or `callee-unknown`, sums `cuts` per `(family,
   language, reason, subReason)` (`subReason` absent is `null`) and `answers` as `answersWith.complete + partial +
   unknown`, sorted by family, language, reason, then cuts descending.
   `reasonsMoved` compares `totalCuts` per reason, over the union of reasons.
2. In `readableLedger` add, after the rows difference: `### Causes of call cuts` with the table `| Family | Language |
   Reason | Sub-reason | Cuts | Answers | Share |` for the candidate side, then the same under `#### Base side`; and
   under the difference a line `Reasons whose total moved: <list or none>`.
3. Add `callCauses: { base: CallCauseRow[]; candidate: CallCauseRow[] }` and `reasonsMoved: string[]` to the `ledger`
   part of `ReportBody`.

**RED tests.** `corpus-gate-ledger.test.ts`: "the causes table counts a cause by its cuts and by the answers that hold
it": two answers, one with three `receiver-unproven/repository-wide` cuts and one with one; expected row `{ cuts: 4,
answers: 2 }` and a `receiver-unproven` row with no sub-reason; today the function does not exist. "reasonsMoved lists a
reason whose total moved and no reason whose cuts only changed sub-reason": a base with 2 `receiver-unproven` cuts
without sub-reason and a candidate with the same 2 under `unproven` → `[]`; with 3 → `["receiver-unproven"]`.
`corpus-gate.test.ts`: extend the test "reports the cut ledger without failing on it..." to assert the report contains
`### Causes of call cuts` and the line `Reasons whose total moved:`.

**Acceptance.** Owner: the ledger module (pure). Fitness function: `reasonsMoved` is the mechanical guard of "detail
only"; U4, U5, U6 gate runs must print `Reasons whose total moved: none`. `npm run check` passes.

**Corpus gate expectation.** None (scripts).

**Risk.** none.

**Stop conditions.** The report shape in `corpus-gate.ts` differs from the symbols named.

### U8: measure the ledger after Part A

**Goal.** Record what the labels split, and decide what is left.

**Prerequisites.** U4, U5, U6, U7 on `main`.

**Steps.**
1. Run the gate as in U1 on the merged tree (base = the tip before U2, candidate = the tip), `--expect trace:± --expect
   callers:± --expect impact:±`.
2. Read `Reasons whose total moved`: it must be `none`. Read the section "Causes of call cuts".
3. Apply the table.

**Decision table.**

| Number read | Do |
|---|---|
| `Reasons whose total moved` lists a reason | stop: a unit changed a reason; find it with the per-answer differences of the report and fix it in that unit |
| any answer's status differs between sides | stop, same |
| the sub-reason `unproven` holds more than half of `trace/java` call cuts | open a note for RFC-0043 (the Java reader answers `unproven` without a list where it knows more); do not split it in this RFC |
| `repository-wide` holds cuts in answers of one shape (many cuts, few answers) | record the ratio cuts to answers; RFC-0047 uses it |
| `receiver-untyped` holds the largest share of `trace/typescript` | RFC-0044 starts from that row |

**Corpus gate expectation.** None (no change).

**Risk.** none.

**Stop conditions.** As the table.

### U9: the gate reads declared build outputs and expands their placeholders

**Goal.** Manifest `buildOutputs`, `declares`, the two placeholders, their validation.

**Prerequisites.** None.

**Files to edit.** `scripts/corpus-gate.ts` (symbols `ManifestSchema`, `readManifest`, `GateFaultCode`, `runSide`'s
`runGroup`, `gate`), `scripts/corpus-gate.test.ts`. Do not touch `corpus-gate-ledger.ts`.

**Steps.**
1. Add `buildOutputs` and `declares` to `ManifestSchema` as written in "The manifest".
2. Add `const NODE_MODULES_PLACEHOLDER = /\{node-modules:([^}]+)\}/gu;` and `const JDK_PLACEHOLDER = "{jdk}";` beside
   `REPO_PLACEHOLDER`.
3. In `readManifest`, after the `REPO_PLACEHOLDER` check, add validations 1 to 3 of "The manifest" with
   `GateFault("invalid-manifest", `${group.id}/${query.id}: ...`)`.
4. Add `missing-build-output` to `GateFaultCode`; add `checkBuildOutputs(manifest, manifestDirectory)` next to
   `checkCorpusRevisions` and call it in `gate` right after it: `existsSync(join(jdk, "lib", "ct.sym"))`,
   `statSync(path).isDirectory()` for each node_modules path.
5. In `runGroup`, extend the argv map: after `argument.replace(REPO_PLACEHOLDER, ...)` apply
   `.split(JDK_PLACEHOLDER).join(resolve(context.manifestDirectory, jdk))` and `.replace(NODE_MODULES_PLACEHOLDER, (_,
   id) => resolve(context.manifestDirectory, outputs.nodeModules[id]))`; `outputs` is `context.manifest.buildOutputs`;
   validation guarantees presence. `declaredArgv` (`query.argv`) is unchanged.

**RED tests** (`corpus-gate.test.ts`, modelled on "adds a query's candidate arguments on the candidate side only...",
whose fake engine echoes its options):
1. "expands {jdk} and {node-modules:<id>} to the declared paths and records the declared argv": a manifest copy with
   `buildOutputs: { jdk: <tmp dir holding lib/ct.sym>, nodeModules: { b: <tmp dir> } }` and a query `argv: ["list",
   "--jdk", "{jdk}", "{repo:app}"]`; the fake engine prints its argv; the answer's `stdout` shows the absolute paths and
   `answer.argv` shows `{jdk}`. Fails today: the manifest is refused (`invalid-manifest`, unknown key).
2. "refuses a placeholder without its declaration": `{jdk}` with no `buildOutputs.jdk` → `EXIT.fault`;
   `{node-modules:zz}` with `zz` not a repository → `EXIT.fault`.
3. "refuses a missing build output before running anything": `buildOutputs.jdk` pointing at an empty directory →
   `EXIT.fault`, and no answer file written.
4. "refuses a twin whose original is not in its group": `declares: { of: "nope" }` → `EXIT.fault`.

**Acceptance.** Owner: the gate reads the manifest. A manifest without the new keys behaves as before (the existing
tests pass unchanged). `npm run check` passes. Fitness function: tests 2 to 4 enumerate the validation rules.

**Corpus gate expectation.** None (scripts).

**Risk.** item 5 (the corpus gate is the delivery check; a mistake here hides regressions), contained by the
unchanged-manifest tests.

**Stop conditions.** The `runGroup` argv map or `checkCorpusRevisions` no longer exist as described.

### U10: the gate pairs twins and prints the declared section

**Goal.** `declaredArms`, `declaredPairs`, the report section.

**Prerequisites.** U9.

**Files to edit.** `scripts/corpus-gate-ledger.ts`, `scripts/corpus-gate.ts` (`report`, `sideLedger`, `readable`,
`ReportBody`), `scripts/corpus-gate-ledger.test.ts`, `scripts/corpus-gate.test.ts`.

**Steps.**
1. Add `declaredArms` and `declaredPairs` as specified. `declaredArms(answers, twins)`: `with` = answers whose id is a
   key of `twins`; `without` = answers whose id is a value of `twins`; `rest` = the others (order kept).
2. In `corpus-gate.ts` build `twins` once from the manifest: for every group and query with `declares`,
   `${group.id}/${query.id}` → `${group.id}/${query.declares.of}`.
3. `sideLedger(result)` builds the main ledger from `[...rest, ...without]` in the order of `result.answers`; add
   `declaredSection(result, twins)`: `{ pairs: twins.size, without: cutLedger(without), with: cutLedger(with), rows:
   declaredPairs(...) }`.
4. Add `declared` to `ReportBody` and the markdown section of "The two arms".

**RED tests.** `corpus-gate-ledger.test.ts`: "declaredPairs shows a key's values without and with, and — where an arm
holds none": a `without` ledger with `receiver-unproven` 3 and `depth` 1, a `with` ledger with `receiver-unproven` 1 and
`build-output` 1 → four rows with `null` where an arm lacks the key; today the function does not exist.
`corpus-gate.test.ts`: "counts a twin in the answers, keeps it out of the main ledger, and prints the declared section":
a manifest with one query and its twin (the twin passes an option the fake engine turns into one extra cut); assert
`report.counts.answers` 2, the main ledger's cuts equal the original's, and `report.md` contains `## Declared build
outputs` and the row with the two values. Fails today: the manifest key is refused or the section is absent.

**Acceptance.** Owner: pure functions in the ledger module. The main ledger of a manifest without twins is
byte-identical to today's (the existing ledger tests pass unchanged). `npm run check` passes.

**Corpus gate expectation.** None (scripts).

**Risk.** item 5 (as U9).

**Stop conditions.** An existing ledger test fails: the main ledger changed.

### U11: the manifest declares the JDK and the installs (outside the repository)

**Goal.** Twins in the manifest, installs on disk. Done by the implementer in the corpus folder (`<corpus>/gate/`);
nothing of it is committed to the repository.

**Prerequisites.** U10 on `main`; network for `npm ci`.

**Steps.**
1. Back up `corpus.json` as `corpus.json.bak-<date>`. Regenerate with the unmodified generator into a scratch path
   (`node generate.mjs groups.json > <scratch>/regenerated.json`) and compare it,
   as JSON with sorted keys, with `corpus.json`. Expected differences: the two queries that carry `--jdk <path>`, the
   query `trace-<repo>-checkout-order` written only in `corpus.json`, and nothing else. Any other difference: stop and
   report (the manifest was edited by hand in more places than known).
2. Move the hand-written content into `groups.json`: add the checkout-order query to its repository's `queries`, with
   the `--jdk` pair removed from both queries' `argv` (and no `candidateArgs`).
3. Create `prepare-outputs.mjs` beside the generator:
   ```js
   // usage: node prepare-outputs.mjs groups.json <outputs-dir>   (needs network; runs no repository code)
   for each group, repo whose pinned sha holds package.json:
     dir = <outputs>/<group.id>/<repo.id>
     write `git show <sha>:package.json` to dir/package.json
     lockfile = `git show <sha>:package-lock.json` when it exists, else ../lockfiles/<group.id>-<repo.id>.package-lock.json when that file exists, else skip with a printed reason
     write it to dir/package-lock.json
     run `npm ci --ignore-scripts --no-audit --no-fund` with cwd dir; on a non-zero exit remove dir/node_modules and print the reason
   ```
   Use `execFileSync` with an argument array, a fixed `HOME` under the outputs folder, and no shell. Do not run it
   inside any workspace.
4. Run it for the corpus. Record which repositories installed. Expected (to be confirmed by the run, not assumed): the
   three repositories whose pinned commit holds a lockfile; the two whose commit holds none use the corpus lockfile; an
   install that needs a patch or an older Node is recorded as skipped and gets no twin.
5. Edit `generate.mjs`: read `process.env.GATE_JDK_HOME` (exit with an error if unset) and `OUTPUTS =
   process.env.GATE_OUTPUTS_DIR ?? "<this folder>/outputs"`; after a group's `queries` are built, add the twins by the
   table "Which queries declare what":
   ```js
   const hasJava = (r) => git(r.path, "ls-tree", "-r", "--name-only", r.sha).split("\n").some((f) => f.endsWith(".java"));
   const installed = (g, r) => existsSync(join(OUTPUTS, g.id, r.id, "node_modules"));
   const targetOf = (q) => /\{repo:([^}]+)\}/u.exec(q.argv.join(" "))?.[1];
   for (const q of [...queries]) {
     const repo = repos.find((r) => r.id === targetOf(q));
     if (repo === undefined || q.argv.includes("{workspace}")) continue;
     const [command, ...rest] = q.argv;
     if (q.family === "trace" && hasJava(repo)) queries.push({ ...q, id: `${q.id}.declared`, argv: [command, "--jdk", "{jdk}", ...rest], declares: { of: q.id } });
     if ((q.family === "impact" || q.family === "callers") && installed(g, repo)) queries.push({ ...q, id: `${q.id}.declared`, argv: [command, "--node-modules", `{node-modules:${repo.id}}`, ...rest], declares: { of: q.id } });
   }
   ```
   with `import { existsSync } from "node:fs"` and `import { join } from "node:path"` added to the file's imports, and
   emit `buildOutputs: { jdk: process.env.GATE_JDK_HOME, nodeModules: { <repo-id>: "<path from the manifest's
   folder>/<group>/<repo>/node_modules", ... } }` at the top level of the output for the installed repositories
   (`out.buildOutputs`, beside `out.groups`; the gate resolves relative paths against the manifest's directory). A
   repository id used by two groups would collide in `nodeModules`: the generator fails when it sees one.
   (`g` is the group being built; adapt the loop variable names of the file.)
6. Regenerate `corpus.json`. Validate: `node --import tsx scripts/corpus-gate.ts --corpus <manifest> --base <tip>
   --candidate <tip>` loads it (no `invalid-manifest`).

**Measurement and decision table.**

| Number read | Do |
|---|---|
| the regenerated manifest differs from `corpus.json` in more than the three known places (step 1) | stop; the owner decides how to reconcile |
| an install fails | the repository gets no `nodeModules` entry and no twin; record the reason in the unit's report |
| the number of twins | record: it is the cost the gate pays per run |

**RED test.** None in the repository (the manifest is outside it).

**Acceptance.** `corpus.json` has no absolute machine path except `buildOutputs.jdk`, which the manifest may hold (it
lives outside the repository). Every `trace` over a Java repository (except `--workspace` ones) has a `.declared` twin;
every `impact`/`callers` over an installed repository has one.

**Corpus gate expectation.** The gate loads it; the run is U13.

**Risk.** item 5 (the manifest is the corpus's definition), contained by the backup and the diff of step 1.

**Stop conditions.** As the table; a command that would write inside a workspace; a repository whose `npm ci` asks for a
script to run (never run it).

### U12: the four callback queries lose `--depth 1` (outside the repository)

**Goal.** Remove the flag that produces the `depth` row.

**Prerequisites.** U11.

**Steps.**
1. In `groups.json` find the four `trace` queries with `--entrypoint callback:<name>` and `--depth 1` (generated from
   the repositories' pinned queries or hand-added; locate with `rg -n '"--depth"' groups.json corpus.json`) and remove
   the two arguments from each. If they are hand-added to `corpus.json` only, add them to `groups.json` first (as U11
   step 2).
2. Run each of the four alone, on the candidate engine, with no bound: `node --import tsx scripts/corpus-gate.ts
   --corpus <manifest-with-only-that-query> --base <tip> --candidate <tip> --concurrency 1`, or the CLI directly under
   `trace <repo> --entrypoint callback:<name>` on a clone of the pinned commit (never inside a workspace). Read for
   each: exit code, `status`, `value.cost.expanded`, wall time.
3. Regenerate `corpus.json`.

**Decision table.**

| Number read | Do |
|---|---|
| all four exit 0 with `complete` or `partial` | keep the edit |
| one does not finish or exits non-zero | stop and report with its exit, its wall time and the steps it reached; do not choose a number for `--expansions` (no default limit without a measurement; the owner decides) |

**Acceptance.** `rg -n '"--depth"' corpus.json` prints nothing; the `trace/java/depth` row of the next gate run is absent.

**RED test.** None (outside the repository).

**Corpus gate expectation.** Run in U13.

**Risk.** item 5.

**Stop conditions.** As the table.

### U13: record the first declared run

**Goal.** The first report with the declared section; the baseline of the new manifest.

**Prerequisites.** U12, U8.

**Steps.**
1. `node --import tsx scripts/corpus-gate.ts --corpus <manifest> --base <tip> --candidate <tip> --out <dir>` (same
   revision both sides), `--expect none`.
2. Read: the total time against `S` of U1; the section "Declared build outputs": per row the cuts without and with; the
   `build-output` rows of the "with" arm; answers complete/partial/unknown without → with.
3. Keep `<dir>` as the reference of the new manifest. Record in the report to the owner: the gate's time, the number of
   twins, the rows that fell with the declared outputs, and every `build-output` cut (an output the engine could not
   use, with its reason).

**Decision table.**

| Number read | Do |
|---|---|
| a `build-output` cut `jdk-older-than-build`, `version-mismatch`, `inputs-unreadable` in the "with" arm | the declaration is unusable for that repository: record, remove its twin from the generator's rule only if the cause is the install, never by editing the engine |
| the "with" arm shows no row smaller than "without" for `trace/java` | the JDK adds nothing on this corpus for the cause rows: record it; ADR-0131 stays valid (the arm is the measurement) |
| the total time against `T` of U1 | report both to the owner with the per-query times of the twins; no twin is dropped on one's own |

**RED test.** None.

**Corpus gate expectation.** `--expect none` (same engine both sides).

**Risk.** none.

**Stop conditions.** The gate faults (`missing-build-output`, `invalid-manifest`).

## Not covered

| Case | What the engine answers and keeps answering | Why |
|---|---|---|
| The supertype clause that leaves a hierarchy open, as `cause` places of `hierarchy-open` | the cut has the sub-reason and no place | the reading carries a flag, not the clause; RFC-0034 slice 5 for the receiver hierarchy needs the Java reader to return it (RFC-0043's reader) |
| `binding` of RFC-0034 (`typed` / `named`) as a field | none | ADR-0130 rule 5: the sub-reason carries it |
| A call cut whose reading is `unproven` with no list | `receiver-unproven (unproven)` | the port's answer does not say whether the receiver is typed; splitting it needs an additive field of the Java reader, RFC-0043 |
| `bound` readings (a type variable's bound) | trace demotes them to `unproven`; the cut says `unproven` | a distinct cause needs its own member and a measurement of its share |
| The `reason` of a call cut | `receiver-unproven` when the cut lists candidates, `callee-unknown` otherwise | changing a reason is a ledger migration, not part of this RFC |
| The number of cuts of `repository-wide` and where one cut stands for many | one cut per call, as today | RFC-0047 |
| `--node-modules` on a TypeScript `trace` | usage error | the command does not accept it; RFC-0044 decides whether it should |
| TypeScript repositories whose install fails or needs a toolchain the machine lacks | no twin, no `nodeModules` entry; the main arm runs as before | U11 records each skip with its reason |
| `trace --workspace` queries | no twin | their launch repository is TypeScript; the flag names the launch repository only |
| `impact` and `callers` over a Java repository | no twin | they refuse `--jdk` |
| Cuts of `name-only`, `removed-declaration`, `relation-unread` (impact and callers) | unchanged | other reasons, other RFCs |

## Resolved questions (owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | Where does the cause travel: a field on `unbound`, a new binding variant, or recomputed in the walk? | A required `cause` on `unbound`, plus pure functions for proofs and readings. Discarded: recomputing in the walk (a second path, and the readings' flags are gone by then); a new variant (every consumer of `CallBinding` branches on it) |
| 2 | New field (`basis`, `cause2`) or the existing `subReason`? | The existing `subReason`: the ledger, the MCP schema, the evidence selector and the sorting rule already read it, so no consumer changes. Discarded: RFC-0034's `basis` field (it states typed/named only, which two members of the set already state) |
| 3 | Does the reason follow the cause (a computed callee as `callee-unknown` always)? | No: reasons and statuses must not move in Part A. Discarded: renaming reasons now |
| 4 | Where do the new members sit in `CUT_SUB_REASONS`? | Before `unproven`, so a specific cause stands over `unproven` and over none at one place. Discarded: appending at the end (the generic would win) |
| 5 | The TypeScript label: map in the binder, or change the adapter's answer? | Change the adapter: the pack implements the reading and its `unknown` is not an absence; `capability-absent` then means only the pack's declaration. Discarded: translating the reason in the binder (it would leave one word with two meanings) |
| 6 | Does `capability-absent` stay on call cuts? | Yes, for a reading that says it (a pack that declares `receiverMethods` absent); no pack does today |
| 7 | One member for "typed, member unsettled" and one for "no list"? | One catch-all, `unproven`, reused; the port cannot tell typed from expression receivers. Discarded: inventing a member the code cannot emit truthfully |
| 8 | Is a list of one candidate `members-unselected`? | Yes: the reading offered a list and selected none; the label is the reading's, not a count |
| 9 | Chaining calls (`super(...)`, `this(...)`) | `unproven` (or `capability-absent`), no dedicated cause: the constructors are listed and no measurement shows a need; U8 shows the row |
| 10 | Cause places (`Cut.cause`) for the new causes | None: the binder holds no place for them. Discarded: changing the Java reader here |
| 11 | Duplicate queries or switch them? | Twin them. Discarded: switching (baseline lost, effect invisible); two manifests (twice the time, two reports) |
| 12 | Which ledger is the main one? | Every undeclared answer, as before, so history stays comparable; the declared pair is a separate section. Discarded: one ledger over all answers (it would count a query twice) |
| 13 | How is the JDK path supplied? | One `buildOutputs.jdk` in the manifest, from `GATE_JDK_HOME` at generation, and the `{jdk}` placeholder. Discarded: a path per query (today's two, 28 repeats); an environment variable read by the gate (the gate environment is fixed) |
| 14 | Where are the installs, and who makes them? | Under the corpus folder's `gate/outputs/`, by `prepare-outputs.mjs` with `npm ci --ignore-scripts` from the commit's lockfile or the corpus lockfile, outside the gate (the gate never networks, ADR-0039 decision 4). Discarded: installing inside the workspaces (forbidden) |
| 15 | `--depth 1`: lose the flag or a separate ledger block? | Lose the flag; no block, since no bound occurs without a flag. Owner may overturn if a callback trace cannot finish unbounded (U12 stops there) |
| 16 | May a repository without a lockfile at its commit declare `node_modules`? | Yes, unverified (ADR-0037 decision 5); the corpus lockfile makes the install reproducible |
| 17 | Part B before or after Part A? | After: the labels are measured on the unchanged manifest (U8), then the manifest changes (U11). Discarded: both at once (the two effects would be confounded) |
