# ADR-0073: A classpath the host declares is a library signature source

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados" (I approve
  every pending recommendation; leave them closed), after "estas propuestas de correccion y mejoras deben ser de forma
  transversal y no parches puntuales" (the corrections and improvements must be cross-cutting, not point patches). A
  classpath input was first proposed on 2026-11-11 and left for the owner's architecture decision.
- Related: RFC-0033 (design), ADR-0010, ADR-0037, ADR-0044, ADR-0062, ADR-0063, ADR-0070
- Extends: ADR-0063 (the JDK stays a source; the classpath joins it)

**In short:** a host may declare jars, and ye-ast reads their class files as data to learn the members and supertypes
of library types. A hierarchy that ends in a declared library type is no longer open. Nothing is run, loaded or
discovered, and with no classpath declared every answer is unchanged.

## Context

The engine reads library signatures from one source, a declared JDK (ADR-0063). Every other library type is known by a
package prefix (`src/core/adapters/spring/java-symbols.ts:177`) or by a closed vocabulary (ADR-0067, ADR-0068,
ADR-0070). A repository type whose supertype is any other library type has an open hierarchy
(`src/core/adapters/spring/java-receiver-methods.ts:242-245`) and its calls answer `unproven`.

| Option | Verdict |
|---|---|
| One closed vocabulary per library | Rejected as the general mechanism: correct, and unbounded in number |
| A compiler or a build tool | Rejected: runs repository code or adds a JVM |
| Jars the host declares, read with the existing class-file decoder | Chosen |

## Decision

1. `--classpath [<at>=]<path>` declares a jar or a directory of jars for the Java sources under `<at>`. The path is a
   host input in both trust modes, allowed with `--live`, and never discovered. Every command whose family reads
   `receiverMethods` accepts it (`trace`, `callers`, `impact`, `contract-consequences`, `workspace`, `decisions`), and
   so do `mcp` and `init`: one binding chain must not bind the same call differently per family (ADR-0041).
2. Jars are read as data through the confined archive reader and the class-file decoder of `core/adapters/jdk`,
   generalized. Only public and protected declarations are read. No class is loaded and no code runs.
3. The classpath has no order. A qualified name two jars define with different bytes is unsettled. A jar nested in
   another jar is not read; a host declares the extracted directory.
4. Each jar a fact read appears in `inputs.buildOutputs` with the kind `classpath`, its digest and whether the
   snapshot's build files verify its coordinates. An unusable declaration is a `build-output` cut. An unverified jar
   is used and marked, and lowers no status; a jar whose version a build file contradicts with a literal is a
   `build-output` cut and is not used.
5. `LibrarySignatureSource` composes the declared JDK and the declared classpath. A supertype it holds is read, and
   the hierarchy above a repository type is open only where no source, JDK or jar holds a supertype.
6. A library type never becomes a repository declaration, a step, a seed or a candidate.
7. Framework meaning and generated members keep their owners (ADR-0067, ADR-0068, ADR-0070).
8. With no classpath declared, every answer is byte-identical to today's. The corpus gate holds it.
9. The work starts with a probe that measures, on the corpus, how many open hierarchies the jars would close. A probe
   that shows no gain stops the program.

## Consequences

- A pipeline job that already resolved its dependencies passes one flag and gets closed hierarchies.
- A new build-output kind and one new basis value; additive, no schema version change.
- A host that declares nothing loses nothing and gains nothing.

## Not decided here

- Reading nested jars, until a measured case asks for it.
- Any change for TypeScript: ADR-0037 stands, and the 2026-11-08 evaluation measured no gain from a declared
  `node_modules`.
