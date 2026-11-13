# RFC-0032: One owner classifies a snapshot's files, and a veto is released by reading declarations

- Status: Accepted, 2026-11-13. Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados"
  (I approve every pending recommendation; leave them closed); every open question is settled as recommended (see
  Resolved questions). ADR-0072 records its decisions.
- Related: ADR-0013, ADR-0044 (decision 5), ADR-0045 (decision 12), ADR-0062, RFC-0007, RFC-0031, ADR-0072 (the
  decision this RFC designs)

**In short:** one Gradle build script written in Kotlin switches off every Java receiver proof of a repository, because
an adapter keeps its own pattern for "a JVM source nobody reads" and that pattern has no exemption for build scripts.
The defect is one case of a class: several modules classify paths, and a repository-wide veto fires on the presence of
a file, not on what the file declares. This RFC gives the classification one owner in the domain and adds a
declaration-level reader, so a veto falls only on the types a sibling-language file really extends.

## Problem

### The reproduced defect

A scratch repository of three Java classes and a `pom.xml`, traced at `Checkout.pay`, at `main` `db49322d`:

| Snapshot | Status | Cuts |
|---|---|---|
| The three classes | `complete` | none |
| The same, plus `build.gradle.kts` holding `plugins { java }` | `partial` | `unresolved-link`, `receiver-unproven`, no sub-reason, no detail |

The answer is never wrong. It loses a proof the sources support, and the cut does not say why.

### Two owners of one rule

| Module | Rule | Build scripts |
|---|---|---|
| `src/core/domain/languages/uncovered.ts:3-13` | a `.kt`, `.kts`, `.groovy` or `.scala` path is an uncovered source | exempts `*.gradle.kts`, `buildSrc/` and JVM test files |
| `src/core/adapters/spring/java-declared-types.ts:35` | `UNREAD_JVM_SOURCE`, the same four extensions | no exemption |

The adapter's copy feeds every proof of the Java owner: `java-receiver-methods.ts:72,149`,
`java-dispatch-targets.ts:61,94`, `java-call-site-owner.ts:52`, `java-declared-types.ts:52` and
`java-relations.adapter.ts:23,34`.

### The class behind the defect

Path classification is spread over the domain and one adapter:

| Predicate | Place |
|---|---|
| `isUncoveredSource` | `src/core/domain/languages/uncovered.ts:12` |
| `isJvmTestFile` | `src/core/domain/languages/java.ts:10` |
| `isJvmBuildFile` | `src/core/domain/languages/jvm-build.ts:13` |
| `kindOfChangedFile` | `src/core/domain/change/changed-file.ts:11` |
| `isInMapScope` | `src/core/domain/map/entrypoint-map.ts:42` |
| `UNREAD_JVM_SOURCE` | `src/core/adapters/spring/java-declared-types.ts:35` |

And the veto they feed is repository-wide: `provesBinding` (`java-receiver-methods.ts:226`) refuses every binding when
any source is unparsed, any JVM source is unread, or any file names a dynamic implementation.

### Why the veto exists, and what was already tried

The veto on a real Kotlin source is sound. A Kotlin class may extend any Java type, implement any interface, and
declare a type whose simple name hides an on-demand import of the same package. With no reader, the engine cannot tell
which types are touched, so it refuses all.

On 2026-11-08 a narrower veto was evaluated for aspects: decide which join points a pointcut may select. After an
independent review it gave no measured depth and risked false steps, so it was dropped and only the reasons were kept
(`docs/evaluations/trace-quality/2026-11-07-findings.md:214-223`). The lesson holds here: a veto is not narrowed by
estimating what a construct could reach. It is released by reading what the construct declares (ADR-0044 decision 5:
"a veto is released only by positive proof").

## Design

### 1. One classification, owned by the domain

`core/domain/languages` answers one question for every path of a snapshot:

| Class | Meaning |
|---|---|
| `source` of a language | a pack reads it |
| `declared-source` of a language | no pack reads its bodies; a declaration reader reads its types (section 2) |
| `uncovered-source` of a language family | a source no reader reads |
| `build-configuration` | it configures a build and declares no type of the program: `pom.xml`, Gradle scripts in either DSL, build logic, version catalogs |
| `test` | a test of the program |
| `other` | everything else |

Rules:

