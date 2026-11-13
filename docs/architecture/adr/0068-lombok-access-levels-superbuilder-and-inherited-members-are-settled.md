# ADR-0068: Lombok access levels, `@SuperBuilder`, `@Builder.Default` and members inherited from a Lombok superclass are settled

- Status: Accepted, 2026-11-13, lead decision under the owner's standing instruction (2026-11-13)
- Decision source: Lead decision under the owner's standing instruction (2026-11-13) to pick the recommended option, for spec S1 of trace-coverage-followups: "Variantes de Lombok (`@Getter(AccessLevel…)`, `@SuperBuilder`, `@Accessors`), que son la mayor fuente de cortes en Java".
- Related: [ADR-0013](0013-coverage-grows-only-with-evidence.md), [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md), [ADR-0067](0067-record-and-lombok-members-and-mybatis-statements-are-settled-from-the-snapshot.md) (decision 2 amended here)

**In short:** an access level on `@Getter`/`@Setter` keeps the generated names, so the member is still a settled `generated` receiver method; `AccessLevel.NONE` generates nothing. A Lombok annotation that adds no accessor or builder member never unsettles the others. `@SuperBuilder` over a project hierarchy that carries it throughout, `@Builder.Default`, and a member that Lombok generates on a superclass of the project are settled too. `@Accessors`, `@Singular`, `lombok.config` and any other argument stay unsettled.

## Context

ADR-0067 decision 2 left every annotation with an argument unsettled. The domain models of the evaluated corpus carry `@Getter @ToString(callSuper = true) @Setter(AccessLevel.PACKAGE)`, `@SuperBuilder` and `@Builder.Default` appear on four and five classes, and an entity hierarchy puts `@Getter @Setter` on an abstract superclass while its subclasses are empty. Corpus counts (nname, jhipster, petclinic, realworld-nx, shopizer): `@Setter(` 10, `@Getter(` 1, `@ToString(` 16, `@EqualsAndHashCode(` 6, `@SuperBuilder` 4, `@Builder.Default` 5; `@Accessors`, `@Singular`, `lombok.config` and `AccessLevel.NONE` none.

Lombok documents that the access level of `@Getter`/`@Setter` changes the visibility of the generated method, never its name, and that `AccessLevel.NONE` generates nothing; a field-level annotation takes precedence over the class-level one. Under the repository-compiles assumption (ADR-0062) a call that names a member is one the caller may access.

## Decision

1. An access level on `@Getter` or `@Setter` (`AccessLevel.PUBLIC|MODULE|PROTECTED|PACKAGE|PRIVATE`, positional or as `value`, resolved as `lombok.AccessLevel`) keeps the generated names: the member is settled. `AccessLevel.NONE` generates nothing for its scope, and on a field it suppresses the class-level annotation for that field only. A class that states `@Data` or `@Value` together with a class-level `@Getter`/`@Setter(AccessLevel.NONE)` stays unsettled. Any other argument of these annotations (`onMethod`, `onParam`, `lazy`, ...) and any argument of `@Data`, `@Value` or `@Builder` leaves the class unsettled, as before.
2. A Lombok annotation that generates no accessor or builder member (`@ToString`, `@EqualsAndHashCode`, `@Slf4j` and the other `lombok.extern.*` loggers, the constructor annotations) never unsettles other members, with or without arguments.
3. `@SuperBuilder` (`lombok.experimental.SuperBuilder`, no argument) on a class of the project generates `builder()`, a setter per field of the class and of every superclass, and `build()`, when every class of the project's superclass chain carries `@SuperBuilder`. A superclass of the project without it leaves the builder unsettled; a superclass outside the project is the open hierarchy of ADR-0067 decision 3. `@Builder.Default` on a non-static field with an initializer yields the builder setter for that field for `@Builder` and `@SuperBuilder`; a static field, or a final field with an initializer and no `@Builder.Default`, yields none.
4. A member that Lombok generates on a superclass of the project settles a call on a subclass receiver, under the closed-hierarchy conditions of ADR-0067 decision 3: a method declared anywhere in the hierarchy still wins, and a class of the chain whose Lombok annotations are not modelled stops the search. Only accessors are inherited; `builder()` is read on the receiver's own class.
5. `@Accessors`, `@Singular`, `@FieldNameConstants`, a `lombok.config` in the snapshot and any argument not named above stay unsettled (no corpus evidence, ADR-0013).

## Consequences

- Expected families to move: trace cuts (`receiver-unproven` down). No SCHEMA change; callers, impact and consequences read `generated` as before.
- On the nname restaurants traces the domain models and entities still extend a class of a library outside the snapshot (`DomainModel`, `AuditableEntity`), so their calls stay unsettled by the open hierarchy; only receivers whose whole chain lies in the project move.
- Hypothesis, accepted: an annotation processor does not rename members beyond what the annotations state.

## Not decided here

- Whether a member generated on the receiver's own class may be settled over a hierarchy that is open only through a library superclass: it relaxes ADR-0062 and needs its own decision.
- `@Accessors`, `@Singular`, `lombok.config`, `@With`, `@Delegate`, constructors.
