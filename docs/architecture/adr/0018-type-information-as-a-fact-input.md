# ADR-0018: Type information is an input of the facts it settles

- Status: Proposed
- Decision source: the owner, 2026-11-03 (translated): "check ast-grep and serena to see whether ye-ast can benefit from
  them, as dependencies or as solutions they have that are better or that cover gaps we have not solved", "run the probe
  you propose on name-webapp", "formalize an implementation plan and the documentation needed". Acceptance is pending;
  this record stays `Proposed` until the owner answers.
- Related: [ADR-0007](0007-dependency-versions.md), [ADR-0008](0008-typescript-compiler-api-source.md),
  [ADR-0010](0010-trust-modes.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md),
  [ADR-0015](0015-index-reuse-by-content.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0010](../rfc/0010-impact-queries.md), [RFC-0013](../rfc/0013-trace-and-patterns.md),
  [RFC-0016](../rfc/0016-type-resolution.md)

**In short:** a fact may settle which declaration a call refers to by asking `typescript`'s own compiler API, in
ye-ast's process, from a type root it is given. It is never a service, never a server, and never a guess: without a type
root the port answers `unknown` and the existing `unresolved-link` cut stands. The type root is an input of every fact
that used it, so it takes part in invalidation.

## Context

`ADR-0008` decision 1 lists `ts.createProgram` and the type checker as part of the analysis library ye-ast already
depends on. No code exercises them: `createProgram`, `getTypeChecker`, `getSymbolAtLocation`, `getAliasedSymbol` and
`getResolvedSignature` appear nowhere under `src/`. The compiler API is used for two narrower things, module resolution
(`ts.resolveModuleName`, `src/core/adapters/typescript/module-resolver.ts:119`) and configuration parsing
(`ts.parseConfigFileTextToJson` at `:99`, `ts.parseJsonConfigFileContent` at `:101`), and the extractors import `ts` for
syntax only. Call resolution therefore rests on codegraph's index and on the `FieldOrigin` settlement of
`src/core/application/impact/inbound-edges.ts:195,239`, which is `RFC-0013`'s rule R1 plus a narrow slice of R3.

**ye-ast reads no `node_modules` today.** `createModuleResolver` (`module-resolver.ts:46`) takes the package names a
manifest declares and answers `{ external: true }` for them without opening a file (`:113`). A type layer is therefore a
new kind of input, not a correction of an existing one: it is the first thing in ye-ast that would read a dependency's
declarations.

Two projects raised the question of what is missing. Neither is usable as a dependency:

