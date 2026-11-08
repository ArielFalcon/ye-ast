# ADR-0043: A change seeds a declaration only where its tokens differ

- Status: Proposed, 2026-11-08, design agent for the lead
- Decision source: pending the owner. Requested by the lead, 2026-11-08: decide whether ye-ast needs a base mechanism
  that compares tokens without trivia before deciding which declaration a change touched, so that a change that cannot
  alter behaviour stops producing impact; confirm or refute the hypothesis that a javadoc-only commit produced 48
  reached entrypoints because changes are measured by lines.
- Related: [ADR-0008](0008-typescript-compiler-api-source.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md),
  [ADR-0035](0035-derived-facts-are-retained-by-content.md), [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md),
  [ADR-0040](0040-a-snapshot-read-parses-each-java-source-once.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0010](../rfc/0010-impact-queries.md), [RFC-0023](../rfc/0023-consequences-surfaces.md)

**In short:** `impact` turns every changed line into a seed, so a comment, a blank line, a re-wrapped expression or a
reordered Java import seeds a declaration, and a line between two members seeds their whole class. The diff keeps its
lines, but each hunk is now compared by tokens: a hunk whose base and head tokens are equal changes nothing and is
reported as such, never dropped silently, and inside a remaining hunk a line no token touches selects nothing. The
hypothesis that motivated this is half right: the mechanism is real, but the evaluation's commit was not javadoc-only,
and none of its 48 entrypoints depends on trivia alone.

## Context

### The evaluation case is not a javadoc-only commit

The 2026-11-08 evaluation (`20261108T140500Z-current-quality-petclinic-jhipster-k7q2`, case IMP-JH-1) reported 48
reached entrypoints for `impact` on HEAD~1 of a JHipster monolith and called it "a no-op". The commit (`6b000b5d`,
"automatic project update for v9.4.0") changes 81 files. Its main Java edits are behavioural as well as cosmetic:
`SecurityConfiguration.filterChain` changes which paths are `permitAll`, three `partialUpdate*` handlers change a
`LOG.debug` message, `ExceptionTranslator.buildCause` replaces `Optional.ofNullable(null)` with `Optional.empty()`,
`UserRepository` moves four methods and swaps two annotation pairs, and four resources edit javadoc only. Nine
TypeScript sources and about thirty Angular templates change too (a new `toOpenableContentType`, new imports, a button
`type`, removed iframe attributes). The evaluation's oracle line already says "also many *Resource.java small edits".

Reproduced with `ye-ast impact <repo> --base HEAD~1 --head HEAD` at `3ffd2fe4`: status `partial`, 74 seeds, 196
impacted symbols, 48 reached entrypoints, 8.7 s wall, 436 MB peak RSS. Every reached entrypoint names the seeds that
reach it (`ReachedEntrypoint.seeds`), which splits the 48 exactly:

| Seeds that reach them | Entrypoints | What changed there |
|---|---|---|
| Angular components and TypeScript declarations | 33 UI routes | real template and code edits |
| `partialUpdate*` of three resources | 3 PATCH routes | a changed log string literal |
| `UserRepository` (class, two moved methods, two methods with swapped annotations) | 11 routes, 1 job | moves and annotation order |
| trivia-only seeds alone | **0** | - |

Seven of the 74 seeds change no token: the class `UserRepository` (an added blank line between members) and the classes
`UserService`, `AuthorityResource`, `BankAccountResource`, `LabelResource`, `OperationResource` and `UserResource`
(javadoc edits between members). Two more (`findOneByEmailIgnoreCase`, `findOneByLogin`) only moved. Removing those
nine seeds removes no entrypoint, because every one of the 12 `UserRepository` entrypoints is also reached through the
two methods whose annotations swapped order, which a conservative rule keeps. Following each symbol's recorded `via`,
about 20 of the 196 symbols are reached first through a trivia-only seed (a **hypothesis**: `via` records one path per
symbol, so another path may still reach them).

### The mechanism is real, and wider than javadoc

Seeds come from line ranges only. `createDiffReader` keeps the new-side range of each hunk
(`src/core/domain/change/diff-reader.ts:77-82`) and never reads its text for meaning; `selectSeeds` seeds every
declaration whose own lines intersect an added range, and every top-level declaration of the file when an added line
falls outside all of them (`src/core/domain/change/seeds.ts:83-85`). A declaration's own lines are its span minus the
spans of the declarations nested in it (`seeds.ts:101-103`), so the javadoc and the blank lines between two methods
belong to their class.

