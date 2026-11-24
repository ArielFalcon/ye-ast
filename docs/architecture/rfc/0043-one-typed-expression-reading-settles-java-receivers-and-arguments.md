# RFC-0043: One typed-expression reading settles Java receivers and arguments

- Status: Accepted, 2026-11-17. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions); every question is settled as its "Resolved questions" table states.
- Related: [ADR-0132](../adr/0132-one-owner-types-a-java-expression-and-every-reader-of-a-receivers-or-an-arguments-type-asks-it.md),
  [ADR-0133](../adr/0133-a-java-call-on-a-receiver-proven-outside-the-repository-that-no-repository-declaration-can-run-under-is-an-external-call.md),
  [ADR-0134](../adr/0134-a-java-overload-is-selected-by-the-applicability-the-language-defines-and-kept-as-candidates-where-it-is-not-decidable.md)
  (the decisions this RFC designs); [RFC-0013](0013-trace-and-patterns.md) R5, R6, R8;
  [RFC-0021](0021-java-value-flow.md), [RFC-0024](0024-receiver-typed-settlement.md),
  [RFC-0031](0031-cut-ledger-and-outcome-control.md), [RFC-0033](0033-declared-classpath.md),
  [RFC-0039](0039-recorded-reads-for-the-java-project.md),
  [RFC-0040](0040-resident-generations-and-answer-latency.md), RFC-0042 (cut causes, drafted beside this one);
  ADR-0044, ADR-0062, ADR-0063, ADR-0064, ADR-0070, ADR-0073, ADR-0079, ADR-0084, ADR-0086, ADR-0087, ADR-0106,
  ADR-0116 to ADR-0120

**In short:** one module of the Java adapters types an expression (a receiver, an argument, a chain link) from the
repository's declarations and the declared library signatures, and every reading that needs a type asks it. It
replaces four partial typers, lets a call proven to bind a library member leave the repository as an external call,
and selects overloads by the language's applicability. It must move `trace`/java `receiver-unproven` (129) and
`callee-unknown` (62), `effect-unplaced` (7), and the Java `name-only` rows of `callers` (15) and `impact` (16).

## Problem

Every row was re-verified at commit `62a41b28a`. Counts are over the corpus report of 2026-11-17 (118 answers, 436
cuts) and its text classification, which is a heuristic per place, not a proof.

| Evidence | Source |
|---|---|
| The receiver reading types a receiver that is absent or `this`, a call that names a repository method, or a name whose binding is `annotated`; anything else is untyped | `receiverOf`, `src/core/adapters/spring/java-receiver-methods.ts:881-904` |
| A receiver that is a parenthesized, cast or conditional expression, an array element, a literal or an object creation is `unproven` | `receiverMethodOf`, `java-receiver-methods.ts:240-242` |
| The declared JDK is passed to the dispatch reading and not to the receiver reading | `src/core/adapters/spring/java-name-bindings.adapter.ts:58` (`dispatchTargets`), `:59` (`receiverMethods`) |
| A second typer reads the JDK signatures, casts, constructions and chains; only the function-value proof calls it | `receiverOf` `:176`, `chainOf` `:349`, `src/core/adapters/spring/java-library-calls.ts`; callers `java-function-values.ts:193`, `:224` |
| A third typer reads the qualifier of a method reference, and asks no generated member | `referenceOf`, `java-receiver-methods.ts:1045-1068` |
| A fourth typer reads arguments: `int`, `long`, `String`, `boolean` literals and a local with a stated non-generic type | `readArgumentSignature`, `src/core/adapters/spring/java-symbols.ts:1080-1115` |
| A lambda parameter without a type, `var` and a multi-catch parameter state no type | `statedType`, `src/core/adapters/tree-sitter/java-receiver-bindings.ts:86-96` |
| A repository type that types a receiver is a class or an interface; an enum never is, and a test pins it | `repositoryType`, `java-receiver-methods.ts:1076-1079`; `java-receiver-methods.test.ts:187-191` |
| With two same-arity members and no exact match the answer is the candidates; a member with variable arity withholds the selection | `selectAmong`, `java-receiver-methods.ts:1157-1169`; `:1107` |
| The data-effect reading repeats the overload selection | `src/core/adapters/spring/data-effects.adapter.ts:86-97` |
| `trace` reads an `outside` receiver answer as `unproven` | `unprovenOutside`, `executed`, `src/core/application/trace/trace-walk.ts:304-306`, used at `:693`, `:746` |
| A construction or a static call of a library type inside a class with a supertype outside the repository is not rooted outside: the strict reading leaves the name `unsettled` | `chainRootOf`, `java-name-bindings.adapter.ts:118-123` |
| A single-type import of a type that is not under a platform prefix is not rooted outside | `chainRootOf`, `java-name-bindings.adapter.ts:121-122` (`isPlatformName`); the prefixes at `java-symbols.ts:187` |
| The library signatures state methods and constructors, no fields | `LibraryType`, `src/core/ports/library-signatures.port.ts:16-22`; `src/core/adapters/jdk/class-file.ts:186` |
| The only signature source is the declared JDK; ADR-0073 (classpath) has no code | `LibraryBasis`, `library-signatures.port.ts:25-31`; `rg -i classpath src` finds test strings only |
| `--jdk` is accepted by `trace`, `mcp` and `init` only | `src/cli/main.ts:95` |
| `trace`/java `receiver-unproven` 129: 70 on a simple name (local, parameter, lambda parameter, field), 27 on a later line of a chain, 15 on a call result, 8 bare calls, 5 `Type.CONSTANT.m` on JDK types, 4 `this.field.m` | classification script of the audit, over the ledger's cut places |
| `trace`/java `callee-unknown` 62: 33 name a method reference or a member inside a lambda, 28 bare calls (among them constructions of library classes and calls inside an anonymous subclass of a JDK map), 1 static call on a library type | same |
| The corpus manifest declares `--jdk` on 2 queries | manifest, outside the repository |
| Receiver shapes over four application shapes (a small Spring application, a generated monolith of about 140 Java files, a multi-module Spring application of about 1,200 Java files, a backend of about 120 Java files): `).m(` chains 116, 187, 3,562, 197; `new X().m` 2, 5, 119, 7; receivers that are lambda parameters without a type 9, 15, 80, 8; enum declarations 0, 0, 38, 1 | `rg` over the sources of each |

**Root cause.** The engine has no single reading of "the type of this Java expression". Each consumer grew the forms it
first needed: the receiver reading types three forms, the function-value proof nine and with library signatures, the
method-reference reading its own two, the argument reading five. A form one typer reads is a cut in the others, the
library signatures the host declared reach one of them, and a receiver proven to be a library value has no way to say
"this call leaves the repository", so `trace` holds it as unproven.

## Design

### The owner

`src/core/adapters/spring/java-expression-types.ts` (new) is the one module that decides the type of a Java
expression. It lives in the Spring adapter folder because the Java project model it reads (`JavaProject`, `TypeDecl`,
`resolve`) lives there and an adapter may not import another adapter except `spring` reading `tree-sitter` (AGENTS.md
dependency table). It is created by moving the typer of `java-library-calls.ts` into it, so from the first unit there
is no second path. `src/core/adapters/spring/java-overloads.ts` (new) is the one module that decides which overload a
call's arguments select (ADR-0134); it asks the typed-expression owner for argument types.

Nothing under `src/core/domain`, `src/core/application` or `src/core/ports` names a Java construct. The two port
changes this RFC makes are agnostic and written out in "Port changes".

### The contract

`src/core/adapters/spring/java-expression-types.ts`:

```ts
import type { Node } from "web-tree-sitter";
import type { LibraryBasis, LibraryReading } from "../../ports/library-signatures.port.ts";
import type { GeneratedMember } from "./java-generated-members.ts";
import type { JavaFile, JavaProject, MethodDecl, TypeDecl } from "./java-symbols.ts";

/** Why an expression has no proven type. Closed: a new cause is added here and nowhere else. */
export const JAVA_TYPE_CAUSES = [
  "form-not-read",      // an expression form the table of rules does not type
  "name-unbound",       // a simple name no declaration in scope binds, or one the strict reading leaves unsettled
  "declaration-untyped", // a declaration that states no type and whose initializer or context proves none
  "type-unresolved",    // a written type the strict name reading does not settle
  "type-variable",      // a type variable that nothing substitutes and that has no single bound
  "member-unsettled",   // a call or a field read whose member, or whose return type, the declarations do not settle
  "signatures-absent",  // a library type whose declared signatures are not held
  "inference-needed",   // a type only the compiler's inference gives (a method's own type variable, a diamond)
  "union-type",         // a multi-catch parameter, or conditional arms neither of which is below the other
  "recursive",          // an initializer that reads the variable it initializes
] as const;
export type JavaTypeCause = (typeof JAVA_TYPE_CAUSES)[number];

export const JAVA_PRIMITIVES = ["boolean", "byte", "char", "short", "int", "long", "float", "double"] as const;
export type JavaPrimitive = (typeof JAVA_PRIMITIVES)[number];

/** A type argument: settled, or `undefined` where the sources or the signatures do not settle it. */
export type TypeArgument = JavaType | undefined;

/** `bound`: a type variable's one bound stands for it. `exact`: the value is an instance of exactly this class. */
export interface RepositoryJavaType { kind: "repository"; type: TypeDecl; args?: readonly TypeArgument[]; bound?: true; exact?: true }
/** `basis`: `declared-jdk` when the declared signatures hold the type, `named` when only its qualified name is proven. */
export interface LibraryJavaType { kind: "library"; fqn: string; basis: LibraryBasis["basis"] | "named"; args?: readonly TypeArgument[]; exact?: true }

export type JavaType =
  | RepositoryJavaType
  | LibraryJavaType
  | { kind: "primitive"; name: JavaPrimitive }
  | { kind: "array"; element: JavaType }
  | { kind: "null" }
  | { kind: "unknown"; cause: JavaTypeCause };

/** What an expression is: a value of a type, or the name of a type (the qualifier of a static member). */
export type JavaExpressionType = JavaType | { kind: "type-name"; names: RepositoryJavaType | LibraryJavaType };

export type Subtyping = "yes" | "no" | "undecided";

export interface ExpressionTypingSources {
  project: JavaProject;
  /** The library signatures the host declared; absent when none was. */
  libraries?: LibraryReading;
  /** The type and every repository type above it, or `undefined` when one of its supertypes is not a repository type. */
  ancestors(type: TypeDecl): readonly TypeDecl[] | undefined;
  /** The type and every repository type above it, whatever else its supertypes include. */
  above(type: TypeDecl): readonly TypeDecl[];
  /** The member a repository call names, as the receiver reading selects it; absent for a reader that selects none. */
  selected?(invocation: Node, file: JavaFile): { method: MethodDecl } | { generated: GeneratedMember } | undefined;
}

export interface ExpressionTyping {
  typeOf(expression: Node, file: JavaFile): JavaExpressionType;
  /** The type a written type node states (`type_identifier`, `scoped_type_identifier`, `generic_type`, `array_type`, a primitive keyword). */
  writtenType(type: Node, file: JavaFile): JavaType;
  /** The type of the variable a declaration node of `variableInScope` declares. */
  variableType(declaration: Node, file: JavaFile): JavaType;
  isSubtype(type: JavaType, of: JavaType, file: JavaFile): Subtyping;
}

export function createExpressionTyping(sources: ExpressionTypingSources): ExpressionTyping;
```

`ancestors` and `above` are the two members `LibraryCallSources` already has (`java-library-calls.ts:18-20`) and
`FunctionValueSources` already supplies (`java-function-values.ts`), so the function-value proof passes its sources
unchanged. The signatures used for an expression are those of the file it is written in:
`sources.libraries?.of(file.path)`.

`src/core/adapters/spring/java-overloads.ts`:

```ts
import type { Node } from "web-tree-sitter";
import type { ExpressionTyping } from "./java-expression-types.ts";
import type { JavaFile, MethodDecl } from "./java-symbols.ts";

export type OverloadPhase = 1 | 2 | 3;
export type OverloadSelection =
  /** Every declaration of the one signature the arguments select, in the order given. */
  | { kind: "selected"; methods: readonly MethodDecl[]; phase: OverloadPhase }
  /** The declarations not proven inapplicable, in the order given; never empty. */
  | { kind: "candidates"; methods: readonly MethodDecl[] }
  /** Every declaration is proven inapplicable in every phase. */
  | { kind: "none" };

/** `candidates`: the declarations of one name the call's file reaches. `invocation`: a `method_invocation`, an `object_creation_expression` or an `explicit_constructor_invocation`. */
export function selectOverload(candidates: readonly MethodDecl[], invocation: Node, file: JavaFile, typing: ExpressionTyping): OverloadSelection;
```

### Port changes (agnostic, additive, no schema version)

`src/core/ports/import-origins.port.ts`, the `outside` member of `ReceiverMethod` (line 340) becomes:

```ts
  /**
   * ... (the existing text) ... `noFunctionValue`: the pack proves that no function value can be the receiver where the
   * call names this member. `module`: the module an external call under this type is listed under.
   */
  | { kind: "outside"; type: string; exact?: true; noFunctionValue?: true; module?: string };
```

`OutsideSupertypes` (line 289) gains `closure`:

