# ADR-0097: An import change seeds the declarations that use the names it binds

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner, 2026-11-14, on the transversal fix plan of evaluation run 20261114T125655Z-c68fc8, decision D1
  (name-scoped import seeding, fail-closed to file-wide when names cannot be proven): "Acepto" (I accept), asked to
  implement it with Sonnet agents.
- Related: [ADR-0043](0043-a-change-seeds-only-where-its-tokens-differ.md) decision 12 and follow-up F4,
  [ADR-0045](0045-one-assembly-line-for-the-snapshot-reading.md) (the B11 tokens stage),
  [ADR-0082](0082-a-use-in-a-files-top-level-statements-names-the-file-as-its-dependent.md) decision 6,
  [RFC-0010](../rfc/0010-impact-queries.md) "Seeds"

**In short:** A changed import line no longer seeds every top-level declaration of its file. It seeds the declarations
whose own lines write a name the changed imports bind or unbind. What the name rule cannot bound (a side-effect
import, a wildcard, a re-export, a top-level statement that uses the name, a change that binds no different name) keeps
the file-wide seeds, as before. This is the measurement I1 of ADR-0043, answered by evidence.

## Context

ADR-0043 decision 12 kept file-wide seeding for added or removed imports and left it to measurement I1: "Outcome (c) > 0
on any input: a new ADR for name-scoped import seeding, with fixtures for the cases that must keep file-wide seeding (a
side-effect import, a Java wildcard or static import, a re-export, a name used only in a type position or a decorator)
and gate `impact:-`". No I1 outcome was recorded. The MCP evaluation of 2026-11-14 is that evidence:

| Case | What the commit changed outside a declaration | Seeds, entrypoints reached |
|---|---|---|
| a user service, `impact` | one import in each of two model classes | two `top-level` class seeds; 9 entrypoints, 72 symbols; 1 is true, 5 routes and 3 event publishers are false |
| an API application, `impact` | one import in a service class | 3 sibling declarations seeded `top-level`; 3 entrypoints and 1 callback false |
| a security utility, `impact` | one import | 2 name-only cuts caused by the class seed; `partial` instead of `complete` |

Cause (`seeds.ts`): a touched line outside every top-level span, or a removal that falls outside every symbol, makes each
top-level symbol a seed with basis `top-level`; the walk then expands a class seed over every typed reference to it. The
class did not change; only the name an import binds did, so only the code that writes that name can behave differently.

## Decision

1. **A name-scoped import seed.** A hunk whose tokens all lie inside import declarations, on both sides, seeds the
   declarations whose own lines hold a token spelled as a name the file's imports bind differently at the head than at
   the base, innermost first, with basis `lines`. A name is bound differently when the set of sources it binds (module
   and imported name in TypeScript, the qualified name in Java) is not the same on both sides; an added import is a name
   bound at the head only, a removed one at the base only (its users are read at the head). A requested line range has
   no base: it names what the import declarations on its lines bind.
2. **What stays file-wide.** The file's top-level declarations still seed with basis `top-level` when any of these holds:
   - a hunk touches a line that is not an import declaration, as before;
   - an import declaration that binds no name a reading can list (a side-effect import, a Java wildcard or static
     on-demand import, a re-export) is added or removed;
   - the names bound differently are none (a reordered, re-quoted or type-only change) or no declaration of the file
     writes them;
   - a token spelled as one of the names stands outside every top-level declaration and outside imports (a use in a
     top-level statement, ADR-0082 decision 6);
   - the language gives import order meaning (`importOrder: significant`) and imports both sides hold keep a different
     relative order;
   - a side of the file is not read by the tokens stage, a file is added or deleted, or the hunk has a base side the base
     reading does not hold (ADR-0043 decision 4).
3. **Where it lives.** The binding of each import declaration is a fact of the language pack's token reading
   (`ImportDeclarationRange.binds`, absent when the pack cannot list it), so the domain rule in `core/domain/change`
   names no language. The rule is `selectSeeds`'s; `selectRoots` hands it the readings the use case already holds (the
   settling of hunks for a change, the narrowing of requested ranges for `callers` and `trace`).
4. **Nothing else moves.** `Seed.basis` keeps its values; a hunk inside a declaration, a resource, a removal inside a
   declaration and a changed top-level statement seed as they did.

## Consequences

- `impact` and a `callers`/`trace` range over import lines lose seeds, symbols and entrypoints; an answer whose only
  cause of `partial` was a class seed that nothing wrote turns `complete`. The gate declares `--expect impact:-`.
- RFC-0010 "Seeds" row 2 reads "its top-level symbols" for top-level statements and the cases of decision 2, and the
  users of the bound names for an import.
- A name written only in a decorator or a type position seeds its user, because the rule reads tokens, not references.
  A token spelled like the name that is not a use (a property of that name) seeds one declaration too many, never one
  too few.
- The cached token reading changes shape; its cache key moves from `v1` to `v2`.

## Not decided here

- Seeding a file's top-level statements (ADR-0082 decision 6) by the names they use.
- Attributing a changed `export` clause or `package` declaration to the declarations that name it.
