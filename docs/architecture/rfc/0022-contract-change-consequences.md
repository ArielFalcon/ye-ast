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
  rewrite. The chain is the provenance. A call site the extraction reached by propagating a request through other
  bodies starts at the issuing owned call, the innermost owned invocation whose expansion reaches the request, and the
  call it was reached from stays in the chain beside it: a value is consumed where the request is issued, not where a
  listener or a use case passed it on. A declared type is never provenance: `http.get<T>` is an unchecked assertion,
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
| a call whose declaration's summary states a response body | the body, through the container the summary names |
| a conditional inside the path a request writes, on one of the function's own parameters (`all ? '/items' : '/items/' + id`) | one request shape per branch, each carrying the test it holds under; a literal argument decides it, and an undecided one keeps both |
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
would protect is not decided where the closure runs: both are frontiers. A caller edge the code graph only guesses, or matched by name alone on a value receiver no source proof binds
(ADR-0036), is never proof: an `ambiguous-caller` frontier, and a reference to a function is not a call. User type guards, assertion functions and `instanceof` are not recognized: a use behind them is
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
(shown or handed on), `unmodelled`, or nothing beyond the steps. The descriptor reaches the answer unchanged. The end is
what the code does with the value its steps reach, for a read below the changed value as for the changed value itself: an
operator that meets that value (`+x.a`, `x.a == 1`, `x.a < 3`, a text template, `for`/spread of `x.a`, `in`/`instanceof`
with it as the right operand) states its `coerce`, `compare`, `iterate` or `unmodelled` end, by the same classification an
exact value gets; a value that only flows on (a declaration, an assignment, a return, an argument, a `??`), is tested or is
compared with an absence ends with nothing beyond the steps.

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
of an unconstrained number such as a `length`, is undecided. A loose equality with a literal converts an exact object or
array like a `coerce` end does: when the conversion is not known to succeed the test is undecided, so the module never
throws on any descriptor and value. A condition, an early exit or a `?.` lets the use run where its test gives its stated
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

## Flow coverage (P3, proposed)

**Invariant.** A carrier that holds the changed path ends in a use, in a next carrier, or in a frontier. Dropping it is
allowed only by a rule this section names, and each such rule says why no consumer can read the change there. P3 starts
by enforcing this, because a silent stop is the one failure an answer cannot show.

**Measured baseline** (24 corpus queries, P3.0). One silent stop: a value stored in a service member and read by
components through the injected service is never followed, because the readers of a member are searched only as
`this.member` inside the declaring class. Frontiers, by share: a value handed to a request body or an unresolved helper
(32%, requests are P5); a template event handler that passes the value to a component method (25%); signal views and
callback results (`asReadonly`, `linkedSignal`, a callback that returns the value); array methods on the changed
collection; object spreads and form writes; conditional reassignment. Not seen on response data: stores, validators,
conversions and `@let` aliases (three untracked ones in the whole corpus, none on responses), so P3 builds nothing for
stores, validators or conversions; an untracked alias that holds the change becomes a frontier.

**What a carried value is.** Every step that could replace the followed value with another object ends the chain (a
construction, a conversion, a call the reader cannot resolve, a write to the path). So the value a carrier holds is the
parsed response itself or a part of it: an array it holds is an intrinsic `Array`, an object is a plain object, and
parsing gives neither an own function member. A write to a member of a carried value (`items.map = f`, `Object.assign`
or `Object.defineProperty` with it as target) ends its chain with a frontier at the write, wherever the chain reaches
it, so a method the chain later calls on that value is the language's built-in one (a program that patches the built-in
prototypes is outside the model). Containers the reader knows (observables, signals, promises, resources) are told apart
from it by the step that produced them.

**Member readers.** A member that holds the value is read through every receiver that provably denotes the instance that
was written: `this` in the class and its subclasses, an instance the framework injects (`inject()`, a constructor
parameter the injector fills), and the component instance in its template. Candidates come from the code graph's
occurrences of the member, as the callers of a returning function do: the application expands them, the adapters read
each one's syntax from its place. An occurrence through any other receiver (a local `new S()`, a parameter of unknown
origin) is a frontier, since two instances of one class do not share a field's value; a member the graph cannot
enumerate is a frontier too. A subclass that redeclares the member, or overrides an accessor, is a frontier at that
declaration.

