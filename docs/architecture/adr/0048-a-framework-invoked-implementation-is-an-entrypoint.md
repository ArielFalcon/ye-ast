# ADR-0048: A framework-invoked implementation is an entrypoint

- Status: Accepted, 2026-11-09, owner
- Decision source: Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (settle every open question as recommended), after "aplica el orden que recomiendas" and "los ADR recogen decisiones mas acotadas referentes a un RFC".
- Related: [RFC-0026](../rfc/0026-framework-invoked-entrypoints.md) designs this decision; ADR-0041, ADR-0042, ADR-0044, ADR-0045

**In short:** Code a framework calls through a library contract (security user lookup, validators, data fetchers) becomes an entrypoint of kind `callback`, declared as plugin data and proven by the Java supertype closure.

## Context

Bug-localization items ended in methods only the framework calls, and `entrypoints` answered `complete` with none: the entrypoint union has no kind for them and the Java reader discards the library supertype it already resolves. RFC-0026 holds the evidence and units.

## Decision

1. A framework-invoked implementation is an entrypoint of kind `callback`, named by the contract's fully qualified name and member.
2. The framework plugin declares the invoked contracts as data (supertypes and annotations); the Java pack's supertype closure is the only source of implementations.
3. Implementations sharing one body yield one finding per body.
4. What cannot be proven is an `unknown` item, never a silent absence; registration through a `@Bean` factory stays `unknown (no-extractor)`.
5. The reader runs inside the Spring routes adapter; it is not an assembly-line stage, and it is not ADR-0044 V2, which narrows what a call runs. It lands after RFC-0025 U4.

## Consequences

- The delivery units, their order and their tests are in RFC-0026, and each unit names the units of other RFCs it waits for.

## Not decided here

- Moving the entrypoint map onto the assembly line (ADR-0045 B11).
