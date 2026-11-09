# RFC-0024: Every call settles by its receiver's type and arity

- Status: Accepted, 2026-11-09. Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (every open question settled as recommended; see Resolved questions). ADR-0046 records its decisions.
- Reproductions: kept with the study run outside the repository (`evaluations/runs/20261108T2245Z-agent-usefulness-12f8/engine-gaps/designs/rfc-0024-receiver-typed-settlement/repro`).
- Baseline: engine `main` `d0aee793` (the merge of `t3/one-proof-set`, ADR-0045 L2). Every `path:line` below was read on
  it; the study's items were produced at `c2861dba`.
- Related (repository paths under `docs/architecture/`): `adr/0029-lexical-bindings-from-the-typescript-binder.md`,
  `adr/0036-dependence-is-the-compile-time-binding.md`, `adr/0037-host-declared-build-outputs.md`,
  `adr/0041-one-call-reconciliation-for-every-family.md` (decisions 4, 6, 8, open question 7),
  `adr/0042-completeness-is-relative-to-the-question.md`,
  `adr/0044-one-implementation-closure-with-scoped-vetoes.md` (decision 1, V0a, V0b),
  `adr/0045-one-assembly-line-for-the-snapshot-reading.md` (decision 2 B1/B2b/B8/B10b, decision 5, decision 12, L3),
  `rfc/0002-facts-contract.md`, `rfc/0010-impact-queries.md`, `rfc/0013-trace-and-patterns.md`,
  `rfc/0016-type-resolution.md`, and RFC-0027 (the declaration model, which extends this RFC's binder contract
  afterwards).

**In short:** a call is settled today by the *name* it spells wherever the language makes a binding by type: a receiver
whose type declares several members of that name binds to none of them, and the call's candidates then come from the
repository's homonyms. One rule replaces all of them — a member call binds to the declarations its receiver's *type*
offers at the call's *signature*, one owner per language answers that question, and every family (the forward walk, the
index edge, the reverse index, the bridge between an implementation and its contract) asks that owner instead of
matching a name. Where the language cannot answer, the call is a cut that names the declarations the receiver's type
does offer, never the repository's homonyms.

## Seam with RFC-0027 (lead decision)

RFC-0024 owns `CallBinder.memberOf` and `CallBinder.declares`, and keeps them **`GraphSymbol`-based**; it also adds
`CallBinder.membersAbove`, of the same shape. RFC-0024's units U1 to U4 land **before** RFC-0027's U1, and RFC-0027
extends this contract afterwards (it adapts its `ModelDeclaration` to these methods; it does not replace them). No unit
of either draft offers two contracts for one question.

## Problems

Fourteen graded needs of the 2026-11-08 study share this class, in both languages, plus the class's counterfactual items
(`CF-nname-TS-FLOW`, and `CF-shopizer-J-BUG` with T5 secondary). Each row below is one mechanism; the item ids are the
study's.