**Template calls.** A template expression that passes the value to a method of its component (`(click)="add(owner())"`,
`{{ label(owner()) }}`) follows it into that method's parameter, resolved on the component class or its bases, with the
guard-boundary policy of a TypeScript argument. The carrier of the method's result names the template expression by its
place in the template resource (start and end offset, callee, argument position), so two calls on one line stay apart,
and the template reader resumes that expression. An event handler's result is read by the framework (`false` cancels
the event's default action): it is a strict comparison with `false`, the use the descriptor already expresses.

**One callee table.** Which calls keep the value, project it, or bind it to a callback parameter is one table of the
TypeScript adapter, read by every step that meets a call; the scattered conditions it replaces move into it. Each row
names its receiver kind (the carried value, or a known container), the callee (a built-in method of that kind, or an
imported function whose module the reader resolves, as RxJS operators are today), the argument and callback parameter
that receive the value or an element, and the path of the result (the same value, an element, a callback's return, or
none). `reduce` binds the accumulator to the callback's return, so its element is a frontier; `flatMap` flattens one
level. A method called on the changed value itself is a use (`steps` ending in a call), already decided by P2.

**Copies.** An object spread carries the properties of its source in order: a later member the reader knows overrides
a property, a later spread it cannot read makes every following path unknown (a frontier). `Object.assign` is followed
only onto a fresh object literal target, whose result and target are the same object; any other target is a frontier.
Spreading the changed value itself is a use: an array spread iterates it (`iterate`), an object spread of `null` or
`undefined` copies nothing, which the copy's later reads cannot express, so it ends `unmodelled`.

**Conditional reassignment.** A read that the followed value and a conditional write may both reach keeps its use and
its frontier, and the use carries an untested `reassigned` guard: the value is not proven to reach it on the path that
runs, so its verdict is `review`, never `incompatible` or `admits`.

**Deduplication.** Two trails that reach the same place with different guards are both kept, keyed by their guard state
(the second may lack the guard that made the first `admits`); a carrier reached through a second link keeps that link's
attribution.

**Cost.** A workspace is prepared once for a set of hypotheses: its snapshots, sources, code graphs, framework metadata,
call sites and readers. Selecting the operation's links and serving handlers, and the fact envelope that declares the
hypothesis, belong to each hypothesis, never to the preparation. A second hypothesis on the same workspace, and every
hypothesis P4 derives from one diff, pays only its selection and its walk. Measured before P3 (P3.0): the walk is
0.1-2 s; repeated preparation is 1.5-70 s per query. The preparation is released when its holder releases it, so memory
is held for the hypotheses that use it and no longer. A caller with several hypotheses asks them in one call (`consequencesOfEach`), answered in the order asked; nothing is
held between calls, so a repository the size of the largest measured one (3.5 GB prepared) is never kept by a cache.

