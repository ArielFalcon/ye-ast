# RFC-0025: Angular route tables are read wherever the router receives them

- Status: Accepted, 2026-11-09. Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (every open question settled as recommended; see Resolved questions). ADR-0047 records its decisions.
- Reproductions: kept with the study run outside the repository (`evaluations/runs/20261108T2245Z-agent-usefulness-12f8/engine-gaps/designs/rfc-0025-angular-route-tables/repro`).
- Engine baseline: every `path:line` below was re-checked on `main` `ebd12a4f` (ADR-0045 L2, L3 and L5a landed).
  Reproductions were taken on `6d21e7bc`; the two route readers did not move between the two commits.
- Related: [RFC-0007](../rfc/0007-extension-model.md) (extension model, row A1 of the Angular plugin, Conformance),
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) (coverage grows only with evidence),
  [ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md) (Angular and Spring from own extractors, decision 7),
  [ADR-0042](../adr/0042-completeness-is-relative-to-the-question.md) (completeness is relative to the question; cuts
  carry a reason and a reach; decision 6, frontier versus enumerated item),
  [ADR-0045](../adr/0045-one-assembly-line-for-the-snapshot-reading.md) (the assembly line; decision 12, B11 framework
  readers and framework plugins),
  [RFC-0002](../rfc/0002-facts-contract.md) (facts contract), [RFC-0006](../rfc/0006-configuration.md) (configuration and
  the export budget), [RFC-0010](../rfc/0010-impact-queries.md) and [RFC-0013](../rfc/0013-trace-and-patterns.md)
  (both read entrypoints and inherit their answers)

**In short:** the Angular route reader treats a route table as reachable only when a `RouterModule.forRoot` /
`provideRouter` table names it, or a `loadChildren` written as a dynamic `import()` names it. Everything else — the
`forChild` tables an `@NgModule` composes, the legacy `<path>#<Module>` string, and every table the caller's `include`
did not export — is reported as `unknown`. The proposal replaces that with one rule: the router configuration is a graph
that is read from the places the Angular router is configured and walked along exactly the edges Angular walks
(`children`, spread, table references, `loadChildren` in every form, `@NgModule({ imports })`), composing each table's
full path from the graph, never from a file name or a folder layout. A narrowing `include` then narrows what the family
reports, never the configuration that interprets the selected files, and a route reference the sources do not resolve is
a place the walk stopped: an `unknown` item and a cut with a reason and a reach.

## Problems

One class, three mechanisms. All workspace paths are relative to `RUN/ws/<workspace>/<repo>/`.

| Mechanism | Study items | Symptom (asked → answered, oracle) | Workspace evidence |
|---|---|---|---|
| M1 the legacy string `loadChildren` is not followed | `N-shopizer-TS-ROUTES.A1-N1`, `.A2-N1`, `.B1-N1`, `.B2-N1`, `CF-shopizer-TS-ROUTES` (5) | asked which route shows the login screen → `unknown (unresolved)` at `app-routing.module.ts:8`, `3 known, 121 unknown` → oracle: `/auth/login` | `shopizer/admin:src/app/app-routing.module.ts:8` (`loadChildren: "app/pages/auth/auth.module#AuthModule"`), `:11-15` (`"app/pages/pages.module#PagesModule"`), table behind it at `src/app/pages/auth/auth-routing.module.ts:10-24` |
| M2 an `@NgModule({ imports })` composition is not followed | `N-PETCLINIC-TS-IMPACT.B2-N2`, `CF-PETCLINIC-TS-ROUTES` (2, and the 4 petclinic `callers` items that ask for the route) | asked what reaches `owner-list.component.ts:48` → `reached entrypoints (0)`; the route never exists → oracle: `ui-route /owners` | `petclinic/frontend-angular:src/app/app.module.ts:46,54` (`OwnersModule`, `AppRoutingModule`), `src/app/owners/owners.module.ts:39`, `src/app/owners/owners-routing.module.ts:31-41` |
| M3 a narrowing `include` exports the selected files but not the configuration that interprets them | `N-JHIPSTER-TS-ROUTES.A2-N1`, `N-nname-TS-ROUTES.A1-N1`, `.A2-N1`, `.B2-N1` (4) | asked for the routes of the entities / the restaurant feature → `0 known, 12 unknown` and `0 known, 6 unknown`, status `complete (N undecided)` → oracle: the selected routes with their full paths | `jhipster/application:src/main/webapp/app/app.routes.ts:27-30` (the root table the include drops), `nname/name-webapp:src/app/core/router/app.routes.ts:39` (`loadChildren: userFeature.loadChildren`), `src/app/core/config/app.config.ts:68-72` (`provideRouter(routes)` with `routes` imported through `@core/router` at `:22`) |

M2 and M1 are one theme — *a table the walker cannot reach* — and three mechanisms: M1 misses a reference form, M2
misses a composition edge, M3 removes the files. A fix for one does not fix the others; on `shopizer`, resolving the
string form alone still leaves `auth-routing.module.ts` unreached, because `AuthModule` owns no router call and only
imports the routing module that does.

The condition the study graded is reproduced below and in `repro/answers.md` on `main` at `6d21e7bc`.

## Root cause

All three live in the route readers: `src/core/adapters/typescript/angular-routes.adapter.ts` (the walk),
`src/core/adapters/typescript/route-table.loader.ts` (the graph), `src/core/adapters/typescript/angular-router.extractor.ts`
(the per-file reading), plus the export selection the map family applies before any of them.

### M2 — only a `loadChildren` reaches a table; an `@NgModule` composition is invisible — **confirmed**

`route-table.loader.ts:304-317` builds the roots: the table of every `routerConfigs` entry whose `kind` is `root`, i.e.
`RouterModule.forRoot` or `provideRouter` (`angular-router.extractor.ts:349-359`). `route-table.loader.ts:318-325` marks
everything reachable from those roots through `loads`, and `loads` is filled in exactly one place —
`route-table.loader.ts:285`, when a `RouteEntry` has a `childRef` that came down to one table. A `childRef` is set only
by `children` naming a table (`:278-287`), a spread (`:305-311`), or `loadChildren` (`:295-299`).

Nothing reads `@NgModule({ imports: [...] })`. `moduleTableOf` (`:189-194`) maps a class to the router call *inside its own
decorator* and returns `undefined` otherwise; `childTableOf` (`:196-211`) uses it only after a `loadChildren` named the
class. `readAngularRouteFile` (`angular-router.extractor.ts:130-374`) records `routerConfigs[].owner` — the enclosing
class of the call (`:360-372`) — and nothing else about the module class.

So `OwnersRoutingModule`'s `forChild` table is built as a `RawTable` (`:302`) but no root reaches it, and
`angular-routes.adapter.ts:44` hands it to `unreachedRoutesOf` (`:62-68`), which reports one `unknown` per entry with
`no-extractor` when no unresolved reference exists or `unresolved` when one does (`:65`). In `petclinic` there are no
unresolved references at all, so the reason is `no-extractor`: the answer says "this reader does not read this", which
is true but names no cause and loses 20 real routes.

Reproduction `repro/p1-petclinic-entrypoints.json` → `3 known, 20 unknown`, status `complete (20 undecided)`.

### M1 — `lazyOf` requires a dynamic `import()` with a static specifier — **confirmed**

`angular-router.extractor.ts:187-204`: `lazyOf` takes the initializer, follows a local binding one level
(`x` or `x.loadChildren` where `x` is a top-level `const`, `:189-190`), collects every `import()` call in it
(`:192-200`), requires **exactly one** (`:201`) whose argument is a string literal (`:202`), and answers `undefined`
otherwise. `entryOf` turns `undefined` into `{ unresolved: true }` (`:296-299`), `refOf`/`childTableOf` answer nothing
for it (`:196-197`), and `build` records `unresolvedLoad` and a reference (`route-table.loader.ts:278-286`).

