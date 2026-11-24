# RFC-0044: One receiver-typing reading for TypeScript

- Status: Accepted, 2026-11-17. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions); every question is settled as its "Resolved questions" table states.
- Related: [ADR-0135](../adr/0135-one-owner-types-a-typescript-receiver-in-a-fixed-order-of-proofs-and-every-family-asks-it.md),
  [ADR-0136](../adr/0136-the-type-checker-types-a-typescript-receiver-over-the-repositorys-own-sources-only-where-its-answer-names-a-repository-declaration-or-a-language-global.md)
  (the decisions this RFC designs); [RFC-0013](0013-trace-and-patterns.md) R5, R6, R8;
  [RFC-0024](0024-receiver-typed-settlement.md), [RFC-0031](0031-cut-ledger-and-outcome-control.md),
  [RFC-0043](0042-one-typed-expression-reading-settles-java-receivers-and-arguments.md) (unit U8 and its port change,
  reused here), RFC-0042 (cut causes, drafted beside this one);
  [ADR-0018](../adr/0018-type-information-as-a-fact-input.md),
  [ADR-0029](../adr/0029-lexical-bindings-from-the-typescript-binder.md) decisions 4, 9 and 11,
  [ADR-0037](../adr/0037-host-declared-build-outputs.md),
  [ADR-0046](../adr/0046-a-call-binds-by-its-receivers-type.md) decision 4,
  [ADR-0079](../adr/0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md) decisions 4, 5 and 7,
  [ADR-0090](../adr/0090-a-typescript-call-on-this-binds-through-the-hierarchy-of-the-class-it-is-written-in.md),
  ADR-0108, ADR-0111, ADR-0133 (the external-call rule), ADR-0045 decision 12, ADR-0075

**In short:** one module of the TypeScript adapters types the receiver of a member call by a fixed order of proofs
(value, declared type, framework value factory, type checker) and answers through the existing receiver reading, so
the dependence families and `trace` bind the call by the same answer. It replaces the answer "this pack cannot say"
that every receiver other than `this` and `super` gets today, and the type rules `trace` keeps for itself. It must
move `trace`/typescript `receiver-unproven` (31, 22 of them `capability-absent`) and `callee-unknown` (8), and the
typescript `name-only` rows of `callers` and `impact` (38).

## Problem

| Evidence | Source |
|---|---|
| The TypeScript receiver reading answers only a call through `this.` or `super.`; any other receiver is `unknown` with `capability-absent` | `accessOf`, `src/core/adapters/typescript/this-receiver-methods.ts:196`; `UNKNOWN`, same file `:22`; wired at `receiverMethods`, `src/core/adapters/typescript/import-origins.adapter.ts:256` |
| A member call on an optional chain (`a?.b()`) or on a type assertion binds nothing: the source reader marks it `COMPUTED` | `receiverBindings`, `src/core/adapters/typescript/function-value-calls.ts:213-229` |
| A value initialised by a call (`f()`), and any receiver that is a property chain, has no stored value | `storedValue`, `function-value-calls.ts:368` |
| A field binds only when it is class-private and stays local | `fieldAnnotationOf`, `function-value-calls.ts:186` |
| `trace` types an annotated or constructed receiver by itself, after the base binding answered; the base binding marks only a relations proof and a literal as outside | annotated and constructed blocks, `src/core/application/trace/trace-walk.ts:712-735`; `proven`, `src/core/application/navigation/call-binding.ts:190-212` |
| The base binding asks the receiver reading for a receiver binding that placed nothing only in a nominal language | `bindCalls`, `call-binding.ts:272` (`hasTyping(reference.file, "nominal")`) |
| One unproven heritage clause anywhere makes every `declaredTypes` site `unknown` and every `outsideSupertypes` site `unknown` | `subtypedTypes`, `import-origins.adapter.ts:341-369`, read at `:274`; `hierarchyOf`, `this-receiver-methods.ts:104` |
| The framework value table is read only by the HTTP call-site reader; a second vocabulary of the same factories lives in the consumer-flow readers | `VALUE_CELLS`, `src/core/adapters/frameworks/angular/angular.plugin.ts:20`; `HOLDER_ROWS`, `src/core/adapters/typescript/consumer-flow.holders.ts` |
| A file is parsed once per `(target, kind)` and bound privately by each reader | `sourceTree`, `src/core/adapters/typescript/source-tree.ts:39`; `bindFile`, `src/core/adapters/typescript/lexical-bindings.ts:28` |
| A literal `require("./x")` is always an untraversed reference, a `dynamic-load` cut; a literal `import("./x")` is a module edge | `readSyntax`, `src/core/adapters/typescript/module-dependencies.adapter.ts:86-103`; `src/core/domain/impact/module-impact.ts:42-44` |
| 39 `trace`/typescript cuts read from the sources by shape: field built by a framework value factory 3; local of an outside type that escapes its function 7; field annotated with a package type 5; optional call on an injected field 3; value initialised by a repository call 3; call result of a repository function 1; chain through a library member 4; provider or token 2; computed member 1; bare-spelled or function-typed callee 5; `super(...)` over a language global 1; platform module without declarations or untyped value 4 | corpus report of 2026-11-17 (audit evidence, lane "TypeScript receiver typing") |

**Root cause.** TypeScript has no owner of "the type of this receiver". Seven readers each type one receiver form
for one consumer (the source reader's `ReceiverBinding`, `declaredTypes`, the `this` reading, the relations'
origins, the assignability program, the declared type bindings, and the type arms of `trace`), so a form none of
them reads has no answer in any family, and a form one of them reads is known to that reader's consumer only.

## Design

### The owner

`src/core/adapters/typescript/receiver-typing.ts` (new), built by `createImportOrigins`
(`import-origins.adapter.ts:52`) next to `createThisReceiverReading`. It is the only module that turns a receiver
expression into a type. It lives in the TypeScript adapter because every rule below is a rule of the language
(ADR-0075); it sits behind `ImportOrigins.receiverMethods`, the port every family already asks
(`edge-targets.ts:361`, `call-binding.ts:280`, the `typed` loop of `trace-walk.ts`), so no family gains a second
question.

The readers that stay, and why they are not a second path:

| Reader | Stays as | Relation to the owner |
|---|---|---|
| `localReceivers` (`function-value-calls.ts:32`) | the value proof of a local binding | the owner's level P1 for a name reads it; nothing else derives a value |
| `annotated` (`function-value-calls.ts:427`), `typeOf` (`import-origins.adapter.ts:328`) | how a type node names a type | the owner calls them; `declaredTypes` keeps calling them |
| `createThisReceiverReading` | `this.m()` and `super.m()` | asked first; the owner is asked only when it answers `unknown` |
| relations' field and local origins (`angular-metadata.adapter.ts`) | the proof of an injected repository class and of provider substitution | read first by `CallBinder.receiverOf`; the owner is asked only for a binding they left without a declaration |
| `createReceiverTypes` (`receiver-types.ts:26`) | the one sources-only program | level P4 asks the same program (ADR-0136) |

### The contract

Adapter contract, `src/core/adapters/typescript/receiver-typing.ts`:

```ts
/** Why the reading types no receiver at a site. Closed: a new cause is a new rule of RFC-0044's tables. */
export const RECEIVER_TYPE_CAUSES = [
  "own-instance",        // `this` or `super`: the `this` reading owns it
  "root-binding",        // a name bound to an import, a class, a function, an enum or a namespace: a root, not a value
  "dynamic-scope",       // `with`, direct `eval`, or a binding the binder reports `dynamic`
  "type-assertion",      // `e as T`, `<T>e`: a claim of the programmer, no proof
  "untyped-declaration", // no annotation and no initialiser the table types
  "destructured",        // a binding pattern element, a loop variable, a catch variable
  "union",               // a union or intersection other than with `null` or `undefined`; two operands of different types
  "type-parameter",      // a type parameter, or a type an inner scope declares
  "structural-type",     // a type literal, a function type, an alias of one, a repository type that is not nominal
  "outside-call-result", // a call whose callee is declared outside the repository
  "undeclared-return",   // a repository callee without one declared return type
  "member-type",         // a property of a type outside the repository, or a member the framework row does not list
  "computed-receiver",   // element access, tagged template, `await`, `yield`, any expression the table does not list
  "ambiguous-place",     // no single call, declaration or member at the place
  "unparsed",            // the file, or a file the proof needs, has no tree
] as const;
export type ReceiverTypeCause = (typeof RECEIVER_TYPE_CAUSES)[number];

/** How a type was established: `value` proves the class of the object itself; `declared` only what its declaration states. */
export type ReceiverTypeProof = "value" | "declared";

export type ReceiverType =
  /** A class or interface the repository declares, by its file, the 1-based line of its name and its name. `nominal`: it declares a `private`, `protected` or `#` instance member. */
  | { kind: "repository"; file: string; line: number; name: string; nominal: boolean; proof: ReceiverTypeProof }
  /** An export of a package, by the module specifier and the exported name. */
  | { kind: "package"; module: string; name: string; proof: ReceiverTypeProof }
  /** A global of the language's libraries (`Map`, `String`, `Array`). */
  | { kind: "global"; name: string; proof: ReceiverTypeProof }
  /** A value a framework factory returns: the row's type, with the members the row lists. Always `declared`. */
  | { kind: "cell"; module: string; name: string; members: ReadonlySet<string> }
  | { kind: "unknown"; cause: ReceiverTypeCause };

export interface ReceiverTyping {
  /** The type of the receiver of the member call of `site.member` that starts at `site`. */
  typeAt(site: ReceiverCallSite): Promise<ReceiverType>;
  /** `typeAt` as the port's answer (rules A1 to A6). */
  methodAt(site: ReceiverCallSite): Promise<ReceiverMethod>;
}