**Seams landed before the writers.** The prepared workspace and the per-hypothesis session as two port types; the
member-occurrence query of the session (found, unresolved, unavailable) with the receiver's provenance; the template
call carriers (into a method's parameter, and back to the template expression); the `reassigned` untested guard.

**Delivery,** each step gated by `npm run check`, the measured silent stop as the first oracle case, and the cost of the
same corpus queries before and after:

1. The invariant: member readers, guard-distinct trails, every silent drop either a named rule or a frontier,
   conditional reassignment as `review`.
2. Template calls into component methods and back; untracked aliases and bindings that hold the change end in a
   frontier.
3. The callee table and copies.
4. The prepared workspace reused across hypotheses.

## Hypotheses from a diff (P4, proposed)

A hypothesis written by hand answers "what if"; a change already made should not need one. Given a base and a head, P4
derives what the change did to each response property, from the contract both snapshots declare, and answers it with
the same evaluator a declared hypothesis uses.

**Value sets.** What a place of a payload may hold is a value set: for each JSON class, either every value of the class
or a list of literals, plus `null` and absence. Whether a property is required is read apart from whether it is
declared. A declared property holds its declared shape; an undeclared one holds every value when the object is open,
and nothing when it is closed. A property that is not required may also be absent; a required one may not, so a
required property that a closed object does not declare can hold nothing, and its place is `unknown`. A shape is a domain value: the value set of each place, the properties of an object (and whether the object is
open), the shape of array elements. A place the reader cannot state is `unknown` there, with its evidence and reason,
and nothing below it is derived.

**Derivation** (domain, pure). For each property path of the base shape, compared with the same path in the head: the
introduced values are the head's value set minus the base's, and the retired values are the base's minus the head's.
That is the whole rule; the change kinds are its names:

| Introduced (head minus base) | Change |
|---|---|
| absence | `optional` (`removed` when absence is all the head allows) |
| `null` | `nullable` |
| every value of a class the base did not allow | `{ "type": class }`, one per class |
| the values of a class the base allowed only as literals (an enumeration opened) | that class, with the base's literals named so no representative equals them |
| literals | `{ "values": { "added" } }` |

Retired literals are `values.removed`, read as P2 reads them (a strict comparison with one is `review`). A retired `null`
or a retired absence (a property made non-nullable or required) is reported as a difference the head gains, with its
place, and is not followed: a branch that tested for it may now be dead, which this phase does not search. A path where
nothing is introduced or retired derives no hypothesis; what else it may differ in is classified by P6. `renamed`, `wrapped` and `meaning` are never derived. The derived change is built
normalized, as the parser builds a declared one; the parser stays the input of a written hypothesis, and its refusal of
two `type` entries or of a literal outside a new type guards written input only. The base value set is the old
guarantee the answer states, replacing the assumed one. A delta at the response root or at an array element itself (a
path ending in `[]`) is an `unsupported-delta` frontier at its contract place until the hypothesis can address them.

**Shared schemas.** Each pair of base and head schema nodes is compared once, and its relative delta is reported under
every path that reaches it (`billing.city` and `shipping.city` both). A path that re-enters a pair it is already inside
(a recursive type) stops there with a `recursive-shape` frontier naming the place.

**Sources.** One driven port, the shapes of operations' success responses at a snapshot, with two adapters:

- OpenAPI 3.x and Swagger 2.0 documents, through the adapter's existing reference resolution (one owner). Keywords
  constrain together: `type` (a list in 3.1), `nullable` (3.0, restricting its own `type`), `enum`, `required`,
  `properties`, `additionalProperties` (open unless `false`), `items`. `allOf` is read only when every branch is an
  open object schema (no `additionalProperties: false`, since a closed branch forbids what the other branches declare)
  and the branches declare disjoint properties or the same one identically: the result is open, declares every
  branch's properties and requires every branch's required names. A keyword beside a `$ref` reads as the target only
  when the target, in the same file, states it with the same value (`type: object` beside an object schema): ignoring
  it (3.0) and combining it with the target (3.1) then agree. Any other keyword beside a `$ref` (`nullable: true` beside
  a schema that does not say it), any other `allOf`, and `oneOf`, `anyOf`, `not`, a schema in `additionalProperties`,
  are `unknown` at that place. An operation whose success responses or media types do not all
  declare the same schema (a `200` body beside a `204` without one) is `unknown` at its root.
- Spring handlers of operations no contract document declares, under Jackson's default configuration: the handler's
  return type, unwrapping `ResponseEntity<T>` and `Optional<T>`; collections and arrays are arrays of their element. A
  class is an object of its logical wire properties, merged once from public getters (`getX`, `isX` for `boolean`),
  public fields, record components and Lombok `@Data`, `@Getter` and `@Value`: `@JsonProperty` and `@JsonGetter` name a
  property, `@JsonIgnore` and `access = WRITE_ONLY` drop it, `@JsonInclude(NON_NULL)` on the class or the member turns
  `null` into absence. A primitive is never `null`; every other reference may be `null`, whatever annotation it
  carries, since an annotation does not prove what is serialized. An enumeration is a string listing its constants'
  wire names (`@JsonProperty` on a constant names it). `unknown` at their place: other `@JsonInclude` values
  (`NON_EMPTY`, `NON_DEFAULT`, `NON_ABSENT`, `CUSTOM`), `@JsonValue`, `@JsonFormat` on an enumeration, `@JsonAnyGetter`,
  `@JsonUnwrapped`, `@JsonSerialize`, `@JsonIgnoreProperties`, mixins, `Map`, `Page<T>` and any unresolved type. A
  repository that configures the mapper (a naming strategy, a default inclusion, a customizer or an `ObjectMapper` it
  builds) makes its Java shapes `unknown`.
- A declared contract document wins over the code that implements it; a declared document the reader cannot read is
  `unknown`, never replaced by the code's shape. The application decides this precedence.

**Operation identity.** A document operation is named as the route of the handler that serves it names it (equal path,
then the configured base path, through the join's matching), since a route's name excludes its base path; an operation
no route or several repositories serve is a frontier. A contract file's references are read at the same revision, and a
reference the reader cannot resolve keeps its file among the shape's sources, so the operation is never dropped.

**Answer.** One fact over the change: for each property path with a delta, the derived change (normalized, with the base
value set as the old guarantee), the base and head places in the contract as evidence, and its consequences as P2
answers them, on the head snapshot, from one prepared workspace (P3). Gained guarantees are listed, not followed. An
`unknown` shape or an unsupported delta is a frontier at its contract place. Operations the head no longer declares, or
newly declares, are listed with their place and derive no hypothesis. P6 lists all of these as classified differences.

**Cost.** Shapes are read only for operations whose contract files the change touched; each pair of schema nodes is
compared once; the consequence walks are those of the declared form, over one prepared workspace.

**Out of P4.** Java code that consumes another service's responses (only one corpus repository has it, a client of its
own server); whether the producer still fills a property; dead branches behind a gained guarantee; request payloads (P5,
which reuses value sets and their derivation with the opposite polarity: a value the server stops accepting breaks
producers).

**Seams landed before the writers.** The shape and value set types, the derived change built from a delta, the old
guarantee in the answer, the shape port, and the use case's entry that answers one hypothesis on a prepared workspace.

**Delivery.** (1) Shapes from contract documents, the derivation, the use case and the answer; oracle cases: the corpus
commit that removes a property from a published schema, plus an enumeration opened to a string, one schema reached by two
paths, an open object losing a declared property, and a recursive schema. (2) Shapes from Spring handlers, measured on the
corpus DTO styles (plain getters, records, Lombok), with negative controls: a field renamed with its wire name pinned by
`@JsonProperty` derives nothing, and a `NON_EMPTY` or `NON_DEFAULT` member is `unknown`.

## Requests (P5, proposed)

A request body is written by the frontend and read by the server, so the polarity flips: a change breaks a producer
when the server stops accepting a value that producer may write. Values the server newly accepts break nothing.

**Measured baseline** (P5.0 and the design challenge). 351 syntactic `post`/`put`/`patch` candidates in the five corpus
frontends: 255 pass an identifier, 32 an object literal, 39 `null`. Bodies are models passed through service methods,
object literals beside form values (`getRawValue()`, `form.value`), spreads of loaded entities, mapper functions, and a
wrapper that serializes its own parameter (`JSON.stringify(data)`). Estimated, not measured: presence and `null`
hypotheses on properties a producer builds deliberately reach a decisive verdict on 15-35% of producer paths; scalar,
type and enumeration hypotheses on 0-15%. So P5 starts with a measured slice, and the owner decides from its numbers
whether it grows.

**Rejection.** What a change makes a producer unable to write is a rejection: a value set (P4) of the values the base
accepted and the head does not, absence and `null` included. A written request hypothesis (`target: "request"`) states
it with its own kinds, normalized into that value set: `required` (absence), `non-nullable` (`null`),
`{ "values": { "removed": [...] } }` (literals no longer accepted, each in a class the server keeps), and
`{ "type": class }` (the other present JSON classes; absence and `null` are stated apart). The response kinds are
refused for a request with `unsupported-change`, since each states what a reader may now receive; contradictory
combinations are refused as for a response.

**Origins** (the new mechanism). The question is whether some path the producer writes can put a rejected value at the
property, so the body is followed backward to what builds it, syntax only. A declared type is never an origin. An
origin is exact (a value the source writes), approximate (a class whose values are not all known, such as a template
literal with a substitution) or a frontier with its reason. Only an exact origin can be a witness.

| Expression at the followed path | Origin |
|---|---|
| a literal; a template literal whose substitutions are literals | that value |
| a template literal with any other substitution | approximate: some string |
| an array or object literal at the end of the path | its class (the path ends there) |
| an object literal | its own writes in source order: a later definite write replaces earlier ones (a written `undefined` included); an uncertain later write (a spread whose presence is unknown, a spread of a parameter, a non-literal computed key, a getter or `__proto__`) may overwrite the earlier writes, so they stop being exact; they stay exact only past a spread proven to lack the property; no write and no uncertain member is absence |
| `a.b` | `a` at `b` followed by the rest of the path |
| `c ? a : b` | each branch, under its condition |
| `a ?? b`, `a \|\| b` | the left values that pass the operator's test, and the right only when the left can fail it; a left side whose test is undecidable keeps the uncertainty and proves nothing about the right |
| a parenthesis, `as`, `!`, `satisfies` | the operand |
| a local binding, or a name destructured from an object (`const { a } = x`, no default, rest or nested pattern, read as `x.a`) | its initializer, only when it reaches the read unchanged: no reassignment between them and, for an object, no write to it, no alias, and no call or closure it escapes to; otherwise a frontier |
| a parameter | the argument of each proven call, in that call's context; its default when the argument is omitted or `undefined` (never `null`); missing or unresolved callers are a frontier, and no caller is never "no origin"; destructuring, spread arguments, rest parameters and `arguments` are a frontier; a parameter written, aliased or handed to a call that may run before the request is serialized is `mutated`; a parameter met again on its own path is a located `recursion` frontier |
| a call through a wrapper method (the P1.5 fixpoint) | the forwarding chain the fixpoint records, followed through every wrapper method down to the `HttpClient` body, arguments bound at each hop, each call kept apart |
| `JSON.stringify(x)` without replacer or indent arguments | `x`, serialized |

Anything else ends the origin with a frontier naming its reason: `form-value`, `call-result`, `member`, `construction`,
`mutated`, `recursion`, `unresolved-callers`, `untracked`.

**Transport.** The body's serialization is a step, not an assumption: Angular's `HttpClient` serializes a plain object
or array as JSON, passes a string through, and sends `FormData`, `Blob`, `ArrayBuffer` and `HttpParams` in another
format. A string body is followed only when it is a `JSON.stringify` of a followed value; any other format is a
frontier. An interceptor registered through `withInterceptors` or `HTTP_INTERCEPTORS` that clones the request with a
`body`, a spread or a computed key, or builds a new `HttpRequest`, makes every body of the application a frontier at
that place; one that clones other fields keeps the body; one the reader cannot read is a frontier. A call that receives the request, or whose result is passed to
`next`, is followed into its resolved declaration and judged the same way; an unresolved one is a frontier. Values are selected
with JavaScript semantics and serialized only at the end (`NaN ?? 1` selects `NaN`, which the wire writes as `null`; `f ?? 1` with a function `f` selects `f`, which an
object then leaves out).
Under JSON serialization an `undefined`, a function or a symbol drops
an object property and becomes `null` in an array slot, and a non-finite number becomes `null`; a `toJSON` member, a
prototype set with `__proto__:`, or a spread of an object carrying one answers for the whole serialized object, so a
later write of a property never settles it. `JSON.stringify(x)` is the body's own serialization only along the chain that is the body
itself (bindings, parameters, conditionals, `??`); inside an object property it is a string, so a deeper path is a
frontier. Angular serializes the body when the request is subscribed, so a value handed to a call before that may be
changed by it, wherever the call sits in the statement. A hand-off ends exact provenance with `mutated` unless the
callee is a function or method the snapshot resolves and its body, while it runs, neither writes, aliases nor passes
the parameter on to code that does; a closure the callee only returns does not run then. A callee held in a field,
imported from a package or otherwise unresolved is never proven.

**Verdict per producer** (domain, pure). `incompatible` when an exact origin on a modelled branch writes a rejected wire
value, with the value, its place, the chain from the call site and the branch conditions it holds under. `admits` when
every origin of that producer is covered and every wire value it can write lies outside the rejection; it says nothing
about the rest of the request. `review` otherwise, each frontier an `unknown` finding at its place. An empty origin set
never admits. The denominator is producer x followed path: a body can be decided at `id` and unknown at `name`.

**First slice (P5.1).** Declared request hypotheses (`required`, `non-nullable`, removed literals, `{ "type": class }`)
over qualified HTTP links; a body located at a `post`, `put` or `patch` of `HttpClient` or of a wrapper (the bodies of
`request`, `fetch` and `httpResource` are `untracked`); the origin rows above; the transport step for plain objects and `JSON.stringify`; frontiers elsewhere. Gate:
petclinic's literal fields (`vet-add.component.ts` writes `id: null` beside form values) and jhipster's small account
payloads, with negative controls, zero false `incompatible`/`admits`, frontiers counted by reason, latency and peak RSS
per query against the response family. A request answer lists each producer as a complete finding with its verdict,
witness and chain, and states that the old contract accepted the rejected values.

**Server shapes.** The shape port states what an operation accepts (`requests`) so a diff derives rejections. Built for
OpenAPI documents with P6; Spring request bodies are a later slice, and until then a reader of Spring handlers states
no request and its changed operations stay one `request-unread` frontier.

- OpenAPI (built): the request schema through the existing resolver, read in the request direction: a `readOnly`
  property is never a request obligation, `writeOnly` is readable, whole-body `required` is apart from property
  `required`; media types that declare different schemas are an `unknown` body, and a body none of them describes
  accepts anything. Parameters (OpenAPI 3 and Swagger 2, operation over path item, a `$ref` resolved) are one closed
  object per location (`cookie`, `header`, `path`, `query`), each parameter a property, a path parameter always
  required; a Swagger `in: body` parameter is the body and `formData` makes it `unknown`.
- Spring `@RequestBody` (later): acceptance is read only under an evidenced Spring and Jackson version and mapper
  configuration. Jackson 2 reads `null` into a primitive as its default; Jackson 3 (Spring Boot 4) rejects it. Unknown
  properties are ignored under the documented Boot 2-4 defaults. A validation rejection is inferred only when the
  validation entry (`@Valid`/`@Validated` and groups), the cascade path and the deserialized value are established; a
  field default, a constructor, a setter, a `BindingResult` parameter or a null-handling annotation is a frontier.
  `@JsonProperty(required = true)` requires presence on the active creator property only. An enumeration rejects
  unknown text; numeric input (ordinals) and custom creators, aliases or formats are a frontier. Jackson coerces
  between scalars, so a scalar place whose present classes depend on coercion is `unknown`, and only presence and
  `null` are derived where they are exact.
- Derivation (built): the shape comparison reads the body in the request direction, with the body's own requirement as
  the root's absence; a request rejection is base acceptance minus head acceptance at a place, written as the declared
  request change P5.1 answers (`required`, `non-nullable`, removed literals, `{ "type": class }`), with the base
  acceptance as the old contract. A property the head newly declares is compared from what the base let it hold
  (anything under an open object, nothing under a closed one). A rejection the vocabulary cannot state (a class narrowed
  to listed literals, several classes kept beside a retired one) is an `unsupported-delta` frontier with the reason.

**Out of P5.** The server as a reader of what the producer sends (no Java flow reader); form models and validators (a
`form-value` frontier, counted first); websocket and brokers (no typed instance in the corpus). Spring application
events are open question 4.

**Cost.** Origins are memoized per expression, followed path and call-binding context within one prepared workspace;
recursion and unresolved continuations end in frontiers; caller lookups reuse the session's. No cross-call cache.

## Classified differences (P6, proposed)

P4 answers what a change introduces; it says nothing about a property the head adds, a bound it tightens, or a change no
consumer follows. Measured on four corpus contracts over 93 revision pairs: of 303 operations whose response data the
change altered, 195 derived nothing (117 changed only keywords a value set does not state, 39 added a property, 38
changed only non-success responses, 1 a media type), and none of the 105 altered requests was classified. P6 ([corpus probe](../../evaluations/contract-change-rules/2026-11-07-corpus-probe.md)) names every
difference with a rule from one catalog, in the taxonomy of oasdiff's breaking-change checks, so an agent reads "property
X of operation Y became nullable; rule `response-property-became-nullable`, breaking; these consumers read it unguarded"
without writing a hypothesis.

**Detection stays with the derivation.** `deriveChanges` is the one module that decides what changed at a place. Each
difference is a delta with its place: a hypothesis's own (`removed`, `introduced-absence`, `introduced-null`,
`introduced-class` with the class, `literals-added`, `literals-retired`; `undeclared` once for a property an open object
stops declaring, and for everything below it, instead of one difference per class it then admits), a retired value (`retired-absence`,
`retired-null`, `retired-class`), a property only the head declares (`added-required`, `added-optional`; nothing below
it is compared), and a keyword the value set does not state. A difference at the body root or at an array element is
listed too; a hypothesis cannot name that place, so it is also an `unsupported-delta` frontier when a reading would
derive one there:

