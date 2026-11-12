# RFC-0027: Every callable the source writes is a declaration

- Status: Accepted, 2026-11-09. Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (every open question settled as recommended; see Resolved questions). ADR-0049 records its decisions.
- Reproductions: kept with the study run outside the repository (`evaluations/runs/20261108T2245Z-agent-usefulness-12f8/engine-gaps/designs/rfc-0027-declaration-model/repro`).
- Baseline: engine `main` `d0aee793` (ADR-0045 L2 landed). Every `path:line` below was re-read there.
- Related: ADR-0013 (`docs/architecture/adr/0013-coverage-grows-only-with-evidence.md`), ADR-0029
  (`.../0029-lexical-bindings-from-the-typescript-binder.md`), ADR-0036 (`.../0036-dependence-is-the-compile-time-binding.md`),
  ADR-0041 (`.../0041-one-call-reconciliation-for-every-family.md`), ADR-0042
  (`.../0042-completeness-is-relative-to-the-question.md`), ADR-0044
  (`.../0044-one-implementation-closure-with-scoped-vetoes.md`), ADR-0045
  (`.../0045-one-assembly-line-for-the-snapshot-reading.md`), RFC-0002, RFC-0007, RFC-0010, RFC-0013, RFC-0017,
  [RFC-0024](../rfc-0024-receiver-typed-settlement/rfc.md)

**In short:** today a _declaration_ is only what the codegraph index holds, so callables the source writes — object-literal
members (including the ones a store factory builds), anonymous-class initializers, and the function values that name a
declaration — are invisible to `outline`, unbindable for `trace` and unreachable as `callers`/`impact` targets. The language
packs' B1 stage will declare every callable a source writes, under one joined declaration tree, so each gets a
deterministic dotted path (or a span target when no container is proven) and the same four-family treatment as an index
symbol; a binding the pack cannot prove stays a cut that names the declaration's place, never silence.

## Relation to RFC-0024

RFC-0024 (receiver-typed settlement) owns `CallBinder.memberOf` / `declares` and its `memberOfReceiver`, with a
`GraphSymbol`-based, **asynchronous** contract (`rfc-0024`, §Contracts, `CallBinder`), and its U1–U4 land **before** this
RFC's U1. This RFC **does not change those signatures**. It adds exactly one function to the same port for a holder the
index does not declare, `memberOfDeclaration(holder: ModelDeclaration, member, place)`, implemented by the same owner and
placed by ADR-0045 in the Java/TypeScript packs' B2b. A call whose receiver resolves to an index declaration keeps
RFC-0024's path unchanged; a call whose receiver resolves to a syntax-only declaration reaches the new function. §3b
lists the one addition; nothing else of RFC-0024 is touched.

## Problems

Evidence is read at `RUN/ws/...` pinned shas and reproduced on engine `main` `d0aee793`; the reproduction artefacts are in
`repro/` (plans `ts-store.json`, `java-lambda.json`, `java-anon.json`, `java-relations.json`).

| Item | Symptom | Workspace evidence |
|---|---|---|
| `N-JHIPSTER-J-FLOW.A1-N2`, `.A2-N1` | `trace UserService.getUserWithAuthorities` lists `SecurityUtils.getCurrentUserLogin().flatMap` as `external: unnamed` and never steps into `UserRepository.findOneWithAuthoritiesByLogin`; the agent greps the repository instead. `callers` of that method cannot see the method reference either | `jhipster/application:src/main/java/io/github/jhipster/sample/service/UserService.java:282` (oracle step O3 also needs `AdminUserDTO::new` at `:272`) |
| `N-realworld-J-FLOW.A1-N2`, `.A2-N2`, `.A2-N4` | `trace ArticlesApi.createArticle` reports `callee-unknown: ArticlesApi.java:33 HashMap` and the call `articleQueryService.findById(...)` written inside the anonymous `HashMap` initializer is in no step and in no cut; the response-side read is found by hand | `realworld/backend:src/main/java/io/spring/api/ArticlesApi.java:32-36` |
| `CF-realworld-TS-FLOW` | `trace ArticleListComponent.setPage` steps into nothing: cuts `receiver-unproven (capability-absent)` for `this.articlesListStore.setListPage` and `.loadArticles`, `effects (0)`. `outline` of the store file lists only `ArticlesListStore [constant] 17-102` and `replaceArticle [function] 104-112`; `callers` of `ArticlesListStore.setListPage` faults `unknown-symbol` offering `ArticlesListStore`, `replaceArticle` | `realworld/frontend:libs/articles/data-access/src/articles-list.store.ts:18-92`, `libs/articles/feature-articles-list/src/article-list.component.ts:19,34-37` |
| `N-shopizer-J-BUG.A1-N3` | `callers` of the class `ReadableMinimalProductMapper` answers `status: complete`, `impacted symbols (0)`, although `ReadableShoppingCartMapper` declares a field of that type and calls `merge` on it | `shopizer/backend:sm-shop/src/main/java/com/salesmanager/shop/mapper/cart/ReadableShoppingCartMapper.java:74,134` and `.../mapper/catalog/ReadableMinimalProductMapper.java:29` |

## Root cause

### M1 — A Java function value that names a declaration is recorded as an opaque value, never as a reference

- **Confirmed.** `java-member-names.adapter.ts:54` admits only `method_invocation`, `object_creation_expression` and
  `explicit_constructor_invocation` as written calls; a `method_reference` is instead collected whole by
  `isFunctionValueNode` (`java-function-value-calls.ts:69-71`, `:5`) into `functionValues` (`java-member-names.adapter.ts:49-50`).
  Nothing carries the name `findOneWithAuthoritiesByLogin` to the binder, so no edge, cut or deferred step names it.
- **Reproduction** `repro/java-lambda.json` → `repro/java-lambda.trace.txt`:
  `external: unnamed: SecurityUtils.getCurrentUserLogin().flatMap`, with no mention of the repository method.
- **Why the symptom follows**: `trace-walk.ts:474-485` emits a deferred step only for a written call the index left
  unrecorded; a method reference is not a written call, so the loop never sees it.

### M2 — An anonymous class body owns its calls as a class the walk never visits, and defers them besides

- **Confirmed.** Two rules compound. `java-member-names.adapter.ts:92-93` (`isAnonymousClassBody`) reports the whole
  `class_body` as a function value, and `:49-50` adds it to `functionValues`; and the index declares the anonymous class
  as a nested class (`outline` prints `33-37 <HashMap$anon@33> [class]` under `createArticle [method]`). In
  `callsByOwner` (`reconciled-calls.ts:47-58`), `BODY_KINDS` includes `"class"` (`:13`), so the call at `:35` is owned
  by that nested class, and `executesInBody` (`owning-body.ts:42-44`) marks it `deferred` because it lies inside a
  function-value span. `trace` walks callables, never a class declaration, so the call is in no step and in no cut of
  `createArticle`.
- **Reproduction** `repro/java-anon.json` → `repro/java-anon.trace.txt` and `repro/java-anon.outline.txt`.
- **Java rule it violates**: the instance initializers and field initializers of an anonymous class execute as part of
  evaluating the `new` expression that creates it (JLS 12.5, 15.9.4), in textual order; only its _methods_ run later.

### M3 — TypeScript object-literal and factory-produced members are names, never declarations

- **Confirmed.** The TypeScript reader collects object-literal keys into `names` only
  (`declared-member-names.adapter.ts:95`), and its `callables` are function declarations, class methods and interface
  signatures (`:73-74`, `:93-94`). A property whose value is an arrow or a function expression is pushed as an _owner_
  of calls (`:63-71`) but never as a declaration. `DeclaredCallable`
  (`declared-member-names.port.ts:86-100`) has two line numbers and no span, no kind and no container, so it cannot be a
  tree node either.
