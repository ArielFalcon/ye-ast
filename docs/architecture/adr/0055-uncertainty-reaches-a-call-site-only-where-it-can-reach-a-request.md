# ADR-0055: Uncertainty becomes an unresolved call site only where it can reach a request

- Status: Accepted, 2026-11-12, owner
- Decision source: Owner, 2026-11-12: "Corrígelo todo de forma planificada y con calidad, que se integre bien a las reglas del proyecto y que resuelvan los problemas detectados para mejorar la calidad multi repo"
- Related: ADR-0013, ADR-0045, ADR-0049, ADR-0050, ADR-0051, ADR-0052, RFC-0007, RFC-0013

## Context

On a real Angular workspace, 680 call sites were unresolved for about 29 requests, and 536 of them carried
`dispatch-disagreement`. Almost all came from reading a field the framework fills with a value cell
(`signal(...)`, `computed(...)`, `input()`, `toSignal(...)`, an alias of one): the call reader answered "ambiguous" for
any member that is a property with a non-function initializer, and the gap spread to every transitive caller although no
request can run when such a field is read. The noise hid the requests, and a gap named only its first-hop call, never
the place that was undecided. In the trace, a call on a value constructed from a package export, or on a call result
whose declared type is a library or package type, was cut against homonyms of the repository instead of being a leaf.

## Decision

1. The vocabulary of what reading or calling a stored value runs belongs to the framework that defines it. The
   framework plugin contract gains `cells`: for an export of a package (module and exported path) it answers `nothing`
   (reading the field runs no repository code) or `callback` with the index of the argument whose function runs on read,
   and names the members of a cell that return a cell running the same. The list is closed and evidence-backed
   (ADR-0013). The Angular plugin lists `signal`, `input`, `input.required`, `model`, `model.required`, `viewChild`,
   `viewChild.required`, `viewChildren`, `contentChild`, `contentChild.required`, `contentChildren` and `toSignal`
   (`rxjs-interop`) as `nothing`, `computed` and `linkedSignal` as `callback` of argument 0, and `asReadonly` as a
   projection. `resource`, `httpResource` and `rxResource` are not listed. The TypeScript adapter holds no framework
   name; removing the plugin removes the behavior.
2. `calleeOf` consults it before answering a gap, for a field read through `this`, an injected receiver or an inherited
   field, when the field has exactly one declaration with an initializer, nothing assigns it in its class, a base class
   or a subclass, no subclass declares it again or takes it as a constructor parameter property, and the initializer's
   root is an import of a package a manifest declares that nothing in the file rebinds. A `nothing` cell answers that the
   read runs no repository code; a `callback` cell answers the callback's own declaration (ADR-0049), so a request the
   callback issues reaches every caller; a projection of a cell answers what the cell answers; an alias field
   (`x = this.dep.f`, `x = inject(P).f`) answers what its target member answers, and an alias cycle stays a gap. The
   owner's contract grows; no consumer adds a condition (ADR-0051 decision 7).
3. Unchanged gaps: a function-typed field the code reassigns, a field initialized by `inject(...)`, an overload set,
   an override, and an abstract or uninitialized field typed as a signal. The last is an owner decision still pending:
   structural typing lets a subclass supply any callable there, so it stays an undecided dispatch.
4. A gap a caller inherits names, after its own call, the place of the nearest declaration below the callee that holds
   the cause as its own gap (the field read that is undecided), so an entry is actionable without opening the
   intermediate files. Gaps inside a cycle and `recursive` gaps keep their single place.
5. Trace: a member call on a value constructed from a package export is an import leaf, as one constructed from a
   library global already is; a member call on a call result whose declaration states a library or package type is a
   leaf under that type. Both stay a cut when the repository writes over the root. A return type the declared types do
   not place stays a cut; no built-in table of library methods is added.

## Consequences

- Reading a signal-family field no longer makes a call site unresolved at any depth, while a request in a `computed`
  callback is still found at its callers and an undecided dispatch is never hidden.
- The evidence of an inherited gap carries one more place; clients that print evidence list it.
- The contract gains an optional plugin field and an optional parameter of the call-site readers; no schema changes.
- `assignedBelow` now also treats a subclass constructor parameter property as taking the member, which makes the
  previously existing external-factory escape stricter in that one case.
