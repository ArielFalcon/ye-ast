# ADR-0008: TypeScript 6.0.3 as the single TypeScript version

- Status: Accepted, 2026-10-29, owner
- Decision source: the owner asked (translated) "what is gained by using TS 7 and why not keep the one that has the
  compiler?", was shown a single-version option next to the two-version one, and answered "yes" to applying
  `typescript@6.0.3` as the only version, recorded as an exception to ADR-0007.
- Related: [ADR-0007](0007-dependency-versions.md), [ADR-0003](0003-implementation-language.md),
  [RFC-0007](../rfc/0007-extension-model.md)

**In short:** ye-ast uses `typescript@6.0.3` both to type-check its own code and as the analysis library its extractors
call. TypeScript 7, the latest stable release, dropped the compiler API those extractors need. This is the exception
ADR-0007 rule 4 foresees; it ends when TypeScript 7 publishes a stable programmatic API.

## Context

TypeScript plays two roles in ye-ast:

| Role | What it does | Who uses it |
|---|---|---|
| Development tool | `tsc --noEmit` type-checks ye-ast's own code | developers and CI; never shipped |
| Analysis library | the `typescript` package's API used at run time on the analysed repository: `ts.resolveModuleName` (honours its `tsconfig` `paths`, `baseUrl`, `extends`), `ts.createProgram` and its AST (route tables), the type checker (declared response types for consumer expectations) | ye-ast's extractors, every run |

Checked on 2026-10-29 by installing `typescript@7.0.2`: `ts.createProgram` and `ts.resolveModuleName` are `undefined`;
the package exports only `./unstable/sync`, `./unstable/async`, `./unstable/fs`, `./unstable/proto`, `./unstable/ast`
and `./unstable/ast/is`. TypeScript 7's gain is type-checking speed (role 1), negligible at ye-ast's size; it offers
nothing stable for role 2. `typescript@6.0.3`, the latest 6.x and the last line built on the JavaScript compiler, has
the full API (`createProgram` and `resolveModuleName` are functions).

| Option | For | Against |
|---|---|---|
| **One version: `typescript@6.0.3`** | One dependency; the code is checked with the version it analyses with; dependency-cruiser supports it natively | Slower type checking, no real cost today; an exception to ADR-0007 |
| `typescript@7.0.2` for `tsc` + `npm:typescript@6.0.3` for analysis | Fast type checking; follows ADR-0007 literally | Two versions under an alias; dependency-cruiser needs the swc parser |
| TypeScript 7 `unstable/*` API | One version, native speed | Marked unstable; IPC-based; parity with the classic API unproven |
| Delay the extractors | One version | Blocks the first slice, which needs module resolution |

## Decision

1. `typescript@6.0.3`, pinned exactly, is the only TypeScript version: development tool and analysis library.
2. Every use of the compiler API sits behind an adapter in `core/adapters/typescript/`, so moving to another API changes
   that adapter only.
3. dependency-cruiser parses with its default TypeScript support; swc is not a dependency.
4. The exception is revisited when TypeScript 7 publishes a stable programmatic API, or when the 6.x line stops being
   maintained, whichever comes first.

## Consequences

- If a later TypeScript 7.x adds syntax 6.0.3 cannot parse, ye-ast cannot read repositories that use it (hypothesis;
  7.0 shipped the 6.0 language). A conformance fixture pins module resolution and type reading, so the migration can be
  checked when it happens.
- How long the 6.x line is maintained is not known; it is checked at each dependency review.
- TypeScript 6.0.3 resolves modules with its own defaults, not TypeScript 5's (probe, 2026-10-29):
  - without `moduleResolution`, `module: commonjs` resolves as `Bundler`, where TypeScript 5 used `Node10`;
  - `baseUrl` and `moduleResolution: node10` still resolve but raise TS5101 and TS5107, "will stop functioning in
    TypeScript 7.0";
  - codegraph ignores `baseUrl` alone, with no `paths` (codegraph 1.6.2 platform bundle
    `lib/dist/resolution/path-aliases.js:273`).
- The resolution adapter therefore passes explicit resolution options derived from the analysed project and its declared
  TypeScript major, treats deprecation diagnostics as information, and carries a conformance fixture with a legacy
  `tsconfig` (`baseUrl`, `node10`).
- Leaving the 6.x line means ye-ast owns legacy resolution itself.
- `typescript` moves from `devDependencies` to `dependencies` with the first extractor, because it runs on the analysed
  repository.