A fixture (two Spring controllers, each calling one method of a service class, and two TypeScript modules using two
functions of a third), one probe per edit, `impact --base main --head <branch>`:

| Edit, nothing else | Seeds | Impacted symbols | Reached entrypoints |
|---|---|---|---|
| javadoc of `Svc.one()` and the JSDoc of `add` | class `Svc`; `add` and `mul` (`top-level`) | 9, including `CtrlB`, which only calls `two()` | 0 |
| blank line between two methods of `Svc` | class `Svc` | 5 | 0 |
| `return 2;` re-wrapped over two lines; a TypeScript expression re-wrapped | `Svc.two`; `mul` | 7 | 1 (`GET /b`) |
| two Java imports swapped; two TypeScript imports swapped | class `CtrlA` (`top-level`); `add` and `mul` (`top-level`), and 6 module records | 5 | 0 |
| `two()` moved above `one()` | class `Svc`, `Svc.two` | 8 | 1 (`GET /b`) |
| control: `return 2;` becomes `return 3;` | `Svc.two` | 5 | 1 (`GET /b`) |

The formatting-only edit answers exactly what the control answers. The javadoc edit is worse than a real edit of
`one()`: it seeds the class, so it reaches the users of every member. With a javadoc on a method of a widely injected
service, that is every class that injects it.

### Where the mechanism reaches, and where it does not

| Family | Reached | Evidence |
|---|---|---|
| `impact`, and workspace impact through it | yes | `impact-queries.ts:392-480` seeds from the diff's lines; `workspace-impact.ts:289` delegates to `impact.ofChange` |
| `callers` and `trace` with line ranges | partly | `requestedRanges` already drops trivia lines outside every top-level declaration (`root-selection.ts:49-73`, commit `a0b9545e`); a trivia line inside a class still selects the class: `callers <fixture> Svc.java:8-10` (the javadoc of `one()`) seeds `Svc` and reaches both controllers |
| `contract_consequences` base/head | no | it compares payload shape digests per operation, "documentation is left out" (`contract-operation.ts:24`); changed files are only a pre-filter (`contract-change-queries.ts:146,160`). Read in code, not probed |
| TypeScript module impact | no | it compares each module's import and export statements, not lines (`module-impact.ts:31`); an import reorder is a statement change, which is right for ES modules |
| changed entrypoints and changed contracts in `impact` | no | they compare extracted findings and operations at both sides |

The two token readers the change needs already exist: `SourceTrivia` (`src/core/ports/source-trivia.port.ts`) reads
the lines no token touches, through tree-sitter for Java (`adapters/tree-sitter/java-trivia.adapter.ts`) and through
the compiler's own parse for TypeScript (`adapters/typescript/source-trivia.adapter.ts`), and composition joins them
(`compose.ts:175-179`). Only `callers` and `trace` consume them.

## Decision

1. **A hunk whose tokens did not change changes nothing.** For each hunk of a changed source file read at both sides,
   the tokens of its base lines are compared with the tokens of its head lines. A token that spans the hunk's edge
   counts whole. Equal sequences mean the hunk seeds nothing, loses its removed declaration names, and is reported as
   in decision 5. Unchanged regions are identical by construction, so a file whose every hunk is equal has equal
   tokens.
2. **What a token is, per language.** When unsure, it is a token.
   - **Java**: every leaf of the tree-sitter parse except comments. A comment is trivia, javadoc included, except a
     comment whose text holds a `\u` escape (javac reads Unicode escapes before comments, so an escaped line end turns
     the rest into code, and tree-sitter does not), and a javadoc holding a `@deprecated` tag (javac derives the
     `Deprecated` attribute from it). Whitespace and line breaks are never tokens. The import declarations of a file are
     compared as a multiset: when base and head declare the same imports, their tokens leave the hunk comparison,
     because the language gives their order no meaning.
   - **TypeScript**: every leaf token of the compiler's parse except comments and JSDoc, plus one line-break token in
     each gap between two tokens that holds a line terminator, whitespace or comment alike, because automatic
     semicolon insertion reads line breaks: `return x` and `return` / `x` differ. A comment is trivia except a
     triple-slash directive, a `@ts-` pragma, a `#__PURE__`, `@__PURE__` or `#__NO_SIDE_EFFECTS__` annotation, and any
     comment inside the arguments of an `import(...)` call; those comments are tokens. Import order is kept, because
     module evaluation follows it.
   - In both languages a string or template literal, an annotation or decorator and its order and arguments, a type or
     generic argument, a modifier and a member's position among fields or enum constants are tokens, so they always
     change their declaration.