```ts
/** ... `closure`: every type outside the repository at or above the listed ones, sorted, present only when the pack holds the declaration of each of them. */
export type OutsideSupertypes = { kind: "types"; types: readonly string[]; root?: string; static?: true; closure?: readonly string[] } | { kind: "unknown"; reason?: typeof CAPABILITY_ABSENT };
```

`src/core/ports/library-signatures.port.ts` gains fields:

```ts
/** A public or protected field of a library type, with its type as the generic signature writes it. */
export interface LibraryField {
  name: string;
  type: string;
  static: boolean;
}
export interface LibraryType {
  // ... existing members ...
  /** Absent where the source reads no fields. */
  fields?: readonly LibraryField[];
}
```

### Rules: what types an expression

Node kinds are those of the tree-sitter Java grammar the repository installs. `owner(n)` is the innermost type whose
body holds `n` (`thisType`, `src/core/adapters/spring/java-project.ts:146`). A rule's "else" column is the answer when
its proof is missing; every such answer is `{ kind: "unknown", cause }`.

| # | Form (node kind) | Answer | Proof | Else (cause) |
|---|---|---|---|---|
| T1 | `identifier` that `variableInScope(text, node, { stopAtType: true })` answers `{ declaration }` | `variableType(declaration)` (rules V1 to V9) | The declaration in scope (JLS 6.3, 6.4) | per V rule; `{ unsettled }` is `name-unbound` |
| T2 | `identifier` no local declares, a field of `owner` or of a type around it or above them | The field's written type (rule F1) | JLS 6.4.1, 8.3 | `member-unsettled` |
| T3 | `identifier` no variable or field can be (`declaresFieldAround` is false) that resolves to a type | `type-name` of that type | JLS 6.5.2; ADR-0064 for a name no repository declaration binds | `name-unbound` |
| T4 | `this` | repository type `thisType(node)` | JLS 15.8.3 | `name-unbound` (an anonymous or local class) |
| T5 | `super` | `form-not-read` (the receiver reading reads `super.m()` itself, ADR-0087 decision 4) | - | - |
| T6 | `field_access` `X.f` | by the type of `X`: a repository type or `this`: rule F1; a `type-name`: rule F2; an array with `f` = `length`: `int` | JLS 15.11 | `member-unsettled`; the cause of `X` when `X` is unknown |
| T7 | `method_invocation` | rules M1 to M7 | JLS 15.12.3 | per M rule |
| T8 | `object_creation_expression` without a class body and without an outer instance | `writtenType(type)` with `exact: true`; a diamond (`<>`) gives no `args` | JLS 15.9.1 | the cause of `writtenType` |
| T9 | `object_creation_expression` with a class body, or `outer.new T()` | `form-not-read` | - | - |
| T10 | `cast_expression` with one type | `writtenType` of it | JLS 15.16 | `union-type` for an intersection cast |
| T11 | `parenthesized_expression` | the type of its one expression | JLS 15.8.5 | `form-not-read` when it has none |
| T12 | `ternary_expression` | both arms the same type: it; one arm `null`: the other; one arm `isSubtype` `yes` of the other: the other; both primitive numeric: binary numeric promotion (JLS 5.6.2) | JLS 15.25 | `union-type` |
| T13 | literals | `decimal_integer_literal`, `hex_integer_literal`, `octal_integer_literal`, `binary_integer_literal`: `long` with an `l`/`L` suffix, else `int`; `decimal_floating_point_literal`, `hex_floating_point_literal`: `float` with `f`/`F`, else `double`; `true`, `false`: `boolean`; `character_literal`: `char`; `string_literal`: library `java.lang.String`; `null_literal`: `null` | JLS 3.10, 15.8.1 | - |
| T14 | `array_access` | the element of the array's type | JLS 15.10.3 | `form-not-read` when the array's type is not an array |
| T15 | `array_creation_expression` | `array` of `writtenType(type)`, one `array` per dimension | JLS 15.10.1 | the cause of `writtenType` |
| T16 | `class_literal` | library `java.lang.Class` | JLS 15.8.2 | - |
| T17 | `binary_expression` | `&&`, `\|\|`, `==`, `!=`, `<`, `>`, `<=`, `>=`: `boolean`; `+` with an operand typed `java.lang.String`: `java.lang.String`; an arithmetic, shift or bitwise operator with both operands primitive numeric: the promoted type (JLS 5.6.2; a shift promotes its left operand alone) | JLS 15.17 to 15.24 | `form-not-read` |
| T18 | `unary_expression` | `!`: `boolean`; `+`, `-`, `~` on a primitive numeric: its unary promotion (JLS 5.6.1) | JLS 15.15 | `form-not-read` |
| T19 | `instanceof_expression` | `boolean` | JLS 15.20.2 | - |
| T20 | `assignment_expression` | the type of its left side | JLS 15.26 | the cause of the left side |
| T21 | `update_expression` | the type of its operand | JLS 15.14, 15.15 | the cause of the operand |
| T22 | `lambda_expression`, `method_reference` | `inference-needed` (a function value has no type of its own; its target is the function-value proof's) | JLS 15.13, 15.27 | - |
| T23 | `switch_expression` and any other kind | `form-not-read` | - | - |

`writtenType` rules: a primitive keyword is that primitive; `array_type` is `array` of its element, once per
dimension; a name that is a type variable in scope (`typeVariableAround`) with exactly one bound is the bound's type
with `bound: true`, otherwise `type-variable`; `var` is `declaration-untyped`; a name `resolve(node, file, project,
enclosingType, node, true)` answers `repository` for is that repository type; one it answers `platform` or `library`
for is a library type, `declared-jdk` when the file's signatures hold it and `named` otherwise; a name the strict
reading leaves unresolved is read through `importedTypeSources` under ADR-0064 as `libraryClassOf` and
`singleImportedType` read it today (`java-library-calls.ts:69`, `:215`); anything else is `type-unresolved`. Type
arguments: one argument per declared type parameter, each a `writtenType`; a `? super X` or a bare `?` is
`undefined`; a count that differs from the declaration's type parameters gives no `args`. A wildcard `? extends X`
reads as `X` only when the type parameter it instantiates declares no bound: for a repository type, its
`type_parameter` node has no `type_bound`; for a library type the signatures hold, the entry of
`LibraryType.typeParameters` at that position is only its name (`typeParameterName`,
`src/core/adapters/spring/java-library-type-text.ts:24`). Otherwise it is `undefined`: the capture of the wildcard is
then below the declared bound too (JLS 5.1.10), a type the sources do not write.

Variable rules (`variableType`), by the declaration node `variableInScope` answers:

| # | Declaration | Type | Else |
|---|---|---|---|
| V1 | `variable_declarator` of a `local_variable_declaration` with a written type | `writtenType`, wrapped in `array` once per `dimensions` pair on the declarator | - |
| V2 | the same with `var` and an initializer | `typeOf(initializer)` without `exact`; an initializer already on the trail of the current reading is `recursive` | `declaration-untyped` without an initializer or when the initializer is a `type-name` |
| V3 | `formal_parameter` of a method or a constructor, or of a lambda that writes its type | `writtenType` | - |
| V4 | `spread_parameter` | `array` of `writtenType` | - |
| V5 | an `identifier` that is a lambda parameter without a type (`inferred_parameters`, or the lambda's single `parameters` identifier) | rule L1 | per L1 |
| V6 | `enhanced_for_statement` | with a written type: `writtenType`; with `var`: the element of the iterated expression's type when it is an `array`, or the type argument of `java.lang.Iterable` in the closure of a library type the signatures hold (substituted as M4 substitutes) | `declaration-untyped` |
| V7 | `resource` | with a written type: `writtenType`; with `var`: `typeOf` of its value | `declaration-untyped` |
| V8 | `catch_formal_parameter` | one type: `writtenType`; several: `union-type` | - |
| V9 | `instanceof_expression`, `type_pattern`, `record_pattern_component` (a pattern variable) | `writtenType` of the pattern's type | `declaration-untyped` when it states `var` |

Field rules. **F1**, a field `f` read on a value of repository type `R` (or on `this`, or by its bare name): walk
`project.classChain(R)` from `R`; the first class whose body declares `f` exactly once (`fieldsOf`,
`src/core/adapters/tree-sitter/java-function-value-calls.ts:92`, a record component included) gives
`writtenType` of the declaration, read in the declaring file. A type that is a type variable of `R` itself, with
`args` known on the receiver, is the argument at the variable's position. When no class of the chain declares it: the
one interface of `ancestors(R)` that declares it gives the type; none, several, or `ancestors(R)` undefined is
`member-unsettled`. For a bare name the search runs over `owner` and then each type around it, as `fieldReceiver`
does today (`java-library-calls.ts:254`). **F2**, `T.f` on a `type-name`: a repository `T` whose body declares an
`enum_constant` named `f` is the repository type `T`; otherwise F1 on `T`; a library `T` whose signatures state
`fields` gives the type text of the static field `f`, parsed and substituted as M4 does; no `fields`, or no such
field, is `signatures-absent`.

Method invocation rules, for `X.m(args)` with `n` arguments:

| # | Receiver | Answer | Else |
|---|---|---|---|
| M1 | any, `m` is `toString` with `n = 0`, `hashCode` with `n = 0`, `equals` with `n = 1` | `java.lang.String`, `int`, `boolean` (JLS 4.3.2; `String` is final and a primitive return type cannot vary, JLS 8.4.5) | - |
| M2 | any, `m` is another method of `OBJECT_METHODS` (`java-receiver-methods.ts:42`) | `member-unsettled` | - |
| M3 | none, or `this` | the agreed return type of the declarations of `m` that `n` may select in the innermost enclosing type that has a member `m` (`unqualified`, `java-library-calls.ts:390`) | `member-unsettled` |
| M4 | a library type the signatures hold, or its `type-name` | the agreed return type of every member of the name that `n` may select in the type and the types above it (`candidatesOf`, `java-library-calls.ts:112`), each type variable substituted from the receiver's `args` through the supertypes' arguments and from an argument passed as exactly that variable (`withMemberVariables`, `:146`); a `type-name` reads static members only | `signatures-absent` when a type of the closure is not held; `inference-needed` when the return type is an unsubstituted type variable; `member-unsettled` when the members disagree or there is none |
| M5 | a library type with basis `named` | - | `signatures-absent` |
| M6 | a repository type, or its `type-name` | when `sources.selected` answers a method: `writtenType` of its return type read in the declaring file (a type variable of the declaring type is the receiver's argument at its position when the declaring type is the receiver's own type); when it answers a generated `accessor`: `writtenType` of the field it reads; a generated `built`: the repository type it builds; otherwise the agreed return type of the declarations `n` may select over `ancestors` (`declared`, `java-library-calls.ts:375`) | `member-unsettled`; `type-variable` |
| M7 | a primitive, an array, `null`, or `unknown` | - | the receiver's cause, or `member-unsettled` |

"Agreed" is the rule `agreed` already implements (`java-library-calls.ts:222`): every candidate's return type is the
same type; library types that differ only in their arguments agree on the raw type.

Lambda parameter rule **L1**. Let `p` be the identifier, `L` its `lambda_expression` with `k` parameters, `i` the
position of `p`. Read `L`'s context through `parenthesized_expression`:

1. `L` is the value of a `variable_declarator` whose declaration writes a type (not `var`), or the operand of a
   `cast_expression` with one type: the target is `writtenType` of that type.
2. `L` is argument `a` of a `method_invocation` `X.m(...)`: type `X` by `typeOf`. For a library receiver the
   signatures hold, the candidates are those of M4; for a repository receiver, the declarations of `m` that the
   argument count may select over `ancestors`. Each candidate gives the type of its parameter at `a` (the element type
   for a position at or past a variable-arity parameter). A candidate whose parameter there is not a class type, or
   is not a functional interface with a single abstract method of `k` parameters, is not potentially compatible
   (JLS 15.12.2.1) and is dropped; a candidate whose parameter is a type variable makes the answer `inference-needed`.
3. Any other context is `inference-needed`.

For a target `FI<A1..Am>` the signatures hold whose single abstract method (`functionalMember`,
`src/core/adapters/spring/java-function-values.ts`) declares parameter `i` as `P`: substitute the type variables of
`FI` in `P` by `A1..Am`, where an argument `? super B` reads as `B`, an argument `? extends B` reads as `B` when the
type parameter of `FI` at that position declares no bound (JLS 9.9, the function type of a wildcard-parameterized
interface, which is `glb(B, declared bound)` otherwise), a bare `?` or a bounded position is unsettled, and each `B`
is substituted through the candidate's environment as M4 does. The answer is the type every remaining candidate
agrees on. No candidate left, a target the signatures do not hold, a repository functional interface, an unsettled
argument or a disagreement is `inference-needed` (`signatures-absent` when the only obstacle is a type not held).

`isSubtype(S, T)`:

| `S` | `T` | Answer |
|---|---|---|
| identical types (same `TypeDecl`, or same `fqn`), or primitives with the same name | - | `yes` |
| `null` | a repository, library or array type | `yes` |
| `null` | a primitive | `no` |
| any reference type | library `java.lang.Object` | `yes` |
| repository `R` | repository `T` | `yes` when `above(R)` holds `T`; `no` when `ancestors(R)` is defined and does not; else `undecided` |
| repository `R` | library `T` | `yes` when a supertype clause of a type of `above(R)` resolves to `T`, or to a library type whose closure in the signatures holds `T`; `no` when `ancestors(R)` is defined, `R` is no enum and no record, and `T` is not `java.lang.Object`; else `undecided` |
| library `L` (`declared-jdk`) | repository `T` | `no` when every type of the closure of `L` in the signatures is held and none has the qualified name of `T`; else `undecided` |
| library `L` (`named`) | repository `T` | `undecided` (a dependency may extend a type the repository publishes) |
| a repository or a library type | an `array` | `no` |
| library `L` (`declared-jdk`) | library `T` | `yes` when the closure of `L` in the signatures holds `T`; `no` when every type of that closure is held and none is `T`; else `undecided` |
| library `L` (`named`) | library `T` other than `L` | `undecided` |
| `array` of `E` | `array` of `F` | for reference `E`, `F`: `isSubtype(E, F)`; for primitives: `yes` when identical, else `no` |
| `array` | library `java.lang.Cloneable`, `java.io.Serializable` | `yes` (JLS 4.10.3) |
| `array` | any other non-array type | `no` |
| a primitive | a reference type, or the reverse | `no` (boxing is the overload owner's, not subtyping) |
| `unknown` on either side | - | `undecided` |

### Rules: what the receiver reading does with a typed receiver

`receiverOf` (`java-receiver-methods.ts:881`) keeps three branches and asks the owner for the rest:

| # | Receiver | Reading |
|---|---|---|
| R1 | none, or `this` | unchanged (`searchedType`), plus rule X5 below |
| R2 | a call that names a generated builder (`generatedResult` answers `builder: true`) | unchanged: "the builder of `X`" is no type the sources declare |
| R3 | anything else | `typing.typeOf(object, file)`: a repository type whose `TypeDecl.kind` is `class` or `interface` (rule R6 adds enums) gives `{ type, bound: answer.bound === true, typeName: false }`; a `type-name` of such a type gives `typeName: true`; a library type goes to rule R4; any other answer is `undefined`, which `receiverMethodOf` already turns into `unproven`, or `unknown` for a name (ADR-0087 decision 1, unchanged) |
| R4 | a library type, not a `type-name`, not a memberless platform interface (`MEMBERLESS_PLATFORM_INTERFACES`) | `outsideReceiverOf` answers its `fqn`: `{ kind: "outside", type: fqn }`, with the marks of rules X1 to X6 |
| R5 | a repository type with `exact: true` (a construction) | the member `memberOf` selects with `virtual = false`; when it has a body the answer carries `exact: true` (ADR-0132 decision 8) |
| R6 | a repository enum (`TypeDecl.node.type === "enum_declaration"`) none of whose `enum_constant` children has a `body` | read as a class: `repositoryType` accepts it; `runnableAmong` no longer refuses it as a type below (`subtype.kind === "other"`, `java-receiver-methods.ts:784`) when it has no bodied constant. An enum with a bodied constant, and an annotation type, keep `undefined` |
| R7 | a method reference `Q::m` (`referenceOf`, `:1045`) | the qualifier `Q` is typed by `typing.typeOf`; a repository type whose closed hierarchy declares no method `m` and for which `generatedOf` answers a member at arity 0 or at arity 1 answers `generated`; a library qualifier answers `outside` (rules X3, X4) |

`sources.selected` is `methodNamed` (`:975`) of the same resolver, so the type of `a.f().g()`'s receiver is the return
type of the member `f` the selection names, as today.

### Rules: when a call leaves the repository (ADR-0133)

What the Java pack marks on an `outside` answer. `packageOf(fqn)` is the function of that name in
`java-name-bindings.adapter.ts:213`, moved to `java-symbols.ts` and exported.

| # | Call | Answer |
|---|---|---|
| X1 | `super.m()` over an outside superclass (existing) | `{ kind: "outside", type, exact: true, module: packageOf(type) }` |
| X2 | `T.m(...)` where `typeOf(T)` is a `type-name` of a library type | `{ kind: "outside", type: fqn, exact: true, module }` (a call through a type name names a static member, JLS 15.12.3) |
| X3 | `new T(...)` without a class body, and `T::new`, where `writtenType(T)` is a library type | `{ kind: "outside", type: fqn, exact: true, module }` |
| X4 | `Q::m` where `Q` is a `type-name` of a library type the signatures hold and every member named `m` in its closure is static | `exact: true`; any other library qualifier: no `exact`, marks as X6 |
| X5 | a call without a receiver inside an anonymous class body (`searchedType` reaches a holder that is an `object_creation_expression` with a class body) whose written type is a library type `T` the signatures hold with its whole closure, whose body declares no method of the name, where a member of the name is stated in that closure | `{ kind: "outside", type: T, exact: true, module }`; when the closure states no member of the name the search continues outward, as JLS 15.12.1 does; when a type of the closure is not held: `unproven`, as today |
| X6 | a value receiver typed as a library type (R4) | `module: packageOf(fqn)`; `noFunctionValue: true` when the signatures hold the type and every type above it and either its `kind` is `class`, `enum` or `record` and it is not `java.lang.Object`, or its `kind` is `interface` or `annotation` and the call's name and argument count are not those of its single abstract method (`functionalMember` is `undefined`, or names another member) |

What `trace` does with an `outside` answer (language-agnostic, `trace-walk.ts`):

| # | Answer | Outcome |
|---|---|---|
| E1 | `exact` | an external call |
| E2 | not `exact`, `noFunctionValue`, and the name closure keeps no declaration | an external call |
| E3 | not `exact`, and the name closure keeps declarations | a cut listing those declarations |
| E4 | not `exact`, no `noFunctionValue`, the name closure keeps none | a cut with no candidate |
| E5 | the name closure is open | a cut listing the declarations of the name in scope, as today |
| E6 | a method reference with outcome E1 or E2 | nothing: no step, no external call, no cut |

The external call is `{ kind: "import", module, name: <the call's spelling> }`, or `{ kind: "unnamed", name }` without
a `module`; it goes through `leafUnlessReplaced` like every other leaf.

**Name closure** of a call of `name` written in `file` under the dispatch `{ type }`:

```text
named   = bindings.namedDeclarations(name, file, true)            // the declarations a value can be
kept    = [ d in named where await bindings.mayRunUnder({ type }, d, signal) ]
sources = ((await memberDeclarations()).get(name) ?? []) filtered by mayRunDeclarationOf(file, source)
for each source in sources:
  callables = (await syntaxIndexOf(source)).callables.get(name) ?? []
  placed    = [ d in named where d.file === source ]
  if callables is empty                                           -> return "open"
  if some callable c has no d in placed with c.start <= d.startLine <= c.nameLine -> return "open"
return kept
```

### Rules: overload selection (ADR-0134)

`selectOverload(candidates, invocation, file, typing)`:

```text
args   = the argument nodes of invocation, comments left out
types  = args.map(a => typing.typeOf(a, file))                    // a type-name is unknown here
groups = candidates grouped by stated signature: two declarations are one group when readSignature gives both
         a signature and sameSignature holds; a declaration with no readable signature is its own group
shape(g)   = the parameters of the group's first declaration: each a written type node, the last marked variable-arity
arity ok(g, phase): phase 1, 2: parameters.length == args.length and (phase rule) ; phase 3: g is variable-arity and
                    args.length >= parameters.length - 1

verdict(A, P, phase):                                              // one argument type against one parameter type
  if A is unknown or a type-name                                   -> undecided
  if P is a type variable of the method or of a type around it     -> undecided
  T = typing.writtenType(P), erased (args dropped); generic = P states type arguments
  if T is unknown                                                  -> undecided
  if A, T primitive:   same name -> yes; A widens to T (JLS 5.1.2 table below) -> yes; else no
  if A primitive, T reference:
       phase 1 -> no
       B = the box of A (JLS 5.1.7);  s = typing.isSubtype(library B, T)
       s == yes -> (generic ? undecided : yes);  s == no -> no;  else undecided
  if A reference, T primitive:
       phase 1 -> no
       A is one of the eight box types -> verdict(unbox(A), T, 1);  A is null -> no;  else no
  s = typing.isSubtype(A, T)
  s == yes -> (generic ? undecided : yes);  s == no -> no;  else undecided

applicable(g, phase):                                              // "yes" | "no" | "undecided"
  if not arity ok(g, phase) -> no
  per argument i: P = parameter i (phase 3: the element type of the last parameter for i >= parameters.length - 1)
  any verdict no -> no;  else any undecided -> undecided;  else yes
  a group without a readable signature -> undecided when arity ok

identical(g): arity ok(g, 1), and for every argument i: A_i is a repository, library, primitive or array type,
              parameter i states no type arguments and is no type variable, and writtenType(parameter i) is A_i
              (same TypeDecl, same fqn, same primitive, arrays by their elements)
if exactly one group g is identical -> return selected(g, 1)      // see "Soundness", row "Overloads, identity"

for phase in 1, 2, 3:
  yes = groups applicable yes;  maybe = groups applicable undecided
  if maybe is not empty -> return candidates(groups not "no" in every phase)
  if yes is empty       -> continue
  if yes has one group  -> return selected(that group, phase)
  best = the groups g of yes such that for every other h of yes and every position i:
           typing.isSubtype(param_i(g), param_i(h)) == yes  (primitives: identical or widening)
  best has exactly one group -> return selected(it, phase)
  else -> return candidates(yes)
return none
```

Widening primitive conversions (JLS 5.1.2): `byte` to `short`, `int`, `long`, `float`, `double`; `short` to `int`,
`long`, `float`, `double`; `char` to `int`, `long`, `float`, `double`; `int` to `long`, `float`, `double`; `long` to
`float`, `double`; `float` to `double`. Boxes (JLS 5.1.7): `boolean`/`java.lang.Boolean`, `byte`/`Byte`,
`short`/`Short`, `char`/`Character`, `int`/`Integer`, `long`/`Long`, `float`/`Float`, `double`/`Double`, all in
`java.lang`. A constant is never narrowed in an invocation context (JLS 5.3).

How the receiver reading uses it: `exactCandidate` (`:1177`) is replaced by `selectOverload` over the reachable
members `offeredAmong` returns. `selected` gives the group; the member of the group is chosen as `selectAmong` chooses
today among declarations of one signature (the type's own, else the nearest up its class chain, else the only one).
`candidates` and `none` give `{ candidates }` over the returned methods (`none`: the reachable ones), unchanged in
shape. The guard "every member of the name, no variable arity" (`:1107`) is removed for a closed hierarchy; the open
hierarchy keeps `named.some(hasVarargs)` (`:1102`, `:1144`).

### Soundness

| Rule | Why it cannot assert something false | The input that would break it, and how it is excluded |
|---|---|---|
| T1 to T3 | The declaration is the one the language's scoping gives; a name is a type only when no variable or field can be it | A field an outside supertype declares under the name of an imported type: ADR-0064's stated assumption, scoped to names a single-type import binds or the declared JDK holds; a lowercase name only an outside supertype could declare is `name-unbound` |
| T8 | A construction without a body creates an instance of exactly the class it names | `new T() { ... }` creates a subclass: rule T9 answers `form-not-read` |
| T12 | The conditional's type is the least upper bound; when one arm's type is above the other's it is that type | Arms whose least upper bound is a third type: `union-type` |
| V2 | A `var` local has its initializer's type (JLS 14.4.1) | A capture or an anonymous class as initializer: `exact` is dropped, and T9 is unknown |
| M4, L1 | The return and parameter types are the declared signatures' own, substituted only by arguments the sources write | A member the build's release has and the declared JDK's release lacks, or the reverse: ADR-0063 decision 3's stated residual; an inferred method type variable: `inference-needed` |
| M6 | The selected member's declared return type bounds every override's (JLS 8.4.5) | A repository receiver whose hierarchy is open: `selected` answers nothing unless ADR-0086 selects, and `declared` requires `ancestors` |
| `? extends X` read as `X` | With no declared bound on the type parameter, the capture's only upper bound is `X`, so its members and its supertypes are those of `X` | A type parameter that declares a bound (`Holder<T extends Jdbc>` read as `Holder<? extends Store>`): the capture is below `Jdbc` too, so the rule answers `undefined` there. Using the answer as an exact type argument: no rule of this RFC compares arguments for equality (`receiverFits` keeps its own reading) |
| R5 | The run-time class is exactly `C`, so the member `C` has is what runs | The selection naming an abstract declaration: `exact` is set only when the selected member has a body |
| R6 | An enum without bodied constants has no class below it (JLS 8.9: an enum is final unless a constant has a body) | A constant with a body: excluded by the rule; a `lombok.config`: the existing `generated` guard |
| X2, X3 | A static member and a constructor are not virtual | A name that is a variable: T3 requires that no variable or field can be it |
| X5 | An anonymous class cannot be extended, and its body declares no method of the name, so the member it inherits runs | A member an enclosing type also has: the language searches the anonymous class first, and the rule requires the closure to state the member |
| X6, E2 | No repository declaration of the name can run under the type (ADR-0079 decision 5, per declaration), no callable is hidden from the index, and no function value can be the receiver | A library interface that narrows another into a functional interface: ADR-0133 decision 4's stated assumption; a lambda the same source binds to the receiver: RFC-0013 R6's function-value row still makes it a cut, since `settleByName` is not reached and `holdsFunctionValue` is asked first (unit U8 step 4) |
| Overloads | A member is selected only in the first phase where one is certainly applicable and no other is possibly applicable, and only when certainly most specific | An argument whose type is not proven, a generic parameter, an open hierarchy: all `undecided`, which keeps the candidates |
| Overloads, identity | A group whose parameter types are the arguments' own types is applicable in phase 1. Any other group applicable in phase 1 takes each argument by subtyping or primitive widening from that same type, so the identical group's parameters are below its parameters at every position and it is the most specific (JLS 15.12.2.5); two groups cannot both be identical, since they would state one signature | An argument whose static type is below the type the owner answers: only a wildcard capture under a declared bound, which `writtenType` answers `undefined` for. A type variable's bound (`bound: true`) is safe: the variable's supertypes are its bound's |

### Kept reads (ADR-0116 to ADR-0120)

The owner holds no file list and enumerates no type. Every cross-file read it makes is one of these:

| Question the owner asks | How it is recorded |
|---|---|
| The type a written name denotes (`resolve`, `lookupType`, `bindName`, `importedTypeSources`, `typesDeclaring`) | By the project inside `project.reading` (ADR-0116 decision 3): `declaring`, `named`, `package`, `build` |
| A field, a method or a return type of a type of another file (F1, M3, M6) | The `TypeDecl` is handed out by the project, which records `file` for its path (ADR-0116 decision 3) |
| The repository types above a type (`ancestors`, `above`) | The resolver's `declaredHierarchy`, which resolves each clause through the project |
| The types below a type, an anonymous or local class below it, a method reference of a name (only through `sources.selected`, never by the owner) | The resolver's `writes`, which asks `naming(supertype \| unplaced-supertype \| method-reference, name)` (ADR-0119 decision 2) |
| A library type's declaration | Not a question of the index: the signatures are an input. The digest `libraries?.of(path)?.basis.digest ?? ""` of the file's signatures joins the subject of `java-receiver-sites` (`java-receiver-methods.ts:149`) and the layout of `java-receiver-methods` (`:177`), and the slot version of `java-receiver-sites` is bumped (`src/core/domain/snapshot/stored-derived-facts.ts:19`) |

The lambda rule, the variable rules and the expression rules read the call's own file only. The function-value
guard of X6 reads the signatures only. The name closure runs in the core over readings it already holds.

### What the design does not do

- It runs no compiler, loads no class and infers no type argument.
- It adds no vocabulary of library types: what a library type is comes from the declared signatures or from its name.
- It does not change which declaration a typed receiver names (the selection of ADR-0062, ADR-0086 and ADR-0106),
  except through the overload owner.
- It does not tighten or widen RFC-0013 R6.
- It adds no cut reason and no sub-reason; RFC-0042 owns the labels, and unit U0 says how to read them.

## Delivery units

Order matters: each unit merges to `main` alone and leaves it consistent.

| Unit | Behavior | Needs | Ledger rows it may move |
|---|---|---|---|
| U0 | Measurement: the cuts by receiver form, and the manifest's `--jdk` | - | none |
| U1 | The owner exists: the typer of the library-call reading moved into it, same answers | U0 | none |
| U2 | Variables are resolved by the scoping owner; `var`, loop, resource, catch and pattern variables | U1 | `dispatch` (function-value veto) |
| U3 | The remaining expression forms (T4 to T23, F1, F2 for repository types, M1, M2) | U2 | none expected |
| U4 | The receiver reading asks the owner (R3, R5, R7) | U3 | `receiver-unproven:-`, `callee-unknown:-`, `name-only:-` |
| U5 | Library signatures reach the receiver reading (R4 through M4) | U4 | `receiver-unproven:-` on queries with `--jdk` |
| U6 | Library fields in the signatures (F2 for library types) | U5 | `receiver-unproven:-` on queries with `--jdk` |
| U7 | The pack marks what leaves (X2 to X6) | U5 | `name-only:-` |
| U8 | `trace` reads an `outside` answer (E1 to E6) | U7 | `receiver-unproven:-`, `callee-unknown:-` |
| U9 | The library closure of outside supertypes | U8 | `receiver-unproven:-`, `name-only:-` |
| U10 | Lambda parameters without a type (L1) | U5 | `receiver-unproven:-` on queries with `--jdk` |
| U11 | The overload owner, asked by the receiver reading | U4 | `receiver-unproven:-` |
| U12 | The other overload readers ask it; `readArgumentSignature` is deleted | U11 | `effect-unplaced:-` |
| U13 | Enum receivers (R6) | U4 | `receiver-unproven:-` |
| U14 | Measurement: the cuts a library that is not the JDK leaves, and the rule that schedules ADR-0073 | U8, U10 | none |

### Shared by every unit

**First step (S0).** Merge `main` into the unit's branch. Locate every symbol the unit names by its name
(`rg -n "<symbol>" src`), not by its line: the latency program (RFC-0040) is converting the whole-project Java readers
into per-file kept reads on other branches, so the files named here will have moved. If a symbol is gone or its role
changed, stop (X0).

**Test fixtures.** Tests of the receiver reading extend `src/core/adapters/spring/java-receiver-methods.test.ts` and
reuse its helpers `java`, `use`, `methodAt`, `method`, `place`, `STORE`, `JDBC` (lines 12-42). `use(call, members,
parameters)` writes a class `Use` whose method `run` holds `call` on line 4. Tests that need signatures use
`librariesOf()` and `jdkTypes()` of `src/core/adapters/spring/java-library.testing.ts` and this helper, added once in
U5:

```ts
/** `methodAt` read with library signatures. */
async function methodWith(libraries: LibraryReading, sources: readonly SourceFile[], member: string, start = ""): Promise<ReceiverMethod> {
  const user = sources.find(({ path }) => path.endsWith("/Use.java"))!;
  const line = user.content.split("\n")[3]!;
  const column = start === "" ? line.indexOf("{ ") + 3 : line.indexOf(start) + 1;
  const [method] = await createJavaNameBindings(createJavaParser, sources, undefined, undefined, undefined, [], libraries).receiverMethods([{ file: user.path, line: 4, column, member }]);
  return method!;
}
```

Tests of the owner live in `src/core/adapters/spring/java-expression-types.test.ts` (new in U1) with this helper:

```ts
/** The type of the first expression of `Use.java` whose text is `text`, read over `sources` and `libraries`. */
async function typeAt(sources: readonly SourceFile[], text: string, libraries?: LibraryReading): Promise<unknown> {
  return withJavaSources(await createJavaParser(), (parse) => {
    const { files } = parse(sources);
    const project = createJavaProject(files);
    const file = files.find(({ path }) => path.endsWith("/Use.java"))!;
    const hierarchy = readHierarchy(files, project, libraries);
    const typing = createExpressionTyping({ project, ...(libraries === undefined ? {} : { libraries }), above: (type) => ancestorsOf(type, hierarchy), ancestors: (type) => { const above = ancestorsOf(type, hierarchy); return above.some((ancestor) => hierarchy.outside.has(ancestor)) ? undefined : above; } });
    const found = file.root.descendantsOfType(EXPRESSION_KINDS).filter((node) => node !== null && node.text === text)[0]!;
    return plain(typing.typeOf(found, file));
  });
}
/** A type with each `TypeDecl` replaced by its qualified name, so `deepEqual` compares data. */
const plain = (type: unknown): unknown => JSON.parse(JSON.stringify(type, (key, value) => (key === "type" && typeof value === "object" && value !== null && "fqn" in value ? value.fqn : value)));
```

`EXPRESSION_KINDS` is the list of node kinds of table T1 to T23, exported by the owner. `readHierarchy` and
`ancestorsOf` are those of `java-dispatch-targets.ts` (`readHierarchy` at line 494; export `ancestorsOf` if it is not
exported). Fixture names are neutral (`Order`, `Store`, `Item`); no fixture names an application.

**Acceptance (A0).** `npm run check` passes. The report states the five items of the acceptance gate
(`odd/tasks/engine-gap-roadmap.md`, "Acceptance gate for every unit"): the owner (the module named in the unit); the
contract (the sum type named in the unit); no second path (`rg` for the patterns of
`java-typing.single-rule.test.ts` finds only the owners); no chain of special cases (every new case is a row of a
rule table of this RFC); the fitness function (the single-rule test, extended as the unit says). Each RED test was
seen failing for the stated reason before the change. Docs: the doc comment of every changed export states the new
rule.

**Corpus gate.** Run once, after merging `main`: `node --import tsx scripts/corpus-gate.ts --corpus <manifest> --base
main --candidate <branch>` with the unit's `--expect` and `--expect-cuts`. Declare a `--expect-cuts <reason>:-` only
when U0's table counted at least one cut that the unit's rule settles on a query whose inputs let the rule fire;
otherwise leave that reason out. List every difference of the report with why it is right.

**Stop conditions (X0).** Stop and report, without deciding, when: a symbol named here no longer exists or no longer
has the role described; a RED test passes before the change; a sibling test that the unit says must stay green fails
after it; the corpus gate shows a new cut, a removed step, or a moved family the unit did not declare; a rule would
need a case that is not a row of this RFC's tables.

### U0: measurement

- **Goal.** Know, per receiver form, how many `trace`/java cuts each rule of this RFC can settle, and whether the
  corpus lets the rules that need signatures fire.
- **Prerequisites.** None. No source change; the output is a table in the unit's report.
- **Steps.**
  1. Run the corpus gate on `main` against itself (`--base main --candidate main --expect none`) and keep its report.
  2. If RFC-0042 is on `main`, group the `trace`/java cuts of reasons `receiver-unproven` and `callee-unknown` by the
     cause label the engine writes. Otherwise run the audit's classification script (`classify.py`, kept with the
     audit reports outside the repository; the lead supplies its path) with `python3 -I classify.py`.
  3. Fill this table, one row per class: the count, and the count on queries whose manifest entry declares `--jdk`.

     | Class | Settled by |
     |---|---|
     | A: receiver is `new T()`, a cast, parentheses, a conditional, `a.b` or `this.f` of a repository type | U4 |
     | B: receiver is a call result or a later link of a chain | U4 (repository links), U5 (library links) |
     | C: receiver is a `var` local, a loop, resource, catch or pattern variable | U2 with U4 |
     | D: receiver is a lambda parameter without a type | U10 |
     | E: receiver is `Type.CONSTANT` of a library type | U6 |
     | F: a method reference to a generated member | U4 |
     | G: a construction, a static call or a method reference of a library type | U7, U8 |
     | H: a call without a receiver inside an anonymous class of a library type | U7, U8 |
     | I: a value receiver declared with a library type | U8, U9 |
     | J: same-arity overloads with a typed receiver | U11 |
     | K: a receiver of an enum type | U13 |
     | L: `effect-unplaced` whose repository declares several methods of the operation's name and arity | U12 |
     | M: a class I or B cut kept only because a source declares the name outside a callable (name closure "open") | none: reported |
  4. Count the Java `trace` queries of the manifest and those that declare `--jdk`.
- **Decision table.**

  | Reading | Action |
  |---|---|
  | Fewer Java `trace` queries declare `--jdk` than exist | Report it to the lead before U5. The manifest is outside the repository and is the lead's to change (ADR-0079 resolved question 4 already answers "yes" for the reverse families). Until it changes, U5, U6 and U10 declare no `--expect-cuts` and their report says the rule is proven by fixtures only |
  | A class counts 0 | The unit that settles it still lands (its rule is a row of the owner's table and its fixtures prove it); it declares no `--expect-cuts` for that class |
  | Class M is more than a tenth of classes I and B together | Report it: a pack capability that tells a callable declaration from a field of the same name is a candidate follow-up; this RFC does not design it |
- **RED test.** None: no behavior changes.
- **Acceptance.** The table, the two query counts, and the manifest action taken or reported.
- **Corpus gate expectation.** `--expect none`.
- **Risk.** `Risk: none`.
- **Stop conditions.** The gate on `main` against itself reports a difference.

### U1: the owner exists

- **Goal.** Move the typer of `java-library-calls.ts` into `java-expression-types.ts` with the sum type of the
  contract, with identical answers for the function-value proof.
- **Prerequisites.** U0.
- **Files.** Create `src/core/adapters/spring/java-expression-types.ts`, `java-expression-types.test.ts`,
  `java-typing.single-rule.test.ts`. Edit `src/core/adapters/spring/java-library-calls.ts`. Do not touch
  `java-receiver-methods.ts`, `java-function-values.ts` (its imports keep resolving), any port, or `src/core/application`.
- **Steps.**
  1. S0.
  2. Create the owner with the contract above. Move into it, from `java-library-calls.ts`: `receiverOf` (as the body of
     `typeOf`), `writtenType`, `singleImportedType`, `agreed`, `variableOrTypeName`, `declaresFieldAround`,
     `fieldReceiver`, `componentOf`, `declaredField`, `memberAround`, `declarationsOf`, `localScope`, `written`,
     `chainOf`, `declared`, `unqualified`, `candidatesOf`, `environmentOf`, `withMemberVariables`, `receiverFromText`,
     `keyOf`, `parameterTypeAt`, `argumentsOf` and `libraryClassOf`. `declarationsOf` moves unchanged in this unit; U2
     deletes it.
  3. Replace the internal type `Receiver` (`java-library-calls.ts:28`) by the contract's types with this mapping:
     `{ kind: "library", fqn, typeName: false, args }` is `{ kind: "library", fqn, basis: "declared-jdk", args }`;
     `typeName: true` is `{ kind: "type-name", names: { kind: "library", fqn, basis: "declared-jdk" } }`;
     `{ kind: "repository", type }` is the same; each `undefined` becomes `{ kind: "unknown", cause }` with the cause of
     the rule that could not answer (tables T, V, M; a form the moved code does not read is `form-not-read`).
     `variableType` and `isSubtype` are exported and implemented as far as the moved code needs (`isSubtype` with the
     full table: it is new code with no consumer yet, covered by the unit's tests).
  4. In `java-library-calls.ts` keep only `LibraryCallSources`, `libraryParameterClasses`, `libraryClassOf` (re-export
     from the owner) and `classHead`. `libraryParameterClasses` builds the typing with
     `createExpressionTyping({ project: sources.project, libraries: { of: () => sources.signatures }, ancestors: sources.ancestors, above: sources.above })`,
     takes `typeOf(object)`, continues only for a library type or a library `type-name`, and calls the owner's exported
     `libraryCandidates(receiver, name, args, file)` (the moved `candidatesOf`).
  5. Add `java-typing.single-rule.test.ts` in the style of `src/core/adapters/syntax.single-rule.test.ts`: it reads
     every non-test `.ts` file under `src/core/adapters` and asserts each pattern occurs only in its owners or in
     `pending`, and that `pending` holds no file that no longer matches. Rules:

     | Concept | Pattern | Owners | Pending |
     |---|---|---|---|
     | typing an expression by its node kind | `/"cast_expression"\|"ternary_expression"\|"array_access"/` | `spring/java-expression-types.ts` | none |
     | substituting a library member's type variables | `/\bparseTypeText\(/` | `spring/java-expression-types.ts`, `spring/java-library-type-text.ts`, `spring/java-function-values.ts` | none |
     | typing a call's arguments | `/\breadArgumentSignature\b/` | `spring/java-overloads.ts` | `spring/java-symbols.ts`, `spring/java-receiver-methods.ts`, `spring/data-effects.adapter.ts` |
     | typing a method reference's qualifier | `/statedType\(local\)/` | none | `spring/java-receiver-methods.ts` |
- **RED test** (`java-expression-types.test.ts`, test "an expression's type is a repository type, a library type with
  its arguments, or unknown with its cause"). Sources, with `librariesOf()`:

  ```java
  // src/main/java/app/Order.java
  package app;
  public class Order {
    public java.util.List<String> lines() { return null; }
  }
  // src/main/java/app/Use.java
  package app;
  import java.util.List;
  import java.util.Optional;
  class Use {
    List<String> items;
    void run(Order order, Optional<Order> maybe, Object any) {
      order.lines();
      maybe.get();
      ((List<String>) any).stream();
      new java.util.ArrayList<String>();
      missing.call();
    }
  }
  ```

  Assertions (each fails today because the module does not exist):
  - `typeAt(sources, "order", libs)` is `{ kind: "repository", type: "app.Order" }`.
  - `typeAt(sources, "order.lines()", libs)` is
    `{ kind: "library", fqn: "java.util.List", basis: "declared-jdk", args: [{ kind: "library", fqn: "java.lang.String", basis: "declared-jdk" }] }`.
  - `typeAt(sources, "maybe.get()", libs)` is `{ kind: "repository", type: "app.Order" }`.
  - `typeAt(sources, "((List<String>) any).stream()", libs)` is
    `{ kind: "library", fqn: "java.util.stream.Stream", basis: "declared-jdk", args: [{ kind: "library", fqn: "java.lang.String", basis: "declared-jdk" }] }`.
  - `typeAt(sources, "missing", libs)` is `{ kind: "unknown", cause: "name-unbound" }`.
  - `typeAt(sources, "order.lines()")` without libraries is `{ kind: "library", fqn: "java.util.List", basis: "named", args: [{ kind: "library", fqn: "java.lang.String", basis: "named" }] }`.

  Second test, "a value is below a type by the declared hierarchy, and undecided where it is open": with
  `class Base {}`, `class Child extends Base {}`, `class Open extends com.lib.Thing {}`:
  `isSubtype(Child, Base)` is `"yes"`, `isSubtype(Base, Child)` is `"no"`, `isSubtype(Open, Base)` is `"undecided"`,
  `isSubtype(null, Base)` is `"yes"`; `isSubtype(library java.lang.String, Base)` is `"no"` with `librariesOf()` (the
  table holds `java.lang.String` and `java.lang.Object`, its whole closure) and `"undecided"` without signatures.
  Sibling proof: `src/core/adapters/spring/java-library-calls.test.ts` and `java-function-values.test.ts` pass unchanged.
- **Acceptance.** A0. The `Receiver` type and every moved function no longer exist in `java-library-calls.ts`.
- **Corpus gate expectation.** `--expect none`: no row moves.
- **Risk.** `Risk: none` (a move behind an unchanged port; the corpus gate and the existing tests hold the answers).
- **Stop conditions.** X0; a test of `java-library-calls.test.ts` changes its answer.

### U2: variables are resolved by the scoping owner

- **Goal.** A simple name's declaration is the one `variableInScope` answers, and rules V1 to V9 (without V5) type it.
- **Prerequisites.** U1.
- **Files.** Edit `java-expression-types.ts` and its test. Do not touch `java-declared-variables.ts`.
- **Steps.**
  1. S0.
  2. In the owner, replace the body of `variableOrTypeName` up to the field lookup by: `found =
     variableInScope(identifier.text, identifier, { stopAtType: true })`; `{ declaration }` gives
     `variableType(declaration, file)`; `{ unsettled }` gives `{ kind: "unknown", cause: "name-unbound" }`; `undefined`
     continues with the field lookup and the type-name reading as today.
  3. Implement `variableType` by table V1 to V9. For V2, V6 and V7 pass a trail (a `Set` of declaration node ids) down
     `typeOf`; a declaration already on the trail answers `recursive`. V5 answers
     `{ kind: "unknown", cause: "inference-needed" }` until U10.
  4. Delete `declarationsOf`, `localScope`, `written` and the constant `PATTERNS`.
- **RED test** (`java-expression-types.test.ts`, "a local's type is its declaration's, and a var local's its
  initializer's"). `Order` as in U1, and:

  ```java
  // src/main/java/app/Use.java
  package app;
  import java.util.List;
  class Use {
    void run(Order order, List<Order> orders, Object any) {
      var kept = order;
      kept.lines();
      for (Order each : orders) { each.lines(); }
      if (any instanceof Order typed) { typed.lines(); }
      try { any.hashCode(); } catch (IllegalStateException | IllegalArgumentException failed) { failed.getMessage(); }
      var self = self;
    }
  }
  ```

  Assertions: `typeAt(sources, "kept")` is `{ kind: "repository", type: "app.Order" }` (today `{ kind: "unknown",
  cause: "declaration-untyped" }`, the moved code's answer for `var`); `"each"` and `"typed"` are the same repository
  type (`typed` is unknown today: the member-wide scan gives a pattern variable no type); `"failed"` is
  `{ kind: "unknown", cause: "union-type" }`; the initializer `self` of `var self = self` is `{ kind: "unknown",
  cause: "recursive" }`.
  Sibling proof: the test "a variable that any binding form of the grammar declares in the member is never the
  library-typed field of its name" of `java-library-calls.test.ts` passes unchanged, except for the cases the scoping
  owner now decides in scope: for each case that changes, the unit's report quotes it and states the JLS 6.3 scope that
  makes the new answer right; a case that changes from released to vetoed is a stop condition.
- **Acceptance.** A0; `rg -n "declarationsOf" src/core/adapters/spring` finds nothing.
- **Corpus gate expectation.** `--expect trace:± --expect-cuts dispatch:±` only if U0's gate run shows a function-value
  veto among the `dispatch` cuts; otherwise `--expect none`. A new cut is a stop condition.
- **Risk.** `Risk: none` (the function-value proof only releases a veto by positive proof; the scoping owner is the
  stricter reading the receiver bindings already use).
- **Stop conditions.** X0; a function value that was released becomes vetoed.

### U3: the remaining expression forms

- **Goal.** Rules T4 to T23, F1, F2 for repository types, M1 and M2 are in the owner.
- **Prerequisites.** U2.
- **Files.** Edit `java-expression-types.ts` and its test only.
- **Steps.** S0. Add one `case` per row of table T to the `switch` of `typeOf`, in the table's order; implement F1 and
  F2 (repository part) as written; add M1 and M2 ahead of the receiver dispatch of the method-invocation rule; export
  `EXPRESSION_KINDS`. F1 replaces `fieldReceiver`'s restriction to `this.f` and bare names: `a.f` with `a` of a
  repository type is read by the same search.
- **RED test** ("each expression form has one rule"). `Order` as in U1, plus:

  ```java
  // src/main/java/app/Shelf.java
  package app;
  public class Shelf {
    public static final Order FIRST = null;
    public Order top;
    public Order[] all;
  }
  // src/main/java/app/Use.java
  package app;
  class Use {
    void run(Shelf shelf, boolean flag, int count) {
      shelf.top.lines();
      Shelf.FIRST.lines();
      shelf.all[0].lines();
      (flag ? shelf.top : null).lines();
      String text = "a" + count;
      long total = count + 1L;
      shelf.toString().trim();
      new Order().lines();
      new Order() { }.lines();
    }
  }
  ```

  Assertions (`R` = `{ kind: "repository", type: "app.Order" }`): `"shelf.top"`, `"Shelf.FIRST"`, `"shelf.all[0]"` and
  `"(flag ? shelf.top : null)"` are `R`; `"\"a\" + count"` is `{ kind: "library", fqn: "java.lang.String", basis:
  "named" }`; `"count + 1L"` is `{ kind: "primitive", name: "long" }`; `"shelf.toString()"` is the `String` type;
  `"new Order()"` is `{ ...R, exact: true }`; `"new Order() { }"` is `{ kind: "unknown", cause: "form-not-read" }`.
  Each is `{ kind: "unknown", cause: "form-not-read" }` or `member-unsettled` today.
  Sibling proof: every test of U1 and U2 passes unchanged.
- **Acceptance.** A0.
- **Corpus gate expectation.** `--expect none` (the only consumer is the function-value proof; a move of `dispatch`
  is declared as in U2).
- **Risk.** `Risk: none`.
- **Stop conditions.** X0; a node kind of table T does not exist in the installed grammar (report the kind the
  grammar uses instead).

### U4: the receiver reading asks the owner

- **Goal.** Rules R3, R5 and R7: the receiver reading types its receivers and its method-reference qualifiers through
  the owner.
- **Prerequisites.** U3.
- **Files.** Edit `src/core/adapters/spring/java-receiver-methods.ts` (`createResolver`, `receiverOf`,
  `outsideReceiverOf`, `referenceOf`, `receiverMethodOf`, the doc comment of `createJavaReceiverMethods`),
  `java-receiver-methods.test.ts`, `java-typing.single-rule.test.ts`,
  `src/core/domain/snapshot/stored-derived-facts.ts`. Do not touch `src/core/application` or any port.
- **Steps.**
  1. S0.
  2. In `createResolver`, build one typing per resolver:
     `createExpressionTyping({ project, ancestors, above, selected: (invocation, file) => selectedFor(invocation, file) })`
     where `above(type)` is `declaredHierarchy(type).types`, `ancestors(type)` is the same list when
     `unsettledGaps(declaredHierarchy(type))` is empty and `undefined` otherwise, and `selectedFor` calls `methodNamed`
     with a `ReceiverSource` for `file` and returns its answer when it holds `method` or `generated`. `createResolver`
     gains a parameter `sourceOf: (file: JavaFile) => ReceiverSource` for that; its callers pass the `readFile` they
     already have (`receiverBindingsOf` for a file with no kept bindings).
  3. Rewrite `receiverOf` by table R1 to R3: keep the branch for `object === null || object.type === "this"`; keep
     the `method_invocation` branch only for `generatedResult(...)` with `builder: true`; for every other receiver ask
     `typing.typeOf(object, source.file)` and map it as R3 says. The `ReceiverBinding` lookup
     (`source.bindings.get(...)`), `annotationAt` and the type-variable reading in `receiverOf` are deleted: T1, T2 and
     `writtenType` give the same types. `outsideReceiverOf` maps a library answer as R4 says and keeps its existing
     branch for a repository type (`outsideMemberOf`).
  4. R5: thread `exact` from the owner's answer to `methodNamed`; when it is set call `memberOf(..., typeName, false)`
     (not virtual) and return `{ method, bound: false, exact: true }` when the method has a body. In
     `receiverMethodOf` spread `exact: true` into the `method` answer as `bound` is spread today.
  5. R7: in `referenceOf` replace lines 1053-1058 (the local typing of the qualifier) by `typing.typeOf(object, file)`:
     a repository type or `type-name` gives `type`; when `candidates` is empty and the hierarchy is closed, return
     `{ generated: made }` for `generatedOf({ type, typeName: false }, name, 0) ?? generatedOf({ type, typeName: false }, name, 1)`;
     `receiverMethodOf` answers `GENERATED` for it. Remove the pending entry "typing a method reference's qualifier" of
     the single-rule test.
  6. Bump `"java-receiver-sites"` in `stored-derived-facts.ts` by one.
- **RED tests** (`java-receiver-methods.test.ts`).
  1. "a receiver that is a construction, a cast, a parenthesized or a conditional expression names the method its
     type offers":
     - `methodAt([STORE, JDBC, use("new Jdbc().save(\"x\")", [], "")])`: today `{ kind: "unproven" }`; after
       `{ kind: "method", file: JDBC.path, start: 4, nameLine: 4, exact: true }`.
     - `methodAt([STORE, JDBC, use("((Jdbc) store).save(\"x\")")])`: today `{ kind: "unproven" }`; after `method(JDBC, 4)`.
     - `methodAt([STORE, JDBC, use("(store).save(\"x\")")])`: today `{ kind: "unproven" }`; after `method(STORE, 4)`.
     - `methodAt([STORE, JDBC, use("(flag ? jdbc : store).save(\"x\")", [], "Store store, Jdbc jdbc, boolean flag")])`:
       today `{ kind: "unproven" }`; after `method(STORE, 4)`.
     - `methodAt([STORE, JDBC, use("new Jdbc() { }.save(\"x\")", [], "")])`: `{ kind: "unproven" }` before and after.
  2. "a var local names the method of its initializer's type": the existing assertion
     `use("var local = store; local.save(\"x\")")` (`java-receiver-methods.test.ts`, in the first test) changes from
     `{ kind: "unproven" }` to `method(STORE, 4)`.
  3. "a method reference to a member a record adds is generated code": with
     `java("Item.java", ["package app;", "", "public record Item(String slug) {}"])` and
     `use("java.util.function.Function<Item, String> f = Item::slug", [], "")`,
     `methodAt([item, call], "slug", undefined, "Item::slug")`: today `{ kind: "unproven", candidates: [] }`; after
     `{ kind: "generated" }`.
  4. Sibling proof: every other test of the file passes unchanged, in particular "a call on a parameter, a stated
     local or a private field names the method its declared repository type offers", the `outside` tests (lines 81,
     91-92, 163, 812) and "an enum names no method".
- **Acceptance.** A0; `receiverOf` holds no `annotationAt` and no `statedType` call.
- **Corpus gate expectation.** `--expect trace:± --expect callers:± --expect impact:±`, `--expect-cuts
  receiver-unproven:-` and `callee-unknown:-` per U0 classes A, B, C and F, `name-only:-` if U0 found a reverse-family
  place of those classes. A cut that grows or a step that disappears is a stop condition.
- **Risk.** `Risk: item 6 (the receiver reading feeds every family; a typing rule that is too wide would show as a
  wrong step that no unit test names; the corpus gate and the per-form fixtures are the guard)`.
- **Stop conditions.** X0; a test that pins a field through `javaReceiverBindings` changes its answer (report the
  case: the bindings admit fields the owner's rule F1 must match).

### U5: library signatures reach the receiver reading

- **Goal.** `libraries` reaches `createJavaReceiverMethods`; a chain through library calls types its receiver (M4),
  and the kept derivation is keyed by the signatures it read.
- **Prerequisites.** U4.
- **Files.** Edit `java-name-bindings.adapter.ts` (pass `libraries`), `java-receiver-methods.ts`
  (`createJavaReceiverMethods`, `createResolver`), `java-receiver-methods.test.ts`, `stored-derived-facts.ts`.
- **Steps.**
  1. S0.
  2. Add a last parameter `libraries?: LibraryReading` to `createJavaReceiverMethods` and to `createResolver`; pass it
     at `java-name-bindings.adapter.ts` (the `receiverMethods:` line) and into `createExpressionTyping`.
  3. Add `signatures: libraries?.of(path)?.basis.digest ?? ""` to the `subject` object of `keptByReads`
     (`const subject = { path, content, sites: places, ... }`), and
     `libraries: [...new Set(sources.map(({ path }) => libraries?.of(path)?.basis.digest ?? ""))].sort()` to the
     object `layout` is fingerprinted from. Bump `"java-receiver-sites"` by one.
  4. Add the helper `methodWith` to the test file.
- **RED test** ("a chain through library calls names the method of the type the signatures return"):

  ```ts
  const order = java("Order.java", ["package app;", "", "public class Order {", "  public void ship() {}", "}"]);
  const call = use("orders.get(0).ship()", [], "java.util.List<Order> orders");
  assert.deepEqual(await methodWith(librariesOf(), [order, call], "ship"), method(order, 4));   // today { kind: "unproven" }
  assert.deepEqual(await methodAt([order, call], "ship"), { kind: "unproven" });                 // no signatures: unchanged
  const text = use("orders.get(0).toString().trim()", [], "java.util.List<Order> orders");
  assert.deepEqual(await methodWith(librariesOf(), [order, text], "trim"), { kind: "outside", type: "java.lang.String" });   // today { kind: "unproven" }
  ```

  Sibling proof: every `methodAt` test passes unchanged (no signatures declared: the same answers).
- **Acceptance.** A0. A test asserts two reads of one file with two `LibraryReading`s of different digests derive
  twice (use a counting `DerivedFacts` fake as the kept-reads tests of the file do).
- **Corpus gate expectation.** With the manifest declaring `--jdk` on Java `trace` queries: `--expect trace:±
  --expect-cuts receiver-unproven:-`. Otherwise `--expect none` (U0's decision table).
- **Risk.** `Risk: item 1 (the subject of a stored derived fact changes; the slot version is bumped so no stored
  entry is read with the old subject)`.
- **Stop conditions.** X0; an answer changes with no JDK declared.

### U6: library fields in the signatures

- **Goal.** `Type.CONSTANT.m()` on a library type is typed (F2), through an agnostic `fields` member of the port.
- **Prerequisites.** U5.
- **Files.** Edit `src/core/ports/library-signatures.port.ts`, `src/core/adapters/jdk/class-file.ts` and its test,
  `java-library.testing.ts`, `java-expression-types.ts` and its test.
- **Steps.**
  1. S0.
  2. Add `LibraryField` and `LibraryType.fields` as written in "Port changes".
  3. In `class-file.ts`, the field table is skipped whole today (the comment "The field table: a field states no
     member of the declaration", line 186). Read it instead: for each field with `ACC_PUBLIC` or `ACC_PROTECTED`, emit
     `{ name, type, static }` where `type` is rendered from the field's `Signature` attribute when present and from
     its descriptor otherwise, by the same rendering the reader uses for a method's return type. A field the reader
     cannot render makes the whole type `undefined`, as a method it cannot render does.
  4. In `java-library.testing.ts` add to `jdkTypes()`:
     `"java.lang.Boolean": type({ kind: "class", supertypes: ["java.lang.Object"], members: [member("booleanValue", [], "boolean")], fields: [{ name: "TRUE", type: "java.lang.Boolean", static: true }] })`
     (extend the local `type` helper and `TypeShape` with `fields`).
  5. Implement the library part of F2.
- **RED test** (`java-expression-types.test.ts`, "a static field of a library type has the type its signature
  states"): `Use.java` with `void run() { Boolean.TRUE.booleanValue(); }`:
  `typeAt(sources, "Boolean.TRUE", librariesOf())` is `{ kind: "library", fqn: "java.lang.Boolean", basis:
  "declared-jdk" }` (today `{ kind: "unknown", cause: "signatures-absent" }`); without libraries it stays
  `{ kind: "unknown", cause: "signatures-absent" }`. In `class-file.test.ts`: a class file with one public static
  field and one private field yields `fields` with the public one only (build the bytes with the test's existing
  class-file builder).
- **Acceptance.** A0.
- **Corpus gate expectation.** As U5.
- **Risk.** `Risk: item 3 (a port gains an optional member; additive, and every existing implementation and fake
  compiles without it)`.
- **Stop conditions.** X0; the class-file test has no builder that can state a field (report it; do not hand-write
  bytes in the test).

### U7: the pack marks what leaves

- **Goal.** Rules X2 to X6: the receiver reading answers `outside` for static calls, constructions and references of
  library types and for calls inside an anonymous class of one, with `exact`, `noFunctionValue` and `module`.
- **Prerequisites.** U5.
- **Files.** Edit `src/core/ports/import-origins.port.ts` (the `outside` member), `java-receiver-methods.ts`
  (`receiverMethodOf`, `creationOf`, `suppliedReference`, `referenceOf`, `searchedType`, `outsideReceiverOf`,
  `superMethodOf`), `java-symbols.ts` (export `packageOf`), `java-name-bindings.adapter.ts` (import it),
  `java-function-values.ts` (export `functionalMember`), `java-receiver-methods.test.ts`. Do not touch
  `src/core/application`.
- **Steps.**
  1. S0. Change the port as written in "Port changes".
  2. `outsideReceiverOf` returns `{ type, module, noFunctionValue? }` instead of a string, built by X6;
     `receiverMethodOf` spreads it into the answer. `noFunctionValue` needs `libraries?.of(file.path)`; hold the whole
     closure by walking `supertypes` with `classHead` until a type is not held (then no mark).
  3. X2: in `receiverMethodOf`, before the final fallthrough, when the object's `typeOf` is a library `type-name`,
     answer `{ kind: "outside", type: fqn, exact: true, module }`. X3: `creationOf` and `suppliedReference` answer the
     same when `writtenType` is a library type and the creation has no class body. X4 and the non-exact reference: in
     `referenceOf`. X5: in `searchedType`, where the holder is an anonymous class and `unheldSupertypes` answers
     `undefined` today. X1: `superMethodOf` adds `module`.
  4. These answers are given only where `proves` holds, as every other answer of the reading.
- **RED tests** (`java-receiver-methods.test.ts`).
  1. "a static call, a construction and a constructor reference of a type outside the repository are not virtual":
     - `methodAt([use("java.nio.file.Paths.get(\"a\")", [], "")], "get")`: today `{ kind: "unproven" }` (pinned at
       lines 175-177; that assertion changes); after
       `{ kind: "outside", type: "java.nio.file.Paths", exact: true, module: "java.nio.file" }`.
     - `methodAt([use("new java.util.ArrayList<String>()", [], "")], "ArrayList")`: today `{ kind: "unknown" }`; after
       `{ kind: "outside", type: "java.util.ArrayList", exact: true, module: "java.util" }`.
     - the same construction in `class Use extends com.lib.Base` with `import java.util.ArrayList;` and
       `new ArrayList<String>()` (write the class by hand, call on line 4): the same answer; today `{ kind: "unknown" }`.
  2. "a value receiver of a library class proves no function value; one of a functional interface's own method does
     not": with `librariesOf()`,
     `methodWith(libs, [use("maybe.get()", [], "java.util.Optional<String> maybe")], "get")` is
     `{ kind: "outside", type: "java.util.Optional", module: "java.util", noFunctionValue: true }`;
     `methodWith(libs, [use("task.run()", [], "Runnable task")], "run")` is
     `{ kind: "outside", type: "java.lang.Runnable", module: "java.lang" }`;
     `methodWith(libs, [use("items.add(\"x\")", [], "java.util.List<String> items")], "add")` is
     `{ kind: "outside", type: "java.util.List", module: "java.util", noFunctionValue: true }`;
     `methodAt([use("maybe.get()", [], "java.util.Optional<String> maybe")], "get")` (no signatures) is
     `{ kind: "outside", type: "java.util.Optional", module: "java.util" }`. Today each is `{ kind: "outside", type }`.
  3. "a call without a receiver inside an anonymous class of a library type runs the member it inherits": add to
     `jdkTypes()` a member `member("add", ["E"], "boolean")` on `java.util.ArrayList`;
     `use("new java.util.ArrayList<String>() { { add(\"x\"); } }", [], "")` with
     `methodWith(librariesOf(), [...], "add", "add(")`: today `{ kind: "unproven" }`; after
     `{ kind: "outside", type: "java.util.ArrayList", exact: true, module: "java.util" }`; without signatures
     `{ kind: "unproven" }`; with a body that declares `boolean add(String s) { return true; }` the answer stays what
     it is today (assert it equal to the answer read before the change).
  4. Sibling proof: the `outside` tests at lines 81, 91-92, 163 and 812 gain `module` and nothing else; "a receiver
     declared as a platform interface that declares no member is no outside receiver" passes unchanged.
- **Acceptance.** A0. `trace` is unchanged by this unit (it still maps `outside` to `unproven`); the reverse families
  read `exact` as today (`edge-targets.ts`, `settled.dispatch.exact`).
- **Corpus gate expectation.** `--expect callers:± --expect impact:± --expect-cuts name-only:-` if U0 found
  reverse-family places of class G; `trace` byte-identical. Otherwise `--expect none`.
- **Risk.** `Risk: item 3 (a port variant gains optional fields; additive)`.
- **Stop conditions.** X0; a `trace` answer changes.

### U8: trace reads an outside answer

- **Goal.** Rules E1 to E6 in `trace-walk.ts`: an `outside` answer is an external call or a narrowed cut.
- **Prerequisites.** U7.
- **Files.** Edit `src/core/application/trace/trace-walk.ts`, `trace-walk.test.ts`, the `receiverMethods` doc comment
  of `import-origins.port.ts`, `docs/architecture/rfc/0013-trace-and-patterns.md` (add one sentence to R5: "A Java
  receiver the pack answers `outside` for is settled by ADR-0133"). Do not touch any adapter.
- **Steps.**
  1. S0.
  2. Delete `unprovenOutside`; `executed` maps only a `bound` method to `unproven`.
  3. Add, inside `bodyOf` beside `settleByName`, `keptUnder(dispatch, name, from)` exactly as the pseudocode "Name
     closure", and:

     ```ts
     const settleOutside = async (reference: GraphUnresolvedReference, name: string, outside: Extract<ReceiverMethod, { kind: "outside" }>, referenced = false): Promise<void> => {
       const kept = outside.exact === true ? [] : await keptUnder(outsideDispatchOf(outside), name, reference.file);
       if (kept === "open") return void cuts.push(unresolvedAt(reference, membersNamed(name, reference.file)));
       const receiver = receiverOf(reference.name);
       const held = outside.exact !== true && receiver !== undefined && (await holdsFunctionValue(reference, receiver, name));
       if (kept.length > 0 || held || (outside.exact !== true && outside.noFunctionValue !== true)) return void cuts.push(unresolvedAt(reference, kept));
       if (referenced) return;
       const leaf: ExternalCall = outside.module === undefined ? { kind: "unnamed", name: reference.name } : { kind: "import", module: outside.module, name: reference.name };
       await leafUnlessReplaced(leaf, outside.module === undefined ? { path: [], member: name } : { module: outside.module }, () => cuts.push(unresolvedAt(reference, [])));
     };
     ```
  4. Call it at the three places an answer of the receiver reading is consumed, before any other use of the answer:
     in the loop over `references` (the answers of `pendingReferences`), `if (answer?.kind === "outside") { await
     settleOutside(reference, read.kind === "declared" ? read.member : reference.name, answer, true); continue; }`; in
     the loop over `[...called, ...passed]`, when `receiver?.kind === "outside"` and the verdict is `keep` or
     `redirect`, with a reference built from the edge as the `unproven` loop builds one
     (`{ from: node.id, file: node.file, line: edge.line!, column: edge.column!, kind: edge.kind, name: target.name, candidates: [] }`);
     and in the loop over `typed`, when `receiver?.kind === "outside"`.
  5. Import `outsideDispatchOf` from `../navigation/call-binding.ts`.
- **RED test** (`trace-walk.test.ts`, "a call on a receiver proven outside the repository leaves it, unless a
  declaration may run under its type or a function value may be the receiver"), in the style of the file's first
  test. Graph: `fakeNode("run", "method", use, 1, 12)`, `fakeNode("Shelf", "class", shelf, 1, 6)`,
  `fakeNode("Shelf.get", "method", shelf, 4, 4, "get")`, the `contains` edge, and unresolved references of `run`:
  `{ name: "map.get", kind: "calls", line: 3, column: 4 }`, `{ name: "task.run", kind: "calls", line: 4, column: 4 }`,
  `{ name: "Paths.get", kind: "calls", line: 5, column: 4 }`. Fakes: `bindings.bindCalls` answers three `declared`
  bindings (`{ kind: "declared", member, form: "member", call }`); `origins.receiverMethods` answers, in order,
  `{ kind: "outside", type: "java.util.Map", module: "java.util", noFunctionValue: true }`,
  `{ kind: "outside", type: "java.lang.Runnable", module: "java.lang" }`,
  `{ kind: "outside", type: "java.nio.file.Paths", module: "java.nio.file", exact: true }`;
  `bindings.namedDeclarations` answers `[Shelf.get]` for `get` and `[]` otherwise; `bindings.mayRunUnder` answers a
  variable `runs`; `memberDeclarations` answers an empty map; `syntaxOf` answers no function-value call.
  - With `runs = false`: `result.roots[0]!.external` is
    `[{ kind: "import", module: "java.util", name: "map.get" }, { kind: "import", module: "java.nio.file", name: "Paths.get" }]`
    and `result.cuts` holds one cut, at `` `${use}:4 task.run` ``, with no candidate. Today: three cuts and no
    external call.
  - With `runs = true`: the external calls are `[{ kind: "import", module: "java.nio.file", name: "Paths.get" }]` and
    the cuts are at `map.get` (candidates: the anchor of `Shelf.get`) and `task.run`.
  - With `runs = false` and `memberDeclarations` answering `new Map([["get", [shelf]]])` while `syntaxOf(shelf)`
    states two callables named `get` (lines 4 and 9) and the graph places one: `map.get` is a cut listing
    `Shelf.get`.
  Sibling proof: the file's existing tests pass unchanged; `trace-queries.test.ts` passes unchanged.
- **Acceptance.** A0; `rg -n "unprovenOutside" src` finds nothing.
- **Corpus gate expectation.** `--expect trace:± --expect-cuts receiver-unproven:- --expect-cuts callee-unknown:-`
  (U0 classes G, H, I). No step may disappear; an external call may appear only where a cut stood.
- **Risk.** `Risk: item 6 (an external call asserts that nothing of the repository runs; a pack mark that is too wide
  would be a false leaf; the marks are held by U7's fixtures and the name closure by this unit's)`.
- **Stop conditions.** X0; an answer gains an external call at a place that was a step.

### U9: the library closure of outside supertypes

- **Goal.** `mayRunUnder` excludes a declaration whose owner's outside supertypes are held by the signatures and do
  not include the receiver's type (ADR-0079 decision 5, third rule).
- **Prerequisites.** U8.
- **Files.** Edit `import-origins.port.ts` (`OutsideSupertypes`), `java-dispatch-targets.ts`
  (`createJavaOutsideSupertypes`), `java-name-bindings.adapter.ts` (pass `libraries`), `java-kept-reads.ts`
  (`keptByFile`), `src/core/application/navigation/call-binding.ts` (`mayRunUnder`), their tests,
  `stored-derived-facts.ts` if the slot of `outsideSupertypes` is listed there.
- **Steps.**
  1. S0. Change the port as written.
  2. `createJavaOutsideSupertypes` gains `libraries?: LibraryReading`. For a `types` answer, when the signatures of
     the site's file hold every listed type and every type above each (walk `supertypes` with `classHead`), add
     `closure`: the sorted set of all of them. Otherwise add nothing.
  3. `keptByFile` gains an optional `subject?: Readonly<Record<string, string>>` on its `reading` argument, spread
     into the `subject` object it builds; `createJavaOutsideSupertypes` passes
     `{ signatures: libraries?.of(path)?.basis.digest ?? "" }` for the file of the sites.
  4. `mayRunUnder`: replace `found.types.length > 0 || type === found.root` by
     `type === found.root || (found.closure === undefined ? found.types.length > 0 : found.closure.includes(type))`.
- **RED test** (`java-receiver-methods.test.ts`, beside the `outsideSupertypes` tests): a class
  `Shelf implements java.util.function.Supplier<String>` with `public String get() { return null; }`, site
  `{ file, start: 4, name: "get" }`: without signatures `{ kind: "types", types: ["java.util.function.Supplier"], root: "java.lang.Object" }`
  (unchanged); with `librariesOf()` the same plus `closure: ["java.util.function.Supplier"]`. In
  `call-binding.test.ts`: with that answer, `mayRunUnder({ type: "java.util.Map" }, get)` is `false` (today `true`),
  and `mayRunUnder({ type: "java.util.function.Supplier" }, get)` is `true`.
- **Acceptance.** A0.
- **Corpus gate expectation.** `--expect trace:± --expect callers:± --expect impact:±`, `--expect-cuts` per U0 class
  I on queries with `--jdk`; reverse families move only once they receive signatures ("Not covered", last row).
- **Risk.** `Risk: item 3 (a port answer gains an optional field; additive)`.
- **Stop conditions.** X0.

### U10: lambda parameters without a type

- **Goal.** Rule L1.
- **Prerequisites.** U5.
- **Files.** Edit `java-library-type-text.ts` (keep a wildcard's bound), `java-expression-types.ts` and its test,
  `java-receiver-methods.test.ts`.
- **Steps.**
  1. S0.
  2. In `java-library-type-text.ts`, `readType` returns for a wildcard
     `{ kind: "wildcard"; bound?: { variance: "extends" | "super"; type: TypeText } }` instead of the string
     `"wildcard"`; `TypeText["args"]` becomes `readonly (TypeText | Wildcard)[]`. Every existing reader treats the new
     object as it treated `"wildcard"` (`receiverFromText` returns `undefined` for it, `parseTypeText` returns
     `other` for a top-level one).
  3. Implement L1 in `variableType` for V5, as written. The candidate environment is the one M4 builds.
- **RED test** (`java-receiver-methods.test.ts`, "a lambda parameter without a type is typed by the functional
  interface of the library method it is passed to"):

  ```ts
  const order = java("Order.java", ["package app;", "", "public class Order {", "  public void ship() {}", "}"]);
  const each = use("orders.forEach(o -> o.ship())", [], "java.util.List<Order> orders");
  assert.deepEqual(await methodWith(librariesOf(), [order, each], "ship", "o.ship"), method(order, 4));   // today { kind: "unknown" }
  assert.deepEqual(await methodAt([order, each], "ship", undefined, "o.ship"), { kind: "unknown" });       // no signatures
  const stated = use("java.util.function.Consumer<Order> c = o -> o.ship()", [], "");
  assert.deepEqual(await methodWith(librariesOf(), [order, stated], "ship", "o.ship"), method(order, 4));
  const raw = use("orders.forEach(o -> o.ship())", [], "java.util.List orders");
  assert.deepEqual(await methodWith(librariesOf(), [order, raw], "ship", "o.ship"), { kind: "unknown" });
  ```

  The last case stays untyped: a raw `List` gives the receiver no argument, so the `T` of
  `Consumer<? super T>` (`forEach`, declared by `java.lang.Iterable` in the test table) is not settled and the answer
  is `inference-needed`, which the receiver reading turns into `{ kind: "unknown" }` for a name.
- **Acceptance.** A0.
- **Corpus gate expectation.** As U5, `receiver-unproven:-` for U0 class D.
- **Risk.** `Risk: none`.
- **Stop conditions.** X0; a lambda parameter is typed where a candidate's parameter is a type variable.

### U11: the overload owner, asked by the receiver reading

- **Goal.** `selectOverload` exists and replaces `exactCandidate`.
- **Prerequisites.** U4.
- **Files.** Create `src/core/adapters/spring/java-overloads.ts` and `java-overloads.test.ts`. Edit
  `java-receiver-methods.ts` (`selectAmong`, `exactCandidate`, `memberOf`, `repositoryMemberOf`, `constructorOf`),
  `java-receiver-methods.test.ts`, `java-typing.single-rule.test.ts` (remove `java-receiver-methods.ts` from the
  pending list of "typing a call's arguments").
- **Steps.**
  1. S0. Implement `selectOverload` exactly as the pseudocode; the widening table and the box pairs are two constants
     of the module.
  2. In `selectAmong`, replace the `exactCandidate` call and the `sameStatedSignature` test by: `selection =
     selectOverload(reachable, invocation, file, typing)`; `selected` continues with the class-chain choice over
     `selection.methods`; `candidates` returns `{ candidates: selection.methods }`; `none` returns
     `{ candidates: reachable }`. `repositoryMemberOf` and `constructorOf` call it the same way (a constructor: over
     the constructors of the call's arity or of variable arity; `selected` with one method is the answer, anything
     else `"unproven"`).
  3. Delete `exactCandidate`, `isPlainArgument`, `sameStatedSignature`, `statesTypeArguments`, `hasTypeVariables`,
     `PLAIN_PLATFORM_TYPES`. In `memberOf` remove `if (named.some(hasVarargs)) return undefined;` on the closed-hierarchy
     path only.
- **RED tests.** `java-overloads.test.ts` ("an overload is selected by the first phase in which one is certainly
  applicable"), over this fixture and a helper that parses it, finds the invocation on a line and returns
  `[kind, the start lines of methods]`:

  ```java
  // src/main/java/app/Sink.java
  package app;
  public class Sink {
    void put(Object value) {}
    void put(String value) {}
    void put(long value) {}
    void put(Integer value) {}
    void log(String first, Object... rest) {}
    void log(String only) {}
  }
  // src/main/java/app/Use.java
  package app;
  class Use {
    String name;
    void run(Sink sink, int count, Object any, java.util.List<String> names) {
      sink.put(name);
      sink.put(count);
      sink.put(any);
      sink.put(names.get(0));
      sink.log("a");
      sink.log("a", count);
      sink.put(unknown());
    }
  }
  ```

  Expected: `put(name)` selects line 5 in phase 1 (a field of type `String`; today the argument is unread);
  `put(count)` selects line 6 in phase 1 (`int` widens to `long`; `Integer` needs boxing, a later phase);
  `put(any)` selects line 4; `put(names.get(0))` without signatures is `candidates` of lines 4, 5, 6, 7;
  `log("a")` selects line 9 in phase 1; `log("a", count)` selects line 8 in phase 3; `put(unknown())` is `candidates`
  of the four `put`.
  In `java-receiver-methods.test.ts`: a `Sink` receiver with `sink.put(name)` and a field `name` answers
  `method(sink, 5)`; today `{ kind: "unproven", candidates: [...the four places] }`.
  Sibling proof: "a call whose arguments settle one signature names it" and every existing overload test of the file
  pass unchanged (an exact match is phase 1's most specific candidate).
- **Acceptance.** A0.
- **Corpus gate expectation.** `--expect trace:± --expect callers:± --expect impact:± --expect-cuts
  receiver-unproven:-` per U0 class J.
- **Risk.** `Risk: item 6 (a wrong selection is a wrong step; the three-valued rule and the fixtures of each phase
  are the guard)`.
- **Stop conditions.** X0; an existing selection test changes its answer.

### U12: the other overload readers ask the owner

- **Goal.** The data-effect reading, the library-call reading and the call-site owner ask `selectOverload`;
  `readArgumentSignature` is deleted.
- **Prerequisites.** U11.
- **Files.** Edit `src/core/adapters/spring/data-effects.adapter.ts` (lines 86-97), `java-expression-types.ts`
  (`declared`), `java-call-site-owner.ts` (`lenientSelections`), `java-symbols.ts` (delete `readArgumentSignature`,
  `INTEGER_LITERALS`, `unwrapParentheses` if unused), their tests, `java-typing.single-rule.test.ts` (empty the
  pending list).
- **Steps.**
  1. S0.
  2. Data effects: replace the block from `let methods = named.filter(...)` to `methods = matching;` by
     `const selection = selectOverload(named, call.node, call.type.file, typing)` with the resolver's typing
     (`createResolver` exposes it as `typing`); `named.some(hasVarargs)` no longer returns `false` by itself;
     `selected` gives `methods = selection.methods`; `candidates` returns `false` unless `unique` holds as today;
     `none` returns `false`.
  3. `declared` in the owner: after the arity filter, keep the declarations `selectOverload` does not prove
     inapplicable (`selected`: its methods; `candidates`: its methods; `none`: none).
  4. `lenientSelections`: after each arity filter, drop the methods `selectOverload` proves inapplicable, by the same
     reading as step 3, with a typing built over `project` (`ancestors` and `above` from `project.hierarchy`).
- **RED test** (`data-effects.adapter.test.ts`, extend "repository overloads need one proven signature before access
  or body semantics are claimed"): the test's `content` with
  `class Overload { private String code; void run(Repo r) { r.findByCode(code); } }`: `sites[0]!.site.effect?.access`
  is `"read"`; today `undefined` (a field argument is unread). The three existing variants keep their answers.
- **Acceptance.** A0; `rg -n "readArgumentSignature" src` finds nothing.
- **Corpus gate expectation.** `--expect trace:± --expect-cuts effect-unplaced:-` per U0 class L; otherwise
  `--expect none`.
- **Risk.** `Risk: none`.
- **Stop conditions.** X0; a cross-service link of the corpus changes (the call-site owner feeds the request
  readers): report the link.

### U13: enum receivers

- **Goal.** Rule R6.
- **Prerequisites.** U4.
- **Files.** Edit `java-receiver-methods.ts` (`repositoryType` and `runnableAmong` only) and its test. Do not touch
  `staticallyImported` or `unheldSupertypes`: they keep their class-or-interface test.
- **Steps.**
  1. S0.
  2. Add `const isPlainEnum = (type: TypeDecl): boolean => type.node.type === "enum_declaration" &&
     !namedChildren(type.node.childForFieldName("body") ?? type.node).some((constant) => constant.type === "enum_constant" && constant.childForFieldName("body") !== null);`
     (the test `enumConstantSupertypes` already makes for a bodied constant).
  3. `repositoryType`: accept `resolved.type.kind === "class" || resolved.type.kind === "interface" ||
     isPlainEnum(resolved.type)`. In `runnableAmong`, replace `subtype.kind === "other"` by
     `(subtype.kind === "other" && !isPlainEnum(subtype))`.
  4. R3's mapping accepts a plain enum as it accepts a class.
- **RED test.** The existing test "an enum names no method, since a constant may declare its own body" is replaced by
  "an enum whose constants declare no body names its method; one with a bodied constant does not":
  with `kinds = java("Kinds.java", ["package app;", "", "enum Kinds {", "  ONE;", "  void save(String value) {}", "}"])`,
  `methodAt([kinds, use("kinds.save(\"x\")", [], "Kinds kinds")])` is `method(kinds, 5)` (today `{ kind: "unproven" }`);
  with `"  ONE { void save(String value) {} };"` on line 4 it stays `{ kind: "unproven" }`;
  `methodAt([kinds, use("Kinds.ONE.save(\"x\")", [], "")])` is `method(kinds, 5)`.
  Sibling proof: the `outsideSupertypes` tests for an enum owner pass unchanged (an enum still lists `java.lang.Enum`).
- **Acceptance.** A0.
- **Corpus gate expectation.** `--expect trace:± --expect-cuts receiver-unproven:-` per U0 class K.
- **Risk.** `Risk: none`.
- **Stop conditions.** X0.

### U14: measurement for ADR-0073

- **Goal.** Count the cuts that only a signature of a library other than the JDK would settle, and apply the rule
  that schedules ADR-0073.
- **Prerequisites.** U8 and U10 on `main`, and the manifest declaring `--jdk` on its Java `trace` queries.
- **Steps.**
  1. Run the corpus gate on `main` against itself and keep the report.
  2. For each `trace`/java cut of reasons `receiver-unproven` and `callee-unknown`, read the receiver reading's
     answer at its place (a scratch script under one `mktemp -d` directory that calls `createJavaNameBindings(...)
     .receiverMethods` over the corpus sources with the manifest's JDK; never committed). Count the cuts whose answer
     is `outside` with a `type` that does not start with `java.` and no `exact` (N1), and the cuts whose receiver the
     typed-expression owner answers `signatures-absent` for (N2). Count the repository types whose hierarchy is open
     only through a library type that is not under `java.` (N3: ADR-0073 decision 9's probe).
  3. Report N1, N2, N3, and the total of `trace`/java cuts (T).
- **Decision table.**

  | Reading | Action |
  |---|---|
  | N1 + N2 is the largest class of the remaining `trace`/java cuts | Schedule RFC-0033's slice 0 and slice 1 next: ADR-0073 covers them, since a declared classpath is a second `LibrarySignatureSource` and every rule of this RFC that reads `declared-jdk` reads its basis the same way |
  | N1 + N2 is not the largest class and N3 is 0 | Do not schedule ADR-0073; report the largest class instead |
  | Anything else | Report the three numbers to the owner with the two options above; do not decide |
- **RED test.** None. **Acceptance.** The four numbers and the row of the table that applies.
- **Corpus gate expectation.** `--expect none`. **Risk.** `Risk: none`. **Stop conditions.** The scratch script
  needs a source change to run.

## Not covered

| Case | What the engine keeps answering | Why it stays |
|---|---|---|
| Reflection (`Method.invoke`, `Class.forName`), dynamic proxies | `unproven` with `repositoryWide` where a dynamic implementation is named (`provesBinding`); otherwise the call on the reflective API is typed as any library call | Outside the promise (ADR-0029, ADR-0079 residual risk) |
| A library that is not the JDK: a value receiver, a chain link, a lambda parameter, an anonymous class of one | `outside` without `noFunctionValue` (a cut), or `unknown`/`unproven` with cause `signatures-absent` | ADR-0073 is accepted and unbuilt; U14 measures it. It would cover exactly the cuts N1 and N2 of U14 |
| A method's own type variable that no argument fixes, a diamond, a poly expression | `inference-needed` | The compiler's inference is not read (ADR-0132 decision 3) |
| A repository functional interface as a lambda's target | `inference-needed` | `functionalMethodOf` lives in the dispatch reading over the whole hierarchy; a unit that needs it must first move it behind the resolver |
| A multi-catch parameter, conditional arms with a third least upper bound | `union-type` | The least upper bound is not computed |
| `T.super.m()`, `Outer.this.m()`, `outer.new T()` | `unproven` (ADR-0087 decision 4) | Unchanged |
| A lambda or a method reference as an argument of an overloaded call | `undecided`, so the candidates | Potential compatibility (JLS 15.12.2.1) is read only for lambda parameters (L1) |
| Members an annotation processor adds other than the record and Lombok members ADR-0067 and ADR-0068 read | `unproven` | No reader of other processors |
| A receiver typed with a library functional interface whose own method is called (`supplier.get()`) | a cut with no candidate (E4), or RFC-0013 R6's external leaf where no reading answers `outside` | A function value may run; R6's limitation is not changed here |
| A switch expression as a receiver or an argument | `form-not-read` | Its type is the least upper bound of its arms |
| `--jdk` on `callers` and `impact` | They refuse it (`src/cli/main.ts:95`), so rules M4, L1, X5, X6 and U9's closure move only `trace` | ADR-0079 decision 8 and its unit U3 already decide and design it; scheduling it is not part of this RFC. The rules that need no signatures (U4, U7's X2 and X3, U11, U13) move the reverse families |

## Resolved questions

(owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | Where does the owner live, and how is it created? | A new module in `src/core/adapters/spring`, created by moving the library-call typer into it (U1). Discarded: extending `receiverOf` in place (a fifth copy), and a module under `tree-sitter` (it needs `JavaProject`, which `tree-sitter` may not import) |
| 2 | Does "not typed" carry a cause? | Yes, a closed set of ten causes on the `unknown` member. Discarded: `undefined` (the function-value proof's shape today), which lets a consumer read absence as a type and gives the cut ledger nothing to count |
| 3 | Which reader resolves a local variable? | `variableInScope`, the flow-scoped owner. Discarded: keeping the member-wide scan of the library-call typer (a second scoping rule; it is deleted in U2) |
| 4 | May a virtual call on a library **interface** leave the repository? | Yes, under ADR-0133 decision 4's scoped assumption (no library type narrows the interface into a functional one). Discarded: classes only, which would keep every call on a collection interface a cut. This follows the precedent of ADR-0064 (an assumption with its risk stated). **Owner may overturn**: the stricter option is one condition in rule X6 |
| 5 | May a virtual call leave without declared signatures? | No: the type's kind and its single abstract method are not proven, so the call keeps a narrowed cut. Discarded: accepting RFC-0013 R6's documented limitation for these calls too. The standing preference "the engine never guesses" decides it. **Owner may overturn** |
| 6 | Does the receiver reading inherit ADR-0064's assumption? | Yes, through the owner (ADR-0132 decision 5), with ADR-0064's scope unchanged. Discarded: keeping it for the function-value proof only, which leaves constructions and static calls of imported library types inside a class with an outside supertype as cuts. **Owner may overturn** |
| 7 | Is a type outside the platform prefixes, bound by a single-type import, an outside type? | Yes, as `resolve(..., true)` already answers `library` for it and ADR-0079 already answers `outside` with it. Only calls that are not virtual leave on that identity alone (X2, X3); a virtual call needs signatures (question 5). Discarded: requiring a platform prefix (`chainRootOf`'s rule), which keeps every construction of a third-party class a cut |
| 8 | Who computes the name closure? | The core (`trace-walk.ts`), over `mayRunUnder`, `memberDeclarations` and the syntax index it already holds. Discarded: a new index question for "files that declare a method named `m`", which would change the per-file declarations fact while RFC-0040 is rewriting its readers |
| 9 | How does an external call get its module? | The pack states it on the answer (`module`), as `DeclaredType` states `module` for a package type. Discarded: the core splitting a qualified name, which would put a Java naming rule in the core (ADR-0075) |
| 10 | Is `exact` set on a construction's member? | Yes, when the selected member has a body (ADR-0132 decision 8): `trace` then reads no dispatch below it. Discarded: leaving it virtual, which keeps a `dispatch` cut where the run-time class is known |
| 11 | How is an overload selected? | The three phases of JLS 15.12.2 with a three-valued applicability (ADR-0134). Discarded: selecting the only candidate not proven inapplicable (unsound: an undecided candidate may win an earlier phase) |
| 12 | Do the value evaluator and the call-site owner ask the overload owner? | Yes, to drop the declarations proven inapplicable; they keep their lenient reading otherwise (U12). Discarded: leaving their arity filter, which is the second path the acceptance gate forbids |
| 13 | Which ADR holds enum receivers? | ADR-0132 decision 7, since the three numbers of this lane are taken by the owner, external calls and overloads. Discarded: folding overloads into ADR-0132, which would put two decisions with different risks in one record |
| 14 | Does this RFC add cut reasons or sub-reasons? | No. RFC-0042 owns cut causes; the `cause` of an `unknown` type is adapter data that RFC-0042 may surface |
| 15 | Is `--jdk` on `callers` and `impact` part of this RFC? | No: ADR-0079 decision 8 already decides it and its unit U3 designs it. Recommended next after U9, so the reverse families read M4 and the closure. **Owner may overturn** by scheduling it earlier |
| 16 | What does the corpus need for the ledger to move? | `--jdk` on the Java `trace` queries of the manifest (2 declare it today). The manifest is outside the repository and is the lead's to change; U0 reports it and its decision table says what each unit declares meanwhile |