- **Reproduction** `repro/ts-store.json` → `repro/ts-store.outline.txt` (two declarations in the file),
  `repro/ts-store.trace.txt` (two `receiver-unproven (capability-absent)` cuts), `repro/ts-store.callers.txt`
  (`unknown-symbol` with the file's two index declarations as candidates).
- Two distinct mechanisms follow from the same absent declaration, and they must not be conflated:
  - the declaration itself does not exist, so no path and no target;
  - the receiver `this.articlesListStore` is a field initialized by `inject(ArticlesListStore)`, not annotated, so the
    receiver-binding rule (`declared-member-names.port.ts:30-38`: "`this.r` is bound when the enclosing class declares
    `r` once, as a field or a constructor property **annotated** with one type") binds nothing and `receiverMethods` is
    capability-absent for TypeScript (`import-origins.adapter.ts:242`).
- **The factory shape is not provable from the source alone**: `signalStore(withState(...), withMethods(...))` returns a
  value whose members are the object literals inside its arguments; only the library's signature states that. The
  general rule may therefore cover a literal that _is_ the binding, and the factory shape must enter as framework data
  (Design §3).

### M4 — A type a declaration names is no dependence the Java pack records

- **Confirmed.** ADR-0045's stage table states it: B4 relations for Java are "absent: no Java relations reader"
  (`0045-...md:417`). `ReadableShoppingCartMapper` names `ReadableMinimalProductMapper` in a field declaration
  (`:74`) and calls `merge` on it (`:134`, a `receiver-unproven` cut with 43 candidates today), so nothing points at the
  type's declaration and `callers` of the class is empty. The answer nevertheless says `complete`, which ADR-0042
  forbids: an answer whose asserted item is "the callers of this type" cannot be `complete` while no stage reads type
  references.
- **Reproduction** `repro/java-relations.json` → `repro/java-class.callers.txt`.

### What ADR-0044 V1a already closes, and what this RFC may not touch

V1a (decision 5, with repository signatures only) closes exactly one thing: **the dispatch veto**. A function value no
longer vetoes a repository functional interface `F` unless every type it may be converted to is proven to be neither `F`
nor below it; an invocation whose parameter type needs a library declaration stays unsettled. It does not decide, and
this RFC must not change:

- that a function value is **never a call** — trace may at most show it as a deferred step (`deferred: true`,
  `via: "reference"`), never as an executed step, and never as evidence that a body runs;
- that a constant target of an invocation is read only from a declared signature source; and
- any closure or narrowing of a dispatch answer.

This RFC adds the fact V1a left out — **a function value that names a declaration is a reference to it** — and records it
as a dependence and a deferred step. It releases no veto, and no unit may change `dispatchTargets`' answers.

## Reach

Searched `src/` for the broad form of each mechanism at `main` `d0aee793`:

- **Every consumer of a declaration's span/containment**: `declarationPath`, `selectedBySymbol`, `innermostAt`
  (`declaration-tree.ts:46-70`), `containmentTree` (`containment-tree.ts:8-11`), `selectRoots`/`missingTargets`
  (`root-selection.ts:111-147`), `outline.ts:50`, `:120`, `import-bindings.ts:39`, `declaration-uses.ts:180`,
  `root-selection.ts:74`, `:126`, `:140`, and the trace/impact root printing. All read the graph's `contains` edges; a
  second declaration population must join here, or each family will invent its own.
- **Every consumer of `callables`**: `base-reading.ts:215` (a construction test), `trace-walk.ts:185`, `:293`, `:321`,
  `:354`, `:403`. These are dispatch/return facts; the declaration model is a separate list, so no dispatch answer moves.
- **Call ownership**: `callsByOwner` (`reconciled-calls.ts:47`), called by `trace-queries.ts:143` and by
  `reconciled-calls.ts`'s own `ownedIn`; it takes `GraphSymbol[]` and must accept the model's declarations.
- **Every reader that records a function value**: `java-member-names.adapter.ts:49-50`, `:92-93`,
  `java-function-value-calls.ts:5`, the TypeScript `function-value-calls.ts` and `declared-member-names.adapter.ts:52`.
  The Java anonymous body and the Java method reference are the two gaps; the TypeScript arrow/function expression is
  already a span but not a declaration.
- **Every reverse source**: `reverse-calls.ts:114-119` (`unboundIn`) already returns written-only and deferred calls;
  `:106-112` (`lookedUpIn`) already indexes them. A non-call edge kind already becomes `basis: "reference"`
  (`inbound-edges.ts:315`) and `consumer-callers.ts:64` maps it to the reference kind. A written reference therefore
  joins an existing basis, not a new one.
- **Variants beyond the observed case**: Java constructor references (`DTO::new`), static and unbound instance
  references (`Type::method`), method references inside lambdas and nested types, anonymous classes with several
  initializer blocks and a mix of methods, anonymous classes in field initializers and in `enum` constant bodies,
  TypeScript object literals in class fields, nested object literals, getters/setters and computed keys, and a second
  framework whose factory returns its argument's members. The rules below state an answer for each without naming one.

## Design

### 1. Place on the assembly line

ADR-0045 (Accepted) owns the stages; this RFC extends **ADR-0045 decision 12** (one language pack per language) and
**ADR-0041 decision 4** (the one binder), and supplies the declaration population the binder resolves into. It does not
amend ADR-0044 (see the scope paragraph above) and adds no family-level reader. It extends RFC-0024's `CallBinder` by one
function and changes none of its signatures.

| Piece | ADR-0045 place | Single owner |
|---|---|---|
| `declarations` on B1 (per file) | The language packs' B1 syntax stage, retained per file by content | Each pack's `declared-member-names` adapter |
| The joined declaration tree and path | A per-file join over B1 and the store's symbols, in `navigation` (shared proofs); keyed by the file's content and the index digest of its symbols | `core/application/navigation/declaration-model.ts` |
| `outline`'s file tree | B1's declarations merged into `outline`'s existing tree | `outline.ts` reads the model |
| Call ownership | `callsByOwner` reads the model's bodies (index and syntax) | `reconciled-calls.ts` |
| Targets (`callers`, `impact`, `trace`) | `root-selection` resolves through the model; `trace` steps carry a model declaration | `root-selection.ts`, `trace-walk.ts` |
| Reverse answers for a syntax declaration | `ReverseCalls` gains `intoDeclarations`; the existing B10a delta already retains the written calls it needs | `reverse-calls.ts` |
| Java type references from a declaration (M4) | The Java pack's first step in B4, inheriting B4's retention and gaining its own adapter | `core/adapters/tree-sitter/java-relations.adapter.ts` (new) |
| Factory shapes (M3) | A framework plugin over the TypeScript pack, selected by its dependency signal and file references (ADR-0045 decision 12, "Frameworks are plugins over packs") | `core/adapters/typescript/signals-store.adapter.ts` (new) implements `FrameworkMemberBindings` |

No new subdomain and no new family. `navigation` already owns the containment tree and the binder, so it owns the
joined model.

### 2. The declaration model

**A declaration** is a callable or type a source names where a value can live, with a deterministic identity. Two
populations join into one tree:

| Population | Where it comes from | Identity |
|---|---|---|
| Index declaration | `GraphSymbol` + the store's `contains` edges (today) | its `GraphNodeId`, wrapped as `index:<id>` |
| Syntax declaration | B1's `declarations` (new) | `syntax:<file>:<startLine>:<startColumn>` (a source place; never an index name) |

**One declaration, two sources.** A syntax declaration is an index declaration when a compatible index declaration **of
the same name** in the same file contains its start place. A parser header before the indexed start joins the same
declaration when the indexed start lies in the written span and both end at exactly the same source position; this
handles export/modifier prefixes without merging a nested same-name callable. A method or function joins a callable, never its same-named
type; an accessor may join an indexed method, property or field. When several do, it is the **innermost**: the one that starts last,
and of two that start together the one that ends first — the existing `owningBody` rule (`owning-body.ts:27-34`). The
index identity wins and the syntax data (its path root, `invoked`, its binding) attaches to it. A syntax declaration no
index declaration of its name contains adds a node. Without this rule every method would appear twice in `outline`.

The tree's node list excludes `file`, `import` and `export` declarations (`NOT_DECLARED_KINDS`,
`importers-fact.ts:27`), so the file is never a node and `declarationTree` roots at the file's declarations.

Path rule, unchanged from `declarationPath` (`declaration-tree.ts:46-48`): the names of the containers, outermost first,
then the declaration's own name, joined by `.`. A syntax declaration gets a path **only when its container is proven**:

1. **Binding by literal** — an object literal that is the whole initializer of a variable declaration, a property
   declaration or an exported const `D` gives its function-valued members the path `D.<name>`; a nested object literal
   recurses (`D.a.m`). Proved by the language: `D` holds that literal.
2. **Binding by framework shape** — a call of a framework-declared factory `F` whose declared member-carrying argument
   returns the object literal gives its members the path `<declaration that receives F's result>.<name>`. Proved only
   by the plugin's data, and the fact records the plugin and the call place as evidence.
3. **Otherwise no path.** The declaration is listed with its span, and a target reaches it by the existing
   `{file, start, end}` range form (`impact-queries.port.ts:42`), or by its dotted path when one exists. A declaration
   that starts on a line another declaration also starts on is **not** range-targetable on its own: the range form is
   lines only, so its path is the address, and a duplicate path is the fault below.

Determinism: per-file lists sorted by `(startLine, startColumn, name)`; repository-relative paths; a path introduced by syntax that selects
more than one declaration in one file is an **ambiguity fault** naming every place, never a pick (fail closed). Existing
index-only overload sets keep the query protocol's declaration-set selection; the member binder still selects only
what its existing signature rule proves.

Kinds: `method`, `function`, `accessor`, `initializer`, `anonymous-class`, and `object` for a literal's named holder,
plus the index's own kinds unchanged. An object holder joins an indexed variable or field when present and supplies
containment; a syntax-only object holder is not an execution body.

```ts
// src/core/ports/declared-member-names.port.ts — added; `callables` keeps its dispatch meaning
/** A callable or type a source writes where the declaration model can name it. */
export interface DeclaredDeclaration {
  /** The written name; `initializer` for an instance or field initializer block, `<anonymous@<line>>` for an anonymous class. */
  name: string;
  kind: "method" | "function" | "accessor" | "initializer" | "anonymous-class";
  /** Its whole span, 1-based lines and 0-based columns, end exclusive. */
  span: SourceSpan;
  /** True when it runs only if something invokes it: every method, function value and anonymous-class method. */
  invoked: boolean;
  /** The declaration that holds it, by place; absent at a file's top level. */
  container?: SourcePosition;
  /** What holds the value it is, when the language proves the binding: a variable, field or exported const, by place. */
  binding?: SourcePosition;
}

export interface DeclaredMemberNames {
  // ...existing fields
  /** Every callable the source writes, in source order. Every `callables` entry has one declaration here. */
  declarations: readonly DeclaredDeclaration[];
}
```

```ts
// src/core/application/navigation/declaration-model.ts — new
import type { DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import type { GraphSymbol } from "../../ports/code-graph.port.ts";

/** A declaration a family can name, depend on and step into. It satisfies `TreeDeclaration` (`declaration-tree.ts:4-9`). */
export interface ModelDeclaration {
  file: string;
  /** `index:<GraphNodeId>` or `syntax:<file>:<startLine>:<startColumn>`; deterministic and never an index name for syntax. */
  id: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** 0-based, end exclusive: two declarations of one line are told apart by these and by their paths. */
  startColumn: number;
  endColumn: number;
  /** The index symbol, when the index declares it; absent for a syntax declaration. */
  symbol?: GraphSymbol;
  /** The dotted path, outermost first; absent when no container is proven. */
  path?: string;
}

export interface DeclarationModel {
  /** The file's tree, `declarationTree`'s rule unchanged, index and syntax declarations in one node list. */
  tree(file: string): Promise<readonly DeclarationBranch<ModelDeclaration>[]>;
  /** Selected declarations in position order; duplicate syntax paths fault; indexed overload target sets remain intact. */
  select(file: string, symbol: string): Promise<readonly ModelDeclaration[]>;
  /** The file's declarations, in position order. */
  list(file: string): Promise<readonly ModelDeclaration[]>;
  /** The innermost declarations whose span holds `at`, innermost first: what a call at that place belongs to. */
  ownersOf(file: string, at: SourcePosition): Promise<readonly ModelDeclaration[]>;
}
```

The model is created by the line (`BaseReading`, decision 1) as a stage, one per file, keyed by the file's content and
the index digest of its symbols (the B10a key rule). A family receives it through the line, never builds one.

### 3. Rules per mechanism

**R1 — A Java function value that names a declaration is a written reference.** The Java pack emits
`SyntaxCall { kind: "references", name, callee, line, column, anchors, owners }` for `Type::name` and `expr::name` (a
member reference) and `Type::new`/`expr::new` (a constructor reference). `name` and `callee` are the **referenced
member's spelling** (`findOneWithAuthoritiesByLogin`), never the `::` form, so the reverse lookup's name index
(`reverse-calls.ts:106-112`) reaches it; a constructor reference records the type's name and is bound like an
`instantiates` for its target. The target is resolved by the Java pack's strict reading of the receiver (a type name, or
the declared type of the expression), with one rule: **only a unique member of that name is a proof** — several
same-named members leave the reference `unresolved-link` with every candidate, never a pick, because the functional
interface's arity is not known without a library signature. The trace shows a resolved reference as a **deferred** step
(`via: "reference"`); the reverse families show it as a dependence with `basis: "reference"`. A lambda body is not a
reference: its calls stay deferred inside its function value, as today.

