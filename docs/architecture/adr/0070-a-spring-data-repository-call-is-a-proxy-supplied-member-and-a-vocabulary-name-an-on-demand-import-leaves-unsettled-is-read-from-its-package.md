# ADR-0070: A Spring Data repository member is supplied by the proxy, and a closed-vocabulary name an on-demand import leaves unsettled is read from its package

- Status: Accepted, 2026-11-13, lead decision under the owner's standing instruction (2026-11-13)
- Decision source: Lead decision under the owner's standing instruction (2026-11-13) to pick the recommended option, for spec S3 of trace-coverage-followups: "Consultas derivadas dentro de cadenas `Optional`".
- Related: [ADR-0013](0013-coverage-grows-only-with-evidence.md), [ADR-0068](0068-lombok-access-levels-superbuilder-and-inherited-members-are-settled.md)
- Amends: [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md) decision 1, [ADR-0064](0064-a-supertype-outside-the-repository-redefines-no-java-name.md)

**In short:** a call on a Spring Data repository interface of the snapshot is a settled `generated` receiver member when the repository's whole outside hierarchy is the closed Spring Data vocabulary and the member is a body-less method the hierarchy declares (a derived query or a `@Query` method) or an operation of the vocabulary that nothing redeclares; the data effect reader places the effect. A simple name that an on-demand import alone leaves unsettled is read from the package of a closed vocabulary (Spring Data, Lombok) when the file imports that package. A name `java.lang` offers keeps its identity under an on-demand import of an unknown package. A single declared repository method of the name and arity is the call's target without an argument signature.

## Context

On the evaluated corpus a Spring Data call chain such as `userRepository.findOneByEmailIgnoreCase(userDTO.getEmail()).ifPresent(...)` or `authorityRepository.findById(...).ifPresent(...)` was cut as `receiver-unproven` and its data effect was `effect-unplaced`, and every getter and setter of a class annotated through `import lombok.*;` stayed cut. Four mechanisms, two layers:

1. Name resolution. ADR-0062 decision 1 binds a name one on-demand import of the repository declares, but a name no repository package declares stays unsettled whenever the file has an on-demand import. `import org.springframework.data.jpa.repository.*;` therefore left `JpaRepository` and `@Query` unresolved, and `import lombok.*;` left `@Getter`, `@Setter` and `AccessLevel` unresolved.
2. A `String` parameter received a `context:` identity whenever the file imported an on-demand package outside the platform tables (`org.springframework.data.domain.*`), so it never equalled the argument's `java.lang.String`.
3. The data effect reader demanded an argument signature even when exactly one repository method of the name and arity exists, and the signature reader knows only literals and identifiers.
4. The receiver reader treated every Spring Data parent as an unsettled supertype, so a repository member was `unproven`. Relaxing that alone yields a `dispatch` cut, because a body-less interface method becomes a child whose implementations (an aspect) it cannot bound.

## Decision

1. One name-resolution rule for closed vocabularies. A simple name that the strict binding leaves unsettled only because of on-demand imports resolves to `<package>.<Name>` when (a) a closed vocabulary the engine owns lists `<Name>` in `<package>`, (b) the file imports `<package>.*`, and (c) no type of the sources is visible by that name (same package, single-type import, member type in scope; `importedTypeSources` of ADR-0064). Under the repository-compiles assumption a second on-demand package offering the name would be an ambiguous reference. The vocabularies are the Spring Data repository interfaces and the `Query` and `Modifying` annotations (`data-vocabulary.ts`, the single owner, also read by the effect reader and the hierarchy reading of ADR-0062 decision 2), the Lombok types the engine models (annotations, `AccessLevel`), and `JpaSpecificationExecutor` as a repository fragment (decision 4). A wildcard of any other package, and a name a visible type offers, stay unsettled.
2. A name that `java.lang` offers is `java.lang.<Name>` even when other on-demand packages are unknown, unless a type of the sources is visible by that name or a static on-demand import of an unknown owner is present, which keeps its context identity as before.
3. The effect reader requires an argument signature only when more than one declared method of the name and arity exists, as the receiver reader does, and only when the repository's outside hierarchy is the closed vocabulary and the name is not one the vocabulary's interfaces declare (their overloads are not in the sources). Otherwise the signature is required as before.
4. A call whose receiver's declared type is an interface of the snapshot is `generated` (the port's existing kind, no new variant) when every supertype outside the sources resolves to the closed Spring Data vocabulary (at least one) and the called member is either a body-less method that the repository hierarchy declares, with one candidate of the call's arity or one a settled signature selects, or an operation of the vocabulary's closed operation set that no type of the hierarchy declares. A `default` method with a body is a normal child. Stay unproven: a parent outside the vocabulary (a fragment not in the snapshot, an unresolved supertype, `QueryByExampleExecutor`), an operation name the repository redeclares, two overloads no signature settles, an interface with no Spring Data parent, a class, type-variable or type-name receiver, and a vocabulary wildcard of another package. The Spring proxy supplies the member, so the call has no declaration to place; the effect reader places the data effect, or reports `effect-unplaced` when it cannot name the access (a custom implementation method).
5. `JpaSpecificationExecutor` is in the vocabulary only as a parent. Evidence (ADR-0013): on the nname restaurants service its parent on `RestaurantRepository`, `CourseRepository` and `DailyMenuRepository` is the only reason `save` and the derived queries stayed cut. `QueryByExampleExecutor` has no evidence and stays out.

## Consequences

- Expected families to move: trace cuts (`receiver-unproven`, `effect-unplaced` down), data effects up. No SCHEMA change.
- Hypothesis, accepted: a Spring proxy supplies a body-less repository method; an aspect around it is not a body the repository owns.
- A repository that redeclares an inherited operation (`findById` with `@NotNull`) stays unproven; settling it needs an argument-signature proof against the vocabulary's own declaration.

## Not decided here

- Redeclared vocabulary operations, `QueryByExampleExecutor`, Kotlin repositories, repository fragments in the snapshot that implement custom methods.