| Keyword | Delta |
|---|---|
| an upper bound (`maximum`, `exclusiveMaximum`, `maxLength`, `maxItems`, `maxProperties`) | lowered or added: `constraint-narrowed`; raised or dropped: `constraint-widened` |
| a lower bound (`minimum`, `exclusiveMinimum`, `minLength`, `minItems`, `minProperties`) | raised or added: `constraint-narrowed`; lowered or dropped: `constraint-widened` |
| `pattern`, `format`, `multipleOf`, `uniqueItems` | added: `constraint-narrowed`; dropped: `constraint-widened`; replaced: `constraint-changed` |
| a bound whose value is not a number at either revision | `constraint-changed` |
| `default`, `deprecated`, `readOnly`, `xml` | `annotation-changed` (`readOnly` restricts what a writer sends, never what a reader receives) |
| any other keyword (`writeOnly`, `discriminator`, an extension) | an `unclassified-difference` frontier naming it, never silence |

A keyword at its default value (`uniqueItems: false`, `deprecated: false`, `readOnly: false`) is its absence. The shape
carries these keywords: the OpenAPI reader keeps every keyword it does not turn into the value set or the structure,
leaving out documentation (`description`, `summary`, `example`, `examples`, `externalDocs`, `title`, `$comment`, `$id`,
`$schema`); an `allOf` keeps the keywords of the schema that holds it and of every branch, several distinct values of
one keyword as their list. An extension (`x-`, except the `x-nullable` it models) is kept: in the corpus, generator
extensions such as one that adds `@JsonInclude(NON_NULL)` change what the wire carries. Shapes read from Spring handlers
carry none.