1. A path has exactly one class. The existing predicates become readings of it, and `UNREAD_JVM_SOURCE` is deleted.
2. No adapter declares a pattern over the paths of a language it does not read. A fitness test holds it, in the
   precedent of `src/core/adapters/syntax.single-rule.test.ts` ("a concept lives only in its owner").
3. A build script is `build-configuration` whatever language it is written in. It keeps its role as the context of the
   pack whose build it states (`LanguagePack.contextFiles`).

Rule 3 alone removes the reproduced defect and every variant of it: Groovy and Kotlin DSL, `settings.gradle.kts`,
build logic.

### 2. A declaration reader for a language without a pack

A new contract beside `LanguagePack`, for a language that shares a type system with a covered one:

```ts
interface DeclarationReader {
  family: string;                       // "jvm"
  reads(path: string): boolean;
  declarations(sources: readonly SourceFile[], signal?: AbortSignal): Promise<DeclaredTypes>;
}

interface DeclaredTypes {
  types: readonly {
    file: string; line: number;
    package: string; name: string;
    supertypes: readonly string[];      // as written, with the imports that resolve them
    members: readonly { name: string; arity: number }[];
  }[];
  unread: readonly string[];            // files the reader could not read: they stay uncovered
}
```

It reads headers, never bodies. It makes no call, no entrypoint and no effect.

The owner of the covered language consumes it:

| Question | Today, with any sibling-language file | With declarations |
|---|---|---|
| Does a simple name resolve to the type the import states? | unproven everywhere | unproven only where a declared type of that name sits in the same package |
| Which declaration does `x.m()` name, for `x` of repository type `T`? | unproven everywhere | unproven only where a declared type sits in the hierarchy above `T` and its members do not settle the signature |
| Is the set of bodies below `T` closed? | unknown everywhere | unknown only where a declared type sits at or below `T` |
| Is the set closed for a functional interface? | unknown everywhere | still unknown: a function value of the sibling language may implement it, and bodies are not read |
| Who calls a Java method? | `no-extractor` cut | unchanged: calls written in the sibling language are still unread |

A file in `unread` keeps today's repository-wide veto. Nothing is guessed.

### 3. An unparsed source keeps its veto

A Java file the grammar cannot parse may hide an anonymous class in the unread region, and an anonymous class can
implement any type. No reading of the rest of the file proves otherwise. The veto stays repository-wide. The remedy is
the grammar's currency, and the ledger row that counts it (RFC-0031).

### 4. The cut says what vetoed

Today the cut of the reproduced case carries no sub-reason. Under RFC-0034 a cut names the places of its cause. This
RFC supplies two causes to its closed set: `unread-source` and `unparsed-source`, each with the files that caused it.

## What enters, and under which rule

The declaration reader is a contract, not a language. A first reader enters under ADR-0013: a grammar, fixtures that
fail first, measured applications and the ledger rows it moves. This RFC does not choose the language.

## Migration

| Step | Change | Gate expectation |
|---|---|---|
| 1 | The classification and its fitness test; `UNREAD_JVM_SOURCE` deleted | `trace:+`, `callers:±`, `impact:±` on repositories with build scripts in a JVM language; none elsewhere |
| 2 | The cut causes | additive detail, no status change |
| 3 | The `DeclarationReader` contract and its consumption by the Java owner, with a fake reader in tests | none: no reader is registered |
| 4 | A first reader, under ADR-0013 | the rows RFC-0031 names for it |

## Rejected

| Option | Why |
|---|---|
| Exempt `*.gradle.kts` inside the adapter's pattern | A second copy of the rule, corrected once; the next predicate drifts again |
| Scope the veto by estimating what an unread file could touch | The path dropped on 2026-11-08 for aspects: no measured gain, risk of false steps |
| Read the declarations outside the syntax error of an unparsed file | An anonymous class in the unread region can implement any type |
| A full pack for a sibling language | The largest cost for the rows this RFC targets; it stays available under ADR-0013 |

## Resolved questions (owner, 2026-11-13: "apruebo todas las recomendaciones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | Which sibling language gets the first declaration reader? | Whichever the baseline ledger shows vetoing the most answers. Do not choose before it exists |
| 2 | Does a declared type's member list need parameter types, or only arity? | Arity first. It settles the cases where no member of that name and arity exists above `T`. Parameter types enter when the ledger shows overloads left unproven for that reason |
| 3 | Is build logic (`buildSrc/`, included builds) `build-configuration`? | Yes, as `uncovered.ts` already decides. It compiles into the build, not into the program |
