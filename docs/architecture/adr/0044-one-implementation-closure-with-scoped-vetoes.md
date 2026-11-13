# ADR-0044: What a Java call names and what it may run have one owner per language, and its vetoes reach only what their cause may implement

- Status: Accepted, 2026-11-09. The owner delegated closing and accepting it after an independent review, verbatim:
  "Cierra los 3 ADR pendientes con lo que recomiendes para las preguntas pendientes. Que se revisen con sol high y se
  queden aprobados y listos. Ten en cuenta los cambios que aplicará 0045 por si debe cambiar algo en estos". Reviewed
  and rechecked by an independent reviewer; open questions closed into decisions; V1b keeps its stated precondition.
- Decision source: the owner, 2026-11-08, verbatim: "lanza un agente con esfuerzo high por cada propuesta para que la
  analice conjuntamente con la evidencia, que investigue y proponga un ADR de cambio". Translated: launch a high-effort
  agent for each proposal, to analyse it together with the evidence, investigate and propose a change ADR. The proposal
  this ADR answers is the tech lead's question after the MCP evaluation of that day: "whether ye-ast needs a shared model
  of which implementation runs behind a port, used by trace, callers/impact and contract_consequences alike", building on
  ADR-0041. Standing owner rules that bound it: facts, not guesses; noise is worse than no fix; no size threshold without
  a measurement; fix the mechanism, never one repository's case; project-agnostic; deterministic; no SCHEMA bump while
  the MCP has no consumers. Revised the same day after an independent review that compiled every probe with javac 21.
  Closed on 2026-11-09 on the owner's instruction, verbatim: "Cierra los 3 ADR pendientes con lo que recomiendes para
  las preguntas pendientes. Que se revisen con sol high y se queden aprobados y listos. Ten en cuenta los cambios que
  aplicará 0045 por si debe cambiar algo en estos". Translated: close the three pending ADRs with what you recommend
  for their open questions, have them reviewed and left approved and ready, and take into account what ADR-0045 will
  change. Every open question is now a decision (10 to 15) or a recorded follow-up with its trigger, and the units are
  placed on ADR-0045's assembly line ("Place on the assembly line"). Every `file:line` of `src/` was re-read on main
  8c5f181a; the corpus repositories' lines are as reproduced at engine 3ffd2fe4.
  Revised the same day after an independent review: decision 10 gained complete release keys, the Gradle release and
  toolchain precedence, the access flags the table must carry, and the redistribution precondition of V1b.