| Candidate | Finding |
|---|---|
| [ast-grep](https://github.com/ast-grep/ast-grep) | `@ast-grep/napi` 0.51.1 (MIT) declares `Lang` as `Html`, `JavaScript`, `Tsx`, `Css`, `TypeScript` only. Java — the one language with an own extractor over tree-sitter — needs `@ast-grep/lang-java`, at `0.0.7`, with a `postinstall`. Nothing to replace today. |
| [Serena](https://github.com/oraios/serena) | The application is GPL-3.0-or-later and only SolidLSP is MIT, in Python. No code of it can enter an Apache-2.0 TypeScript project, and the LSP client it wraps is MIT and belongs to Microsoft. |

The measurable gap was the receiver-resolution problem `RFC-0013:40` records. A probe was run on a real Angular
application to size it (method and caveats in `RFC-0016`): 701 sources, 14.440 call expressions.

| | With the dependency closure | Without it |
|---|---|---|
| Settled to a repository declaration | 5.940 (41.1%) | 4.812 (33.3%) |
| Settled to a library declaration | 8.473 (58.7%) | 1.879 (13.0%) |
| **Unresolved** | **27 (0.2%)** | **7.749 (53.7%)** |

A `Program` over that repository took 3.15 s and 680 MB; full verification with `tsc --noEmit` took 9.74 s, so resolution
alone is a third of what a type check costs. Two consecutive runs produced identical counts. A later measurement on the
same program put the real frontier at 18.156 unresolved references, 8.793 of them calls (`RFC-0016`, S0).

The absence of the dependency closure is not a rounding error. Without it the unresolved names are, in order, `inject`,
`set`, `computed`, `input`, `signal`, `output`, `pipe`, `Injectable`, `effect`, `required` — that is, the framework
primitives `RFC-0013:169` names as the features a role is built from.

| Option | For | Against |
|---|---|---|
| A. Keep codegraph's edges and `FieldOrigin` | No work; no new input | Leaves every unresolved call a cut, and the cut rate is the weakness |
| B. Implement `RFC-0013` R2-R6 in syntax, per language | Works without any dependency closure | Hand-written heuristics that grow with every idiom, exactly what `ADR-0013` decision 5 bounds |
| **C. Compiler API in process, from a given type root** | Already a declared dependency; deterministic; 3.15 s; no process, no protocol | TypeScript only while `typescript` is the only language whose compiler runs in Node |
| D. `tsserver` or an LSP client | Uniform across languages; incrementality | A stateful service decides the project and the answers; loses the determinism `RFC-0002` rule 3 promises and the scope control `declaredScope` needs |
| E. A host-supplied type root under `untrusted` | Keeps `ADR-0010` intact: the host already supplies the manifest and the store | A new host contract, and no existing consumer supplies one |

## Decision

1. **A fact may use type information to settle a reference.** It enters through a port the core declares and an adapter
   implements; no use case imports the compiler.
2. **It is obtained in ye-ast's process, from the `typescript` package already pinned by `ADR-0008`.** No server, no LSP
   client, no language server, no new dependency, and no repository code runs.
3. **It is a refinement inside the five fact families, not a sixth family.** `ADR-0013` decision 1 is unchanged: what it
   improves is the resolution of an existing fact, never the set of questions ye-ast answers.
4. **The type root is an input.** A fact that used it records it, beside `declaredScope` and the content digest, and a
   different type root invalidates the stored fact (`RFC-0002` rule 5).
5. **Absent a type root, the port answers `unknown` with its reason, and the existing cut stands.** It never falls back
   to a guess, and it never turns an unresolved call into a resolved one on a name match alone.
6. **The type root is always a directory outside the snapshot; the trust mode decides who supplies it.** It is never
   inside a snapshot: under `sha` the export holds only the files of the git tree, and under `live` the mirror holds only
   the in-scope listing, so `node_modules` is in neither. Under `trusted` the host may supply it, and a caller that
   supplies none may have it derived from the working tree's `node_modules`, the only place the closure exists. Under
   `untrusted` only the host supplies it. A caller that supplies none gets today's answer.
7. **`tsserver` and LSP are rejected for TypeScript.** They add a stateful process that chooses the project and the
   answers, which contradicts decision 4 of `ADR-0010` and rule 3 of `RFC-0002`, for no semantic gain over the same
   engine reached in process.
8. **The resolution feeds the walk, not the cut emitter.** A settled reference becomes an inbound edge before
   `walkImpact` expands the graph. `impact-queries.ts:470,474` builds the `unresolved-link` cuts after the walk and over
   the symbols it reached, so resolving there would add an edge from a caller the walk never expanded: its own callers
   and entrypoints would stay unvisited with no cut declaring it, and the fact would answer `complete` on an unvisited
   frontier. **Measured, this decision delivers one cut; see "What the wiring measured" below, which reopens it.**
9. **The port is synchronous.** `impactOf` (`impact-queries.ts:455`) and `walkImpact` (`walk.ts:63`) return values, not
   promises. The adapter reads the materialized snapshot directory and the type root from disk with a synchronous
   compiler host; a port that had to interleave reads with the walk would force the walk to become asynchronous, which
   this record does not propose.
10. **New vocabulary is a schema change with its own slice.** `ambiguous-target` as an `UnknownReason` and
    `no-type-root` as a `Cut.kind` extend closed unions in `src/core/domain/shared/fact.ts:101,111`. Each is declared
    under `RFC-0002` rule 6 in the slice that introduces it, never as a side effect of another.

## Consequences

- Answers that are `partial` today because of an `unresolved-link` cut become `complete` where the type root settles
  them. That is a change of meaning in the stored fact and takes the schema treatment of `RFC-0002` rule 6.
- **Completeness moves only for the reference kinds the port settles.** On the probe program, 8.793 of 18.156 frontier
  rows are `calls`; 3.735 are `imports`, which name a module specifier and belong to module resolution, not to types. An
  answer that settles calls cannot claim completeness over imports, and says which kinds it covers.
- Every stored fact of a snapshot that used type information is invalidated once, on the release that adds the input.
- The `TypeScript` version is part of what decides the fact, so a second input identity exists beside the content
  digest.
- TypeScript gains a resolution quality the other languages do not have. Java keeps `codegraph` plus the Spring
  vocabulary, and this record decides nothing for it: no compiler for Java runs in Node, so the same decision there
  costs a JVM.
- The existing syntax rules survive as the fallback when no type root is available, which keeps `untrusted` without a
  host answering exactly as it does today.
- `importers` stays on its own path until it is brought in: `impact-queries.ts:240-241` reads the unresolved references
  itself, so after the first wiring `impact` would settle semantically what `importers` still settles by name tail. Two
  answers about one reference must not disagree.

## What the wiring measured

The decision above was implemented and measured before any commit (`RFC-0016`, `S4 measured`). On a real Angular
application, with its own `node_modules` as the type root:

| Base | Cuts, no root | Cuts, with root | Symbols |
|---|---|---|---|
| `HEAD~5` | 84 | 83 | +1 |
| `HEAD~20` | 201 | 201 | +1 |
| `HEAD~60` | 374 | 374 | +22 |

Cost on `HEAD~5`: 3,08–3,28 s → 5,17–5,63 s wall clock, and 449 MB → 836 MB maximum RSS. The port does settle 11.308 of
the 14.595 frontier rows, 1.896 of them onto repository declarations. **The cuts are a different population**: they are
what the index could not settle and the walk reached, so almost nothing that settles is ever asked about. The 99,8% of
the Context table is the checker's coverage of every call expression, never of the cuts.

Decision 8's premise — that an edge is what the agent needs — is refuted by that measurement. What the agent reads is the
cut list, and the type layer can shorten it only by proving that a cut is false, never by adding an edge nothing walks.
That is `RFC-0016` gap A, and it does not need a `Program` for most of its effect: an import binding plus the existing
`module-resolver` proves 55% of the cut places in 369 ms, without a type root, a `Program` or `node_modules`.

This record stays `Proposed` until the owner decides three things: whether a cut whose target is provably external stops
being a cut, whether the port stays once that is measured, and whether a host under `untrusted` supplies a type root at
all — decision 6 means qayaba, which declares `untrusted` for every run, gets nothing from this record without one.

**The first of those was decided on 2026-11-03** and shipped as `ADR-0019`: a cut whose target a file's own imports prove
external is no longer emitted, without a type root. Measured, it removes 6% to 13% of the cuts of a real diff and changes
no symbol. The port itself remains unmerged, and now has to justify +387 MB against a list that is already smaller.

Two defects found while measuring are independent of that decision and stand on their own: the adapter trusts a
coordinate codegraph does not promise (`RFC-0016` gap C), and it resolves modules without the repository's `paths`
because composition passes no `options` (`gap B`) — and this record's companion RFC specifies a wiring, adapter reading
adapter, that the dependency rule forbids.

## Not decided here

- The host contract for the type root: its shape, how a host declares it, and whether `RFC-0006`'s profile carries a
  field for it (`RFC-0016`, question 1).
- Whether the dependency closure is ever exported into a snapshot: the probe application's `node_modules` is 622 MB,
  while the declarations a type root needs are 74.6 MB (11.308 `.d.ts` files and 1.016 `package.json` files). The second
  number is why a host-supplied directory is the candidate and an export is not.
- Any Java coverage beyond what `codegraph` and the Spring plugin already read (`RFC-0016`, question 5).
- The budget that stops a `Program` and what a fact does when it is reached (`RFC-0016`, question 4).