export interface ReceiverTypingDeps {
  treeOf(file: string): ts.SourceFile | undefined;
  boundOf(file: string): BoundFile;                                    // `bindFile`, shared (unit U1)
  /** The binding of a root name as a type outside the repository: `typeOf` of import-origins.adapter.ts. */
  outsideTypeOf(file: string, head: ts.Identifier, member?: string): Promise<DeclaredType>;
  /** The one repository class or interface a name names from `file`, through imports: `heritageOf`'s repository branch. */
  repositoryTypeOf(file: string, name: ts.EntityName | ts.Expression): Promise<{ file: string; node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration } | undefined>;
  /** The one repository function or method a callee expression names, through imports. */
  callableOf(file: string, callee: ts.Expression): Promise<ts.SignatureDeclaration[] | undefined>;
  /** The framework rows of the composed plugins (unit U5); absent until then. */
  cells?: FrameworkValueCells;
  /** Level P4 (unit U8); absent until then and on a live read. */
  checker?: (site: ReceiverCallSite) => Promise<ReceiverType>;
}

export function createReceiverTyping(deps: ReceiverTypingDeps): ReceiverTyping;
```

Port contract. This RFC changes two port types, both additively; neither names a language.

`src/core/ports/import-origins.port.ts`, the `outside` member of `ReceiverMethod`. RFC-0043 ("Port changes") adds
`noFunctionValue` and `module`; this RFC adds `global` (unit U3). The member after both:

```ts
  /**
   * ... (the existing text) ... `noFunctionValue`: the pack proves that no function value can be the receiver where the
   * call names this member. `module`: the module an external call under this type is listed under. `global`: the type
   * is a global of the language's libraries, so an external call under it is listed as a call of that global and is
   * replaced by a write to the member through that global's prototype.
   */
  | { kind: "outside"; type: string; exact?: true; noFunctionValue?: true; module?: string; global?: true };
```

`src/core/ports/framework-cells.port.ts` (unit U5):

```ts
/** What a value a factory returns is: the type its package exports for it, and the members that type offers. */
export interface ValueCellType {
  /** The exported type name (`WritableSignal`). */
  name: string;
  /** The member names a call on the value may name; a call of any other member is not typed by the row. */
  members: ReadonlySet<string>;
  /** Whether the value itself is called to read it (`x()`). */
  callable: boolean;
}

export interface FrameworkValueCells {
  runOf(factory: CellFactory): ValueCellRun | undefined;
  /** The type of the value `factory` returns; none for a factory the framework does not list. */
  typeOf?(factory: CellFactory): ValueCellType | undefined;
  readonly projections: ReadonlySet<string>;
}
```

`src/core/application/navigation/call-binding.ts`, `OutsideDispatch` (application type, unit U3):

```ts
export interface OutsideDispatch {
  type: string;
  exact?: true;
  noFunctionValue?: true;
  module?: string;
  global?: true;
}
```

`outsideDispatchOf` copies each field that is present. No `SCHEMA` version changes: none of these types is
serialized into an answer.

### Rules: the order of proofs

For the member call at a site, the owner strips the wrappers of rule W, then answers by the first level that
settles. A level that refuses (`unknown`) hands over to the next; the cause reported is the first level's.

| Level | Proof | Result `proof` |
|---|---|---|
| P1 | value: the expression is a construction or a literal, or the name's every store holds one kind and the value stays in its function | `value` |
| P2 | declared type: the declaration's annotation, or with none the type of its initialiser | `declared` |
| P3 | framework value factory: the initialiser calls a factory a composed plugin lists | `cell` |
| P4 | type checker over the repository's own sources (ADR-0136) | `declared` |

**Rule W (wrappers seen through).** Parentheses; the non-null assertion `e!`; `e satisfies T`; `e as const`; the
optional chain: for `a?.m()` the receiver is `a`. Soundness: none of them changes the object the member is read
from; `?.` only skips the call when `a` is `null` or `undefined`, and a call that does not run runs nothing.

**Rule W- (wrappers refused).** `e as T` and `<T>e` other than `as const` answer `unknown: type-assertion`. An
assertion is the place where the declared type and the value may disagree by the programmer's own statement.

### Rules: what types a receiver expression

`E` is the receiver after rule W. Each row gives the level that answers and the exact answer.

| # | Receiver form | Level | Answer |
|---|---|---|---|
| T1 | `this`, `super` | - | `unknown: own-instance` (the `this` reading answered before the owner was asked) |
| T2 | `new X(...)` | P1 | the type `X` names by rule N, `proof: value` |
| T3 | a string literal, a template literal, `` `${...}` `` | P1 | `global String`, `value` |
| T4 | an array literal | P1 | `global Array`, `value` |
| T5 | a regular expression literal | P1 | `global RegExp`, `value` |
| T6 | a numeric literal, a bigint literal, `true`, `false` | P1 | `global Number`, `global BigInt`, `global Boolean`, `value` |
| T7 | an object literal, an arrow function, a function expression, a class expression | - | `unknown: structural-type` (the source reader binds object literals as `object`; unchanged) |
| T8 | an identifier `x` whose binding is an import, a class, a function, an enum, a namespace, or more than one declaration | - | `unknown: root-binding` (`rootOrigins` and `rootBindings` read it; unchanged) |
| T9 | an identifier `x` bound to one variable or parameter whose `ReceiverBinding` at the site holds `constructed`, `declared` or `literal` | P1 | that value: `constructed` and `declared` by rule N on the class name, `literal` as T3 to T5; `value` |
| T10 | an identifier `x` bound to one variable, parameter or parameter property, otherwise | P2 | rule D on the declaration |
| T11 | `this.f` | P2 | rule D on the one member `f` the enclosing class declares; inherited: the one member `f` of the nearest repository superclass, when every heritage clause from the class up to it is proven; else `unknown: ambiguous-place` |
| T12 | `e.f` where `e` types as `repository` | P2 | rule D on the one member `f` that class declares (same inheritance rule as T11) |
| T13 | `e.f` where `e` types as `package`, `global` or `cell` | - | `unknown: member-type` |
| T14 | a call `c(...)` | P2 | rule R on the callee `c` |
| T15 | `a ?? b`, `a \|\| b`, `c ? a : b` | - | the type of `a` when `a` and `b` type to the same `kind`, `module`, `name`, `file` and `line`; `proof` is `declared`; else `unknown: union` |
| T16 | an identifier bound to a binding pattern element, a `for...of` or `for...in` variable, a catch variable | - | `unknown: destructured` |
| T17 | `e[k]`, a tagged template, `await e`, `yield e`, `a && b`, a comma expression, an assignment expression, any other expression | - | `unknown: computed-receiver` |
| T18 | any name whose binding the binder reports `dynamic` | - | `unknown: dynamic-scope` |

**Rule N (what a type name names).** For a name `X` written in `file` (an identifier or a qualified name):

1. `deps.repositoryTypeOf(file, X)` answers one class or interface: `repository`, with `nominal` =
   `declaresRestricted` (`import-origins.adapter.ts:616`) of that declaration.
2. Otherwise `deps.outsideTypeOf(file, head, member)` answers `global` or `package`: that type.
3. Otherwise `unknown`: `type-parameter` when the name binds a type parameter or a type an inner scope declares
   (`scoped` of `annotated`), `structural-type` when it binds a type alias, an enum or a type literal,
   `ambiguous-place` otherwise.

**Rule D (the declared type of a declaration).** For a variable, parameter, parameter property, property
declaration, property signature or `get` accessor:

1. It has a type annotation (for an accessor, its return type): the type node is read by `annotated`
   (`function-value-calls.ts:427`), which sees through parentheses, `readonly` and a union with `null` or
   `undefined`. A primitive keyword answers the global `KEYWORD_TYPES` (`import-origins.adapter.ts:531`) maps it to;
   an array type answers `global Array`; a type reference answers rule N on its name; any other type node answers
   `unknown: structural-type`, or `unknown: union` for a union or intersection `annotated` refuses. `proof: declared`.
2. It has no annotation and has an initialiser `I` (for a parameter, its default): the type of `I` by the table
   T2 to T15 and, when that is `unknown: untyped-declaration` or `unknown: outside-call-result`, rule F (level P3).
   `proof: declared`, whatever `I`'s own proof. An initialiser `null` or `undefined` answers
   `unknown: untyped-declaration`.
3. Otherwise `unknown: untyped-declaration`.

Soundness of D2: the language infers the declared type of an unannotated declaration from its initialiser, and every
later store must be assignable to that declared type. So a reassigned binding keeps its declared type; what it loses
is the value proof, which P1 (T9) already refuses through the source reader's store rule. This is the reading
ADR-0108 gives a reassignable property: the declaration still proves the dependence, never what runs.

**Rule R (the type of a call result).** For a call whose callee is `c`:

1. `deps.callableOf(file, c)` answers the signatures of one repository function or method (a bare name bound to a
   function of the file or to an import of one; `this.m`; `X.m` with `X` bound to a repository class and `m` static).
   Every signature states a return type and they are the same type node text: rule D1 on that type node, read in the
   file that declares the callable. An `async` callable or a generator answers `global Promise`, `global Generator`
   or `global AsyncGenerator` whatever it declares.
2. The callable has a signature without a return type, or two signatures that differ: `unknown: undeclared-return`.
3. The callee is not a repository callable: `unknown: outside-call-result`.

**Rule F (framework value factory, level P3).** The initialiser is a call, `deps.cells` is present, the callee's
root is bound to an import of a package, and `deps.cells.typeOf({ module, path })` answers a row, where `path` is the
exported name followed by the member names written after it (`input.required` is `["input", "required"]`): `cell`
with the row's `name` and `members` and the import's `module`. Otherwise the refusal of the level before stands.
The initialiser may be reached through rule W.

### Rules: the answer on the port

`methodAt` maps `typeAt` to a `ReceiverMethod`. `key` is `typeKey` (`import-origins.adapter.ts:539`): the bare name
for a global, `module#name` for a package or a cell.

