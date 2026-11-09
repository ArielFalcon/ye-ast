# ADR-0046: A call binds by its receiver's type, never by the callee's name

- Status: Accepted, 2026-11-09, owner
- Decision source: Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (settle every open question as recommended), after "aplica el orden que recomiendas" and "los ADR recogen decisiones mas acotadas referentes a un RFC".
- Related: [RFC-0024](../rfc/0024-receiver-typed-settlement.md) designs this decision; ADR-0041, ADR-0042, ADR-0044, ADR-0045

**In short:** A member call binds to what its receiver's type declares at the call, so overloads, interfaces and the dispatch bridge stop attributing every homonym; trace keeps no receiver rule of its own.

## Context

The agent-usefulness study traced 14-15 binder items in both languages to calls settled by name: `memberOf` refuses an overload set and every interface (`call-binder.ts`), the contract bridge pairs an implementation with its contract by name (`inbound-edges.ts`), and trace keeps a second Java rule. RFC-0024 holds the evidence, reproductions and units.

## Decision

1. A member call binds to the declaration its receiver's type offers at the call's signature, and the declarations that type offers are its candidates, never the repository's homonyms.
2. A TypeScript overload set binds to its one implementation; a nominal language's selection belongs to its owner (`receiverMethods`, with ADR-0044 V0b's exact-signature link).
3. The dispatch bridge between an implementation and its contract matches by signature; a language that cannot state signatures keeps the name-only bridge at the existing heuristic confidence.
4. Trace reads only the base binding; no family keeps a second receiver rule.
5. RFC-0024 owns `CallBinder.memberOf` and `declares`; its units U1-U4 land before RFC-0027 U1, which extends that contract.

## Consequences

- The delivery units, their order and their tests are in RFC-0024, and each unit names the units of other RFCs it waits for.

## Not decided here

- Without a declared build output, TypeScript does not select an overload signature by argument kinds; ADR-0041 open question 7 stays open, with its volume reduced by U3 and U4.
