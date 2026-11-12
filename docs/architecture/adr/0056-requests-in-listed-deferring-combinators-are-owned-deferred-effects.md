# ADR-0056: Requests in listed deferring combinators are owned deferred effects

- Status: Accepted, 2026-11-12, owner
- Decision source: Owner, 2026-11-12: "Corrígelo todo de forma planificada y con calidad, que se integre bien a las reglas del proyecto y que resuelvan los problemas detectados para mejorar la calidad multi repo", authorizing mechanism M4 of the diagnosis, owned deferred effects through a plugin catalog of combinators.
- Supersedes: ADR-0053 decisions 3 and 5 in part, and the RFC-0013 R12 sentence that a site inside a function value is a cut, never its effect, in part.
- Related: ADR-0013, ADR-0053, ADR-0055, RFC-0007, RFC-0013

## Context

A request written inside a function value that a library combinator takes (`defer(() => this.rest.post(...))`,
`of(x).pipe(switchMap(() => ...))`) was an `effect-unplaced` cut of the declaration around it, and so was the wrapper
leaf it reaches. The trace therefore answered `partial` with no effect, and no workspace link for the request, although
the declaration is the only place that can make it.

## Decision

1. Decision 3 of ADR-0053 is amended: a function value written inline as an argument that a registered framework
   deferral vocabulary lists for an export the file imports from a package is owned by its enclosing declaration. A
   request inside it is an effect of that declaration, marked `deferred`: it runs later, if at all. Every other stored,
   passed, asynchronous or library-controlled callback keeps its cut, as does a function value around a listed one that
   no vocabulary lists.
2. The vocabulary is plugin data, closed and evidence-backed (ADR-0013): the RxJS plugin lists `defer`, `switchMap`,
   `mergeMap`, `concatMap` and `exhaustMap` from `rxjs` and `rxjs/operators`, argument 0. The TypeScript reader accepts
   an export only by the package-export rules of ADR-0055: an import of a package the manifest declares, not type-only,
   not shadowed, not rebound. Removing the plugin restores the cut.
3. Decision 5 of ADR-0053 is amended: workspace-backed trace returns matches at exactly placed executed effects and at
   exactly placed owned deferred effects, the latter marked `deferred: true`. A match reached both ways is unmarked.
   A step that is itself deferred contributes nothing.
4. `TraceEffect` (HTTP and message), `UnresolvedCallSite`, trace links and trace unlinked call sites carry
   `deferred?: true`. The mark means "runs later, if at all", never "subscribed". No schema version changes.

## Consequences

- A request in a listed combinator is a complete effect with its target and a workspace link instead of two cuts.
- A client that needs only executed effects filters on the mark.
- `Promise.then`, `Observable.subscribe` callbacks and other combinators stay cuts until a vocabulary lists them with
  evidence.