| # | `typeAt` answers | `methodAt` answers |
|---|---|---|
| A1 | `package` | `{ kind: "outside", type: key, module, noFunctionValue? }`, plus `exact: true` when `proof` is `value` |
| A2 | `global` | `{ kind: "outside", type: key, global: true, noFunctionValue? }`, plus `exact: true` when `proof` is `value` |
| A3 | `cell`, and `site.member` is in `members` | `{ kind: "outside", type: key, module, noFunctionValue? }` |
| A4 | `cell`, and `site.member` is not in `members` | `{ kind: "unknown", reason: "capability-absent" }` |
| A5 | `repository` with `nominal: true`, and every heritage clause of the class, of the types above it and of the types below it is proven | `{ kind: "unproven", candidates }`: the declarations of `site.member` with a body or an initialiser in the class, the repository types above it and the types below it, sorted by `(file, start)`; with none, `{ kind: "unknown", reason: "capability-absent" }` |
| A6 | `repository` otherwise, and every `unknown` | `{ kind: "unknown", reason: "capability-absent" }` |

`noFunctionValue: true` is set when `site.member` is none of `call`, `apply`, `bind`. Until unit U3 the fields
`module`, `global` and `noFunctionValue` are not written (U2a writes `type` and `exact` only).

A6 keeps today's answer, byte for byte, for every site the owner does not settle; relabelling `capability-absent`
by cause belongs to RFC-0042.

### Rules: what the application does with the answer

The application names no language; every rule below is written against the port.