The legacy form `loadChildren: "app/pages/auth/auth.module#AuthModule"` contains no `import()` at all, so the module and
the export it names are never looked at. `AngularProject` (`angular-projects.ts:8-13`) carries no source root, so even a
reader that wanted to resolve the path could not place it: the string is relative to the CLI project's `sourceRoot`
(`shopizer/admin/angular.json`, `projects["shopizer-admin"].sourceRoot = "src"`), not to the importing file.

Reproduction `repro/p3-shopizer-entrypoints.json` → `3 known, 121 unknown`; the two references at
`app-routing.module.ts:8` and `:11-15` are `unknown (unresolved)` and every one of the 121 items carries all 19
unresolved references as evidence.

### M3 — the export selection is computed without the reading the extractor performs — **confirmed**

`entrypoint-queries.ts:57` computes `exportSelection(scope, deps.matcher.matches, isExtractorConfiguration)` and
`:59` prepares the commit over it; `read-snapshot.ts:219` then calls `deps.extractor.extract(tree.sources)`, i.e. the
extractor sees only the files that predicate wrote. `exportSelection`
(`core/domain/shared/scope.ts:25-33`) keeps `selected(path) || (configuration(path) && kept(path))`, and
`isExtractorConfiguration` (`core/domain/languages/configuration.ts:13-15`) is a **path** predicate: `package.json`,
`tsconfig*`, `angular.json`, JVM build files, Spring config, contract documents.

A route configuration is not a path predicate. `angular-routes.adapter.ts:28` groups the files it was given by nearest
Angular manifest and `:30` loads route tables only from those. With the root table not exported, `declared` is false
(`route-table.loader.ts:306-317`), `roots` is empty (`:318`), every built table is `unreached` (`:329`) and
`noRoot = "unresolved"` (`angular-routes.adapter.ts:43`) renames every entry: the answer is `0 known, N unknown`, where
`N` is exactly the number of route entries in the selection. Reproduced for three repositories; `repro/p2`, `p4`, `p5`.
The same repositories answer completely without a scope: `repro/p6` (`75 known, 0 unknown`), `repro/p7`
(`45 known, 0 unknown`). The reading is not broken; the input is truncated.

The status line already prints `scope: include … (the content it selects; the configuration that interprets it is read
too)` (`src/mcp/presentation-context.ts:84`), which is true of `tsconfig.json` and false of the route configuration.

## Reach

The same mechanisms, searched over the whole `src/` (the broad form of each rule, not one repository):

1. **Every table that no `loadChildren` names, in every Angular repository.** `unreachedRoutesOf`
   (`angular-routes.adapter.ts:62-68`) is the single place that renames them, so every repository whose modules compose
   routes eagerly (the `@NgModule` style, still what `ng generate module --routing` emits for NgModule projects) loses
   them: a `forChild` table is named only by luck, when a `loadChildren` in the same repository happens to name the class
   that owns it. Variants produced beyond `petclinic`: a `forChild` table in a module imported by a lazily loaded module
   (should be `/lazy/child`, is `unknown`); the same table registered at the root and lazily (two prefixes); a table
   reached through a barrel; a module class re-exported under another name.
2. **Every `loadChildren` form that is not one static `import()`.** `lazyOf` (`angular-router.extractor.ts:187-204`) is
   the only reader of a lazy reference, and `loadComponent` shares it (`:283-286`), so the same gap covers the legacy
   string, a string held by a `const`, a specifier built by a template literal, and any `.then` whose export is not a
   plain property access (destructuring, `await`, a helper that returns a module). `refOf`
   (`:216-222`) adds a second: a reference written as a call **with** arguments is `no-extractor`.
3. **Every extractor whose input is a graph.** `exportSelection` is applied by both `entrypoints` paths
   (`entrypoint-queries.ts:33` live, `:57` revision) and nothing else: `map` is the only family that exports with a
   configuration predicate. The mechanism — *the export predicate must cover the closure the reader interprets* — is
   general, but the evidence covers only Angular routes; this RFC narrows the fix to the Angular reading and states the
   general shape as an ADR (see "Decisions to record").
4. **Every family that consumes `ui-route` entrypoints**: `callers`, `impact` and `trace` reach a route's component
   through the map (`src/core/domain/impact/reached-entrypoints.ts:23-45`, which joins a `ui-route` to its `component`
   and to its guards; `src/core/application/trace/trace-queries.ts:237`). Each recovered route makes those answers wider
   without a change of their own — the petclinic `callers` items of the study are half this RFC and half the *details
   view* RFC.
5. **Nothing outside the Angular plugin.** `spring-routes.adapter.ts`, the TypeScript call-site and relations readers,
   and the `entrypoints` answer shape are untouched.

## Design

### The rule

> **A route table is read wherever the Angular router receives one.** The reader starts at every place the router is
> configured and follows exactly the edges Angular follows, composing each table's path from the graph.

No file name, folder name, `-routing.module` suffix, `*.routes.ts` pattern or directory depth decides anything.

### Nodes and edges (the graph Angular builds)

| Node | Read from |
|---|---|
| **Root configuration** | a `RouterModule.forRoot(...)` call, or a `provideRouter(...)` call, anywhere in the project (`angular-router.extractor.ts:349-359`, unchanged) |
| **Bootstrap module** | the class a `bootstrapModule(X)` call names, wherever that call is written |
| **Module class** | a class the Angular metadata reading reports as `kind: "module"` (`AngularClass`, `core/domain/relations/angular-class.ts:11-16`), with the `imports` operands it already resolved |
| **Route table** | an array the reader already recognizes (`angular-router.extractor.ts:104-106,325-347`) |
| **Route entry** | an object with `path` (or `matcher`) and one route key (`:86-102`) |

| Edge | Angular's meaning | Direction and prefix |
|---|---|---|
| root configuration → its table | the router is configured with it | seeded at prefix `/` |
| bootstrap module → a module its `imports` names | the module is loaded in the root injector | same prefix, `/` |
| module → a module its `imports` names | same injector as the importer | same prefix |
| module → a table its own decorator registers with `forChild` | registered in this module's injector | same prefix |
| route → `children` (inline, a table by name, a spread) | child routes | parent path + entry path |
| route → `loadChildren` (module class or table) | child injector created at this route | parent path + entry path |
| route → `loadComponent` | the component shown | the entry itself |

**Path composition.** A table inherits the path of the route that loads it: at the root, nothing; beneath a route,
that route's full path. A `forChild` table is inherited from its **module graph**, which is why a `forChild` table
inside a module a lazy route loads is served under that lazy route (`/auth/register`), while a `forChild` table in the
root module graph is served from `/` (`/owners`). Two registrations of one module graph (root and lazy) yield two route
sets: Angular creates two injectors, so both are true, and `sortFindings` keeps both because their paths differ.

**One aggregate per module graph.** The loader folds a module and everything its `imports` reach into one `RouteTable`
node holding the entries of every `forChild` table of that graph, in a fixed order: the module itself, then its
`imports` in source order, depth first, each module class once (an array a spread names is expanded in place). The aggregate is what a `loadChildren` naming the module
class resolves to and what a bootstrap module seeds; the existing walk then needs no new edge for prefix composition.

### Placement on the ADR-0045 assembly line

- **Stage B11, framework readers**, in the **Angular framework plugin** over the TypeScript pack (ADR-0045 decision 12;
  RFC-0007 row A1; ADR-0014 decision 7). No new stage kind, no new pack, no new port for the framework: the reader keeps
  living in `core/adapters/typescript/` beside the TypeScript pack, reads the pack's parsed reading, and contributes
  entrypoints.
