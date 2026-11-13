# ADR-0063: A JDK the host declares is the library signature source

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13 (D2), choosing among the ways to supply the library signatures that ADR-0044 decision 10 needs: "JDK local declarado (Recomendado)". Translated: a declared local JDK (the recommended option). The need behind it is the owner's standing rule that backend-to-backend relations must resolve correctly, which a hexagonal port with one implementation cannot do while the function-value veto of ADR-0044 decision 5 holds.
- Amends: [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md) decision 10 and its redistribution risk; [ADR-0037](0037-host-declared-build-outputs.md) decisions 1, 5 and 9
- Related: [ADR-0007](0007-dependency-versions.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md), [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md)

**In short:** the library signatures come from the JDK the user already has and declares with `--jdk [<at>=]<path>`, read as data from `lib/ct.sym` and `release`, at the JDK's own feature release, with no digest pin and no shipped table. It is a build output (ADR-0037): recorded in `inputs.buildOutputs` as unverified, and a cut when unusable. The proof of ADR-0044 decision 5 is its one consumer.

## Context

ADR-0044 decision 10 made the library signature source a table generated from one pinned `ct.sym` and either shipped or
generated at install time, and left redistribution of the table open (its "Redistribution of the table" risk). The work
that followed measured the consequences:

- The pin accepted two 23.0.1 builds and a table of release 23 only. A real backend declares `java.version` 25, and the
  user's machine holds other JDKs, so the pin refused exactly the JDK a user would declare.
- Generating the whole table decoded 4 848 types and serialized them, while opening the archive and listing its 20 411
  names took 33 ms and decoding `Stream`, `Optional` and `Objects` took 3 ms: nothing needs a table.
- The generator assumed the layout of JDK 12 and later (a module directory under the release set) and hard-coded the
  letter of release 23. A `ct.sym` of JDK 11 has no module directory; release sets are letters (`8`, `9`, `A` for 10,
  and so on, concatenated for shared directories).
- The Temurin 25 `ct.sym` holds release 25 (letter `P`) in the layout `OP/java.base/java/util/stream/Stream.sig`.
- A parent POM outside the snapshot leaves the release unsettled under decision 10 as written, which would keep the veto
  on the repository that motivated this work (its parent coordinates resolve to a corporate artifact, not to a path).
- The CLI had a parallel `--jdk <path>` channel (`jdkPath`) that reached no query, left no trace in `inputs` and could
  not be cut.

## Decision

1. **The source is a JDK the host declares.** ADR-0044 decision 10's "what it is" is replaced: the library
   declarations are read from `<home>/lib/ct.sym` and `<home>/release` of a JDK the host names, through the confined,
   link-refusing archive reader. No table is generated, serialized, committed or shipped. Only `java.*` types are held;
   any other name has no signatures and stays unsettled. The class-file decoder and its fault rules stand.
2. **No digest pin.** The SHA-256 of `ct.sym` is the identity recorded in the answer, not a gate. A JDK of any vendor
   and version is accepted; a wrong or edited archive is a wrong proof, which is why the declaration is stated
   unverified (decision 7) and the digest is recorded.
3. **The release is the JDK's own feature release F**, read from `JAVA_VERSION` of `release` (`1.8.x` is 8, `23.0.1`
   is 23). Rule B replaces the per-source selection of decision 10 for this unit: the table of F is used for every
   source of the declaration's `at`. A newer table only adds candidates, and a library parameter is either a library
   class (never a repository interface) or a bare type variable (unsettled), so the proof does not turn on which release
   the build used. The residual is a member removed between the build's release and F. A stated limit of rule B: a `java.*`
   type added after the build's release can bind a simple name that the code means from another on-demand package,
   since only `java.*` types are held and the table of F then offers the one.
4. **Upper-bound refusal.** If a build file in the snapshot, under the declaration's `at`, states a literal release
   greater than F, the declaration is unusable for that snapshot and the answer carries a `build-output` cut with the
   reason `jdk-older-than-build`, because an older table lacks real candidates. The literals read are `<release>`,
   `maven.compiler.release`, `maven.compiler.source`, `maven.compiler.target`, `java.version`, `sourceCompatibility`,
   `languageVersion` and `options.release`, as a text scan, not a resolution.