| # | Rule | Where |
|---|---|---|
| B1 | A receiver binding that places nothing (no `outside`, no `target`, no `declaration`, nothing `attributed`) asks the receiver reading, in any language; an `outside` answer makes it `outside: true` with the answer's `dispatch` | `bindCalls`, the `unplaced` rule (`call-binding.ts:272`): the condition `hasTyping(reference.file, "nominal")` is removed |
| B2 | A call the binder proves nothing about is a `declared` binding and is settled by the receiver reading | unchanged (`bindCalls`, `settleDeclared`) |
| B3 | `callers` and `impact` attribute an outside receiver per declaration by `mayRunUnder` | unchanged (ADR-0079 decision 5: `edge-targets.ts` `declaredMethodsOf` and `unprovenInto`, `reverse-calls.ts`) |
| B7 | An index edge called on a value receiver whose receiver verdict is `keep` by `name-match` also reads the receiver reading: an outside receiver the target cannot run under drops the edge (`outside-receiver`, carrying the receiver's name), one it may run under keeps it `unproven` with the `dispatch` | `verdictsOf`, `edge-targets.ts:216`: `declaredMethodsOf` is asked for every kept edge, and its answer is read after `receiverVerdict` (unit U2b). `heldAtReceiver` (`trace-walk.ts:392`) gives `trace` the edge back with its receiver |
| B4 | `trace` settles a receiver binding that carries a `dispatch` by the rule of an `outside` answer (RFC-0043 rules E1 to E6), before `settleReceiver` | `settleBinding`, `trace-walk.ts` (unit U3) |
| B5 | A leaf under an answer with `global: true` is `{ kind: "global", name }` with the root `instanceOf(type, member)`; with a `module`, `{ kind: "import", module, name }` with the root `{ module }`; with neither, `{ kind: "unnamed", name }` | the `settleOutside` of RFC-0043 U8 (unit U3) |
| B6 | `trace` no longer types an annotated or a constructed receiver by itself: the `global` and `package` arms of its annotated block and the outside arms of its constructed block are deleted | `trace-walk.ts:712-735` (unit U3) |

What stays in `trace`: the `nominal` arm of the annotated block (a step at a repository class needs
`executionProven`, ADR-0029 decision 11), the `literal` arm and the relations' `external` arms of `settleReceiver`
(value proofs the base binding already marks `outside`, `call-binding.ts:203-205`).

### Soundness

| Rule | Why it cannot assert something false | The input that would break it, and how it is excluded |
|---|---|---|
| P1, `exact` (A1, A2) | The object is the one a `new X(...)` or a literal created, so its class is `X` itself and no subclass's member runs | A member replaced on the object (`v.add = f`), or on the prototype. The source reader binds `constructed` only where the value stays in its function (`staysLocal`, `function-value-calls.ts:109`); the owner also refuses T9 when the function holds an assignment, an update or a `delete` whose target is a property or element access on `x`. A prototype write is a replaced root (`leafUnlessReplaced`, unchanged) |
| P2 (A1 to A3) | A `declared` answer is never `exact`: `callers`/`impact` keep every declaration that `mayRunUnder` keeps, and `trace` leaves only when the name closure of RFC-0043 keeps none | A repository class below the outside type that overrides the member: its owner has an outside supertype, so `mayRunUnder` keeps it. An object literal or an assigned property of the member's name: the name closure is `open`, the cut stays. A member replaced on a value that escaped: the assignment names the member, the name closure is `open` |
| P2, residual | A repository class that declares the member, has no supertype outside the repository, and is passed where the outside type is declared (structural assignability, `any`, a cast) | Accepted by ADR-0029 (decision 9 and its consequences) for annotated receivers; ADR-0135 decision 7 restates it for every `declared` answer. Not widened: no new receiver form trusts more than an annotation |
| A5 | Candidates are offered only for a nominal class with a wholly proven hierarchy, the same condition under which `trace` steps today (ADR-0029 decision 11) | A structural impostor of a non-nominal class: excluded, A6 answers `unknown` |
| Rule F | The value is what a framework factory returned; only listed members are typed | A repository module shadowing the import name: the root must bind an import of the package (`outsideTypeOf`); a package the repository writes through is a replaced root |
| `noFunctionValue` | Only `call`, `apply` and `bind` run the receiver itself when it is a function | A value typed with a package's function type alias: A1 withholds the mark for those three members, so RFC-0043 rule E4 keeps the cut |
| B1 | The answer is the same one B2 already trusts; B1 only asks it for more calls | A proof the binder holds that the owner contradicts: B1 is asked only when the proof placed nothing |
| Heritage | `mayRunUnder` reads `outsideSupertypes`; with an unproven heritage clause it answers `unknown`, and every declaration may run | Scoped only for a clause proven to name a package type (unit U6); any other unproven clause keeps the snapshot-wide refusal, because the class that writes it may be below any repository class |

### What the design does not do

- It does not read `node_modules`: the declared directory stays with ADR-0037's `TypeBindings`.
- It does not type a member of an outside type (T13), so a chain through a library member keeps its cut.
- It does not change `declaredTypes`, its `subtypedTypes` refusal, or any reader of them other than the two arms of
  `trace` named in B6.
- It adds no `CutCause` and no `CutSubReason`; `RECEIVER_TYPE_CAUSES` is an adapter vocabulary RFC-0042 may map.
- It does not consolidate the consumer-flow vocabulary (`consumer-flow.holders.ts`, `consumer-flow.callees.ts`).

### Framework value factories as data

One table, owned by the framework's plugin (`VALUE_CELLS`, `angular.plugin.ts:20`), read through
`FrameworkPlugin.cells` (`src/core/ports/framework-plugin.port.ts:17`). Composition hands the composed plugins' cells
to the TypeScript pack; only `src/composition/framework-plugins.ts` imports a framework
(`src/composition/framework-plugins.single-rule.test.ts`). Every row, complete (Angular majors from the framework's
public API; `mutate` existed only in 16 and is not listed):

| Module | Path | Since | `run` (unchanged) | Type `name` | `members` | `callable` |
|---|---|---|---|---|---|---|
| `@angular/core` | `signal` | 16 | nothing | `WritableSignal` | `set`, `update`, `asReadonly` | yes |
| `@angular/core` | `computed` | 16 | callback 0 | `Signal` | (none) | yes |
| `@angular/core` | `linkedSignal` | 19 | callback 0 | `WritableSignal` | `set`, `update`, `asReadonly` | yes |
| `@angular/core` | `input` | 17.1 | nothing | `InputSignal` | (none) | yes |
| `@angular/core` | `input.required` | 17.1 | nothing | `InputSignal` | (none) | yes |
| `@angular/core` | `model` | 17.2 | nothing | `ModelSignal` | `set`, `update`, `asReadonly`, `subscribe` | yes |
| `@angular/core` | `model.required` | 17.2 | nothing | `ModelSignal` | `set`, `update`, `asReadonly`, `subscribe` | yes |
| `@angular/core` | `viewChild` | 17.2 | nothing | `Signal` | (none) | yes |
| `@angular/core` | `viewChild.required` | 17.2 | nothing | `Signal` | (none) | yes |
| `@angular/core` | `viewChildren` | 17.2 | nothing | `Signal` | (none) | yes |
| `@angular/core` | `contentChild` | 17.2 | nothing | `Signal` | (none) | yes |
| `@angular/core` | `contentChild.required` | 17.2 | nothing | `Signal` | (none) | yes |
| `@angular/core` | `contentChildren` | 17.2 | nothing | `Signal` | (none) | yes |
| `@angular/core` | `output` | 17.3 | (new row: no `run`) | `OutputEmitterRef` | `emit`, `subscribe` | no |
| `@angular/core/rxjs-interop` | `toSignal` | 16 | nothing | `Signal` | (none) | yes |

A row with no member types no member call (rule A4); it is listed so that the table states what the value is. The
read `x()` of a cell is not a member call: the `this` reading already places it at the field (ADR-0090) and `runOf`
already tells the HTTP reader what it runs; this RFC adds no rule for it. A member call on a cell is listed under
the row's module (`{ kind: "import", module: "@angular/core", name }`).

`output` gets a type row and no `run` row: `runOf` keeps answering `undefined` for it, so the HTTP reader's
behaviour is unchanged.

### External members: when a call leaves and when a candidate is dropped

| Family | Answer | Condition |
|---|---|---|
| `trace` | an external call instead of a cut | the receiver reading answers `outside` and RFC-0043 rule E1 or E2 holds: `exact`, or `noFunctionValue` and the name closure keeps no declaration; and the leaf's root is not replaced |
| `trace` | a cut with fewer candidates | rule E3: the name closure keeps some declarations |
| `callers`, `impact` | the homonym is not a caller's target and produces no `name-only` cut | `exact`, or `mayRunUnder` answers false for that declaration |

The soundness condition, by threat:

| Threat | Covered by |
|---|---|
| A repository class extends or implements the outside type (directly or through a package type) and declares the member | its owner has an outside supertype: `mayRunUnder` keeps it (never applied to an `exact` answer, which is a value of the outside class itself) |
| Declaration merging: a repository `interface X` or `namespace X` merged with an imported or global `X` | the name then binds a repository declaration: rule N answers `repository`, never `package` or `global` |
| Module augmentation (`declare module "pkg" { interface X { m(): void } }`) | adds a signature, no body; a body the repository supplies is a write through the package or a prototype (next row) |
| Prototype assignment (`X.prototype.m = f`, `Object.assign(X.prototype, ...)`) | a replaced root: `isReplaced` (`trace-walk.ts:210`) refuses the leaf; for the dependence families the assigned function is referenced where it is written |
| A member assigned on the instance (`v.m = f`) | P1 refuses a value written through; for a `declared` answer the assignment names `m`, so the name closure is `open` |
| A function value as the receiver | `noFunctionValue` is withheld for `call`, `apply`, `bind`; `holdsFunctionValue` (`trace-walk.ts`) is still asked |

### The scoped heritage rule

Verified: `subtypedTypes` (`import-origins.adapter.ts:341`) and `hierarchyOf` (`this-receiver-methods.ts:104`)
refuse for the whole snapshot when one heritage entry is unproven. The refusal is sound and is not removed: a class
that writes `extends mix(Base)` may be below any repository class. One class of entry is provably narrower:

**Rule H.** A heritage entry `heritageOf` leaves unproven is an *unnamed outside type* when it is a plain chain of
three or more names whose root identifier is bound to an import of a package (`pkg.forms.Base`) and that package is
not in `replacedRoots().packages`. Such an entry is recorded as the outside supertype `"<module>#*"` of the class
that writes it, instead of refusing the snapshot. Every other unproven entry keeps the snapshot-wide refusal.

Soundness: every member path of a package's namespace object is a declaration of that package unless the repository
wrote through the package, which `replacedRoots` records. A package type cannot extend a repository class. So the
entry adds an outside supertype to one class and hides no repository supertype.

`declaredTypes` keeps its own refusal unchanged; rule H applies to `hierarchyOf` (and therefore `outsideSupertypes`
and rule A5) and to `subtypedTypes` alike, because both call `heritageOf`.

### The checker level (ADR-0136)

| Aspect | Rule |
|---|---|
| Program | the one program of `createReceiverTypes` (`receiver-types.ts:26`): engine-owned `OPTIONS`, `createConfinedHost` over the snapshot's own sources, no `tsconfig`, no declared directory, default library only |
| Asked | last, only for a site every earlier level refused, and never for the causes `own-instance`, `root-binding`, `dynamic-scope`, `type-assertion` |
| Accepted | the type of the receiver expression is one object type whose symbol has every declaration in one repository source file (answer `repository`, by rule N on that declaration) or every declaration in a default library file (`isLibrary` of `confined-compiler-host.ts`; answer `global`); or a primitive (`string`, `number`, `bigint`, `boolean`: the matching global). `proof: declared` |
| Refused | `any`, `unknown`, `never`, an error type, a type parameter or a site `inGenericScope` (`receiver-types.ts`), a union after `null` and `undefined` are removed, an intersection, an anonymous object type, a symbol with declarations in more than one file, a declaration in any file that is neither a repository source nor a default library file |
| Where the answers live | `facts.ofInputs("ts-receiver-checked", <the snapshot's TypeScript sources>, derive)`: one derivation per set of sources, holding the answers by site as data; the program is dropped after the derivation (ADR-0037's retention rule) |
| Live reads | never asked: `deps.checker` is absent unless the reader was built for a commit's sources |
| Cost bound | none is defaulted. Unit U8 starts with measurement M4 and is built only if M4 meets its decision table |

A package type is never accepted from the checker: without the package's declarations the checker resolves an
import of it to an error type, which is refused; that is why this level cannot assert anything about a package.

### Shared parsing

`sourceTree(file, target, kind)` keys its cache by `(target, kind)` (`source-tree.ts:39`): a reader that passes
`ts.ScriptKind.TS` and one that passes nothing parse the same `.ts` file twice. `bindFile` builds one program per
call. Unit U1 makes both one per content: the cache key uses the kind the file's extension implies when the caller
passes none, and `bindFile` keeps its result by `(path, content)` behind a `WeakRef`, the pattern `source-tree.ts`
already uses (ADR-0029 decision 4 keeps the binder program per file; it does not require one per reader).

### A literal `require` of a relative path

`readSyntax` (`module-dependencies.adapter.ts:30`) records `require("<literal>")` as `untraversed` unless the file
binds `require` itself (`ownRequire`, `:86`). Rule Q: a call `require(<one string literal>)` whose specifier starts
with `./` or `../`, in a file that does not bind `require`, is a pending dependency with form `require`, resolved
like a literal `import()`; when the resolver answers no file it stays `untraversed` as today. Soundness: an
identifier `require` the file does not bind is the module system's loader in every module format the resolver
serves, unless the repository replaces the global. The rule therefore fails closed: it is off for the whole
extraction when any source's text matches `LOADER_WRITTEN` (unit U7), a pattern that covers every way to write the
name (`require =`, `require:`, `{ require }`, a `function require` that is not `declare`d, a quoted `"require"`).

## Delivery units

| Unit | Behavior | Needs | Ledger rows it may move |
|---|---|---|---|
| U0 | Measurement: the baseline rows and whether the heritage refusal fires | - | none |
| U1 | One parsed tree and one bound file per content | - | none (no difference) |
| U2a | The owner exists and answers through `receiverMethods` (levels P1, P2; rules A1, A2, A5, A6) | U1 | `name-only:-` |
| U2b | The base binding and the edge verdicts ask the reading for a value receiver (B1, B7) | U2a | `name-only:-` |
| U3 | `trace` reads the owner's outside answer; its own type arms are deleted (B4, B5, B6) | U2b; RFC-0043 U8 | `receiver-unproven:-`, `callee-unknown:-` |
| U4 | An optional member call binds like a plain one in the source reader | U2b | `receiver-unproven:-` |
| U5 | Framework value factories type their members (rule F, A3, A4) | U3 | `receiver-unproven:-` |
| U6 | The scoped heritage rule H | U0 (M2), U2a | `name-only:-`, `receiver-unproven:-` |
| U7 | A literal relative `require` is a module edge (rule Q) | - | `dynamic-load:-` |
| U8 | The checker level, after its measurement M4 | U5, U6 | `receiver-unproven:-` |

### Shared by every unit

**First step (S0).** Merge `main` into the unit's branch. Locate every symbol the unit names by its name
(`rg -n "<symbol>" src`), never by its line: other programs are editing these files. If a symbol is gone or no
longer has the role described here, stop (X0).

**Acceptance (A0).** `npm run check` passes. The report states the five items of the acceptance gate
(`odd/tasks/engine-gap-roadmap.md`, "Acceptance gate for every unit"): the owner (`receiver-typing.ts`, or the module
the unit names); the contract (the type the unit names); no second path (the fitness test the unit names finds only
the owner); no chain of special cases (every case is a row of a table of this RFC); the fitness function. Each RED
test was seen failing for the stated reason before the change. The doc comment of every changed export states the
new rule.

**Corpus gate (G0).** Run once, after merging `main`:
`node --import tsx scripts/corpus-gate.ts --corpus <manifest> --base main --candidate <branch>` with the unit's
`--expect` and `--expect-cuts`, on the manifest AGENTS.md names under "Scope and verification". List every
difference of the report with why it is right.

**Stop conditions (X0).** Stop and report, without deciding, when: a symbol named here no longer exists or has
another role; a RED test passes before the change; a sibling test the unit says must stay green fails; the gate
shows a new cut, a removed step or a moved family the unit did not declare; a rule would need a case that is not a
row of this RFC's tables.

**Fixtures.** Adapter tests use the helper of `src/core/adapters/typescript/this-receiver-methods.test.ts`:
`const source = (path: string, ...lines: string[]): SourceFile => ({ path, content: `${lines.join("\n")}\n` });`.
Names are neutral (`Order`, `OrderService`, the package `net-kit`); no fixture names an application. Lines and
columns in an expected value are 1-based positions of the named token; where an unchanged sibling case of the same
test file shows another convention, that convention wins and the report says so.

### U0: measurement

- **Goal.** Fix the numbers the later units are judged against.
- **Prerequisites.** None. No source change; scratch files live in one `mktemp -d` directory and are deleted.
- **Steps.**
  1. S0.
  2. **M1.** Run G0 with `--candidate main` and no expectation. Read, for language `typescript`: `trace`
     `receiver-unproven`, `trace` `callee-unknown`, `callers` plus `impact` `name-only`, `impact` `dynamic-load`.
     Expected 31, 8, 38 (the last is recorded, not compared).
  3. **M2.** For each application of the manifest (never the excluded one), build its sources as `SourceFile[]`
     (every `.ts` file outside `node_modules`, plus the `package.json` files), append
     `{ path: "__probe__.ts", content: "export function probe(value: Map<string, number>): void { value.get(\"k\"); }\n" }`,
     and run in a scratch script (`node --import tsx <scratch>/probe.ts <application root>`):
     `await createImportOrigins(sources).declaredTypes([{ file: "__probe__.ts", line: 1, column: 30, spelled: "Map", owner: { name: "probe", line: 1, endLine: 1 } }])`.
     The answer `{ kind: "global", name: "Map" }` means the refusal does not fire; `{ kind: "unknown" }` means it
     does. For an application where it fires, list each heritage entry (`extends` or `implements` expression) that
     is not an identifier and not a two-name chain, as `call`, `long-chain` (three or more names) or `other`.
- **Decision table.**

  | Reading | Do |
  |---|---|
  | M1 `receiver-unproven` plus `callee-unknown` is 0 | stop: the rows moved since the audit; report |
  | M1 differs from 31 / 8 / 38 otherwise | continue; every later unit compares against the numbers read here |
  | M2 fires in no application | do not build U6; say so in the report |
  | M2 fires in an application and every listed entry there is `long-chain` | build U6 |
  | M2 fires only in applications that list a `call` or `other` entry | do not build U6 (rule H cannot lift those); report the entries by shape |

- **Acceptance.** The report holds the four M1 numbers and the M2 answer per application shape.
- **Corpus gate expectation.** None (no change).
- **Risk.** `Risk: none`.
- **Stop conditions.** X0; the gate or the probe cannot run.

### U1: one parsed tree and one bound file per content

- **Goal.** Every reader of a `.ts` file shares one tree, and every reader of a file's bindings shares one
  `BoundFile`.
- **Prerequisites.** None.
- **Files.** Edit `src/core/adapters/typescript/source-tree.ts` (`sourceTree`),
  `src/core/adapters/typescript/lexical-bindings.ts` (`bindFile`); create or extend
  `src/core/adapters/typescript/source-tree.test.ts` and `lexical-bindings.test.ts`. Touch no reader.
- **Steps.**
  1. S0.
  2. In `sourceTree`, compute the cache key from
     `kind ?? (/\.[cm]?ts$/.test(file.path) ? ts.ScriptKind.TS : undefined)` and pass that same value to the parse.
     For a `.ts`, `.mts` or `.cts` path the compiler infers `TS` when no kind is given, so the tree is the one
     parsed today; for every other extension the key and the parse are unchanged.
  3. In `bindFile`, keep results in a module-level `Map<string, { content: string; bound: WeakRef<BoundFile> }>` by
     `path`: return the held `BoundFile` when the content is equal and the reference is live; otherwise build as
     today and store it. No reader mutates a `BoundFile` (verify with `rg -n "bindFile\(" src`; if one does, X0).
- **RED tests.**
  - `source-tree.test.ts`, "a TypeScript file is parsed once whatever script kind its reader names": for
    `{ path: "src/a.ts", content: "export const a = 1;\n" }`,
    `assert.equal(sourceTree(file, ts.ScriptTarget.Latest), sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS))`.
    Today: two different objects. Sibling: for `src/a.tsx` and `src/a.js` the two calls return different objects,
    before and after.
  - `lexical-bindings.test.ts`, "a file is bound once per content": `assert.equal(bindFile(p, c), bindFile(p, c))`
    (today: different objects); `assert.notEqual(bindFile(p, c), bindFile(p, c + " "))`.
- **Acceptance.** A0. Proof of equal output: the whole suite passes with no test changed, and G0 reports no
  difference. Fitness: `src/core/adapters/syntax.single-rule.test.ts` passes unchanged (the owners of
  `ts.createSourceFile` and `ts.createProgram` are the same files).
- **Corpus gate expectation.** No `--expect` and no `--expect-cuts`: the report must show no difference in any
  family.
- **Risk.** `Risk: item 6 (a shared tree that differed from the private one would change facts silently; the gate's
  "no difference" is the proof)`.
- **Stop conditions.** X0; any gate difference.

### U2a: the owner exists

- **Goal.** `receiver-typing.ts` types a receiver by P1 and P2 and the TypeScript receiver reading returns its
  answer where the `this` reading has none.
- **Prerequisites.** U1.
- **Files.** Create `src/core/adapters/typescript/receiver-typing.ts` and `receiver-typing.test.ts`,
  `src/core/adapters/typescript/receiver-typing.single-rule.test.ts`. Edit `import-origins.adapter.ts`
  (`createImportOrigins`: build the owner, wire `receiverMethods`). Export `annotated` is already exported; export
  nothing else from `function-value-calls.ts`. Do not touch `this-receiver-methods.ts`, any port, any file under
  `src/core/application`.
- **Steps.**
  1. S0.
  2. Write the contract of "The contract" (without `cells` and `checker` behaviour: both are read as absent).
  3. `typeAt(site)`: find the call by the tokens at `(site.line, site.column)` as `nodesAt`
     (`import-origins.adapter.ts:544`) does: the one `CallExpression` whose `expression` is a
     `PropertyAccessExpression` named `site.member` and that starts at the site; none or several answers
     `unknown: ambiguous-place`; no tree answers `unknown: unparsed`. Apply rule W to `access.expression`, then the
     table T1 to T18 in row order, with rules N, D and R. Recursion (T12, T15, D2, R1) carries a depth; at depth 8
     answer `unknown: computed-receiver`.
  4. T9 reads `localReceivers(tree).receiverBindings` for the binding at the site, exactly as
     `createTypeScriptMemberNames` derives it; it is refused (falling to T10) when the enclosing function holds an
     assignment, a compound assignment, `++`, `--` or `delete` whose operand is a property or element access on the
     same binding.
  5. `deps` in `createImportOrigins`: `treeOf` and `boundOf` are the ones `createThisReceiverReading` receives
     (`bindsOncePerFile`); `outsideTypeOf(file, head, member)` is
     `typeOf(file, await bindingOf(file, tree, { root: head, ...(member === undefined ? {} : { member }) }, boundOf(file), NO_OWNER))`,
     the expression `heritageOf` already evaluates; `repositoryTypeOf(file, name)` is `heritageOf(file, name, boundOf, 0)`
     kept only when it answers an object with exactly one declaration; `callableOf(file, callee)`:

     ```text
     callee is an identifier f:
       binding = boundOf(file).bindingOf(identifier)
       declared in the file, every declaration a FunctionDeclaration        -> those declarations
       an import: root = (await rootOrigins([{ file, line, column, kind: "calls", name: f }]))[0]
         root.status === "complete" && root.value.kind === "repository" && root.bare === true && root.value.declared has one segment
                                                                             -> the top-level FunctionDeclarations named so in treeOf(root.value.file)
     callee is this.m:      the MethodDeclarations named m, not static, of the enclosing class
     callee is X.m, X an identifier and repositoryTypeOf(file, X) a class:  its static MethodDeclarations named m
     anything else, or an empty list                                          -> undefined
     ```
  6. `methodAt`: rules A1, A2, A5, A6, writing `type` and `exact` only. A5's hierarchy is `hierarchyOf` of the `this`
     reading; pass the owner the same `heritage` and `heritageFiles` functions it receives rather than reading
     heritage again.
  7. Wire: `receiverMethods: async (sites, signal) => { const own = await thisReceivers.receiverMethods(sites, signal); return Promise.all(own.map((answer, index) => (answer.kind === "unknown" && signal?.aborted !== true ? typing.methodAt(sites[index]!) : answer))); }`.
- **RED test** (`receiver-typing.test.ts`, "a receiver is typed by its value, then by its declared type, and an
  assertion types nothing"). Fixture:

  ```ts
  const USE = "src/use.ts";
  const SOURCES: readonly SourceFile[] = [
    source("package.json", JSON.stringify({ dependencies: { "net-kit": "1.0.0" } })),
    source("src/order.ts",
      "export class Order {",
      "  #id = 1;",
      "  total(): number { return this.#id; }",
      "}",
      "export function loadOrder(): Order { return new Order(); }",
      "export function loadNames(): string[] { return []; }"),
    source(USE,
      'import { Client, Params } from "net-kit";',
      'import { loadNames, loadOrder } from "./order";',
      "export class OrderService {",
      "  client: Client;",
      "  params = new Params();",
      "  run(names: Map<string, number>, raw: unknown): void {",
      "    this.client.send();",
      "    this.params.append();",
      "    names.get(1);",
      "    [1, 2].includes(1);",
      "    loadNames().join();",
      "    loadOrder().total();",
      "    const order = loadOrder();",
      "    order.total();",
      "    new Params().append();",
      "    (raw as Client).send();",
      "  }",
      "}"),
  ];
  const at = (line: number, spelled: string, member: string): ReceiverCallSite => ({ file: USE, line, column: SOURCES[2]!.content.split("\n")[line - 1]!.indexOf(spelled) + 1, member });
  const read = (site: ReceiverCallSite) => createImportOrigins(SOURCES).receiverMethods([site]).then(([answer]) => answer);
  ```

  Assertions (today every one of them answers `{ kind: "unknown", reason: "capability-absent" }`):

  | Site | Expected after |
  |---|---|
  | `at(7, "this.client", "send")` | `{ kind: "outside", type: "net-kit#Client" }` |
  | `at(8, "this.params", "append")` | `{ kind: "outside", type: "net-kit#Params" }` |
  | `at(9, "names", "get")` | `{ kind: "outside", type: "Map" }` |
  | `at(10, "[1, 2]", "includes")` | `{ kind: "outside", type: "Array", exact: true }` |
  | `at(11, "loadNames()", "join")` | `{ kind: "outside", type: "Array" }` |
  | `at(12, "loadOrder()", "total")` | `{ kind: "unproven", candidates: [{ file: "src/order.ts", start: 3, nameLine: 3 }] }` |
  | `at(14, "order", "total")` | the same `unproven` answer |
  | `at(15, "new Params()", "append")` | `{ kind: "outside", type: "net-kit#Params", exact: true }` |
  | `at(16, "(raw as Client)", "send")` | `{ kind: "unknown", reason: "capability-absent" }` (before and after) |

  One more test per refusal that has its own row: "a class without a restricted member offers no candidate" (the
  fixture's `Order` without the `#id` line: lines 12 and 14 answer `unknown`); "a value written through is not
  exact" (`const p = new Params(); p.append = () => {}; p.append();` answers `{ kind: "outside", type: "net-kit#Params" }`
  without `exact`). Sibling proof: `this-receiver-methods.test.ts` passes unchanged.
- **Fitness.** `receiver-typing.single-rule.test.ts`, in the style of
  `src/core/adapters/syntax.single-rule.test.ts`: among the files of `src/core/adapters/typescript`, only
  `receiver-typing.ts` contains the text `kind: "outside"` in a returned object, and only `receiver-typing.ts` and
  `this-receiver-methods.ts` are named as owners of that pattern.
- **Acceptance.** A0.
- **Corpus gate expectation.** `--expect callers:± --expect impact:± --expect trace:± --expect-cuts name-only:-`.
  An index edge without a value receiver now reads an outside answer (`declaredMethodsOf`). In `trace` only two
  differences are right: a `receiver-unproven` cut loses its `capability-absent` sub-reason where the reading now
  answers `outside` (`trace` still holds that answer unproven, `unprovenOutside`, until U3); and a cut narrows to
  the candidates of rule A5, or becomes a step where `runsOnly` (`trace-walk.ts`) proves one body among them. No
  external call may appear or disappear.
- **Risk.** `Risk: item 6 (a wrong type would drop a real caller; every rule has a fixture row and the answer is
  attributed only through mayRunUnder)`.
- **Stop conditions.** X0; an external call appears or disappears in `trace`; a `callers` or `impact` answer loses
  a caller whose declaration has an outside supertype.

### U2b: the base binding and the edge verdicts ask the reading for a value receiver

- **Goal.** Rules B1 and B7.
- **Prerequisites.** U2a.
- **Files.** Edit `src/core/application/navigation/call-binding.ts` (`bindCalls`),
  `src/core/application/navigation/edge-targets.ts` (`OutsideReceiver`, `verdictsOf`),
  `src/core/application/trace/trace-walk.ts` (`heldAtReceiver`), and their tests. Touch no adapter.
- **Steps.**
  1. S0.
  2. B1: in `bindCalls`, in the condition that pushes to `unplaced`, delete `hasTyping(reference.file, "nominal") &&`.
  3. B7: add `receiver?: string` to `OutsideReceiver` ("the name the call's receiver is written with, when it is a
     value"). In `verdictsOf`, ask `declaredMethodsOf(kept, signal)` for every kept edge. In the loop, keep the two
     first branches for `receiver === undefined`. For `receiver !== undefined` compute
     `const verdict = await receiverVerdict(followed, receiver, binder, bindings)` (or the existing fallback when
     `binder` or `bindings` is absent); then, only when `verdict.kind === "keep" && verdict.derivation === "name-match"`
     and `method` is an `outside-receiver`, store `{ kind: "drop", root: { ...method, receiver } }`; when `method`
     is `unproven` with a `dispatch`, store `{ ...verdict, unproven: method }`; otherwise store `verdict`.
  4. In `heldAtReceiver`: `if (verdict.root.kind === "outside-receiver") return verdict.root.receiver === undefined ? { kind: "keep" } : { kind: "keep", receiver: verdict.root.receiver, derivation: "name-match" };`
     so `trace` settles the edge exactly as before this unit.
- **RED tests.** Build both on the helpers the two test files already have; write no new harness. In
  `call-binding.test.ts`: the `World` fixtures `outsideReceiver(receiver: ReceiverMethod)` and `nominalReceiver()`, the
  runner `bound(world, body, calls)` and the projection `summary(binding)`; the existing test "a Java member call whose
  receiver the pack reads as a type outside the repository is an outside dispatch" is the model to copy, with the
  file's extension changed to `.ts` and the `binder.receiverOf` answer stated below. In `edge-targets.test.ts`: the
  builders `edgeTargetsOf(world)` and `verdictOf(world, from)` and the fixtures `proofOf` and `placeOf`. If a helper
  named here is gone or cannot state the fake answers below without a change to its signature, stop and report (X0).
  - `call-binding.test.ts`, "a receiver binding that places nothing asks the receiver reading in any language": a
    call `client.send` in `src/use.ts` (a structural file), `binder.receiverOf` answering
    `{ link: "syntax", holds: { kind: "annotated", type: "Client", line: 4, column: 11 } }` and
    `origins.receiverMethods` answering `[{ kind: "outside", type: "net-kit#Client" }]`. Expected binding:
    `{ kind: "receiver", proof, candidates, attributed: [], outside: true, dispatch: { type: "net-kit#Client" } }`.
    Today: the same object without `outside` and `dispatch`, and `receiverMethods` is not called.
  - `edge-targets.test.ts`, "an edge on a value receiver the reading proves outside is dropped unless its target may
    run under that type": one `calls` edge from `OrderService.run` to `Cache.get` at a place whose receiver is the
    value `names`; `receiverMethods` answers `{ kind: "outside", type: "Map" }`; `outsideSupertypes` answers
    `{ kind: "types", types: [] }`. Expected verdict: `{ kind: "drop", root: { kind: "outside-receiver", type: "Map", receiver: "names" } }`.
    Today: `{ kind: "keep", receiver: "names", derivation: "name-match" }`. With `outsideSupertypes` answering
    `{ kind: "types", types: ["net-kit#Base"] }`: `{ kind: "keep", receiver: "names", derivation: "name-match", unproven: { kind: "unproven", dispatch: { type: "Map" } } }`.
  - Sibling proofs: an edge whose receiver verdict is `proven` or a `redirect` keeps that verdict whatever the
    reading answers (one test); the nominal `unplaced` test of `call-binding.test.ts` passes unchanged;
    `trace-queries.test.ts` passes unchanged.
- **Acceptance.** A0. Fitness: `src/composition/edge-targets.single-rule.test.ts` passes unchanged.
- **Corpus gate expectation.** `--expect callers:± --expect impact:± --expect-cuts name-only:-`. `trace` must not
  move.
- **Risk.** `Risk: item 3 (the condition removed in bindCalls is shared by every language: a nominal language is
  unaffected because it already passed the condition; a structural language is the requested change)`.
- **Stop conditions.** X0; `trace` moves; a Java row moves.

### U3: trace reads the owner's outside answer

- **Goal.** Rules B4, B5 and B6: one rule decides when a TypeScript member call leaves the repository.
- **Prerequisites.** U2b. RFC-0043 U8 (`settleOutside`, `keptUnder`, the deletion of `unprovenOutside`) and the
  fields `noFunctionValue` and `module` of RFC-0043 "Port changes" must be on `main`. If they are not, deliver them
  first exactly as RFC-0043 writes them (they name no language and their RED test uses fakes only), then this unit.
- **Files.** Edit `src/core/ports/import-origins.port.ts` (`ReceiverMethod`),
  `src/core/application/navigation/call-binding.ts` (`OutsideDispatch`, `outsideDispatchOf`),
  `src/core/application/trace/trace-walk.ts` (`settleOutside`, `settleBinding`, the annotated and constructed
  blocks), `src/core/adapters/typescript/receiver-typing.ts` (`methodAt`), their tests, and
  `docs/architecture/rfc/0013-trace-and-patterns.md` (add to R5: "A TypeScript receiver the pack answers `outside`
  for is settled by ADR-0133 and ADR-0135"). Do not touch `declaredTypes` or `subtypedTypes`.
- **Steps.**
  1. S0.
  2. Port: add `global?: true` to the `outside` member as "The contract" writes it. Application: add
     `noFunctionValue`, `module` and `global` to `OutsideDispatch`; `outsideDispatchOf` copies each one present.
  3. Owner: `methodAt` writes `module` (A1, A3), `global: true` (A2) and `noFunctionValue: true` when `site.member`
     is none of `call`, `apply`, `bind`.
  4. B5: in `settleOutside`, the leaf and its root are
     `outside.global === true ? [{ kind: "global", name: reference.name }, instanceOf(outside.type, name)] : outside.module !== undefined ? [{ kind: "import", module: outside.module, name: reference.name }, { module: outside.module }] : [{ kind: "unnamed", name: reference.name }, { path: [], member: name }]`.
  5. B4: in `settleBinding`, before the line that calls `settleReceiver`:
     `if (binding.kind === "receiver" && binding.dispatch !== undefined) return settleOutside(reference, name, { kind: "outside", ...binding.dispatch });`.
     In the loop that settles a kept edge held at its receiver (`unproven`, filled from `valueRoots`), when the
     receiver reading's answer for that edge is `outside`, call `settleOutside` with a reference built from the
     edge (as RFC-0043 U8 step 4 builds one) instead of `settleReceiver`.
  6. B6: in the annotated block delete the two branches `type?.kind === "global"` and `type?.kind === "package"`
     (their sites fall to `typed.push`); in the constructed block delete the `ambient` and `external` branches (every
     site goes to `settleByName(reference, name, named)`). Keep the `nominal` branches.
- **RED test** (`trace-queries.test.ts`, "a member call on a receiver declared with a type outside the repository
  leaves it unless a declaration of the name may run under that type"), with the file's `factOf`, `valueOf` and
  `cutsOf` and its `boundCall` fixture: `boundCall({ kind: "annotated", type: "Client", line: 8, column: 17 })`
  plus `receivers: { save: { kind: "outside", type: "net-kit#Client", module: "net-kit", noFunctionValue: true } }`.
  - With no declaration of `save` able to run under the type (the fake `outsideSupertypes` answers
    `{ kind: "types", types: [] }` for `Repo.save` and `Other.save`): `valueOf(fact).steps[0]?.external` is
    `[{ kind: "import", module: "net-kit", name: "store.save" }]` and `cutsOf(fact)` is `[]`. Today: one
    `receiver-unproven` cut listing `Repo.save` and `Other.save`.
  - With `outsideSupertypes` answering `{ kind: "types", types: ["net-kit#Base"] }` for `Other.save`: no external
    call and one cut whose candidates are the anchor of `Other.save` only.
  - With the answer `{ kind: "outside", type: "Map", global: true, noFunctionValue: true }` and no declaration able
    to run: the external call is `{ kind: "global", name: "store.save" }`.
  - With member `call` and the answer without `noFunctionValue`: one cut with no candidate, no external call.
  - Sibling proofs: the file's test of a `nominal` annotated receiver stepping at the class's method passes
    unchanged; its test of a `literal` receiver passes unchanged; the test of a relations `external` proof passes
    unchanged.
- **Acceptance.** A0; `rg -n "kind === \"package\"" src/core/application/trace/trace-walk.ts` finds no match in the
  annotated block. Fitness: extend `receiver-typing.single-rule.test.ts` with "no file under
  `src/core/application/trace` calls `declaredTypes` except for the `nominal` step and `returnedMethod`" (two
  allowed call sites, named in the rule's `owners`).
- **Corpus gate expectation.** `--expect trace:± --expect-cuts receiver-unproven:- --expect-cuts callee-unknown:-`.
  An external call that stood under the deleted arms may become a cut only where the name closure keeps a
  declaration or is open; list each such place with the declaration or the source that keeps it.
- **Risk.** `Risk: item 6 (an external call asserts that nothing of the repository runs; the name closure and
  mayRunUnder hold it per call, and the RED test's four cases pin both directions)`.
- **Stop conditions.** X0; a step disappears; an external call appears at a place that was a step; more external
  calls become cuts than cuts become external calls.

### U4: an optional member call binds like a plain one

- **Goal.** Rule W in the source reader: `a?.m()` and `this.f?.m()` get the `ReceiverBinding` of `a.m()` and
  `this.f.m()`.
- **Prerequisites.** U2b.
- **Files.** Edit `src/core/adapters/typescript/function-value-calls.ts` (`receiverBindings`),
  `src/core/adapters/typescript/declared-member-names.adapter.test.ts`. If the callee spelling the index or the
  syntax reader writes for the call keeps `?.`, also `compactSpelling`
  (`src/core/domain/shared/call-place.ts:21`): it removes `?.` in favour of `.`; that function is language-agnostic
  text normalisation and `?.` is the only token added.
- **Steps.**
  1. S0.
  2. In `receiverBindings`, delete the branch that answers `COMPUTED` when `access.questionDotToken !== undefined`;
     the code after it reads `access.expression` as for a plain access. Keep the type-assertion branch.
  3. Run the RED test; if the binding is produced but `CallBinder.receiverOf` still reports `unspelled` in the
     application test below, apply the `compactSpelling` change.
- **RED test** (`declared-member-names.adapter.test.ts`, "an optional member call binds its receiver like a plain
  one"), with the file's `read` helper:
  `read(["class OrderService {", "  private readonly log: Log;", "  run(items: Map<string, number>): void {", "    items?.get(\"a\");", "    this.log?.write();", "  }", "}"])`.
  Expected `receiverBindings` entries for lines 4 and 5: `holds` is
  `{ kind: "annotated", type: "Map", line: 3, column: 14 }` and `{ kind: "annotated", type: "Log", line: 2, column: 25 }`.
  Today both hold `{ kind: "computed" }`. Sibling: the same source with `.` instead of `?.` answers the same two
  bindings before and after; a call on `(items as any)?.get` stays `computed`.
- **Acceptance.** A0. Fitness: none added; the rule is one deleted branch, guarded by the RED test.
- **Corpus gate expectation.** `--expect trace:± --expect callers:± --expect impact:± --expect-cuts receiver-unproven:-`.
- **Risk.** `Risk: none`.
- **Stop conditions.** X0; a binding changes for a call that writes no `?.`.

### U5: framework value factories type their members

- **Goal.** Rule F and rows A3, A4, over the one table of the plugin.
- **Prerequisites.** U3.
- **Files.** Edit `src/core/ports/framework-cells.port.ts` (`ValueCellType`, `FrameworkValueCells.typeOf`),
  `src/core/adapters/frameworks/angular/angular.plugin.ts` (`VALUE_CELLS`, `ANGULAR_CELLS`),
  `src/composition/language-packs.ts` and `src/composition/compose.ts` (hand the composed cells to the TypeScript
  pack's `origins` factory), `src/core/adapters/typescript/import-origins.adapter.ts` (`createImportOrigins` options:
  `cells?: FrameworkValueCells`), `receiver-typing.ts`, `src/composition/framework-plugins.single-rule.test.ts`, the
  tests. Do not edit `consumer-flow.holders.ts` or `consumer-flow.callees.ts`.
- **Steps.**
  1. S0.
  2. Port: the two types of "The contract".
  3. Plugin: replace the value type of `VALUE_CELLS` by `{ run?: ValueCellRun; type: ValueCellType }` and write the
     fifteen rows of "Framework value factories as data". `runOf` answers the row's `run`; `typeOf` answers the
     row's `type`.
  4. Composition: where `compose.ts` composes the framework plugins and builds the language packs, merge the
     plugins' `cells` into one `FrameworkValueCells` (first row found wins for `runOf` and `typeOf`; `projections`
     is the union) and pass it to the TypeScript pack, whose `origins` factory passes `{ cells }` to
     `createImportOrigins`. No file under `src/core/adapters/typescript` imports a framework.
  5. Owner: rule F in D2, and A3, A4.
- **RED test** (`receiver-typing.test.ts`, "a member of a value a framework factory returned is the framework's"),
  with `createImportOrigins(SOURCES, { cells })` and
  `const cells = { runOf: () => undefined, projections: new Set<string>(), typeOf: ({ module, path }) => (module === "view-kit" && path.join(".") === "cell" ? { name: "Cell", members: new Set(["set"]), callable: true } : undefined) };`
  over

  ```ts
  source("package.json", JSON.stringify({ dependencies: { "view-kit": "1.0.0" } })),
  source("src/panel.ts",
    'import { cell } from "view-kit";',
    "export class Panel {",
    "  count = cell(0);",
    "  run(): void {",
    "    this.count.set(1);",
    "    this.count.reset();",
    "  }",
    "}"),
  ```

  Line 5 answers `{ kind: "outside", type: "view-kit#Cell", module: "view-kit", noFunctionValue: true }`; line 6
  answers `{ kind: "unknown", reason: "capability-absent" }`. Today both answer `unknown`. Without `cells` both
  answer `unknown` (sibling). `angular.plugin.test.ts` (create beside the plugin if absent): for each of the
  fifteen rows, `ANGULAR_CELLS.typeOf!({ module, path })` deep-equals the row, and `runOf` answers what it answers
  today for the fourteen existing rows and `undefined` for `output`.
- **Fitness.** Extend `framework-plugins.single-rule.test.ts` with a vocabulary rule: the quoted names `"signal"`,
  `"linkedSignal"`, `"toSignal"` and `"asReadonly"` appear under `src/core` only in `angular.plugin.ts`, with
  `pending: ["typescript/consumer-flow.holders.ts", "typescript/consumer-flow.callees.ts"]` (their consolidation
  is listed under "Not covered").
- **Acceptance.** A0.
- **Corpus gate expectation.** `--expect trace:± --expect callers:± --expect impact:± --expect-cuts receiver-unproven:-`
  (the cuts on a field built by a framework factory, 3 at the audit).
- **Risk.** `Risk: item 3 (a port gains an optional method and the TypeScript pack's factory an optional option;
  both additive)`.
- **Stop conditions.** X0; the HTTP call-site reader's answers move.

### U6: the scoped heritage rule

- **Goal.** Rule H.
- **Prerequisites.** U0 with the decision "build U6"; U2a.
- **Files.** Edit `src/core/adapters/typescript/import-origins.adapter.ts` (`heritageOf`),
  `this-receiver-methods.test.ts`. Do not touch `subtypedTypes` or `hierarchyOf`: both read `heritageOf`.
- **Steps.**
  1. S0.
  2. In `heritageOf`, before the early `return undefined` taken when `rest.length > 0`: when `written` is a plain
     chain, `head` is an identifier, and `typeOf(file, await bindingOf(...{ root: head }...))` has no answer but the
     root's binding is an import whose origin is `external` with module `m`, and
     the `packages` of the same reader's `replacedRoots()` do not hold `m`, return the string `` `${m}#*` ``.
- **RED test** (`this-receiver-methods.test.ts`, "a heritage entry that names a member path of a package is an
  outside supertype of its class alone"): add to a copy of `SOURCES`
  `source("src/deep.ts", 'import * as kit from "base-kit";', "export class Deep extends kit.forms.Base {", "  draw(): void {}", "}")`.
  `outsideSupertypes([{ file: "src/store.ts", start: 2, name: "save" }])` answers `{ kind: "types", types: [] }`
  (today `{ kind: "unknown" }`), and for `{ file: "src/deep.ts", start: 3, name: "draw" }` answers
  `{ kind: "types", types: ["base-kit#*"] }`. Sibling: with `OPEN` in the sources (a `call` entry) both answer
  `{ kind: "unknown" }`, before and after; with a source that writes `kit.forms.Base = Local` both answer `unknown`.
- **Acceptance.** A0. Fitness: none added; `heritageOf` stays the one reader of a heritage entry (the existing
  rule of `syntax.single-rule.test.ts` on heritage clauses, if present, passes unchanged).
- **Corpus gate expectation.** `--expect callers:± --expect impact:± --expect trace:± --expect-cuts name-only:- --expect-cuts receiver-unproven:-`,
  only in the applications M2 listed.
- **Risk.** `Risk: item 6 (lifting a refusal widens what every heritage reader proves; the sibling tests pin the
  two inputs that must keep refusing)`.
- **Stop conditions.** X0; an application M2 did not list moves.

### U7: a literal relative `require` is a module edge

- **Goal.** Rule Q.
- **Prerequisites.** None.
- **Files.** Edit `src/core/domain/impact/module-dependency.ts` (`ModuleDependency.form`),
  `src/core/adapters/typescript/module-dependencies.adapter.ts` (`readSyntax`, `extract`),
  `module-dependencies.adapter.test.ts`. Read, and change only if a test fails,
  `src/core/application/impact/importers.ts` and `src/core/application/outline/outline.ts`.
- **Steps.**
  1. S0.
  2. `ModuleDependency.form` becomes `ModuleReferenceForm | "import-equals" | "require"`; its comment gains
     "`require`: a literal relative `require` in a file that binds no `require`; static like `import-equals`".
  3. Add `const LOADER_WRITTEN = /\brequire\s*(?:=(?!=)|:)|(?<!declare\s)\bfunction\s+require\b|\{\s*require\s*[,}]|["'`]require["'`]/;`
     and, in `extract`, `const loaderWritten = sources.some(({ content }) => LOADER_WRITTEN.test(content));`, passed
     to `readSyntax`.
  4. In `readSyntax`, a `require` call with a string-literal specifier that starts with `./` or `../`, with
     `ownRequire` false and `loaderWritten` false, is pushed to `pending` like a `dynamic-import`
     (`kind: "import"`, `typeOnly: false`, `form: "require"`, `bindings: []`) and adds
     `JSON.stringify({ reference: "require", specifier })` to `statements`. When the resolver later answers no
     repository file for it, remove it from the dependencies and push the `untraversed` entry written today.
  5. `importers.ts`: a `require` dependency lands in `imports` (the branch static forms take); `outline.ts`: it is
     an `imported` entry. Change nothing if the existing branches already do this.
- **RED test** (`module-dependencies.adapter.test.ts`): rename "a require of a string literal stays outside module
  traversal and carries the file it names" to "a require of a relative string literal is a module dependency" and
  assert, for `[item, { path: "src/use.ts", content: "const lib = require('./lib/item');" }]`:
  `result.untraversed` is `[]` and `result.dependencies` deep-equals
  `[{ file: "src/use.ts", line: 1, endLine: 1, offset: 12, specifier: "./lib/item", kind: "import", typeOnly: false, form: "require", target: { kind: "repository", file: "src/lib/item.ts" }, bindings: [] }]`.
  Today: `dependencies` is `[]` and `untraversed` holds the reference. Siblings, each one test: `require('pkg')`
  stays `untraversed` with its external target (the existing "literal and computed references" test, unchanged);
  a file that declares `function require() {}` keeps the `LOCAL_REQUIRE` answer; with a second source
  `globalThis.require = load;` the first assertion's `dependencies` is `[]`; `require(name)` stays `untraversed`
  without a specifier.
- **Acceptance.** A0. Fitness: none added; `readSyntax` stays the one reader of module references.
- **Corpus gate expectation.** `--expect impact:± --expect-cuts dynamic-load:-`; an `impact` answer may gain files
  reached through the new edge.
- **Risk.** `Risk: item 3 (ModuleDependency.form gains a member that outline and importers read; additive, and
  both consumers are named in the steps)`.
- **Stop conditions.** X0; a consumer of `ModuleDependency.form` other than the two named switches on the form.

### U8: the checker level

- **Goal.** Level P4 as "The checker level" states it, if measurement M4 says so.
- **Prerequisites.** U5, U6 (or U0's decision not to build U6). ADR-0136 accepted.
- **Steps, part 1 (measurement M4; no source change).**
  1. S0.
  2. Run G0 with `--candidate main`; list the places of the remaining `trace`/typescript `receiver-unproven` and
     `callee-unknown` cuts per application.
  3. In a scratch script per application, build one program with the `OPTIONS` of `receiver-types.ts` and
     `createConfinedHost` over the application's sources; for each listed place, find the receiver expression as
     `typeAt` does and apply the "Accepted" and "Refused" rows. Record: accepted places per application; the wall
     time of program creation plus the queries; the wall time of the base `trace` query of the manifest on that
     application, from the same machine and run.

  | M4 reading | Do |
  |---|---|
  | no place accepted in any application | do not build; record the numbers in the report and in ADR-0136, whose level is then not built |
  | places accepted in one application only | stop and report to the owner: a level that serves one application is the observed case, not a mechanism |
  | places accepted in two or more applications, and in each the program's wall time is at most that application's base `trace` query time | build part 2 |
  | places accepted in two or more applications, and the program costs more than the base query in one of them | stop and report both numbers to the owner |

- **Files, part 2.** Edit `src/core/adapters/typescript/receiver-types.ts` (add `typeOfReceiver(site)` beside
  `mayHold`, over the same lazy program), `receiver-typing.ts` (`deps.checker`), `import-origins.adapter.ts` (pass
  `checker` only when `facts` is present and the reader was built for a commit's sources; see step 5),
  `receiver-types.test.ts`, `receiver-typing.test.ts`.
- **Steps, part 2.**
  4. `typeOfReceiver(site): ReceiverType`: `checker.getTypeAtLocation(receiverExpression)`; remove `null` and
     `undefined` from a union with `getNonNullableType`; apply the "Refused" row first (each refusal answers
     `unknown` with the cause the earlier level reported), then the "Accepted" row.
  5. Keep the answers with `facts.ofInputs("ts-receiver-checked", <the TypeScript sources>, derive)`, where
     `derive` builds the program, answers every site the owner asked in that read, and returns plain data. The
     reader is told the sources are a commit's by the caller that builds it for a snapshot whose `kind` is not
     `"live"` (`nodeModulesReading`, `src/core/application/snapshot/base-reading.ts:223`, shows where that fact is
     read); thread it as an optional boolean of the TypeScript pack's `origins` factory in
     `src/composition/language-packs.ts`, not through a port.
- **RED test** (`receiver-typing.test.ts`, "a receiver no declaration types is typed by the checker only where
  its type is a repository class or a language global"): for
  `source("src/c.ts", "export class Order { #id = 1; total(): number { return 1; } }", "const orders = [new Order()];", "export function run(): void {", "  orders[0].total();", "  orders.map((order) => order).at(0);", "}")`,
  line 4 answers `{ kind: "unproven", candidates: [{ file: "src/c.ts", start: 1, nameLine: 1 }] }` and line 5
  (`.at`) answers `{ kind: "outside", type: "Array", global: true, noFunctionValue: true }`; today both `unknown`.
  Siblings: with an import of an undeclared package as the element type both stay `unknown`; on a reader built
  without `facts` both stay `unknown`.
- **Acceptance.** A0. Fitness: `syntax.single-rule.test.ts` passes unchanged (`receiver-types.ts` is already an
  owner of `ts.createProgram`).
- **Corpus gate expectation.** `--expect trace:± --expect-cuts receiver-unproven:-`, on the places M4 accepted.
- **Risk.** `Risk: item 5 (a type program on the answer path costs time and memory; M4's table decides before any
  code, and the answers are derived once per set of sources)`.
- **Stop conditions.** X0; a `live` read builds the program; an answer names a package type.

## Not covered

| Case | What the engine keeps answering | Why it stays |
|---|---|---|
| Provider graph: `useClass`, `useExisting`, `useFactory`, `multi`, `inject(TOKEN)` of a repository contract | the relations' `replaceable` proof and a `receiver-unproven` cut | which class a token yields is a fact of the injector, not of a receiver's type; it needs its own design |
| Template input and output bindings (`(saved)="onSaved()"`, `[value]="x"`) | no step from `emit` to the parent's handler; the call is an external call of the framework | a template edge, not a receiver; deferred |
| Classic NgRx (`store.dispatch(action)` to reducers and effects) | an external call of the package | a dispatch table read from decorators and creators; deferred |
| A member of an outside type (`s.split(",").map(...)`, `globalThis.location.reload()`) | `receiver-unproven` (T13) | needs the library's or the package's declarations; ADR-0037 covers the declared directory |
| The result of a package call (`createHash("x").update(...)`) | `receiver-unproven` (rule R3) | same |
| A platform module without declarations (`Buffer.from`) | today's cut | same |
| A bare-spelled call of a function-typed parameter or of a destructured member (`callback()`, `const { save } = repo; save()`) | `callee-unknown` | the callee, not a receiver; rule T16 refuses destructuring |
| A computed member (`this.handlers[name]()`) | `receiver-unproven` with form `computed` | the member is not named |
| `super(...)` in a class that extends a language global | today's cut | a chaining call; the `this` reading's implicit-chain rule owns it |
| A non-nominal repository type as the declared type of a new receiver form | `receiver-unproven` (A6) | ADR-0029 decision 11: a structural type proves no body |
| An `unproven` answer with candidates on a receiver binding a syntax proof produced | today's candidates | B1 applies an `outside` answer only; widening it changes a nominal language |
| The consumer-flow vocabulary of the same factories | two tables | listed `pending` in the fitness rule of U5; its consolidation is a refactor with no ledger row |
| The sub-reason of a cut the owner cannot settle | `capability-absent` | RFC-0042 owns cut causes |

## Resolved questions

(owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | A new port method for receiver types, or the existing receiver reading? | The existing `receiverMethods`: its `outside`, `unproven` and `unknown` answers already carry what every family needs, and ADR-0079's `mayRunUnder` already attributes them. Discarded: a `receiverTypes` port method (a second question for the same fact, and a parallel path in three families) |
| 2 | Does the declared type of an unannotated declaration count? | Yes, from its initialiser (rule D2), as `declared`, because the language infers exactly that. Discarded: only annotations (misses every field built by a factory or a constructor) |
| 3 | Is a reassigned binding typed? | By its declared type only, never as a value (ADR-0108's reading). Discarded: refusing it (loses the declared type the compiler enforces) |
| 4 | Is a type assertion a proof? | No (rule W-). Discarded: trusting it like an annotation (an assertion is where the two disagree by statement). Owner may overturn |
| 5 | The external-call rule for TypeScript: its own, or ADR-0133's? | ADR-0133's, with the pack's marks; `trace`'s two type arms are deleted. Some of today's external calls become cuts where a declaration may run or the name is open: those were unproven. Discarded: keeping the arms (a second path, and unsound for a transitive outside supertype). Owner may overturn |
| 6 | Trust in a declared outside type when a repository class without outside supertypes declares the member | Kept as ADR-0029 decision 9 accepts it; restated in ADR-0135 decision 7. Discarded: keeping every homonym (the `name-only` row would never move). Owner may overturn |
| 7 | Scope the heritage refusal for every unproven entry? | Only for a member path of a package (rule H); a call or any other expression may place its class below any repository class. Discarded: per-class scoping of every entry (unsound) |
| 8 | The checker without `node_modules`: do it? | Only as the last level, over the program that already exists, accepted for repository classes and language globals, and only if M4 shows it settles places in two applications at no more than the base query's cost (ADR-0136). Discarded: always on (ADR-0018's cost), never (ADR-0111 already pays for the program). Owner may overturn |
| 9 | A custom global `require` | Rule Q fails closed for the whole extraction when any source writes the name. Discarded: trusting the name (a false edge) |
| 10 | Framework rows without members | Listed with an empty member set, so the table states what the value is and A4 refuses its members. Discarded: omitting them (the table would not say why `x.foo()` on an input signal is untyped) |
| 11 | Units of this RFC that need RFC-0043 U8 | U3 names it as a prerequisite and tells the implementer to deliver it first if absent. Discarded: writing the same rule twice |
