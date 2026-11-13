# ADR-0072: One owner classifies every file of a snapshot, and a veto is released only by reading declarations

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados" (I approve
  every pending recommendation; leave them closed), after "estas propuestas de correccion y mejoras deben ser de forma
  transversal y no parches puntuales" (the corrections and improvements must be cross-cutting, not point patches).
- Related: RFC-0032 (design), ADR-0013, ADR-0044 decision 5, ADR-0045 decision 12, ADR-0062

**In short:** the class of a path (source, declared source, uncovered source, build configuration, test, other) has one
owner in the domain, and no adapter keeps its own pattern. A build script is build configuration in any language. A
repository-wide veto caused by a sibling language is narrowed only by a reader of that language's declarations, never
by an estimate of what an unread file could touch.

## Context

At `main` `db49322d`, adding a `build.gradle.kts` to a three-class Java repository turns a `complete` trace into a
`partial` one with a `receiver-unproven` cut that states no cause. `src/core/adapters/spring/java-declared-types.ts:35`
treats every `.kts` path as an unread JVM source, while `src/core/domain/languages/uncovered.ts:3-13` holds the same
rule with the exemption for Gradle scripts. One rule has two owners, and five readers of the Java owner consume the
wrong one.

The veto itself is sound for a real source of a sibling language. On 2026-11-08 the owner dropped a narrower veto for
aspects that estimated what a pointcut could select: no measured gain, and a risk of false steps.

| Option | Verdict |
|---|---|
| Add the exemption to the adapter's pattern | Rejected: it repairs one copy and keeps two owners |
| Estimate what an unread file can touch | Rejected: the path dropped on 2026-11-08 |
| One classification in the domain, and a declaration reader that releases the veto by positive proof | Chosen |

## Decision

1. `core/domain/languages` classifies every path of a snapshot into exactly one class: `source`, `declared-source`,
   `uncovered-source`, `build-configuration`, `test` or `other`.
2. No adapter declares a pattern over the paths of a language it does not read. A fitness test holds it.
3. A build script, build logic and a version catalog are `build-configuration` whatever language they are written in.
4. A `DeclarationReader` reads the types, supertypes and members (name and arity) of a language without a pack, and
   nothing else. The owner of a covered language of the same type system consumes them. Parameter types enter when the
   ledger shows overloads left unproven for lack of them.
5. With declarations read, a proof is refused only where a declared type takes part in it: the same package for a
   name, the hierarchy above for a member, at or below for a closure. A functional interface keeps its veto.
6. A file a reader cannot read, and a source the grammar cannot parse, keep the repository-wide veto.
7. A cut caused by an unread or unparsed source names that cause and its files.
8. A first declaration reader enters under ADR-0013, for the sibling language the baseline ledger of ADR-0071 shows
   vetoing the most answers.

## Consequences

- Repositories whose only sibling-language files are build scripts recover their Java proofs with decision 3 alone.
- Mixed repositories recover them type by type once a reader exists, and keep `no-extractor` for calls written in the
  sibling language.
- The classification becomes a dependency of every reader that filters paths; drift is a failing fitness test.

## Not decided here

- The name of the first sibling language, until the baseline ledger exists.
