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
   unknown in that snapshot. A type declared nowhere (generated code) stays unknown. The leaf's evidence is the module or the global it is rooted at, as for every other
   leaf; the answer gains no field, so the declared type itself is not written.

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
  repository code; the guards of decision 9 only catch the nominal cases. The owner accepted this limitation with the
  decision.

## Not decided here

- Using the binder for any other fact than the consumers above.
- Narrowing a receiver to a repository type, and following a chain through declared return types (RFC-0013 R5): trace
  slice 3, with dispatch (R7).
- Java bindings, which have their own reader.
