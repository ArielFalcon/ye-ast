# RFC-0033: A classpath the host declares as the library signature source

- Status: Accepted, 2026-11-13. Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados"
  (I approve every pending recommendation; leave them closed); every open question is settled as recommended (see
  Resolved questions). ADR-0073 records its decisions.
- Related: ADR-0010, ADR-0013, ADR-0019, ADR-0035, ADR-0037, ADR-0044 (decisions 1, 5, 6, 10), ADR-0062, ADR-0063,
  ADR-0064, ADR-0067, ADR-0068, ADR-0070, RFC-0031, ADR-0073 (the decision this RFC designs)

**In short:** the engine knows the signatures of the JDK a host declares and of two closed vocabularies. Every other
library type is a name. A repository class that extends a library class has an open hierarchy, so calls on it are
`unproven`. This RFC extends ADR-0063 from the JDK to the jars a host declares: read as data with the class-file
decoder that already exists, never loaded, never discovered. Without a declared classpath every answer stays
byte-identical to today's.

## Problem

| Fact | Evidence |
|---|---|
| The one library signature source is a declared JDK | `src/core/ports/library-signatures.port.ts:26-31` (`basis: "declared-jdk"`), `src/core/adapters/jdk/jdk-library.adapter.ts` |
| Other libraries are recognized by a list of package prefixes | `src/core/adapters/spring/java-symbols.ts:177` |
| A supertype the sources do not declare leaves the members of the hierarchy unsettled | `hierarchyOpen`, `src/core/adapters/spring/java-receiver-methods.ts:242-245` |
| Two closed vocabularies settle what a signature source would otherwise settle | ADR-0070 (Spring Data repository types), ADR-0067 and ADR-0068 (Lombok) |
| A probe on 2026-11-11 measured it directly: a repository type whose parent is a library type answers `unproven` for the owner of a call | recorded with the ADR-0044 V0b2 prerequisite; the classpath was proposed then and waited for this decision |
| On one corpus backend the domain models extend library base classes, and that open hierarchy is the first cause of its `receiver-unproven` cuts | measured on 2026-11-13 during the trace coverage work |

Each closed vocabulary is correct and bounded to one library. The mechanism they stand in for is general: a library
type has members and supertypes, and a jar states them.

## Design

### 1. The input

`--classpath [<at>=]<path>`, repeatable, on every command that binds calls (resolved question 1), and in the MCP
registration `ye-ast init` prints.

| Rule | Detail |
|---|---|
| What `<path>` is | a jar, or a directory read recursively for `*.jar` |
| What `<at>` is | the repository directory whose Java sources the jars serve; the root when absent. The longest `<at>` that contains a path wins, as for `--jdk` (`LibraryReading.of`) |
| Order | none. A qualified name that two declared jars define with different bytes is unsettled, as if no jar held it |
| Discovery | none. ye-ast never looks in a build tool's cache or a home directory. The host names the path |
| Trust | a host input in both trust modes, like `--jdk` (ADR-0063 decision 8). Allowed with `--live` |

A host gets the jars from its own build: a dependency cache or the output of a dependency-copy step it ran itself.
ye-ast runs no build tool.

### 2. Reading

- A jar is a zip of class files. `src/core/adapters/jdk/jdk-archive.adapter.ts` already reads an archive as data,
  confined to the host path, and `src/core/adapters/jdk/class-file.ts` already decodes a class file into
  `LibraryType`. Both are generalized, not copied.
- The index is lazy: the central directory names the types, and a type is decoded on demand and memoized (ADR-0063
  decision 6).
- Only public and protected declarations are read, as today. No code attribute is read. Nothing is loaded or run.
- A jar nested in another jar is not read in the first slice (resolved question 3).

### 3. Identity and verification

| Element | Rule |
|---|---|
| Identity | the SHA-256 of each jar a fact read |
| In the answer | `inputs.buildOutputs` gains the kind `classpath`, with `at`, `digest` and `verified` |
| `verified` | true when the jar's own coordinates (`META-INF/maven/**/pom.properties`) equal a literal group, artifact and version a build file under `<at>` states. Otherwise false |
| Unverified jars | used and marked, as a declared JDK is today (ADR-0063 decision 2). A digest is recorded; it is not a gate |
| Unusable | a path that cannot be read, or holds no jar, is a `build-output` cut, never a silent absence (ADR-0037) |

