# RFC-0013: Trace and patterns

- Status: Draft, 2026-11-01; open questions accepted by the owner ("Acepto las recomendaciones"); `patterns` deferred;
  trace slice 1 implemented, 2026-11-06 (schema 0.22.0)
- Related: [RFC-0002](0002-facts-contract.md), [RFC-0007](0007-extension-model.md), [RFC-0010](0010-impact-queries.md),
  [RFC-0011](0011-cross-repository-impact.md), [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md),
  [ADR-0015](../adr/0015-index-reuse-by-content.md), [ADR-0017](../adr/0017-owner-of-a-member-expands-only-whole-type-edges.md)

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

| # | Rule | Settles |
|---|---|---|
| R1 | A call edge the index resolved, unless its synthesizer is ignored by `EDGE_POLICY` | a step |
| R2 | `this.<member>` and `this.<member>.<rest>` inside the class that declares the member (the inbound rule of RFC-0010, applied forward) | a step at the member |
| R3 | `this.<field>.<member>`: the field's `FieldOrigin` holds a repository class (a step at its member, with dispatch R7 when it is an interface), an external type (a leaf), or nothing known (R6). Slice 2: it needs the call-binding port | a step or a leaf |
| R4 | A bare name or a receiver identifier bound in the file: a local or a parameter whose declaration fixes its origin (`inject(T)`, `new T()`, `const x = this.f`, a type annotation `: T`), an import (a repository file: its export; a package: external with the package name), or no binding at all (a global: `global#Math`) | a step, a leaf |
| R5 | A chain on a call result `head(...).m(...)`: the head is settled first; when it is a repository declaration with a declared return type, `m` is looked up in that type; when the type is external or absent, `m` is external of it | a step or a leaf per link of the chain |
| R6 | Closed world, narrowed to what a name lookup proves (below): an unsettled call proven not to reach repository code | a leaf `external` |
| R6b | Otherwise | a cut `unresolved-link` at the place, listing the repository declarations of that name as candidates |

R6 applies only where the name at the call is the name of the callee:

| Spelling | External leaf when | Otherwise |
|---|---|---|
| member call `x.m(...)` | no member within the declared scope is named `m` (`unnamed`): a method (getters, setters and interface methods included), a property or field, or a function an object literal holds. A top-level function or constant named `m` does not count | R6b cut listing those members |
| bare call `f(...)` | the import origins say the file imports `f` from a package (`import`, with the module) or the language's own libraries declare it (`global`) | cut: a local parameter, an alias or a computed callee may be a repository function passed under another name |
| computed call `x[k](...)`, `(expr)(...)` | never | cut |

Limitation, verified on a real index: a key that aliases a declaration (`{ handle }`, `{ m: handle }`) is no
declaration of its own, so a call through an object-literal key whose name no member has is reported external
`unnamed`, even when the key holds a repository function. A function the literal defines (`{ m() {} }`,
`{ m: () => ... }`) is a declaration and counts.

R4 and R5 read the syntax tree of the file (the TypeScript compiler API in `core/adapters/typescript`, ADR-0008; the
tree-sitter syntax tree for Java), never a type checker, and are computed once per file content.

### Tree rules

| # | Rule |
|---|---|
| R7 | Dispatch: a step at an interface or abstract method has as `alternatives` every implementation of it in the repository (through `implements` / `extends`, the same type walk `callers` uses). The step expands in place the one implementation when there is exactly one, or the one the framework's dispatch proves (a qualifier, `@Primary`, a named bean), noting which proof chose it; with several and no proof, none is expanded and the step carries a cut |
| R8 | Order: children in the line and column of their call; a call inside a function passed as an argument (a callback to `subscribe`, `then`, `pipe`, `effect`, a stream lambda) is marked `deferred` |
| R9 | Roots: a symbol, a line range or an entrypoint. An HTTP route, listener or job starts at its handler. A UI route starts at its component, whose children are its constructor and field initializers, then its lifecycle hooks in the framework's order, then the handlers its template binds to events, then its template children (`uses-component` and the rest) |
| R10 | Folding: a proven terminal step (expanded, with no children, no cut and no effect) is a leaf `{symbol, file, start, end}` of its parent, `deferred` when the parent passes it as a value; the text lists it by name on one line under its parent, and the full answer keeps its location. A step a bound stopped or with an unsettled call stays a step. External leaves are one line per parent grouped by module (`rxjs: pipe, subscribe`); nothing is dropped |
| R11 | A declaration already expanded appears again as `seen` with the step that expanded it; cycles end there |
| R12 | Effects: an external leaf whose module, type and member a plugin row declares as an effect (HTTP clients, message publishers, data-access types; RFC-0007, ADR-0013) carries its kind, and its target when RFC-0011's call-site extraction resolves one |
| R13 | Bounds and cuts as every walk: the RFC-0010 budget, unset by default; unresolved places, unbound dispatch and unreadable templates are cuts |

### The fact

Slice 1 answers this shape; `effects` (R12) and `alternatives` (R7) join it in their slices.

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
  via?: "call" | "own-member" | "reference";
  deferred?: true;
  seen?: number;
  leaves?: { symbol: string; file: string; start: number; end: number; deferred?: true }[];   // folded (R10)
  external?: ({ kind: "import"; module: string; names: string[] } | { kind: "global" | "unnamed"; names: string[] })[];
}
```

### Text for the agent

```
trace POST /orders/checkout -> OrdersController.orderCheckout (src/.../OrdersController.java:35)
status: partial (cuts: 1 unresolved-link)
effects (3): http GET /restaurants/{id} at RestaurantsRepositoryAdapter.java:36, http POST .../reward-points/quote at RewardPointsRepositoryAdapter.java:34, data OrderRepository.save at ...
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
  unresolved-link at ...
```

The effects come first, since they decide the plan; steps follow the MCP depth summary and `expand` of the latency plan.

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
| 3 | R7 dispatch and R9 entrypoint roots, with the template's event handlers read by the Angular adapter | the service checkout trace and the page trace |
| 4 | R12 effects with RFC-0011 call-site targets | each effect of the acceptance table |

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
