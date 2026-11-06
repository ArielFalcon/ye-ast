# Plan: `outline` references, on an import-binding table

- Date: 2026-11-06
- Request (agent feedback): imports with their local binding when it can be resolved, and, for a declaration, what it
  uses: `RestaurantApi / getAllRestaurants 93–105 / references: RestaurantListResponseSchema → restaurant.schema.ts:42 ;
  toScrollPage → este archivo:47`, treated as an optional extension that shares the engine of the outbound walk.
- Coordinated with: [trace plan](2026-11-06-trace-outbound-walk.md) (slice 1 on branch
  `t3/extract-shared-graph-navigation`, commits `b6595d7..7b4dc72`, not on `main`); `RFC-0016` gap A (import origins).
- Status: phase 2 (binding table and Part A) and phase 3 (Part B, focus uses) implemented, see the task tables. Phases are
  owner-approved in this order: (1) this design, (2) the binding table exposed in `outline` as Part A, (3) Part B in
  focus mode once trace slice 1 is on `main`.

## 1. Goal and non-goals

**Part A.** `outline` lists, per file, every module statement with what it binds: the local name, the imported name,
type-only or not, and where it leads: a repository file and, when it is proven, the declaration; a package; or an
explicit unknown. **Part B.** In focus mode, the focused declaration lists the names its own body uses that are bound
outside the body, each settled to a repository declaration (`file:line`), a package, a language global, or a cut.

