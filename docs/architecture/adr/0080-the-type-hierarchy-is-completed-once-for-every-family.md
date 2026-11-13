# ADR-0080: The type hierarchy is completed once, at the reading, for every family

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0045](0045-one-assembly-line-for-the-snapshot-reading.md) decision 12,
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [ADR-0064](0064-a-supertype-outside-the-repository-redefines-no-java-name.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md) unit U2,
  [RFC-0003](../rfc/0003-codegraph-integration.md), [RFC-0024](../rfc/0024-receiver-typed-settlement.md)

**In short:** the index leaves some supertypes of a type as an unresolved reference with no `extends` or `implements`
edge. Every family read that gap as "this type has no supertype" and answered `complete` without the dependents that
arrive through the supertype. The gap is now closed in one place: when a reading is opened, the language pack places
each such supertype with its own exact name resolution, and every family reads the same completed hierarchy. A
supertype nobody places leaves a cut.

## Context

The index writes a supertype it cannot resolve as an unresolved reference of kind `extends` or `implements`. It never
resolves a supertype written with type arguments, since it keeps them in the name (`Repo<String>`). Observed on main
before this record, with `class NameRepo implements Repo<String>` and a caller holding a `Repo<String>`:

- `callers` of `NameRepo.find` answered `complete` with no caller and no cut; the control without type arguments was
  right;
- `impact` of a change to that method missed the same caller;
- `importers` of the interface's file did not list the implementing file as a user;
- `callers` of a generic superclass's constructor missed the subclass constructor that chains to it.

Eleven places read the hierarchy from the index (the navigation, the call binder, the reverse calls, the declaration
uses, the implemented contracts, the trace walk, the contract consumers). A first fix patched two of them and left the
others wrong, which is why the gap is closed below them instead.

A gap of the index is never proof of absence. The principle this record applies is the one the supplied constructors
already follow: the language pack binds exactly (names, imports, packages), the application expands.

## Decision

1. **The language pack answers a type's written supertypes.** `ImportOrigins.declaredSupertypes` is optional, as
   `implicitChains` is: per type declaration it answers each supertype its `extends` and `implements` clauses write, in
   source order, by the name written without type arguments. An entry is `placed` at a repository declaration, `outside`
   by its qualified name where the name is proven to bind a type outside the repository, or `unknown`. A name is never
   placed by its simple name alone. A pack that implements none declares the capability absent (ADR-0045 decision 12).
2. **The hierarchy is completed once per reading.** `BaseReadings.open` builds the reading over a reader that adds one
   `extends` or `implements` edge per placed supertype, at the reference's place and in the index's order, and no longer
   lists that reference as unresolved. Every stage of the reading, and every family, reads that reader
   (`reading.store`); no consumer of the hierarchy is edited. The synthesized edge is as certain as the pack's proof.
3. **The signal decides the cost.** The completion is asked only for the unresolved supertype references of files whose
   pack offers the capability. Without one, the reader is the index's own and every answer keeps its bytes.
4. **An unplaced supertype is a cut, never a missing supertype.** Where the pack answers `unknown`, `callers`, `impact`
   and `importers` carry a `relation-unread` cut, one per type, on every answer that reached the type, a member of it or
   a type below it. A supertype proven outside the repository leaves the answer as it was.
5. **`BaseReadings.of` stays for a family that reads no hierarchy** (`outline`). A family that reads supertypes, owners
   or dispatch opens its reading with `open`.

## Units

- **U1 (with this record):** decisions 1 to 5 for the Java pack, with the signal narrowed to references the index keeps
  with their type arguments. Byte-identical answers on sources that write none.