**R2 — An anonymous class's initializer runs at its construction; its methods do not.** `isAnonymousClassBody` stops
being a function value. Instead the Java pack pushes, as function values, the **spans of the method bodies an anonymous
class declares**; its instance initializer blocks and field initializer expressions stay inside the enclosing execution.
A call written in an initializer therefore belongs to the constructing body (`callsByOwner`) and executes in order; a
call in an anonymous class's method stays deferred, exactly as a named class's method is not run by constructing it.
The anonymous class remains an index declaration for its type; no path is invented for its initializer.

**R3 — A TypeScript object-literal member is a declaration, bound only as far as the source proves.** The TypeScript pack
emits a `DeclaredDeclaration` for each function-valued object-literal property (arrow, function expression, method
shorthand, accessor) and each anonymous class member, with its span and its container. A member gets a path by the
binding rules of §2 (`D.m` for a literal initializer, `<D>.m` for a framework factory). A **member of a declaration** is
what the binder resolves a call into, through RFC-0024's `memberOf` for an index holder and this RFC's
`memberOfDeclaration` for a syntax-only holder (§3b).

**R4 — A TypeScript receiver is bound from its single assignment when that assignment proves it.** The receiver-binding
rule gains one case, sound for the same reason the annotated case is: a field or variable declared once, never assigned
elsewhere, whose initializer is (a) an object literal, (b) a `new` of a class the file names, or (c) an **Angular
injection call** whose declared token is a declaration (`inject(T)`, the plugin helper `angular-injection.ts:29-40`). The
binding states `{kind: "token", name, line, column}`; a field written anywhere else or initialized from any other
expression binds nothing.