- Amended by: [ADR-0063](0063-a-jdk-the-host-declares-is-the-library-signature-source.md) (decision 10: the library signature source is a JDK the host declares, with no pin, a lazy index, the JDK's own release and an upper-bound refusal; the table no longer ships and the redistribution risk is resolved)
- Related: [ADR-0013](0013-coverage-grows-only-with-evidence.md), [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md),
  [ADR-0036](0036-dependence-is-the-compile-time-binding.md), [ADR-0037](0037-host-declared-build-outputs.md),
  [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md), [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0045](0045-one-assembly-line-for-the-snapshot-reading.md), [ADR-0007](0007-dependency-versions.md),
  [RFC-0013](../rfc/0013-trace-and-patterns.md), [RFC-0021](../rfc/0021-java-value-flow.md),
  [RFC-0022](../rfc/0022-contract-change-consequences.md), [RFC-0023](../rfc/0023-consequences-surfaces.md)

**In short:** the two symptoms do not share a cause. Petclinic stops before dispatch: a build-generated supertype leaves
Java names unsettled, and dispatch already proves the single body. Nname stops at a repository-wide veto: any lambda
anywhere vetoes every one-method interface, and the single body is proven only with that veto off. Contract consequences
fails for a third reason: it starts at the root of a propagated call site, re-finds the request by line and name, and
has no Java reader. What the code does show is more than one Java writer of what a call names and what it may run:
trace's strict readers, and the call-site flow's lenient ones, disagree on both the declaration a call binds to and the
bodies below it. Both facts get one owner per language behind the existing `receiverMethods` and `dispatchTargets`
ports, the only Java link of ADR-0041's binder. A veto is released only by positive proof about every possible target
type of its cause, dispatch stays trace's extension of ADR-0041's base, and the dependence families keep their bridges. A sound release of nname's veto needs library signatures that no reader has
today: a JDK signature table generated from a pinned JDK, selected by the release the build declares, enters as one
stage of ADR-0045's Java pack (decision 10). Every unit lands on the assembly line: the two owners are Java-pack
readings of the B2b contract over the B5 project, the vetoes and the closure read line stages, and the call-site flow
(E18) leaves its frozen place in the single-owner test when it reads the owner (V3).

## Context

### The hypothesis

The lead's hypothesis (unverified): (a) `contract_consequences` in nname cites use-case calls instead of the adapter
that issues the HTTP call (`RecipientRestRepositoryAdapter.java:41-49`), and (b) trace does not follow an interface with
a single implementation (petclinic `ClinicService` → `ClinicServiceImpl`; nname `RewardPointsRepositoryPort`), while
`callers` resolves it. Both may come from a missing shared implementation-selection model.

### What the reproduction shows (engine 3ffd2fe4, CLI and adapter probes, 2026-11-08)

| Case | Where it stops | Mechanism | Proof |
|---|---|---|---|
| petclinic `GET /owners/{ownerId}` (corpus query `trace-backend-rest-owner-route`) | `OwnerRestControllerV1.java:92`, `unresolved-link` listing `ClinicService.findOwnerById` and `ClinicServiceImpl.findOwnerById` | Before dispatch. The index's call edge is kept only when the receiver reading proves the method (`trace-walk.ts:537`); `receiverMethods` answers `unproven` because the field's type `ClinicService` does not resolve: the strict reading answers `unsettled` for a simple name inside a class whose supertype is not a project type (`java-symbols.ts:283-293`, `:449-466`), and the controller implements `OwnersApi` (`OwnerRestControllerV1.java:54`), generated by `openapi-generator-maven-plugin` into `target/generated-sources` (`pom.xml:349-374`). This is right: an inherited member type shadows a single-type import in the class body (JLS 6.4.1) | `dispatchTargets` at `ClinicService.java:56` already answers one body, `ClinicServiceImpl.java:200-202`. With the 35 generated sources added to the reader, `receiverMethods` answers `ClinicService.java:56` and dispatch is unchanged |
| nname `DiscountsApplicationServiceImpl.quoteRewardPoints` (corpus query `trace-ms-name-orders-quote-checkout-discount` reaches it) | Step at `RewardPointsRepositoryPort.java:8`, then a cut with detail `dispatch not proven` listing `RewardPointsRepositoryAdapter.quoteRewardPoints` | At dispatch, veto 3: `hierarchy.functionValues` is true when any source holds a lambda or method reference (`java-dispatch-targets.ts:226-230`), and with it every functional interface is unknown (`:88`). The port declares one abstract method | Today `dispatchTargets` answers `unknown` (`dispatch not proven`). `targetsOf` with only `functionValues` set false answers one body, `RewardPointsRepositoryAdapter.java:30-31`. RFC-0013 R7 measured it: "its one-method repository ports stay cut, since the service holds lambdas" |
| nname `GET /users/{userId}` response `phone` removed (NU-CC-1) | Frontiers `unknown (source-unreadable)` at `OrderCreatedListenerNats.java:41` (and, in the evaluation, `OrdersController.java:41,53`) | Not implementation selection. The call-site flow did select the adapter: it reached the library request through `NotificationApplicationServiceImpl.java:55` and `RecipientRestRepositoryAdapter.java:39`. But a request reached through other methods is reported once per root of the propagation (`http-call-sites.adapter.ts:63`, `java-method-flow.ts:197-203`); the issuing owned call is listed only by `placed` (`includeNested`). The consequence carrier starts at the link's call site (`contract-consequences-queries.ts:161`), and the only consumer flow reader is TypeScript (`consumer-flow.adapter.ts:22`): a Java carrier is `source-unreadable`. RFC-0022 states Java consumers out of P4 | `of`: `GET .../users/{userId}` at `OrderCreatedListenerNats.java:41`; `placed` adds `RecipientRestRepositoryAdapter.java:47`, the `restClient.execute` whose response `UserResponse` is read at `:49` |

Side facts from the same probes, not causes of the symptoms:

- Over every tracked source, tests included, the nname dispatch reading answers `generated implementation`, because
  `OrdersControllerTest.java:148` names `java.lang.reflect.Proxy` (`java-dispatch-targets.ts:282-299`;
  `java-receiver-methods.ts:61` vetoes receiver selection the same way). Trace's read does not hand test sources to that
  reader (a trace target in that test answers `unknown-symbol`), so the answer shows `dispatch not proven`.
- Two `ms-name-notifications` sources do not parse (`NotImplementedFeatureError.java:9`: a statement before
  `super(...)`, a flexible constructor body). A source that does not parse vetoes every Java proof of the snapshot
  (`java-dispatch-targets.ts:62`), and those two places are half of NU-CC-1's `unknown (unresolved)` list.

### Verdict on the hypothesis

| Claim | Verdict |
|---|---|
| (a) and (b) share one root cause | Refuted. (a) is the place a propagated call site is reported plus the missing Java consumer reader; (b) is two scoping defects |
| Trace does not follow an interface with a single implementation | Refuted as stated, with a difference between the cases. Petclinic: dispatch already proves the single body; trace stops one link earlier, at static selection under an undeclared supertype. Nname: dispatch answers `unknown` today, because of the repository-wide function-value veto; it proves the single body only when that veto alone is disabled |
| `callers` resolves it, so trace and `callers` disagree | True, by design. `callers` follows the index's edge and impact's dispatch bridge (`basis: "dispatch"`, `derivation: "resolved"`, `inbound-edges.ts:143-152`). A dependence holds whatever implementations exist (ADR-0036); what runs needs the closed set |
| A shared implementation-selection model is missing | Partly true, not where the hypothesis put it: below |

### Three readings of "what runs below the static target"

| Reading | Where | Candidates | Closure proven | Framework choice | Consumers |
|---|---|---|---|---|---|
| Dispatch bridge | `inbound-edges.ts:143-152` | Same-named methods of the index's types above or below | Not needed: dependence | None | `callers`, `impact`, the callers step of contract consequences |
| R7 dispatch | `java-dispatch-targets.ts:53-104` | Bodies of every concrete class below the owner, by the strict reading | Yes, or `unknown` with a reason | None: R7 says "a framework's choice among several (a qualifier, `@Primary`, a profile) is not read" | Trace (`trace-walk.ts:306-319`) |
| Call-site method flow | `java-method-flow.ts:28-56`, `:73-110` | Every concrete class below, through `project.hierarchy` | No: no veto for lambdas, proxies, aspects, generated or anonymous implementations | `@Qualifier`, `@Primary`, named `@Bean` (RFC-0021 S2), applied to every call on a value of the type | HTTP and event call sites: `workspace`, `decisions`, trace effects, contract consequences |

The last two are two writers of one fact. On the nname port the call-site flow propagates through the adapter while
trace calls the same step not proven; with two implementations and `@Primary`, trace cuts while the call-site flow
selects. AGENTS.md: "One owner per fact ... a second writer is a defect."

### The static binding above it has more than one Java writer too

Which declaration a Java member call names (the static binding ADR-0041 decision 4 calls the "Java declared receiver")
is read three ways (main ac475e50, unchanged on 8c5f181a):

| Reader | Where | Receiver type | Overloads | Privacy, reflection, rewriting |
|---|---|---|---|---|
| Strict, behind `receiverMethods` | `java-receiver-methods.ts:51-90` | Bindings of a parameter, a local or a field (`javaReceiverBindings`), resolved by the strict reading (`java-declared-types.ts:127-150`), `unsettled` under an undeclared supertype | Exactly one signature at the call's arity | Vetoes: a dynamic-implementation API, an unparsed source, call-rewriting annotations |
| Lenient, the call-site flow | `java-invocations.ts:59-77` (`receiverOf`), `java-method-flow.ts:82-109` (`methodsOf`) | `project.lookupType`, the non-strict reading that falls back past `unsettled` (`java-symbols.ts:495-498`), then `externalNames`; an identifier is taken as a type name whenever such a type exists (`java-method-flow.ts:85-88`) | Every same-arity method of the name, all kept (`:101-108`) | None |
| Data effects | `data-effects.adapter.ts:22`, `:37-110` | Bindings with `includeUnproven: true`, resolved strictly; an unproven one makes the effect unknown | Its own matching: the one overload whose parameters equal the arguments' signature | Reflection and privacy only through the binding's `unproven` flag |

On `OwnerRestControllerV1.java:92` the strict reader answers `unproven` while `methodsOf` answers
`ClinicServiceImpl.findOwnerById:200` (adapter probe), so a call site propagates through a binding trace refuses. With
`find(String)` and `find(Long)` the strict reader cuts and the lenient one propagates both. ADR-0041 U3 makes one binder
in the core; the adapter's own readers sit below its ports and are not covered by it.

### The carrier re-finds its request

The TypeScript request reader decides what a request is in one predicate (`http-call-sites.adapter.ts:592-608`). The
consumer walker (`consumer-flow.walker.ts:136`, `:1005-1011`) and the request-origin reader
(`request-origins.adapter.ts:26`, `:62-66`) re-find the request from the site's line and symbol, without its column,
taking the first call that their own predicate accepts. On `return this.cache.get(id) ?? this.http.get<U>(url);` both
calls start on the line and are named `get`, so the first syntactic match may be the cache's. The two re-finders also
disagree with each other: `requestKind` accepts `httpResource.text(...)`, `namesRequest` does not.

### What a sound release of the function-value veto needs

The first version of this ADR released the veto for a functional interface `F` when the statement holding a function
value mentioned neither `F` nor a member typed with it. The review refuted it with programs that compile (javac 21):

- **Inherited library generics.** `class Slots extends java.util.ArrayList<Port> {}`, then `slots.add(() -> "lambda")`:
  the lambda implements `Port`, and the statement names only `slots` (type `Slots`) and the library member `add`. The
  same holds for `slots.add(Use::body)`, `slots.add(c ? () -> "a" : () -> "b")`, a switch expression argument and
  `slots.subList(0, 0).add(() -> "sub")`. The target is the parameter type of an inherited library method after
  substitution (JLS 15.12, 15.27.3, 15.13.2, 18.5).
- **Nested function values.** `interface Factory { Port create(); }`, then `Factory factory = () -> () -> "lambda";` or
  `return () -> () -> "returned";`: the inner lambda's target is the return type of the outer target's function type
  (JLS 15.27.3, 18.2.1), and the statement mentions only `Factory`.

For both, today's adapter answers `unknown` and disabling only `functionValues` answers the single body, so the first
rule would have turned a cut into a false step. A sound rule cannot reason from an absent mention. It must prove, for
each function value, that every type it may be converted to is neither `F` nor below it, and that proof needs the
parameter types of the method each function value is passed to.

The nname case shows what that costs. Its `src/main` holds 29 function values (the first version said 31, counting
switch rules and a logging configuration line). Every one is an argument of a library call: `map` 11, `filter` 10,
`reduce` 3, `orElseThrow` 2, `peek`, `anyMatch` and `requireNonNullElseGet` 1 each, on `Stream`, `Optional` and
`Objects` receivers, and none has a function value as its result. No reader of ye-ast knows a library member's
signature: the strict Java reading types repository declarations and knows platform names only (`isPlatformName`,
`java-symbols.ts:273`), and no reader types a receiver through a library return type (`menuItems.stream().map(...)`).
**So a sound rule over repository signatures alone releases none of them, and `quoteRewardPoints` stays cut.**

Three evidence sources could prove library targets without guessing:

| Source | What it proves | Cost and limits |
|---|---|---|
| Nothing | No library target; the veto stays wherever a function value is a library argument | None; the nname cut stays, honestly |
| A host-declared class path (an ADR-0037 kind: the build's jars and the JDK's `ct.sym` or `jmods`) | Every library the build used, as data the host declares | A class-file signature reader, a new parser over untrusted bytes; a new declaration surface |
| A JDK signature table generated at ye-ast's build time from a pinned JDK, as the TypeScript `lib` globals are generated from the pinned compiler (`typescript-lib-globals.extract.ts`) | `java.*` members only, selected by the release the build declares (`maven.compiler.release`, a Gradle toolchain); without a declared release, nothing | A generated data file and its extractor; third-party libraries (Spring, Reactor) keep the veto |

Decided: the JDK signature table (decision 10); the class path is follow-up F1. Each source also needs the raw class
of every receiver, typed through library return types. Only the raw class matters
when the parameter type at the function value's position is not a bare type variable, which holds for every nname case.
Expected, not measured: with the JDK table and that receiver typing, each of nname's 29 targets is a library functional
interface (`Function`, `Predicate`, `Consumer`, `Supplier`, `BinaryOperator`), so each excludes the port, and dispatch
would answer the single body that the probe with the veto disabled shows.

### Options weighed

| Option | For | Against | Verdict |
|---|---|---|---|
| A shared core layer of implementation selection, consumed by trace, `callers`, impact and contract consequences | One answer everywhere | Dependence needs no closure: impact would either pay vetoes it does not need (a dependence lost to a lambda elsewhere) or ignore them (then the layer is two layers). The proof reads Java trees and the strict resolver, which live in the adapter | Discarded |
| Keep both writers, scope the vetoes in trace only | Smallest change | Trace and `workspace` keep disagreeing about the same port; the lenient writer still states call-site targets through implementations it never proved closed | Discarded |
| **One owner per language behind the existing `dispatchTargets` port; the call-site flow reads it; a veto released only by positive proof** | One fact, one writer; no new core layer; the port already exists; ADR-0041's split (static binding in the base, dispatch in trace's extension) holds | The call-site flow becomes strict, so its propagation may shrink where a veto still holds (measured, V3); releasing nname needs a library signature source (V1b) | Chosen |
| Release the veto when the statement mentions no type or member of `F` | Cheap; would release nname today | Unsound: inherited library generics and nested function values implement `F` without a mention (javac 21) | Discarded |
| A single source implementation is proof (the call-site flow's rule, for trace too) | Unblocks both cases at once | A guess: a lambda, a proxy, a generated client or a test double may stand there | Discarded |
| Model the generator: derive `OwnersApi` from the OpenAPI document | No host declaration needed | Guesses the generator's version, templates and options; ye-ast would be writing code it then reads as fact | Discarded; ADR-0037's declared build outputs are the path |

## Decision

1. **Static binding plus closure, one owner per language.** Two facts, read in order: "the declaration a member call
   names at compile time" (`ImportOrigins.receiverMethods`) and "the bodies a call of that declaration on a value whose
   static type is `T` may run, and whether that set is closed" (`ImportOrigins.dispatchTargets`,
   `src/core/ports/import-origins.port.ts:88`, `:99`, answer shapes `:130-138`). For Java their only writers are
   `core/adapters/spring/java-receiver-methods.ts` and `core/adapters/spring/java-dispatch-targets.ts`.
   - The call-site flow stops binding and dispatching itself: `receiverOf` (`java-invocations.ts:68`) and `methodsOf`
     (`java-method-flow.ts:73`) ask the owner for the declaration, then for its bodies, instead of `lookupType`,
     `externalNames`, the identifier-as-type fallback, the same-arity list and `dispatchIndex.implementations`.
   - Data effects ask the owner for the declaration and keep only their own vocabulary (what a repository operation does
     to data). Their overload rule, "the one method whose parameters equal the arguments' signature", becomes a link of
     the owner, since an exact match is the most specific applicable method (JLS 15.12.2.5). It applies to every
     consumer once its fixture holds. An `unproven` answer keeps the effect unknown, as today.
   - Inside the adapter the owner answers the declared candidates and the closure verdict apart, and the port's value
     is derived from them: `bodies` when the closure is proven, `unknown` with its reason otherwise. The core never sees
     the candidates of an unknown closure. Until V3 the call-site flow reads the owner in a staging form that keeps
     today's lenient result (candidates whatever the verdict, the lenient binding where the strict one is unproven);
     from V3 it reads only proven bindings and proven closures, and the staging form is deleted.
   - The seam with ADR-0041: its base (`ReconciledCalls`, `core/application/navigation/`) owns the binding chain and
     reaches Java only through these two ports, whose adapter is this owner. U3's "Java declared receiver" link is
     `receiverMethods`; trace's dispatch extension reads `dispatchTargets`. The adapter's own readers (call sites, data
     effects) are below the ports and call the same owner functions directly. No second chain exists in the adapter,
     and no Java rule exists in the core.

   Fitness tests hold both (Migration, "Fitness functions").