| # | Mechanism | Items | Symptom the study recorded |
|---|---|---|---|
| M1 | A receiver whose type declares several members of the called name binds to nothing, and every interface is refused as a declaring type | TS: `N-nname-TS-FLOW.A1-N1`, `.A2-N1`, `.B1-N2`, `CF-nname-TS-FLOW`. Java: `N-PETCLINIC-J-FLOW.A1-N1`, `.A1-N2`, `.A1-N3`, `.A2-N2`, `N-nname-J-FLOW.A1-N2`, `.A2-N2`, `N-shopizer-J-FLOW.A1-N2`, `N-shopizer-J-IMPACT.A1-N3` | TS: `trace` on `AddressFormPage.onSave` cuts `this.rest.post`/`.patch` **with four candidates each**, `effects (0)`, so the HTTP effect behind the wrapper is never named (`nname/name-webapp:src/app/features/user/api/user-address.api.ts:32`, `:41`). Java: `trace` on `DELETE /petclinic/api/visits/{visitId}` cuts `findVisitById` listing **`ClinicService.findVisitById` and `ClinicServiceImpl.findVisitById`**, and `deleteVisit` listing three declarations; the walk stops one hop after the controller (`petclinic/backend-rest:.../VisitRestControllerV1.java:103`, `:107`) |
| M2 | A call in a body's own class (`this.m(...)`) whose class declares several members of the name binds to nothing and attributes **all of them** | none of the 14 observed; reach only (see Reach) | — |
| M3 | The dispatch bridge from a method to the same-named methods above it matches by **name** only, so one implementation reaches every overload of the contract above it | Java: `N-shopizer-J-IMPACT.A2-N1`, `.A2-N2`, `N-shopizer-J-BUG.A2-N4`, `CF-shopizer-J-BUG` | `callers` on two different declarations of `CustomerService.getByNick` (lines 22 and 29) answer **the same 23 entrypoints and the same 48 cuts**; the depth-0 block of each answer lists `22`, `28` and `29 getByNick (via CustomerServiceImpl.getByNick (dispatch))` (`shopizer/backend:sm-core/.../customer/CustomerService.java:22`, `:28-29`) |
| M4 | A recovered call is looked up by its callee's name and, when its binding attributes it, becomes one cut per attributed declaration (`attributedCallCuts`) | contributes to the cut count of every reverse item above | `callers` on `ReadableMinimalProductMapper.merge` reaches 16 routes and prints **95 `unresolved-link` cuts** (`shopizer/backend:sm-shop/.../catalog/ReadableMinimalProductMapper.java:47-147`) |
| M5 | An index unresolved reference with no candidates is "unattributed": one cut per file whose `reach` names every **walked** declaration of that name | the residual of `N-shopizer-J-IMPACT.A2-N1`/`.A2-N2`, `CF-shopizer-J-BUG` (ADR-0041 open question 7's 544 Java places) | the 48 `unresolved-link name-only` cuts, each naming all three `getByNick` declarations |
| M6 | A trace member call nothing settled prints **every in-scope declaration of the name**, not the ones its receiver's type declares | the Java trace items above (the printed candidate list) | `findVisitById (ClinicService, ClinicServiceImpl)`; `deleteVisit (VisitRestControllerV1, ClinicService, ClinicServiceImpl)` — the controller's own homonym is printed too |
| M7 | Trace keeps a second copy of the Java receiver rule (`nominalMethod`) beside the base binding | mixed into the Java trace items above | the same cuts as M1; the rule refuses the same overload set (`trace-walk.ts:258`) |

M4 and M5 are different cut classes and different emitters: M4 is `attributedCallCuts` over `ReverseCalls.into`'s
`attributed` list (`domain/impact/impact-cuts.ts:96`, called at `impact-queries.ts:551`); M5 is `unresolvedLinkCuts` over
the walk's `pointing` declarations (`impact-cuts.ts:163`, `:203`, `:217`, `:226`). M6 is the printed candidate list of a
*trace* cut and is neither of them. The design keeps the three apart.

## Root cause

All seven mechanisms are one mistake: **a settlement keyed by a name where the language keys by type and signature.**

### M1 — `CallBinder.memberOf` refuses the overload set and every interface member — **confirmed**

`src/core/application/navigation/call-binder.ts:154-160`:

```ts
memberOf(type, member) {
  for (const declaring of above(type).filter((candidate) => isClassKind(candidate.kind))) {
    const own = navigation.methodsOf(declaring).filter((method) => method.name === member);
    if (own.length > 0) return own.length === 1 ? own[0] : undefined;
  }
  return undefined;
}
```

Two independent refusals, both by construction:

1. `own.length === 1 ? own[0] : undefined` (line 157): a type that declares **two or more** members of the name answers
   `undefined`. A TypeScript overload set is exactly that — `post` and `patch` are declared four times each
   (`nname/name-webapp:src/app/core/rest/services/client/rest-client.service.ts:37-44`, `:81-88`) — so the call never binds.
2. `.filter(isClassKind)` (line 155): `isClassKind` is `["class", "component"]`
   (`src/core/domain/impact/edge-policy.ts:17`, `:94-96`), so an **interface** is never a declaring type here, while
   `EDGE_POLICY.ownerKinds` (`:34`) does include interfaces. A receiver typed with an interface can therefore never bind,
   though `typesAround` already returns interface owners (`src/core/application/navigation/graph-navigation.ts:71-89`).

Every consumer of the chain calls it and inherits both refusals: `call-binding.ts:137` (the `proven` receiver branch),
`:157` (the own-member branch), `edge-targets.ts:259` (an index edge's receiver), `trace-walk.ts:421`, `:430`.
`declares()` (`:161-165`) uses the **unfiltered** `above()`, so the same type reports that it declares the member the
chain just refused — which is why the refusal turns into an attribution instead of an absence.

Reproduction (plan `repro/p-ts-overload.json`, snapshot `name-webapp @ dfd2070f`):

```
status: partial (cuts: 42 unresolved-link receiver-unproven, 3 unresolved-link function-value)
roots (1): ...AddressFormPage.onSave matches 1: #0 onSave
effects (0)
cuts:
  unresolved-link (45 calls):
    receiver-unproven: src/app/features/user/api/user-address.api.ts:32 this.rest.post
      (rest-client.service.ts:37 RestClientService.post, :42 ..., :43 ..., :44 ...)
    receiver-unproven: src/app/features/user/api/user-address.api.ts:41 this.rest.patch
      (rest-client.service.ts:81 ..., :86 ..., :87 ..., :88 ...)
```

and for Java (plan `repro/p-java-trace.json`, snapshot `backend-rest @ 5180cc9b`):

```
status: partial (cuts: 2 unresolved-link callee-unknown, 2 unresolved-link receiver-unproven)
steps:
  #0 99 deleteVisit [method] (.../VisitRestControllerV1.java:99-109)
cuts:
  unresolved-link (4 calls):
    receiver-unproven: .../VisitRestControllerV1.java:103 findVisitById
      (ClinicService.java::...ClinicService.findVisitById, ClinicServiceImpl.java::...ClinicServiceImpl.findVisitById)
    receiver-unproven: .../VisitRestControllerV1.java:107 deleteVisit
      (VisitRestControllerV1.java::...VisitRestControllerV1.deleteVisit, ClinicService..., ClinicServiceImpl...)
```

The candidate list is `CallBinding.candidates`, built once per call as **every in-scope declaration of the name**
(`call-binding.ts:165`, `namedDeclarations`, `:93`), and trace prints exactly it when the binding settles nothing
(`trace-walk.ts:414` → `:376-377`).

### M2 — the own-member branch attributes the whole overload set — **confirmed** (read; no corpus case observed)

`call-binding.ts:155-158`:

```ts
const members = own === undefined || hasTyping(reference.file, "nominal") ? [] : ownMembersOf(navigation, body, own, ["method"]);
if (members.length === 1) bindings[index] = { kind: "declaration", target: members[0]!, link: "own-member" };
else if (members.length > 1) bindings[index] = { kind: "unbound", form: "own", candidates: members, attributed: members };
```

A `this.m(...)` written in a class that overloads `m` becomes `unbound` with `attributed` = the whole set, so every
reverse family emits one cut per overload. TypeScript is the only language that reaches this branch (`nominal` is
excluded on line 156); the same `own.length > 1` shape lives in trace's `nominalMethod` (`trace-walk.ts:258`) for the
Java path. Label: **confirmed** by reading; no study item exercises it, and the unit that fixes M1 owns the same rule.

### M3 — `bridgesOf` matches an implementation to its contract by name — **confirmed**

`src/core/application/impact/inbound-edges.ts:135-143`:

```ts
function bridgesOf(method: GraphSymbol, contractChanged: boolean): InboundEdge[] {
  const directions = contractChanged ? (["up", "down"] as const) : (["up"] as const);
  return ownersOf(method).flatMap((owner) => directions.flatMap((bridge) =>
    typesAround(owner, bridge).flatMap(({ type, confidence }) =>
      methodsOf(type)
        .filter((candidate) => candidate.name === method.name)   // ← name only, line 141
        .map((from) => ({ from, confidence, bridge, basis: "dispatch", derivation: "resolved", lines: [] })))));
}
```

`CustomerServiceImpl.getByNick(String, int)` therefore bridges **up** to all three `CustomerService.getByNick`
declarations, and the walk adds the two siblings of whatever declaration was asked for. This is the largest false
dependence mechanism of the class: it makes two different declarations answer identically.

Reproduction (plan `repro/p-java-homonym.json`, snapshot `shopizer/backend @ 6a4a0a65`), `callers` on line 22 versus
line 29 of `CustomerService.java`; the two answers differ only in the seed's own line:

```
--- line 22
+++ line 29
-  For the next 8 handler rows, one verified origin: .../customer/CustomerService.java:22 getByNick (lines)
+  For the next 8 handler rows, one verified origin: .../customer/CustomerService.java:29 getByNick (lines)
     ... same 23 `reached entrypoints` rows, same 48 `unresolved-link name-only` cuts ...
     via .../customer/CustomerServiceImpl.java:getByNick (dispatch)
+      22 getByNick [method] (depth 0, confidence 0.9, fan-in 15)
       28 getByNick [method] (depth 0, confidence 0.9)
-      29 getByNick [method] (depth 0, confidence 0.9)
```

### M4 — the reverse index's attribution of a recovered call — **confirmed**, not a defect by itself

`reverse-calls.ts:47-51` spells the lookup key as the call's callee name, `:100` files every written call under it, and
`:184` filters candidates by `sharesRuntime` only. Looking a call up by name is a sound *over-approximation* (a call can
only reach a declaration whose name it spells); the defect is what happens next: `bindings.boundCalls` decides per call,
and when the binding is `unbound`/`receiver` with `attributed`, `:202` emits one attributed call and
`attributedCallCuts` (`impact-cuts.ts:96`) turns it into one cut per attributed declaration. Fixing M1 and M2 shrinks
this list; no unit changes the lookup key (ADR-0041 decision 8 keeps it).

### M5 — the unattributed cut names every walked homonym — **confirmed**, cause downstream of M1/M3

`impact-cuts.ts:226` emits one `name-only` cut per file whose `reach` is `callersOf(unattributedNames.get(file))`;
`unattributedNames` is filled at `:217-220` from `pointing`, and `pointing` is the **walked** declarations of that name. So
the cut names every declaration of the name the walk reached — which, through M3, is every overload of the contract. The
volume ADR-0041 open question 7 measured (544 places) is therefore mostly M3's siblings, not an independent rule. The
residual rule of OQ7 (a qualified index reference with no candidates attributes to no declaration, `:203`) stays open
here; see Resolved questions 3.

### M6 — trace prints the name index, not the receiver's candidates — **confirmed**

`trace-walk.ts:376-386` (`settleByName`) receives `named`, and for an unsettled member binding that list is
`CallBinding.candidates` — every in-scope declaration of the name (`:456`). When `named.length === 0` it reads a second
name index of its own (`memberDeclarations()`, `:380`) and prints that instead (`:383`). For a call whose receiver the
binder *does* type (M1), the printed set should be the members that type declares; today it is the repository's
homonyms. That is why the petclinic cut lists the controller's own `deleteVisit` beside the two service declarations.

### M7 — trace keeps a second Java receiver rule — **confirmed**

`trace-walk.ts:251-264` (`nominalMethod`) re-implements the Java receiver rule over `declaredTypes` answers, with the
same `own.length > 1 → undefined` refusal (`:258`), used at `:406` and `:498`. ADR-0041 decision 1 requires one binder;
ADR-0044 decision 1 requires Java answered only by the owner. Both are read here as a defect against accepted decisions,
not as a new one.

### What L3 and V0a already close (and what they do not)

| Delivered/planned | Mechanism it closes here | What it explicitly does **not** close |
|---|---|---|
| ADR-0045 **L3** — "bindings carry the receiver classification and proofs independently of the derivation (decision 5); trace reads typed bindings and the Java module readers and expands a target only on positive execution evidence" (`docs/architecture/adr/0045-...md:492`, decision 5 at `:244-267`) | It gives an **`EdgeTarget`** the receiver classification and its proofs beside the target, so trace can read *why* a typed edge is a dependence without losing the receiver (`EdgeTarget` and `typedVerdictOf`, `edge-targets.ts`). It is a shape of the *edge verdict*, not of `CallBinding`. | None of M1–M7: L3 changes what an edge verdict *carries*, not which declaration a call binds to. `memberOf`, `bridgesOf`, `reverse-calls`' lookup, `CallBinding.candidates` and `settleByName` are untouched by it. |
| ADR-0044 **V0a** — "The owner answers candidates and closure apart (decision 1); `receiverOf` and `methodsOf` read the owner in its staging form" (`adr/0044-...md:445`) | It makes `java-receiver-methods.ts` the single Java reader **inside the adapter** and separates dispatch candidates from the closure verdict, so my Java units inherit one implementation and its fixtures. It is the code change that makes ADR-0044 decision 1's seam ("its base reaches Java only through these two ports") implementable. | The base's chain is not in V0a's scope: `CallBinder.memberOf` still answers Java receivers with the structural rule (and refuses interfaces), `bridgesOf` still matches by name, and no port answer carries the receiver's candidate declarations. |
| ADR-0044 **V0b** — the exact-signature overload link becomes a link of the owner (`:446`) | The Java *signature selection* rule (arity and stated parameter types, JLS 15.12.2.5) — my Java units add no signature rule; they route to the owner and inherit V0b when it lands. | It does not route the base's binding to the owner and says nothing about the up-bridge or TypeScript. |

V0a and V0b are **not prerequisites** of this RFC: `receiverMethods` exists on `main` and answers today (this draft cites
its `memberOf` at `java-receiver-methods.ts:193`), so U2 and U4 call it as it is and inherit V0b's link without a change
when it lands. Nothing in U1–U4 reads an `EdgeTarget` field L3 adds, so no unit of this RFC waits on L3 either.

## Reach

Searched the whole `src/` for the broad form — a settlement of a member call or a dependence keyed by a name alone:

| Site | What it decides by name | Fixed by |
|---|---|---|
| `navigation/call-binder.ts:154-160` | which member a receiver's type offers; whether an interface has one at all | U1 |
| `navigation/call-binding.ts:135-146` (`proven`) | the target, and `candidates` = every in-scope declaration of the name | U2 (target), U3 (candidates) |
| `navigation/call-binding.ts:155-158` | own-member overload set | U1 |
| `navigation/edge-targets.ts:257-262` + `:299-317` | an index edge's receiver, and a homonym edge judged with `[target]` as its only candidate | U2, U3 |
| `navigation/reverse-calls.ts:184`, `:202` | which recovered calls may reach a declaration, and the cut per attributed one | no code change; shrinks with U2, U3 |
| `impact/inbound-edges.ts:135-143` | the contract a method implements | U4 |
| `impact/impact-cuts.ts:203`, `:217-226` | the reach of an unattributed cut (M5) | no code change; shrinks with U3, U4 (OQ7 open) |
| `trace/trace-walk.ts:376-386`, `:456` | the candidates a cut prints | U3 (through `CallBinding.candidates`) |
| `trace/trace-walk.ts:251-264` | a second Java receiver rule (M7) | U5 |
| `trace/trace-walk.ts:511-515`, `:544-553` | the receiver-method sites trace builds for its **dispatch** read (ADR-0044 decision 3, ADR-0045 L3b's expansion rule) | **not touched**: it decides what runs, not what the call binds to |
| `adapters/spring/java-receiver-methods.ts:193` | already by arity (and by V0b, by signature) — the model the others follow | none; it is the owner |

Beyond the observed cases the same shape produces: a TypeScript `callers` that cannot tell two overloads apart (each
suspects every call site of the other); a Java `trace` that stops at the first interface hop whenever the contract is
overloaded; a `contract-consequences` frontier reached through the wrong overload; and a cut volume that scales with the
number of homonyms in the repository rather than with the call (the largest single cut class of the 2026-11-08 study).

## Design

### The rule

> **A member call binds to the declarations its receiver's *type* offers at the call's *signature*.** The type comes from
> the receiver's proof (ADR-0041 decision 4). The signature is the language's: for a nominal language, the name plus the
> argument count and the stated parameter types (JLS 15.12.2.5, already the owner's rule); for a structural language,
> the name plus the overload set's one implementation. Where the type offers several declarations and the language does
> not single one out, the call binds to none and states **those** declarations as its candidates — never the
> repository's homonyms.

Three consequences, and they are the whole design:

1. **One question, one owner per language.** "The declaration a member call names" is `ImportOrigins.receiverMethods`
   for a nominal language (ADR-0044 decision 1) and the source's own callables for a structural one. No family and no
   chain asks `methodsOf(...).filter(name)` to answer it.
2. **The candidates are the receiver type's members, not the name's homonyms.** Every place that keeps "what it could
   be" (`CallBinding.candidates`, a cut's printed list, `attributed`) takes it from the same answer.
3. **Both directions use it.** Forward (what a body calls) and reverse (what depends on a declaration) settle through
   one binder and one candidate rule; the bridge between an implementation and its contract asks the same owner.

### Placement on the assembly line (ADR-0045)

| This RFC | ADR-0045 place | Why there |
|---|---|---|
| The structural member rule and the nominal-member link of the binding chain | **B8** (`CallBinder`, `CallBindings`, `EdgeTargets`) | ADR-0041 decisions 1 and 4 make B8 the one owner of "which declaration a call binds to" |
| `ReceiverMethod.unproven.candidates` (the receiver's declarations of the name) | **B2b**, the Java pack's `receiverMethods` row (decision 2 table) | A pack answers a language question; the core never reads Java signatures |
| `ImportOrigins.implementedDeclarations` (the contract declarations a method implements) | **B2b**, a new row: the same owner and the same signature reading | ADR-0045 decision 8: a new mechanism enters as a stage row with its retention, its measurement and its fixtures |
| The reverse index keyed by name | **B10b**, unchanged | ADR-0041 decision 8: a name index is the cheap over-approximation; the binding decides |
| Trace reading the binding's candidates only | **B8**, read by trace's extension | ADR-0041 decision 6: a family narrows, never re-binds |

It extends ADR-0041 decisions 4 and 8 (the chain gains a signature link; attribution gains a narrower candidate set) and
ADR-0044 decision 1 (it makes the base honour the seam that decision states). It contradicts nothing.

### Contracts

```ts
// src/core/ports/import-origins.port.ts — additive: no SCHEMA move, no answer field.

/** A declaration by its file and the 1-based lines from its first token to its name. */
export interface MethodPlace {
  file: string;
  start: number;
  nameLine: number;
}

export type ReceiverMethod =
  | { kind: "method"; file: string; start: number; nameLine: number; bound?: true }
  /**
   * `candidates`: the declarations of the called name that the receiver's type and its hierarchy declare, sorted, present
   * only when the reading read that whole hierarchy. A family attributes the call among them; it never widens them.
   */
  | { kind: "unproven"; candidates?: readonly MethodPlace[] }
  | { kind: "unknown"; reason?: typeof CAPABILITY_ABSENT };

/** One entry per site: the declarations above the method the site names that it implements, nearest first. */
export type ImplementedDeclarations =
  /** `none`: the method implements a declaration the sources do not hold (a generated or library supertype). */
  | { kind: "declarations"; declarations: readonly MethodPlace[] }
  | { kind: "none" }
  /**
   * `unknown` with no reason: the language types structurally (every same-named member above is a contract the method
   * satisfies), the hierarchy is unread, or a JVM source is unread. `capability-absent`: the pack declares no such
   * reading (ADR-0045 decision 12). Both keep today's by-name bridge; see Resolved questions 2.
   */
  | { kind: "unknown"; reason?: typeof CAPABILITY_ABSENT };

export interface ImportOrigins {
  // ... unchanged members ...
  implementedDeclarations(sites: readonly DispatchSite[], signal?: AbortSignal): Promise<readonly ImplementedDeclarations[]>;
}
```

```ts
// src/core/application/navigation/call-binder.ts — the contract RFC-0024 owns; RFC-0027 extends it afterwards.

/** A member call's place, which a nominal language reads its arguments from. */
export interface CallPlace {
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based UTF-16. */
  column: number;
}

export interface CallBinder {
  receiverOf(site: MemberCallSite): Promise<ReceiverProof>;
  /**
   * The member a call of `member` written at `place` binds to on a value whose type is `type` (ADR-0041 decision 4): the
   * one declaration the language's signature rule places, or the overload set's one implementation. `undefined` when the
   * type offers several and the language singles none out, or when its source was not read.
   */
  memberOf(type: GraphSymbol, member: string, place: CallPlace): Promise<GraphSymbol | undefined>;
  /**
   * Every declaration of `member` the type `type` and its hierarchy declare, nearest first, sorted: the candidate set a
   * cut names for a call on a value of that type.
   */
  membersAbove(type: GraphSymbol, member: string): readonly GraphSymbol[];
  /** Whether `type`, or a type above it, declares `member`. */
  declares(type: GraphSymbol | undefined, member: GraphSymbol): boolean;
}
```

```ts
// src/core/application/navigation/call-binder.ts — the binder's dependencies: one is new, the file's callables.
export interface CallBinderDeps {
  store: CodeGraphReader;
  navigation: GraphNavigation;
  syntaxIn: (file: string) => Promise<ReceiverSyntax>;
  /**
   * The callable declarations of a file, with the one body an overload set has: the reading `memberOf` needs to collapse
   * a structural language's overload set (ADR-0029's reader, already read by every family).
   */
  callablesIn: (file: string) => Promise<readonly DeclaredCallable[]>;
  proofs: () => Promise<ReceiverProofs>;
  /** Per local name a file's imports bind, the declaration the join proves it reaches. */
  importedDeclarations: (file: string) => Promise<ReadonlyMap<string, GraphSymbol>>;
}
```

`memberOf` becomes asynchronous; it is called at `call-binding.ts:137` (inside `proven`, reached through `:245`
`ofReceiver`), `edge-targets.ts:259`, `trace-walk.ts:421` and `:430`, all already inside async code. The one
`createCallBinder` construction is `edge-targets.ts:128`.

```ts
// src/core/application/navigation/call-binding.ts

/** What a member call binds to on a value of a proven type: the one answer and the set a cut names. */
export interface ReceiverMemberAnswer {
  /** The declaration the call binds to; absent when the type offers several and no language rule singles one out. */
  target?: GraphSymbol;
  /** The declarations the receiver's type offers for the member (or the owner's candidates when it read more of the hierarchy), sorted. */
  candidates: readonly GraphSymbol[];
}

export type CallBinding =
  | { kind: "declaration"; target: GraphSymbol; link: "own-member" | "chain" | "import" | "file" | "declared-receiver" | "bound-receiver" | "overload" }
  | {
      kind: "receiver";
      proof: ReceiverProof;
      target?: GraphSymbol;
      outside?: true;
      /** The declarations the receiver's type offers at the call's signature: what the cut names and what `attributed` holds. */
      candidates: readonly GraphSymbol[];
      /** The declarations the call may bind to: `candidates` when the target is unknown, empty when it is known or the receiver is unproven. */
      attributed: readonly GraphSymbol[];
    }
  | { kind: "outside"; form: "bare" | "chain"; origin: Outside }
  | { kind: "unbound"; form: "own" | "computed" | "bare" | "member" | "chain"; candidates: readonly GraphSymbol[]; attributed: readonly GraphSymbol[] }
  | DeclaredBinding;

export interface CallBindings {
  // ... unchanged members ...
  /** What a member call of `member` on a value of `type` binds to: one call, one answer, through the language's chain. */
  memberOfReceiver(type: GraphSymbol, member: string, place: CallPlace): Promise<ReceiverMemberAnswer>;
}
```

`link: "overload"` is a new value of an internal union (`core/application`), not of an answer: no fact field changes.

```ts
// src/core/domain/impact/edge-policy.ts — one predicate, no behavior

/** Declarations that can own a member a value receiver stands for: a class, a component, or an interface (JLS 9.2). */
export function isOwnerKind(kind: string): boolean; // (EDGE_POLICY.ownerKinds as readonly string[]).includes(kind)
```

### Algorithm

1. **A written call's binding** (`CallBindings.bindCalls`), per call:
   1. `members = ownMembersOf(...)`; if `members.length === 1`, bind `declaration/own-member`.
   2. If `members.length > 1`, ask `binder.memberOf(body's owner type, own, place)`: one answer → `declaration/overload`;
      none → `unbound/own` with `attributed = members` (the body's own type's members — never the repository's).
   3. A member call with a receiver proof (`proven`): ask `memberOfReceiver(proof.type, name, place)`; its `target` and
      `candidates` become the binding's. `candidates` for an unproven receiver (no `proof.type`) stay the in-scope
      declarations of the name — the reach of a cut, never an attribution — and `attributed = []`.
2. **`memberOfReceiver`, nominal language** (`hasTyping(file, "nominal")`): `origins.receiverMethods([{file, line,
   column, member}])`.
   - `method` → `target` = the declaration the index places between `start` and `nameLine` (`placedBetween`);
     `candidates` = `binder.membersAbove(type, member)` (which contains the target).
   - `unproven` with `candidates` → `target` absent, `candidates` = those places resolved to symbols (the owner read a
     hierarchy the graph may not hold, e.g. a generated supertype); when absent, `binder.membersAbove(type, member)`.
   - `unproven` without `candidates`, or `unknown`/`capability-absent` → `target` absent, `candidates` =
     `binder.membersAbove(type, member)`.
3. **`memberOfReceiver`, structural language**: `target` = `binder.memberOf(type, member, place)`; `candidates` =
   `binder.membersAbove(type, member)`.
4. **`CallBinder.memberOf`, structural reading**, per type, nearest first over `above(type)`:
   1. The declaring chain is every `isOwnerKind` — a class, a component, or an **interface**.
   2. `own = membersOf(declaring).filter(kind member && name)`; exactly one → it. More than one → read the declaring
      type's source once: `implementations = callables.filter(c => c.name === member && c.body)`; exactly one
      `implementations` → the index symbol `placedBetween(implementation.start, implementation.nameLine)`; else
      `undefined` (fail closed; signatures are never guessed from arity). Continue up only while the name is absent from
      the declaring type.
5. **An index edge's receiver** (`EdgeTargets.receiverVerdict`): the same `memberOfReceiver`, asked with the edge's
   place. The verdict is `redirect` to a different target; `proven` when the answer's target is the edge's own target,
   or when the receiver's type offers exactly that one declaration; `name-match` when the type offers several and none
   was selected.
6. **The contract bridge** (`bridgesOf`): ask `origins.implementedDeclarations([{file, line: method.startLine, name}])`;
   `declarations` → those; `none` → no bridge; `unknown` (with or without `capability-absent`) → today's same-named
   members above, at the existing confidence (Resolved questions 2). A structural language answers `unknown` because its
   typing makes every same-named member above a contract the method satisfies, so its answers do not move.
7. **Determinism.** Every set above is sorted by `(file, startLine, name)` before it leaves the use case; candidates,
   attributed declarations, cuts and their `reach.declarations` are `sortedUnique` as today. Identical inputs give
   identical bytes.

### Completeness (ADR-0042)

| Situation | Answer |
|---|---|
| The receiver's type offers exactly one member, or the language singles one out | `proven`/`declaration`, no cut |
| The receiver's type offers several and the language singles none out | one `unresolved-link` cut whose candidates are **those** declarations; `reach: callers-of` names them |
| The receiver's source was not read (`unread`) or the pack declares the reading absent | today's answer, plus `capability-absent` where the stage is named |
| The receiver has no provable type (a call result, a callback parameter, a computed value) | no attribution, no cut (ADR-0041 decision 8's unattributed call); trace keeps R6's cut, with `reach: call-at` |
| A nominal reading answers `unproven` with `candidates` | the cut names those candidates |

No answer status changes meaning: a `partial` answer stays `partial` with the same reason family, and its cut count may
fall (which the corpus gate reports as `±`).

### What does not change

- Every answer shape (`TraceValue`, `ImpactValue`), every fact field, every `SCHEMA` version, every derivation value.
- The reverse lookup's name index (ADR-0041 decision 8), the alignment classes, and `ReconciledCalls`.
- Trace's `receiverMethods` read for **dispatch** (`trace-walk.ts:511-515`, `:544-553`): it decides what runs, which is
  trace's extension (ADR-0044 decision 3), and no unit of this RFC changes it.
- TypeScript selection by argument kinds: not added syntactically (Resolved questions 1); with a declared build output,
  ADR-0037 decision 10 already settles it (`typed`) and this RFC inherits it.
- The dependence rules of ADR-0036: a `typed` binding still proves a dependence and still does not prove execution.

## Delivery units

Order: U1 → U2 → U3; U4 after U2 (same adapter, no dependency on U3); U5 after U2. RFC-0027's U1 follows U4 (Seam).
Each unit is one commit, failing fixture first, `npm run check`, and the corpus gate before `main` (ADR-0039); every
`src/core/` change passes the gate.

| Unit | Change | Size (authored lines, estimate) | Gate expectation |
|---|---|---|---|
| U1 | The structural member rule answers the receiver's type: every owner kind, and the overload set's one implementation | ~200 | `trace:+`, `callers:±`, `impact:±` |
| U2 | A nominal receiver is answered by the Java owner, which the base asks before the structural rule | ~220 | `trace:+`, `callers:±`, `impact:±` |
| U3 | A receiver binding's candidates are the receiver type's members, not the name's homonyms | ~120 | `callers:±`, `impact:±`, `trace:±` |
| U4 | The contract bridge matches an implementation to its contract by signature | ~300 | `callers:±`, `impact:±`, `trace:none` |
| U5 | Trace's second Java receiver rule is deleted; the base binding is the only one | ~140 | `trace:±`, `callers:none`, `impact:none` |

### U1 — the structural member rule answers the receiver's type

- **Prerequisites:** none. Not L3, not V0a, not ADR-0044.
- **Files:** `src/core/application/navigation/call-binder.ts` (the declaring chain is `isOwnerKind`; the overload set
  collapses to its one implementation; `memberOf` → async; new `membersAbove`),
  `src/core/domain/impact/edge-policy.ts` (`isOwnerKind`),
  `src/core/application/navigation/graph-navigation.ts` (one `placedBetween` helper, moving `call-binding.ts:102-106` (`placed`) and `trace-walk.ts`'s `placedMethod` to it),
  `src/core/application/navigation/call-binding.ts` (`proven`/`ofReceiver` await the binder),
  `src/core/application/navigation/edge-targets.ts` (`await` at `:259`; `callablesIn` at the `createCallBinder`
  construction, `:128`),
  `src/core/application/trace/trace-walk.ts` (`await` at `:421`, `:430`; `callablesIn` where trace builds its binder).
  **Must not touch:** `adapters/spring/*`, any answer shape, `impact/*`.
- **RED test 1:** `src/core/application/navigation/call-binder.test.ts`, "an overload set binds to its one implementation".
  Fixture with `fakeCodeGraph`: class `Client` (`src/client.ts:1-12`) containing four `post` members at lines 2, 3, 4
  and 5; `callablesIn("src/client.ts")` answers `{name:"post", start:2, nameLine:2, body:false}`,
  `{...start:3, body:false}`, `{...start:4, body:false}`, `{...start:5, body:true}`. Assertion: `memberOf(Client, "post",
  place)` answers the member whose `startLine` is 5, for an arity-2 and an arity-3 call alike (the collapse is
  arity-independent). Why it fails today: `own.length === 4` returns `undefined` at `call-binder.ts:157`.
  **Variant beyond the observed case:** two same-named members **both with bodies** (declaration merging across files,
  `src/a.ts` and `src/b.ts`) answer `undefined`, and a type whose source the reader did not read answers `undefined` —
  both fail closed, pinned one test each.
- **RED test 2:** same file, "an interface is a declaring type". Fixture: `interface Strategy { expire(): void }` at
  `src/strategy.ts:1-4` and a receiver annotated with it; assert `memberOf(Strategy, "expire", place)` answers
  `Strategy.expire`. Why it fails today: `isClassKind` is `["class", "component"]` (`edge-policy.ts:17`) and line 155
  filters the interface out. **Confirmed** by reading; no corpus case of this branch was re-probed.
- **GREEN:** the three tests pass; `bound()` in `call-binding.test.ts` binds `this.m()` with three overloads to the
  implementation as `declaration/overload`. Real probe: `repro/p-ts-overload.json` step 1 on `name-webapp` — the two
  `this.rest.post`/`.patch` cuts become steps into `rest-client.service.ts:44-57` / `:88-...` and `effects` names the
  HTTP `POST`/`PATCH`; no answer gains a candidate list of four.
- **Corpus gate:** `--expect trace:+ --expect callers:± --expect impact:±`. `trace:+` because a cut becomes steps on
  `nname`; `±` because a dependence previously `name-match` becomes `proven` (ADR-0036) and one attributed cut per
  overload becomes one step. Report every moved answer with its cause.
- **Docs:** RFC-0010 (an overload set binds to its implementation, and no signature is selected without a declared build
  output — the limitation of Resolved questions 1), RFC-0013 R6 (the cut lists the receiver's declarations), ADR-0029's
  lexical-binding rule untouched.
- **Risks / high-risk item:** none by the global list (no stored data, security, public contract, concurrency or
  delivery surface); only `core/application` signatures move.

### U2 — the base asks the Java owner for a nominal receiver

- **Prerequisites:** U1. Not L3, not V0a, not V0b: `receiverMethods` exists and answers on `main`
  (`import-origins.port.ts:102`). If V0b is already on `main`, the unit inherits its exact-signature link and adds no
  signature rule.
- **Files:** `src/core/application/navigation/call-binding.ts` (`memberOfReceiver` and `ReceiverMemberAnswer`; `proven`
  reads the answer), `src/core/application/navigation/call-binder.ts` (no Java branch: `memberOf` stays the structural
  rule; `membersAbove` is U1's), `src/core/application/navigation/edge-targets.ts` (`receiverVerdict` awaits the answer
  and keeps the redirect), `src/core/domain/impact/edge-policy.ts` (`isOwnerKind`, from U1, reused),
  `src/core/ports/import-origins.port.ts` (`MethodPlace`, `unproven.candidates`),
  `src/core/adapters/spring/java-receiver-methods.ts` (one function: `unproven` carries its candidates),
  `src/core/adapters/typescript/*`'s `receiverMethods` answer stays `unknown` (no change). **Must not touch:** trace,
  `impact/*`, any answer shape.
- **RED test:** `src/core/application/navigation/call-binding.test.ts`, "a nominal receiver the owner settles by arity
  binds to that declaration". Fixture: `interface Port` (`src/main/java/p/Port.java:1-8`) declaring `load(String)` at
  line 3 and `load(String, int)` at line 4 (both `body:false`); class `Holder`, body `run` at
  `src/main/java/p/Use.java:5-9`; a call `port.load(a, b)` at line 7 whose receiver the source binds as
  `{receiver:"port", member:"load", holds:{kind:"annotated", type:"Port", line, column}}`; `imports:{Port:"Port"}`;
  `receivers:{load:{kind:"method", file:"src/main/java/p/Port.java", start:4, nameLine:4}}`. Assert the binding is
  `{kind:"receiver", target: Port.load@4}` with `candidates` = both `Port.load` declarations. Why it fails today: the
  proof reaches `proven` (`call-binding.ts:135-146`), `binder.memberOf(Port, "load")` refuses the two-member set
  (`call-binder.ts:157`) **and** the interface (`:155`), so `target` is absent and `attributed` holds the members — a
  `declared`/`receiverMethods` path never runs because the proof is `syntax`, not `none` (`:216`). The fixture is chosen
  so the `declared` path cannot pass it: the receiver binding is a syntax annotation, not an unanswered proof.
  **Variant beyond the observed case:** the owner answers `{kind:"unproven", candidates:[line 3]}` for a generated
  supertype the graph does not hold — `target` is absent and `candidates` is that one place, not the graph's set.
- **GREEN:** both tests pass. Real probe (expected, confirmed by the unit): `repro/p-java-trace.json` step 1 —
  `findVisitById` (line 103) becomes a step into `ClinicService.findVisitById` and a dispatch to
  `ClinicServiceImpl.findVisitById`; `deleteVisit` (line 107) stops listing the controller's own declaration; the two
  `ResponseEntity` `callee-unknown` cuts stay (not receiver settlements).
- **Corpus gate:** `--expect trace:+ --expect callers:± --expect impact:±`. `trace:+` on petclinic, `nname` and shopizer
  (cuts become steps); `callers`/`impact` `±` where an index edge's receiver verdict moves from `name-match` to `proven`
  or from an attribution to a redirect.
- **Docs:** RFC-0010 (a nominal receiver's dependence is the type's declaration), RFC-0013 R3/R5 (the owner answers),
  ADR-0044 decision 1 gains the sentence that the base reads it (recorded as its own ADR).
- **Risks / high-risk item:** item 3 (**contracts others consume**) only if `ImportOrigins` is read as a published
  contract; it is an internal core port, and the change is an additive optional field with `import-origins` conformance
  fixtures. State it in the PR summary.

### U3 — the candidates are the receiver type's members

- **Prerequisites:** U1, U2. Not L3 (U3 reads `ReceiverProof`/`ReceiverMemberAnswer`; an `EdgeTarget` field L3 adds is
  not read here).
- **Files:** `src/core/application/navigation/call-binding.ts` (the `proven` branch U2 introduced: `candidates` and
  `attributed` come from the answer instead of `namedDeclarations`, `:165`). **Must not touch:** `trace-walk.ts` (it
  already prints `binding.candidates` at `:456`), `reverse-calls.ts`, `impact-cuts.ts`, the cut vocabulary.
- **RED test:** `src/core/application/navigation/call-binding.test.ts`, "an unsettled receiver's candidates are the
  members of its type, not the homonyms". Fixture: `class A` (`src/a.ts:1-8`) declaring `save(String)` at line 3 and
  `save(String, int)` at line 4; `class B` (`src/b.ts:1-6`) declaring `save(String)` at line 3; a body `a.save(x)` whose
  receiver proof is a syntax annotation naming `A` (`imports:{A:"A"}`, the same fixture shape `bound()` uses); `memberOf`
  answers `undefined` (two members, no body). Assert
  `binding.candidates` = `["A.save@3","A.save@4"]` and no `B.save`. Why it fails today: `:165` builds `candidates` from
  `namedDeclarations(name, file, true)` — every in-scope declaration of the name, `B.save` included — while
  `attributed` (already `declares`-filtered, `:138`) holds only `A`'s. **Variant beyond the observed case:** an unproven
  receiver (a call result) keeps `candidates` = the in-scope name set and `attributed = []`, so the reach of that cut is
  unchanged — pinned by a test.
- **GREEN:** both tests pass. Real probe: `repro/p-java-trace.json` step 1 — the line-107 cut prints
  `ClinicService.deleteVisit, ClinicServiceImpl.deleteVisit` and no longer the controller's own `deleteVisit`; the
  `name-only` cut count of `repro/p-java-homonym.json` is recorded before and after (it moves with U4, not here).
- **Corpus gate:** `--expect callers:± --expect impact:± --expect trace:±`. Report the cut counts per query; a cut that
  loses a candidate must be listed with the declaration removed and why it cannot be that call's target.
- **Docs:** RFC-0010 (attribution), RFC-0002 (cut reach, no vocabulary change), ADR-0042 decision 2.
- **Risks / high-risk item:** none by the global list.

### U4 — the contract bridge matches by signature

- **Prerequisites:** U2 (same adapter and same signature reading). Not V0a: the owner answers today.
- **Files:** `src/core/ports/import-origins.port.ts` (`ImplementedDeclarations`),
  `src/core/application/impact/inbound-edges.ts` (`bridgesOf` asks the port), `src/core/application/impact/inbound-origins.ts`
  (`inboundEdgesOf` takes the port and passes it), `src/core/application/impact/impact-queries.ts` (the
  `inboundEdgesOf(...)` call at `:537` passes the read's origins),
  `src/core/adapters/spring/java-receiver-methods.ts` (`implementedDeclarations`, reusing `readSignature`,
  `sameSignature`, `JavaProject.hierarchy`), `src/core/adapters/typescript/import-origins.adapter.ts` (answers
  `{kind:"unknown"}`), `src/composition/*` (wire the new port member). **Must not touch:** `walk.ts`,
  `impact-queries.ts`'s traversal, `edge-targets.ts`.
- **RED test:** `src/core/application/impact/inbound-edges.test.ts`, "a method bridges to the contract declaration of its
  own signature". Fixture with the existing fake reader: `interface Port { save(x: string); save(x: string, y: number) }`
  at `src/port.ts:2`, `:3`; `class Impl implements Port` with `save(x: string, y: number)` at `src/impl.ts:4`; the port
  answers `{kind:"declarations", declarations:[{file:"src/port.ts",start:3,nameLine:3}]}`. Assert
  `callersOf(Impl.save)` bridges to exactly `Port.save@3`. Why it fails today: the bridge filters by
  `candidate.name === method.name` (`inbound-edges.ts:141`) and returns both. **Variant beyond the observed case:** the
  port answers `{kind:"unknown"}` → the bridge keeps today's by-name set, pinned by a test so the fallback cannot be
  dropped silently.
- **GREEN:** both tests pass. Real probe (expected): `repro/p-java-homonym.json` steps 1-2 — the two `reached
  entrypoints` sets differ, and the depth-0 block lists only the seed's own declaration.
- **Corpus gate:** `--expect callers:± --expect impact:± --expect trace:none`. The `callers`/`impact` moves on `shopizer`
  are the point; `trace` reads no bridge.
- **Docs:** RFC-0010 (the dispatch bridge's rule), ADR-0045 decision 2 (the new B2b row with its retention and
  fixtures), ADR-0044 decision 1's placement table (one row).
- **Risks / high-risk item:** none by the global list; the new port member is additive and the `unknown` fallback keeps
  today's answers for a language that cannot answer.

### U5 — trace's second Java receiver rule is deleted

- **Prerequisites:** U2 (the binding now answers a nominal receiver) and U3. Not L3: U5 removes trace's own rule, which
  reads `receiverBindings`/`declaredTypes`, not `EdgeTarget`.
- **Files:** `src/core/application/trace/trace-walk.ts` (delete `nominalMethod` `:251-264` and its two uses `:406`,
  `:498`; the `annotated` pass keeps `declaredTypes` and reads the binding's target). **Must not touch:** trace's
  `receiverMethods` dispatch read (`:511-515`, `:544-553`), `memberDeclarations` (`:62`, `:150`, `:380`) and
  `trace-queries.ts:136`, `:165`, which stay: that index states whether an unsettled call names repository code at all
  (RFC-0013 R6) and decides no binding.
- **RED test:** `src/core/application/trace/trace-walk.test.ts`, "a Java receiver is settled by the binding, not by a
  second rule in the walk". Fixture: a body whose call the base settles to `Port.load` at `src/main/java/p/Port.java:4`,
  with a second class in the same file declaring `load` at line 9. Assert the walk has one child step at `Port.java:4`
  and one cut for the sibling call; today the `nominalMethod` path (`:498`) answers the line-9 declaration for the same
  call. Test `nominalMethod`'s absence by asserting the step and by the source scan below. Why it fails today: `:406`
  chooses `nominalMethod` before the binding's target. **Variant beyond the observed case:** a call the binding binds
  `outside` still becomes an external call, not a cut (pins that the deletion did not swallow the leaf rule).
- **GREEN:** the tests pass; no occurrence of `nominalMethod` remains under `src/`. Real probe:
  `repro/p-java-trace.json` step 1 — the same walk as after U2, with no trace-specific path left; `nname` `trace onSave`
  unchanged from U1's answer.
- **Corpus gate:** `--expect trace:± --expect callers:none --expect impact:none`. `trace:±` because a cut candidate list
  or a step may move; a step that disappears is a regression, so the report is read line by line.
- **Docs:** RFC-0013 R3/R5/R6 (trace's chain is the base's plus execution), ADR-0041 decision 1 (one binder) gains a
  delivered line.
- **Risks / high-risk item:** item 6 (**no test would catch a regression in what changes**); the RED tests plus the
  corpus gate cover the walk's decisions. This is the only unit that removes code.

## Measurement

| Unit | Study items it should close | How to re-check |
|---|---|---|
| U1 | `N-nname-TS-FLOW.A1-N1`, `.A2-N1`, `.B1-N2`, `CF-nname-TS-FLOW` | `repro/p-ts-overload.json` step 1 on `name-webapp`: `effects` names the HTTP verb, and the `this.rest.post`/`.patch` cuts are gone |
| U2 | `N-PETCLINIC-J-FLOW.A1-N1`, `.A1-N2`, `.A1-N3`, `.A2-N2`, `N-nname-J-FLOW.A1-N2`, `.A2-N2`, `N-shopizer-J-FLOW.A1-N2`, `N-shopizer-J-IMPACT.A1-N3` | `repro/p-java-trace.json` step 1 and the same plan with `nname`/`shopizer` routes: the interface hop becomes a step, and the cut no longer lists the implementation beside the interface declaration |
| U3 | the printed candidate list of every Java trace item (M6); the cut volume behind `N-shopizer-J-IMPACT.A2-N1`, `.A2-N2`, `CF-shopizer-J-BUG` (M4) | `repro/p-java-trace.json` step 1: the line-107 cut loses the controller's homonym; `repro/p-java-homonym.json`: the `attributed`-cut count per answer, before and after |
| U4 | `N-shopizer-J-IMPACT.A2-N1`, `.A2-N2`, `N-shopizer-J-BUG.A2-N4`, `CF-shopizer-J-BUG` (M3, and the `name-only` volume M5) | `repro/p-java-homonym.json` steps 1-2: the two `reached entrypoints` sets must differ, and the depth-0 block must list only the seed's own declaration; record the `name-only` place count |
| U5 | the trace half of the Java items above (M7) | the petclinic/nname traces must be identical before and after, and no `nominalMethod` remains |

A `callers` answer's **cut count** and its **route count** are the two numbers to report per item; the study's own
figures are the baseline (`23 routes / 48 cuts` for one `CustomerService.getByNick` overload).

## Resolved questions (owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes")

| # | Question | Decision |
|---|---|---|
| 1 | Must a TypeScript overload set select a *signature* by arity and argument kinds without a declared build output? | **No.** The one implementation is what runs, so the body and the HTTP effect are exact; a signature chosen from syntax would be a guess (a literal `"1"` and a `number` are indistinguishable at the callee's declared type). With a declared `node_modules`, ADR-0037 decision 10 already answers it (`typed`). The limitation is recorded in RFC-0010 by U1. |
| 2 | Does the contract bridge keep a by-name fallback for a language that cannot answer (`unknown`/`capability-absent`)? | **Yes**, at today's confidence and only there: a language that cannot state signatures still has same-named contract members a change may break. Removing it would lose true dependences; `name-match` states the uncertainty ADR-0036 already has a value for. U4's fixture pins it. |
| 3 | Does ADR-0041 open question 7 (index unresolved references lose the unattributed homonym cut) get decided by this RFC? | **Not here.** U3 and U4 shrink its volume causally (the reach no longer contains sibling overloads, M4's attributed cuts fall to the receiver's members), and U2 supplies the receiver-typed candidates OQ7 says the decision needs. OQ7 is decided on the M5 report re-run after U4, with the bound that no answer's size grows and ADR-0045 M1 holds. |
| 4 | Is the overload collapse a new derivation value for dependence (`overload`)? | **No.** Keep ADR-0036's `proven`; record the collapse in the binding's internal `link`. A new value would be vocabulary under RFC-0002 rule 6 with no consumer that reads it. |
| 5 | Who owns `CallBinder.memberOf`/`declares` and in which order do the drafts land? | **RFC-0024 owns them, `GraphSymbol`-based and asynchronous; U1–U4 land before RFC-0027's U1, and RFC-0027 extends the contract afterwards** (lead decision). `membersAbove` is part of the same contract. No unit of either draft offers two contracts for one question. |

## Review responses

| Finding | Response |
|---|---|
| R1 | **Accepted.** U2's RED now drives the `proven` path from a syntax annotation (not the `declared` path) and asserts the `receiver` target, so the `declared`/`settleDeclared` route cannot pass it; the failure reason is named at both `call-binder.ts:155` and `:157`. |
| R2 | **Accepted.** U3's premise was false: `attributed` is already `declares`-filtered (`call-binding.ts:138`) and excludes `B.save`. U3 now asserts the **`candidates`** list (built at `:165` from `namedDeclarations`) and its fixture uses an overload set so `memberOf` refuses and the assertion is reachable. |
| R3 | **Accepted.** `ReceiverMemberAnswer { target?; candidates }` is the return type of `CallBindings.memberOfReceiver`; algorithm 2 and 3 read it. |
| R4 | **Accepted by removal.** U5 deletes only `nominalMethod` (`trace-walk.ts:251-264`, uses `:406`, `:498`); `memberDeclarations` (`:62`, `:150`, `:380`) and `trace-queries.ts:136`/`:165` **stay** as trace's RFC-0013 R6 reading and decide no binding. Reach's `:511-515`/`:544-553` row is relabelled trace's dispatch read, not a settlement copy. |
| R5 | **Accepted.** `ImplementedDeclarations` is a union with `declarations`, `none`, and `unknown` (reason optional `capability-absent`). |
| R6 | **Accepted.** U1 lists `trace-walk.ts` (`:421`, `:430`), `call-binding.ts` (`ofReceiver` → `proven`) and `edge-targets.ts:259` as the call sites of the now-async `memberOf`. |
| R7 | **Accepted.** U3's conditional L3 read is removed: no L3 prerequisite for U3, and the type it reads is `ReceiverProof`/`ReceiverMemberAnswer`, not L3's `EdgeTarget`. |
| R8 | **Accepted.** U5's prerequisite is U2 + U3, not L3; `nominalMethod` reads `receiverBindings`/`declaredTypes`, which L3b does not remove. |
| R9 | **Accepted.** M4 and M5 are separated: M4 = `attributedCallCuts` over `ReverseCalls.into` (`impact-cuts.ts:96`, `reverse-calls.ts:202`, `impact-queries.ts:551`); M5 = `unresolvedLinkCuts` (`:163`, `:203`, `:217`, `:226`). U3 moves M6 (trace's printed list) and M4's list; U4 moves the `name-only` volume through M3's siblings. |
| R10 | **Accepted by scope.** V0a/V0b are pending (`adr/0044-...md:445-446`) and are **not** prerequisites: `receiverMethods` answers on `main` (`import-origins.port.ts:102`), and U2/U4 call it as it is; V0b is inherited when it lands. |
| R11 | **Accepted.** The workspace path gains `app/`; the bridge filter is `inbound-edges.ts:141` (read on `d0aee793`: `141: .filter((candidate) => candidate.name === method.name)`); `bodyOf` starts at `trace-walk.ts:340`; ADR-0045 L3 is `:492`. |
| Q1 | **Accepted** as the lead's seam decision, stated in "Seam with RFC-0027" and in U1's contract. |
| C1–C16 | Not this draft's findings (briefs / RFC-0027); the baseline `d0aee793` is stated in the header and every `path:line` was re-read on it. |

## Decisions recorded in ADR-0046

1. A member call binds to the declaration its receiver's type offers at the call's signature, and the declarations that
   type offers are its candidates — never the repository's homonyms.
2. A TypeScript overload set binds to its one implementation; a nominal language's selection is its owner's
   (`receiverMethods`, with ADR-0044 V0b's exact-signature link).
3. The dispatch bridge between an implementation and its contract matches by signature, and a language that cannot state
   signatures keeps the name-only bridge at the existing heuristic confidence.
4. Trace reads only the base binding; no family keeps a second receiver rule.
