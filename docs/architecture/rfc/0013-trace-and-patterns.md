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
| R7 | Dispatch: a step at an interface or abstract method has as `alternatives` every implementation of it in the repository (through `implements` / `extends`, the same type walk `callers` uses). The step expands in place the one implementation when there is exactly one, or the one the framework's dispatch proves (a qualifier, `@Primary`, a named bean), noting which proof chose it; with several and no proof, none is expanded and the step carries a cut. Implemented (slice 3) for a body-less method (R10) with the import origins' `dispatchTargets`: for each concrete class below the method's owner, by the strict reading of every supertype the sources write (Java's one resolver, ADR-0029 decision 9), the body its own declaration or the nearest one up its class chain gives; a class that declares the name with the method's arity only as another signature, or whose chain ends with no declaration, proves nothing; parameter types are compared as the strict reading resolves them, never by their text (ADR-0029 decision 10), so a homonym from another package is another signature, and a type the reading does not settle or a type variable proves no override. The one body is a child `via: "dispatch"` with no call place, and the step lists it as its one alternative; several bodies are a cut listing them, each an alternative; no body, or no proof, keeps the cut of R10. No proof when a value the sources do not place may implement the owner: a source that does not parse, a JVM language no extractor reads, an aspect or a JDK API that implements an interface at run time anywhere (as in R4); an annotation on the owner or the method other than the language's own (`@Override`, `@Deprecated`, `@SuppressWarnings`, `@FunctionalInterface`), since a generator or a proxy may implement it (`@Mapper`, a client interface); a supertype of the owner or of a type above it outside the repository (`extends JpaRepository`); a supertype the strict reading leaves unsettled under the name of the owner or a type below it; an anonymous or local class, or an enum, below it; or a lambda or method reference anywhere while the owner or an interface below it is functional: at most one abstract method beside `Object`'s among those it declares or inherits by Java's rules (a declaration overrides what it inherits under its signature, a more specific interface's method overrides those above it, abstract methods of one signature merge), or two methods of one name and arity anywhere in its hierarchy unless every parameter type of both is written concrete (no type variable of the method or of its interface, bounded or not, no wildcard, no type arguments): `send(T)`, `<U extends T> send(U)` or `send(List<?>)` beside `send(String)` may be one signature under a type argument, for that interface and every one below it. A framework's choice among several (a qualifier, `@Primary`, a profile) is not read. TypeScript types structurally, so any object with the members may stand where the type is declared: no hierarchy proves its bodies and the cut stays. Measured before the resolved-type signature comparison: on backend B 13 of 24 single-implementation cuts expand; backend A holds an aspect, so none does; the checkout service opens its application service (4 to 34 steps), while its one-method repository ports stay cut, since the service holds lambdas and a lambda may implement a functional interface. The comparison takes the checkout back to 4 steps: the implementation reads its parameter types through wildcard imports the strict reading does not settle (slice 3 measured) |
| R8 | Order: children in the line and column of their call; a call inside a function passed as an argument (a callback to `subscribe`, `then`, `pipe`, `effect`, a stream lambda) is marked `deferred` |
| R9 | Roots: a symbol, a line range or an entrypoint. An HTTP route, listener or job starts at its handler. A UI route starts at its component, whose children are its constructor and field initializers, then its lifecycle hooks in the framework's order, then the handlers its template binds to events, then its template children (`uses-component` and the rest). A property or field whose initializer makes calls is a root by symbol or by a range inside it, and a class root's children are its members that have a body or an initializer that makes calls, in source order, reached `via: "member"`, an obligation of the root that an earlier expansion of the class below another root never meets; `callers` and `impact` seed as before. Implemented (slice 3) for entrypoints: a target `{kind, name}` (CLI `--entrypoint <kind>:<name>`) reads the map at the same snapshot only when one is given; every complete entrypoint of that kind and name roots at its handler, a UI route at its component, each the declaration of the index that joins the map's place (same file, the place's line in its span, the same simple name); a UI route whose component is `unknown`, or a handler no declaration joins, is an `unresolved-link` cut at that place, and a kind and name the map does not hold is the `unknown-entrypoint` fault listing the map's names of that kind. A class an entrypoint starts at, a UI route's component, runs as a page: its constructor, field initializers and class-body calls in source order, then its lifecycle hooks in Angular's order (`ngOnChanges` to `ngOnDestroy`), then what its template's event bindings call, in template order: an own method (`(click)="save()"`), or the method the relations prove a call runs (`store.save()` through an injected field, `via: "template"`), then the components, directives and pipes its template uses, in the order the template text first uses them, each `via: "template"` and run as a page itself, then its other members in source order. Any other event call (a template local's, `$event`'s, an unproven field's), a handler the class runs no member of, a template item the relations cannot place, a used declaration the index does not hold, a template that cannot be read or that the component does not name, and a page component the relations know no template of are `unresolved-link` cuts at their place; a class root by symbol keeps source order. Declaration and entrypoint targets are not mixed in one request |
| R10 | Folding: a proven terminal step (expanded, with no children, no cut and no effect) is a leaf `{symbol, file, start, end}` of its parent, `deferred` when the parent passes it as a value; the text lists it by name on one line under its parent, and the full answer keeps its location. A step a bound stopped or with an unsettled call stays a step, and so does a method dispatch may replace. The index records neither bodies nor modifiers, so the declaration's own syntax decides, read by the parsers of R6 from the same parse, per file and once per query, and matched to the index node by name and by the lines from its first token (a decorator or annotation) to its name: a body-less callable (a TypeScript `abstract` method, overload signature, ambient function or interface method signature; a Java `abstract` method or interface method without `default`, `static` or `private` body) is a step with an `unresolved-link` cut at its declaration listing every repository declaration of its name in any type below its owners, an interface's included (none when there is none); a `static`, `private` or `final` method with a body expands it and never gets a dispatch cut; an overridable method with a body (a Java `default` method, a class method) expands it and gets a cut only when a type below its owner declares a method of its name, listing those declarations. A declaration in an interface below counts, whether a `default` override or a re-abstraction: a class below that interface may supply yet another body. A method its syntax does not state keeps the interface-owner rule: a cut when an interface declares it. The types below an owner follow the index's `extends` and `implements` edges (the index records no TypeScript `interface B extends A`, so a type below such an interface is not found from `A`); the index leaves a parameterized supertype (`interface Sub extends Port<String>`) as an unresolved reference spelled with its type arguments, so that reference names every type declaration of its raw name (`Port`), and a homonym adds its implementations to the candidates. Until R7 binds dispatch these cuts stay. So does a property or field a call reaches: the call runs the value the property holds, which its initializer built at construction, so the step is not expanded and carries an `unresolved-link` cut at the property's declaration (the value is unknown); an arrow function assigned to a property is indexed as a method and expands, and a property root (R9) still traces its initializer. External leaves are one line per parent grouped by module (`rxjs: pipe, subscribe`); nothing is dropped |
| R11 | A declaration already expanded appears again as `seen` with the step that expanded it; cycles end there |
| R12 | Effects: an external leaf whose module, type and member a plugin row declares as an effect (HTTP clients, message publishers, data-access types; RFC-0007, ADR-0013) carries its kind, and its target when RFC-0011's call-site extraction resolves one. Implemented (slice 4) for HTTP and messages: the rows are the call-site extraction's own vocabularies (the standard HTTP clients, `@HttpExchange`, Feign, the brokers' templates and NATS's client API, Angular's `HttpClient` and the wrappers it derives), read once per query over the snapshot's sources. A call site joins the trace by place: at a line where the index records a call (an edge or an unresolved reference) of an expanded body, the innermost such body, it is an effect of that step, `http` with the method, path and base, or `message` with the protocol and destination; a wrapper's request is the caller's effect, as RFC-0011 places it. A call site whose target the extraction does not decide (a library whose source the snapshot lacks, an undecided URL) is an `unresolved-link` cut at its place, `<kind> effect through <library>`, never an effect whose kind a name suggests. A call site at no recorded call of the innermost declaration around it, when that declaration is an expanded body, is the same cut, never dropped; one in a body the walk did not expand is not an effect of the trace. Data-access types have no row yet and stay out |
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
  effects?: ({ kind: "http"; line: number; target: HttpTarget } | { kind: "message"; line: number; target: EventTarget })[];   // R12, RFC-0011 targets
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
| 3 (implemented: R7 for Java, R9 entrypoint and page roots, R5 for Java, TypeScript unproven receivers as cuts) | R7 dispatch and R9 entrypoint roots, with the template's event handlers read by the Angular adapter | the service checkout trace and the page trace; the checkout's dispatch stays cut under the fail-closed signature comparison (slice 3 measured) |
| 4 (implemented: R12 for HTTP and messages) | R12 effects with RFC-0011 call-site targets | each effect of the acceptance table (slice 4 measured) |

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