**The catalog classifies.** `core/domain/contracts/contract-change-rules.ts` holds one row per delta and side of the
exchange: a stable id and a level. `breaking`: a party that conforms to the old contract can fail under the new one;
`review`: it may; `compatible`: it cannot. Whether a given consumer does fail stays the verdict of its use. The
response rows follow from the direction of reading: what a response introduces can break its readers, what it retires
cannot. The request rows are their mirror: what the server stops accepting can break its writers, what it newly accepts
cannot.

| Delta | Response rule | Level |
|---|---|---|
| `removed` | `response-property-removed` | breaking |
| `undeclared` | `response-property-undeclared` | breaking |
| `introduced-absence` | `response-property-became-optional` | breaking |
| `introduced-null` | `response-property-became-nullable` | breaking |
| `introduced-class` | `response-property-type-changed` | breaking |
| `literals-added` | `response-property-enum-value-added` | review |
| `literals-retired` | `response-property-enum-value-removed` | compatible |
| `retired-absence` | `response-property-became-required` | compatible |
| `retired-null` | `response-property-became-non-nullable` | compatible |
| `retired-class` | `response-property-type-narrowed` | compatible |
| `added-required` | `response-required-property-added` | compatible |
| `added-optional` | `response-optional-property-added` | compatible |
| `constraint-narrowed` | `response-property-constraint-narrowed` | compatible |
| `constraint-widened` | `response-property-constraint-widened` | review |
| `constraint-changed` | `response-property-constraint-changed` | review |
| `annotation-changed` | `response-property-annotation-changed` | compatible |
| `errors-changed` | `response-error-changed` | review |
| `envelope-changed` | `response-success-envelope-changed` | review |

