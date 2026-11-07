# ADR-0029: The TypeScript compiler's binder is the one source of lexical bindings

- Status: Accepted, 2026-11-06, owner
- Decision source: the owner, 2026-11-06: "Apruebo" (I approve), on the design reported after the binder probe: one
  shared TypeScript binding resolver in `core/adapters/typescript`, used by both `rootOrigins` and the function-value
  reader, replacing both hand-written scopings. Amended 2026-11-06 by the owner's "Acepto" (I accept) on trace slice 2:
  a declared external type counts as a proof, with two guards and its limitation written here; the third and fourth
  consumers and the names in type positions follow from it (decisions 6 to 9).
- Related: [ADR-0008](0008-typescript-compiler-api-source.md),
  [ADR-0018](0018-type-information-as-a-fact-input.md), [ADR-0019](0019-cuts-retired-on-a-proven-external-target.md),
  [RFC-0010](../rfc/0010-impact-queries.md), [RFC-0013](../rfc/0013-trace-and-patterns.md)

**In short:** which declaration a TypeScript or JavaScript name binds is read from the compiler's own binder, through a
program over that one file with no library, no module resolution, no `tsconfig` and no `node_modules`. It replaces the
two hand-written scope walkers, so the import origins and the function-value calls answer from one implementation of
the language's scoping. The resolver asks for symbols, never for a type.

## Context

Two modules answered the same question with their own walk over the tree: the proof that a bare root is a parameter of
the function around it (`rootOrigins`, `local-parameter`) and the binding of a function-value receiver. Each review found
a variant one of them missed: a parameter beside one with a default value, a parameter captured by a closure, a `var`
declared twice, a function declared in a block. JavaScript scoping has more variants than either walk modelled.

A probe built one `ts.createProgram` per file with a host that serves only that file (`noLib`, `noResolve`,
`types: []`, `allowJs`) and asked `checker.getSymbolAtLocation` for each case. Every case matched the language: hoisted
`var` across blocks and never across a function, static block or namespace; block-scoped `let`, `const`, `class` and
function declarations in strict code; a switch's case block; catch variables; parameters, default-valued, destructured
and captured; a function expression's own name; a redeclared `var` as one symbol with every declaration; an import as an
alias at its import declaration; a global or an undeclared name as no binding. A shorthand property and an export
specifier each need their own lookup. Inside `with` the binder answers no binding; the name is dynamic there.

Measured on five repositories (3,338 files) while the machine was loaded:

| Measure, per file | Median | p95 |
|---|---|---|
| Parse alone | 0.11 to 0.37 ms | 0.38 to 5.9 ms |
| Bind a parsed file (program and checker) | 0.45 to 1.5 ms | 1.3 to 5.2 ms |
| Resolve every name in a lexical position | 0.06 to 0.16 ms | 0.28 to 5.7 ms |
| Heap held while a bound file is alive | 300 to 600 KiB | |

Resolving a property name instead pulls in type checking: one file took 2.7 s. `ADR-0018` measured 2 to 3.4 times the
latency and 2 to 3.6 times the memory for a program with the library and dependency types; none of that is loaded here.

## Decision

1. The binding of a name in a TypeScript or JavaScript source comes from the compiler's binder, through one program per
   file over that file alone: `noLib`, `noResolve`, `types: []`, `allowJs`, no `tsconfig`, no `node_modules`, no other
   file. Nothing in the repository configures it.
2. One resolver in `core/adapters/typescript/` owns it. It asks only `getSymbolAtLocation` on names in lexical
   positions, `getShorthandAssignmentValueSymbol` and `getExportSpecifierLocalTargetSymbol`; it never asks for a type. A
   test holds that.
3. A name inside `with`, or inside a function that a sloppy direct `eval` can extend, is dynamic: no binding is claimed
   for it.
4. A program lives for the file it binds and is dropped once that file's names are answered; only the answers stay for
   the query.
5. `rootOrigins` and the function-value reader read bindings only from the resolver.
6. The consumer-flow reader of contract consequences is a consumer: the binding a read, a write or a call of a name
   reaches comes from the resolver, and a name inside a dynamic scope (a `with` body, or a function a sloppy direct
   `eval` can extend) is reported as a frontier, never as a binding or as no binding.
7. Trace's receiver bindings are a consumer: the binding of a receiver's root name, and of every store into a receiver
   bound in the file (its initializer and each assignment), comes from the resolver. A receiver whose root is dynamic
   stays a cut.