### 4. What the signatures change

`LibrarySignatureSource` becomes a composition: the declared JDK, then the declared classpath. `LibraryBasis.basis`
gains `declared-classpath`.

| Reader | With a classpath |
|---|---|
| Hierarchy above a repository type | a supertype the classpath holds is read: its members and its own supertypes, transitively. The hierarchy is open only where a supertype is held by no source, no JDK and no jar |
| `receiverMethods` | selects among repository and library members by the rule of ADR-0044 decision 1. A call bound to a library member is an external leaf (ADR-0019), not a cut |
| `dispatchTargets` | unchanged for a repository type, except that a library class naming a repository type as its supertype keeps the closure unknown |
| Function-value veto (ADR-0044 decision 5) | an invocation context whose candidates are library declarations is settled from their parameter types |
| Type identity | "is this type the framework's `Repository`?" is answered by the qualified name the jar states, where today a prefix list and an import reading answer it |

### 5. What the signatures do not change

1. A library type never becomes a repository declaration. It is not a graph node, a step, a seed or a candidate. Its
   origin stays "library". This keeps the platform and repository classification the 2026-11-11 probe showed at risk.
2. Framework meaning stays with the framework. A jar says `save` exists on a type; the plugin says what `save` does to
   data (ADR-0070, RFC-0035).
3. Generated members stay with their readers. A jar holds no member an annotation processor adds to repository
   sources (ADR-0067, ADR-0068).
4. Without a declared classpath, every reader answers as today: the vocabularies, the prefix list and ADR-0062's
   assumptions remain the reading. The gate proves it with `--expect none`.

### 6. Retention

The decoded index of a jar is a derived fact keyed by the jar's digest (ADR-0035). It is retained across snapshots
and, under RFC-0037, across processes.

## TypeScript

Nothing is added. ADR-0037 already covers a declared `node_modules`. The agent evaluation of 2026-11-08 measured no
difference from declaring it (10.7% against 12.0% of TypeScript needs), so extending the checker to the live tree has
no evidence behind it and is not proposed.

## Slices

| # | Slice | Proof |
|---|---|---|
| 0 | A probe outside `main`: read the jars of the corpus backends and count the open hierarchies they would close, with the cost of the index | the ledger rows of RFC-0031 before and after; the decision to continue |
| 1 | The archive reader and decoder accept a jar; conformance fixtures over hand-written class bytes | fixtures fail first |
| 2 | The composed `LibrarySignatureSource`, the input, the build-output entry and its cuts | gate `--expect none` with no classpath declared |
| 3 | The hierarchy and `receiverMethods` read library supertypes | gate with the classpath declared: `trace:+`, `callers:±`, `impact:±` |
| 4 | Type identity by qualified name; the vocabularies keep meaning only | gate `--expect none` without a classpath; parity with one declared |

## Rejected

| Option | Why |
|---|---|
| More closed vocabularies, one per library | Each is correct and none is general; the list grows with every corpus application |
| Run a build tool or a compiler to resolve types | It runs repository code or needs a JVM; ADR-0010 forbids the first |
| Discover jars in the user's dependency cache | The answer would depend on the machine's state, not on declared inputs |
| An indexer that needs a build (SCIP) | Evaluated before and rejected under `untrusted` for the same reason |
| An ordered classpath | Order exists to break ties between duplicate classes; refusing the tie is simpler and never wrong |

## Resolved questions (owner, 2026-11-13: "apruebo todas las recomendaciones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | Which commands accept `--classpath`? | Every command whose family reads `receiverMethods`: `trace`, `callers`, `impact`, `contract-consequences`, `workspace`, `decisions`, and `mcp`, `init`. ADR-0041 gives one binding chain to every family; a family that ignored the input would bind the same call differently |
| 2 | Does an unverified jar lower the answer's status? | No. It is recorded as unverified, like a declared JDK. A version mismatch the build files prove (a literal version that differs) is a `build-output` cut and the jar is not used |
| 3 | Are nested jars read? | Not in the first slice. A host declares the extracted directory. Revisit with a measured case |
| 4 | Does slice 0 gate the rest? | Yes. If the probe shows the open hierarchies are mostly closed already by ADR-0067 to ADR-0070, the program stops here and the vocabularies stay |