- **U2:** the signal covers every unresolved supertype reference. Observed on main: `class Qualified implements
  other.Repo` (a qualified name, no type arguments) loses its caller the same way. The narrowing of U1 exists because an
  `unknown` for every unresolved supertype of a repository with wildcard imports could add many cuts; U2 lands with the
  measured number of `relation-unread` cuts on the corpus, and a pack proof is improved before a cut is hidden. U2 also
  covers the direction below: an answer that reached a type whose name an unplaced reference writes carries a cut, and
  `importers` reads that name without its type arguments.
  Landed: the completion asks the pack for every unresolved reference of kind `extends` or `implements`. The Java pack
  proves `outside` a simple name that `java.lang`, the on-demand imports or an outside supertype of a type around the
  clause offer where no declaration of the repository can bind it: by the one listed platform package that offers it,
  else the one package the sources do not declare, and without a qualified name (now optional on `outside`) where
  several such packages, or a member type of that outside supertype, may be it. An on-demand import of a type, or a type
  around the clause whose supertype the repository declares more than once, leaves it `unknown`. A written name binds at
  compile time, so the pack's answer needs only every source read: a dynamic proxy or a call-rewriting annotation no
  longer leaves every supertype of the repository `unknown`, and a source the reader cannot parse still does. The
  unresolved-name matching of `callers`, `impact` (`name-only`, `removed-declaration`) and `importers` reads a supertype
  reference by its name without type arguments, in every language. Trace no longer reads a method of the same name in a
  type below as a possible override when the pack proves the supertype methods it implements or overrides
  (`implementedDeclarations`) without the called one: an overload of another parameter type is no `dispatch` cut, and
  an `unknown` answer keeps it one.
- **U3:** the TypeScript pack answers `declaredSupertypes`. Observed on main: `class NameRepo implements Repo<string>`
  lost its caller through a `Repo<string>` receiver with `complete`. Landed: every heritage entry of a class or
  interface is bound by the pack's own heritage proof (the binder's lexical bindings, the file's type scopes, imports
  through module resolution, re-exports, namespace imports and constants). It is `placed` at the one named class or
  interface declaration it binds, `outside` as the global name of a library type (`Error`) or `<package>#<export>`
  (`lib#OnInit`), and `unknown` for a call, a class expression, a type literal, an unbound name, a global the snapshot
  declares, and a name the language merges from several declarations.
- **U4:** a Java enum constant with a body is a type below its enum. Observed on main: a method overridden in a constant
  body is reached, and the callers of the enum's method are not.
  Landed: the completion also asks `declaredSupertypes` for every member of a bodied kind (`EDGE_POLICY.bodiedMemberKinds`,
  the index's `enum_member`) that holds a declaration; a member that holds nothing, as every TypeScript enum member and
  every Java constant without a body, is never asked. The Java pack answers a constant with a class body by its enum,
  which the language makes the body's superclass (JLS 8.9.1), from the constant's own file, so a source the reader does
  not read elsewhere leaves it placed. A placed body reads, in the completed reader, as a type of
  `EDGE_POLICY.bodiedMemberType` (`class`) with an `extends` edge to its enum at its own place, so its methods are
  members that override the enum's in every family that opens its reading; a body the pack does not place is a
  `relation-unread` cut led by the constant. `outline` reads the index's kinds. `trace` is unchanged: a receiver of an
  enum type already names no method, so a call through it stays a `receiver-unproven` cut that names the body's method.

## Alternatives considered

- **Bridge each consumer from `implementedDeclarations`.** Dropped: it fixed `callers` and `impact` for methods without
  type variables and left type-variable parameters, `importers` and constructors wrong; each new consumer would repeat
  the bridge.
- **Resolve the name inside the codegraph adapter by stripping the type arguments.** Dropped: the adapter has no scoping
  rules, so it would place by simple name and link a homonym of another package.
- **Read every unresolved supertype as a cut.** Dropped: it marks every type that implements a library interface and
  destroys the signal.

## Consequences

- One owner for "what is above a type": the reading. A second completion, or a consumer that reads the index's own
  reader after `open`, is a defect.
- `open` is asynchronous, so the families await the reading before any stage; `of` stays synchronous.
- The member answers `outside` supertypes by qualified name, which ADR-0079 unit U2 consumes.
- Cost: one unresolved-reference read over the files of the packs that offer the capability, and one pack question per
  type with such a reference.