8. A name in a type position (a type annotation's type reference, an `implements` or `extends` clause) is looked up
   as a name, so a declared type can be told apart from a library, primitive or package one. It stays no type API: no
   `getTypeAtLocation`, no `getTypeOfSymbol`, no inference. The lookup is the root bindings' (`ImportOrigins`), shared by
   outline and trace slice 2's declared external annotations (S5): the type scopes written around the name (a type
   parameter, an `infer`, a mapped type's key, a declaration in an enclosing block, namespace or the file), then the
   file's imports and the language's globals. The resolver itself still answers `none` for a name in a type position,
   and the `typeCount` test still holds: no type is created.
9. A receiver annotated with a library, primitive or package type is an external leaf (trace slice 2, S5) only when no
   in-scope repository class or interface extends or implements that type and the type is not imported from one of the
   repository's own packages (the module resolver never resolves those to a package). A heritage name is followed
   through `const` aliases, type aliases and imports of the repository's own files to a repository class, interface or
   type literal, or to a library or package type. Heritage that reaches neither (a mixin call, a parameter, a `let`, a
   dynamic scope, a deeper chain, a source that does not parse) proves nothing about any type, so every annotation stays
   unknown in that snapshot. A type declared nowhere (generated code) stays unknown. A field annotation (`this.r`) holds
   only for a field the language keeps inside its class, a `#name` or a TypeScript `private` field or constructor
   parameter property, while the class's `this` never escapes and the class names the field through no other receiver
   (a key no literal states, a rest or a reflecting call on another receiver may name every field, and is not resolved);
   a `protected`, `public` or unmodified field stays unknown, since a subclass, a superclass method or another module
   could write it, and no class hierarchy is read across files. In Java (trace slice 2, S6) the same proof reads the
   project's one name resolver (`JavaProject.bindName`, strict): a receiver whose one declaration (a parameter, a typed
   lambda parameter, a local or loop variable, or a `private` field the file names only through `this` and never by
   reflection) states a type a single import names under a platform package is a leaf under that package. A repository
   type, a type variable, a type outside the platform packages (a dependency or generated code) and a name the strict
   reading leaves unsettled stay unknown. Java records no replaced roots, since source cannot rebind a class's
   methods; repository code reaches a platform type through a subtype, a dynamic proxy or an object stored in a platform
   class's field, so every annotation stays unknown when a
   repository type names a supertype outside the repository (its own supertypes are not in the sources), or the sources
   hold an anonymous class, a lambda or a method reference (an implementation of an interface they do not state), a JDK
   API that implements an interface at run time (`java.lang.reflect.Proxy`, `java.beans.EventHandler`,
   `java.lang.invoke.MethodHandleProxies`, `java.lang.invoke.LambdaMetafactory`, named through an import, a qualified
   name, a wildcard import or a name no import settles), an aspect, a Java source that does not parse, or a source of a
   JVM language no extractor reads (`.kt`, `.kts`, `.groovy`, `.scala`). The implicit supertypes of classes, enums and records
   (`java.lang.Object`, `Enum` and the interfaces it implements, `Record`) stay unknown. Reflection keeps the declared type: the runtime checks every
   reflective write against the field's type. A dynamic proxy is a value of that type that runs repository code, so the
   JDK APIs that make one fire the guard above, wherever their value is stored (a write through `sun.misc.Unsafe` is
   outside the promise, as an `any` cast is in TypeScript). A root, in Java as in TypeScript, proves where a call's chain
   starts, not what it runs past the root: nothing records what the repository stores in a platform class's fields or a
   package's or global's members (`System.setOut`, `other.setLogger`), so a call that reads a member between its root and
   its own member (`System.out.println`, `other.logger.flush`, `document.body.appendChild`) is not settled by its root,
   whether the index left it pending or resolved it into an edge: trace, impact, callers, importers and outline keep such an edge instead of dropping it, and keep such a pending call a cut (ADR-0019, amendment). The leaf's evidence is the module or the global it is rooted at, as for every other
   leaf; the answer gains no field, so the declared type itself is not written.
