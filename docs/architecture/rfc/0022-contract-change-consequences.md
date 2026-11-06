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
  (`a.b`, `[]` for an array element: `[].owner.name`) and a change: `nullable`, `optional`, `removed`,
  `{ "renamed": "<name>" }`, `{ "type": "<kind>" }`, `{ "wrapped": "<property>" }`, or a non-empty list of them on the
  same property. The old guarantee is "present and
  non-null" and the answer states that assumption. Changes are data: a change is the set of values it introduces,
  normalized once per hypothesis (see "Change algebra"), never a code path per case.
- **Chain.** Operation → qualified link → call site → flow steps → use. Each step carries its evidence and its path
  rewrite. The chain is the provenance. A declared type is never provenance: `http.get<T>` is an unchecked assertion,
  and two declarations that share a type are not connected by it.
- **Use.** An operation applied to the value at the property path, described as its steps past the changed segment and
  how it ends. Each concrete value standing for a class the change introduces is decided on its own: the guards it
  passes in order handle it or replace it, then the steps (a member read, a keyed read, a call) and the end are
  evaluated on what is left with the consumer language's own semantics (see "Change algebra").
- **Verdicts,** per use and scoped to its chain:

  | Verdict | When |
  |---|---|
  | `incompatible` | An introduced value reaches, unguarded, a step or end that throws on it. Carries the witness (the value written as a JavaScript literal: `null`, `undefined`, `""`, `0`, `"a"`, `[]`, `{}`; `null` first when several throw), the failing step or end of the descriptor with its index `at` (the number of steps when the end fails), the capability the value lacks there (`readable`, as a member read or an object destructuring needs, `function`, `iterable`) and, when a fallback put it in place of the witness, the replacement. |
  | `admits` | Proven guards keep every introduced value from the use; carries those guards. |
  | `review` | No introduced value is shown to throw, but the slice cannot admit: a value reaches a use that runs on it (`consumed`), a removed or renamed property behind a guard, a guard outside the vocabulary or a test the module cannot decide before a failing step (`opaque-guard`), a value the module cannot follow (`unknown-value`), an opaque fallback replacement the use needs known (`opaque-replacement`), a sink outside the vocabulary. |
  | frontier (`unknown` item) | The flow cannot be followed past this place; location and reason. |

- **Asymmetry.** `admits` needs a sufficient guard for every introduced value; `incompatible` needs an unguarded step or
  end that fails on one of them, on a modelled chain. Anything else is `review` or a frontier. `!` is not a guard. `?.` guards only the segments it covers.

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
| a read of a component field, input or signal in its template (`x()`, `@if (x(); as y)`, `*ngIf="x as y"`, `@for (i of x)`) | bound to the alias or item; `@for` over the changed collection itself is a use that tolerates `null` and `undefined` |

A zero-argument call is a signal read only when the callee is the carried value itself or a resource's `value`; calling
the changed value is a dereference; a resource member that only reports or replaces its state (`isLoading`, `error`,
`hasValue`, `status`, `reload`, `set`, ...) is no loss; any other method call on a container of the changed property
(`update(fn)` included), a pipe other than `async`, an `async` projection and a function passed by reference are
frontiers.

## F0 guards

Recognized when they test the path up to and including the changed segment, or its alias: `?.` on the changed segment;
a condition on the value (truthiness, an equality with an absence or a literal, `typeof`, `Array.isArray`) in `@if`,
`*ngIf`, `if`, `&&`, `?:`; an early `return` or `throw` on the negation in the same block; `??` or `||` directly on the
changed value with any right side, which replaces the values its test rejects; a destructuring default (`{ x = [] }`),
which replaces `undefined` only; a `switch` clause on the covered path (see "Change algebra", Guards). Each guard states the test it applies and where the use runs; what a guard rejects is
derived by evaluating the test, never listed. A guard on one element (`items[0]`) protects only reads of that same index. A read after
a write to the guarded path or a prefix of it reads the written value, and one that only a guard outside its closure
would protect is not decided where the closure runs: both are frontiers. A caller edge the code graph only guesses is
never proof, and a reference to a function is not a call. User type guards, assertion functions and `instanceof` are not recognized: a use behind them is
`review`. A dereference is any operation that fails on null or undefined: a member read, a call, a keyed read, an array
spread, iteration, destructuring (an empty pattern included).