Not in scope: what a member call on a local value reaches (`schema.parse(...)` where `schema` is a local: receiver
inference is trace's `CallBindings`, trace slice 2); evaluating conditions; listing uses in the whole-file listing;
marking imports "unused" (it needs scope analysis nobody asked for; see Q4); a type checker (`ADR-0018`).

## 2. Measurements

### 2.1 Setup

| Item | Value |
|---|---|
| TypeScript repository | this repository, `git archive` of `7a9c3425fae894b9153a3f06dd198b9bba21da18`; 411 files indexed, 399 TS, 0 not indexed |
| Java repository | `spring-petclinic-microservices`, `git archive` of `305a1f13e4f961001d4e6cb50a9db51dc3fc5967`; 122 files indexed, 62 Java |
| Engines | codegraph 1.6.2, store schema 11, extraction 27; Node 24.22.2; TypeScript 6.0.3 |
| Index | `createCodeGraph().index(export, store)` then `.open(store)`, the adapter every query uses (`src/core/adapters/codegraph/codegraph.adapter.ts:91-130`) |
| Syntax | `ts.createSourceFile` over each file; module specifiers through `createModuleResolver` (`src/core/adapters/typescript/module-resolver.ts:56`) with the manifests' dependencies, as `import-origins` builds it (`import-origins.adapter.ts:31-35`) |
| Non-test filter (2.3) | path does not match `\.(test\|testing\|e2e\.test\|audit\.test)\.tsx?$`, `/test/`, `__tests__`; owner kinds `function`, `method`, `constructor` |
| Scripts | kept in the scratch directory of the run (not committed): `bindings.mts` (syntactic binding enumeration), `m1.mts` (join), `m2v.mts` (settling), `audit.mts` (graph edges against bindings), `sizes.mts` (rendered bytes), `java2.mts` (Java imports), `extract-time.mts` |

### 2.2 M1: can a syntactic binding be joined to its graph record?

Graph facts, read from the store: codegraph writes one `imports` edge **from the file node** per statement (at column 0
of the statement, target the file node) and one per named binding (target the declaration, at the 0-based column of
the **local** name for imports and of the **property** name for `export { a as b } from`). A binding imported from a
package is no edge: it is an unresolved reference of kind `imports`, named once by the specifier and once by the local
name, at the same positions. Every import edge carries confidence 0.9 (0.7 for a `paths` alias file edge), provenance
`null`.

Join rule tested: syntactic binding ↔ graph record at the same `(line, column)`.

| Form (this repository) | Bindings | Joined to a declaration edge | Joined to a file edge | Joined to an `imports` unresolved reference | Ambiguous | Unmatched |
|---|---:|---:|---:|---:|---:|---:|
| named | 2,330 | 1,528 (3 through a re-export alias) | | 802 | 0 | 0 |
| named, `import type` | 1,781 | 1,750 | | 31 | 0 | 0 |
| named, inline `type` | 506 | 491 | | 15 | 0 | 0 |
| named with alias (`a as b`) | 10 | 4 | | 6 | 0 | 0 |
| default | 169 | | | 169 | 0 | 0 |
| namespace | 1 | | 1 | | 0 | 0 |
| `export { … } from` | 11 | 11 | | | 0 | 0 |
| **static total** | **4,808** | **3,784** | **1** | **1,023** | **0** | **0** |
| `import()` with a literal | 17 | | | | | 17 |
| `import("…")` type node | 9 | | | | | 9 |

- Every one of the 1,023 package bindings is a package for the module resolver too; every one of the 3,785 repository
  bindings resolves, through the resolver, to the file the graph edge reaches. Per statement the resolver and the graph's
  file edge agree on 2,564 of 2,595; the 31 others are the 17 `import()`, the 9 type nodes and 5 `export … from`
  statements, for which the graph writes no file edge and the resolver gives the file.
- The graph resolves barrels: `import { impactFact }` reaches `withCuts` in `shared/fact.ts` through
  `export { withCuts as impactFact }` (`src/core/domain/impact/impact-fact.ts:80`); 3 of 3 such bindings.
- No graph edge lies at a position without a syntactic binding (0 graph-only edges).

**Decision D1.** Part A combines both: **syntax owns the binding** (local, imported, form, type-only, specifier) and
the resolver owns the file or package; the graph edge at the binding's `(line, column)` only adds the declaration, and
only for a binding the syntax already holds. The measured join is total and unambiguous on static forms, and the graph
is the only reader that follows re-export chains today. A graph edge never creates a binding.

### 2.3 M2: what the binding table settles for Part B

Unresolved references (`unresolvedReferences`, kind not `imports`) made by the 2,095 non-test functions, methods and
constructors of the TS repository, classified by the name they are rooted at (`rootedName`,
`src/core/domain/impact/impact-cuts.ts:81`). When that root is bound nowhere, the root is read again from the syntax at
the reference's position (the head of `ts.Expression` is `ts`, of `f(x).g` is `f`); that settled 387 more places.

| Root settles to | Calls (7,764) | Type references (1,885) | Values passed (286) |
|---|---:|---:|---:|
| package import (certain external) | 1,357 (17.5%) | 344 (18.2%) | 3 (1.0%) |
| language global (`ambient`, existing rule) | 1,211 (15.6%) | 1,186 (62.9%) | 0 |
| repository import (declaration via the join) | 64 (0.8%) | 0 | 43 (15.0%) |
| top-level declaration of the same file | 433 (5.6%) | (in local) | 26 (9.1%) |
| `this` / `super` (own member: trace R2 helper) | 272 (3.5%) | 0 | 46 (16.1%) |
| local binding: parameter, variable, type parameter | 4,337 (55.9%) | 320 (17.0%) | 167 (58.4%) |
| imported but shadowed by a local declaration | 3 | 0 | 1 |
| **unknown** | **87 (1.1%)** | **35 (1.9%)** | **0** |

- Per declaration: **21.3%** have no unresolved reference (446 of 2,095, the prior baseline); with the binding table,
  **96.3%** have no root left unknown (2,017); 96.8% counting calls only, 99.2% type references only.
- The unknown residue is the Node globals `@types/node` declares and the TypeScript lib does not (`Buffer` 54,
  `NodeJS.ProcessEnv` 13, `process` 11, `setImmediate`), 21 member calls on a `new` expression the root reader did not
  descend (`new Set(a).add(k)`, placed on the `new` keyword; the head is the global `Set`), and 6 computed callees. They stay unknown: no source of the snapshot declares them.
- "Local binding" settles the **root** only: B claims the names bound outside the body, and a member call on a local
  value reaches what the receiver's type says, which is trace slice 2. That is the scope line of Part B (D4).
- Graph-resolved edges from the same declarations (10,070) checked against the bindings at their position: 3,990 agree
  with the binding's declaration, 22 **contradict** it: `ts.SourceFile`, `ts.Node` and similar type references whose
  root `ts` is imported from `typescript`, resolved by the graph to repository interfaces of the same name
  (`src/core/adapters/typescript/angular-metadata.extractor.ts:371,388`). 585 edges have no position (references to
  constants with `line = null`), 284 are receiver inferences of the graph (a local root, target in another file, confidence
  0.7-0.9).

Java (`spring-petclinic-microservices`): the store holds 352 import nodes and 28 `imports` edges, none from an import
node. `describeFile` and `createJavaProject` (`src/core/adapters/spring/java-symbols.ts:163,222`) settle all 352
statements: 43 single imports name a repository type (with its file), 1 wildcard names a repository package, 224 name
a platform package (`isPlatformName`), 57 another package no source declares, 27 static or wildcard imports outside the
snapshot. Over the 554 unresolved references of Java methods, 254 are rooted at an imported or project type, 100 at a
name the file declares, 145 at a local, field or parameter, and 55 (9.9%) at a capitalised name no import binds
(`Builder` of an imported outer type, `HashSet` under a `java.util.*` wildcard).

**Decision D2.** Part B is viable. The binding table moves the share of declarations whose every outside name is
settled from 21% to 96% on TypeScript. On Java the table must come from `java-symbols`, never from the graph (28 of 352).

### 2.4 M3: edge cases, on a fixture

Fixture: `src/lib/defs.ts` (named, interface, type, constant, default class), `src/lib/barrel.ts`
(`export { original as renamed }`, `export *`, `export * as defsNs`), `src/lib/defaultFn.ts` (default function),
`src/feature/use.ts` importing in every form, `tsconfig.json` with `"paths": {"@lib/*": ["src/lib/*"]}`, manifest
dependencies `zod`, `lodash`. Indexed with the same engines.

| Form | Graph gives | Binding table ends as |
|---|---|---|
| `import { original as local }` | edge at `local` → `defs.ts#original` | repository, declaration `original` |
| `import Widget from` (repository default) | edge → **file** node only | repository file; declaration from the target file's `export default` declaration name (D3), else unknown |
| `import * as defs` | edge → file node | repository file; namespace binds the module, `defs.original` settles by member name in that file (B) |
| `import type { Shape }`, `{ type Kind, LIMIT }` | edges, not marked type-only | repository declaration, `typeOnly` from syntax |
| `import { renamed }` from a barrel | edge → `defs.ts#original` | repository declaration through the re-export; file `barrel.ts` kept as written |
| `import { original as viaStar }` through `export *` | edge → `defs.ts#original` | repository declaration through the re-export |
| `import { LIMIT as aliasLimit } from "@lib/defs.ts"` | file edge (confidence 0.7) + declaration edge | repository declaration; the resolver honours `paths` (below) |
| `import { z } from "zod"`, `import unused from "lodash"` | unresolved `imports` references | external `zod`, `lodash` (listed even when unused) |
| `import fs = require("node:fs")` | nothing | external `node:fs` (today `bind` drops it, `import-origins.adapter.ts:198`) |
| `import "./side.ts"` | file edge at column 0 | repository file, no binding |
| `export { LIMIT as reLimit } from` in the file | edge at the property name | re-export binding with its declaration |
| `export *`, `export * as ns from` | nothing | repository file, binding `*` with no declaration |
| `import("../lib/defaultFn.ts")` | nothing | dynamic form, repository file, no binding |
| `require("../lib/defs.ts")` | file edge at the call | `require` form, repository file, no binding |
| `import("…")` type node | nothing | type-query form, file or package |

Nothing is omitted: a form either resolves or is a module statement whose target is `unresolved` with the resolver's
reason. Trust: the resolver reads the snapshot's nearest `tsconfig`/`jsconfig` (`paths`, `baseUrl`, `extends`) in both
modes, as `RFC-0002` rule 4 and `RFC-0016` (line 16) allow: configuration that interprets content. `ADR-0010` decision
2 forbids only engine configuration (`codegraph.json`, `.codegraph/`) and the repository's own manifest under
`untrusted`; no change is needed.

### 2.5 M4: answer size

Rendered with the real `renderOutline` (`src/mcp/render.ts:1044`) over `ye-ast outline` output, Part A simulated as
one line per target with `name:line` per binding. Tokens ≈ bytes / 4 (no tokenizer was run).

| File | `summary` today | with Part A | Part A block |
|---|---:|---:|---:|
| `src/core/application/outline/outline.ts` | 822 B | 1,281 B | 747 B |
| `src/mcp/render.ts` | 6,241 B | 7,875 B | 2,950 B |
| `src/composition/compose.ts` | 4,533 B | 6,872 B | 5,302 B |
| `src/core/application/impact/impact-queries.ts` | 4,338 B | 7,213 B | 4,914 B |

Part B, one `uses:` line per focused declaration without use-site lines, over the 2,095 declarations: p50 117 B, p90
371 B, p99 953 B, max 4,483 B (`composeQueries`, 70 distinct uses); distinct uses p50 3, p90 11, max 70. No bound is
proposed: nothing measured calls for one.

Sample (Part A, `outline.ts`):

```
    imports:
      src/core/domain/impact/importers-fact.ts: NOT_DECLARED_KINDS:22, sortedUnique:53
      src/core/domain/shared/declaration-tree.ts: branchesOf:41, declarationPath:46, declarationTree:23, innermostAt:66, selectedBySymbol:54, type DeclarationBranch:12
      src/core/ports/code-graph.port.ts: type CodeGraphReader:90, type GraphSymbol:49
```

Sample (Part B, `compose.ts` `ownEntrypoint` 274): `uses: fileURLToPath (node:url); join (node:path); dirname (node:path); extname (node:path)`.

## 3. Decisions

| # | Decision | Evidence |
|---|---|---|
| D1 | Syntax owns bindings; the graph edge at the same `(line, column)` adds the declaration | 2.2: 4,808 of 4,808 static bindings joined, 0 ambiguous |
| D2 | Part B is built; Java bindings come from `java-symbols` | 2.3: 21% → 96%; Java 352 of 352 vs 28 |
| D3 | **One owner** for the syntactic reading of module statements: today two adapters parse them (`module-dependencies.adapter.ts:45-81` per statement, `import-origins.adapter.ts:189-205` per binding). The bindings are added to `ModuleDependency` (`src/core/domain/impact/module-dependency.ts:8`) and `import-origins` derives its name → specifier map from the same helper | AGENTS.md "One owner per fact"; placement question 1 |
| D4 | B lists names bound outside the body (imports, same-file declarations, own members, globals); a member call on a local value is not a B item, and the answer says so in its description | 2.3: local roots are 56% of calls; receivers are trace slice 2 |
| D5 | A graph edge whose syntax root is bound to a package is not a repository use in B; the binding wins | 2.3: 22 contradicted edges (`ts.X` homonyms) |
| D6 | Incompleteness is the fact's `partial` status with `unresolved-link` cuts grouped by name per declaration (`at` lists every place), never a per-item marker | owner rule; 2.3: unknown roots cluster on few names (`Buffer`, `process`) |
| D7 | No `SCHEMA` bump and no schema-history entry; the outline value's `imports` changes shape in place | owner rule (no MCP consumers yet); the trace plan's "schema minor bump" (`2026-11-06-trace-outbound-walk.md:151,199`) and branch `7b4dc72` (`SCHEMA = "0.22.0"`) conflict with it and are reported, not followed |

## 4. Design

### 4.1 The binding table (Part A, phase 2)

Domain, `core/domain/impact/module-dependency.ts` (the statement type already lives there):

```ts
export interface ModuleBinding {
  /** The name this file uses; absent for `export *`. */
  local?: string;
  /** The exported name it takes: a name, `default`, or `*` for a namespace. */
  imported: string;
  line: number;
  /** 1-based column of the local name (of the property name in `export { a as b } from`), where the graph writes it. */
  column: number;
  typeOnly: boolean;
}
// ModuleDependency gains: bindings: readonly ModuleBinding[]; form gains "require" and "import-equals".
```

The adapter (`module-dependencies.adapter.ts`) fills `bindings` for import, `import x = require`, and re-export
statements; `import-origins` builds its map from the same helper (`adapters/typescript/import-bindings.ts`, new, used by
both). For a repository default import the adapter also reports the target file's `export default` declaration name
when it is a named declaration (`ModuleBinding.exportedAs`), because the graph only reaches the file node (2.4).

Application, `core/application/navigation/import-bindings.ts` (shared, Q2 of the trace plan): joins a file's
dependencies with its graph `imports` edges by `(line, column)` and returns, per binding, the declaration
(`GraphSymbol`) or nothing. Pure join rule (same position, target not the file node; for a default, the symbol of
`exportedAs` in the target file) in `core/domain/relations/import-binding.ts`.

Outline fact (`core/domain/outline/outline-fact.ts`), replacing `imports: readonly string[]`:

```ts
export interface OutlineImport {
  line: number;
  endLine: number;
  specifier: string;
  kind: "import" | "reexport";
  form?: "dynamic-import" | "type-query" | "require" | "import-equals";
  typeOnly: boolean;
  target: ModuleTarget;
  bindings: readonly OutlineBinding[];
}
export interface OutlineBinding {
  local?: string;
  imported: string;
  typeOnly?: true;
  /** The declaration the binding reaches, through re-exports; absent when it binds a module (`*`) or is not proven. */
  declaration?: { file: string; name: string; kind: string; line: number; endLine: number };
}
```

A repository binding whose declaration is not proven makes the fact `partial` with one `unresolved-link` cut
`{at: ["<file>:<line> <local>"], reason: "unresolved"}`; on this repository that count is 0 (2.2). An `unresolved`
target is already explicit in `target`.

### 4.2 Part B (phase 3, focus only)

Per focused declaration, only the exact matched node (named nested functions own their uses; anonymous callbacks are
already attributed to the encloser by codegraph, trace plan 3.1 step 1):

1. Graph edges `outgoingEdges([node], [calls, instantiates, references, extends, implements])` minus `isIgnoredEdge`
   (`src/core/domain/impact/edge-policy.ts`), keeping each edge's `confidence`.
2. Unresolved references of the node not suppressed by an edge at the same occurrence (`sameOccurrence`, trace
   `call-place.ts:40`, shared).
3. Each settles by its root, read with the reference-occurrence helpers of `adapters/typescript` (the `ImportOrigins`
   port gains the syntax-root fallback of 2.3): package import → external; repository import → the join's declaration,
   and for a namespace root the member by name in that file; same-file top-level declaration; `this`/`super` → own
   member through `GraphNavigation` (trace `navigation/graph-navigation.ts`); global; local → not an item (D4); else a
   cut (D6). Java: the same port answered by `java-symbols` (Q1 of the trace plan places Java binding readers in
   `adapters/spring/`).
4. Items dedupe by target with a relation set; each keeps its use sites `{line, column}` distinct from the target's
   `{file, line, endLine}`; order by first use site's line then column, unplaced uses last (583 `references` edges have
   `line = null`).