3. **A line no token touches selects nothing.** Inside a hunk that changed, an added line that holds no token selects
   no declaration; a hunk left with no such line seeds as a removal at its place, as removed lines do today. The same
   rule replaces the current one for requested ranges (RFC-0010, "Seeds"): a range line no token touches selects
   nothing anywhere, not only outside top-level declarations, and a range left empty stays the `unknown-symbol` fault.
4. **Unknown keeps the line.** A file of a language with no token reader, a side that does not parse cleanly, a deleted
   or added file, and a binary file keep today's line rules and report nothing under decision 5. The token comparison
   only ever removes seeds; it never adds one and never changes a walk.
5. **A set-aside change is a fact, never an empty answer.** `ImpactValue` gains `settled`, present when not empty: one
   entry per set-aside hunk, sorted by file and position, with its base and head line ranges and its reason,
   `no-token-change` or `java-import-order`. A change whose every hunk settles answers `complete` with no seeds and the
   settled entries as its evidence, and the MCP summary says so in one line ("n changed hunks alter no token"). No
   `SCHEMA` bump while the MCP has no consumers.
6. **Placement.**
   - `core/domain/change`: the hunk comparison and the line rule, pure functions over token readings; `FileChange`
     gains the base and head line range of each hunk and the names its removed lines declare.
   - `core/ports`: `SourceTrivia` becomes `SourceTokens`, one reading per file: the tokens with their lines, the comment
     tokens decision 2 keeps, the line-break tokens, and which tokens form a Java import declaration. The lines no token
     touches, which `callers` and `trace` read today, are derived from it in the domain, so one reader owns both facts.
   - `core/adapters/tree-sitter` reads Java, through the parse holds (ADR-0040); `core/adapters/typescript` reads
     TypeScript with the compiler API, which stays there (ADR-0008). Composition joins the two readers as it joins the
     trivia readers today.
   - `core/application/impact` applies the comparison between `selectChange` and the seed selection, with the base and
     head sources it already holds (`impact-queries.ts:466-467`).
7. **Cost.** Only changed source files are read, once per side, and the comparison is linear in each hunk's tokens.
   Java trees come from the read's holds, so the head side reuses trees the query already parses and the base side
   parses only changed files. No derived-fact retention (ADR-0035) until a measured composition shows the reading
   matters.

## Migration

Each unit is one commit series that passes the corpus gate (ADR-0039) before reaching `main`.

| Unit | Content | Expected gate |
|---|---|---|
| U1 | `FileChange` records each hunk's base and head ranges and its removed names; `selectSeeds` unchanged | `none` |
| U2 | `SourceTokens` replaces `SourceTrivia`, both adapters with conformance fixtures; `callers` and `trace` derive trivia lines from it | `none`, or `callers:±` and `trace:±` only where a directive comment outside declarations now selects |
| U3 | decisions 1, 4 and 5 in `impact` for Java and TypeScript, the `settled` field and its MCP line, RFC-0010 and LLM-facing docs | `impact:±`: seeds, symbols and entrypoints only lose elements; `settled` appears |
| U4 | decision 3 inside changed hunks and for requested ranges | `impact:-`, `callers:±`, `trace:±`: a trivia range inside a class becomes an `unknown-symbol` fault instead of seeding the class |

The reorder residual (moved declarations still seed) stays until a measured case shows it matters; see "Not decided
here".

## Conformance fixtures

Per language, one `impact` fixture per rule, each asserting seeds and `settled`:

- Java: javadoc text edit; blank line between members; comment inside a body; a body re-wrapped; two imports swapped
  (`java-import-order`); an import added (seeds as today); a log string literal edited (seeds); two annotations swapped
  (seeds); an annotation value edited (seeds); a generic argument edited (seeds); a `@deprecated` javadoc tag added
  (seeds); a comment holding `\u000a` (seeds); a moved method (seeds, the residual); a side that does not parse (line
  rules, nothing settled).
- TypeScript: JSDoc edit; blank line; comment inside a body; `return x` split after `return` (seeds); arguments
  re-wrapped (seeds, the line-break token); two imports swapped (seeds, and the module origin as today); a decorator
  argument edited (seeds); a template literal edited (seeds); a type argument edited (seeds); a `@ts-expect-error`
  comment added (seeds); a magic comment inside `import(...)` edited (seeds).
