# RFC-0013: Trace and patterns

- Status: Draft, 2026-11-01; open questions accepted by the owner ("Acepto las recomendaciones"); `patterns` deferred;
  trace slice 1 implemented, 2026-11-06
- Related: [RFC-0002](0002-facts-contract.md), [RFC-0007](0007-extension-model.md), [RFC-0010](0010-impact-queries.md),
  [RFC-0011](0011-cross-repository-impact.md), [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md),
  [ADR-0015](../adr/0015-index-reuse-by-content.md), [ADR-0017](../adr/0017-owner-of-a-member-expands-only-whole-type-edges.md),
  [ADR-0029](../adr/0029-lexical-bindings-from-the-typescript-binder.md)

**In short:** two read-only query families for an agent that must understand a repository and plan a change. `trace`
answers what an entrypoint or a symbol executes, as a tree in source order that ends at effects (HTTP calls, data
access, messages, external libraries). `patterns` answers what kind of thing a file or symbol is in this repository,
which existing members of that kind are the most typical, which conventions they share, which styles coexist, and what
is created with one; with no target it lists every kind, which is the repository's architecture map. Both are facts
derived from code, contracts and git, with evidence and completeness.

## Why

The owner (translated, 2026-11-01): "it must be analyzed well how to implement them, so they produce structures just as
the LLM needs them, with optimal quality and efficiency. The forward flow could be called trace; the precedent or
architecture-pattern finder I do not know how to implement deterministically, it is what seems most complex to me, so
that its answers are of quality and accurate."

An agent's costliest failures in a complex task are not the edit: they are reading a flow file by file and losing it
at the third layer, and writing code that works but does not follow the way the repository already does that thing.
`callers` and `impact` cover what a change breaks (inbound); nothing covers what code does (outbound) or how this
repository builds a thing of a given kind.

## Trace

### The question and the answer the agent needs

"What does `POST /orders/checkout` do?", "what happens when this page loads or this button is pressed?". The agent
needs: the steps in the order they run, where each one is (file:line, to open only what matters), which steps leave the
repository or touch data (the effects, which decide risk and tests), and where the answer stops knowing. It does not
need every getter, every library call or every type named on the way, but it must be able to see they exist.

### Evidence that shaped the rules (probe workspace, 2026-11-01)

| Finding | Number | Consequence |
|---|---|---|
| The index resolves only part of the calls of a TypeScript frontend: resolved `calls` edges against unresolved call references (non-test sources) | 5,562 against 8,936 | a trace over resolved edges alone misses most calls; ye-ast resolves receivers itself (rules R3-R6) |
| Unresolved calls whose last name no declaration of the repository has | 5,224 of 8,936 | they cannot run repository code: external by the closed-world rule R6, with no cut |
| Unresolved `this.<field>.<member>` with a member name the repository declares | 1,912 | settled by `FieldOrigin` (R3) |
| Unresolved calls with a repository name and no receiver origin | 1,800, led by `input`, `map`, `push`, `filter`, `set`, `min`, `max`, `now` | most are a global (`Math`, `Date`) or an import (`input` from the framework): settled by binding (R4); the rest are cuts with their candidates |
| A Java service: the controller calls the interface method of its application service; DTO getters, builder chains, `log.info` and `ResponseEntity.ok` sit between the steps that matter | — | dispatch through `implements` (R7), never codegraph's heuristic bridge; leaves without children folded (R10); builder chains resolved through declared return types (R5) |
| No type checker runs today; library types (`node_modules`, jars) are not in the snapshot | — | receivers are resolved from syntax and declarations, never from a compiler type of a library the snapshot lacks |
| The Angular template adapter reads component, directive and pipe uses, not event bindings | — | a component's handlers from its template are read before a page trace is useful (R9) |

### Receiver resolution, in order

A call is `callee(args)` or `receiver.member(args)`; each rule settles it to one of: a declaration of the repository
(a step), an external target `module#Type.member` or `global#name.member` (a leaf), or a cut with the candidates.
A call the index resolved into an edge of another kind (a router resolver turns `this.router.navigate([...])` into a
`navigates` edge to a route) is read back as the call it was, with the spelling and place the edge records, and settled
by R2 to R6b like a call the index left unresolved; it is never dropped. Outline's uses of a body, impact's
`unresolved-link` cuts and importers' unresolved namers read it through the same reader, as the unresolved reference it was.

