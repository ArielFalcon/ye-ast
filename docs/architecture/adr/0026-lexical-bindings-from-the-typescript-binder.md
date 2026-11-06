# ADR-0026: The TypeScript compiler's binder is the one source of lexical bindings

- Status: Accepted, 2026-11-06, owner
- Decision source: the owner, 2026-11-06: "Apruebo" (I approve), on the design reported after the binder probe: one
  shared TypeScript binding resolver in `core/adapters/typescript`, used by both `rootOrigins` and the function-value
  reader, replacing both hand-written scopings.
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

## Consequences

- One implementation of scoping: a variant the binder handles is handled by both consumers.
- About 1 ms more per file a query binds, and a few hundred KiB while that file is bound.
- `ADR-0008` holds: the compiler API is used inside `core/adapters/typescript/`, and decision 1 there already lists the
  program and the checker. `ADR-0018` does not apply: no type is read, no library or dependency is loaded, and no type
  root exists.
- In sloppy JavaScript a function declared in a block is block-scoped for the binder, while the runtime also hoists it
  to the function. A call to it outside the block finds no binding.

## Not decided here

- Using the binder for any other fact than the two consumers above.
- Java bindings, which have their own reader.
