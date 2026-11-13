# ADR-0064: A supertype outside the repository redefines no name that resolves to a java.* type

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13 (D3), choosing how the library-call proof of ADR-0044 decision 5 treats the supertypes the snapshot does not hold: "Assume, scoped (Recommended)". Translated: assume it, with the scope stated (the recommended option). The need behind it is the standing rule that backend-to-backend relations must resolve correctly (ADR-0062).
- Decision source, amendment: Owner, 2026-11-13 (D4), extending the assumption to the names a file binds through a single-type import: "Extend to explicit imports (Recommended)". Translated: extend it to explicit imports (the recommended option).
- Related: [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md) decision 5, [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md), [ADR-0063](0063-a-jdk-the-host-declares-is-the-library-signature-source.md)
- Amended by: [ADR-0070](0070-a-spring-data-repository-call-is-a-proxy-supplied-member-and-a-vocabulary-name-an-on-demand-import-leaves-unsettled-is-read-from-its-package.md) (a closed-vocabulary name an on-demand import leaves unsettled is read from its package)

**In short:** where a Java file's simple name is bound by a single-type import, or resolves to a `java.*` type by an on-demand import or `java.lang`, a supertype outside the repository is assumed to declare no member type of that name and no field of that name. The assumption serves only the library-call proof of ADR-0044 decision 5, and only for names the declared JDK holds or a single-type import binds.

## Context

The strict reading of a simple name leaves it unsettled when a class has a supertype the snapshot does not declare, because that supertype may declare a member type of the name (JLS 6.4.1, 8.5) or, for a name used as a receiver, a field of it (JLS 6.4.2). A measured backend (ADR-0013 evidence: the repository that motivated ADR-0062 and ADR-0063) has domain services extending a base class of the company's own library. Of the 14 function values its declared JDK left unsettled, 13 were unsettled only for that reason: `List`, `Objects` and `Stream` imported from `java.util` in a class below that base.

## Decision

1. **The assumption.** For a simple name that no declaration of the repository binds and that resolves to a `java.*` type the declared JDK holds, by a single-type import, by exactly one on-demand package or `java.lang` (ADR-0062 decision 1), a supertype outside the repository is assumed to declare no member type of that name and no inherited field of that name.
2. **Single-type imports (D4).** A name the file binds through a single-type import (`import a.b.C;`) is assumed not to be redefined by a supertype outside the repository, whether the import names a type of the repository or not: no member type and no inherited field of that name. The proof then reads the repository type the import names.
3. **The scope is exact.**
   - It never covers a name bound otherwise that the repository declares: a member or local type, a type of the file's package or of a package an on-demand import names, a static import, a conflicting import. These keep the strict reading, so a class with an outside supertype keeps them unsettled. An on-demand import of a non-java package and a same-package reference are among them.
   - It never covers a name that resolves to a non-java type, or to a `java.*` type the JDK does not hold.
   - A field the repository declares, in the type, around it or above it among the repository types, still obscures a type name used as a receiver. Fields of supertypes outside the repository are the only ones assumed away.
   - A variable (a lowercase name, a field a class inherits) is not a name this assumption covers: a receiver that only an outside supertype could declare stays unsettled.
4. **Only the proof reads it.** The strict resolver, `declaredTypes`, receiver methods and every other reader keep their answers. The reading is one method of the project (`importedTypeSources`) that the library-call proof alone calls.
5. **The risk, stated.** A company base class that declares a nested type or a field named like a `java.*` type the subclass also imports would bind the name to its own, and a function value passed to it could be mis-settled. Such a declaration hides the import the author wrote, so the code would not behave as its author reads it.

## Consequences

- A class below an outside base class keeps its library-typed parameters, fields and type-name receivers settled; the repository's own names below it stay unsettled.
- A false release needs a base class that shadows a name the subclass imports by a single-type import (a `java.*` type or a type of the repository). Revisit the assumption on a measured case.