`OutlineFocus` gains `uses?: readonly OutlineUse[]`: present means evaluated (an empty list is "uses nothing outside
its body"), absent means not evaluated (whole-file listing). Type references follow B's own policy (they are uses,
not calls), which is why B does not reuse trace's call expansion, only its acquisition, occurrence matching and
binding resolution.

## 5. Phases and tasks

Route: inline unless stated; tests through the public seam (`OutlineQueries.outline`, the adapters' ports, the MCP
server), one rule each; break proof per AGENTS.md "Testing".

### Phase 1: this plan (done on this branch)

### Phase 2: binding table and Part A

| Task | Content | Placement | Tests (one rule each) |
|---|---|---|---|
| A1 | Shared statement helper; `ModuleDependency.bindings`, `require`/`import-equals` forms; `import-origins` reads the helper (no behavior change: `import x = require` becomes bound, a fix) | `adapters/typescript/import-bindings.ts`, `module-dependencies.adapter.ts`, `import-origins.adapter.ts`, `domain/impact/module-dependency.ts` | per form of 2.4 through `ModuleDependenciesReader.extract`; alias keeps both names; inline `type` is type-only per binding; default export name of the target; `import x = require` binds through `ImportOrigins.origins`; impact suites stay green; differential `impact` and `importers` run before/after on this repository (identical bytes) Done: `1360680`. |
| A2 | The join, by `(line, column)` | `domain/relations/import-binding.ts`, `application/navigation/import-bindings.ts` | join reaches the declaration through a re-export alias; a file edge never becomes a declaration; a default import takes `exportedAs`; no edge → no declaration Done: `6ffa90b`; the named-declaration fallback generalized in `4a167e8`. |
| A3 | Outline Part A: `OutlineImport[]`, cut per unproven repository binding; `head.sources` passed to the reader | `domain/outline/outline-fact.ts`, `application/outline/outline.ts`, `outline-queries.ts`, `composition/compose.ts` (inject the reader) | through `OutlineQueries.outline` on a fake graph + real reader: package, repository with declaration, unproven → `partial` with the cut, dynamic import listed with its file, side-effect listed with no binding Done: `9f067bf`, `8407866`; Java statements from `java-symbols` in `4a167e8`. |
| A4 | MCP: output schema (`src/mcp/server.ts:248`, `imports: strings` → object shape), `renderOutline` (`render.ts:1056`) and its `full` guide (`render.ts:1045`), tool description (`server.ts:60,578`) | `mcp/` | schema accepts the new shape and rejects the old; summary text shows `target: name:line` per binding; `full` guide names the fields Done: `9f067bf`. |
| A5 | Compose: `outline-import` file dependencies from repository targets (`composition-normalize.ts:521-525`), plus a declaration anchor per proven binding so compose can join it with `callers`; schema parts and fixtures (`composition-schema-parts.ts:198`, `composition-fixtures.ts:192`) | `mcp/composition-*` | normalization keeps one file dependency per repository target; a proven binding anchors its declaration; reconstruction (`composition-normalize.test.ts`) round-trips; an external target creates no file part Done: `9f067bf`. |
| A6 | Docs: AGENTS.md command list unchanged; README/site outline description; no schema history entry (D7) | docs | structural readback Done: `9f067bf`. |

