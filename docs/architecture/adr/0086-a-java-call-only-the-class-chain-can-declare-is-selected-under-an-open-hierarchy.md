# ADR-0086: A Java call only the class chain can declare is selected under an open hierarchy

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md),
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [ADR-0073](0073-a-classpath-the-host-declares-is-a-library-signature-source.md),
  [RFC-0013](../rfc/0013-trace-and-patterns.md)

**In short:** a Java type with a supertype the sources do not declare has an open hierarchy, and every call on a
receiver of that type answers `unproven`: the unread supertype could declare the member the call binds to. For two
written forms the language rules out that member whatever the supertype declares, and the call is selected among the
declarations the sources hold, as it is under a closed hierarchy.

## Context

Measured on the corpus: of the 144 Java `receiver-unproven` cuts of `trace`, 11 are calls whose receiver's type has an
open hierarchy and whose member the sources declare in the receiver's own class chain: 8 write no argument (a getter of
an entity that implements a platform interface) and 3 are static calls through a type name whose only unread supertypes
are interfaces. The selection gives up on the open hierarchy before it looks at the declarations.

The Java Language Specification settles both without the unread supertype:

- A method of a class overrides or hides every inherited method of the same signature (JLS 8.4.8), and a class method
  takes precedence over an interface method of that signature. A call that writes no argument is applicable, before
  variable arity is considered, only to methods of the name that declare no parameter (JLS 15.12.2.2): one signature.
- A class does not inherit the static methods of its superinterfaces (JLS 8.4.8), and a method invoked through a type
  name is static (JLS 15.12.3).

## Decision

1. **A call without arguments.** A call that writes no argument on a receiver of a repository class is selected among
   the declarations of the name without parameters when one of them is declared by a class of the receiver's class
   chain: the nearest one up the chain is the declaration the call binds to. An unread supertype can only declare the
   same signature, which that declaration overrides.
2. **A static call through a type name.** A call whose receiver is the name of a repository class whose class chain the
   sources declare whole, so that every unread supertype is an interface, is selected among the declarations of the
   class chain as under a closed hierarchy. The declarations of interfaces are no candidates of it.
3. **What stays unproven.** A call with arguments on an open hierarchy: an unread supertype may declare an overload
   more specific than every declaration the sources hold. A call whose only declarations of the name belong to
   interfaces. A receiver that is an interface. A call without a written receiver whose searched type the reading does
   not already settle: an unread supertype of an enclosing type may declare the name. Every guard of the selection under a closed hierarchy holds unchanged:
   a private member outside its class, a member whose reach from the call's file is unknown, a static member reached
   through an instance or the reverse.
4. **The selection is the binding, not what runs.** The declarations below the receiver's type that override the
   selected one are read as for every other selected call; a call that dispatch does not settle is a `dispatch` cut.
5. **One chain for every family.** The rule lives in the selection the receiver reading owns, so `trace`, `callers`,
   `impact` and the families that read `receiverMethods` bind the call the same way (ADR-0041).
6. **The bound.** A call selected before this decision is selected the same way. With every hierarchy closed, every
   answer is byte-identical.

## Alternatives considered

- **Wait for the declared classpath (ADR-0073).** Dropped as the only answer: a host that declares no jars keeps these
  cuts, and the sources already settle them.
- **Select any call whose arity one declaration of the class chain takes.** Dropped: with one argument or more, an
  unread supertype may declare an overload of that arity with more specific parameter types (decision 3).
- **Assume an unread supertype declares no member of the name.** Dropped: it is false for the common case of a
  framework base class, and a wrong binding is a false `complete`.

## Consequences

- The Java selection reads the class chain before it gives up on an open hierarchy, for these two forms only.
- A cut of these forms either becomes a step or, where an overrider exists below, a `dispatch` cut with its candidates.