**R5 — A factory's members are framework data.** A framework plugin implements `FrameworkMemberBindings` (§3b): it
declares, as data, the factory calls it reads and which argument's returned object literal becomes the result's members.
For the signals-store plugin the data is: the package `@ngrx/signals` (project signal, `package.json`), the factory
`signalStore`, the feature call `withMethods`, and that call's argument function whose returned object literal holds the
members; the holder is the declaration that receives `signalStore(...)`'s result. The plugin is selected by ADR-0045's
two signals only (the nearest manifest naming the package; the file's own references to the factory and the feature).
The line merges every plugin's bindings by its union rule; two plugins asserting different containers for one member is
an explicit `unknown` with both as evidence. A factory of any other library yields no path (R3's cut).

**R6 — A type a Java declaration names is a reference to that type's declaration.** The Java pack's first step in B4
records, for every Java declaration, the type names it writes (field, parameter, local, return, cast, `new`,
`extends`/`implements`, annotation) as `references` edges to the repository declaration that type resolves to, by the
same strict reading. `callers`/`impact` of a class then list the declarations that name it. An unresolved **name** is an
`unresolved-link` cut at its place with that name's candidates; the stage's absence is U0's cap-absent containment.
`relation-unread` stays a file-level reason (`impact-cuts.ts:267-277`) and is never used for one name.

### 3b. Contracts this RFC changes

| Where | Change |
|---|---|
| `src/core/ports/declared-member-names.port.ts` | `DeclaredDeclaration` added (U1); `DeclaredMemberNames.declarations` added (U1); `SyntaxCall.kind` gains `"references"` (U6); `ReceiverValue` gains `{ kind: "token"; name: string; line: number; column: number }` (U4). `callables` unchanged |
| `src/core/application/navigation/declaration-model.ts` (new) | `ModelDeclaration` and `DeclarationModel` as above; `ModelDeclaration.id` satisfies `TreeDeclaration.id` |
| `src/core/application/navigation/call-binder.ts` | **Exactly one addition** to RFC-0024's `CallBinder`, after its U1–U4 land: `memberOfDeclaration(holder: ModelDeclaration, member: string, place: CallPlace): Promise<ModelDeclaration \| undefined>`. `memberOf`, `memberOfReceiver` and `declares` keep RFC-0024's signatures |
| `src/core/application/navigation/call-binding.ts` | `CallBindingsDeps` gains `declarations: DeclarationModel`; `proven()`'s `typed()` gains a last branch — a proven holder without a `symbol` uses `memberOfDeclaration` and carries `declaration` on the receiver answer; indexed holders retain RFC-0024's chain and `target`. U2 consumes syntax declaration answers |
| `src/core/application/navigation/reconciled-calls.ts` | `callsByOwner(calls, declarations: readonly ModelDeclaration[], functionValues)`; `positionedBodies` uses a declaration's span whether or not it has a `symbol` |
| `src/core/application/navigation/reverse-calls.ts` (U5) | `intoDeclarations(declarations: readonly ModelDeclaration[]): Promise<readonly SyntaxCaller[]>`, `SyntaxCaller = { from: GraphSymbol; line: number; column: number; kind: string }`. `into` keeps RFC-0024's shape; no new retention |
| `src/core/ports/framework-members.port.ts` (new) | `FrameworkMemberBindings` (below), consumed by the line and built by composition from every framework plugin |
| `src/core/ports/language-pack.port.ts` | `AbsentCapability` gains `"relations"` (`:13`); the line exposes `absentCapabilitiesOf(path): ReadonlySet<AbsentCapability>` |
| `src/core/application/snapshot/base-reading.ts` | the declaration-model stage, `absentCapabilitiesOf`, and the `declarations` and framework accessors handed to every family |
| `src/core/application/trace/trace-walk.ts` (U4) | `Child.symbol: GraphSymbol` becomes `Child.declaration: ModelDeclaration` (its `place.target` stays the string `declaration.id`, `OrderedPlace.target` is already `string`); a written `references` record settles as a deferred child |
| `src/core/application/outline/outline.ts` | the file tree is `DeclarationModel.tree(file)` |

```ts
// src/core/ports/framework-members.port.ts — new
import type { SourceFile } from "./entrypoint-extractor.port.ts";
import type { SourcePosition } from "../domain/shared/owning-body.ts";

/** A member a framework's factory returns to the declaration that receives its result (R5). */
export interface FrameworkMemberBinding {
  /** The declaration that receives the factory's result, by place. */
  holder: SourcePosition;
  /** The member the argument's object literal declares, by place. */
  member: SourcePosition;
  /** The plugin and the call place, as the fact's evidence. */
  evidence: { framework: string; file: string; line: number };
}

export interface FrameworkMemberBindings {
  /** The bindings one source writes, in position order; empty when no factory of this plugin appears. */
  bindings(file: SourceFile): Promise<readonly FrameworkMemberBinding[]>;
}
```

No port outside `navigation`, `declared-member-names`, `framework-members` and `language-pack` changes;
`impact-queries.port.ts`'s `CallersTarget` keeps its two forms unchanged.

### 4. How a declaration joins the four families

| Family | Join | Completeness |
|---|---|---|
| `outline` | The file's tree is the model's tree; every declaration carries name, kind, span and, when proven, its path. A declaration without a path prints its span and no path (the `focus` form prints `path` only when proven) | `complete` when every declaration of the file is read; a pack without the declarations stage states a `capability-absent` cut over the declaration list |
| `trace` | A root or a step is a `ModelDeclaration` (`Child.declaration`); the step's file/symbol/kind/line/endLine come from it. Its body's calls are owned by it through `callsByOwner` over the model | A call whose binding proves a syntax declaration is a step; a call whose receiver or target is unproven is an `unresolved-link` cut naming the declaration's **place** (`file:line name`), never `file::name` with no line |
| `callers` (reverse) | A `{file, symbol}` target selects through the model. An index declaration keeps today's walk. A syntax declaration asks `ReverseCalls.intoDeclarations`; each answer's `from` is an index body, so the walk continues unchanged from it. A reference target (R1) also reaches `callers` through the existing `basis: "reference"` (`inbound-edges.ts:315`) | A cut whose reach can hold a caller makes the answer `partial` (ADR-0042 unchanged); a target that no declaration matches is the existing `unknown-symbol` fault, whose candidates now include proven paths |
| `impact` | A syntax declaration seeds like a symbol; the first hop comes from `intoDeclarations`; every later hop is unchanged | Unchanged rules; the new seed's `basis` is the binding's (`reference` for R1, `call` for R3/R4/R5) |

### 5. Algorithm (deterministic, per read)

1. B1 returns each file's `declarations` (sorted by position). The line retains it per file by content.
2. The model joins, per file: index symbols (minus `NOT_DECLARED_KINDS`) and syntax declarations. A syntax declaration
   merges into the innermost same-named index declaration that contains its start (§2); otherwise it is a new node. Its
   **path root** is the proof's binding when §2 proves one; the framework plugin's bindings are added last, as data.
3. Paths are computed once per tree, outermost first. A duplicate path inside one file is recorded for the fault.
4. `outline` renders the tree; `select` resolves a requested dotted path or a range; `ownersOf` answers call ownership.
5. Families read the model and their own policy; no family builds a second tree.

### 6. What does not change

Answer shapes and every other family's facts: no new required field, no SCHEMA bump, and no new cut vocabulary. U0 reuses
`unresolved-link` with the `relation-unread` reason and the `capability-absent` sub-reason (`fact.ts:154`, `:162`, `:171`);
U8's unresolved names are `unresolved-link` at their place. `dispatchTargets`, `receiverMethods`, `memberOf`,
`memberOfReceiver` and `declares` keep their answers and signatures; `callables` keeps its dispatch meaning; the index
stays the only source of symbols and containment for index declarations; a file no pack reads stays `no-extractor`.

## Delivery units

Prerequisites: ADR-0045 L1 and L1b on `main`; RFC-0024's U1–U4 on `main` before U1 (its `CallBinder` contract). Every
unit is one commit with its fixture failing first and `npm run check` green; the corpus gate runs once per feature
(ADR-0039) through the parent.

| # | Unit | Depends on | Est. authored lines | Gate |
|---|---|---|---|---|
| U0 | A Java type target is `partial` while B4 reads no type reference (`relation-unread`, `callers-of` reach) | L2 | 140 | `callers:±`, `impact:±` |
| U1 | The declaration model and its contracts, extending RFC-0024's binder | RFC-0024 U1–U4, L1b | 300 | `none` |
| U2 | The model joins `outline`, target resolution and call ownership | U1 | 340 | `none` |
| U3 | TypeScript object-literal members are declarations (binding by literal) | U2 | 180 | `outline:+`, `none` |
| U4 | A TypeScript receiver from its single assignment (`inject(T)` token) | U2, U3 | 250 | `trace:±` |
| U5 | The signals-store framework plugin supplies factory member bindings | U3, U4 | 260 | `trace:±` |
| U6 | Java method and constructor references are written references | U2, RFC-0024 U2/U4 (ADR-0044 V0a/V0b) | 260 | `trace:+`, `callers:+` |
| U7 | A Java anonymous class's initializer is execution, not a function value | L1b | 80 | `trace:+` |
| U8 | Java type references from declarations (B4's Java step); removes U0's cut | U0, L2, the existing B4 key | 340 | `callers:+`, `impact:+` |

### U0 — A Java type target is never `complete` while its type references are unread (lead)

Prerequisites: ADR-0045 L2 on `main` (the families read the line); ADR-0042's reach rules.

- **Why**: `callers`/`impact` assert "the declarations that depend on this type"; a Java field, parameter or return type
  is a dependence no stage reads (M4), so the answer must be `partial`, never `complete` with zero dependents.
- **Kinds (decided with the owner)**: the condition (a) is the kind codegraph emits for a Java type. An annotation type
  (`@interface`) arrives as `interface` (codegraph `java.js:241`, `annotation_type_declaration` in `interfaceTypes`), an
  enum as `enum`, and a record as `class` (ye-ast maps `record_declaration` to `class`, `java-symbols.ts:165`). A record
  is therefore covered by `class` with no rule of its own; the record `callers` answer is the same false `complete` U0
  fixes, and the RED variants pin it (`impact-queries.test.ts`, "a Java record, interface and enum target").
- **Status**: the cut is status-only. It adds no symbol and removes none; `callers` and `impact` keep their values and
  their `status` moves from `complete` to `partial` for each Java type target with unread references.
- **Files**: `src/core/ports/language-pack.port.ts` (`AbsentCapability` gains `"relations"`), the Java pack's `absent`
  in `src/composition/compose.ts`, `src/core/application/snapshot/base-reading.ts` (`absentCapabilitiesOf`),
  `src/core/application/impact/impact-queries.ts` (the cut where the cuts are assembled, near `:554`, and the `ofChange`
  path when a seed is a Java type), `src/core/domain/impact/impact-cuts.ts` (one helper), tests.
  **Must not touch** `inbound-edges.ts`, `reverse-calls.ts`, `trace-walk.ts`.
- **Cut, exact (ADR-0042)**: `{ kind: "unresolved-link", at: ["<target file>::<dotted path>"], reason: "relation-unread",
  subReason: "capability-absent", reach: { kind: "callers-of", declarations: ["<target file>::<dotted path>"] } }`. The
  reach is the target's callers, not a whole file: a file-level cut would repeat `unreadRelationCuts`' shape
  (`impact-cuts.ts:267-277`) and would not be the absent stage. It is emitted only when (a) the requested or seeded
  declaration is a Java type (class, interface, enum, record, annotation) and (b) the Java pack declares `relations`
  absent. A Java method target is untouched, and so is a class a removal's place holds only because the member it held
  is gone at head: that holder starts the walk at the removal, whose own cut already names what the change broke
  (`removalHolders`, `seeds.ts`).
- **RED**: `src/core/application/impact/impact-queries.test.ts`, "a Java class target with no B4 reader is partial":
  a fixture (written under `os.tmpdir()`) with `class Target` and `class Holder { private Target t; }`; `callers` of
  `Target` answers `partial` with exactly that cut and no impacted symbol. Fails today: the answer is `complete`.
  Variant: the same fixture with a Java *method* target stays as today; a TypeScript class target is untouched.
- **GREEN**: `callers` and `impact` on `repro/java-relations.json` answer `partial` with the cut; the corpus report lists
  every `complete`→`partial` move and no symbol added or removed.
- **Gate**: `callers:±`, `impact:±` — the direction is "status only": cuts added, no item added or removed. The report
  must show zero added/removed symbols.
- **Docs**: RFC-0010 (a type target's completeness), ADR-0042's cut table, the MCP callers guide.
- **Risk**: item 3 (public answers change status for every Java type target) and item 6 (no existing test catches a
  Java type whose only dependents are type references; the RED is that test).

### U1 — The declaration model (extends RFC-0024's binder)

Prerequisites: RFC-0024 U1–U4 landed; ADR-0045 L1b.
Member-selection clarification accepted by the owner, 2026-11-12: "Continua como recomiendas" — the caller position
does not constrain the target's span; membership comes from the proven holder and its unique direct child.

- **Files**: create `src/core/application/navigation/declaration-model.ts` (+ test); edit
  `src/core/ports/declared-member-names.port.ts` (`DeclaredDeclaration`, `declarations`), both member-name adapters
  (emit `declarations` from the callables each already reads: Java methods and constructors, TypeScript functions, class
  methods, interface signatures and accessors; no new syntax yet), `src/core/application/navigation/call-binder.ts`
  (only `memberOfDeclaration`), `src/core/application/navigation/call-binding.ts` (the `declarations` dep and the last
  `typed()` branch), `src/core/application/snapshot/base-reading.ts` (the stage).
  **Must not touch** `trace-walk.ts`, `reverse-calls.ts`, `reconciled-calls.ts`, `outline.ts`, `root-selection.ts`,
  `dispatchTargets`/`receiverMethods`.
- **Contract**: the binder addition is `memberOfDeclaration(holder, member, place)` (async, `ModelDeclaration` in and
  out). A syntax-only holder's children come from the model's tree; the answer is the unique child whose name equals
  `member`; no match or several matches → `undefined`. Proven containment establishes membership; `place` remains the
  caller occurrence and need not lie inside the selected declaration. An index holder keeps RFC-0024's `memberOf`
  selection and is wrapped with `id = "index:<id>"`; nominal receiver selection stays in `CallBindings.memberOfReceiver`.
- **RED**: `src/core/application/navigation/declaration-model.test.ts`, "a declaration the index does not hold joins the
  tree, and one it holds is that declaration": the index holds `A` (class) and `A.m` (method); the pack declares `m`
  (coinciding) and a syntax-only `n` under `A`. Expected exact tree: **one root, `A`, with two children `m` and `n`** —
  no `file` node (`NOT_DECLARED_KINDS`, `importers-fact.ts:27`), no duplicate `m`; `select("A.m")` answers one and
  `select("A.n")` answers one. Fails today: the model does not exist. Variant: two syntax-only declarations of the same
  path in one file are a duplicate-path fault naming both places.
- **GREEN**: the model answers; a call whose holder is a syntax-only declaration settles through
  `memberOfDeclaration`; RFC-0024's binder tests stay green.
- **Gate**: `none` (no family reads the model yet).
- **Docs**: RFC-0007's capability table (B1's declarations), RFC-0017 (the list this will feed).
- **Risk**: none.

### U2 — The model joins `outline`, target resolution and call ownership

Prerequisites: U1.

- **Files**: `src/core/application/outline/outline.ts` (`:50`, `:120`) and `outline-queries.ts`;
  `src/core/application/navigation/root-selection.ts` (`:74`, `:111-147`), `containment-tree.ts`;
  `src/core/application/trace/trace-queries.ts` (`:143`, `:153`, `:276`);
  `src/core/application/impact/impact-queries.ts` (`:534`); `src/core/application/navigation/import-bindings.ts:39`,
  `declaration-uses.ts:180`; `src/core/application/navigation/reconciled-calls.ts` (`callsByOwner`, `ownedIn`).
  **Must not touch** the packs, `trace-walk.ts`, `reverse-calls.ts`.
- **Ownership rule (exact)**: `callsByOwner` takes `readonly ModelDeclaration[]`; `positionedBodies` builds a body from
  every declaration with a span, using its `startLine`/`startColumn`/`endLine`/`endColumn` and, when it has a `symbol`,
  that symbol's id as the owner key; a syntax-only body's key is its `id`. A call is owned by the innermost body
  (`owningBody`'s rule) exactly as today.
- **RED**: `src/core/application/outline/outline.test.ts`, "a syntax-only member of a file is an outlined declaration
  with its span": the test's fake model holds `D` and a syntax-only `D.m`; the file outline lists both with `D.m`'s
  span. Fails today: only the index's declarations are listed. Variant: `root-selection`'s `missingTargets` offers
  `D.m` as a candidate, and `callsByOwner` assigns a call written in `m` to `D.m`, not to the file (both over the fake
  model).
- **GREEN**: `outline` on `repro/ts-store.json` lists the store's members with spans (the factory ones with no path until
  U5); `callers`/`trace` still answer every index target byte-identically.
- **Gate**: `none` expected — U1's declarations coincide with index symbols, so the merge adds none; any addition the
  report shows is attributed to the merge rule, not accepted silently.
- **Docs**: RFC-0017 (outline), RFC-0010 (target resolution), the MCP outline guide. Syntax-only roots remain in the
  selection and produce explicit `no-symbols` cuts while execution/reverse traversal awaits U4/U5; no graph handle is
  fabricated and no unsupported root is reported complete and empty. A focused unbound declaration omits `path`.
- **Risk**: item 3 — every surface that lists declarations changes for every repository; the report must show the
  additions only.

### U3 — TypeScript object-literal members are declarations

Prerequisites: U2.

- **Files**: `src/core/adapters/typescript/declared-member-names.adapter.ts` (emit object-literal members with spans,
  kinds and `binding`), `declaration-model.ts` (the binding-by-literal rule, nested), tests.
  **Must not touch** the receiver binder, `trace-walk.ts`.
- **RED (adapter)**: `declared-member-names.adapter.test.ts`, "an object-literal method is a declared callable of the
  literal": `const D = { m() { return 1; } }` yields a `DeclaredDeclaration` for `m` with its span and its `binding`
  (the literal's declaration). Fails today: object-literal members are only names.
- **RED (path)**: `declaration-model.test.ts`, "a literal initializer's member gets `D.m`; a returned literal gets no
  path". Variant: a nested literal `const D = { a: { m() {} } }` yields `D.a.m`.
- **GREEN**: `outline` of `repro/ts-store.json` lists the store's members with spans; the probe's `callers` candidates
  include them by place.
- **Gate**: `outline:+`; `none` elsewhere.
- **Docs**: RFC-0017, the MCP outline guide.
- **Risk**: none.

### U4 — A TypeScript receiver from its single assignment

Prerequisites: U2, U3.

- **Files**: `src/core/adapters/typescript/declared-member-names.adapter.ts` (`receiverBindings`: the initializer case),
  `src/core/adapters/typescript/angular-injection.ts` (the token as a declaration reference; `injectedToken`/
  `injectedClass` at `:29-40`), `src/core/application/navigation/call-binding.ts` (the `token` holds kind in `proven`),
  `src/core/application/trace/trace-walk.ts` (`Child.declaration`, §3b: the first unit where a step may be a syntax
  declaration). **Must not touch** `dispatchTargets` (absent for TypeScript, stays absent) or RFC-0024's `memberOf*`.
- **RED (adapter)**: `declared-member-names.adapter.test.ts`, "a field initialized once by an injection token binds its
  declaration": `private readonly s = inject(S);` yields one `ReceiverBinding` for `s` with
  `holds: {kind:"token", name:"S", line, column}`. Fails today: the annotated-only rule binds nothing. Variant: the field
  assigned again elsewhere binds nothing; a non-framework call initializer binds nothing.
- **RED (binder)**: `call-binding.test.ts`, "a token-bound receiver settles its declaration's member": with that binding,
  `this.s.m()` binds `S.m` through `memberOfDeclaration`. Fails today: no binding and no declaration.
- **GREEN**: `repro/ts-store.json` trace resolves `this.articlesListStore.setListPage` to the declaration as a step, or
  a cut naming its place; with U5 both are steps.
- **Gate**: `trace:±`; the report lists every moved cut.
- **Docs**: RFC-0013 (R6/R8), ADR-0045 decision 12's capability note.
- **Risk**: none.

### U5 — The signals-store framework plugin

Prerequisites: U3, U4; ADR-0045 L1b's framework-plugin wiring.

- **Plugin data (exact)**: package `@ngrx/signals` in the nearest `package.json`; the factory `signalStore`; the feature
  call `withMethods`; the first argument of `withMethods` is a function whose returned object literal holds the members;
  the holder is the declaration that receives `signalStore(...)`'s result (`ArticlesListStore`). File-level signal: the
  file imports `signalStore` and `withMethods` from `@ngrx/signals` (`@ngrx/signals/rxjs-interop` for `rxMethod` does
  not select).
- **Files**: create `src/core/ports/framework-members.port.ts` and
  `src/core/adapters/typescript/signals-store.adapter.ts` (+ conformance fixture — a framework plugin, not a language
  stage, so it lives beside the Angular readers and implements the port); register it in `src/composition/compose.ts`;
  `src/core/application/snapshot/base-reading.ts` merges the plugins' bindings; `declaration-model.ts` resolves a
  binding into a path; `src/core/application/navigation/reverse-calls.ts` (`intoDeclarations`) and the
  `callers`/`impact` merge that consumes it (the first unit where a syntax declaration is a proven `callers` target).
  **Must not touch** the line, the packs, or `trace-walk.ts`.
- **RED**: the plugin's conformance test, "a store factory binds its feature members to the store declaration": a
  fixture with the manifest signal and `const S = signalStore(withState(x), withMethods(() => ({ m() { return 1; } })))`
  resolves `S.m` with the plugin's evidence. Fails today: no plugin. Variant: the same file without the manifest signal
  yields no path; a second `withMethods` member with the same name is a duplicate-path fault.
- **GREEN**: `trace` on `repro/ts-store.json` follows `setPage → setListPage → loadArticles → ArticlesService.query →
  ApiService.get` with the URL and params, effects non-empty (the oracle's O2–O6); `callers` of
  `ArticlesListStore.setListPage` resolves by that path and lists the component's two call sites.
- **Gate**: `trace:±`.
- **Docs**: RFC-0007 (a framework plugin kind, its signal and data), ADR-0045 decision 12's framework table.
- **Risk**: item 3 — a framework's data now decides that members exist and how they are named; the conformance fixture
  pins both the signal and the shape.

### U6 — Java function values that name a declaration are references

Prerequisites: U2; RFC-0024 U2/U4 (which require ADR-0044 V0a/V0b, feature A); **ADR-0044 V1a or the V1b that carries its
rule**, pinned by this unit's fixture (V1a lands alone only if M0 finds a corpus release).

- **Files**: `src/core/adapters/tree-sitter/java-member-names.adapter.ts` (emit `kind: "references"`),
  `src/core/application/navigation/reconciled-calls.ts` (a written reference record),
  `src/core/application/trace/trace-walk.ts` (`writtenOnly` split into calls and references; a reference settles as a
  deferred child), `src/core/adapters/spring/java-receiver-methods.ts` (the unique-member resolution for a reference
  site). **No new reverse source**: `unboundIn` already returns written-only and deferred calls (`reverse-calls.ts:114-119`)
  and `lookedUpIn` already indexes them (`:106-112`).
  **Must not touch** `dispatchTargets` or ADR-0044's vetoes.
- **RED**: `reconciled-calls.test.ts`, "a method reference is a written reference": a Java fixture with
  `list.map(this::fmt)` yields `kind: "references"` at `this::fmt`. Fails today: the reference is only a function value.
  Variant: `Type::new` with several constructors is a cut naming them; a reference to an overloaded name is a cut.
- **GREEN**: `repro/java-lambda.json` trace lists `userRepository::findOneWithAuthoritiesByLogin` as a deferred step at
  `UserService.java:282` (`via: "reference"`); `callers` of `findOneWithAuthoritiesByLogin` lists
  `getUserWithAuthorities` with `basis: "reference"`; the dispatch answer of the repository port is byte-identical.
- **Gate**: `trace:+`, `callers:+` (a deferred step and a reference dependence added; no cut removed).
- **Docs**: RFC-0013 (deferred steps), RFC-0010 (the reference basis), ADR-0044's scope note in this RFC.
- **Risk**: item 3 and item 6 — a new public dependence and deferred step, with the dispatch-veto fixture as the only
  guard that it is never an execution; the gate report lists every added reference and every unchanged dispatch answer.

### U7 — A Java anonymous class's initializer executes at its construction

Prerequisites: ADR-0045 L1b (the Java pack's B1). Independent of U1 and U2.

- **Files**: `src/core/adapters/tree-sitter/java-member-names.adapter.ts` (`isAnonymousClassBody` no longer a function
  value; instead the anonymous class's method bodies are the function values), its test; a trace fixture.
  The syntax scopes identify initialization that executes in the enclosing body; `reconciled-calls.ts` applies that
  ownership to both written-only calls and aligned index records. **Must not touch** the dispatch readers.
- **RED**: `java-member-names.adapter.test.ts`, "an anonymous class initializer is not a function value": a fixture
  `new HashMap<>() {{ put("a", service.get()); }}` yields a function value only for a method the class declares, not for
  its `class_body`. Fails today: the whole body is a function value. Variant: a method declared inside the anonymous
  class is still a function value.
- **GREEN**: `repro/java-anon.json` trace lists `articleQueryService.findById` and `put` as steps of `createArticle` at
  `ArticlesApi.java:35`; the `HashMap` construction keeps the same external/cut it has today.
- **Gate**: `trace:+` (two steps added, no cut removed).
- **Docs**: RFC-0013 (an initializer runs at construction).
- **Risk**: none.

### U8 — Java type references from a declaration (B4's Java step)

Prerequisites: U0, ADR-0045 L2; **not L4** — see retention below.

- **Files**: create `src/core/adapters/tree-sitter/java-relations.adapter.ts` (+ conformance test), its port wiring in
  `src/core/application/snapshot/base-reading.ts` (the B4 stage for the Java pack), `src/composition/compose.ts`.
  The syntax helper reads written type occurrences; `adapters/spring/java-relations.adapter.ts` resolves them with
  the existing Java project owner. It removes U0's cut where it read the relation (the Java pack stops declaring
  `relations` absent).
  **Must not touch** the TypeScript relation extractor or any Java dispatch reader.
- **Retention (ADR-0045 decision 8, answered)**: B4 is a whole-snapshot slot today (`retained-relations.ts:13-22`), so
  the Java reader joins **that** stage and inherits its existing whole-snapshot key; no new stage and no new key. The
  row records it: "B4 relations, every language — whole-snapshot slot today; per-file plus a join after L4". L4b is a
  later optimization of the same stage, not a prerequisite. Measurement: ADR-0045 M2's per-stage CPU and retained bytes,
  plus M4's re-derivation after one edited file, reported with this feature.
- **RED**: the adapter's conformance test, "a field's declared type is a reference to it": a fixture
  `class Holder { private final Target t; void f() { t.m(); } }` yields a `references` relation from `Holder` to
  `Target`. Fails today: no Java relations. Variant: a parameter type, a return type and a `new` type each count; a
  type no source declares is an `unresolved-link` cut naming that type's candidates, at its place.
- **GREEN**: `repro/java-relations.json` `callers` of `ReadableMinimalProductMapper` lists `ReadableShoppingCartMapper`
  at `:74` and no longer carries U0's absent-stage cut; the conformance fixture is `complete`, and a repository with an
  unresolved type name is `partial` with an `unresolved-link` cut, never U0's absent-stage cut.
- **Gate**: `callers:+`, `impact:+`; the report lists every added class caller and every new `unresolved-link` cut.
- **Docs**: ADR-0045 decision 12's B4 row (Java becomes "yes") and decision 2's B4 retention, RFC-0010.
- **Measured delivery** (2026-11-12): the fixed mapper probe reaches `ReadableShoppingCartMapper` at line 74 as a
  proven reference and is complete. An isolated B4 run over 1,173 production Java sources used 2,145 ms process CPU
  on its first derivation and 21 ms on a retained repeat (no derivation); one edited source required one derivation
  at 1,839 ms. The admitted B4 output was 11,232,578 bytes under a 32 MiB snapshot cache. These are individual stage
  measurements, including parsing/serialization, not end-to-end latency distributions. The existing whole-snapshot
  invalidation remains; L4 is still the per-file optimization. Unresolved type occurrences are retained as data and
  attributed through the existing name frontier, not emitted as repository-wide cuts.
- **Risk**: item 3 and item 6 — a new public dependence for every Java class and a new stage with no existing test; the
  conformance fixture and the gate report are the guard.

## Measurement

| Unit | Study items it should close | Re-check |
|---|---|---|
| U0 | none (it states the gap honestly) | `callers ReadableMinimalProductMapper` is `partial` with the cut, not `complete` |
| U1 | none alone | the model's fixture; RFC-0024's binder tests stay green |
| U2 | none alone | the fake model's fixture; `callers`/`trace`/`outline` byte-identical on every index target |
| U3 | none alone | `outline` on `realworld/frontend` store file: the members appear with spans, the factory ones with no path |
| U4 | partial `CF-realworld-TS-FLOW` | `trace` cut names the place instead of `capability-absent` |
| U5 | `CF-realworld-TS-FLOW` | `trace setPage` reaches `ApiService.get` with URL and params, effects non-empty |
| U6 | `N-JHIPSTER-J-FLOW.A1-N2`, `.A2-N1` | `trace getUserWithAuthorities` lists the deferred step; `callers findOneWithAuthoritiesByLogin` lists the reference |
| U7 | `N-realworld-J-FLOW.A1-N2`, `.A2-N2`, `.A2-N4` | `trace createArticle` lists `findById` at `:35` |
| U8 | `N-shopizer-J-BUG.A1-N3` | `callers ReadableMinimalProductMapper` lists `ReadableShoppingCartMapper` at `:74` |

Each re-check is the plan in `repro/` against the pinned workspace, with the answer excerpt compared to the oracle item.

## Resolved questions

Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes". Each decision is the recommendation below and
every unit above is consistent with it.

| # | Question | Decision |
|---|---|---|
| 1 | Should a syntax declaration's path be allowed to shadow an index declaration's path in the same file? | No. A duplicate path is an ambiguity fault naming both places; picking one would make the answer depend on registration order |
| 2 | Is a framework plugin the right home for a store factory, or should the general rule try to prove a factory's return shape? | The plugin. Proving a factory's return needs the library's signature (ADR-0044's V1b lesson); the general rule stays literal-only |
| 3 | May a syntax declaration answer `complete` when no reverse delta was retained (a cold read)? | No: an unretained delta makes the answer `partial` with a `capability-absent` sub-reason over the reverse source |
| 4 | Does adding declarations to `outline` require an opt-in? | No. `outline`'s contract is "the declarations of a file"; a silent omission is the defect this RFC removes |
| 5 | Who owns `CallBinder.memberOf`/`declares`? | RFC-0024, with its `GraphSymbol` contract and its U1–U4 first; this RFC adds only `memberOfDeclaration` for a holder without a symbol |
| 6 | Does U8 wait for ADR-0045 L4b's per-file B4? | No. The Java reader joins the existing whole-snapshot B4 stage and inherits its key; L4b is a later optimization of the same stage |
| 7 | Is an absent Java relation stage a `relation-unread` cut or an `unresolved-link` cut? | Both, apart: the absent stage is `unresolved-link` with reason `relation-unread`, sub-reason `capability-absent` and reach `callers-of` the target; one unresolved type name is `unresolved-link` at its place (U8) |
| 8 | Where does the framework plugin live, and how does its data reach the model? | `adapters/typescript/signals-store.adapter.ts` beside the Angular readers, implementing `FrameworkMemberBindings`; composition builds it, the line merges it, the model resolves it |
| 9 | Does U1 wire the families or the model only? | The model only; U2 wires `outline`, targets and call ownership, so each unit stays under the size ceiling and its gate is attributable |

## Review responses

Every finding of `designs/review-binder.md` for RFC-0027 is accepted; none is disputed, so no original text is kept
against a finding. Where a finding had two parts, the response names the part each unit answers.

| Finding | Change |
|---|---|
| C1 (baseline moved) | Header, all `path:line` and the repro statement re-read on `d0aee793` |
| Q1 (seam) | New "Relation to RFC-0024" section; §3b adds only `memberOfDeclaration`; U1 prerequisites name RFC-0024 U1–U4; Resolved question 5 |
| Q2 (sync vs async) | `memberOfDeclaration` is async; `ModelDeclaration` accessors stay async; no sync view invented |
| Q3 (`DeclarationBranch`) | `ModelDeclaration` gains `id` (satisfying `TreeDeclaration`, `declaration-tree.ts:4-9`) |
| Q4 (RED tree) | U1's RED states the exact tree: one root `A` with children `m` and `n`, no `file` node (`NOT_DECLARED_KINDS`, `importers-fact.ts:27`), no duplicate `m` |
| Q5 (identity rule) | §2 requires the **same name**, the innermost container, and `owningBody`'s tie-break (`owning-body.ts:27-34`) |
| Q6 (U1 files) | U1 is the model only; U2 lists `outline.ts`, `outline-queries.ts`, `root-selection.ts`, `containment-tree.ts`, `trace-queries.ts`, `impact-queries.ts`, `import-bindings.ts`, `declaration-uses.ts`, `reconciled-calls.ts` |
| Q7 (ownership) | §3b and U2 change `callsByOwner`/`positionedBodies` with the exact body rule |
| Q8 (span) | `ModelDeclaration` gains `startColumn`/`endColumn`; §2 and U1 state the matching rule and the shared-line limit of the range form |
| Q9 (U2 RED) | U3 splits it: the adapter test asserts the declaration and its `binding`; the path test lives in `declaration-model.test.ts` |
| Q10 (U3 RED) | U4 splits it: the adapter test asserts the `token` binding; `call-binding.test.ts` asserts the settled member |
| Q11 (plugin contract) | New `FrameworkMemberBindings` port, its type, composition wiring, line merge and model resolution |
| Q12 (names) | U5 names `@ngrx/signals`, `signalStore`, `withMethods`, the first argument's returned object literal and the holder |
| Q13 (B4 retention) | U8 joins the existing whole-snapshot B4 stage, states the row, the M2/M4 measurement and the fixtures; L4b is not a prerequisite |
| Q14 (`relation-unread`) | U0 uses `unresolved-link` + `relation-unread` + `capability-absent` with a `callers-of` reach (not `unreadRelationCuts`' file cuts); U8's unresolved names are `unresolved-link`; vocabulary unchanged |
| Q15 (V1a) | U6's prerequisite is "V1a or the V1b that carries its rule", pinned by the dispatch-veto fixture |
| Q16 (risk) | U0, U6 and U8 name item 3 and item 6 and their gate reports |
| Q17 (contracts) | §3b lists `SyntaxCall.kind` and `ReceiverValue`'s `token`; §6 says `capability-absent` is a sub-reason, not a cut reason |
| Q18 (U8 size) | U8 is 340 lines; the cut work moved to U0 (140) |
| Lead (new U0) | U0 added as the fail-closed containment before U8, with its RED, files, gate direction and U8's removal |

## Decisions recorded in ADR-0049

- A declaration model spanning index and syntax declarations, owned by the language packs' B1 stage and joined by one
  per-file model in `navigation`.
- A function value that names a declaration is a reference (a dependence and a deferred step), never a call and never
  evidence of execution (extends ADR-0044 without changing its veto).
- A framework plugin may supply the container of members its factory returns, through `FrameworkMemberBindings`; no
  language pack names a library.
- A Java declaration's written types are references to those types' declarations (B4's Java step), and a Java type target
  stays `partial` until that step reads them.

Java method and constructor references are written references | U2, RFC-0024 U2/U4 (ADR-0044 V0a/V0b) | 260 | `trace:+`, `callers:+` |
| U7 | A Java anonymous class's initializer is execution, not a function value | L1b | 80 | `trace:+` |
| U8 | Java type references from declarations (B4's Java step); removes U0's cut | U0, L2, the existing B4 key | 340 | `callers:+`, `impact:+` |