## Change algebra (P2, proposed)

F0 knows one delta (the value may now be absent) and one requirement (a dereference needs a value). P2 makes both data:
a change is a set of values, a use is the code's own steps over the value, and the verdict is what those steps do with
each value the change lets in. A new change is a constructor of value sets, never a code path.

**Values.** The changed value is the JSON value the response carries; flow steps keep its identity, and a step that
transforms it ends the chain, as in F0. Its classes are `undefined`, `null`, `boolean`, `number`, `string`,
`array`, `object` and literals, each literal inside its kind. Each class is represented by a few subjects, chosen per
use, and each subject states what it stands for. An **exact** subject is one value whose own keys and elements are all
known: `undefined`, `null`, `false`, `true`, `0`, `""`, a literal the use names or the change adds, a fallback's
replacement and what is read from one. A **sample** stands for every value of its class but the literals other
subjects stand for: a fresh number (every number other than `0` and the numbers the use names, which differs, loosely
and so strictly, from every literal the use names), a fresh string (every nonempty string other than the strings it
names), `[]` (every array) and `{}` (every object). What a sample's `length` gives, or what any other member of a
sample reads, is any value of a type or unknown, never the concrete value of the member that happens to stand for it.
No retired literal is a subject: the fixed ones (`0`, `""`, `false`, `true`) are dropped when the change retires them,
as the named ones are. A JSON value holds no function and no symbol, and an array or a primitive has no named member
besides those of its prototype.

**Changes.** A change gives the values the new contract permits that the old one did not (`introduced`) and those it no
longer produces (`retired`). The old guarantee stays assumed and stated: present, non-null, of whatever kind the code
relies on.

| Change | Input | Introduced | Retired | The answer adds |
|---|---|---|---|---|
| `nullable` | `nullable` | `null` | | |
| `optional` | `optional` | `undefined` | | |
| `removed` | `removed` | `undefined`, only | every present value | |
| `renamed` | `{ renamed: "<name>" }` | `undefined`, only | every present value | the new path |
| `type` | `{ type: "<kind>" }` | the kind | the other kinds | |
| `values` | `{ values: { added: [...], removed: [...] } }` (string, number or boolean literals, one list may be omitted, at least one literal) | the added literals | the removed literals | `silent`: the count of uses left without a finding |
| `wrapped` | `{ wrapped: "<property>" }` | `object` | `array` | `elementsAt`: the elements' new path, `<path>.<property>[]` |
| `meaning` | `{ meaning: "<note>" }` | | | the note |