| Delta | Request body rule | Parameter rule | Level |
|---|---|---|---|
| `removed` | `request-property-removed` | `request-parameter-removed` | breaking (body), review (parameter) |
| `undeclared` | `request-property-undeclared` | `request-parameter-undeclared` | compatible |
| `introduced-absence` | `request-property-became-optional` | `request-parameter-became-optional` | compatible |
| `introduced-null` | `request-property-became-nullable` | `request-parameter-became-nullable` | compatible |
| `introduced-class` | `request-property-type-widened` | `request-parameter-type-widened` | compatible |
| `literals-added` | `request-property-enum-value-added` | `request-parameter-enum-value-added` | compatible |
| `literals-retired` | `request-property-enum-value-removed` | `request-parameter-enum-value-removed` | breaking |
| `retired-absence` | `request-property-became-required` | `request-parameter-became-required` | breaking |
| `retired-null` | `request-property-became-non-nullable` | `request-parameter-became-non-nullable` | breaking |
| `retired-class` | `request-property-type-narrowed` | `request-parameter-type-narrowed` | breaking |
| `added-required` | `request-required-property-added` | `request-required-parameter-added` | breaking |
| `added-optional` | `request-optional-property-added` | `request-optional-parameter-added` | compatible |
| `constraint-narrowed` | `request-property-constraint-narrowed` | `request-parameter-constraint-narrowed` | breaking |
| `constraint-widened` | `request-property-constraint-widened` | `request-parameter-constraint-widened` | compatible |
| `constraint-changed` | `request-property-constraint-changed` | `request-parameter-constraint-changed` | review |
| `annotation-changed` | `request-property-annotation-changed` | `request-parameter-annotation-changed` | review |