10. In Java (trace slice 3, S4a) a declared repository type proves the method a call names, since Java types nominally:
   a value a declaration states the type of is an instance of that type or of a type below it. A receiver held by such a
   type through the receiver bindings of decision 9 (a parameter, a local or loop variable, or a `private` field the file
   names only through `this` and never by reflection), or by the declared return type of the repository method a
   receiver call names in the same way (`x.f().m()`, and `f().m()` or `this.f().m()` through the enclosing class), names
   the one method the type's members of that name, its own and inherited, offer for the call's arity: the type's own,
   else the nearest up its class chain. An overriding method may only return a subtype of the declared return type, which
   dispatch covers. Trace steps at that method, and dispatch decides the body below it (RFC-0013 R7). The proof needs the
   declared hierarchy to prove every body a value of the type may run (R7's guards, with the declared type as the owner)
   and holds nothing when a source does not parse or a JVM source no extractor reads is in scope; when the type is a type
   variable, an enum or an annotation type (a record is a final class); when a type at or above it names a supertype
   outside the repository, whose members the sources do not state; when its members of the name are an overload, a
   varargs, a `private` method or one of `Object`'s; or when a source holds Lombok's `@Delegate` or `@ExtensionMethod`,
   by which a processor adds an overload or rewrites a call with no declaration in the sources. Signatures, here and in
   R7's overrides, compare parameter identities by decision 12, never by their text: `save(X)` in another package may name another `X`, an overload. A name nothing in the
   repository binds and no single import names is one type only for files that read it from the same package and
   on-demand imports. Two methods whose parameter types are not certainly one declared type may still be one (a name the
   reading leaves unsettled, a type variable, whose binding by an implementation is not read): nothing narrows to either,
   so dispatch proves no body and a call names no method (trace slice 3 close-out rule, fail closed). Decision 9's global guard
   is scoped here, as R7 scopes it: a supertype outside the repository, an anonymous or local class and a lambda or method
   reference withhold the proof only inside the declared type's hierarchy (at or above it for a supertype, below it for
   an anonymous or local class, the type itself being a functional interface for a lambda). That is sound because Java
   types nominally: a value of a repository type `T` is an instance of a class whose declared supertypes reach `T`, and a
   platform class cannot extend a repository type, so a repository class with a platform supertype elsewhere is no value
   of `T`, an anonymous or local class implements only the type it names, and a lambda implements only a functional
   interface. Decision 9 needs the global guard because there the declared type is a platform type, which any of those may
   implement without the sources saying so. An aspect, a dynamic-proxy API, a source that does not parse and a JVM source
   no extractor reads stay global. A call the index resolved into an edge keeps it, with the walk's override rule (R10)
   cutting at a type below that declares the method, whether or not this proof holds: codegraph resolves a Java receiver
   by its declared type, so a `var` local, a non-`private` field or an aspect in scope do not change what the edge
   names. The edge is a step only at the proven method, and a cut, only when the sources may make a value of any declared
   type run code they do not show: a source that does not parse, a JVM source no extractor reads (a Kotlin subclass
   overriding the method), or a JDK API that implements an interface at run time; then a call on a value it reads (a
   variable, a member of another value, another call's result) is a cut listing the edge's target and every declaration
   of its name. The declared type stays true at run time because the compiler checks every assignment, a cast and the
   cast it inserts where a generic value is read into a declared type are checked at run time, and a reflective write is
   checked against the field's type; a type variable and `var` state no type here. A Spring proxy over a class runs the
   same body after its advice, which is framework code, or repository code only through an aspect (an R7 guard); a JDK
   proxy implements only interfaces (an R7 guard). Outside the promise: a write through `sun.misc.Unsafe` or JNI, and an
   annotation processor this decision does not name that adds an overload to a class.
11. A call the index resolved into a method of a repository class is not proof that the method runs when its receiver is
   a value (a parameter or a variable, by the binder's scoping), a field read through `this` (`this.f.m`) or any other
   expression: the index matched the call by name, and TypeScript types structurally, so any object with that member may
   stand there (trace slice 3, S6). The receiver is read through parentheses, a non-null `!` and `satisfies` only. The
   only receivers left to the index's edge are a plain chain of names rooted at a class, a function, an import or a
   namespace, `this` itself (`this.m()`), and a plain chain whose root no binding proves. Every other receiver, a type
   assertion (`as`, `<T>x`), an optional call, an element access, a comma, a condition, an `await` or a call result
   included, needs a proof, and is a cut listing the declarations of its name without one. Trace takes it as a step
   only when the receiver's origin proves the class (a store-bound local of decision 7, or a member proof of the
   relations, such as an `inject(T)` local or a field's `FieldOrigin`), or when the receiver's one annotation (for a
   field, a `#` or `private` one decision 9 admits; for a local every store fills with one such field read, `const h =
   this.handler`, that field's, the copy counting as no escape of the field while the local itself stays in the file's
   sight) names a nominal class: a repository class that itself declares a `private`, `protected` or `#` instance
   member, which TypeScript compares by declaration, so only an instance of it or of a subclass fits. A brand the class
   inherits proves nothing: every class below the one that declares it fits, the annotated class's siblings included.
   The step is the method the class or its nearest ancestor declares; a subclass that overrides it is the step's
   dispatch cut (RFC-0013 R7). The rule holds only while every heritage of the snapshot is proven (decision 9) and the
   index resolves the heritage of every class that declares the member, so no subclass is unseen. A call result is
   proven only when the call is itself an edge of the body whose receiver needs no proof and its declaration states a
   nominal class as its return type (RFC-0013 R5); two calls of one member name starting at one place prove nothing. A
   field the relations prove holds a package or global type makes the call a leaf under it. A call into an interface
   keeps its dispatch cut. Impact, callers, importers and outline still read such an edge as a possible dependence.

12. Java signature identity has one owner, `JavaProject.typeIdentity` and `readSignature`, shared by trace dispatch,
    receiver-method comparison. This is an identity comparison, not an extension of the
    strict resolver's external-leaf or dependency proof. Its lexical walk is the existing resolver's: local and
    enclosing member types, including inherited member types, precede imports. A type parameter remains variable,
    never a concrete signature proof. Local types without a placed declaration, inaccessible or ambiguous members,
    and an unknown superclass retain the cut. A member type can shadow a single-type import (JLS 6.4.1).
    Single-type and single-static imports precede the file's package and on-demand imports; conflicting single imports
    or a conflicting top-level declaration in the compilation unit prove nothing. Static imports resolve a public
    static member type through its declaring repository type, including inherited members. Unread external member
    suppliers remain unknown. The file's own package precedes ordinary and static on-demand imports. `java.lang` is
    an implicit on-demand supplier, not a higher-priority import. Known demand suppliers must agree on one identity;
    a known collision stays cut even beside an unknown supplier. A missing supplier is never assumed empty merely
    because a collision would make a compilable program illegal (JLS 6.5.5.1, 7.5).
    For exclusion of platform collisions, the public top-level names of `java.lang` and `java.util` are the union of
    the Java SE 8, 11, 17, 21 and 25 package summaries, checked into `java-platform-type-names.ts`. This inventory is
    a versioned language model, never read from the host JDK or a repository build. An unlisted package or platform
    member-type container stays unknown. A future platform release requires updating the inventory before its new
    names can be excluded. Repository package membership uses the same snapshot-source boundary as the resolver;
    generated or dependency declarations absent from that boundary cannot be reconstructed.
    When demand suppliers cannot be enumerated, equal unresolved resolution contexts (own package, ordinary demands,
    static demands and simple name) can establish only equality of the two signature expressions, as the prior
    same-context rule did; they select no supplier and prove no repository target or external leaf. Different contexts
    do not prove equality, and known collisions never use this fallback. Qualified repository member names resolve
    to their declaring member, so inherited spellings compare canonically. Array dimensions remain part of identity.
    No schema or persisted graph shape changes. `bindName`'s strict and lenient query behavior is unchanged.
    The owner's J1 instruction authorizes choosing the root fix and testing this shared comparison; S3's proposed
    import precedence and compilability assumption are corrected by these rules.

## Consequences

- One implementation of scoping: a variant the binder handles is handled by both consumers.
- About 1 ms more per file a query binds, and a few hundred KiB while that file is bound.
- `ADR-0008` holds: the compiler API is used inside `core/adapters/typescript/`, and decision 1 there already lists the
  program and the checker. `ADR-0018` does not apply: no type is read, no library or dependency is loaded, and no type
  root exists.
- In sloppy JavaScript a function declared in a block is block-scoped for the binder, while the runtime also hoists it
  to the function. A call to it outside the block finds no binding.
- Decision 9 trusts a declaration, not a value. TypeScript types are structural: a repository object that has the
  members of a library type can be passed where that type is declared without extending or implementing it, and an
  `any` or a cast can put any value there. A receiver declared as such a type is reported external although it may run
  repository code; the guards of decision 9 only catch the nominal cases. The same holds for a TypeScript `private` field
  written from outside its class through an `any` or a cast (`(page as any).cache.get = f`), and for a nominal class of
  decision 11 (`const s: Store = { save() {} } as any`): trace reports a step at the class's method. The owner accepted
  this limitation with decision 9, and decision 11 inherits it.

## Not decided here

- Using the binder for any other fact than the consumers above.
- Narrowing a receiver to a repository type in TypeScript, and following a chain there through declared return types
  (RFC-0013 R5), beyond the nominal classes of decision 11: structural typing lets a compatible object of another
  class stand where the type is declared (trace slice 3, S4b, research).
- Java bindings, which have their own reader.