- **One owner for `@NgModule({ imports })`: `angular-metadata.extractor.ts`.** The declaration's `imports` list is read
  by `readAngularMetadataFile(sf, shape)` (`angular-metadata.extractor.ts:121`), which already answers it as
  `RawAngularClass.imports: RawOperand[]` for `kind === "module"` (`:20-27`, `:198`) and whose adapter resolves it to
  `AngularClass` (`angular-metadata.adapter.ts:205-221`, the port `AngularMetadata.classes`,
  `core/ports/angular-metadata.port.ts:9-22`). The route reader **consumes that output** and never reads the decorator:
  it calls the same function, once per file, for the two things the route graph needs — the `imports` operands of each
  module class and the file's top-level arrays (`RawAngularFile.arrays`, `:113`, which a spread in `imports` names).
  `core/ports` and `core/domain` are untouched by this: the consumption crosses two modules of the **same** adapter
  folder, which is what the dependency rule allows (an adapter may not import *another adapter*; it may share modules
  inside its own). The cycle is type-only: `angular-metadata.extractor.ts` imports `RawRouteFile` as `import type`
  (`:3`), which the compiler erases, so the route reader's runtime import of `readAngularMetadataFile` creates no runtime
  cycle, and the arch rule sees a `typescript → typescript` edge inside one adapter.
- **`bootstrapModule(X)` is the route reader's own fact.** It is not a decorator reading, no other reader reads it, and
  the route extractor already walks call expressions for `RouterModule.forRoot` / `provideRouter`
  (`angular-router.extractor.ts:360-372`); the same walk records the booted class, so nothing is duplicated.
- Module resolution stays the existing `module-resolver.ts` (B2b after ADR-0045 L1), and declaration lookup the
  existing `declaration-lookup.ts`; the new edges use them, they do not replace them.
- **Cost, stated**: the map family now pays the Angular metadata reading of every TypeScript file it was given, where
  today only relations (`impact`, `trace`) pay it. ADR-0045's B11/B4 sharing turns both into one derivation; until then
  the cost is bounded by the parsed-once-per-read rule (`recoveredModuleShape`) and is measured by the corpus gate.
- **ADR-0042 decision 6** is what makes the new cut correct: a route reference the walk cannot cross is a *frontier*
  (what lies beneath it is enumerated nowhere), so it is a cut **and** an `unknown` item at its span.

### Contracts

#### `src/core/adapters/typescript/angular-router.extractor.ts`

```ts
/** A class a `bootstrapModule(...)` call boots. */
export interface RawBootstrap {
  className: string;
  module?: string;
  imported?: string;
  line: number;
  endLine: number;
}

export interface RawRouteFile extends ModuleShape {
  // … every existing field unchanged …
  /** The classes the file boots, in source order; empty when it boots none. */
  bootstraps: RawBootstrap[];
}
```

Reading rule, exact: **`bootstrapModule` detection.** A `CallExpression` whose callee is a property access named
`bootstrapModule` (whatever its base: `platformBrowserDynamic()`, `platformBrowser()`) and whose first argument unwraps
to an identifier → one `RawBootstrap` from that identifier's binding. `bootstrapModuleFactory(...)` is **not** read (its
argument is a factory, not a class) and produces no `RawBootstrap`. The route reader adds **no** reading of
`@NgModule`, its `imports` list or any decorator: that fact has one owner, below.

#### `angular-metadata.extractor.ts` — consumed, never re-read

The route reader imports `readAngularMetadataFile` and uses two of its answers, both already produced today:

```ts
// src/core/adapters/typescript/angular-metadata.extractor.ts, unchanged
export function readAngularMetadataFile(sf: ts.SourceFile, shape: Pick<RawRouteFile, "imports">, proveMembers = false, coreExternal = true): RawAngularFile;
export interface RawAngularFile {
  /** Its `@NgModule` classes, by class name, with the operands of each decorator's `imports` list. */
  classes: RawAngularClass[];          // kind === "module" → imports: RawOperand[]   (:20-27, :198)
  /** The top-level arrays of this file, by name, read as lists of operands. */
  arrays: Map<string, RawOperand[]>;   // (:113)
}
```

The projection the loader receives is declared by the loader (next section) and built by the adapter as
`readAngularMetadataFile(tree, raw).classes.filter((c) => c.kind === "module")` plus `.arrays`, verbatim: the operands
are **not** re-derived. `RawOperand` is `{ reference: RawReference; line } | { unreadable: true; line }` (`:14`), and
`operandsOf` (`:154-161`) already expands an array literal, follows a spread one step (it answers the identifier the
spread names, which the loader expands through `arrays`), and reduces `Module.forRoot(...)` to `Module`. The
`angular-metadata.extractor.ts → angular-router.extractor.ts` back-import is `import type` at `:3`, erased by the
compiler.

#### `src/core/adapters/typescript/angular-projects.ts`

```ts
export interface AngularProject {
  directory: string;
  dependencies: ReadonlySet<string>;
  packages: ManifestPackages;
  /**
   * The repository-relative directories a legacy `loadChildren` path is relative to, longest first: the workspace
   * file's `sourceRoot` for the project that holds this directory, then the project directory itself. Empty when no
   * workspace file above declares one.
   */
  legacyRoots: readonly string[];
}
```

Read from the nearest `angular.json` above the manifest (`isAngularWorkspace`,
`core/domain/languages/typescript.ts:44`), as data: `projects[*].sourceRoot`, keeping the projects whose `root` is the
project directory or an ancestor of it, and resolving `sourceRoot` against `root`. A file that does not parse, a
`projects` map that declares none, or a repository that carries no workspace file (the legacy `.angular-cli.json` is not
read: no evidence calls for it) leaves `legacyRoots` empty, and the string form then stays unresolved (F3b); nothing
throws.

#### `src/core/adapters/typescript/route-table.loader.ts`

```ts
/** What the Angular metadata reading states about one file, projected to what the route graph needs. */
export interface AngularModuleReading {
  /** Its `@NgModule` classes, in source order, with the operands of each decorator's `imports` list. */
  modules: readonly { name: string; line: number; imports: readonly RawOperand[] }[];
  /** Its top-level arrays, by name: what a spread in an `imports` list names. */
  arrays: ReadonlyMap<string, readonly RawOperand[]>;
}

/** One file, parsed once: its route reading and its Angular module reading. */
export interface RouteFileReading {
  routes: RawRouteFile;
  modules: AngularModuleReading;
}

export interface RouteTableInputs {
  /** The files that seed the walk. `read` and `reading` may reach any path the export holds: a legacy string, a barrel
   * and a lazily loaded module need not be candidates. */
  candidates: readonly string[];
  read: SourceReader;
  packages: ManifestPackages;
  /** The one reading of a file, memoized by the caller; `undefined` when the file does not parse. */
  reading(file: string): Promise<RouteFileReading | undefined>;
  /** The roots a legacy `loadChildren` path is relative to, longest first. */
  legacyRoots: readonly string[];
}

export interface LoadedRouteTables {
  /** The tables the router is configured with and the module graphs the application boots, in file and line order. */
  roots: RouteTable[];
  declared: boolean;
  unreached: RouteTable[];
  unparsed: string[];
  /** Every `loadChildren`, `children`, spread and root configuration that does not come down to one table, sorted. */
  unresolvedReferences: UnresolvedReference[];
  /** The root configurations among them, with why each is unresolved. */
  unresolvedConfigurations: Array<UnresolvedReference & { reason: UnknownReason }>;
  /** Every `@NgModule` import that does not come down to a module class, or whose graph holds an `unreadable` operand, sorted. */
  unresolvedModuleImports: UnresolvedReference[];
}

export async function loadRouteTables(inputs: RouteTableInputs): Promise<LoadedRouteTables>;
```

