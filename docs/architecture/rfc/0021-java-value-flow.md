# RFC-0021: Java value-flow summaries

- Status: Draft, 2026-11-05
- Related: RFC-0007, RFC-0011 E5/E6, ADR-0013, [RFC-0028](0028-value-flow-through-wrappers.md) (the language-agnostic summary contract this design extends)

**In short:** Replace the HTTP and event readers’ single-hop wrappers with one adapter-local method summary analysis. Preserve argument scopes, object records and consuming-module configuration while following source-declared implementations.

## Contract

| Spec | Rule |
|---|---|
| S1 | Method summaries carry reachable standard-client leaves, computed to a finite set fixpoint. Argument substitution follows call edges with method cycle detection, without a depth cap. |
| S2 | Dispatch follows source hierarchy; concrete receivers, qualifiers, primary and a sole implementation select candidates. Disagreement remains unresolved. |
| S3 | Abstract object records retain field closures. Source constructors, record components and proven Lombok builders supply mappings; getters and source returns read them. |
| S4 | Map access extends configuration keys only when the source property is Map-typed and the key is evaluated. Configuration stays in the consuming module. Absent and undecided remain explicit lookup states. |
| S5 | OkHttp is a standard leaf only for its declared public API. No application vocabulary is introduced. |
| S6 | Cycles, missing source and conflicting implementations remain explicit unresolved findings; output is sorted and reproducible. |
| S7 | Real stdio workspace impact measures resolution, noise, runtime and peak memory against the baseline. |

## Ownership and evidence

All implementation belongs to `core/adapters/spring`: it interprets Java syntax and framework configuration. The existing call-site and finding contracts remain the public seam. HTTP and event readers share summary propagation rather than maintaining two wrapper engines. An evaluation comes to the topology domain's `Evaluated<T>` (`core/domain/topology/evaluated.ts`): a value, or an undecided one with its cause, places and alternatives. One mapping there turns an undecided value into a call site's unknown target and diagnostic, and one rule picks the prevailing cause of several readings, for every reader. An undecided client base keeps the request the code writes, with the base's own cause. A selected leaf retains source evidence and its caller evidence. Existing typed `unresolved` findings express undecidable targets; a new public cause would require a separate schema change.

The present evaluator only interprets strings (`url-text.ts`); readers independently register direct-client methods as wrappers (`http-call-sites.adapter.ts`, `event-call-sites.adapter.ts`). `classChain` excludes interfaces although `hierarchy` includes them. Configuration already returns found/absent/undecided and loads only consuming-repository resources.

## Termination and conservatism

Reachability grows monotonically over the finite set of methods and leaves. Substitution tracks active source methods; a recursive edge cannot manufacture a concrete value. Overload ambiguity is not settled by declaration order. Object mappings require source proof. Runtime values remain unknown. Binary-only libraries retain their precise declared type as the cut.

## Validation

Use adapter-port fixtures for each rule, observed failing before implementation, with type-correct mutations as break proof. Run the complete check gate. Read the real corpus without modifying it; keep evaluation artifacts outside the engine and corpus.

## Implementation evidence

The TypeScript request-summary reader also preserves wrapper paths, parameter substitutions and body hops at the first
caller supplying a path hole. Its fixtures cover candidate agreement, disagreement, unread bodies and conditional paths.

Source fixtures cover forwarding chains, implementation disagreement, named bean selection, records from builders and constructors, setters, Map keys across a library boundary, explicit configuration default states, source event subjects and inherited NATS template methods. The standard HTTP leaf follows `OkHttpClient.newCall(Request)` and `Request.Builder.url/method`, including the documented GET default and standard verb setters ([Request source](https://github.com/square/okhttp/blob/parent-3.14.9/okhttp/src/main/java/okhttp3/Request.java), [client source](https://github.com/square/okhttp/blob/parent-3.14.9/okhttp/src/main/java/okhttp3/OkHttpClient.java)).

A measured source URL helper also needs a proven null fallback, a single array element and `HttpUrl.parse(...).newBuilder()`. A runtime override remains unresolved. Named `@Bean` factory returns supply qualifier selection without assuming bean names from implementation names.

Remaining scope: a binary-only facade still yields a library cut without a separately stated subject; helper-based subscriptions are not yet propagated by the shared method-summary reader. Neither absence is a claim of no event impact. These acceptance gaps keep the feature partial.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Is an adapter-local abstract record justified? | Yes: string coercion loses field identity, and both HTTP and event consumers need records. Keep the type in Spring until a second technology needs it. |
| 2 | Should new public ambiguity causes be introduced? | Reuse typed unresolved for this slice; do not change MCP summaries. Add a public taxonomy only with a separately reviewed schema commit. |
| 3 | How should binary-only messaging facades be modeled? | Preserve the library cut and evaluate source values where a supported source leaf consumes them. Do not infer subscription semantics from a method name. |

## Audit corrections

Mutable object mappings require a local reference whose uses before the read are proven simple accessors. Passing to a source helper is allowed only when every parameter use is a proven field getter; aliases, captures, storage and undecidable calls invalidate the mapping. Shared mutable records and scalar fields written outside constructors cannot establish a complete value. Records, final-field values and Lombok Value supply immutability evidence.

Summary expansion retains alternatives per output position instead of enumerating combinations of unrelated calls. The work stack is iterative; binding contexts are memoized and shared alternative entries deduplicated. Each output is resolved only when its dispatch alternatives agree. Framework implementations and named Bean constructors are indexed once per project. Value-expression stack exhaustion becomes an undecidable value, preserving the existing unresolved contract.

The audit correction is partial: nested dispatch that transforms arguments differently still creates exponentially many distinct binding contexts (64/256/1,024 at 6/8/10 levels). Independent-edge grouping and identical-context memoization do not establish global polynomial complexity. The owner accepted this as a known limit on 2026-11-06: it needs many levels of nested dispatch, each with several source implementations that transform the argument differently, which no measured repository shows (16 levels: about 2.7 s). Joining contexts would turn exact answers in ordinary code into unknowns. The exact remedy is symbolic method summaries: each method summarized once as a template over its parameters and alternatives compared by template, which needs the value evaluator to work over unknown parameters, records and configuration keys. It is deferred until a real repository needs it.