A body property that disappears from a closed schema is no longer accepted; a parameter the contract stops declaring is
`review`, since a contract does not say whether a server rejects a parameter it does not declare. The body's own place
is the property `""`. A request body difference the server's rejection answers (a retired value, or a property added where the base
accepted more) derives a request hypothesis the producer evaluator of P5.1 answers, naming its rules. An optional
property an open base object newly declares is compatible, as in oasdiff, and still derives the hypothesis of the values
the head rejects there, which each producer's verdict settles; a parameter difference is
listed and not followed, since no producer reader locates parameters.

An operation only the head declares is `operation-added` (compatible); one only the base declares is
`operation-removed` (breaking). The rows are typed as one per delta, so a delta without a rule does not compile. Rule
ids are part of the answer and change with the producer version (ADR-0024); no fact that holds them is stored.

**Fail closed.** The body shape is not all an operation exchanges. The OpenAPI reader states three digests per
operation, with the digester the `impact` family already uses (one owner, documentation left out, references
followed): the request without the schemas its body and parameter shapes read (media types, parameter serialization,
consumed media, parameters in the order of their location and name), the non-success responses, and the success
responses without their schemas (status codes, media types, headers). A changed operation whose non-success responses
differ is `errors-changed`; one whose success responses differ beyond their schemas is `envelope-changed`; neither is
followed, since no consumer reader follows error handling or headers. The request is compared through the reader's
request (body and parameters, above); a request whose digest differs while that comparison finds nothing (a consumed
media type, a parameter's `style`) is an `unclassified-difference` frontier at the operation. A reader that states no
request (Spring handlers) leaves the request of its changed operations unread: one `request-unread` frontier
(`no-extractor`) for the whole change, with the place of each, rather than one marker per operation. The request of an
operation is taken from the reader whose response shape is held for it, never combined from two readers. A refactor that
keeps every value set and keyword (an `allOf` split, a schema moved or renamed behind a reference) reports nothing, in
the request as in the response.

**Answer.** The derivation section lists every difference once, in the order of the operations (each operation's own
first, then its properties'), with its rule id, level, side of the exchange (`operation`, `response`, `request` or
`parameter`, whose property is `<location>.<name>` and below), operation,
property, delta, the class or keyword it names with the keyword's value at each revision, and the operation's contract
place at each revision that declares it. It replaces the separate lists of gained guarantees and of added and removed
operations. A derived answer's `derivedFrom` names the rules of the differences its hypothesis answers; the other
differences are listed and not followed. A derivation frontier on the request side names its side (`target`).

**Ownership.** `impact` keeps its digest comparison: it answers which code a change reaches, and the consequences family
is the one owner of what the difference means.

**Out of P6 so far.** Request bodies read from Spring handlers (one `request-unread` frontier), Spring Bean Validation
annotations and Spring response headers or status codes, consumed media types, security schemes, callbacks.

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
elements, once. F0 had no MCP, CLI or protocol surface; the family is exposed on every surface by
[RFC-0023](0023-consequences-surfaces.md) under [ADR-0033](../adr/0033-contract-consequences-as-one-query-family.md),
as `ye_ast_contract_consequences` ([ADR-0034](../adr/0034-name-contract-consequences-explicitly.md)).

## Ownership

| Layer | Owns |
|---|---|
| `core/domain/contracts` | hypothesis, access path, path rewrites, value sets, change normalization, guard and verdict rules, payload shapes, the hypotheses and differences a pair of them derives, and the rule catalog that classifies the differences |
| `core/domain/languages` | the step semantics and prototype table of a consumer language (JavaScript for both adapters, from P2) |
| `core/ports` | the driven port for flow steps and uses, the driving query family |
| `core/application/contracts` | the worklist over chains, frontier accounting, the fact |
| `core/adapters/typescript` | flow steps in classes and functions, router resolvers and component inputs |
| `core/adapters/angular-compiler` | template uses, guards, aliases and child bindings |
| `core/adapters/openapi` | payload shapes of operations from contract documents (P4) |
| `core/adapters/spring` | payload shapes of operations from handler return types (P4) |

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
3. A flow step that converts the value (`new Date(x)`, `Number(x)`) ends the chain, so the JSON classes always describe
   the value at the use. P3 keeps it so: no conversion reached response data in the P3.0 baseline.
4. Spring application events (P5.2). Both ends are Java in the same repository: the publisher builds the event,
   the listener reads it, and the corpus has two repositories with them (shopizer, ThingsBoard). Following what a
   listener does with a field needs a Java flow reader, which does not exist. Recommended: defer until a Java flow reader
   exists for another reason; the cheap alternative (each listener of a changed event class as one `review`, linking
   same-repository events) identifies candidate listeners under declared dispatch evidence, with unresolved
   dispatch and conditions explicit; it does not establish field consumption or compatibility.