Risk: item 3 (contract others consume: the outline value shape and the MCP output schema change), item 1 not touched
(no stored data). A1 gets its own commit (shared parser of `impact` and `importers`).

As built (phase 2):

- `require` of a string literal stays an `untraversed` reference (impact does not follow it) and now carries
  `specifier` and `target`; the outline lists it with form `require`. `ModuleDependency.form` gains only
  `import-equals`, and module impact's `via` never carries it, so `impact` and `importers` answers are unchanged
  (differential runs before/after, identical bytes).
- `import x = require` binds `*` (the module itself) and now binds its name in `ImportOrigins`.
- `ModuleBinding.exportedAs` is the name syntax proves the target file declares the binding under: the default
  export's declaration (TypeScript) or the imported type or member (Java); the join uses it when no edge is at the
  binding's position.
- Java: `adapters/spring/java-imports.adapter.ts` answers the same `ModuleDependenciesReader` port from
  `java-symbols`; the outline reads every reader's statements. A wildcard of a repository package is `unresolved`
  with that reason, since a target is one file.
- A runtime reference named by a computed expression is listed with no specifier and an `unresolved` target.
- A requested file the index holds but no module reader read (or could not parse) carries a `no-extractor` cut.
- Open: codegraph holds no node for a Java `record`, so an import of a repository record keeps no declaration and
  makes the outline `partial` with its `unresolved-link` cut (`spring-petclinic-microservices`: `OwnerDetails`).