2. **Separate from static binding, narrowing only.** ADR-0041's base binds the call to its compile-time declaration (the
   interface method, ADR-0041 decision 4); this fact answers what runs below it. A consumer never re-binds the call:
   the bodies are alternatives below the binding (ADR-0041 decision 6). This ADR adds no answer field of its own; the
   receiver classification ADR-0045 decision 5 adds to every binding is ADR-0045's, and this ADR supplies its Java values
   ("Place on the assembly line").
3. **Dispatch stays trace's extension; it does not become a shared core layer.** ADR-0041 decision 5 holds. The
   dependence families (`callers`, `impact`, `importers`, `outline`, the callers step of contract consequences) keep
   ADR-0036 dependence and impact's dispatch bridges, which hold whatever the closure, so no closure veto ever cuts
   them. The execution readers read the one fact: trace (R7), and inside the Java adapter the call-site method flow
   (RFC-0021 S2), so `workspace`, `decisions`, trace effects and contract consequences inherit it.
4. **A framework's choice narrows a call, never a method.** `@Primary` and `@Qualifier` decide what the container puts
   into a single-valued injection point, not what every value of the type is: `static String invoke(Port p) { return
   p.q(); }` called with `new Secondary()` runs `Secondary` whatever bean is `@Primary`. So:
   - The dispatch site gains a call-local input: the call's place. The adapter narrows only when it proves the call's
     receiver is the value of a single-valued injection point (a constructor or field the container fills, read through
     a field assigned once from it and never written elsewhere), and it reads that point's `@Qualifier`, the candidates'
     `@Primary` and named `@Bean` there. All Java and Spring interpretation stays in the adapter.
   - The answer keeps the closed set and the selected subset apart: the closed bodies, plus, when narrowing applied, the
     selected bodies and which proof chose them. Trace lists the closed set as `alternatives` and expands the selected
     one; with no selection it keeps today's rule (one body expands, several cut).
   - Without that proof (a parameter, a local, a call result, an unknown closure), the answer is the full closed set.
     A candidate the framework registers conditionally (a profile, a condition annotation) refuses the narrowing.
