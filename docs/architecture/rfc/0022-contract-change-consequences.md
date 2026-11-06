# RFC-0022: Contract change consequences

- Status: Draft, 2026-11-06
- Related: [ADR-0010](../adr/0010-trust-modes.md), [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) (family
  "consumer field reads"), [ADR-0018](../adr/0018-type-information-as-a-fact-input.md), [RFC-0002](0002-facts-contract.md),
  [RFC-0007](0007-extension-model.md) (rows A5, S9), [RFC-0011](0011-cross-repository-impact.md)

**In short:** given a declared hypothesis about one property of an operation's response, follow the value from the
operation through source-proven flow steps to the code that uses it, and state for each use whether the change makes it
fail, whether a guard already protects it, or whether it needs review. Every place where the flow cannot be followed is
reported where it happens. The first slice (F0) covers Angular/TypeScript consumers of a response property that becomes
nullable or is removed, and is measured against an independent oracle before anything wider is built.

## The question

"If I change this contract, which parts of the system stop complying with it and why?" `impact`, `callers` and `trace`
answer what is connected. This family answers which expectations a change contradicts, with the chain that proves the
value reaches each one.

## Model

- **Hypothesis.** An operation (HTTP method and path as its handler declares them), the response, a property path
  (`a.b`, `[]` for an array element: `[].owner.name`) and a change. F0 changes: `nullable` and `removed`. The old
  guarantee is "present and non-null" and the answer states that assumption. Changes are data: a new kind extends the
  guarantee vocabulary, never a code path per case.
- **Chain.** Operation → qualified link → call site → flow steps → use. Each step carries its evidence and its path
  rewrite. The chain is the provenance. A declared type is never provenance: `http.get<T>` is an unchecked assertion,
  and two declarations that share a type are not connected by it.
- **Use.** An operation applied to the value at the property path. F0 requirements: a dereference beyond the changed
  segment (member read, call, keyed read) requires the value to be present and non-null; display, comparison or passing
  the changed value itself requires nothing the slice can decide.
- **Verdicts,** per use and scoped to its chain:

  | Verdict | When |
  |---|---|
  | `incompatible` | An unguarded dereference of a value the new contract permits to be null or absent. Carries the counterexample (`null`, absent) and the requirement. |
  | `admits` | A guard is proven between the changed segment and the dereference. |
  | `review` | The value reaches the use but the slice cannot decide: no failing operation, a removed property behind a guard, a sink outside the vocabulary. |
  | frontier (`unknown` item) | The flow cannot be followed past this place; location and reason. |

- **Asymmetry.** `admits` needs a sufficient guard; `incompatible` needs an unguarded failing operation on a modelled
  chain. Anything else is `review` or a frontier. `!` is not a guard. `?.` guards only the segments it covers.

## F0 flow steps (TypeScript and Angular)

A value is followed only through these steps; anything else it flows into is a frontier with its reason.

| Step | Path effect |
|---|---|
| HTTP call site on a qualified link; `observe: 'response'` | the body; with `observe: 'response'` the body sits under `body` |
| `return` of the value; each proven call occurrence continues, and a function entered through an argument returns only to the call that passed it | none |
| `pipe(...)`: pass-through operators listed as data (`catchError`, `tap`, `filter`, `take`, `first`, `finalize`, `shareReplay`, `takeUntil`, ...) | none |
| `map(p => e)` where `e` is an access path on `p` or an object literal of access paths | projection or property-wise rename |
| `map(p => { ... return e })`: each `return` of a block body | as for an expression body |
| `subscribe(p => ...)`, `subscribe({ next: p => ... })`, `await firstValueFrom/lastValueFrom(...)`, `toSignal(...)` | bound to the parameter, variable or signal |
| `httpResource(...)`; the value a `resource`/`rxResource` `loader`/`stream` returns | the resource's `value()` signal |
| assignment to a field, a local, or `signal.set(...)`; `e ?? f`, `e \|\| f` with the value on the left | bound to the holder |
| argument of a call to a function or method declared in the repository | the parameter at that position |
| route resolver registered under `resolve: { key }`, when every root router of the repository binds component inputs (`withComponentInputBinding()` passed to `provideRouter(...)` directly or in a spread array of features, or `RouterModule.forRoot(..., { bindToComponentInputs: true })`; routes under `forChild` or lazy loading inherit it) | the component input whose public name is `key` |
| a component input by its public name: `@Input()`, `@Input('alias')`, `input()`, `input.required()`, `model()` with `alias` | the member that declares it; no such input is a frontier |
| the same resolver, read in that route's component through `ActivatedRoute` `data` (`data.subscribe(({ key }) => ...)`, `snapshot.data[key]`) | bound to the destructured or read value |
| template property binding `[name]="path"` on a child component | the child input whose public name is `name` |
| a read of a component field, input or signal in its template (`x()`, `@if (x(); as y)`, `*ngIf="x as y"`, `@for (i of x)`) | bound to the alias or item; `@for` over the changed collection itself is a `review` use |