The function's four positional parameters (`route-table.loader.ts:83` on `ebd12a4f`: `candidates, read, packages,
parseSource?`) become one record: the loader gains inputs, and a fifth positional parameter is a signature no reviewer
should have to read twice. `parseSource` is replaced by `reading`, so a file is parsed once for both the route table and
the module composition. The single caller (`angular-routes.adapter.ts:35-38`) and the tests change with it.

#### `src/core/ports/entrypoint-extractor.port.ts`

```ts
export interface EntrypointExtraction {
  /** Sorted by evidence location, then kind and name (RFC-0002 rule 2). */
  findings: readonly Finding<Entrypoint>[];
  /** Where the reading stopped without reaching what lies beyond (ADR-0042 decision 6); absent when it reached every place. */
  cuts?: readonly Cut[];
}

export interface EntrypointExtractor {
  extract(files: readonly SourceFile[], libraries?: readonly LibrarySource[]): Promise<EntrypointExtraction>;
}
```

A frontier cannot be an item (ADR-0042 decision 6: "an enumerated item is never also a cut; a frontier is always a
cut"), and the map fact already carries cuts (`entrypoint-map.ts:83-90`), so the extractor must be able to answer one.
`Findings` alone cannot carry it.

#### `src/core/application/snapshot/read-snapshot.ts`

```ts
export interface CommitExtraction {
  export: CommitExport;
  sources: readonly SourceFile[];
  findings: readonly Finding<Entrypoint>[];
  /** Where the extractor's reading stopped: the map's cuts, never an answer of another family. */
  readingCuts?: readonly Cut[];
}
```

`extractSources` (`:213-221`) spreads `extraction.cuts` into `readingCuts`; `impact` and `trace`, which read
`tree.findings` (`src/core/application/impact/impact-queries.ts:396`, `src/core/application/trace/trace-queries.ts:196`),
are untouched. **Retention must carry the cuts, or a cached snapshot answers `complete` where its reading stopped**:
`keepFindings` (`src/core/application/snapshot/prepared-snapshot.ts:39`) becomes
`keepExtraction(sources: readonly SourceFile[], extraction: EntrypointExtraction): void`, `SnapshotData`
(`read-snapshot.ts:62-67`) gains `readingCuts?: readonly Cut[]`, and the two callers
(`prepared-snapshot.ts:144`, `live-snapshot.ts:73`) and the retained branch (`prepared-snapshot.ts:112`) pass it
through.

#### `src/core/domain/map/entrypoint-map.ts`

```ts
export function buildEntrypointMap(base: MapBase, findings: readonly Finding<Entrypoint>[], exported: MapExport, readingCuts: readonly Cut[] = []): EntrypointMapFact;
```

The cuts of the reading are added to the export's cuts (`exportCuts`, `:96-110`) and deduplicated by place, so the same
span never appears twice. `entrypoints` asserts `everything` (ADR-0042 decision 3), so no `inQuestion` work is needed:
every cut stays.

#### `src/core/application/entrypoints/entrypoint-queries.ts`

```ts
/** What a narrowing `include` and an `exclude` keep out of the map's reading: a route configuration is not a path predicate. */
function mapReading(scope: DeclaredScope, matches: (path: string, glob: string) => boolean): PathSelection;
```

Returns `(path) => isExtractorConfiguration(path) || (scope.include.length > 0 && isTypeScriptSource(path))`, and the
existing `kept` excludes apply through `exportSelection`. Both `map` paths (`:33` live, `:57` revision) use it. After
extraction, findings are filtered by the **caller's** selection:

```ts
const selected = pathSelection(scope, deps.matcher.matches);
const findings = extracted.value.findings.filter((finding) =>
  finding.evidence[0] === undefined ? false : selected(finding.evidence[0].path));
```

The reading cuts take the same filter, by the place they name (`cut.at[0]` is the file of the reference):

```ts
const reading = extracted.value.readingCuts?.filter((cut) => cut.at[0] !== undefined && selected(cut.at[0])) ?? [];
```

A finding's own span is where it is declared; a reference is never the reason a finding is kept or dropped. With an
empty `include` and no `exclude`, `pathSelection` selects every path and both filters are the identity. `exportCuts`
are **not** filtered: they describe the export, and the widened export adds only `isTypeScriptSource` paths, which are in
map scope and readable, so no new export cut can appear.

### Algorithm

1. **Group the files** by nearest Angular manifest (unchanged, `angular-projects.ts:49-62`), carrying `legacyRoots`.
2. **Read each file once** through `RouteTableInputs.reading`: the route reading (unchanged) and the Angular module
   reading projected from `readAngularMetadataFile` (`classes` filtered to `kind === "module"`, plus `arrays`).
3. **Index the module classes** by `<file>\0<Class>` → its `imports` operands, and by `<file>\0<Class>` → the
   `forChild` tables its own decorator registers (`routerConfigs` filtered by `kind === "child"` and `owner === Class`).
4. **Build a module aggregate** for a class, memoized by `<file>\0<Class>`:
   - visit the class: append the entries of each `forChild` table it owns, in source order, building each once
     (`tableNode`);
   - resolve each operand of its `imports` list to a class: `{ reference: { name, member } }` → with `member`
     undefined, `nameDeclaration(file, raw, { name })` (local class, imported class, barrel — the existing ladder);
     with `member` set, the module the namespace is bound to, then `member` there; a reference naming a top-level array
     of the file (`arrays`) is expanded in place, each array once; an operand that names `@angular/router`'s
     `RouterModule` is skipped (it is a router configuration, read by `routerConfigs`); `{ unreadable }` marks the
     aggregate `partial`;
   - recurse depth first in source order, each class once;
   - **fail closed**: if any class in the visited graph has an `unreadable` operand, the aggregate is *not* built and
     the reference goes to `unresolvedModuleImports` at the class's line (what the graph could hold is unknown, and
     answering "no routes" would be a false complete).
5. **Resolve every `childRef`** (`childTableOf`, unchanged ladder) with two additions:
   - a reference that names a **module class** answers its aggregate, not only the class's own single configuration;
   - a reference whose specifier is the **legacy string form** `<path>#<Export>` resolves the path against
     `legacyRoots` in order (`<root>/<path>.ts`, then `<root>/<path>/index.ts`), keeping the first existing file, and then
     resolves `<Export>` in that file: a class → its aggregate; a `Routes` constant → its table. No existing file → the
     reference is unresolved, once, at its span.
6. **`lazyOf` accepts every form that names one module and one export statically**: exactly one `import()` with a
   static specifier, reached through any chain of `await`, parentheses, a `.then` or `.ROUTES` body, a destructuring
   `.then(({ routes }) => routes)`, or a local binding. Zero or several `import()` calls, or a dynamic specifier, answer
   `undefined` (unresolved).
7. **Collect the roots**, in this order, deduplicated by node:
   - every `root` configuration's table, in file and line order;
   - every bootstrap class's aggregate, in file and line order.
   `declared` is true when at least one of either exists.
8. **Walk** (unchanged, `angular-routes.adapter.ts:85-136`): each root at `segments: []`; a table reached as an
   entry's children or spread or `loadChildren` inherits the entry's segments; a cycle answers `unknown (unresolved)` at
   the reference (`:98,134`).
9. **Renaming**: a table no root reaches keeps today's treatment (`unreachedRoutesOf`, `:62-68`) — an item per entry
   that shows a component, never silence.
