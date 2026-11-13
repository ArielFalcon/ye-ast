# ADR-0081: A syntax error confined to a body leaves its source's declarations read

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [ADR-0080](0080-the-type-hierarchy-is-completed-once-for-every-family.md),
  [ADR-0007](0007-dependency-versions.md), [RFC-0002](../rfc/0002-facts-contract.md)

**In short:** a Java source whose syntax tree holds an error was read as wholly unread, on the argument that it may
declare any type, and every proof that needs all sources read answered `unknown` for the whole repository. The reader
now states a third thing where the tree proves it: the declarations of the source are read and some of its bodies are
not. A proof about what a written name denotes holds with unread bodies; a proof that nothing else exists does not; the
cut for the unread body stays.

## Context

A repository of the corpus holds two sources whose constructors write statements before `super(...)`, legal since Java
22. The installed grammar is the latest published one and accepts an explicit constructor invocation only as the first
statement of a constructor body, so a dependency update cannot read them (ADR-0007 keeps the pin). With those two
sources unparsed, every supertype answer of the Java pack in that repository was `unknown`, and each class under a
library supertype carried a `relation-unread` cut (ADR-0080 decision 4).

One statement the grammar rejects, inside one constructor, says nothing about which types the repository declares.

## Decision

1. **The reader states three things.** A source is read; or it is unread; or its declarations are read and some of its
   bodies are not. The third holds only by proof from the tree: every error and every missing node lies inside a member
   body (a method body, a constructor body, an initializer block, a block inside an initializer), and inside the
   outermost such body the brace that closes its first brace is the body's last token. Under the repository-compiles
   assumption of ADR-0062 matched braces delimit the body as the compiler reads it, so the body declares only types
   local to it. An error in a member header, between members, directly in a field declaration, or a body whose braces
   do not match, leaves the source unread as before. No heuristic and no threshold decide the state.
2. **A proof asks for what it needs.**
   - What a written name denotes outside a body needs every declaration read. `declaredSupertypes` is such a proof and
     answers over the declarations of the sources in the third state.
   - That nothing else exists (no other type below overrides or implements, the dispatch targets, the one
     implementation closure, the absence of a dynamic implementation or a call-rewriting annotation) needs every body
     read: an unread body may hold an anonymous class or a proxy. These proofs stay off exactly as before.
   - `receiverMethods`, `implementedDeclarations`, `implicitChains`, `rootOrigins` and `declaredTypes` stay on the
     stricter reading: their gate also scans every body, and nothing proves that scan redundant for them.
3. **The cut for the unread body stays.** A body nobody read may call anything: the source keeps its
   `source-unreadable` place at the same line, with the same reach, in every answer that carried it. No new cut reason.
4. **The third state lives inside the Java adapters.** The parser adapter is the one owner of the decision; no port,
   domain or application type changes.

## Alternatives considered

- **Update the grammar.** Dropped: the pinned version is the latest published and has the gap.
- **Read every source with an error by its recovered tree.** Dropped: error recovery can swallow the next member into a
  body or close a body early; only the brace match over the body's own tokens tells a confined error from those.
- **Turn every name proof on over unread bodies.** Dropped for now: the receiver and dispatch proofs share a gate that
  scans bodies for dynamic implementations, and separating them is a unit of its own with its own evidence.

## Consequences

- A source that does not compile for another reason, whose braces still balance (a brace missing in one place and
  extra in another), is read as confined, and a member the misplaced brace swallows is read as part of a body. That is
  outside the repository-compiles assumption; a live reading of a work in progress is where it can happen.
- The trees of the sources in the third state stay alive for the reading, and a second project over the declarations
  is built only when such a source exists.
- The remaining proofs of decision 2 are the next lever in a repository with such a source: each can move to the
  declarations reading only with a proof that its body scan is not needed for it.