5. **A veto is released only by positive proof.** The precedent is the aspect veto, scoped to the join points its
   pointcuts may select (6afc788d, RFC-0013 R7). A function value keeps vetoing a repository functional interface `F`
   unless every type it may be converted to is proven to be neither `F` nor a type below it. Its possible target types
   come from its context, and an obligation that cannot be settled keeps the veto:
   - an assignment context with a written type (a local, a field or a variable initializer, never `var`): that type;
   - a casting context: the cast type, each member of an intersection;
   - a `return`: the enclosing method's written return type, or, inside a function value's body, the return type of the
     enclosing function value's target function type, recursively;
   - an invocation context: the parameter type at that position (the element type for a varargs position) of every
     declaration the invocation may select at its arity. That requires the receiver's class and its inherited members
     to be settled, and every candidate declaration to be read. A repository declaration is read from the sources; a
     library declaration only from a declared signature source (V1b). Inheritance through a type the reading holds no
     signatures for (`extends java.util.ArrayList<Port>`) leaves the invocation unsettled. A parameter type that is a
     type variable must be substituted by what the receiver's static type and the other arguments prove, or the
     invocation stays unsettled;
   - a conditional or switch expression arm, or a parenthesized expression: the context of the enclosing expression;
   - a function value as the result of another (an expression body, or a `return` in a block body): the return type of
     the outer target's function type after substitution (JLS 18.2.1), propagated recursively.

   A settled target excludes `F` when it is a class or interface type, or a parameterization of one, that is neither
   `F` nor below it in the declared hierarchy. A library type is never below `F`, since a library declaration cannot
   extend a repository type; an `F` that extends a library type is already vetoed (`generated implementation`,
   `java-dispatch-targets.ts:83`). The platform-type veto of `declaredTypes` (`subtypedTypes`,
   `java-declared-types.ts:66-80`) keeps its current form: a library context may target any platform interface, so
   this reading proves nothing there.

   As built, V1a (`java-function-values.ts`): `Hierarchy.functionValues` reads each lambda and method reference to
   `FunctionTargets`, repository types or `library`, or `unsettled`. The veto on a functional interface `F` holds when a
   value is unsettled or targets `F` or a type below it. Settled contexts are a declaration with a written type (never
   `var`), a cast, a `return`, conditional, switch and parenthesized arms, a value that is the result of another (the
   one abstract method of a repository target; a library target leaves it unsettled), and an argument of a call written
   without a receiver or on `this`, resolved in the innermost enclosing type that has a member of the name, over every
   declaration the arity may select. An assignment to an existing variable, a constructor argument and every call on
   another receiver are unsettled. Name resolution is the strict reading's, so a file whose on-demand imports could
   bind the written name keeps the veto.

   As built, V1b (`java-library-calls.ts`, ADR-0063): where the host declared a JDK for the file, an argument of a call
   on another receiver is read in the JDK's signatures. The receiver is typed to one raw class: a local, parameter or field
   with a written non-`var` type whose declaration's scope holds the use, a record component accessor, a repository
   method's written return type, `new C(..)`, a cast, a class name no variable can obscure, or a library call whose
   candidates agree on one non-variable class. Every member of the name at the arity is a candidate (variable arity from
   one argument fewer; an interface's static members only through the interface; a class name selects static members
   only), and the value is settled only when each candidate's parameter at that position is a library class: a type
   variable, an array, a primitive, a receiver or a type above it that the JDK does not hold, and a receiver chain through
   a repository type whose supertypes are not all repository types stay unsettled. A simple type name no declaration binds
   is the one `java.lang` or on-demand `java.*` type the JDK holds under the repository-compiles assumption (ADR-0062
   decision 1), and a name two of them hold is unsettled. A nested value takes the type argument its written library
   target states for the target's own single abstract method. A constructor argument stays unsettled.
6. **An undeclared supertype is never guessed.** A supertype the snapshot does not declare keeps the strict reading
   `unsettled` and the call a cut. Generated Java sources enter as an ADR-0037 build-output kind (its decision 1 lists
   "generated sources" for a later kind that has measured evidence, which this ADR supplies): a directory the host
   declares outside the repository, read as data through the confined reader, never generated by ye-ast. Its files join
   the strict reading's project as declarations, so they also count for closure (a generated implementation of a port
   vetoes it like any other), and they are never call sites, entrypoints or routes. With no lockfile analogue, a fact
   that used them states the declaration unverified (ADR-0037 decision 5). Without a declaration every answer stays
   byte-identical, except the cut detail decision 14 adds. The surface is decision 13.
7. **A propagated request is consumed where it is issued.** For a link whose call site was propagated through other
   bodies, contract consequences starts the carrier at the issuing owned call: the owned invocation whose expansion
   reaches the leaf without passing through another owned body (`RecipientRestRepositoryAdapter.java:47` above), read
   from the placed sites (`PlacedCallSiteReader`, the reader trace effects already use). The root stays in the chain as
   the entry it was reached from. The workspace fact keeps its call sites as they are. The carrier is located by the
   placed site's line and column through the request reader's own predicate (`http-call-sites.adapter.ts:592-608`),
   never re-found by line and symbol: the consumer walker and the request-origin reader stop keeping their own request
   predicates (`requestKind`, `namesRequest`) and ask that owner for the call at the site's place.
8. **A blocked propagation is a frontier, never a silence.** Once the call-site flow reads only proven closures (V3), a
   call whose candidates would reach a request but whose closure is unknown no longer expands
   (`flow.expand` answers nothing at `http-call-sites.adapter.ts:70`, through `methodsOf` at `java-method-flow.ts:231`).
   Today the reader then emits a site only for a recognized library receiver (`http-call-sites.adapter.ts:77-79`,
   `libraryOf` `:194`), so the root's request, and the URL or subject its arguments bind
   in the adapter, would vanish without a trace. Instead the reader emits at that call a site whose target is `unknown`
   (`unresolved`), with the blocked call and every candidate body as its evidence. The issuing call inside each
   candidate becomes a root of its own and keeps its own site.
9. **Coverage.** Java only. TypeScript types structurally, so R7 keeps its cut; another language enters with its reader
   and conformance fixtures (ADR-0013).