10. **Cuts**: one cut per unresolved place, deduplicated by `path:line:endLine`:
    - a `loadChildren`, `children` or spread reference, and a root configuration, that does not come down to one table →
      `{ kind: "unresolved-link", at: [path, `${path}:${line}`], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } }`;
    - an `@NgModule` import that resolves to no module class, or whose graph holds an `unreadable` operand →
      `{ kind: "unresolved-link", at: [path, `${path}:${line}`], reason: "specifier", reach: { kind: "module", importer: path, specifiers: [{ specifier, namesNoFile: true }] } }`
      (`namesNoFile` only when no path of the snapshot could be its target, the resolver's own answer).
11. **Determinism**: aggregates follow source order (module, then `imports` in source order, depth first); roots follow
    the sorted candidate order the loader already uses (`route-table.loader.ts:295`) and line; cuts and references are
    sorted; `sortFindings` (`finding-order.ts:8-14`) sorts and deduplicates findings. Paths stay repo-relative, and no
    index-internal id enters a fact.

### What does not change

- Answer shapes: `Entrypoint`, `UiRoute`, `Cut`, the map envelope and the MCP schemas. The `entrypoints` tool text gains one
  sentence in U4; no schema changes.
- The `name`/`path` convention of a `ui-route` (`ui-route.ts:13-28`) and the rule that a redirect is not an entrypoint.
- `callers`, `impact`, `trace`, `importers`, `outline`, `contract_consequences`, `workspace`, `decisions`: no edit, no
  status change except where a recovered `ui-route` widens what they reach.
- The Spring reader, the TypeScript call-site, relations and dynamic-load readers, and the `no-project` /
  `source-unreadable` handling.
- Reading a repository's own code: nothing is built or run; only `.ts` files are parsed.

## Delivery units

| # | Behaviour | Files (create / edit) | Depends on | Size (authored lines, est.) | Corpus gate |
|---|---|---|---|---|---|
| U1 | the reader consumes the one `@NgModule` reading and reads the booted class | `angular-router.extractor.ts`, `route-table.loader.ts` (inputs and the two reading types), `angular-routes.adapter.ts` (the projection); new `angular-router.modules.test.ts` | — | ~200 | none (no observable change) |
| U2 | a module graph is walked; a `forChild` table is named under its real prefix | `route-table.loader.ts`, `angular-routes.adapter.ts`; tests in `angular-router.modules.test.ts` | U1 | ~380 | `<entrypoints>:+` |
| U3 | every `loadChildren` form, the legacy string included, resolves or names one unsupported construct | `angular-router.extractor.ts`, `angular-projects.ts`, `route-table.loader.ts`; tests | U1, U2 | ~340 | `<entrypoints>:+` |
| U4 | a route reference the walk cannot cross is an `unknown` item **and** a cut with a reason and a reach | `entrypoint-extractor.port.ts`, `angular-routes.adapter.ts`, `entrypoint-map.ts`, `entrypoint-queries.ts`, `read-snapshot.ts`, `prepared-snapshot.ts`, `live-snapshot.ts`, `compose.ts`, `spring-routes.adapter.ts`, the 12 doubles over 10 test files that answer `extract: async () => []`; tests | U2, U3 | ~280 | `<entrypoints>:±` |
| U5 | a narrowing `include` selects the question; the route configuration is read whole, and only routes declared inside the selection are reported | `entrypoint-queries.ts`, `presentation-context.ts` (one line), `configuration.ts` (doc), a new scope fixture, docs | U2, U3 | ~300 | `<entrypoints>:+` |

`<entrypoints>` is the family id the corpus manifest gives `ye-ast map` / `ye_ast_entrypoints`; the manifest lives
outside the repository, so the unit states the direction and the reviewer substitutes the id. U1 -> U2 -> U3 is a
dependency chain; U4 and U5 are independent of each other and both land after U3.

**Seam order (lead decision, 2026-11-09).** U4 changes `EntrypointExtractor.extract` to answer
`EntrypointExtraction`. It lands **before RFC-0026 U3**, which adapts `spring-routes.adapter.ts` to the new port: that
unit appends its callbacks to `findings` and returns `{ findings: [...callbacks], cuts: [] }`. `spring-routes.adapter.ts`
is in U4's file list only for the mechanical `{ findings }` return; RFC-0026 owns every later change to it.
**U5 lands before RFC-0029 U5**, and the split is: U5 owns *"an `include` selects the question; the configuration
needed to read route tables is read whole, and only routes declared inside the selection are reported"*; RFC-0029 U5
owns *"an `include` that selects no file is a fault"* and reads the **caller's** `pathSelection`, never
`CommitExport.files`, for `unmatchedIncludes` and the selected-file count. U5 also filters the reading cuts with the
caller's selection (its own unit text, and step 10 of the design), so a place outside the selection never turns a
narrowed answer `partial`.

### U1 — the reader consumes the one `@NgModule` reading and reads the booted class

- **Prerequisites**: none. Nothing outside the three files changes, and no answer moves.
- **Files**: edit `src/core/adapters/typescript/angular-router.extractor.ts` (`RawBootstrap` and its detection, ~50
  lines), `src/core/adapters/typescript/route-table.loader.ts` (`AngularModuleReading`, `RouteFileReading`, the
  `RouteTableInputs` record, ~60 lines), `src/core/adapters/typescript/angular-routes.adapter.ts` (build the projection
  from `readAngularMetadataFile`, ~30 lines); create `src/core/adapters/typescript/angular-router.modules.test.ts`
  (~80 lines). **Must not touch** `angular-metadata.extractor.ts`, `angular-metadata.adapter.ts`,
  `core/domain/relations/angular-class.ts` — the `@NgModule` fact has one owner and this unit only consumes it — nor any
  other adapter.
- **RED test 1** (`angular-router.modules.test.ts`,
  `test("the class a bootstrapModule call boots is read, and bootstrapModuleFactory is not")`): through
  `parseAngularRouteFile`, the source
  `import { AppModule } from './app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\nbootstrapModuleFactory(factory);`
  asserts `bootstraps` deep-equals
  `[{ className: "AppModule", module: "./app.module", imported: "AppModule", line: 2, endLine: 2 }]`, and no
  `bootstrapModuleFactory` entry. It fails today because `RawRouteFile` has no `bootstraps`.
- **RED test 2** (`test("the module composition is projected from the Angular metadata reading, never re-read")`): the
  projection function is exported for the test (`modulesOf(raw: RawAngularFile): AngularModuleReading`) and called with
  a `RawAngularFile` literal whose `classes` holds
  `{ kind: "module", name: "OwnersModule", line: 3, imports: [{ reference: { name: "OwnersRoutingModule" }, line: 4 }, { unreadable: true, line: 5 }], declarations: [], exports: [] }`
  and whose `arrays` is empty. Assertion: the answer deep-equals
  `{ modules: [{ name: "OwnersModule", line: 3, imports: [{ reference: { name: "OwnersRoutingModule" }, line: 4 }, { unreadable: true, line: 5 }] }], arrays: new Map() }`.
  It fails today because the projection does not exist. **The expected value is the operand list the owner produced**,
  so no fixture has to reproduce the decorator's resolution rules — the shape the review's finding 1 required.
  Variant beyond the observed case: `test("a spread in imports projects the identifier the owner answered")` — an
  operand `{ reference: { name: "SHARED" }, line }` is projected verbatim, proving the route reader does not interpret
  spreads itself.
- **GREEN**: both RED tests pass; `npm run check` green; every existing test of `angular-routes.adapter.test.ts`
  unchanged and green.
- **Corpus gate**: `none` — no answer can change, because the walk does not read the projection until U2.
- **Docs**: none yet (the behaviour lands in U2).
- **Risk**: none.

### U2 — the module graph is walked, and a `forChild` table is named under its real prefix

- **Prerequisites**: U1.
- **Files**: edit `route-table.loader.ts` (the module index, the aggregate builder, the bootstrap seeds,
  `unresolvedModuleImports`, ~200 lines), `angular-routes.adapter.ts` (~15 lines: the `reading` call site; the cut is
  *not* built here until U4). Tests: extend `angular-router.modules.test.ts` with the behavioural
  fixtures below (~170 lines). **Must not touch** `angular-router.extractor.ts` beyond U1, `entrypoint-extractor.port.ts`,
  `entrypoint-map.ts`, `entrypoint-queries.ts`.
- **RED tests** (through `createAngularRoutesExtractor().extract`, the port seam), each a fixture repository:
  - `test("a forChild table a module composes is named at the root")` — F1 of the conformance list. Fails today:
    `names()` is `[]` and `unknowns()` carries one `no-extractor` per entry.
  - `test("a forChild table inside a lazily loaded module graph is named under the lazy route")` — F2. Fails today for a
    different reason: `childTableOf` answers the lazily loaded class's *own* configuration only, so a graph whose only
    configuration sits in an imported routing module answers no table.
  - **Variant beyond the observed case**: `test("a module graph registered at the root and loaded lazily yields both prefixes")` — F9.
- **GREEN**: the three tests pass; the petclinic probe `repro/p1` becomes `23 known, 0 unknown` (`/owners`,
  `/owners/add`, `/owners/:id`, `/owners/:id/edit`, `/owners/:id/pets/add` and the other four features' tables); every
  other existing route test unchanged.
- **Corpus gate**: `<entrypoints>:+` — answers gain `ui-route` findings; no status may go the wrong way (`partial` →
  `complete` is possible for a repository that had no unresolved reference; `complete` → `partial` is not, because U2
  adds no cut).
- **Docs**: `docs/architecture/rfc/0007-extension-model.md` row A1 of the Angular plugin gains "`@NgModule({ imports })`
  composition from the bootstrap module and from every lazily loaded module"; the `angular-routes.adapter.ts` header
  comment gains the graph sentence; `src/mcp` tool text unchanged.
- **Risk**: none. Item 6 does not apply: F1, F2, F9 and F11 fail without the change.

### U3 — every `loadChildren` form resolves, or names one unsupported construct

- **Prerequisites**: U1, U2 (the legacy string names a module class, whose routes live in its graph).
- **Files**: edit `angular-router.extractor.ts` (`lazyOf`, ~40 lines), `angular-projects.ts` (`legacyRoots`, ~40
  lines including the workspace reading), `route-table.loader.ts` (the legacy resolution and `unresolvedModuleImports`,
  ~50 lines); tests ~170 lines. **Must not touch** the Typescript call-site reader, `dynamic-loads.adapter.ts` (it reads
  `require`/`import()` as *loads*, a different fact), `module-resolver.ts`.
- **RED tests**:
  - `test("the legacy <path>#<Export> form resolves through the workspace source root")` — F3. Fails today: no
    `import()` in the initializer, so `unresolved`.
  - **Variant beyond the observed case**: `test("the legacy form whose export names a Routes constant resolves to its table")` —
    F3c. Fails today for the same reason; it covers the second thing an export can name, which no workspace of the study
    shows.
  - Guards (they pass today and must keep passing): F5, the helper/`await`/destructuring forms that `repro/p6` and
    `p7` prove; F3b, the string form with no source root, which stays `unresolved`.
- **GREEN**: the two RED tests pass and the two guards stay green; the shopizer probe `repro/p3` names the
  `/auth/...` and `/pages/...` routes; the `legacyRoots` of a repository without a workspace file are empty and the
  reference stays `unresolved` (F3b).
- **Corpus gate**: `<entrypoints>:+`.
- **Docs**: RFC-0007 row A1 gains the legacy string form and the helper/await forms; the adapter's header comment names
  the forms it reads and the one it does not (`no-extractor` for a reference written as a call with arguments).
- **Risk**: none.

### U4 — a frontier is a cut with a reason and a reach

- **Prerequisites**: U2, U3 (they produce the places).
- **Files**: edit `src/core/ports/entrypoint-extractor.port.ts` (the `EntrypointExtraction` type),
  `src/core/adapters/typescript/angular-routes.adapter.ts` (return the cuts, ~40 lines),
  `src/core/adapters/spring/spring-routes.adapter.ts` (return `{ findings }`, 1 line; RFC-0026 U3 later grows it),
  `src/core/domain/map/entrypoint-map.ts` (`readingCuts`, deduplicated),
  **`src/core/application/entrypoints/entrypoint-queries.ts`** (pass `extracted.value.readingCuts` to
  `buildEntrypointMap` at both call sites, `:41` live and `:66` revision — without this the cuts never reach the fact
  and the GREEN probe cannot pass),
  `src/core/application/snapshot/read-snapshot.ts` (`CommitExtraction.readingCuts`, `extractSources`, `SnapshotData`),
  `src/core/application/snapshot/prepared-snapshot.ts` (`keepExtraction`, and the retained branch at `:112` that rebuilds
  `extracted` from the cache) and `src/core/application/snapshot/live-snapshot.ts` (the retained branch at `:41` and the
  write at `:73`), `src/composition/compose.ts:160-166`; the **12** doubles over **10** test files that answer
  `extract: async () => []` (mechanical: `extract: async () => ({ findings: [] })`), including
  `src/composition/mixed-workspace.testing.ts` if it holds one; tests ~90 lines. **Must not touch** `Cut` itself
  (`fact.ts`) — no new reason or reach member is needed — nor `pathSelection`, `exportSelection` or `exportCuts`, nor the
  two `spring-routes.adapter.ts` answer paths RFC-0026 U3 owns.
- **RED test**: `angular-router.modules.test.ts`, `test("a loadChildren the sources do not resolve is an unknown item and one cut")`
  — F6. Assertion: one `unknown (unresolved)` at `app.routes.ts:<line>`, and
  `cuts` deep-equals `[{ kind: "unresolved-link", at: ["src/app/app.routes.ts", "src/app/app.routes.ts:7"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } }]`.
  Fails today: `extract` answers findings only.
  Variant beyond the observed case: `test("an @NgModule import that names no file is one cut with the module reach")` — F7.
  Second variant: `test("the same place never yields two cuts")` — a root configuration that is both an unresolved
  reference and an unresolved configuration.
- **GREEN**: the tests pass; `npm run check` green; the shopizer probe `repro/p3` reports
  `partial (cuts: 2 unresolved-link dynamic-load)` instead of `complete (121 undecided)` alone; a repository with no
  frontier keeps `complete (N undecided)`.
- **Corpus gate**: `<entrypoints>:±` — cuts appear, so statuses move in both directions; the report is reviewed
  answer by answer, and the gate blocks a `complete` → `partial` move that is not a frontier (no other family may move).
- **Docs**: RFC-0002 rule 2 note (the map can carry a reading cut); the MCP status line already renders reasons
  (`src/mcp/presentation-context.ts`), so only the `entrypoints` section of the tool text gains "a route reference the
  sources do not resolve is listed as unknown and as a cut".
- **Risk**: item 3 — `EntrypointExtractor` is a port the composition and every family test double consume. One commit,
  one purpose, and the port's doc comment states the shape. It lands before RFC-0026 U3 (seam order above).

### U5 — a narrowing `include` narrows the answer, not the configuration

- **Prerequisites**: U2 and U3 (the widened reading still reaches nothing on the observed repositories without the
  module graph; the standalone `provideRouter` form alone would pass the nname and jhipster probes, but the unit is one
  behaviour and lands after both).
- **Files**: edit `src/core/application/entrypoints/entrypoint-queries.ts` (`mapReading`, the findings filter **and the
  reading-cut filter** in `map` and `mapLive`), `src/core/domain/languages/configuration.ts` (the doc comment of
  `isExtractorConfiguration` says why a route configuration is not there),
  `src/mcp/presentation-context.ts:84` (the one scope string, so it stops saying the reading is only "the content it
  selects"); `src/core/application/entrypoints/entrypoint-queries.test.ts` (the filter, with a fake extractor and a fake
  matcher); a new fixture under `os.tmpdir()` for the end-to-end scope assertion. **Must not touch** `pathSelection`,
  `exportSelection`'s signature, the VCS port, `exportCuts`, `isInMapScope`, and nothing RFC-0029 U5 owns
  (`unmatchedIncludes`, the selected-file count, the `unknown-scope-path` fault).
- **RED test**: `entrypoint-queries.test.ts`, `test("a narrowing include reports the selected routes with their full paths and drops the others")` —
  F10: a temporary repository (written under `os.tmpdir()`, committed nowhere) with `package.json` naming
  `@angular/core`, `angular.json`, `src/main.ts` booting `AppModule`, `app.module.ts` importing two feature modules,
  `owners-routing.module.ts` with `forChild([{ path: 'owners', component: OwnerList }])` and
  `pets-routing.module.ts` with `forChild([{ path: 'pets', component: PetList }])`. Call `map` with
  `scope: { include: ["src/app/owners/**"] }`. Assertion: one finding, `ui-route /owners`, and no `/pets`; status
  `complete`. Fails today: `0 known, 5 unknown`.
  Variant beyond the observed case: `test("an exclude still wins over the framework reading")` — the same fixture with
  `exclude: ["src/app/owners/routes/**"]` reports nothing from that directory and no cut claims it was read.
- **GREEN**: the two tests pass; the probes `repro/p2`, `p4`, `p5` name the selected routes with their full paths. The
  reading cuts are filtered with the same `selected` predicate as the findings (`cut.at[0]`), so an unresolved
  `loadChildren` in a file the caller did not select never turns a narrowed answer `partial`. **No export cut can appear
  from the widening**: it adds only `isTypeScriptSource` paths, which `isInMapScope` accepts (`entrypoint-map.ts:43`) and
  `cutsCompleteness` classifies as readable, so `exportCuts` (`:96-110`) answers exactly what it answered before.
- **Corpus gate**: `<entrypoints>:+` — the scoped answers gain routes; the reading cost rises for a narrowed Angular
  scope (see Risks).
- **Docs**: RFC-0006 (what a narrowing `include` keeps out), RFC-0002 rule 4 (what completeness is relative to), and the
  status-line string in `presentation-context.ts`.
- **Risk**: none. Item 6 does not apply (F10 and F11 fail without it), and the `scope` argument is narrowed, never widened:
  the caller's selection still bounds the answer.

## Conformance fixtures (RFC-0007)

Every fixture is a minimal repository and its expected facts, seen failing first. Rows F1–F9, F11 and F12 are in-memory
sources through `createAngularRoutesExtractor().extract` (no filesystem); F10 writes a repository under `os.tmpdir()`
because it exercises the export.

| # | Row | Fixture | Expected |
|---|---|---|---|
| F1 | A1 NgModule composition | `app.module.ts` imports `OwnersModule`; `owners.module.ts` imports `OwnersRoutingModule`; `owners-routing.module.ts` has `forChild([{path:'owners', component: OwnerList}])`; `main.ts` boots `AppModule` | `ui-route /owners` at the entry's span |
| F2 | A1 lazy module graph | `forRoot([{path:'auth', loadChildren: () => import('./auth/auth.module').then(m => m.AuthModule)}])`; `AuthModule` imports `AuthRoutingModule` with `forChild([{path:'', children:[{path:'register', component: Register}]}])` | `ui-route /auth/register` |
| F3 | A1 legacy string | F2 with `loadChildren: 'app/auth/auth.module#AuthModule'` and `angular.json` `sourceRoot: 'src'` | same as F2 |
| F3b | A1 negative: no source root | F3 without any workspace file and without a resolvable `src/app/auth/auth.module.ts` | one `unknown (unresolved)` at the reference; no route named (guard: the fail-closed answer today must not change) |
| F3c | A1 legacy string naming a table | F3 with `loadChildren: 'app/auth/auth.routes#AUTH_ROUTES'` and that file exporting the `Routes` constant | the table's routes named under `/auth` |
| F4 | A1 tables by reference | `provideRouter(routes)` where `routes` comes from a barrel, holds `...errorRoute` from another file and a spread of a local table | every entry of both tables named at its full path |
| F5 | A1 lazy forms (guard) | one `loadChildren` each: a helper returning `import()`, `async () => (await import('./x')).ROUTES`, `.then(({routes}) => routes)`, `() => import('./x.module').then(m => m.XModule)` | each subtree named. These resolve on `main` already (`repro/p6`, `p7`): the fixture exists so the rewrite of `lazyOf` cannot regress them |
| F6 | A1 frontier | `loadChildren` whose specifier is a template literal over a variable | one `unknown (unresolved)` at the span **and** one `unresolved-link`/`dynamic-load` cut with reach `anything`/`typescript` |
| F7 | A1 negative: unreadable composition | `@NgModule({ imports: [ pick("x") ? OwnersRoutingModule : OtherModule ] })` naming the table's module — the owner answers `{ unreadable }` for a conditional | the reference stays `unresolved` and one `unresolved-link`/`specifier` cut carries the module reach; no route named (fail closed, never an empty route set) |
| F7b | A1 spread composition | `@NgModule({ imports: [ ...SHARED, OwnersRoutingModule ] })` with `const SHARED = [OwnersRoutingModule]` in the same file | `owners` named once (the array expanded once, not twice) |
| F8 | A1 cycle | `A` imports `B`, `B` imports `A`; each has a `forChild` table | terminates, each table's routes named once |
| F9 | A1 double registration | the same module graph imported by `AppModule` and loaded by a lazy route | both prefixes named |
| F10 | A1 scope | the `os.tmpdir()` repository of U5, `map` with `include: ["src/app/owners/**"]` | `ui-route /owners` only; `/pets` absent; status `complete` |
| F11 | A1 golden rule (negative) | a `forChild` table in a module nothing imports, and a file named `x.routes.ts` that no root reaches | one `unknown (no-extractor)` per entry, never a named route: no file name decides |
| F12 | A1 negative: no Angular manifest | the same sources with a `package.json` naming no Angular package | `[]` (unchanged) |

## Measurement

| Unit | Study items it should close | How to re-check |
|---|---|---|
| U1 | none | `npm run check` |
| U2 | `N-PETCLINIC-TS-IMPACT.B2-N2`, `CF-PETCLINIC-TS-ROUTES`; with the details-view RFC, the four petclinic `callers` items | `repro/p1`: `3 known, 20 unknown` → `23 known, 0 unknown` |
| U3 | `N-shopizer-TS-ROUTES.{A1,A2,B1,B2}-N1`, `CF-shopizer-TS-ROUTES` | `repro/p3`: `/auth/...` and `/pages/...` named; unknown count falls below 20 |
| U4 | none directly: it makes a remaining unknown legible (the shopizer items close in U3) | `repro/p3` carries one `dynamic-load` cut at each reference that is still unresolved, and no answer becomes `complete` while a frontier exists |
| U5 | `N-JHIPSTER-TS-ROUTES.A2-N1`, `N-nname-TS-ROUTES.{A1,A2,B2}-N1` | `repro/p2`, `p4`, `p5`: `0 known` → the selected routes with full paths |

The counterfactuals `CF-petclinic-TS-ROUTES` and `CF-shopizer-TS-ROUTES` are re-run with the same plans, which are
copied into `repro/`.

**Reading cost (U5).** The corpus gate's counters and the prewarm timings are read before and after U5 for the
Angular applications of the corpus; the report states the delta of the export's file count and of the entrypoint
answer's duration. U5 is accepted with the delta measured, not assumed: a narrowed `entrypoints` now exports every
TypeScript source of the repository (resolved question 2). `callers` answers that ask for an Angular route's handler are re-checked with
`repro`-style plans after U2; they are expected to gain a reached `ui-route` and to stay limited by the details-view
mechanism, which is a different RFC.

## Resolved questions

Owner decision, 2026-11-09, verbatim: "Resuelve todas las preguntas abiertas como recomiendes." Each question is closed
with the recommendation it carried; every unit implements that answer and offers no alternative.

| # | Question | Decision |
|---|---|---|
| 1 | Under a narrowing `include`, does `entrypoints` report only the findings declared inside the selection (the reading is wider), or every finding the wider reading produces? | **Only the selection.** The declared scope is the question (ADR-0042 rule 4); reporting `/pets` for `include: src/app/owners/**` would assert beyond it, and the configuration exists only to compute the paths *of what was asked*. U5 filters findings and reading cuts with the caller's `pathSelection`. |
| 2 | Is the widened reading "every TypeScript source of the repository" acceptable, or must it become a content-driven closure (a second export round: parse the roots, ask for the missing paths, materialize only those)? | **The whole TypeScript selection.** A content-driven closure is not part of this RFC: it needs a second `exportCommit` round and a content-derived key for ADR-0031's cache. `entrypoints` already reads every TypeScript source when no `include` is given, so the regression is bounded to narrowed calls on Angular repositories, and U5 carries the measurement. |
| 3 | When a `loadChildren` resolves to a module whose graph holds no `forChild` table at all, is that "no routes beneath" (nothing named) or a reading gap? | **`unknown (no-extractor)` at the reference.** A module with no route table in its whole graph is almost always a composition the reader did not follow, and silence would be a false complete; an application that genuinely has none pays one item. U2 emits it. |
| 4 | Does the route reader follow a spread inside `@NgModule({ imports: [...SHARED] })`? | **Yes, through the owner's answer.** `operandsOf` already reduces a spread to the identifier it names (`angular-metadata.extractor.ts:157`) and `RawAngularFile.arrays` already reads a file's top-level arrays as operand lists (`:113`), so the loader expands the named array, once, with a visited set. An operand the owner answers `{ unreadable }` is never guessed: the graph fails closed (F7). |

## Decisions recorded in ADR-0047

1. **The Angular router's configuration is read as a graph from where the router is configured, never by file name** —
   one narrow decision: nodes are root configurations, bootstrap modules, `@NgModule` classes and route tables, and the
   edges are `children`, spread, table references, `loadChildren` in every form and `@NgModule({ imports })`; a table's
   path comes from the graph.
2. **A narrowing `include` narrows a fact's answer, never the configuration that interprets it** — extends ADR-0042
   rule 4 to a configuration whose closure is not a path predicate: a family may read beyond the selection to interpret
   it, and reports only what the selection covers.
3. **The entrypoint map carries the cuts of its reading** — extends ADR-0042 decision 6 to `entrypoints`: a place where
   the route walk stopped is a cut with a reason and a reach, never only an `unknown` item.

## Risks

- **A false route.** A module aggregate that merges a graph Angular would not merge, or a prefix taken from the wrong
  boundary, names a route that is not served. Mitigations: the aggregate follows only the owner's `imports` operands and
  `forChild`; a graph with an `unreadable` operand fails closed (F7); a module nothing imports is never named (F11).
- **A second owner creeps back.** A later change that parses an `@NgModule` decorator here would recreate the duplicated
  fact the review blocked. Mitigation: U1 asserts the projection verbatim from `RawAngularFile`, and the file list of
  every unit forbids editing `angular-metadata.extractor.ts`.
- **Reading cost.** A narrowed `entrypoints` on an Angular repository now reads every TypeScript source of the
  repository (resolved question 2), and the map pays the Angular metadata reading once per file (Placement). Mitigation:
  measured by the corpus gate's counters and by the prewarm timings; bounded by TypeScript sources, never Java sources
  or templates.
- **A wrong selection filter silently drops a route.** F10 and F11 guard it; the filter reads `evidence[0]` only, and a
  finding without evidence is dropped (never kept by accident).
- **The cut reason is reused, not new.** `dynamic-load` and `specifier` already exist for exactly these situations, so
  no closed union grows; a reviewer who disagrees must add a member in a commit that also emits it (ADR-0042 decision 1).
- **A port change ripples.** U4 changes `EntrypointExtractor`'s answer shape for 12 doubles over 10 test files and the
  composition; it is mechanical and one commit, and the native review takes it alone (Risk item 3).

## Review responses

Against `engine-gaps/designs/review-entrypoints.md`, findings 1–9. Every line re-checked on `main` `ebd12a4f`.

| # | Finding | Response |
|---|---|---|
| 1 | U1 RED fixture cannot produce its expected array | **Fixed.** The fixture is gone: U1 no longer reads the decorator. RED test 2 asserts the projection of a `RawAngularFile` literal verbatim, so the expected value is exactly the owner's output and no fixture reproduces the resolution rules. `angular-metadata.extractor.ts:14` (`RawOperand`), `:20-27` (`RawAngularClass`), `:113` (`arrays`), `:121` (`readAngularMetadataFile`). |
| 2 | U4 omits `entrypoint-queries.ts` and the live retained branch | **Fixed.** U4's file list names `entrypoint-queries.ts` with both `buildEntrypointMap` call sites (`:41` live, `:66` revision) and `live-snapshot.ts` with the retained branch (`:41`) and the write (`:73`), beside `prepared-snapshot.ts:112,144`. |
| 3 | `@NgModule({ imports })` gets a second owner | **Fixed.** The route reader consumes `readAngularMetadataFile`'s output (`classes` filtered to `kind === "module"`, plus `arrays`) and never parses a decorator; `bootstrapModule` is the route reader's own fact because no other reader reads it. Cycle: the back-import is `import type` (`:3`), erased. See "Placement". |
| 4 | RFC-0025 U5 and RFC-0029 D4 disagree about what `include` means | **Fixed by the lead's split, stated in the units preamble.** U5 owns the reading and the reporting; RFC-0029 U5 owns "an `include` that selects no file is a fault" and reads the caller's `pathSelection`, never `CommitExport.files`, for `unmatchedIncludes` and the file count. U5 lands first. |
| 5 | `RouteTableInputs.candidates` reads as an enforced boundary | **Fixed.** The comment now says the candidates seed the walk and that `read`/`reading` may reach any path the export holds (a legacy string, a barrel, a lazily loaded module). |
| 6 | Wrong double count; "five positional parameters" | **Fixed.** 12 doubles over 10 test files; the loader has four positional parameters today (`route-table.loader.ts:83`), and the record is named as the future `RouteTableInputs`. |
| 7 | "tool text" claimed unchanged while U4 changes it | **Fixed.** The invariant now says the tool text gains one sentence in U4 and no schema changes. |
| 8 | U3 says "the three tests pass" over two RED and two guards | **Fixed.** U3 now says the two RED tests pass and the two guards stay green. |
| 10 | U1 duplicates the "is `@angular/core` external" rule | **Accepted as debt, fixed in U2.** `angular-routes.adapter.ts` repeats the flag `angular-metadata.adapter.ts:135-136` computes, because U1's fence forbids that adapter. The values agree today, so no answer differs; they could drift when U2 walks the projection. U2 extends its fence to `angular-metadata.extractor.ts` and consumes one exported `coreExternalOf` from both adapters. Passing the owner default instead would make the projection see modules the owner denies, a false graph U2 would turn into false routes. |
| 9 | U5 leaves reading cuts from outside the selection, so a narrowed answer can be `partial` for a place never asked about | **Fixed.** U5 filters reading cuts with the same `selected` predicate by `cut.at[0]`, and states that no export cut can appear from the widening (`isInMapScope` accepts every widened path, `entrypoint-map.ts:43`). |

Cross-draft seams this draft now states: `spring-routes.adapter.ts` (U4 lands first; RFC-0026 U3 returns
`{ findings: [...callbacks], cuts: [] }`), the `entrypoints` fact's renderers (U4 adds no schema), and `include`
(U5 before RFC-0029 U5, split as above).