A combined change is a list of constraints on one property, normalized once per hypothesis: the introduced values
unite, a retired literal is never introduced (its kind's fresh value differs from it), and an always-absent change with
any other, two `type` entries, a literal both added and removed, and a literal outside the kind a `type` entry states are
contradictions and refused.

**Operations.** An adapter describes, where the syntax is at hand, what the code does past the changed segment, as one
descriptor: its ordered steps, each a `member` (its name), a `keyed` read (its key when the code writes a literal one) or
a `call`, each marked when optional (`?.`); then how the chain ends: `iterate` (with the absences the construct
tolerates: `@for` accepts `null` and `undefined`), `destructure` (`object` or `array`, the pattern that destructures the value), `compare` (its exact
operator and the literal when one is written directly), `coerce` (its operator: arithmetic, unary, text), `consume`
(shown or handed on), `unmodelled`, or nothing beyond the steps. The descriptor reaches the answer unchanged.

**Evaluation.** For each concrete value, `core/domain/languages` walks the steps with the consumer language's own
semantics; for JavaScript, one module serves both adapters. A step on `null` or `undefined` throws; an optional step
there ends the chain at `undefined`, which the end then applies to. A member, or a keyed read with a literal key, on a
primitive or an array is what a frozen table of the built-in prototypes holds under that name (inherited members
included; the table follows ECMAScript 2025 with the Annex B members engines ship, is built once and is never read from
the running engine), else `undefined`; an index key on a sample array or string is `unknown`, since its elements are
not known, while an exact one has exact elements and an exact `length`; a sample's `length` is any number. On an open
object (a sample) a member is `unknown` when `Object.prototype` holds it, since an own JSON value may hide the
inherited one, and otherwise some JSON value or absent, which is never callable; an exact object keeps the exact
lookup. A value built from a fallback's literal is exact. A keyed read with any other key is `unknown` past `null` and
`undefined`. A call throws when its target is not a function, and the call of a function is `unknown`: what the callee
does is not modelled. The end then applies to the value reached: `iterate` and array destructuring throw unless it is
iterable (strings and arrays are), object destructuring throws only on `null` and `undefined`, a strict `compare` and
`consume` run, `unmodelled` is `unknown`. Converting to a primitive (`coerce`, and a `compare` that is not strict)
runs on a primitive and on an exact object or array no own key of which shadows `valueOf` or `toString` (an own key
holds a JSON value, which is no function, and the conversion may then have no result); it is `unknown` on a sample
array or object, whose keys are open, and on a value the module cannot tell. Each value ends `throws`, `handled` (a guard kept it from the use, or a fallback replaced it and the use runs
on the replacement), `runs` (it reached the use and the use ran, its result possibly changed) or `unknown`; `unknown` is
never promoted. No repository code runs.

**Guards** are predicates on the values, evaluated with the language's own operators, by exact operator, operand and
branch polarity: `x === null`, `x !== undefined`, `x != null`, truthiness, `typeof x === 'k'` (true for `null` under
`'object'`), `Array.isArray(x)`, `x === <literal>`, and a strict equality with any of several literals and absences (`one-of`), which is
how a `switch` clause states its labels. They are listed in the order the value passes them and each is
applied to the value as it stands. On an exact subject the predicate is applied. On a sample, or any value of a type, it is
decided only when it gives one result for every value the subject stands for, and otherwise it is undecided, which can only
turn a failing use into `review`, never admit a value: `typeof`, `Array.isArray` and an equality with an absence are
decided for any class; truthiness is decided for a fresh number or string (neither is the falsy value), an array and an
object; an equality with a literal of the same type is decided for a fresh sample, which stands apart from every literal
the use names; a strict equality with a literal of another type is decided; a loose equality across types, and any test
of an unconstrained number such as a `length`, is undecided. A condition, an early exit or a `?.` lets the use run where its test gives its stated
result on the value at the path it covers; a value on which it does not is `handled`. A guard on a path deeper than the
changed value reads that path first with the same semantics: a read that throws leaves the value `handled` (the test is
its own use, reported on its own), and a test the module cannot decide acts like a guard outside the vocabulary, which
only turns a failing use into `review`. A fallback (`??` for `null` and `undefined`, `||` for falsy values, a
destructuring default for `undefined`) replaces the values its own test rejects with its right side: the JSON value a
literal right side writes (`''`, `0`, `[]`, `{}`, an object or array literal of such), or `opaque` for any other. Evaluation
continues on the replacement: a use that throws on it is `incompatible` and names it, one that runs is `handled` by the
fallback, and an opaque replacement goes on as an unknown value, so an end that runs on every value still runs and
anything else is `unknown` (`opaque-replacement`). A fallback on a deeper path is followed only as far as its read. A
guard keeps F0's path scope and reach.

A use inside a clause of `switch (<covered path>)` is guarded by the clause's fallthrough group: the clauses from the
last one whose statements end in an exit (`break`, `return`, `throw`, `continue`) up to the clause holding the use,
since a clause with no statements, or one that does not exit, runs on into the next. Without `default` in the group, the
use runs where the value equals one of the group's labels (`one-of` of them, branch taken); with `default` in it, where
the value equals none of the labels outside the group (`one-of` of those, other branch). A guard is a conjunction, so a
clause reached from several labels needs the disjunction in one predicate. A label that is no literal (string, number,
boolean) and not `null` or `undefined` makes the guard an untested `case` guard, which handles nothing and only turns a
throwing use into `review`. A statement after the `switch` gets nothing from it. The labels a `one-of` names are among
the literals the use names, so no fresh value equals one, and a `one-of` that must hold and names a retired literal is
read like a strict equality with it. The switched value itself is a use whose end is a strict `compare`, as the
discriminant of `@switch` is. `in` and `instanceof` with the changed value as the right operand end `unmodelled` (the
operator is the detail); on the left of `in` the value is coerced to a key.

**Verdict,** per use: a value throws → `incompatible`, with that value as the witness, the step or end that fails on it,
the capability it lacks (`a function at toFixed`, `an iterable`) and the replacement it came from, if any; a value runs →
`review` (`consumed`); otherwise a value is `unknown` → `review`, with the descriptor; every introduced value `handled` →
`admits`, with the guards that handled them (`review` for an always-absent change, as in F0). A value that throws
decides first, whatever else the change says. Next, a `meaning` change makes every use it reaches `review` with the
reason `meaning`, since the note says the values may now be read differently and no code is evaluated against it. Then a
use that compares the value strictly (`===`, `!==`) with a retired literal written directly, or that runs only where a
strict equality with a retired literal holds (`===` with its branch taken, `!==` with its other branch), is `review` with
the reason `retired-literal`: its branch is unreachable under the new contract. Retired values are not walked, and no
fresh value equals a literal the change names. An added literal is walked as itself, with its own characters known, besides the
classes the change introduces. A combined change is evaluated once, normalized, never merged from separate verdicts.

**Silent and counted.** Under a `values` change, a use that only shows the value or compares it strictly with a literal
the change does not name gives no finding of its own when the only values that run on it are added literals: every
display of an enum would otherwise bury the findings that matter. A use where `null` or `undefined` also run (a combined
change), where a value throws or where a value is undecided keeps its finding. The domain decides which uses are silent
(`decideUse` returns `silent`); the answer counts them in `silent`, a number present whenever the change has a `values`
entry and `0` when none was left silent, so silence never reads as proven compatibility.

**Cost.** One descriptor per use, built where the syntax already is; a few representative values per introduced class,
each walked once over the use's steps; one normalization per hypothesis; no new walk of the code.

**Delivery,** each step gated by `npm run check`, the F0 measurement unchanged except corrections shown one by one, an
independent oracle for each new change, and latency, peak memory and answer size on the same corpus queries:

1. The descriptor through both adapters, `FlowUse` and the answer, with no verdict change. Each construct says what it
   does: a numeric unary operator (`-`, `+`, `~`, `++`, `--`) on the value coerces it, while `!`, `typeof` and `void`
   only test it; an assignment target is no use of the value it replaces; a loop states the absences it tolerates, so
   `for...of` and `@for` agree through their descriptors. Template method and pipe names reach the descriptor; a guard
   re-run of a chain emits nothing.
2. Changes as value sets, normalized once with their contradictions refused; `optional`, `renamed` and combined
   changes; each introduced value is walked over the use's guards and descriptor; the answer carries the witness, the
   failing step or end and the capability it lacks. Every value these changes introduce is `null` or `undefined`, on
   which a guard's exclusions already are its predicate.
3. Representative values of every class, the prototype table and step evaluation; guards as predicates by exact
   operator, operand and polarity, `typeof` and `Array.isArray` included; `type`, `wrapped`, fallback replacements and
   the replacement in the answer.
4. `values` and `meaning`, retired literals in strict comparisons, the silent-and-counted rule.
5. `switch` clauses (TypeScript) and `@switch` cases (templates) as guards: the `one-of` predicate, fallthrough groups, the
   untested `case` guard.

## Output

The RFC-0002 envelope. Uses are complete findings with their verdict (the witness, failing step or end and capability
of an `incompatible` one; the guards of an `admits` one, whose places join its evidence), descriptor, chain, the
repository they are in and the link they came through (its id, basis, call site and handler); frontiers
are `unknown` findings with a reason and evidence, every place with its repository. Each HTTP call site is matched once
over every repository of the workspace, its own included: a call two repositories serve is an ambiguous frontier. The
call sites whose target no read could evaluate are always listed as one `unknown` item, since any of them may call the
operation; when no call site links, that item also names the handler. Output is
sorted and reproducible; the hypothesis is echoed as normalized (a single change as written, a combined one as its
list), with its assumed old guarantee and, for a rename, the property's new path, for a wrapped array, the path of its
elements, once. F0 has no MCP, CLI or protocol
surface.

## Ownership

| Layer | Owns |
|---|---|
| `core/domain/contracts` | hypothesis, access path, path rewrites, value sets, change normalization, guard and verdict rules |
| `core/domain/languages` | the step semantics and prototype table of a consumer language (JavaScript for both adapters, from P2) |
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
3. A flow step that converts the value (`new Date(x)`, `Number(x)`) ends the chain today, so the JSON classes always
   describe the value at the use. Recommended for P3: such a step carries the class it produces, not a frontier.
