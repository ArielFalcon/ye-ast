# ADR-0053: Multi-repository relations retain their proof context

- Status: Accepted, 2026-11-12, owner
- Decision source: Owner, 2026-11-12: "continua con la implementacion de todo lo pendiente y lo que entiendas necesario para lograr esta mejora en la capacidad multi-repo como defines".
- Related: ADR-0041, ADR-0042, ADR-0045, ADR-0050, RFC-0011, RFC-0013

## Context

Preserving a partial URL does not establish which producer receives it. Provider scope, build configuration, execution
ownership and route competition are independent proof obligations. Discarding one can either hide useful relationships
or publish a producer that another supported runtime value would change.

## Decision

1. Source-backed provider values extend the existing request evaluator and summary owner. A complete-source signal is
   supplied by application from the export and read selection; missing or stopped inputs authorize no provider proof.
   Contributions come from the single registered framework collection through AST-neutral source-expression bindings
   over the same held reading. Removing a framework removes its contribution; competing bindings keep the value unknown.
2. The supported Angular contribution reads one authenticated bootstrap at its declared build entrypoint and stable
   registered `useValue` providers. Token identity follows existing module/declaration resolution. Conflicting or opaque
   injector scopes, mutable values, multiple unassociated roots and relevant file replacements remain unknown. No build
   configuration is selected implicitly. Angular and Nx build interpretation has one shared adapter owner.
3. Execution proof stays separate from request extraction. Direct synchronous non-generator IIFEs run in their enclosing
   body. Stored, passed, asynchronous and library-controlled callbacks retain their existing deferred boundaries.
4. A compatible runtime route that can change the selected handler or producer prevents a definitive match. Existing
   route specificity and method rules still exclude competitors proven unable to win.
5. Workspace-backed trace returns only topology matches at exactly placed, executed HTTP/message effects, with both
   endpoint snapshots. The workspace matcher remains the sole owner of association; basis, confidence and profile
   conditions are preserved. Path equality does not establish ownership of an HTTP authority. Producer handlers supply
   pinned targets for a subsequent trace; an HTTP boundary does not silently expand the producer's entire graph.

## Consequences

- Clients can follow a source-backed consumer-to-producer relationship without rebuilding workspace matching.
- A partial workspace read remains explicit through a section cut in trace.
- Dynamic provider factories, general NgModule/bootstrap composition, runtime deployment discovery, arbitrary callbacks
  and RxJS subscription execution require additional evidence; these remain explicit coverage limits.
- No repository-specific URL, parser, service or global cache is introduced.
