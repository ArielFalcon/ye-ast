# ADR-0075: The core names no language or framework, and a framework enters only as a plugin

- Status: Proposed, 2026-11-13, tech lead; waits for the owner
- Decision source: Owner, 2026-11-13: "estas propuestas de correccion y mejoras deben ser de forma transversal y no
  parches puntuales. Genera los RFC y ADR correspondientes" (the corrections and improvements must be cross-cutting,
  not point patches; write their RFCs and ADRs). The owner has not yet accepted the decisions below.
- Related: RFC-0035 (design), RFC-0007, ADR-0013, ADR-0045 decision 12

**In short:** language and framework identities are values a pack or a plugin registers, never a closed union or a
file name in the core. Every framework reader is a stage of a `FrameworkPlugin` registered in one place. Each adapter
folder holds one technology, and the one frozen exception between adapters is deleted. The change is a refactor: no
answer moves.

## Context

RFC-0007 designs three plugin kinds. As built, one framework is a plugin and the other is wired by hand
(`src/composition/compose.ts:168,177,183,349`); three ports, one use case, one impact dependency and two domain files
are named after a framework; four closed unions name the two languages; `adapters/spring/` holds a language and a
framework; and vocabularies of libraries are tables in adapter code. Adding a framework touches four layers.

| Option | Verdict |
|---|---|
| Leave it until a third framework arrives | Rejected for the hand-wiring and the unions: every cross-repository fix already threads through them. Accepted for the rest (decision 7) |
| Rewrite the framework readers behind new contracts | Rejected: the readers are correct; only their wiring and names are wrong |
| Move and rename behind the existing contracts, extending them where a stage is missing | Chosen |

## Decision

1. No file under `core/domain`, `core/application` or `core/ports` is named after a language or a framework or holds
   one's name as a literal. A fitness test holds it, with a frozen exemption list that only shrinks until decision 4
   lands.
2. Language and framework identities are registered values. The four closed unions are replaced; outputs keep their
   bytes.
3. Every framework reader is a stage of a `FrameworkPlugin`. The composition root builds no framework adapter
   directly; an architecture rule holds it.
4. `FrameworkPlugin` gains the optional stages `effects` and `relations`. A plugin declares the relation kinds it
   emits and the synthesized edges it owns.
5. One adapter folder per technology: the Java language leaves `adapters/spring/`, and the framework files leave
   `adapters/typescript/`. A framework adapter receives its language's readers by injection.
6. The rule `spring-reads-only-the-java-parser` is deleted when decision 5 lands.
7. Decisions 1 to 3 land now. Decisions 4 to 6 and vocabularies as plugin data land when a second framework for either
   language is scheduled.
8. Every step passes the corpus gate expecting no difference.

## Consequences

- A new framework costs an adapter folder, fixtures and one registration line.
- A large, mechanical diff with no behavior; it must not travel with any other change.
- The contract's new stages are shaped by a real second framework, not by a guess.

## Not decided here

- Which framework comes next (ADR-0013).
- A language profile for `.tsx`, `.jsx` and `.js`: new coverage, under ADR-0013.