Review fixes (phase 2):

- `exportedAs` is a dotted containment path from the target file's top level, matched whole against the graph's
  containment tree: the default export's name (TypeScript), or the Java type's fully qualified name, then the member
  for a static import (codegraph holds a Java package as the namespace that contains the file's types). A member the
  named type only inherits, or one of a nested type ending the same, reaches no declaration and stays an
  `unresolved-link` cut.
- A `require` call in a file that binds a `require` of its own (any scope, or an import) keeps its specifier and gets
  an `unresolved` target; the check reuses `declaredNames`, file-wide, so it never resolves a shadowed call.
- Any reader `unread` entry of a requested file (`no-extractor` too, e.g. `import A = N.Member`) is a `no-extractor`
  cut.
- The imports of one line come in source order: static statements now carry `offset` like runtime references.
- `ModuleDependenciesReader.extract` takes an optional `files` selection: the outline reads the statements of the
  requested files only, resolved against every source; the Java reader parses the project only when a selected file is
  Java. `impact` and `importers` pass none. Outline of `src/mcp/render.ts` on this repository, warm: 1.19–1.21 s before,
  1.05–1.10 s after, of which about 0.7 s is CLI startup.
- `ModuleTarget` lives in `domain/shared/module-target.ts`.

### Phase 3: Part B in focus (after trace slice 1 is on `main`)

| Task | Content | Placement | Tests |
|---|---|---|---|
| B1 | Syntax-root fallback and per-place origins in `ImportOrigins` (namespace member, `this`) | `adapters/typescript/import-origins.adapter.ts`, `ports/import-origins.port.ts` | `ts.Expression` roots at `ts`; `f(x).g` at `f`; `new Set(a).add(k)` at `Set` (closes the 21-place residue) |
| B2 | `focusUses(node)`: acquisition, occurrence suppression, settling, dedupe, order | `application/navigation/declaration-uses.ts` (shared with trace), rules in `domain/outline/outline-uses.ts` | one per row of 4.2: ignored synthesizer absent; edge suppresses its reference; package root external; repository import reaches the declaration; contradicted edge settles external (D5); own member; local not listed; unknown name → one cut with every place; dedupe with relation set; order with unplaced last; exact node only (nested named function's uses absent) |
| B3 | Java answers of the same port from `java-symbols` | `adapters/spring/` | single import repository type; platform and other package external; wildcard repository package; unbound capitalised name is a cut |
| B4 | Fact, render, schema, compose for `uses` | `domain/outline`, `mcp/` | evaluated-empty vs absent; text `name → file:line (relations)`; compose anchors each repository use |
| B5 | `.dependency-cruiser.cjs` `one-query-family-never-imports-another` (`:50-56`) covers `outline` and `trace` | config | `npm run arch:check` fails on a planted `outline → trace` import (break proof, not committed) |

Accepted by: per-rule tests; on this repository the share of focused declarations with a `complete` answer recorded
beside 2.3 (target: the measured 96%, not a gate); sizes of 2.5 re-measured with use sites.

As built (phase 3):

- B1: `ImportOrigins.rootBindings` (`adapters/typescript/import-origins.adapter.ts`) reads the whole chain written at a
  use's place, whichever of its names the index placed the use at, and binds its first name: a value name through the
  binder (ADR-0029, the same resolver `rootOrigins` uses), a type name through the type scopes around it (type
  parameters, `infer`, mapped-type keys, type declarations of enclosing blocks), then the file's imports, its top-level
  declarations and the language globals; `super` through its class's `extends` expression. Each site names the
  declaration whose body writes it (its name and lines); a binding whose declarations lie inside that declaration's
  syntax is `local`, and any other declared binding carries the lines its names are written on and whether every
  declaration is a value (a parameter, a variable or a catch binding) of a function, which the binder's visibility
  places around the use (`captured`). A site may be placed at any name of its chain, past its calls (a resolved edge
  sits at the callee's start and names the member it reaches). A member of a namespace import is the declaration the
  module exports under that name, followed through renames, `export … from`, `export *` and re-exported imports by the
  adapter's declaration lookup (`located`); a module that exports no such name, or two, leaves it `unknown`, never a
  private homonym the module declares.
- B2: the acquisition shared with trace is `application/navigation/declaration-uses.ts` (`followed`, `referencesFrom`,
  `ownMembers`, `unsettledBy`); trace reads it, and its answers are byte-identical before and after (differential on
  four targets). `usesOf` settles every edge through `EdgeTargets.verdictsOf` (D5) and every reference no edge records at
  its place through `rootBindings`; an edge whose root `rootBindings` answers as a local value (the body's own, or a
  captured local root) is no use either (D4 holds for resolved edges as for unresolved references), and a repository
  import the join reaches no declaration of is a cut; the grouping and the cuts are `domain/outline/outline-uses.ts`. A declared binding
  settles in order: the single node of its name whose lines hold a line its name is written on is a use (the index
  stores no name column, and every node's lines hold its own name, whatever decorators, modifiers or line breaks precede
  it); with no such node, a captured value is a local root and not a use (D4; a parameter of the encloser, `deps` in
  `createXQueries(deps)`, was the largest residue before this rule); anything else (a function, class or type
  declaration the index misses, a value of the file's top level, an ambiguous match) is a cut. Nesting in the focused
  body is the graph's `contains` tree, never line spans. Java answers `local` for the locals and type variables inside
  the focused declaration; its local lookup stops at the type body, so it never answers a captured value.
- Reading the sources: settling needs the snapshot's sources, not only the focused file (the resolver checks which files
  exist and reads `tsconfig` and manifests; the `ambient` proof needs every source that may declare a global), so a
  focus reads the head's sources as a listing does; the Java-record scan still reads only the focused files.
- B3: `adapters/spring/java-root-bindings.ts`, joined to the TypeScript reader in composition by file. A name only a
  wildcard import could supply stays unknown, since `java.lang` may supply it too, even when a source declares it in the
  wildcard's package.
- B4: `OutlineFocus.uses`; the text prints one line per use, `name → file:line (relations; at lines)`, a package or a
  global otherwise, and "uses nothing outside its body" when evaluated empty and no use of it is unproved (an
  `unresolved-link` cut anchored at it; `hasUnprovedUses`, shared by the outline text and compose's part); compose
  anchors each repository use on the focused declaration's part. The tool description points to `ye_ast_compose` for callers.
- B5: `one-query-family-never-imports-another` covers `outline`; a planted `outline → trace` import fails
  `npm run arch:check` (break proof, not committed).
- Measured on this repository at `bcc73fa`, every non-test function, method and constructor focused by its start line
  (2,616 declarations): 95.8% complete (109 with a cut, 157 unproved places). The residue: Node globals the TypeScript
  library does not declare (`Buffer` 40, `process` 10, `NodeJS.ProcessEnv` 7, kept unknown per Q3) and `this` members
  the index holds no node of (constructor parameter properties, inherited members; 30). Uses per declaration p50 3, p90
  10, max 86.
- Re-measured after the review corrections, same 2,631 declarations at `bcc73fa`: 95.2% complete (125 with a cut;
  `b7976aa` 95.0%, 131). The D4 rule on resolved edges removed 415 listed uses, every one a repository member reached
  through a local value (`io.out`, `deps.redaction.redact`).
- Known limits, not extracted or not decided by this part: a static member's `this.target()` may settle to an instance
  homonym; `super.load(1)` does not pick among overloads; a static import shadowed by a local declaration; enum-member
  reads, `typeof` queries, getter reads, field increments and annotations are not uses the index records.

## 6. Risks

- Item 3: the outline shape and MCP output schema change in place (D7); every consumer in this repository is updated
  in the same commit (`server.ts`, `render.ts`, `composition-normalize.ts`, fixtures).
- A1 touches the parser `impact` and `importers` share; the differential runs guard it.
- D5 shows the graph resolves `ts.X` type references to repository homonyms. `impact` follows those edges today: a
  possible false impact, reported here for a separate decision, not fixed by this plan.
- Part B on TypeScript is `partial` for about 4% of declarations, mostly Node globals; that is honest and named by cut.

## 7. Open questions, with recommended answers

| # | Question | Recommendation |
|---|---|---|
| Q1 | Part A in `summary` or only in `details`? | `summary`: the bindings are the request; measured cost +26-66% on the sampled files (2.5) |
| Q2 | Show the declaration line of each binding in text? | Yes, `name:line`: it is what lets an agent open the span without another query |
| Q3 | Node globals (`Buffer`, `process`) without reading `@types/node`? | Keep them unknown; a vocabulary would be a guess no source of the snapshot proves |
| Q4 | Mark imports nothing uses? | No: it needs scope analysis; B makes use visible per declaration |
| Q5 | Report D5 contradictions in `impact`? | Yes, as a separate task after phase 2, with its own measurement |
| Q6 | Where B's helper lives if trace slice 1 changes `navigation/` | `navigation/`, extended in place; never a copy inside `outline` |