| # | Rule | Settles |
|---|---|---|
| R1 | A call edge the index resolved, unless its synthesizer is ignored by `EDGE_POLICY`, judged by the one owner of where an edge points, the same impact, callers and importers use (`EdgeTargets`, RFC-0010) from the root its name spells at its place: kept; dropped when the root is bound by a package or the language's libraries (`new pkg.Base()`, a `pkg` import named like a repository declaration) or is a parameter of a function around the call ([ADR-0029](../adr/0029-lexical-bindings-from-the-typescript-binder.md) reads that binding); redirected when an import proves the bare name binds another repository declaration than the one the index matched | a step, at the redirected declaration for a redirected edge (its place unchanged); a dropped edge whose root is a package or a library is an external call under the package, or a global, by the name it reaches; one whose root is a parameter runs the parameter's value, so it is an `unresolved-link` cut at the place listing the declarations of its name, never a step. A kept edge into a method of a TypeScript class whose receiver root is a value (a parameter or a variable, reached through a member: `p.save()`), a field of `this` (`this.repo.save()`) or a call result (`make().save()`, with R5: the call's own declaration states a nominal class as its return type) is a step only when R3 or R4 proves the receiver's class (a store-bound local, a member proof such as `inject(T)` or a field's `FieldOrigin`), or a leaf when R3 proves the field holds a package or global type, or its one annotation (a `#` or `private` field's, for a field) names a nominal class, one that itself declares a `private`, `protected` or `#` instance member (an inherited one admits siblings), with the receiver read through parentheses, `!` and `satisfies` only, any other form (a type assertion, an optional call, an index, a comma, a condition) needing a proof, at the method it or its nearest ancestor declares, with R7 over its subclasses ([ADR-0029](../adr/0029-lexical-bindings-from-the-typescript-binder.md) decision 11, with the `any`/cast limitation of decision 9); otherwise the same cut |
| R2 | `this.<member>` and `this.<member>.<rest>` inside the class that declares the member (the inbound rule of RFC-0010, applied forward) | a step at the member |
| R3 | `this.<field>.<member>`: the field's `FieldOrigin` holds a repository class (a step at its member, with dispatch R7 when it is an interface), an external type (a leaf), or nothing known (R6). Trace reads the relations impact reads, under the same retained key, and settles only the calls they prove at their place: a `memberUses` proof is a step at its member, unless a provider may replace its receiver (`useClass`, `useExisting`); an `externalUses` proof (a field that holds a package or global type, never written and never replaced by a provider) is a leaf under its module, or a global. A place two proofs name, or a member the index does not place in the proven class, stays a cut | a step or a leaf |
| R4 | A bare name or a receiver identifier bound in the file: a local or a parameter whose declaration fixes its origin (`inject(T)`, `new T()`, `const x = this.f`, a type annotation `: T`), an import (a repository file: its export; a package: external with the package name), or no binding at all (a global: `global#Math`). A member call spelled as a chain of plain names (`Math.max`, `_.fp.map`, never `f().m` or `this.x.m`) asks the import origins for its root, as an edge's root is asked (R1): a package import is a leaf under the package, a name only the language's libraries declare a global leaf. The root settles only a call one member below it (`Math.max`, `other.setLogger`): a call that reads past its root (`other.logger.flush`, `document.body.appendChild`; one rule for TypeScript and Java) is not settled by its root, pending or resolved into an edge (trace keeps that edge, as impact, callers, importers and outline do), since a member below a package or a global holds whatever the repository stores there (`other.setLogger(new Sink())`), so the call stays as R6 decides; a file that declares the name anywhere, or a repository global of that name, proves nothing, so the call stays as R6 decides. A member call on a bare local is settled when every store into the binding (each initializer and each assignment, by the binder's scoping, ADR-0029) stores one kind of value, and every other place the file names the binding only reads one of its members: a regular expression, array or string literal is a global leaf of that type; `new C()` of the one class the file declares as `C` is a step at `C`'s own method; `new C()` where `C` is rooted at a library global is a global leaf, and at a repository file a step at the own method of that file's one class `C`. A parameter, a catch, iteration or destructured binding, an exported binding, a script's global, a compound or update store, a store a dynamic scope may make, and a binding passed, returned, copied, indexed or written through bind nothing. Read per file and keyed by the line and column where the call starts. Limitation: a method of the class that replaces itself on the instance (`this.m = ...`) is not seen. Declared external annotations (ADR-0029 decision 9): a receiver no store settles, whose one declaration states one type (a parameter, a local, or, for `this.r`, an instance field or a constructor property the enclosing class declares once as `#r` or TypeScript `private`), is held by that type, through parentheses, `readonly` and a union with `null` or `undefined`: a primitive keyword is its library type (`string` is `String`), an array type `Array`, a type reference its first name. A type the type scopes and the file leave unbound is a library global and the call a global leaf at `<Type>.prototype.<member>`; an import of a package the repository depends on is a leaf under that package. The type stays unknown, and the call as R6 decides, when the repository declares it or imports it from its own files or packages, when it binds to nothing (generated code), when an in-scope repository class or interface extends or implements the same type (its heritage followed through `const` aliases, type aliases and the repository's own imports; heritage that reaches no repository class, interface or type literal and no library or package type, such as a mixin call, makes every annotation of the snapshot unknown), or when a direct `eval` in the declaring scope, or for a field in the class, may write it. As for a store-bound local, a receiver the file passes, returns, copies, indexes or writes through, an exported local and a script's global bind nothing, since their members could be replaced; a field binds only while every `this` of its class names one member and every `this.r` reads a member or stores into it, so an aliased, passed, returned, spread, destructured or computed `this` binds no field of that class, and a field the class names through another receiver (`page.cache`, `other['cache']`, `const { cache } = other`) binds nothing, as does every field of a class that, on another receiver, indexes or destructures by a key no string or numeric literal states (`other[key]`, `const { [key]: c } = other`), destructures a rest, or calls `Reflect` or `Object.assign`, `defineProperty`, `defineProperties` or `getOwnPropertyDescriptor(s)` without such a key; a `protected`, `public` or unmodified field binds nothing, since a subclass, a superclass method or another module may write it. Limitation: a `private` field written from outside through an `any` or a cast is not seen (ADR-0029). Java (S6): a call on a parameter, typed lambda parameter, local or loop variable, or a `private` field named only through `this` and never by reflection, whose declared type a single import names under a platform package, is a leaf under that package, read through the project's strict name resolver; a call on a platform class itself (`Collections.emptyList`) is rooted by the same resolver through the language-aware import origins, while a call that reads a member past the root (`System.out.println`, `java.lang.System.out.println`, counted from the class after its package) is not settled by its root, as above, since Java records nothing the repository stores in a platform class's fields (`System.setOut`). Every Java annotation stays unknown while a repository type names a supertype outside the repository, or the sources hold an anonymous class, a lambda, a method reference, a JDK API that implements an interface at run time (`Proxy`, `EventHandler`, `MethodHandleProxies`, `LambdaMetafactory`), an aspect or a source that does not parse, or the scope holds a `.kt`, `.kts`, `.groovy` or `.scala` source (ADR-0029 decision 9). A leaf's evidence is its module or its global, as for any other leaf; the declared type is not part of the answer | a step, a leaf |
| R5 | A chain on a call result `head(...).m(...)`: the head is settled first; when it is a repository declaration with a declared return type, `m` is looked up in that type. When the head is an external call, or its return type is absent, the value `m` is called on is unknown, never external: a library call may return a repository object (`find`, `get`, a callback's result), so `m` is external only by the closed world of R6 and is otherwise a cut (R6b). Corrected 2026-11-06 by the trace slice 2 research. Implemented (slice 3) for Java with the import origins' `receiverMethods` (ADR-0029 decision 10): a call on a receiver whose repository type a parameter, a local or loop variable or a `private` field states (R4's Java bindings), or on what a repository method so named declares it returns (`x.f().m()`, and `f().m()` or `this.f().m()` through the enclosing class), steps at the one method the type's members of that name offer for the call's arity, and dispatch (R7) decides the body below it, with R7's guards on the declared type; an overload, a varargs, a `private` or an `Object` method, a type variable, an enum, a type above it outside the repository, or a source holding Lombok's `@Delegate` or `@ExtensionMethod`, proves nothing. A call the index resolved into an edge keeps it, with R10's override cut, whether or not the proof holds (codegraph resolves a Java receiver by its declared type), and steps at the proven method when the two differ; on a value the call reads (a variable, a member of another value, a call's result) it is a cut listing the edge's target and every declaration of its name only when the sources may make a value of any declared type run code they do not show: a source that does not parse, a JVM source no extractor reads, or a JDK API that implements an interface at run time. TypeScript keeps the cut unless a nominal class proves it (R1, ADR-0029 decision 11): structural typing lets an object of another class stand where the type is declared (slice 3, S4b) | a step, a leaf or a cut per link of the chain |
| R6 | Closed world, narrowed to what a name lookup proves (below): an unsettled call proven not to reach repository code | a leaf `external` |
| R6b | Otherwise | a cut `unresolved-link` at the place, listing the repository declarations of that name as candidates, each `file::path` with the dotted containment path the outline gives it (`src/a.ts::Store.get`; a top-level one `src/a.ts::get`) |

R6 applies only where the name at the call is the name of the callee:

| Spelling | External leaf when | Otherwise |
|---|---|---|
| member call `x.m(...)` | no declaration within the declared scope is named `m` except declarations that name only a type (`interface`, `type_alias`), and no in-scope source declares `m` in a value position: an object-literal key at any depth and in any context, a property assigned as `<expr>.m = ...` or `<expr>['m'] = ...`, a member of a class, record, enum, or local or anonymous class, a constructor parameter property, a value name a module exports (a renamed or re-exported specifier, `export * as name`, `default`; never a type-only export); a type, an interface, a type literal or an ambient (`declare`) declaration declares none. Any other kind in the index (function, method, property, field, constant, variable, class, enum, or one ye-ast does not know) may hold what the call runs, and so may a value-position name the index holds no node for, so either keeps the call a cut | R6b cut listing those declarations; when only the sources declare `m`, the files that do, each `file::m`, sorted |
| member call `x.m(...)` on a function value | the call's own source binds its receiver, read through parentheses, `as`, `satisfies`, `<T>` and `!`, to a function value: `this.x` to that field of the enclosing class, a bare `x` to its innermost local, parameter or module binding (in Java, else to the field of the enclosing type; in TypeScript the binding is the compiler binder's ([ADR-0029](../adr/0029-lexical-bindings-from-the-typescript-binder.md)), under JavaScript scoping: a `var` belongs to its function, module or static block across nested blocks, `let`, `const`, `class` and a function declaration to their block, a switch's to its whole case block, a catch variable to its catch block; every declaration of the binding counts); the binding's initializer or an assignment to it (in TypeScript `??=`, `||=` and `&&=` included) is a lambda, a method reference, an arrow or a function expression, read through every wrapper (parentheses and casts; in TypeScript also `as`, `satisfies`, `<T>` and `!`), through either branch of a conditional or operand of `&&`, `||` and `??`, and through the last operand of a comma or an assignment, it is a function declaration, or (TypeScript) its declared type is a function type. A receiver imported from another module is the index's: it resolves the call to the value it holds | cut, never external: a library member such as `get`, `run`, `call` or `apply` runs the repository function the value holds; the source is the candidate, `file::x`, beside any that declare `m`. Limitation: a value that arrives through a parameter or field typed with a library functional interface (Java `Supplier`, `Runnable`) and no function-valued initializer or assignment in the file, or a Java bare name an inner or anonymous class reads from its outer class, stays as the rule above decides; receiver typing (slice 2) addresses it. Which method of a functional interface runs the value is not resolved (slice 2 or 3, behind a language port) |
| bare call `f(...)` | the import origins say the file imports `f` from a package (`import`, with the module) or the language's own libraries declare it (`global`) | cut: a local parameter, an alias or a computed callee may be a repository function passed under another name |
| computed call `x[k](...)`, `(expr)(...)` | never | cut |

The value-position names are read from every in-scope source by the language's own parser (the TypeScript compiler
API, ADR-0008; tree-sitter for Java), once per query and only when a member call first reaches this rule; the sources of the methods the walk expands are
read for their callables (R10) by the same per-file read. Building the
set took 18 to 75 ms on the probe repositories and 238 ms on this one, against 1.1 to 1.9 s per query, so it is not
cached across queries.

Limitation: a member a repository object defines under a computed name (`{ [key]: fn }`, `target[name] = fn`) has no
name to read, so a call through such a member is still reported external `unnamed` when no other source declares its
name. A computed member written on a global's prototype is covered by the written paths below.

The rule matches names, not receivers, so a library call whose name the code also declares in a value position is a
cut: on this repository's `composeQueries` trace, 269 calls moved from external to cut (191 `Map.set`, 52
`RegExp.test`, 15 `Math.max` and `Math.min`), 2,033 cuts became 2,326. Receiver bindings (R4) settle them.

R4 and R5 read the syntax tree of the file (the TypeScript compiler API in `core/adapters/typescript`, ADR-0008; the
tree-sitter syntax tree for Java), never a type checker, and are computed once per file content.

Every external leaf, of R1, R3, R4 or R6 (the `unnamed` one included), names what the repository must not replace. The
import origins read once per query, from every source the snapshot holds, the member paths it writes: an assignment,
compound assignment, update, `delete`, destructuring or iteration target whose path starts at a global (directly or
through `globalThis`, `window`, `self` or `global`) or at an import of a package, and the first argument of
`Object.defineProperty`, `Object.assign`, `Object.setPrototypeOf`, `Reflect.set` and their kin, with roots resolved by
the binder (ADR-0029). A local declared from a path stands for that path: a variable's initializer, a parameter's
default, a destructured element by its key, rename or index, at any nesting, a literal's member (`const { prototype } =
Array; prototype.push = f` writes `Array.prototype.push`). A name a write does not state is a `*` that covers every name
in its place and below: `Array.prototype[k] = f` and a polyfill loop write `Array.prototype.*`, and
`Object.assign(process.env, vars)` writes `process.env.*`, never `process.cwd`; a computed key on the global object
writes `*`, every global. A write through `__proto__`, `constructor` or `getPrototypeOf` writes `*.prototype` and its
member. A global the snapshot declares is written whole. A leaf stays the cut it would otherwise be when a written path
covers the path it calls (`Array.prototype.push` for a call on an array literal, `Map.prototype.get` for `new Map()`,
`Math.max` for a rooted call, the global itself for a bare call), when its package is written through, or when its
member is written on any prototype: no syntax proves a receiver's whole prototype chain (`Element.prototype.appendChild`
replaces `document.body.appendChild`). A call found replaced never falls back to an `unnamed` external.

External leaves are relative to the fact's declared scope (RFC-0002 rule 4, `scope.languages`): the snapshot holds the
`.ts`, `.mts` and `.cts` sources the map scope exports, so a write in a `.js`, `.jsx` or `.tsx` file is outside the
promise and is not read. A write through a parameter with no default (`function patch(p) { p.push = f }`) or through
a call's result stays outside the paths. A name a `with` body
or a direct `eval` may rebind has no origin, and a local in the scope of a direct `eval`, strict or not, is not bound. An
R3 field leaf under a global needs a library global the binder confirms at the field's `new`, never the unresolved-name
fallback of a field origin.

### Tree rules

| # | Rule |
|---|---|
| R7 | Dispatch: a step at an interface or abstract method has as `alternatives` every implementation of it in the repository (through `implements` / `extends`, the same type walk `callers` uses). The step expands in place the one implementation when there is exactly one, or the one the framework's dispatch proves (a qualifier, `@Primary`, a named bean), noting which proof chose it; with several and no proof, none is expanded and the step carries a cut. Implemented (slice 3) for a body-less method (R10) with the import origins' `dispatchTargets`: for each concrete class below the method's owner, by the strict reading of every supertype the sources write (Java's one resolver, ADR-0029 decision 9), the body its own declaration or the nearest one up its class chain gives; a class that declares the name with the method's arity only as another signature, or whose chain ends with no declaration, proves nothing; parameter identities are compared by the shared Java signature reading, never by their text (ADR-0029 decision 12), so a homonym from another package is another signature, and a type the reading does not settle or a type variable proves no override. The one body is a child `via: "dispatch"` with no call place, and the step lists it as its one alternative; several bodies are a cut listing them, each an alternative; no body, or no proof, keeps the cut of R10. No proof when a value the sources do not place may implement the owner: a source that does not parse, a JVM language no extractor reads, an aspect or a JDK API that implements an interface at run time anywhere (as in R4); an annotation on the owner or the method other than the language's own (`@Override`, `@Deprecated`, `@SuppressWarnings`, `@FunctionalInterface`), since a generator or a proxy may implement it (`@Mapper`, a client interface); a supertype of the owner or of a type above it outside the repository (`extends JpaRepository`); a supertype the strict reading leaves unsettled under the name of the owner or a type below it; an anonymous or local class, or an enum, below it; or a lambda or method reference anywhere while the owner or an interface below it is functional: at most one abstract method beside `Object`'s among those it declares or inherits by Java's rules (a declaration overrides what it inherits under its signature, a more specific interface's method overrides those above it, abstract methods of one signature merge), or two methods of one name and arity anywhere in its hierarchy unless every parameter type of both is written concrete (no type variable of the method or of its interface, bounded or not, no wildcard, no type arguments): `send(T)`, `<U extends T> send(U)` or `send(List<?>)` beside `send(String)` may be one signature under a type argument, for that interface and every one below it. A framework's choice among several (a qualifier, `@Primary`, a profile) is not read. TypeScript types structurally, so any object with the members may stand where the type is declared: no hierarchy proves its bodies and the cut stays. Measured before the resolved-type signature comparison: on backend B 13 of 24 single-implementation cuts expand; backend A holds an aspect, so none does; the checkout service opens its application service (4 to 34 steps), while its one-method repository ports stay cut, since the service holds lambdas and a lambda may implement a functional interface. The initial comparison took the checkout back to 4 steps; the Java signature follow-up recovers the proven wildcard and implicit java.lang identities (measured below) |
| R8 | Order: children in the line and column of their call; a call inside a function passed as an argument (a callback to `subscribe`, `then`, `pipe`, `effect`, a stream lambda) is marked `deferred` |
| R9 | Roots: a symbol, a line range or an entrypoint. An HTTP route, listener or job starts at its handler. A UI route starts at its component, whose children are its constructor and field initializers, then its lifecycle hooks in the framework's order, then the handlers its template binds to events, then its template children (`uses-component` and the rest). A property or field whose initializer makes calls is a root by symbol or by a range inside it, and a class root's children are its members that have a body or an initializer that makes calls, in source order, reached `via: "member"`, an obligation of the root that an earlier expansion of the class below another root never meets; `callers` and `impact` seed as before. Implemented (slice 3) for entrypoints: a target `{kind, name}` (CLI `--entrypoint <kind>:<name>`) reads the map at the same snapshot only when one is given; every complete entrypoint of that kind and name roots at its handler, a UI route at its component, each the declaration of the index that joins the map's place (same file, the place's line in its span, the same simple name); a UI route whose component is `unknown`, or a handler no declaration joins, is an `unresolved-link` cut at that place, and a kind and name the map does not hold is the `unknown-entrypoint` fault listing the map's names of that kind. A class an entrypoint starts at, a UI route's component, runs as a page: its constructor, field initializers and class-body calls in source order, then its lifecycle hooks in Angular's order (`ngOnChanges` to `ngOnDestroy`), then its template's render calls in text order, then what its event bindings call, in template order: an own method (`(click)="save()"`), or the method the relations prove a call runs (`store.save()` through an injected field, `via: "template"`), then the components, directives and pipes its template uses, in the order the template text first uses them, each `via: "template"` and run as a page itself, then its other members in source order. Any other event call (a template local's, `$event`'s, an unproven field's), a handler the class runs no member of, a template item the relations cannot place, a used declaration the index does not hold, a template that cannot be read or that the component does not name, and a page component the relations know no template of are `unresolved-link` cuts at their place; a class root by symbol keeps source order. Declaration and entrypoint targets are not mixed in one request |
| R10 | Folding: a proven terminal step (expanded, with no children, no cut and no effect) is a leaf `{symbol, file, start, end}` of its parent, `deferred` when the parent passes it as a value; the text lists it by name on one line under its parent, and the full answer keeps its location. A step a bound stopped or with an unsettled call stays a step, and so does a method dispatch may replace. The index records neither bodies nor modifiers, so the declaration's own syntax decides, read by the parsers of R6 from the same parse, per file and once per query, and matched to the index node by name and by the lines from its first token (a decorator or annotation) to its name: a body-less callable (a TypeScript `abstract` method, overload signature, ambient function or interface method signature; a Java `abstract` method or interface method without `default`, `static` or `private` body) is a step with an `unresolved-link` cut at its declaration listing every repository declaration of its name in any type below its owners, an interface's included (none when there is none); a `static`, `private` or `final` method with a body expands it and never gets a dispatch cut; an overridable method with a body (a Java `default` method, a class method) expands it and gets a cut only when a type below its owner declares a method of its name, listing those declarations. A declaration in an interface below counts, whether a `default` override or a re-abstraction: a class below that interface may supply yet another body. A method its syntax does not state keeps the interface-owner rule: a cut when an interface declares it. The types below an owner follow the index's `extends` and `implements` edges (the index records no TypeScript `interface B extends A`, so a type below such an interface is not found from `A`); the index leaves a parameterized supertype (`interface Sub extends Port<String>`) as an unresolved reference spelled with its type arguments, so that reference names every type declaration of its raw name (`Port`), and a homonym adds its implementations to the candidates. Until R7 binds dispatch these cuts stay. So does a property or field a call reaches: the call runs the value the property holds, which its initializer built at construction, so the step is not expanded and carries an `unresolved-link` cut at the property's declaration (the value is unknown); an arrow function assigned to a property is indexed as a method and expands, and a property root (R9) still traces its initializer. External leaves are one line per parent grouped by module (`rxjs: pipe, subscribe`); nothing is dropped |
| R11 | A declaration already expanded appears again as `seen` with the step that expanded it; cycles end there |
| R12 | Effects: an external leaf whose module, type and member a plugin row declares as an effect (HTTP clients, message publishers, data-access types; RFC-0007, ADR-0013) carries its kind, and its target when RFC-0011's call-site extraction resolves one. Implemented (slice 4) for HTTP and messages: the rows are the call-site extraction's own vocabularies (the standard HTTP clients, `@HttpExchange`, Feign, the brokers' templates and NATS's client API, Angular's `HttpClient` and the wrappers it derives), read once per query over the snapshot's sources. A call site joins the trace by its exact place: it belongs to the innermost declaration of the index whose span, by line and column, contains where its call starts (an arrow, function expression, lambda, method reference or anonymous class body the index declares no body for is not proven to run: the walk proves no run of a function value, since a call through one, or of a computed callee, is a cut, so a site inside one is an `unresolved-link` cut of the body around it, never its effect), and it is an effect of a step only when that declaration is the body the step expanded and the index records a call of that body on the site's line (or the site is the client method a declaration states, Feign or `@HttpExchange`): `http` with the method, path and base, or `message` with the protocol and destination. A site a sibling on the same line or a nested function the walk did not expand owns is not the step's, neither an effect nor a cut. A wrapper's request is the caller's effect, as RFC-0011 places it. A site whose column cannot be compared with the index's (no column, or a column past its line's first character outside ASCII, where parsers may count apart) is a cut when an expanded body may own it, never an effect. A call site whose target the extraction does not decide (a library whose source the snapshot lacks, an undecided URL) is an `unresolved-link` cut at its place, `<kind> effect through <library>`, never an effect whose kind a name suggests. A site the expanded body owns at no recorded call is the same cut, never dropped. Data access is implemented for the evidenced Spring Data repository, Spring JDBC and JPA APIs: `data` carries the operation and `access` (`read`, `write`, or `unknown` for arbitrary JDBC execution), with an optional proven entity target. Repository generic ancestry is substituted through project interfaces; methods with bodies remain project code. Entity getters are not rows. JDBC SQL is not parsed for table names; JPA query construction alone is not an effect, while a declared query execution is (including standard Query configuration chains). Data sites reuse exact-position ownership and function-value cuts and do not enter workspace HTTP/event matching. MyBatis remains deferred (one observed application); Mongo/Redis and TypeScript ORMs have no evidence in this corpus. This adds the union and compose schema in place without changing SCHEMA, following the owner's standing no-bump rule while MCP has no consumers |
| R13 | Bounds and cuts as every walk: the RFC-0010 budget, unset by default; unresolved places, unbound dispatch and unreadable templates are cuts |

### The fact

Slice 1 answers this shape; `alternatives` (R7) joined it in slice 3 and `effects` (R12) in slice 4.

```ts
interface TraceValue {
  roots: { target: string; steps: number[] }[];   // per requested target, the root steps it selected
  steps: TraceStep[];                              // pre-order
  readingPlan: { ranges: { file: string; start: number; end: number; steps: number[] }[]; lines: number };
  cost: { expanded: number };
}
interface TraceStep {
  id: number; parent?: number; depth: number;
  file: string; symbol: string; kind: string; line: number; endLine?: number;
  at?: { line: number; column?: number };          // the call in the parent
  via?: "call" | "own-member" | "reference" | "member" | "dispatch" | "template";
  deferred?: true;
  seen?: number;
  leaves?: { symbol: string; file: string; start: number; end: number; deferred?: true }[];   // folded (R10)
  external?: ({ kind: "import"; module: string; names: string[] } | { kind: "global" | "unnamed"; names: string[] })[];
  alternatives?: { symbol: string; file: string; start: number; end: number }[];   // every body dispatch may run (R7)
  effects?: ({ kind: "http"; line: number; target: HttpTarget } | { kind: "message"; line: number; target: EventTarget } | { kind: "data"; line: number; operation: string; access: "read" | "write" | "unknown"; target?: { kind: "entity" | "table" | "collection"; name: string } })[];   // R12, RFC-0011 targets
}
```

### Text for the agent

```
trace POST /orders/checkout -> OrdersController.orderCheckout (src/.../OrdersController.java:35)
status: partial (cuts: 1 unresolved-link)
effects (3): http GET /restaurants/{id} at RestaurantsRepositoryAdapter.java:36, http POST .../reward-points/quote at RewardPointsRepositoryAdapter.java:34, data OrderRepository.save at ...
reading plan (6 ranges, 74 lines):
  src/.../OrdersController.java: 35-52 (18 lines)
  src/.../OrdersApplicationServiceImpl.java: 95-118, 120-131 (36 lines)
  ...
steps:
  35 orderCheckout
    41 checkoutOrderUseCase  dispatch: OrdersApplicationServiceImpl (1 of 1)
      98 getValidatedCustomer
      100 getRestaurant  dispatch: RestaurantsRepositoryAdapter
        36 effect http GET /restaurants/{restaurantId}
      101 validateRestaurant (OrdersDomainService.java:..)
      leaves: getCustomerId, getRestaurantId, getItems (+4)
      external: slf4j: info; lombok builder: discountRequest, customerId, checkout, build
cuts:
  unresolved-link (1 call):
    apply ×1 in 1 file → could be: DiscountPolicy.apply
    Call places omitted; mode "details" lists them, mode "full" gives the structured fact.
```

The effects come first, since they decide the plan; steps follow the MCP depth summary and `expand` of the latency plan.
In `summary` the reading plan takes one line per file, files in their first appearance, and the unresolved calls one
line per trailing name and candidate set, most calls first, with the candidates listed by their containment path or
counted, whichever is shorter (RFC-0017), and counted when two of them share a path; `details` lists each range and
each call with its file, line and candidates, each with its file.

### Acceptance

Hand-verified traces of the probe workspace, kept outside the repository with the cross-repo inventory, plus synthetic
fixtures per rule in the repository:

| Root | Expected |
|---|---|
| a frontend API method posting a checkout | the wrapper's `post`, then the framework HTTP client call as an `http` effect with its path |
| a frontend page (UI route) | constructor and field initializers, lifecycle hooks, template event handlers, the stores and API methods they call, every HTTP effect |
| a service's checkout route | dispatch to the application service implementation, the domain service, the repository ports dispatched to their adapters, each outgoing HTTP call as an effect |
| a service's event publisher method | a `message` effect with its subject |

Measured on each: the share of call places settled by R1-R6, the cuts R6b leaves (each with candidates), and the text
size before and after folding.

### Slice 1 measured (2026-11-06)

Fifteen traces over four probe repositories, at the head of each clone, `untrusted`, through `ye-ast trace`; each ran
twice and answered the same bytes. Frontend A is Angular with standalone components and signals, frontend B an Nx
workspace with NgRx signal stores; backend A is Spring REST with service interfaces and MapStruct mappers, backend B
Spring Boot with repository interfaces and MyBatis read services. Roots: an HTTP handler (BA-1, BA-3, BB-1, BB-3,
BB-4), the application method it calls (BA-2, BB-2, BB-5), a frontend API method that posts or gets (FA-1, FB-1), a
component method bound to a user action (FA-2, FA-3, FB-2, FB-3) and a whole signal store (FB-4).

*Settled* counts the call places that became a step (seen and deferred included), the folded leaves and the external
names; *cut* counts the `unresolved-link` cuts, one per place. Leaves and external names are listed once per parent,
so settled is a lower bound of the settled places. Text bytes come from the MCP renderer; wall time is the second
run, with a warm index cache and process start included.

| Trace | Status | Steps / expanded / seen / leaves | Settled / cut (share) | Top cut tails | External groups | Plan ranges / lines | Summary / details bytes | Wall s |
|---|---|---|---|---|---|---|---|---|
| FA-1 | complete | 1 / 2 / 0 / 1 | 4 / 0 (1) | — | 2 | 1 / 5 | 453 / 630 | 4.06 |
| FA-2 | partial | 3 / 3 / 0 / 0 | 9 / 1 (0.9) | `deleteVet` | 3 | 3 / 10 | 736 / 1184 | 1.12 |
| FA-3 | partial | 3 / 3 / 0 / 0 | 9 / 1 (0.9) | `deletePetType` | 3 | 3 / 10 | 815 / 1256 | 2.65 |
| FB-1 | partial | 1 / 1 / 0 / 0 | 0 / 1 (0) | `post` | 0 | 1 / 5 | 694 / 834 | 2.55 |
| FB-2 | partial | 1 / 1 / 0 / 0 | 2 / 1 (0.67) | `login` | 1 | 1 / 4 | 661 / 861 | 2.66 |
| FB-3 | partial | 1 / 1 / 0 / 0 | 0 / 1 (0) | `addComment` | 0 | 1 / 3 | 679 / 831 | 1.40 |
| FB-4 | partial | 7 / 10 / 0 / 3 | 32 / 8 (0.8) | `post`×3, `callState`×3, `get`, `put` | 7 | 7 / 116 | 1290 / 3133 | 1.09 |
| BA-1 | partial | 1 / 9 / 0 / 8 | 12 / 5 (0.71) | `ResponseEntity`×2, `HttpHeaders`, `setName`, `path` | 1 | 1 / 18 | 991 / 2031 | 1.29 |
| BA-2 | partial | 3 / 7 / 0 / 4 | 7 / 1 (0.88) | `getId` | 1 | 3 / 19 | 982 / 1329 | 1.19 |
| BA-3 | partial | 1 / 4 / 0 / 3 | 4 / 2 (0.67) | `ResponseEntity`×2 | 1 | 1 / 14 | 861 / 1209 | 1.27 |
| BB-1 | partial | 2 / 9 / 0 / 7 | 9 / 1 (0.9) | `HashMap` | 1 | 2 / 22 | 693 / 1009 | 1.20 |
| BB-2 | complete | 1 / 8 / 0 / 7 | 7 / 0 (1) | — | 0 | 1 / 11 | 581 / 778 | 1.14 |
| BB-3 | partial | 3 / 13 / 0 / 11 | 18 / 4 (0.82) | `body`, `HashMap`, `setFollowing`, `getId` | 2 | 3 / 32 | 964 / 2629 | 1.15 |
| BB-4 | partial | 11 / 26 / 2 / 18 | 36 / 8 (0.82) | `DateTime`×3, `isEmpty`, `HashMap`, `setFollowing` | 3 | 9 / 79 | 1556 / 4507 | 1.05 |
| BB-5 | partial | 5 / 19 / 0 / 16 | 39 / 11 (0.78) | `getId`×3, `toList`×3, `setFollowing`, `HashMap` | 4 | 5 / 71 | 1328 / 5312 | 1.12 |

In total 198 outcomes settled against 45 cuts (0.81). Not all of them are sound: 26 leaves are abstract methods and one
external is a repository method (findings 1 and 2 below), which leaves 171 sound outcomes (0.70).

What would settle each cut: all 32 cuts of the four cut-heavy traces (FB-4, BB-4, BB-5, BA-1), and all 45:

| Settled by | Cut-heavy (32) | All (45) | Example |
|---|---|---|---|
| R3 field origin | 5 | 10 | `this.apiService.post`; 8 of the 10 fields hold a repository class, 2 hold a signal store (finding 2) |
| R4 import binding in Java: an imported class constructed or called | 13 | 18 | `new ResponseEntity<>(…)`, `new HashMap<>()`, `toList()`, `UriComponentsBuilder.newInstance().path` |
| R4 local or parameter binding | 7 | 7 | `value.isEmpty()` on a `String` parameter, a lambda parameter `item.getCount()`, a destructured `callState()` |
| R5 chain through a declared return type | 7 | 10 | `articleData.getProfileData().setFollowing` |
| R7 dispatch | 0 | 0 | none is a cut: dispatch hides behind leaves (finding 1) |
| Genuinely ambiguous | 0 | 0 | — |

Every cut has a slice 2 rule that settles it, but the rules do not yield equally. R3 is where the frontend flow stops:
five of the six frontend roots below the store end at their first repository hop, a `this.<field>.<member>` cut, so
the reading plan stops at the component. R4 and R5 mostly turn cuts into external leaves or terminal getters, which
removes noise without opening flow. On the backends the hidden flow sits in dispatch: each of the 26 abstract-method
leaves stands for an implementation the trace never opens.

Findings:

1. **An abstract method folds as a proven terminal leaf.** In Java, a call to an interface method (a service, a
   repository port, a mapper, a MyBatis read service) settles on the abstract declaration. The walk reads no call from
   it and folds it into its caller's `leaves`, so BB-2 answers `complete` while its repository write is never reached.
   Reproduction: `Service.create(s) { repo.save(s); }` with `interface Repo { void save(String s); }` and
   `RepoImpl implements Repo` gives `complete` with one leaf at `Repo.save`. An abstract method has no body to
   expand: it is unbound dispatch (R7, R13), a step with a cut until slice 3, never a leaf (R10).
   Fixed for interface members (R10): BA-1, BA-3 and BB-2 now answer `partial`, each interface method a step with a cut
   listing its implementations (`ClinicServiceImpl`, `MyBatisArticleRepository`), and the generated mappers a cut that
   lists none. The index carries no signal for an `abstract` method of an abstract class: codegraph records it as a
   plain `method` with `is_abstract` unset and a signature without modifiers, and indexes no node for a TypeScript
   `abstract` method. Fixed for abstract methods too: the parsers of R6 read whether a declaration has a body and can
   be overridden (R10), so a reached abstract method is a step with a cut listing its subclass implementations, and a
   `static` or `private` interface method, or a `default` one nothing overrides, is no longer a cut.
2. **A call to an object-literal method is shown as external.** The index holds no node for a method written in an
   object literal (`withMethods((store) => ({ setErrors(…) {…} }))`), so no in-scope declaration has the name, the
   type-only rule holds vacuously, and `formErrorsStore.setErrors` becomes an `unnamed` external of FB-4. Reproduction:
   `const store = make({ setErrors(e: string) { … } })` and `function run(s: typeof store) { s.setErrors("x"); }` gives
   `complete` with `s.setErrors` external. Repository code shown as external contradicts R6. The same gap makes
   `this.authStore.login` (FB-2) list only `AuthService.login`. Fixed (R6): the sources' value-position names keep the
   call a cut, so FB-4's four `formErrorsStore.setErrors` calls are cuts listing the store's file; over the 15 traces
   settled outcomes went from 188 to 185 and cuts from 71 to 77, the other change being `resource.value` in FA-2 and
   FA-3, which a `value` key elsewhere now keeps a cut.
3. **A callback held by a property's initializer call is unreachable.** A signal-form submission
   (`readonly ownerForm = form(model, schema, { submission: { action: async () => … } })`) is a property, which no
   request can seed. A range over the action seeds the class, and a class root answers `complete` with no calls,
   although the index records the property's `calls` edges. An arrow function assigned to a property directly is indexed
   as a method and traces correctly. Fixed (R9): the property is a root by symbol or by the range, and answers `partial`
   with `form`, `firstValueFrom` and `String` external, `gotoOwnersList` folded and one cut, the R3 call
   `this.ownerService.addOwner`; the class root expands into its six members that run code, `via: "member"`: five
   steps and `gotoOwnersList` folded.

Usefulness. A trace pays off where it crosses several declarations: BA-2, BB-3, BB-4, BB-5 and FB-4 hand over 3 to 9
ranges (19 to 116 lines) in reading order, with folded leaves and grouped externals, for 1.0 to 1.6 KB of summary
text, which is less than opening the files one by one. A trace that stops at its first hop (FA-2, FA-3, FB-1, FB-2,
FB-3) adds little beyond `ye_ast_outline` plus the cut's candidates. A handler trace on backend A (BA-1, BA-3) shows
the service calls as terminal leaves, which is misleading (finding 1).

Reading for the next slice: findings 1 and 2 are unsound answers, so they come first. Of slice 2, R3 and the Java
import binding settle 28 of the 45 cuts and R3 opens the stopped frontend flows; on the backends, R7 (slice 3) opens
more flow than R4-R5.

### Slice 2 measured (2026-11-07)

The research probe set, `untrusted`, through `ye-ast trace` at a pinned revision of each repository: 86 traces over six
repositories, the slice 1 four (frontend A 20, frontend B 13, backend A 12, backend B 14), an Angular admin application
(frontend C, 25) and ye-ast's own sources at a fixed commit (two roots, `composeQueries` and `walkTrace`). *Cuts* counts
the `unresolved-link` cuts of every trace of a repository; *before* is main before slice 2, *after* the head of slice 2
with its review corrections. Three runs of the after set (one per follow-up commit) answered the same bytes.

| Probe | Traces | Cuts before | Cuts after | Removed | Expected after S5 |
|---|---|---|---|---|---|
| ye-ast `composeQueries` | 1 | 2863 | 1992 | 30% | 54% |
| ye-ast `walkTrace` | 1 | 119 | 65 | 45% | — |
| frontend A | 20 | 103 | 57 | 45% | 65% |
| frontend B | 13 | 68 | 60 | 12% | — |
| frontend C | 25 | 339 | 230 | 32% | 76% |
| backend A | 12 | 195 | 195 | 0% | — |
| backend B | 14 | 161 | 161 | 0% | 22% |

Where the yield fell short of the research estimate, a soundness guard took it back, by design:

- S2-S4 removed 26% on `composeQueries` and 12% on frontend C (expected 31% and 51%): a field proof counts only when
  nothing may replace the field's value (`risks.reaches(owner, field)`), which holds for most constructor-injected
  fields of frontend C.
- S5 first reached 107 cuts on frontend C; the review guards (a field binds only when it is `#` or `private` and named
  through `this` alone, and every field of a class that indexes another receiver by an unstated key binds nothing)
  brought it back to 230. Every cut they restore is a place a repository write could reach.
- On both backends the global Java guard fires (a repository type extends a supertype outside the repository), so every
  Java annotation stays unknown and no cut is removed; 46 unnamed external leaves of backend B gained their package
  name instead. A per-member guard was measured to save 4 cuts on backend B and was not taken.
- The one past-root rule (`readsPastRoot`) cost no cut on any probe.

### Slice 3 measured (2026-11-07)

The research probe set at the same pinned revisions (92 traces) plus the acceptance traces, through `ye-ast trace`,
`untrusted`. Every other query (map, impact, callers, importers, outline) answered the same bytes as main before
slice 3 on every probe repository.

- R7 dispatch alone: backend B's single-implementation cuts went from 24 to 11, and the checkout service from 4 to 34
  steps. The fail-closed signature comparison (parameter types compared as the strict reading resolves them) takes
  part of that back: backend B 357 steps and 324 cuts before slice 3, 347 and 325 after; the checkout service is at 4
  steps again, since its implementation reads its parameter types through wildcard imports, `java.util.*` among them,
  that the strict reading does not settle.
- R9 entrypoint roots: the checkout traced as `http-route:POST /orders/checkout` answers what its handler symbol does;
  the orders page traced as `ui-route:/user/orders` went from 13 steps (its component symbol) to 109, with 39 cuts,
  every event-binding call either a handler, a proven step or a cut.
- R5 Java narrowing (S4a): no step an index edge already settled became a cut.
- S6 TypeScript unproven receivers: a kept edge on a parameter, a local or a field without an origin or nominal proof
  is now a cut. On the TypeScript probes 84 of 92 traces first stayed identical; adding field receivers, call results
  and field aliases moved up to 95 steps into cuts on the repository with the most constructor-injected services,
  and fewer than 60 on the others. Java traces were unchanged by S6.

### Java signature follow-up measured (2026-11-07)

J1, against local main `15f44afa73c817520b5ac1e13ce987248ebe04c1`, `untrusted`, pinned repository revisions.
The original temporary probe scripts were no longer present; the documented largest-class selection was reconstructed
explicitly: the 15 largest non-test Java source files by blob bytes that declare a class named after their file,
traced through that class symbol. This records 45 traces, rather than claiming byte parity with the earlier 43-target
list. The orders symbol and HTTP-entrypoint acceptance traces were also measured separately.

| Repository | Revision | Class traces | Steps main → J1 | Cuts main → J1 | Changed traces |
|---|---|---|---|---|---|
| petclinic-rest | `5180cc9bd0163393c4e628bedc1bc4c27cfaab1b` | 15 | 330 → 330 | 268 → 268 | 0 |
| realworld backend | `ee17e31aafe733d98c4853c8b9a74d7f2f6c924a` | 15 | 347 → 357 | 325 → 324 | 3 |
| orders | `93535d5d14d1c44533f878ca0a4883244b0937ac` | 15 | 217 → 268 | 263 → 355 | 1 |

`OrdersController.orderCheckout`, both by symbol and by `http-route:POST /orders/checkout`: 4 → 42 steps,
4 → 64 expanded, 3 → 91 unresolved-link cuts. More cuts accompany the newly reached bodies; the walk does not claim
completion. Realworld's changed roots are `ArticleMutation` (45 → 49 steps), `CommentsApi` (23 → 27), and `ArticleApi`
(36 → 38). Orders' changed class root is `OrdersController` (10 → 61). Every other class trace is byte-identical.

The identity reading (ADR-0029 decision 12) proves implicit `java.lang` and repository wildcard-imported parameter
names without choosing an unknown supplier. Its platform inventory never classifies an external leaf. A qualified
name first resolves its leftmost segment through the lexical/import/demand reading; a proven type leads through
member declarations, while a proven package leads through known package prefixes to a declared type and its members.
Capitalization and equal spelling establish no identity. Unread qualifiers or terminal declarations stay cuts.
The compilable review repro (`q.X` supplied by `a.*` versus `b.*`) therefore stays unknown instead of listing a false
subclass body. Package-qualified, type-qualified, inherited, mixed and imported-qualifier forms share that rule.
Spring's `counterpart` and route adapter are restored exactly to main's behavior. Its text comparison remains an
advisory: changing that separate query requires a compilable false-fact reproduction and a correction scoped to
removing that fact. The previously added orders map uncertainty did not meet that criterion and is withdrawn.

Differential: map, impact, callers, importers and outline on each of those three repositories (15 commands). Callers,
importers and outline use the largest selected class file; impact compares the pinned revision's third first-parent ancestor with
that revision. After the review correction, stdout, stderr and exit status are compared: **15/15 byte-identical**,
including all three maps, all exit 0. The added unresolved item in orders is absent; `counterpart` and the route adapter
match main exactly. The correction re-ran all 45 class traces, both checkout targets and all 15 differential commands
on the same pinned revisions; the trace measurements in the table are retained unchanged. Two public-seam tests
built from the review repros were observed RED, then GREEN; reverting qualified identity to text or reintroducing the
uncertain counterpart each fails its test, and both mutation variants pass typecheck. The qualified-name matrix and
the review's minimal map source compile with `javac` (10 source sets). Foreground `npm run check` on Node 24.22.2:
3,671 passed, zero failed or cancelled.

Measurements use one exported main tree and shared graph cache, with absolute XDG cache/config paths, isolated HOME
and TMPDIR under one system-temp scratch. The correction measures baseline and final head afresh using that same
export and cache. The scratch retains pinned
targets, exit codes, hashes, metrics, compiler evidence and the RED/mutation/check logs; intermediate exports and
caches are removed after verification. No schema bump or CLI/help change is required.

### Slice 4 measured (2026-11-07)

The slice 3 probe repositories at their head (ye-ast's own sources at the same fixed commit), the 15 largest class
files of each (107 traces, two on ye-ast) plus the four acceptance traces, through `ye-ast trace`, `untrusted`, against
main before slice 4. An effect is a call site with a decided target; an effect cut is a call site the extraction reads
whose target it does not decide.

| Probe | Traces | Effects | Effect cuts | Traces changed |
|---|---|---|---|---|
| frontend A | 15 | 48 http | 0 | 12 |
| frontend B | 15 | 12 http | 1 | 2 |
| frontend C | 15 | 44 http | 0 | 7 |
| the acceptance frontend | 15 | 0 | 0 | 0 |
| backend A | 15 | 0 | 0 | 0 |
| backend B | 15 | 0 | 0 | 0 |
| the acceptance service | 15 | 0 | 5 | 5 |
| ye-ast | 2 | 0 | 0 | 0 |
| acceptance traces | 4 | 0 | 1 | 1 |

- Every other part of every trace answered the same bytes as main: 84 of 111 traces are byte-identical, and the other
  27 differ only by their effects and effect cuts; one acceptance trace turned `partial` by its effect cut, every
  other changed trace was already `partial`. Map, impact, callers, importers and outline answered the same bytes on 14
  commands over the probes. The warm cost of a trace is unchanged within noise (1.4 to 5.2 s against 1.5 to 6.0 s).
- Joining by exact place (a site belongs to the declaration that owns its line and column, and a site inside a function
  value the index declares no body for is a cut) left every count above
  unchanged on the probes (no probe effect sat inside a callback) and removed the false effects a line-only join gave
  on a same-line sibling method, an uninvoked inner function and an uninvoked lambda; map, impact, callers, importers and outline still answer the same bytes on the 14 commands.
- The frontends whose clients the extraction derives (`HttpClient` through a wrapper the RFC-0011 rule recognises)
  carry each request at the caller that names its path; a path a condition chooses is a cut.
- Every effect of the acceptance probes is `unknown` today: the service publishes and calls through the company's
  NATS and REST client libraries, whose source the snapshot does not hold, so each of its six call sites is a cut
  naming the library; the acceptance frontend's wrapper builds its URL through a helper the wrapper rule does not
  follow, so its call sites sit inside the wrapper with undecided targets, and its page and API traces reach no call
  site before their own cuts. The acceptance traces show the effects once the library's source is given or the
  wrapper rule grows (RFC-0011), with no change to trace.
- The backends that make no outgoing call through a known client have no effect, as expected. Data access has no row
  and is not reported.

## Patterns (deferred)

Deferred by the owner on 2026-11-01 (translated): "the architecture part does not convince me yet; I do not see what
answer of value the MCP can give. How can it know whether a command pattern is used for that file, or whether data is
kept in a store, or whether the API call goes in an *.api.ts file, or anything that detailed... so better to focus on
trace". The section stays as a record of the analysis; nothing in it is planned.


### The question and the answer the agent needs

"I must add a store like this one; how are stores done here?" The agent needs: the kind (role) recognized and how,
the one to three members to imitate and why they are typical, the conventions a member follows (with how many
members follow each), whether two styles coexist and which is the current one, and what else is created with a member
(a route entry, a contract operation, a test). With no target: the list of roles, which is the architecture map.

### Roles are derived, never named by ye-ast

A role is the set of declarations that share a **role key**, computed from structural facts only:

| Part of the key | Source | Example |
|---|---|---|
| framework role | the plugin's own facts: Angular metadata (`@Component`, `@Injectable`, `@Pipe`, `@Directive`, route component, guard), Spring stereotypes and mappings, entrypoint kind, contract-route implementer, data-access type | `angular:injectable`, `spring:rest-controller` |
| project supertype | `extends` / `implements` a type declared in the repository (or an unresolved one, by name) | `implements *Api`, `extends BaseStore` |
| path template | the paths of the members aligned segment by segment: a segment equal in every member stays, a segment that varies becomes `*`; computed from the members, never from a list of folder names | `src/app/features/*/stores/*.store.ts` |

Grouping runs in two passes: first by framework role and project supertype, then each group is split where its
members' path templates disagree in a segment that is not the varying one (two directories that both hold stores).
A role with one member is reported as such: no template is inferred from one path.

### Typical members

Each member gets a feature set from facts already extracted: annotations or decorators, injected types (Angular
relations, constructor parameters), the supertypes, the framework APIs it calls (`inject`, `signal`, `computed`,
`rxResource`, `HttpClient`), the files it imports by role. A member's typicality is the number of its features that
the other members share. The text lists the members with the highest typicality (all of them when they tie), then
counts the rest; the order is typicality, then the commit that added the member (newest first), then path. No constant
picks "the top three".

### Conventions and styles

A convention is a feature and the count of members that have it (`inject(): 11 of 12`). Two styles coexist when the
members split on a feature that is exclusive between two groups (constructor injection against `inject()`, a base
class against none); each style lists its members and the newest commit that added one, so the agent sees which one
the repository moves toward. Counts are facts; ye-ast states them and never decides that a minority is wrong.

### Created with a member

Git history answers "what else is created with one", but squashed pull requests make one commit touch hundreds of
unrelated files (the probe: one commit with 336 files). The rule keeps only files that are both added (or changed) in
the commit that added a member and connected to that member in the graph at that commit's snapshot (it imports them,
they import it, a route names it, a contract operation it implements). The answer lists, per role of those files, how
many members' creating commits had one (`route entry in app.routes.ts: 9 of 11`), with one example commit each.
History shorter than the members' age (a shallow clone) is a cut `history-shallow` at the members whose creating commit
is missing.

### Text for the agent

```
patterns src/app/features/order/stores/order-checkout.store.ts
role: angular:injectable, path src/app/features/*/stores/*.store.ts (14 members)
typical: user.store.ts, order-draft.store.ts (share 9 of 10 features)
conventions: inject() 14/14, signal state 13/14, rxResource or safeResource 9/14, providedIn root 6/14
styles: none
created with: a feature api file 9/11 (example 5b6ec5ca), a page that injects it 8/11, a spec 11/11
```

## Efficiency

| Piece | Keyed by | Cost |
|---|---|---|
| outgoing edges and the trace tree | the index key plus the root | a walk over the stored graph; the field and own-member resolution reuse the per-content caches of the latency plan |
| roles, features, typicality | the content digest of the snapshot and the plugin versions | one pass over the plugins' facts; cached by content like the index |
| created-with | the snapshot sha and the history the clone holds | one `git log --diff-filter=AM --name-status` pass plus one graph read per creating commit's members; cached by sha, extended incrementally when HEAD moves forward |

## Completeness

| Cause | Result |
|---|---|
| a call the index could not resolve | cut `unresolved-link` at the place |
| a dispatch with no implementation in the repository | the step is a leaf `external` with the interface, and a cut `unresolved-link` |
| a framework outside the declared scope | `no-extractor` cuts; roles from it are absent, never guessed |
| history missing for a member's creation | cut `history-shallow` (new cut kind, RFC-0002 rule 6 minor change) |
| a bound stopped the trace | the RFC-0010 cut of that bound |

## Placement

| Piece | Where |
|---|---|
| trace tree rules, effect kinds | `core/domain/trace/` |
| role key, path template, typicality, styles | `core/domain/patterns/` |
| the use cases | `core/application/trace/`, `core/application/patterns/` over the graph, relations and VCS ports |
| history read (`log --name-status`) | the git adapter, behind the VCS port |
| MCP tools `ye_ast_trace`, `ye_ast_patterns`; CLI `ye-ast trace`, `ye-ast patterns` | `mcp`, `cli`, wired in `composition` |

## Slices

| Slice | Delivers | Accepted by |
|---|---|---|
| 1 (implemented) | R1, R2, R6 narrowed, R6b, R8 (order), R10, R11, R13 over resolved edges and own members, with a reading plan of the spans to open; roots by symbol and line range; `ye_ast_trace` (and in `ye_ast_compose`), `ye-ast trace`, protocol `trace.walk` | fixtures per rule; real indexed fixtures for callback attribution and object-literal keys; parity across CLI, protocol and MCP |
| 2 | R3 and R4-R5: field origins, bindings, locals, parameters, imports, globals, chains through declared return types, in TypeScript and Java | fixtures per binding kind; the settled share on the probe measured and recorded |
| 3 (implemented: R7 for Java, R9 entrypoint and page roots, R5 for Java, TypeScript unproven receivers as cuts) | R7 dispatch and R9 entrypoint roots, with the template's event handlers read by the Angular adapter | the service checkout trace and the page trace; the checkout's dispatch uses the shared Java identity proof (Java signature follow-up measured) |
| 4 (implemented: R12 for HTTP, messages and data) | R12 effects with RFC-0011 call-site targets | each effect of the acceptance table (slice 4 measured) |

The patterns slices are deferred with that section.

## Decisions

Accepted by the owner on 2026-11-01: "Acepto las recomendaciones". Question 5 lapses with the patterns section.

| # | Question | Decision |
|---|---|---|
| 1 | One trace tool for entrypoints and symbols, or two? | One: `ye_ast_trace` takes a target like `callers` (`file` + `symbol` or a line range) or an entrypoint (`kind` + `name`) |
| 2 | Should trace evaluate conditions (`if`, guards) to prune branches? | No: deterministic and honest is source order with every branch; the text says branches are not evaluated |
| 3 | Is a data-access API a plugin row (RFC-0007) or configuration? | A plugin row per framework, under ADR-0013; a project's own data layer is reached as code and ends at its framework call |
| 4 | Should `patterns` read history under `untrusted`? | Yes: `git log` of the exported snapshot's repository is a read of git, not of repository code, and needs no network |
| 5 | Does the architecture map (no target) replace a separate `modules` subdomain (RFC-0009)? | It covers orientation; module dependency direction (which role imports which) is added to the map in slice 3 as counts between roles |

### Syntax call inventory (2026-11-07)

R1/R10: before a body can be complete or folded, every call written in that body must be represented by a call edge, a pending reference, or an unresolved-link cut. The existing TypeScript and Java readers enumerate calls and constructions (TypeScript tags included) in their existing parse. Syntax owner chains assign calls to declarations, including field initializers; anonymous callbacks remain with their enclosing body. This avoids treating a method already included under a class as an unaccounted class call, including when both declarations share a line. A field with only unindexed calls is still a trace root and a class member to expand.

Reconciliation uses the occurrence's line, UTF-16 column and syntactic callee name. Argument text in a receiver is not identity; Java constructions name their type rather than the `new` keyword. Computed callees without a name reconcile by exact spelling only. A site with neither edge nor pending reference becomes a pending reference with its syntactic call kind, and enters the same R1–R6 settlement as indexed unresolved references. Only an unsettled site becomes a cut. A nameless receiver uses the same empty receiver key as the binding reader, so literal receivers reach R4 rather than falling through. No schema change, checker, second binder or shared navigation change is needed. The other families still consume their existing indexed dependency inventory: a missing execution site does not prove an inbound dependency on a declaration, so these trace cuts are not manufactured dependency edges.

Existing-test classification:

- **(a) silent drops, corrected settlement:** package/repository homonym test (`pass`) and enclosing-parameter callback test (`nested`) omitted `[1].map`. The first implementation added a noisy cut; the corrected expectation retains a proven global Array leaf. The callback parameter remains cut and the package callback remains external.
- **(b) matching errors:** the object-literal call test duplicated `price.toFixed().format` because syntax includes argument text; the Java non-private-field/var/aspect test duplicated a construction named `new Plain`; the class-reexpansion test charged `work`'s call to `Page` as well. Callee identity and syntax ownership fix these without expectation changes.
- **(b) definition-time ownership:** the decorated-method test exposed a decorator factory charged to the method body. Decorator expressions belong to the enclosing class definition; its original expectation remains unchanged. RED observed and GREEN after correcting syntax ownership.
- Earlier ENOSPC failures in Java platform/root/record tests were not reproduced after recovery. Function-value/wrapper tests and the package/global-root test pass with the name-based reconciliation; their existing pending references account for the calls.

The public table covers TS conditional, indexed and comma receivers, computed callees, plain and optional member calls, tags, and Java conditional, indexed and plain receivers plus explicit constructor delegation. Its TS expressions also run as field and class roots. The first three assert the cut's exact place. RED reproduced the false complete; removing the inventory loop with a type-correct empty slice made the test fail again. A Java-reader-only empty-inventory mutation initially survived the receiver rows; an explicit `this(1)` constructor delegation fixture, taken from the measured missing-call category, now fails when that reader is disconnected. Probe and differential results are recorded below after the measurement completes.

### Precision follow-ups (2026-11-07)

Render calls use the same compiler walk and origin proofs as event calls. Page order is initializers, lifecycle hooks, render calls in template text order, event handlers in text order, template children, then other members in source order. An own method joins the existing member; a field call requires the existing member-use proof; every other call becomes a cut at its template occurrence. This is deterministic reading order over potential calls, not a claim that a conditional render branch executes, or that rendering runs once. Conditional blocks, property bindings, interpolations, safe calls and tags go through the compiler's recursive call visitor. No template-specific spelling list, new external proof or dependency edge is introduced. The public composed query test was RED with source order (`clicked,label,total`), then GREEN with template order (`total,label,clicked`) and cuts for both an absent own method and an unproven field call. Emptying the render plan and dropping the render-call settlement were type-correct mutations caught by that test; the latter first survived until the fixture also included an unproven receiver.

The injected-field alias follow-up stays cut. The public AngularMetadataReader experiment compared a direct call, a local field copy, and a copy passed to a separate function that writes an unknown member (`value[key()] = () => {}`). Baseline member proofs: direct 1, safe alias 0, escaped alias followed by a direct call 0. A type-correct experiment treating local variable initializers as non-escapes produced 1,0,1: it still established no origin for the alias and incorrectly proved the direct call after a possible replacement. The change was restored. `localSites` admits only `RawInjection` locals initialized by `inject()`, not copies of fields; relaxing `escapes` alone therefore changes proofs shared by impact/callers without recovering the alias call. A sound future extension must bind the copied local and account for every subsequent use and transitive escape before admitting its member calls. The present change preserves the existing proof boundary rather than weakening it.

### Follow-up measurement (corrected after parent review)

Baseline: local main at task start, `15f44afa`; the same single source export and the same 92-probe manifest are reused. Selection: 15 largest source files per repository excluding tests, retain files declaring classes, plus two ye-ast function traces. Counts: pfe14/pbr15/rwf8/rwb15/shop10/ord13/web15/self2 = 49 TS + 43 Java. Self probes use the worktree's explicit baseline SHA because the concurrently used main checkout moved to a revision without trace-walk.ts. HOME and XDG paths are absolute within the scratch. All before/after commands exit 0, with no unknown probe answers.

Parent rejected d7b6b9cb's unconditional cuts: the syntax inventory bypassed settlement, adding 1,003 cuts and taking complete answers from 3 to 0. Missing calls now enter the existing unresolved-reference loop and all its import, ambient, receiver, chain and closed-world proofs. The call kind distinguishes calls from constructions; no method-name list or second settlement implementation is added. The new public composed-query fixture was RED under unconditional cuts and GREEN through the shared path; a type-correct mutation removing missing sites from that path fails the fixture's external-leaf assertion. Its Array receiver assertion requires the actual global proof; its unknown receiver retains the R6b cut in the presence of a repository value-position member name. Existing R6c closed-world semantics are unchanged.

| Probe | Traces | Steps baseline → corrected | Cuts baseline → rejected → corrected | Complete baseline → corrected |
|---|---:|---:|---:|---:|
| pfe | 14 | 301 → 301 | 48 → 99 → 48 | 0 → 0 |
| pbr | 15 | 325 → 327 | 250 → 252 → 252 | 0 → 0 |
| rwf | 8 | 97 → 97 | 40 → 55 → 40 | 2 → 2 |
| rwb | 15 | 347 → 347 | 325 → 340 → 340 | 0 → 0 |
| shop | 10 | 345 → 345 | 190 → 251 → 190 | 1 → 1 |
| ord | 13 | 210 → 223 | 259 → 265 → 265 | 0 → 0 |
| web | 15 | 2445 → 2451 | 1071 → 1327 → 1133 | 0 → 0 |
| self | 2 | 4957 → 4988 | 2559 → 3156 → 2719 | 0 → 0 |

Totals: 9,027 → 9,079 steps; 4,742 → 4,987 cuts (rejected: 5,745); 3 → 3 complete; 5,125 → 5,127 body expansions. All 92 probes were re-run. Every one of the previous 1,003 extra cut places matched a measured settlement outcome, with no unmatched or mixed places:

| Outcome at the previous extra cut place | Count |
|---|---:|
| External leaf (package or existing R6c unnamed leaf) | 422 |
| Ambient/global terminal, outside repository traversal | 288 |
| Proven step | 52 |
| Unresolved-link cut | 241 |
| Total | 1003 |

Global terminals retain the existing public `global` leaf representation; they are not repository steps. The 1,006 raw missing-call occurrences, before deduplication by public place, yield external 422/global 290/step 53/cut 241; there is no unaccounted occurrence. The remaining 241 site cuts plus four cuts in two newly reached bodies produce 245 cuts beyond baseline, rather than 1,003. Remaining `.map` cuts include unproven call-result chains such as `this.shownFeed().value.map` and `unique(files).flatMap(...).map`; no builtin return-type whitelist is introduced.

Top 30 new cut names against baseline (public `at[0]` places, deduplicated per probe exactly as in the parent's count):

| Name | New cuts |
|---|---:|
| `map` | 83 |
| `optional` | 21 |
| `has` | 18 |
| `get` | 17 |
| `put` | 10 |
| `find` | 9 |
| `parse` | 8 |
| `add` | 6 |
| `impactFact` | 6 |
| `at` | 6 |
| `this` | 5 |
| `focus` | 4 |
| `safeParse` | 4 |
| `getSlug` | 3 |
| `super` | 3 |
| `remove` | 3 |
| `replace` | 3 |
| `push` | 3 |
| `test` | 3 |
| `digest` | 3 |
| `unresolvedOncePerFile` | 2 |
| `follow` | 2 |
| `receiverOf` | 2 |
| `getId` | 1 |
| `getMessage` | 1 |
| `addLabel` | 1 |
| `resize` | 1 |
| `scrollIntoView` | 1 |
| `set` | 1 |
| `count` | 1 |

The 245 new places are 32 bare and 213 member/computed calls. The three S2 public-query repros still answer partial, with cuts at `flow.ts:2 (p ? p : p).save`, `flow.ts:3 [p][0].save`, and `flow.ts:4 (0, p).save`, each listing `flow.ts::Port.save` as a candidate.

The same 17-command differential remains byte-identical in stdout, stderr and exit code, all exit 0: six maps (ord/pbr/web/pfe/rwb/shop), four callers (ord/pbr/rwb/web), two importers (ord/rwf), two outlines (ord/shop), three impacts (ord HEAD~3, rwb HEAD~5, web HEAD~3). Manifest: `diff.json`. Probe manifest: `probes.json`. Per-site settlement evidence: `measure/head/probes/*.sites`, collected by temporary local instrumentation that was removed before verification. Baseline and rejected outputs remain in `measure/base` and `measure/rejected`; no second baseline export was created. Summary: `correction-summary.json`, in scratch `/private/tmp/ye-ast-unaccounted.9WC4fO`.

C2's render order and the accepted alias boundary are unchanged by this correction. Final foreground `npm run check` exited 0: typecheck and architecture passed; 3,663 tests passed, 0 failed/cancelled/skipped. The public S2 table, render test and new settlement fixture all pass. The missing-site-disconnection mutation was RED and restored before this check. `git diff --check` passed.


### Exact source ownership correction (2026-11-07)

Review of `05318a8c` found a false step: on one line, empty `B.run` inherited a tagged call from homonymous `A.run`. The public repro failed before this correction. Inventory ownership now uses the unique innermost source span, with 1-based lines, 0-based columns and an exclusive end. `owningBodyAt` in `domain/shared/source-span.ts` is the small reusable rule for the parallel slice 4 join. Equal or overlapping innermost spans prove no owner. Declaration names never prove ownership.

The adapter transports declaration columns already stored by the index. TypeScript and Java readers supply exact scope spans and call anchors. Indexed edges and unresolved references must reconcile to a unique inventory occurrence in the same body before settlement. An exact invocation start takes precedence over enclosing statement anchors; exact callee spelling takes precedence over its final name. A line-only record is usable only when its owning body and callee select one occurrence. Ambiguity stays an unresolved-link cut. Missing, proven-owned sites still enter the same R1–R6 settlement as indexed pending references. Anonymous callbacks without an indexed body retain their enclosing trace obligation. There is no receiver-shape or builtin-method list.

The same-line public table covers two classes, nested homonymous functions, arrow properties, tags, optional calls and Unicode before the bodies, querying both empty and active bodies. Empty bodies remain complete with just their root; active bodies retain `aOnly` and never `bOnly`. A type-correct mutation restoring name/line assignment failed both the repro and table; choosing the first line-only occurrence failed the ambiguity test. Mutations were restored. Existing settlement coverage now requires both package leaves, `Injectable` and `computed`. No existing expectation was relaxed in this round. Temporary regressions in object-chain matching, initializer/decorator ownership and Java statement anchors were category (b), over-cuts: matching was corrected and their existing assertions pass unchanged. No new category (a) expectation change was needed.

The original baseline `15f44afa` export was reused. All 92 probes and 17 differential commands exclude ThingsBoard, as does the test corpus; no ThingsBoard repository was indexed, traced or mapped. Final measurements:

| Corpus | Traces | Steps baseline → corrected | Cuts baseline → corrected | Expanded baseline → corrected | Complete baseline → corrected |
|---|---:|---:|---:|---:|---:|
| pfe | 14 | 301 → 303 | 48 → 48 | 201 → 203 | 0 → 0 |
| pbr | 15 | 325 → 327 | 250 → 271 | 336 → 336 | 0 → 0 |
| rwf | 8 | 97 → 97 | 40 → 40 | 70 → 70 | 2 → 2 |
| rwb | 15 | 347 → 347 | 325 → 341 | 404 → 404 | 0 → 0 |
| shop | 10 | 345 → 361 | 190 → 195 | 252 → 268 | 1 → 1 |
| ord | 13 | 210 → 223 | 259 → 314 | 291 → 291 | 0 → 0 |
| web | 15 | 2445 → 2448 | 1071 → 1145 | 1326 → 1325 | 0 → 0 |
| self | 2 | 4957 → 4988 | 2559 → 2701 | 2245 → 2245 | 0 → 0 |
| Total | 92 | 9027 → 9094 | 4742 → 5055 | 5125 → 5142 | 3 → 3 |

All 92 before/after commands exited 0; 60 probe answers changed. Relative to the reviewed `05318a8c` run (9,079 steps, 4,987 cuts, 5,127 expansions), exact ownership yields 9,094 steps, 5,055 cuts and 5,142 expansions. Strict ambiguous joins now retain cuts; corrected initializer ownership also reaches additional bodies. These are measured structural counts, not a claim that every added cut is a new missing-site defect. The previous top-30 and settlement table above describe the historical R1–R6 correction, not this final run.

The 17 non-trace commands remain byte-identical in stdout, stderr and exit code, all exit 0: map 6, callers 4, importers 2, outline 2, impact 3. Evidence: `owner-summary.json`, `measure/head`, `measure/base`, and `measure/pre-owner` under `/private/tmp/ye-ast-unaccounted.9WC4fO`. One baseline export only. Final foreground `npm run check` on Node v24.22.2 exited 0: typecheck, architecture (560 modules) and all 3,666 tests passed; none failed, cancelled or skipped. C2 render ordering and alias policy are unchanged. Adapter source fitness requires staging rules version 10; this is cache invalidation, with no stored/public SCHEMA bump. Parallel adapter edits must coalesce that fitness digest at integration.


### Deferred execution boundary correction (2026-11-07)

The limited review of `0890f493` confirmed that exact lexical ownership alone does not prove execution. In `entry(){ ignore(() => [1].map(x=>x)); }`, an empty `ignore` never runs its argument. The inventory nevertheless asserted `[1].map` as a global external of `entry`. The public repro was RED before the correction.

This correction aligns with slice 4 commit `74dec88e`: both existing function-value call readers export the same `isFunctionValueNode` predicate that their receiver classification already uses. Syntax readers and composition supply one `functionValues` source, with whole `{ start: { line, column }, end: { line, column } }` ranges, end exclusive. Java anonymous-class bodies are included. The walk proves no execution of an unindexed function value, including an IIFE; R6 retains the invocation's own cut. An index-declared function value whose body the walk expands still contributes its own calls.

`executesInBody` is the small exported predicate next to main’s `owningBody` in `domain/trace/owning-body.ts`, available for slice 4 integration. It tests whether a site lies in a value range inside the selected body; a range containing that whole body is that body itself or its ancestor and does not exclude it. A deferred value's missing calls and pending references do not enter its lexical encloser's settlement as steps, externals or cuts, and inventory alone does not make a deferred field an executed member. The existing edge to the callee receiving that argument remains. Existing resolved direct-step advisories through callbacks/Java lambdas are unchanged, as requested. Effects intentionally differ: slice 4 retains a cut for high-value information in an unproven function value.

The public table covers an unused stored arrow, unknown callback consumer, ignored function expression, unindexed IIFE, unused Java Runnable lambda, anonymous class and an index-declared invoked arrow. A unary function-expression invocation pins the other side of the boundary: the outer invocation retains its cut even when its first token shares the function value’s start. Value ranges are matched to the call’s actual enclosing syntax scopes, so lexical contents and an invocation wrapping that value are distinct. The last retains its `[1].map` global call; uninvoked or unindexed values contribute none to the encloser. The existing settlement fixture required `[1].map` from an uninvoked `computed` callback; that expectation encoded the same false external. Its direct literal-call witness now lives in the executed `run` method, preserving coverage of R4 settlement. C2, Java signature comparison files and SCHEMA are unchanged.


### Integration with main and final measurement (2026-11-07)

The owner requested merging main `273871bd` (slice 4), followed by main's test-only pruning at `2f3569b8`. Correction/integration commit `b63f9cca` keeps main's single `owningBody` and `comparePositions` in `domain/trace/owning-body.ts`; `owningBodyAt` and its former source file are removed. Calls and effects share `declarationSpan` and `executesInBody`, plus the same required `functionValues` source and existing language predicates. Call inventory matches those ranges to the actual enclosing syntax scopes, preserving an outer invocation that wraps a value even when both start at the same token. Effects retain their deliberate high-value cut policy. Source metadata is never inferred from callee spelling. Staging rules version 11 and its fitness digest distinguish the combined adapter; there is one historical version 10 entry. No additional SCHEMA bump is introduced beyond main.

The 19 focused integration entries passed. Four final merged mutations each typechecked with exit 0 and made the public tests fail: disconnect the range predicate; omit Java ranges/scopes; treat an expanded indexed value as unrun; and treat an invocation wrapping a value as its lexical contents. All were restored. The scope table includes both parenthesized and unary IIFEs, an invoked indexed arrow, unused arrow/function expression, unknown consumer, Java lambda and anonymous class. It preserves the edge to `ignore` while forbidding its callback's external. Main's pruned tests stay pruned.

A single lean baseline export was reused in place for main `2f3569b8`. Both implementations ran all 92 probes at identical pinned input SHAs (TS49/Java43); all exit 0. The historical pre-R12 tables above describe their named commits and must not be conflated with this main comparison:

| Corpus | Traces | Steps main → integrated | Cuts main → integrated | Complete main → integrated |
|---|---:|---:|---:|---:|
| pfe | 14 | 301 → 263 | 48 → 28 | 0 → 0 |
| pbr | 15 | 325 → 327 | 250 → 270 | 0 → 0 |
| rwf | 8 | 97 → 97 | 41 → 41 | 2 → 2 |
| rwb | 15 | 357 → 357 | 324 → 299 | 0 → 0 |
| shop | 10 | 345 → 361 | 190 → 155 | 1 → 2 |
| ord | 13 | 261 → 280 | 356 → 416 | 0 → 0 |
| web | 15 | 2445 → 2384 | 1071 → 807 | 0 → 0 |
| self | 2 | 4957 → 4974 | 2559 → 2219 | 0 → 0 |
| Total | 92 | 9088 → 9043 | 4839 → 4235 | 3 → 4 |

Expanded bodies: 5,211 → 5,170. All 17 non-trace commands remain byte-identical in stdout, stderr and exit code, all exit 0: map6, callers4, importers2, outline2, impact3. The seven sampled unnecessary cuts from the limited recheck (C19/C47/C65/C93/C238/C242/C254) all remain: this scope rule removes 0/7, and no separate patch was attempted. They are constructor delegation, an explicit static call and array-return chains outside deferred value scopes. Existing resolved direct-callback/Java-lambda step advisories remain unchanged.

Evidence under `/private/tmp/ye-ast-unaccounted.9WC4fO`: `merged-final-summary.json`, `measure/base` (main2f3569b8), `measure/head`, pinned manifests `probes-deferred-pinned.json` / `diff-deferred-pinned.json`, `merged-mutations.json` and `merged-*-mutation.log`. Original baseline15f44 outputs remain under `measure/base-15f44`; reviewed0890 outputs remain under `measure/pre-deferred`. Only one baseline source export exists. ThingsBoard is excluded from all runs; HOME, XDG cache/config and TMPDIR point inside this scratch. Java signature-comparison files are unchanged relative to main; C2 render ordering and the accepted alias boundary are unchanged.


Final closure verification on Node v24.22.2: foreground `npm run check` exited 0, with typecheck, architecture and all 3,699 tests passing; none failed, cancelled or skipped. No implementation change followed that run. Global code-cleanup and the repo extension reviewed the own diff against main: canonical range helpers/predicates reused, duplicate adapter properties/version entries removed, unused helper retired, both root selection and walk wired to the same source; C2, main's pruned tests and base advisories left intact. Cleanup itself did not commit or merge. `git diff main --check` passed. Scratch footprint about449 MB, including one updated base export and retained evidence; no ThingsBoard input, user-cache/config write or push.


### Bounded callback-obligation correction after c6003d08 (2026-11-07)

The final recheck rejected c6003d08: excluding indexed pending calls inside callbacks silently removed obligations, including `forEach(() => cb())` and Shopizer AddComponent's two subscription cuts. The owner superseded that policy with a narrower rule: function-value exclusion belongs only to this branch's additional syntax inventory. Main's indexed callback steps, cuts and externals remain unchanged.

The walk now passes original indexed edges/references inside unindexed value scopes into main's existing settlement before any inventory reconciliation or position normalization. The inventory still excludes those contents. Existing main ranges and the same source-site matcher distinguish the boundary; no new execution inference, parser or receiver list is introduced. The ignored `[1].map` callback stays free of inventory-added externals; the outer consumer edge remains. Same-line ownership, C2 and effects are unchanged.

The public callback-obligation table was RED before the fix and GREEN after it, including a subscribe callback containing unresolved forEach/filter and cb calls. The fixture states their member footprints to distinguish R6b cuts from main's R6c unnamed leaves. A type-correct mutation that discards retained indexed references compiles and makes the new test fail; it was restored. Obsolete Java assertions forbidding main's callback externals and their vacuous table rows were removed; the original Java call-shape coverage remains. Paired native controls show ignored/subscription answers byte-identical to main. The each control has identical callback cuts; its only difference is a proven external on the outer literal forEach, which is outside the excluded value.

Fresh paired measurements against current main2f3569b8, at identical pinned corpus SHAs: all92 commands per side exit0; steps9088→9161, cuts4839→5133, expanded5211→5228, complete3→3. Every complete-status change was enumerated: the list is empty, including no partial→complete transition. Shopizer AddComponent probe58 is partial on both sides,45 steps each, with its two cuts exactly equal (forEach at108 and data.filter at161). Its remaining step-record differences are only the outside-inventory Component decorator external and outer dialog onClose.subscribe external. No callback cut is lost there. All17 non-trace commands are byte-identical in stdout/stderr/exit code. ThingsBoard remains excluded.

Evidence: callback-final-summary.json, callback-red.log, callback-green2.log, callback-mutant-typecheck.log, callback-mutation.log, callback-pair/results.json, measure/base and measure/head under the same owned scratch. Prior rejected c600 raw outputs are preserved under measure/rejected-c600. Main source export is reused; HOME/XDG/TMPDIR stay isolated. The earlier c600 table records a rejected result and does not establish correctness.

Final bounded-round verification: Node v24.22.2 foreground `npm run check` exited0; typecheck, architecture and all3,700 tests pass, none failed/cancelled/skipped. Global/repo cleanup reviewed only this correction and reused existing range/settlement components; no other production rule changed. `git diff --check` passes. No source implementation changed after this check.
