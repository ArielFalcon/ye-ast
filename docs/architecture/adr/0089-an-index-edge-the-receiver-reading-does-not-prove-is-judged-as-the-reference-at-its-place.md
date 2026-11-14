# ADR-0089: An index edge the receiver reading does not prove is judged as the reference at its place

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0062](0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md),
  [ADR-0079](0079-an-unresolved-reference-is-attributed-by-its-receivers-type.md),
  [ADR-0084](0084-a-calls-argument-count-excludes-the-homonyms-that-cannot-take-it.md),
  [ADR-0087](0087-a-java-call-the-reading-cannot-read-is-unproven-and-a-call-on-super-runs-without-dispatch.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** the index resolves some calls by a name alone, and `callers` and `impact` follow such an edge unless the
receiver reading names another method. When the reading answers that the receiver's member is not proven, the edge is
still followed, with no cut, toward a declaration the language may not bind, and the declaration the call really runs
answers `complete` without its caller. `trace` already cuts the same call. The reverse families now judge such an edge as
ADR-0079 judges an unresolved reference at its place: by the candidates the reading offers, or, with none, by name.

## Context

Reproduced on `callers`, each `complete` on both sides:

| The call | What the index binds | What the language binds |
|---|---|---|
| `l.forEach(item -> item.save())` beside a field `Other item` | `Other.save` | the `save` of the list's element type |
| `for (var item : l) item.save()` beside the same field | `Other.save` | the same |
| `case Store item -> item.save()` beside the same field | `Other.save` | `Store.save` |

`callers` of the method the language binds lists no caller; `callers` of `Other.save` lists all three. The port already
states the contract the reverse families do not honour: an `unproven` answer means "no index edge proves a step"
(`import-origins.port.ts`, `ReceiverMethod`).

Measured over every index-resolved call edge of two Java repositories of the corpus:

| | The largest back end | A monolith |
|---|---|---|
| Edges judged | 12,977 | 428 |
| The reading names a method | 10,951 | 319 |
| `unproven` without candidates, edge kept | 1,547 | 87 |
| of those, with another declaration of the name the call can take | 1,072 | 29 |
| pairs of such an edge and such a declaration | 13,891 | 64 |

Why the reading proves nothing for the 1,072: the receiver has a declared repository type whose hierarchy is open
through a supertype outside the repository (938, 717 of them through a platform type alone); a repository type the
strict reading does not resolve (105); a variable that writes no type, as a lambda parameter does (17); other (12). A
cut for each of the 13,891 pairs would mark most answers of the repository, and a mark on every answer says nothing.

## Decision

1. **The verdict of an index-resolved call edge in a nominal language, by the reading of its receiver.**

   | The reading | The edge | Cuts |
   |---|---|---|
   | A method | Kept, or moved to that method | None (unchanged) |
   | An outside receiver that is exact, or under which the target cannot run | Not followed | None (unchanged, ADR-0087) |
   | `unproven` with candidates, the target among them | Kept | `hidden-caller` at the call toward each other reached candidate, unless the answer already lists the caller as its dependent |
   | `unproven` with candidates, the target not among them | Not followed: the candidates are every repository declaration the call can run. Kept when a candidate is a declaration of the target's own file and name, which an answer names as it names the target | `hidden-caller` at the call toward each reached candidate (ADR-0079 decision 3), unless the edge is kept and the answer already lists the caller |
   | `unproven` without candidates, or an outside receiver under which the target may run | Kept | `name-only` at the call toward each other reached declaration of the name, of a kind the call can reach, that accepts its argument count (ADR-0084) and, for an outside receiver, may run under it (ADR-0079 decision 5), unless the answer already lists the caller |
   | A generated or supplied member, `unknown`, a capability the pack declares absent | Kept | None (unchanged) |

2. **Recovery comes before marks.** The rows that add cuts are delivered after the readings below, so a cut marks only
   what the sources do not settle:
   - a repository type the strict reading fails to resolve although the sources name it is a defect of the reading,
     fixed as one;
   - a receiver declared with a repository type whose hierarchy is open only through supertypes outside the repository
     answers `unproven` with candidates: the declarations of the name at the call's argument count in the repository
     types at, above and below that type. The gap leaves the selection among them unproven, and it adds no repository
     declaration, under the assumption that no type outside the repository is a subtype of a repository type. A class
     and an interface answer alike; where no repository type at, above or below the receiver's type declares the name
     at that argument count and one outside type alone leaves the hierarchy open, the call binds a member of that type
     and the reading answers an outside receiver of it;
   - a variable whose type only a library signature gives (a lambda parameter, a `var` over a library call) waits for
     library signatures (ADR-0063, ADR-0073).
3. **The bound.** A dependent leaves an answer only by the second and the fourth rows, each a proof that the call cannot
   run the target. Every other change adds a cut. The number of edges each added cut marks is reported at the corpus gate of
   the unit that delivers it, and a unit whose marks the recoveries of decision 2 would remove is not integrated before
   them.
4. **`trace` is unchanged.** It already cuts a call the reading does not prove.

## Not decided here

- A reading that proves nothing because a source of the repository is not parsed, where every call of the repository
  would be marked: the pack marks such an answer as one that says nothing of the call in particular, and its edges
  keep today's verdict until that state is measured.
- A structural language: its edges are judged by another rule (`name-match`), and whether the same hole exists there is
  not measured.
- An edge kept toward a homonym when the reading answers a generated member: it lists a caller that does not call the
  target, and hides none.

## Alternatives considered

- **A cut toward every declaration of the name for every edge the reading does not prove.** Dropped: 13,891 pairs on
  one repository, most of them for a receiver whose declared type already bounds what the call can run.
- **Drop the edge the reading does not prove and cut.** Dropped: the index's target is the declaration the receiver's
  declared type names in most measured cases, so the answer would lose right dependents and gain the same marks.
- **Leave the edge as it is.** Dropped: a `complete` answer without a caller is the one answer the engine must not
  give.

## Consequences

- The candidates of an `unproven` answer are the repository declarations the call can run, also when a supertype
  outside the repository leaves the hierarchy open; the port's description of `ReceiverMethod` says so.
- A `callers` or `impact` answer that reaches a declaration whose name an unproven call writes is `partial` where it
  was `complete`.
- Cost: one read of the edges into the declarations of a reached name per walk round, the read that moves an edge to
  the method its reading names already makes.