5. **An unsettled release uses F.** Where the build's release cannot be settled (a parent outside the snapshot, a
   non-literal value), the declaration still serves at F, with `verified: false`. This amends decision 10's clause that
   an unsettled release keeps the veto: the user's declaration of the JDK stands in for the missing evidence, as an
   unlocked `node_modules` does in ADR-0037 decision 5. Exact per-source release selection (the Maven parent chain and
   the Gradle rules of decision 10, fixtures 20, 25 and 26) is deferred to a precision unit, to be built when a measured
   case shows the release matters.
6. **A lazy index.** The name index is built from the central directory only, decoding a type on demand, memoized per
   (archive digest, F), never per path. Both layouts are read (the second path segment containing a dot is a module
   directory). A release-set directory contains F by its letters. Zero or two entries for (type, F) mean the type is not
   held: `typeOf` answers `undefined`, and a caller treats it as unsettled.
7. **It is a build output (ADR-0037).**
   - Decision 1 is amended: the closed union of kinds gains `jdk`, with `at` the repository directory the JDK compiles
     (`""` for the whole repository) and the declaration syntax `[<at>=]<path>`, `=<path>` for a path holding `=`. The
     CLI flag is the repeatable `--jdk` of `trace`, `mcp` and `init` (which prints it into the registration); the
     query-protocol kind is `jdk` with an absolute path. `callers`, `impact`, `importers`, `outline`, `workspace`,
     `decisions` and `contract-consequences` refuse it as a usage error, since none of them opens a typed reading. It is allowed with
     `--live`: it costs milliseconds and is keyed by content, unlike a `node_modules` check.
   - Decision 5 is amended: a JDK has no lockfile analogue, so every answer that used one states it `verified: false`,
     with `digest` the `ct.sym` SHA-256 and `jdk: { vendor?, version, feature, basis: "declared-jdk" }` (the feature release is the release of the signatures).
   - Decision 9 is amended: the reasons `jdk-unreadable` (missing, a link, not an archive of the supported kind, or a
     JDK 8 home, which has no release-set `ct.sym`), `jdk-older-than-build` (decision 4) and `release-not-held` (the
     table of F is absent from the archive) name a `build-output` cut. Without a declaration every answer is
     byte-identical to the answer before this decision.
8. **Trust.** The path is a host input, not repository content, in both trust modes. Only the two files are read, as
   regular files; nothing is run. A home inside the checkout is allowed (ADR-0037 decision 4).
9. **The port is declared by the consumer** (`core/ports/library-signatures.port.ts`: the types, `LibrarySignatures`
   with a `typeOf`, and a source that opens a declaration). The pin, the generator, the serializer, the eager table and
   the `jdkPath` side channel are removed.

## Consequences

- ADR-0044's "Redistribution of the table" risk is resolved: ye-ast ships no JDK-derived bytes. At run time it reads the
  user's own JDK, and its tests use hand-written class bytes.
- ADR-0044's fixtures 20, 25 and 26 and the Maven and Gradle release resolution move to a deferred precision unit.
- The release basis is the JDK's, not the build's: a snapshot whose parent sits outside it and states a smaller release
  than F is served at F. That is sound for the proof (decision 3) and is recorded as unverified.
- The signatures reach the Java pack as the trailing `libraries` argument of the origins reader (by path, so each `at`
  keeps its own JDK), and the dispatch reader's function-value proof is the only consumer (ADR-0044 decision 5, V1b). The
  held Java project is not read through them, so its identity is unchanged and a reading with a JDK never reuses an answer
  of one without. A snapshot that declares none answers as before; one that declares a JDK may follow a one-implementation
  port the veto cut, which is the change the corpus gate reports.
- The proof inherits the strict reading's limits except one: a supertype outside the repository is assumed not to redefine
  a name that resolves to a `java.*` type (ADR-0064). Names the repository declares stay unsettled below such a supertype.

## Not decided here

- Exact per-source release selection (Maven chain, Gradle precedence) and the build-file basis it would record.
- A cut detail naming the missing input when a veto only a library signature would settle holds.
- A reader for `lib/modules` or `jmods`, for a JDK whose own release is absent from its `ct.sym` (measured on a JDK 11
  home, not on 17 or 21).
