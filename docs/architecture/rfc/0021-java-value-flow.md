# RFC-0021: Java value-flow summaries

- Status: Draft, 2026-11-05
- Related: RFC-0007, RFC-0011 E5/E6, ADR-0013

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

All implementation belongs to `core/adapters/spring`: it interprets Java syntax and framework configuration. The existing call-site and finding contracts remain the public seam. HTTP and event readers share summary propagation rather than maintaining two wrapper engines. A selected leaf retains source evidence and its caller evidence. Existing typed `unresolved` findings express undecidable targets; a new public cause would require a separate schema change.

The present evaluator only interprets strings (`url-text.ts`); readers independently register direct-client methods as wrappers (`http-call-sites.adapter.ts`, `event-call-sites.adapter.ts`). `classChain` excludes interfaces although `hierarchy` includes them. Configuration already returns found/absent/undecided and loads only consuming-repository resources.

## Termination and conservatism

Reachability grows monotonically over the finite set of methods and leaves. Substitution tracks active source methods; a recursive edge cannot manufacture a concrete value. Overload ambiguity is not settled by declaration order. Object mappings require source proof. Runtime values remain unknown. Binary-only libraries retain their precise declared type as the cut.

## Validation

Use adapter-port fixtures for each rule, observed failing before implementation, with type-correct mutations as break proof. Run the complete check gate. Read the real corpus without modifying it; keep evaluation artifacts outside the engine and corpus.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Is an adapter-local abstract record justified? | Yes: string coercion loses field identity, and both HTTP and event consumers need records. Keep the type in Spring until a second technology needs it. |
| 2 | Should new public ambiguity causes be introduced? | Reuse typed unresolved for this slice; do not change MCP summaries. Add a public taxonomy only with a separately reviewed schema commit. |
| 3 | How should binary-only messaging facades be modeled? | Preserve the library cut and evaluate source values where a supported source leaf consumes them. Do not infer subscription semantics from a method name. |