A zero-argument call is a signal read only when the callee is the carried value itself or a resource's `value`; calling
the changed value is a dereference; a resource member that only reports or replaces its state (`isLoading`, `error`,
`hasValue`, `status`, `reload`, `set`, ...) is no loss; any other method call on a container of the changed property
(`update(fn)` included), a pipe other than `async`, an `async` projection and a function passed by reference are
frontiers.

## F0 guards

Recognized when they test the path up to and including the changed segment, or its alias: `?.` on the changed segment;
truthiness or `!= null` / `!== null` (with `!== undefined` for absence) in `@if`, `*ngIf`, `if`, `&&`, `?:`; an early
`return` or `throw` on the negation in the same block; `??` or `||` directly on the changed value with a fallback
proven to exclude the absence (a literal object, array, string or number); a destructuring default (`{ x = [] }`),
which covers `undefined` only. A guard on one element (`items[0]`) protects only reads of that same index. A read after
a write to the guarded path or a prefix of it reads the written value, and one that only a guard outside its closure
would protect is not decided where the closure runs: both are frontiers. A caller edge the code graph only guesses is
never proof, and a reference to a function is not a call. User type guards, assertion functions and `instanceof` are not recognized: a use behind them is
`review`. A dereference is any operation that fails on null or undefined: a member read, a call, a keyed read, an array
spread, iteration, destructuring (an empty pattern included).

## Output

The RFC-0002 envelope. Uses are complete findings with their verdict, chain, requirement, counterexample or guard
evidence, the repository they are in and the link they came through (its id, basis, call site and handler); frontiers
are `unknown` findings with a reason and evidence, every place with its repository. Each HTTP call site is matched once
over every repository of the workspace, its own included: a call two repositories serve is an ambiguous frontier. The
call sites whose target no read could evaluate are always listed as one `unknown` item, since any of them may call the
operation; when no call site links, that item also names the handler. Output is
sorted and reproducible; the hypothesis is echoed with its assumed old guarantee. F0 has no MCP, CLI or protocol
surface.

## Ownership

| Layer | Owns |
|---|---|
| `core/domain/contracts` | hypothesis, access path, path rewrites, guard and verdict rules |
| `core/ports` | the driven port for flow steps and uses, the driving query family |
| `core/application/contracts` | the worklist over chains, frontier accounting, the fact |
| `core/adapters/typescript` | flow steps in classes and functions, router resolvers and component inputs |
| `core/adapters/angular-compiler` | template uses, guards, aliases and child bindings |

## Validation (F0 gate)

Each rule has a fixture observed failing first and a type-correct break proof. An oracle written before the
implementation result, by someone who did not write it, enumerates consumers of chosen properties in two corpus
applications, with a shared-type and a multi-producer negative control. Measured: consumers found and missed, false
`incompatible`, false `admits`, frontiers by reason. The owner decides from these numbers whether the family continues.

## Out of F0

Requests and writers, enum values, shape changes (pagination), semantic tags (units), OpenAPI normalization, Java DTOs
and consumers, validators, stores (NgRx, signal stores: frontier only), attribution against a declared base contract.

## Open questions

1. Links matched by `suffix`, `route-overlap` or `gateway-prefix`. Recommended: a frontier with the basis, not followed.
2. Attribution when the old contract is not declared. Recommended for F0: the assumed old guarantee, stated.
