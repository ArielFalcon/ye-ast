# ADR-0059: A field written once in the constructor from a readable value is a decided callee

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "Aplica lo que recomiendas en el item 3"
- Related: ADR-0049, ADR-0051, ADR-0055

## Context

ADR-0055 decision 3 keeps "a function-typed field the code reassigns" as an undecided dispatch. The call reader took any
write through `this` for a reassignment, including the single assignment a constructor makes. On a real Angular service
a field `handlerError` is assigned once, in the constructor, from `factory.createHandleError('Service')`, a factory the
repository declares and that returns an arrow, and each request is piped through `this.handlerError('op')`. Every such
call was a `dispatch-disagreement`: a false unresolved call site next to the exact link of the same request, and a
component call that lost its caller-side link. ADR-0051 requires uncertainty to be real, and ADR-0055 that it reaches a
call site only where it can reach a request.

## Decision

1. A single constructor write is not a reassignment. A field resolves to what its one written value calls when the class
   hierarchy of the receiver holds exactly one write of the field, that write is an `=` statement at the top level of a
   constructor body that no earlier `return` can skip, the field has no initializer and is not a constructor parameter
   property in any class of the hierarchy, and no subclass the snapshot sees declares, takes or writes it.
2. The callee is the arrow or function expression the value is (ADR-0049: every written callable is a declaration), or,
   when the value is a call, the one arrow or function expression that the call's readable callee returns by its single
   return. A factory call through a never-rewritten local alias of a field of `this` is read through that field.
3. Unchanged gaps: two or more writes, a write in a method, a branch, a loop or a nested function, a write after a
   possible early return, a write the class does not name, an override or a re-declaration in a subclass, an opaque or
   external factory, a factory that returns anything but one function, and a cycle through the factory call.

## Consequences

- The twin unresolved call site next to a complete one and the lost caller-side link disappear for the shape; every
  other write pattern stays a gap.
- The written-field index records the writing nodes, not only the names; no schema or contract changes.
- A local alias of a field of `this` is read only for a constructor factory call; reading it for every receiver stays a
  separate decision.
