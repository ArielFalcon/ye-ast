# ADR-0067: Record and Lombok members and MyBatis mapper statements are settled from the snapshot

- Status: Accepted, 2026-11-13, lead decision under the owner's standing instruction (2026-11-13)
- Decision source: Lead decision under the owner's standing instruction (2026-11-13) to pick the recommended option on any fork, for spec S24 of the multirepo-quality evaluation: "a MyBatis mapper call is a data effect, or an explicit unplaced cut with its cause, never a silent leaf; a Lombok `@Builder`/`@Data`/`@Getter` generated member is a settled receiver method when the annotation is on the class in the snapshot".
- Related: [ADR-0013](0013-coverage-grows-only-with-evidence.md), [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md), [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md) (amended in spirit: the receiver reading keeps its closed-hierarchy conditions)

**In short:** a call whose member no source declares but a record, or a plain Lombok annotation on the class, adds is a settled receiver method (`generated`): the trace shows neither a step nor a cut. A call of a MyBatis mapper method is a data effect whose access comes from the statement the snapshot holds, or an explicit `effect-unplaced` cut that names why no statement decides it.

## Context

The detailed-trace evaluation of the multirepo workspaces reported 197 `receiver-unproven` cuts over 31 Java cases, 56 of them on generated, Lombok or record members, and MyBatis mapper calls as leaf steps with no effect and no cut. On the nname orders checkout trace, 160 cuts sat on calls such as `dto.getCustomerId()`, `CheckoutOrderODTO.builder().address(a)` and `lineItem.menuId()`: the receiver's declaring class has no such method in source, so the strict reading answered `unproven`. Evidence for MyBatis (ADR-0013): a Spring Boot realworld backend of the workspace corpus declares `@Mapper` interfaces with statements only in XML mappers (`src/main/resources/mapper/*.xml`, namespace = interface name); no corpus repository uses `@Select`-style annotations or `@MapperScan`, so those two forms follow MyBatis's documented rules and are covered by conformance fixtures, not by corpus evidence.

## Decision

1. A member is `generated` when the receiver's class is in the snapshot and:
   - it is a record and `name()` is the name of a component the record does not declare as a method;
   - a plain (argument-less) `@Getter`, `@Setter`, `@Data` or `@Value` is on the class, or `@Getter`/`@Setter` on the field, and the call names the accessor of a non-static field (`getX`, `isX` for a primitive `boolean`, `setX` for a non-final field; `@Value` gives no setters);
   - a plain `@Builder` is on the class and the call names the static `builder()`, the builder's setter named like a field (not static, not a final field with an initializer) or `build()`. The result of `builder()` and of a setter is the builder, and of `build()` the class; the result of an accessor is its field's declared type.
2. Lombok is read by the resolved name `lombok.*`. An annotation with an argument (an access level, a prefix, a rename), `@Accessors`, `@SuperBuilder`, `@Singular` or a `lombok.config` anywhere in the snapshot leaves its members unsettled (`unproven`), since the generated names or access may differ. [ADR-0068](0068-lombok-access-levels-superbuilder-and-inherited-members-are-settled.md) amends this: an access level on `@Getter`/`@Setter` and `@SuperBuilder` over a closed hierarchy are settled.
3. A method the class declares itself wins over the generated one (Lombok skips a member that exists, ignoring case); a name any type of the hierarchy declares is settled by the declared reading. The members are settled only over a closed hierarchy (ADR-0062 conditions), never for a type-variable receiver, and a static receiver names only `builder()`.
4. `ReceiverMethod` gains `{ kind: "generated" }`: the call is settled and has no declaration to place. The trace walk adds no step and no cut for it. Every other consumer of the binding reads it as an unproven receiver whose type offers no declaration (`candidates: []`), so callers, impact and consequences are unchanged.
5. An interface is a MyBatis mapper when it is annotated `org.apache.ibatis.annotations.Mapper` or lies in (or below) a package a `@MapperScan` names by string literals (a scan filtered by `annotationClass` or `markerInterface` names none). A call of its method is a data effect: the access comes from the statement of the method (`@Select` read; `@Insert`, `@Update`, `@Delete` write; an XML `select` read, `insert`, `update`, `delete` write, found by `<mapper namespace>` equal to the interface name and the statement `id` equal to the method name), the operation is the method name, and the target is a `table` only when the statement's SQL names exactly one table (`<include refid>` fragments of the document are expanded; a join, a list of tables, a `${}` text or an unresolved fragment names none).
6. A mapper call with no statement, or with more than one (two annotations, an annotation and an XML statement, a duplicate id), is `effect-unplaced` with the cause `mapper-statement-absent` or `mapper-statement-ambiguous` in the cut's place text. A default method of the mapper is code. A mapper receiver the binding does not prove stays unplaced without a cause.
7. XML files under a module's `src/main/java/` or `src/main/resources/` enter the snapshot sources as extractor configuration, so the mapper documents reach the data-effects reader; resource XML of another source set (an Android `src/main/res/`) does not.

## Consequences

- The nname checkout trace drops from 160 `receiver-unproven` cuts to 21; a callee whose body was unsettled only by such calls is now settled and folds into its parent's `leaves`.
- Expected families to move: trace cuts (receiver-unproven down) and trace data effects (MyBatis calls up); the XML mapper files enter the snapshot sources of every Spring module, so `map`/`impact` content hashes of repositories with such XML change.
- Hypothesis, accepted: a Lombok annotation behaves as documented and an annotation processor does not rename members; a mapper's `@Mapper` interface is bound to the XML namespace of the same name.

## Not decided here

- Lombok constructors (`@AllArgsConstructor`, `@NoArgsConstructor`, `@RequiredArgsConstructor`): no observed cut, so `this(...)`/`super(...)` into a generated constructor stays unproven.
- Dynamic mapper providers (`@SelectProvider` and its siblings), `@Results`-mapped tables and MyBatis-Plus base mappers.