10. **The library signature source is a JDK signature table (V1b).** Decision 5's invocation obligations read a library
    declaration only from this source:
    - **What it is.** A data file generated by an extractor that reads the `ct.sym` of one JDK pinned exactly
      (ADR-0007), the file `javac --release N` itself compiles against. Per release it holds the public and protected
      members of the `java.*` packages: each type's kind (class, interface, enum, record, annotation), its `ACC_ABSTRACT`
      flag, type parameters and direct supertypes; each member's name, type parameters, parameter types and return
      type, generic signatures included, and its access flags `ACC_STATIC`, `ACC_ABSTRACT` and `ACC_VARARGS` (JVMS
      4.6), with bridge and synthetic methods left out. The flags are what lets a reading tell a varargs parameter from
      an array (JLS 15.12.2.4: a variable-arity method applies at more arities), a member a type name may select from
      an instance one (JLS 15.12.3), and the single abstract method of a functional interface, its default and static
      members and the public `Object` methods excluded (JLS 9.8), which decision 5 needs for nested function values. An
      obligation whose decision needs metadata the table does not hold stays unsettled. It follows the TypeScript `lib`
      globals precedent (`typescript-lib-globals.extract.ts`): ye-ast's own pinned input, extracted as data, so no
      repository bytes are parsed and the answer is deterministic. A JDK pin upgrade regenerates it and passes the
      corpus gate like any parser upgrade (ADR-0013 decision 3).
    - **Why the class file is read by ye-ast itself.** V1b.1a and V1b.1b read `ct.sym`'s entries and their class files
      with code ye-ast owns, not with a dependency. No maintained JavaScript parser for the Java class-file format
      exists (npm, searched 2026-11-10: `java-parser` reads source, and the rest of the results are other virtual
      machines' bytecode), so the alternatives were an unmaintained single-author package or a port of a JVM tool; the
      subset this table needs is closed and small (JVMS 4.6: header, constant pool, flags, interfaces, members, and the
      `Signature` and `Record` attributes); and the reproducible generator needs the reading to be stable, free of
      external processes and independent of the JDK build that happens to be installed. The cost is real and measured:
      the first decoder read the field table as an attribute table and misaligned every following method, caught only by
      decoding the 16 063 real entries of one `ct.sym`; that reading is now a test and the validation against the real
      file is part of the unit's evidence.
    - **Precondition of V1b.** Before V1b ships, its commit fixes: the concrete JDK distribution and version, and the
      digest of the archive the extractor reads; a reproducible generator (same input digest, same output bytes) and
      its deterministic serialization (sorted keys and members, no timestamps); and the licence and notices that apply
      to redistributing the derived table. OpenJDK is GPLv2 with the Classpath Exception (`LICENSE` and
      `ADDITIONAL_LICENSE_INFO` of the JDK repository); calling the table "derived data" does not by itself prove it
      may be redistributed. If redistribution is not clearly allowed, ye-ast does not ship the table: V1b generates it
      at install time from a JDK the user already has, pinned by the same digest (a JDK with another digest generates
      nothing, and every library obligation stays unsettled), read from a host path the user names, never from
      repository content. The table's bytes are identical either way.
    - **Selection: the release of the compile that owns the source.** A source reads the table of the release its
      build passes to `javac --release`, and only that. A version guessed from the sources is never used.
      - Maven: the effective `<release>` of the `maven-compiler-plugin` execution that compiles the source, or, where
        no `<release>` is configured, the effective `maven.compiler.release` property. Effective means after the parent
        chain (each parent resolved by its `<relativePath>`, default `../pom.xml`, and accepted only when its
        coordinates match the child's `<parent>`), `<pluginManagement>`, and the `-D` options of the snapshot's
        `.mvn/maven.config`, which as user properties override the POM's. A value that is not a literal after
        interpolation through literal properties of the same chain, a profile that sets the property or the plugin's
        `<release>`, a parent outside the snapshot, or a `-D` form the reading does not parse leaves the release
        unsettled. `source`/`target` without a release select nothing: the API is then that of the JDK running Maven,
        which the snapshot does not declare.
      - Gradle: the effective `options.release` of the `JavaCompile` task that owns the source set (`compileJava` for
        `src/main/java`, `compile<Name>Java` for another source set). Every script that may configure that task is
        read: the project's build file, the root's `allprojects` and `subprojects` blocks, scripts applied by `apply
        from`, and convention plugins in `buildSrc` or an included build of the snapshot. The release is settled only
        when every assignment that may reach the task (`options.release = N`, `options.release.set(N)`, inside
        `tasks.withType(JavaCompile)`, `tasks.named(...)` or the task's own block) is a literal and all of them agree;
        otherwise, or when one of those scripts is a binary plugin or is outside the snapshot, it is unsettled and the
        veto holds. Overrides are therefore never ordered: disagreeing assignments discard the evidence instead of
        guessing which runs last.
      - A literal `java.toolchain.languageVersion` serves as evidence only when, over that same set of scripts, no
        assignment to that task's `options.release` exists, no `sourceCompatibility` or `targetCompatibility` is
        declared for the project, no compiler argument or argument provider reaches the task (`options.compilerArgs`,
        `options.compilerArgumentProviders`, which can pass `--release` themselves), and no `javaCompiler` override
        reaches it (`JavaCompile.javaCompiler` can replace the toolchain's compiler), and the toolchain itself is settled
        by the same rule; any of those present keeps the veto, since its effect is not proven. That is sound because Gradle
        then compiles with the toolchain's own `javac` and no `--release`, so the API is the toolchain JDK's own class
        library, the table of that release. With a release declared the toolchain is never read, since toolchain 17
        with release 11 compiles against the 11 API (Gradle's cross-compilation section,
        https://docs.gradle.org/current/userguide/toolchains.html#sec:java_cross_compilation). A declared but unsettled
        release keeps the veto; the toolchain never replaces it.
      - A release the table does not hold selects nothing. Every unsettled selection leaves every library obligation of
        that source unsettled.
      - A build input outside the snapshot (a Maven command-line `-D` or `settings.xml` profile, a Gradle init script,
        a CI flag) is out of reach; a fact that used the table records the selected release and the build files that
        proved it in its `inputs`, so the evidence is visible (Risks).
    - **Receiver typing through library returns.** A receiver typed by a library return (`menuItems.stream().map(...)`)
      is typed by the table's return type after substitution of what the receiver's static type proves; only the raw
      class is needed where the parameter type at the function value's position is not a bare type variable. Where it
      is a type variable, decision 5's substitution rule applies, so `class Slots extends java.util.ArrayList<Port>`
      with the table settles `add(E)` to `Port` and the veto holds by proof (fixture 1 stays vetoed).
    - **Where it lives.** One stage of ADR-0045's Java pack, never a reader inside a family, split as ADR-0045
      decision 2 requires ("a per-file projection and a cross-file answer are two stages, never one"):
      - the table is pack data, shipped or generated at install (no derivation per snapshot);
      - a build file's local projection (its literal properties, plugin configuration, parent reference, assignments
        and toolchain, each as written) is a per-file fact keyed by that file's path and content;
      - the effective release of each source is a cross-file answer keyed by the path and content of every build file
        the resolution consulted (the owning manifest, each parent, `.mvn/maven.config`, each Gradle script and
        convention plugin), plus the snapshot's set of build-file paths (`pom.xml`, `.mvn/maven.config`, `*.gradle`,
        `*.gradle.kts`, `settings.gradle*`, `buildSrc/**`), the presence or absence of every path the resolution looked
        up, including an explicit `<relativePath>` that matches none of those patterns (`../parent-custom.xml`), which
        together are the evidence of every parent or script found absent, and the source's path, which decides its owning build;
      - the function-value target reading is a cross-file Java fact of B5, keyed by every Java source's path and
        content, the snapshot's path universe and those effective releases (ADR-0045 decision 2's B5 key, plus the
        releases' keys).
      Changing only a parent from release 17 to 21 therefore misses the resolution and the B5 fact (fixture 25).
    - **Third-party libraries** (Spring, Reactor) keep the veto. A host-declared class path enters, as ADR-0037
      decision 1 requires, only with its own measured evidence of third-party arguments blocking real cuts, as another
      ADR-0037 build-output kind and another Java-pack stage (follow-up F1).
    - **M0 runs first.** Its report sizes V1b: which releases and members the corpus selects, which fixtures to add,
      and whether V1a lands on its own. It does not reopen the choice of the source. V1b lands only with at least one
      measured release in the corpus (nname's quote-checkout-discount query is the expected one), since a reading that
      changes no answer is not taken (decision 5's precedent for V1a).
11. **The call-site flow becomes strict (V3).** After the V1 units and on the inspected M3 report, the call-site flow
    propagates only through a proven binding and a proven closure, with decision 8's frontier, and the staging form is
    deleted. Following an implementation the closure does not prove states a target the code may never reach; a
    diagnostic beside a stated target would still be a guess presented as a fact.
12. **The frontier names its cause (V3).** `CALL_SITE_CAUSES` (`call-site.ts:25`) gains `dispatch-not-proven`, and the
    MCP presentation (`mcp/presentation.ts:18`) gains its label. It is distinct from `dispatch-disagreement`, which
    names proven bodies that disagree on a value (`java-value-evaluator.ts:285`). It lands in V3 with the frontier, so
    no interim `unresolved` frontier ships. An added enum value, with no SCHEMA bump (owner rule).
13. **Generated Java sources are an ADR-0037 build-output kind (V4).** The closed union `DeclaredBuildOutput`
    (`core/domain/shared/build-outputs.ts:12-16`, and the recorded input kind at `fact.ts:102`) gains
    `{ kind: "java-sources", at, path }`: `path` is a host directory
    of Java sources, standing for the repository-relative directory `at` where the build writes them (for example
    `target/generated-sources/openapi/src/main/java`). `at` has no default, since no generator has a conventional
    directory. A user declares it with a repeatable `--java-sources <at>=<path>` beside `--node-modules` on the same
    commands (`cli/main.ts:423-427`), `ye-ast init` carries it into the MCP registration it prints, and a host through
    the protocol's `buildOutputs` (`protocol/params.ts:89`). ADR-0037 decisions 1 to 4 hold: never discovered, read as
    data through the confined reader (only `.java` files under the declared directory, links by decision 3), the same
    rules under `untrusted`. A declared file whose path the snapshot already holds is not read, and a `build-output` cut
    names it. Every fact that used a declared file states the declaration unverified (ADR-0037 decision 5: no lockfile
    analogue) and records its digest in `inputs` (ADR-0037 decision 6). On the line it is an input of B5, never B7: the
    files join the Java project as declarations, so the B5 key gains their digest, and B5's prebuild (ADR-0045 decision
    6) includes them only where one is declared for that repository. An added kind and an added flag, with no
    SCHEMA bump.
14. **A cut names the undeclared supertype (V4).** The closed set of cut details (`fact.ts:160`, its schema in
    `mcp/composition-schema-parts.ts:30`) gains `supertype outside the snapshot`. The strict reading's `unproven`
    receiver answer carries it when the name went `unsettled` under a supertype the snapshot does not declare, and
    trace's receiver cut (`trace-walk.ts:537`) states it. The evaluation found cuts without a reason hard to act on;
    this one tells the host which build output to declare.
15. **Kept as they are, with a stated trigger.** Three questions stay outside this ADR on purpose, each a follow-up of
    "Follow-ups" with its trigger: the frontier reason for a Java consumer (F2), the dynamic-implementation veto over
    test sources (F3) and the sources the Java parser rejects (F4).

### Place on the assembly line (ADR-0045)

ADR-0045 (Accepted) makes one owner, `BaseReading`, assemble every evidence stage per snapshot, with one language pack
per language and a language profile per language. This ADR's facts land on it as follows:

| This ADR | ADR-0045 place | Single owner |
|---|---|---|
| `receiverMethods`, `dispatchTargets` (decision 1) | Java-pack implementations of the B2b `ImportOrigins` contract, computed over the B5 `JavaProject` in the read's hold; plain outputs retained by B5's key | `java-receiver-methods.ts`, `java-dispatch-targets.ts`, wrapped by the Java pack (L1b); moved out of `adapters/spring/` only by ADR-0045 open question 7 |
| Candidates and closure apart (decision 1) | Inside the Java pack; the contract still answers `bodies` or `unknown` | The same two owners |
| Function-value vetoes (decision 5) and the JDK table (decision 10) | A B5 cross-file Java fact read by the closure; the table is pack data; the declared release a per-manifest fact | `java-dispatch-targets.ts` reads them; no family reads them |
| Framework narrowing (decision 4) | A Spring framework stage over the Java pack (ADR-0045 decision 12: a framework reads a pack's outputs, never implements a language stage): it reads the closed set and the injection point and answers the selected subset; the contract answer composes both | The Spring plugin owns the selection; the Java pack owns the closure |
| Call-site flow (E18) | B5's declared extension; listed frozen in L0's single-owner test until V3 (ADR-0045 decision 8) | From V3 it reads the two owners only and leaves the frozen list |
| Data effects (decision 1) | A B11 Spring stage that reads the owner's binding | `data-effects.adapter.ts` keeps only its data vocabulary |
| Generated Java sources (decision 13) | A declared input of B5; B7 stays absent for Java | The confined reader; the Java pack reads the files |
| Exact-signature overload link (decision 1, V0b) | A rule of the Java receiver owner, read by every B5 consumer | `java-receiver-methods.ts` |

- **The binding keeps the receiver classification (ADR-0045 decision 5).** For a Java member call the receiver
  classification L3 adds is the strict reading's answer: a `method` answer of `receiverMethods` is a nominal Java
  receiver with its proof link; `unproven` keeps the classification and states no execution evidence. Trace expands a
  target only on positive execution evidence, and for a Java call that evidence is the nominal receiver plus a proven
  closure of `dispatchTargets` (or a narrowed selection, decision 4). No later stage, a Java typed reading included,
  erases the classification; a typed derivation alone never makes trace run a body.
- **Vetoes and the closure read line stages only.** The veto inputs (aspects, dynamic-implementation APIs, function
  values, unparsed sources, the path universe) are read from B0 and B5; no family passes its own source list, which
  ADR-0045 decision 4 already forbids. Today's veto that reads every tracked source while trace hands test sources to no
  Java reader (Context, side facts) is unchanged by the line: B5 reads what the read's sources are.
- **The language profile.** Java's nominal typing, which trace reads at `trace-walk.ts:457`, moves to the Java profile in
  L1b; this ADR's rules read the profile, never `isJavaSource` inline, and add no line to ADR-0045's language-check list.
- **Retention and cost.** Each new reading enters as a stage row with its retention, its measurement stage line and its
  fixtures (ADR-0045 decision 8). V0a makes the call-site flow call the owner over the read's one `JavaProject`; before
  L1 that would add a per-call cost the line removes (`receiverMethods` was 1.2 s of the warm profile, ADR-0045 Context),
  so every V unit lands after L1 and its feature passes ADR-0045 M1 and M5 (Migration).

### Relation to ADR-0041

| ADR-0041 unit | Effect of this ADR |
|---|---|
| U0 to U2 (coverage, alignment, classes) | None |
| U3 (one binder) | None in the chain itself. Its "Java declared receiver" link is `receiverMethods`, whose adapter decision 1 makes the only Java binder, so the adapter's call sites and data effects bind as U3's chain does. Decision 6 gives that link more declarations to resolve (the generated supertypes); it adds no link |
| U4 to U6 (reverse access, pruning; L1 and L6 of ADR-0045) | None: reverse families read dependence, never this fact |
| Decision 5 (dispatch is trace's extension) | Kept. Trace reads this fact where it reads it today (`trace-walk.ts:306-319`), with the call's place added for decision 4 |

## Migration

Each unit is its own commit with its fixtures failing first and passes `npm run check`. Units are grouped into
features; one corpus gate (ADR-0039) runs at the end of each feature, before it reaches `main`, with the union of its
units' expectations, and its report attributes every moved answer to the unit that moved it. A unit that replaces a cut
with a step removes an element as well as adding one, so it declares `±` (ADR-0039 decision 6) and the report lists
every removed cut with the proof that replaced it. No V unit shares a feature with an ADR-0045 unit: ADR-0045's L0, L1,
L1b, L4, L5a and L5 are gated `none`, and L2 and L3 move answers of their own, so a shared gate could not attribute a
move. Measurements named `M0` to `M3` are this ADR's; ADR-0045's are cited as "ADR-0045 M1" and "ADR-0045 M5", and every
V feature passes them (warm totals within +15%, no query worse than max(+30%, +100 ms)).

| Unit | Change | After | Gate expectation (of its feature) |
|---|---|---|---|
| M0 | Measurement only, no code (below); runs on `main` now | — | None; sizes V1a and V1b (decision 10) |
| V0a | The owner answers candidates and closure apart (decision 1); `receiverOf` and `methodsOf` read the owner in its staging form, keeping today's lenient results | ADR-0045 L1 (one `JavaProject` per read hold, B5 retention), so the call-site flow adds no per-call cost | `none`; any difference is a disagreement between the readings, listed and explained before V3 |
| V0b | Data effects read the owner's binding; their exact-signature overload rule becomes an owner link (decision 1) | V0a | `trace:±` where the link binds a call the strict reader cut (a step replaces the cut); data effects `none` expected |
| V1a | Function values veto by decision 5 with repository signatures only; every library argument stays unsettled | V0a, M0 | `trace:±` where M0 found a release. Lands only if M0 shows at least one corpus release; otherwise its rule ships inside V1b, which needs it. Expected effect on nname: none (all 29 are library arguments) |
| V1b | The JDK signature table, the declared-release facts and receiver typing through library returns (decision 10) | V1a (or with it), M0, and decision 10's precondition (JDK pin and digest, reproducible generator, licence or install-time fallback) | `trace:±`; expected, not measured: the nname quote-checkout-discount query reaches the adapter. Lands only with a measured release (decision 10) |
| V2 | Call-local framework narrowing as a Spring stage over the Java pack (decision 4) | ADR-0045 L1b (packs and framework plugins), V1 units | `trace:±` where an injected receiver's qualifier or `@Primary` chooses among several proven bodies; `none` if the corpus has none (M2 says which) |
| V3 | The call-site flow reads only proven bindings and proven closures, with decision 8's frontier and decision 12's cause; the staging form is deleted; E18 leaves the frozen list of ADR-0045 L0's single-owner test | V0a, V0b, V1 units, V2, ADR-0045 L1b | `workspace:±`, `decisions:±`, `contract-consequences:±`, `trace:±` (effects); accepted only after the M3 report is inspected. Its own feature |
| V4 | Generated Java sources as a declared build output, and the cut detail of decision 14 (decisions 6, 13, 14) | ADR-0045 L1 (B5 owns the project and its key) | `trace:±` without a declaration (the petclinic owner route's cut gains `supertype outside the snapshot`); with a manifest query that declares the generated directory, the cut at `OwnerRestControllerV1.java:92` becomes steps |
| V5 | Contract consequences start a propagated link's carrier at its issuing call, located by the placed site's column through the request reader's predicate (decision 7) | ADR-0045 L2 (contract consequences read the line and B12's one program) | `contract-consequences:±`: frontiers move from root lines to issuing lines, and a carrier that started at another call of the same line and name moves to the request |

Features, in order: **A** V0a + V0b; **B** V1a + V1b (V1a alone first only if M0 finds repository-signature releases);
**C** V2; **D** V3, alone. V4 is feature **E** and V5 feature **F**, each independent of A to D and of each other.
V3 lands after the V1 units so the stricter flow does not inherit more of the repository-wide veto than it must, and
after L1b so the Java pack owns the readers it leaves for. ADR-0045 L0, which needs no V unit, lists this ADR's
single-owner rows below as frozen entries from the start.

### Fitness functions

Single-rule tests in the style of `src/core/adapters/syntax.single-rule.test.ts`: a pattern, its owners, and a pending
list of the copies a later unit removes, which only shrinks. They are rows of ADR-0045 L0's single-owner test (its
frozen E18 entry is the second row), written in L0, not in a unit of this ADR:

| Concept | Pattern | Owners | Pending, removed by |
|---|---|---|---|
| A Java member call's receiver type for selection | `export function receiverOf` under `adapters/spring` | `spring/java-receiver-methods.ts` | `spring/java-invocations.ts`, by V3 |
| A Java call's declarations and bodies | `function methodsOf` under `adapters/spring` | `spring/java-receiver-methods.ts`, `spring/java-dispatch-targets.ts` | `spring/java-method-flow.ts`, by V3 |
| What a TypeScript HTTP request is | an import of `VERBS` from `./http-call-sites.adapter.ts` | `typescript/http-call-sites.adapter.ts` (declares it) | `typescript/consumer-flow.walker.ts` and `typescript/request-origins.adapter.ts`, by V5 |

The pattern `VERBS\.has\(` is not used: it also matches `spring/request-mapping.ts:175`, `:236` and
`openapi/contract-document.adapter.ts:114`, which own other vocabularies (mapping annotations and OpenAPI path verbs)
under the same local name. Only the HTTP client vocabulary is imported, so its imports are the copies.

Measurements on the corpus manifest, each a gate of the unit it names. None sets a threshold:

| # | Measure | Unit |
|---|---|---|
| M0 | Per repository: every `dispatch not proven` cut that becomes bodies when only `functionValues` is disabled (the probe used above), and, for each function value that blocks it, its context: a repository signature, a JDK signature, another library, a nested result, unsettled | V1a, V1b |
| M1 | After V1a or V1b: cuts released and kept, and why; the time the reading adds to a read | V1a, V1b |
| M2 | Dispatch cuts with several proven bodies whose receiver is an injection point where a framework narrowing chooses one | V2 |
| M3 | Every call whose propagation crosses an unproven closure: links the workspace join loses or gains, sites whose URL or subject an argument bound through the blocked call, sites that move, and every completeness change (a `complete` target that becomes `unknown`) | V3 |

## Conformance fixtures

Through the adapter's port, once per consumer that wires it, each failing first in its unit. Fixtures 1 to 6 must stay
vetoed (`dispatch not proven`) in every unit, whatever source of signatures is declared:

1. **Inherited library generics.** `class Slots extends java.util.ArrayList<Port> {}`, then `slots.add(() -> "lambda")`,
   `slots.add(Use::body)`, `slots.add(c ? () -> "a" : () -> "b")`, a switch expression argument, and
   `slots.subList(0, 0).add(() -> "sub")`.
2. **Nested function values.** `interface Factory { Port create(); }` with `Factory factory = () -> () -> "lambda";` and
   a method `Factory make() { return () -> () -> "returned"; }`.
3. **The statement states the port.** `Port p = x -> null;` and `register(x -> null)` with a repository
   `void register(Port p)`.
4. **Inference through a sibling argument.** `Objects.requireNonNullElse(port, x -> null)` with a field `Port port`.
5. **`var` and type variables.** `var p = make(); use(p, x -> null)`; `<T> T id(T t)` with `Port y = id(x -> null)`;
   `class Svc extends Base<Port> { void f() { use(get(), x -> null); } }` with `T get()` in `Base<T>`.
6. **`this` below the port.** A function value in a default method of `interface Sub extends Port`.
7. **A repository signature excludes the port (V1a).** `interface Port { R q(Q x); }`, one class `Impl`, and elsewhere
   `void each(Handler h)` with a repository `interface Handler { void on(Item i); }` and `each(i -> log(i))`: dispatch
   of `Port.q` answers `Impl`'s body.
8. **A library argument without a signature source (V1a).** `items.stream().map(i -> i.id())`: still vetoed.
9. **A library argument with a declared signature source (V1b).** Fixture 8 with the JDK signatures declared for its
   release: `Impl`'s body. Without a declared release: still vetoed.
10. **Dependence unaffected (V1a to V3).** `callers` of `Impl.q` lists the caller of `Port.q` through the dispatch
    bridge, byte-identical with and without fixture 3's function value.
11. **Narrowing needs an injection point (V2).** Two classes implement `Port`, one `@Primary`, closure proven. A call
    through a constructor-injected `private final Port port` field: trace expands the primary and lists both as
    alternatives. `static String invoke(Port p) { return p.q(); }`: no narrowing, the cut lists both. With `@Profile` on
    either, or with fixture 3's function value: no narrowing.
12. **Trace and call sites agree (V3).** A port with `Impl` and a `@Bean Port port() { return x -> ...; }`: trace cuts
    the dispatch; the call-site flow does not propagate through the port; the blocked call carries an `unknown` site
    listing `Impl`'s body; `Impl`'s issuing call keeps its own site.
13. **A caller-bound argument survives as a frontier (V3).** The root passes the URL key as an argument to the port,
    whose adapter builds the request from it, and the closure is unknown: the root's site is `unknown` at the blocked
    call, never absent.
14. **Undeclared generated supertype (V4).** A controller implementing an interface the snapshot does not declare: the
    cut is unchanged. With a declared generated directory holding it: a step at the field type's method, then dispatch
    to its one implementation, and the fact states the declaration unverified.
15. **A generated member type shadows an import (V4).** The declared generated interface declares a nested
    `ClinicService`: the field type resolves to the nested type, never to the imported repository interface.
16. **The carrier starts at the issuing call (V5).** A listener calls a use case, which calls a port, whose adapter calls
    a library client and reads the response: a hypothesis on a response property locates its finding or frontier at
    the adapter's client call, with the listener's call in the chain.
17. **The carrier is located by column (V5).** `return this.cache.get(id) ?? this.http.get<U>(url);`: the carrier and
    the request origin start at `this.http.get`, never at `this.cache.get`. `httpResource.text(...)`: the walker and the
    origin reader treat it alike, as the request reader does.
18. **One binding for call sites and trace (V0a, V3).** At `OwnerRestControllerV1.java:92` without a declared generated
    supertype: in V0a the call-site flow keeps its lenient binding to `ClinicServiceImpl.findOwnerById`; from V3 it
    agrees with trace (unproven, a frontier), and with V4's declaration both bind and dispatch alike.
19. **Overloads (V0b, V3).** `find(String)` and `find(Long)` on a port, called with an argument whose static type is
    `String`: the owner binds `find(String)` by the exact-signature link, for trace, data effects and call sites alike.
    Called with an argument whose type the reading does not settle: a cut in trace, and from V3 no propagation through
    both overloads.
20. **The declared release selects the table (V1b).** Fixture 9 with `maven.compiler.release` 17: `Impl`'s body. With
    only `maven.compiler.source`/`target`, with a `<release>` inherited from a parent outside the snapshot, with a
    profile that sets the release, or with a release the table does not hold: still vetoed.
21. **The frontier names its cause (V3).** Fixture 12's blocked call carries the cause `dispatch-not-proven`, never
    `dispatch-disagreement`.
22. **A declared file never replaces a snapshot file (V4).** A declared generated directory holding a path the snapshot
    already holds: the snapshot's file is read, and a `build-output` cut names the declared one.
23. **The cut names the undeclared supertype (V4).** Fixture 14 without a declaration: the cut carries the detail
    `supertype outside the snapshot`.
24. **No erased classification (ADR-0045 L3, V0a).** Fixture 18 after L3: the binding carries the strict reading's
    `unproven` receiver classification, and trace states no step whatever another proof derives the target from.
25. **Only the parent changes (V1b, complete key).** A child module inherits release 17 from an in-snapshot parent, and calls
    `opts.getFirst().map(i -> i.id())` on a `List<Optional<Item>> opts`, where `getFirst` exists from release 21
    (`List.getFirst()` fails to compile with `--release 17` and compiles with `--release 21` on the same `javac`):
    unsettled, vetoed.
    Changing only the parent's release to 21 misses the resolution and the B5 fact and answers the release-21 reading;
    the child's file is unchanged.
26. **Gradle release over toolchain (V1b).** `java.toolchain.languageVersion = 21` and `compileJava.options.release = 17`:
    the release-17 table is read (fixture 25's `getFirst()` stays unsettled). With `options.release` computed
    (`options.release = providers.gradleProperty("rel").get().toInteger()`) and a literal toolchain 21: unsettled, the
    toolchain is not read. Two `options.release` literals that disagree (the root's `subprojects` and the project's
    own block): unsettled. Only a literal toolchain 21, no release and no compatibility declared: the release-21
    table; the same with `options.compilerArgs.addAll(["--release", "17"])` or a `javaCompiler` override on the task:
    unsettled. A Maven parent named by `<relativePath>../parent-custom.xml</relativePath>` and absent, then added:
    the resolution misses and re-reads.
27. **Varargs needs `ACC_VARARGS` (V1b).** `Collector.of(() -> new ArrayList<Port>(), (a, t) -> a.add(t), (x, y) -> x)`
    selects `of(Supplier, BiConsumer, BinaryOperator, Characteristics...)` at arity 3 only by variable arity: settled
    with the flag; with a table entry that lacks it, the invocation stays unsettled.
28. **A type-name call needs `ACC_STATIC` (V1b).** `Comparator.comparing(i -> i.id())`, a static interface method
    selected through the type name: settled with the flag, unsettled without it.
29. **A nested function value needs `ACC_ABSTRACT` (V1b).** `Supplier<Function<Item, String>> s = () -> i -> i.id();`:
    the inner lambda's target is `Function`, from `Supplier.get` and `Function.apply` being the only abstract methods
    (`andThen`, `compose` default, `identity` static): settled, the port excluded. With the flags missing for either
    type: unsettled.

## Consequences

- With declared generated sources, trace follows a controller whose supertype a generator wrote; without them the cut
  says which supertype is missing.
- A one-method port is followed only where every function value of the snapshot is proven not to implement it. With the
  JDK table that includes function values passed to `java.*` members of a declared release; nname's port is expected to
  be followed after V1b, and a third-party library argument keeps the cut.
- `workspace`, `decisions` and contract consequences no longer state a call-site target through implementations trace
  cannot prove closed; a request behind an unproven port is reported where it is issued, and the blocked call carries an
  explicit `unknown` site with the cause `dispatch-not-proven`.
- `callers` and `impact` do not change: their bridges are dependence.
- Public additions, none a break and none a SCHEMA bump: the build-output kind `java-sources` with its
  `--java-sources <at>=<path>` flag and protocol value, the call-site cause `dispatch-not-proven` and the cut detail
  `supertype outside the snapshot`. ye-ast gains the JDK table's extractor and its pinned JDK digest, run at build time
  or, under decision 10's fallback, at install time.
- Every unit is a stage row of ADR-0045's Java pack or a Spring stage over it, so no family is wired to receive it.

## Risks

- **A closure assumption that is wrong is a false step, worse than a cut.** The first version of decision 5 was unsound
  in exactly this way. The rule now releases only by proof over every target obligation, recursively, and any unsettled
  obligation keeps the veto; fixtures 1 to 6 pin the known counterexamples. An independent reviewer compiles
  counterexamples for V1a and V1b, since no existing test would catch a missed obligation (high-risk item 6).
- **A build input outside the snapshot changes the release.** A command-line `-D`, a `settings.xml` profile, a Gradle
  init script or a CI flag can pass another `--release` than the snapshot declares. Out of reach by construction; the
  selected release and the build files that proved it are recorded in the fact's `inputs`, so a host can see the basis.
- **Redistribution of the table.** Unresolved until V1b's precondition; the install-time fallback keeps V1b possible
  without shipping JDK-derived data.
- **A wrong table is a wrong proof.** A table entry that differs from the API the build compiled against would settle an
  obligation falsely. Mitigated by `ct.sym` (the exact API `--release` compiles against), by selecting only a declared
  release, and by treating a JDK pin upgrade as a gated parser upgrade.
- **V1a may change nothing.** M0 decides whether it lands alone; complexity without an answer change is not taken.
- **The stricter call-site flow loses propagation (V3).** Where a veto still holds, a root's decided target becomes an
  `unknown` site at the blocked call, and an argument the root bound is lost. M3 lists every such site, link and
  completeness change; V3 lands after the V1 units and only on the inspected report.
- **Generated sources go stale.** They are stated unverified in every fact that used them; nothing claims they match
  the generator's input.
- **Framework semantics.** Narrowing applies only at proven injection points; profiles and conditions refuse it
  (fixture 11); a framework variant the owner does not read keeps the cut.
- **The exact-signature link widens trace (V0b).** It must hold only where the arguments' static types are settled
  exactly; an argument the reading does not settle keeps the cut (fixture 19).
- **Order against the line.** Every V unit waits on ADR-0045 L1 (V2 and V3 on L1b, V5 on L2); a slip of the line delays
  this ADR. M0 runs now and does not wait.

## Follow-ups

Each is outside this ADR on purpose and reopens only on its trigger:

- **F1. A host-declared Java class path.** Third-party library signatures (the build's jars) as an ADR-0037 build-output
  kind and a class-file reader as another Java-pack stage. Trigger: a measured corpus case where a third-party library
  argument blocks a cut that M0's method would otherwise release (ADR-0037 decision 1, ADR-0013 decision 4).
- **F2. The frontier reason for a Java consumer.** `source-unreadable` describes a source ye-ast could not read, not a
  language it does not read yet. Decided in RFC-0022/0023, where Java consumers are stated out of P4. Trigger: the
  revision of RFC-0022/0023 that takes Java consumers, or V5's gate report showing Java carriers at issuing calls,
  whichever comes first; V5 does not wait for it.
- **F3. The dynamic-implementation veto and test sources.** No change now, since trace's read does not hand test
  sources to the Java readers. Trigger: a read that does. The veto is then scoped by source set through the Java
  profile's file rules (ADR-0045 decision 12: the test rule `isJvmTestFile` of `core/domain/languages/java.ts`), not
  through `call-targets.ts`, whose runtime rule (`call-targets.ts:7-10`) tells Java from TypeScript and cannot tell a
  test source from a main one.
- **F4. Sources the Java parser rejects (flexible constructor bodies).** A grammar upgrade under ADR-0007 and ADR-0013
  decision 3, its own change; this ADR keeps "a source that does not parse vetoes every Java proof". Trigger: already
  met (two `ms-name-notifications` sources), so it is ready to schedule independently of every V unit.
