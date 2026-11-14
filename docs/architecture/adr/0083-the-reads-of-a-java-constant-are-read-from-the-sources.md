# ADR-0083: The reads of a Java constant are read from the sources

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0017](0017-owner-of-a-member-expands-only-whole-type-edges.md),
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md),
  [RFC-0007](../rfc/0007-extension-model.md), [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** `callers` of a Java constant, and `impact` of a change to it, listed only the uses inside the constant's
own file and answered `complete`. The index keeps a read of `Type.CONSTANT` as a reference to the type and loses the
member's name, and the walk does not expand a type reached through a member into its users. The Java language pack now
reads each read of a constant from the sources and relates the declaration that writes it to the constant; where the
sources cannot tell which field a name denotes, the place is a cut.

## Context

Reproduced on a fixture with a class that declares `public static final String CACHE`:

- the index records a read `Store.CACHE` written in another file as `references` from the reading method to the class
  `Store`. It records no edge to the constant and no unresolved reference named `CACHE`; for an argument of an
  annotation it records nothing at all. Only an unqualified use in the constant's own file reaches the constant;
- from the constant the walk reaches its class through a member, which follows only whole-type rows (ADR-0017). That
  decision rests on a premise, "whoever uses a member is still reached through its own call edge", which holds for a
  Java method and does not hold for a Java constant;
- the relations a language pack reads go from a type to a type, the edge policy follows a `references` relation only
  between types, and the pack's unresolved uses cut only the types the walk reached. So nothing pairs the read with
  the constant, and not even a `name-only` cut appears.

Of the fields of a Java type only a constant is a declaration `callers` can be asked for (the index's kind `constant`:
a `static final` field of a class). An instance field, a static field that is not final, an enum constant and a
constant of an interface answer an explicit unknown symbol, and a change to one seeds its type. Those are stated
answers; the constant is the one that gives a false `complete`.

## Decision

1. **The pack reads the reads.** For each place the Java sources read a field by name, the language pack decides, with
   the scoping it already applies to names in expressions (ADR-0062), whether the name denotes a constant the
   repository declares: `Type.C`, `pkg.Type.C`, a name a static import brings in, a name a subclass inherits, a typed
   receiver `value.C` where the receiver's type is settled. A proven read is a `references` relation from the
   declaration that writes it to the constant, with its line.
2. **A relation of a pack may end at a constant.** The relations a language pack reads (RFC-0007 row B4) went from a
   type to a type. One may now go from the declaration that writes a read to a constant. The shape of a relation does
   not change; the edge policy follows `references` into a constant from the declarations that hold code, and the
   relation's source is placed at that declaration, not at its type.
3. **Unknown is a cut.** Where the sources do not show which field the name denotes (a supertype outside them, a
   receiver whose type is not settled, a name a library's static import may also bring in), the pack reports an
   unresolved use naming the constant, and a reached constant pairs with it as a `name-only` cut at the place. Never a
   dropped dependent and never a guessed one.
4. **ADR-0017 stands.** A type reached through one of its members still expands only through whole-type rows. This
   decision restores the premise that decision rests on, for the one member kind it did not hold for.
5. **Where the index records nothing, the pack reads the type too.** A type an annotation's argument writes by its
   simple name (`@Mark(Store.CACHE)`) is a use of that type, read by the pack, since the index records nothing for the
   arguments of an annotation.
6. **Only constants.** The fields `callers` cannot be asked for keep their stated answers. Making them declarations of
   their own is a separate decision.

## Alternatives considered

- **Expand the constant's type as a whole.** Dropped: every user of the type becomes a dependent of each of its
  constants. On the fixture, three of the seven dependents it adds for one constant, and all seven for a private one,
  do not read it, and four real reads are still missed.
- **A cut at every reference to the type from another file.** Dropped: fourteen cut places on the fixture, half of
  them at reads that do not touch the constant. The marker would destroy the signal.
- **Extend the reader of written uses of TypeScript to Java.** Dropped: it starts from an import edge that binds the
  name, which in Java binds the type, and it would be a second copy of the scoping the Java pack already owns.

## Consequences

- The edge policy, which every language shares, gains one row. A language whose pack reports no relation into a
  constant answers as before.
- A class that reads a repository constant under conditions the sources cannot settle gains a `name-only` cut. The
  corpus gate measures how many (ADR-0039).
- The index's own edge from an unqualified use in the constant's file and the pack's relation for the same place name
  one dependent, once.