- `callers` with a range over a javadoc inside a class: the `unknown-symbol` fault listing the class's declarations.

## Consequences

- A commit that only edits comments, blank lines or Java import order answers `complete` with no seeds and names what
  it set aside. A Java commit that only re-formats does too; a TypeScript one does only where no line break moved.
- A comment or blank line between members stops seeding the whole class, which was the widest form of the noise: the
  class seed reaches every user of the type, not only the users of the edited member.
- The evaluation's commit keeps its 48 entrypoints: they come from behavioural edits, moves and annotation order. The
  gain on it is 7 to 9 fewer seeds, not fewer entrypoints. The evaluation's recommendation 7 ("48 entrypoints for a
  no-op") rests on a misread commit and should be corrected in its report.
- Risk of a missed change: a token rule that calls something trivia when a tool reads it. Decision 2 lists every
  exception known today; a new one enters through a fixture first (ADR-0013).
- `callers` and `trace` change their answer for a range of trivia lines inside a class (U4): a consumer that relied on
  the class being selected gets an `unknown-symbol` fault naming the candidates.

## Discarded alternatives

| Alternative | For | Against | Why dropped |
|---|---|---|---|
| **Trivia lines only**: reuse `SourceTrivia` at both sides and set aside a hunk whose base and head lines are all trivia | the smallest change; covers all 7 trivia seeds of the evaluation's commit | misses re-wrapped code and Java import order, so the same line mechanism stays for formatting commits | covers the symptom observed, not the mechanism; decision 2 costs one more reading of a parse ye-ast already makes |
| **Per-declaration token digests**, matching each head declaration to its base counterpart by path and ordinal | also neutralizes moves | needs base-side declarations the head index does not hold, and overload matching that turns ambiguous on reorder | more machinery for a gain (moves) no measured case needs; the evaluation's moves also swapped annotations, so they would seed anyway |
| **AST equality per declaration** | exact for ASI and for any grammar subtlety | two parse-tree walks and a structural comparison per declaration, and the same base-side matching problem | the line-break token gives the same answer for automatic semicolon insertion at hunk granularity |
| **A whole-file token diff** (Myers over tokens) replacing git's line diff for seeds | re-aligns moved code inside a hunk | cost grows with the product of file size and edit distance, and it re-implements what git already aligned | hunk-local comparison is linear and needs no second diff |
| **Classify semantic change in a new subdomain** | a home for future equivalence rules | a subdomain without its own language: the vocabulary is the change's (`hunk`, `seed`) | AGENTS.md DDD rule: logic goes to the subdomain whose language it speaks, here `change` |
| **No change** | zero risk of a missed change | every comment or format commit keeps seeding, and a javadoc seeds a whole class | the noise is structural and grows with how widely the class is used |

## Open questions

1. **Should Java javadoc count as tokens when an annotation processor reads doc comments** (a processor can call
   `Elements.getDocComment`, and runtime javadoc libraries do)? Recommended: no until a corpus or evaluation repository
   shows such a processor; then the signal is the processor declared in the build, never a guess from the comment.
2. **Should a moved declaration with unchanged tokens settle** (`moved`)? Recommended: not now. Moves in the measured
   case came with annotation swaps; decide when the corpus gate or an evaluation shows moves alone producing reach.
3. **Should a range over a javadoc select the declaration it documents** instead of the `unknown-symbol` fault of U4?
   Recommended: no; the fault lists the candidates, and the documented declaration is one call away, while attaching
   comments to declarations is a second rule with its own edge cases (a comment between annotations, a file header).
4. **Should Angular templates get the same comparison** (HTML comments and insignificant whitespace)? Recommended:
   not here; the template edits of the measured commit were all behavioural, and HTML whitespace is significant inside
   text and `pre`.
5. **Should an added or removed import seed only the declarations that use the bound name** instead of every top-level
   declaration? Out of this ADR's scope: it is a precision rule over a real change, not trivia. Recommended: measure it
   on the corpus first; the evaluation's TypeScript files show it (`translation.config.ts` and `data-utils.ts` seed all
   their top-level declarations through an import line).

## Not decided here

- Retaining token readings as derived facts (ADR-0035): only after a measured cost.
- HTML, JSON resource and OpenAPI document trivia: their readers compare extracted facts already, except templates
  (open question 4).
