# ADR-0043: A change seeds a declaration only where its tokens differ

- Status: Proposed, 2026-11-08, design agent for the lead; final draft 2026-11-09, references checked on `main`
  8c5f181a
- Decision source: requested by the lead, 2026-11-08: decide whether ye-ast needs a base mechanism that compares tokens
  without trivia before deciding which declaration a change touched, so that a change that cannot alter behaviour stops
  producing impact; confirm or refute the hypothesis that a javadoc-only commit produced 48 reached entrypoints because
  changes are measured by lines. The owner, 2026-11-09, verbatim: "Cierra los 3 ADR pendientes con lo que recomiendes
  para las preguntas pendientes. Que se revisen con sol high y se queden aprobados y listos. Ten en cuenta los cambios
  que aplicará 0045 por si debe cambiar algo en estos". Translated: close the three pending ADRs with what you recommend
  for their open questions, have them reviewed and left approved and ready, and take into account what ADR-0045 will
  change in case something here must change.
- Related: [ADR-0008](0008-typescript-compiler-api-source.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md),
  [ADR-0035](0035-derived-facts-are-retained-by-content.md), [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md),
  [ADR-0040](0040-a-snapshot-read-parses-each-java-source-once.md),
  [ADR-0041](0041-one-call-reconciliation-for-every-family.md),
  [ADR-0045](0045-one-assembly-line-for-the-snapshot-reading.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0007](../rfc/0007-extension-model.md), [RFC-0010](../rfc/0010-impact-queries.md),
  [RFC-0023](../rfc/0023-consequences-surfaces.md)
- Amends: ADR-0045 decision 6 (the B11 tokens stage is never prebuilt, decision 8 here) and decision 12 (the
  `SourceTrivia` stage contract becomes `SourceTokens`, decision 9 here). Supersedes nothing.

**In short:** `impact` turns every changed line into a seed, so a comment, a blank line, a re-wrapped expression or a
reordered Java import seeds a declaration, and a line between two members seeds their whole class. The diff keeps its
lines, but each hunk is now compared by tokens: a hunk whose base and head tokens are equal changes nothing and is
reported as such, never dropped silently, and inside a remaining hunk a line no token touches selects nothing. The
token reading is a per-file stage of ADR-0045's assembly line (B11 tokens), implemented by each language pack and
retained per file; the hunk comparison and the line rule are agnostic domain rules. The hypothesis that motivated this
is half right: the mechanism is real, but the evaluation's commit was not javadoc-only, and none of its 48 entrypoints
depends on trivia alone.

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
belong to their class. That ownership is re-derived from the index's raw spans inside `seeds.ts` (`spanOf`, `nests`,
`ownLines`, `innermostHolding`, `seeds.ts:90-108`), which the ADR-0041 one-owner audit flagged and ADR-0045 maps onto
its migration units L1 and L2 ("seeds ... read B-stage ownership instead").

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
| `impact`, and workspace impact through it | yes | `readChange` (`impact-queries.ts:392-489`) seeds from the diff's lines; `workspace-impact.ts:289` delegates to `impact.ofChange` |
| `callers` and `trace` with line ranges | partly | `requestedRanges` already drops trivia lines outside every top-level declaration (`root-selection.ts:49-73`, commit `a0b9545e`); a trivia line inside a class still selects the class: `callers <fixture> Svc.java:8-10` (the javadoc of `one()`) seeds `Svc` and reaches both controllers |
| `contract_consequences` base/head | no | it compares payload shape digests per operation, "documentation is left out" (`contract-operation.ts:24`); changed files are only a pre-filter (`contract-change-queries.ts:146,160`). Read in code, not probed |
| TypeScript module impact | no | it compares each module's import and export statements, not lines (`module-impact.ts:31`); an import reorder is a statement change, which is right for ES modules |
| changed entrypoints and changed contracts in `impact` | no | they compare extracted findings and operations at both sides |

The two trivia readers the change builds on already exist: `SourceTrivia` (`src/core/ports/source-trivia.port.ts`)
reads the lines no token touches, through tree-sitter for Java (`adapters/tree-sitter/java-trivia.adapter.ts`, which
today parses with its own parser and disposes the tree, `:14-26`, not through the read's hold) and through the
compiler's own parse for TypeScript (`adapters/typescript/source-trivia.adapter.ts`); composition joins them by set
union (`compose.ts:175-179`). Only `callers` and `trace` consume them, each through its own `*Deps`
(`impact-queries.ts:94`, `trace-queries.ts:57`) and its own per-query memo (`triviaOncePerFile`,
`root-selection.ts:76`).

### What ADR-0045 changes for this design

ADR-0045 (Accepted, 2026-11-09) makes one assembly line, `BaseReading`, the only assembler of the evidence a family
reads, with language packs implementing its stage contracts and language profiles supplying the per-language data the
agnostic rules read. Five consequences for this ADR:

| ADR-0045 rule | What it means here | Decided in |
|---|---|---|
| Decision 12 lists `SourceTrivia` among the stage contracts; its pack table names a B11 trivia row for both languages | The token reading is per-file syntax of the snapshot: a stage of the line, not a private reader of `impact` | Decisions 6 and 8 |
| Decision 10: no family's `*Deps` declares an evidence reader port | `callers`, `trace` and `impact` stop declaring `sourceTrivia`; they read the stage from the line | Decision 6 |
| Decision 12: pack (adapter, needs the parse) versus profile (pure data the base rules read) | Tokenization rules live in the packs; the one per-language fact the agnostic comparison reads (import order) is a profile field, carried by the reading | Decision 9 |
| Migration L1/L2: seeds read B-stage ownership | The token line rule filters touched lines before ownership is consulted; it adds no ownership rule | Decision 3, Migration |
| Decision 6 prebuilds B11; decisions 2 and 8 give every stage one retention tier | The tokens stage is retained per file and never prebuilt | Decision 8 |

## Decision

1. **A hunk whose tokens did not change changes nothing.** For each hunk of a changed source file read at both sides,
   the tokens of its base lines are compared with the tokens of its head lines. A token that spans the hunk's edge
   counts whole. Equal sequences mean the hunk seeds nothing, loses its removed declaration names, and is reported as
   in decision 5. Unchanged regions are identical by construction, so a file whose every hunk is equal has equal
   tokens.
2. **What a token is, per language.** When unsure, it is a token. This rule is the base's; each pack implements it for
   its language (decision 9).
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
   - **A doc comment read by a build tool stays trivia** (former open question 1). An annotation processor can read doc
     comments (`Elements.getDocComment`), and so can runtime javadoc libraries; no corpus or evaluation repository shows
     one, and treating every javadoc as a token would restore the class-wide noise this ADR removes. The signal, when it
     appears, is a processor declared in the build, never a guess from the comment's text (follow-up F1).
3. **A line no token touches selects nothing.** Inside a hunk that changed, an added line that holds no token selects
   no declaration; a hunk left with no such line seeds as a removal at its place, as removed lines do today. The same
   rule replaces the current one for requested ranges (RFC-0010, "Seeds"): a range line no token touches selects
   nothing anywhere, not only outside top-level declarations, and a range left empty stays the `unknown-symbol` fault.
   - **The rule filters lines; it does not own them.** It removes token-less lines from the touched ranges before seed
     selection asks which declaration owns a line, so it composes with whichever owner answers that: `seeds.ts`'s own
     functions today (`seeds.ts:90-108`), the line's B-stage ownership once ADR-0045 moves seeds onto it. This ADR adds
     no ownership rule and edits none.
   - **A range over a doc comment selects nothing** (former open question 3). It does not select the declaration the
     comment documents: the `unknown-symbol` fault already lists the file's candidate declarations, so the documented
     one is one call away, while attaching comments to declarations is a second rule with its own edge cases (a comment
     between annotations, a file header, a comment between two overloads).
4. **Unknown keeps the line.** A file no pack tokenizes (the stage answers `unread`, ADR-0045 decision 12's absent
   capability), a side that does not parse cleanly, a deleted or added file, and a binary file keep today's line rules
   and report nothing under decision 5. No cut is added for them: today's answer for those files is already the line
   rule, and a marker on every such file would be noise without a remedy. The token comparison only ever removes seeds;
   it never adds one and never changes a walk.
5. **A set-aside change is a fact, never an empty answer.** `ImpactValue` (`impact-fact.ts:73`) gains `settled`,
   present when not empty: one entry per set-aside hunk, sorted by file and position, with its base and head line
   ranges and its reason, `no-token-change` or `import-order`. The reason names the rule, not the language: a profile
   decides where import order carries no meaning (decision 9). A change whose every hunk settles answers `complete` with
   no seeds and the settled entries as its evidence, and the MCP summary says so in one line ("n changed hunks alter no
   token"). No `SCHEMA` bump while the MCP has no consumers.
6. **Placement.**
   - `core/domain/change`: the hunk comparison and the line rule, pure functions over token readings; `FileChange`
     gains the base and head line range of each hunk and, per hunk, the names its removed lines declare (today
     `removedNames` is per file, `diff-reader.ts:21`). The comparison reads no language check: everything
     language-specific it needs arrives in the reading (decision 9), so ADR-0045's frozen list of language checks does
     not grow.
   - `core/ports`: `SourceTrivia` becomes `SourceTokens`, one reading per file: the tokens with their lines, the comment
     tokens decision 2 keeps, the line-break tokens, the token ranges of the import declarations and the profile's
     import-order value. The lines no token touches are derived from it in the domain, so one reader owns both facts.
   - **The reading is a stage of ADR-0045's line**, B11 tokens (the row its pack table names "B11 trivia"):
     `BaseReading` answers `tokensOf(source)` for a source (path and content), memoized per read and retained per file
     (decision 8), and `unread` where no pack tokenizes the file. `callers`, `trace` and `impact` read it from the line
     and drop `sourceTrivia` from their `*Deps` (`impact-queries.ts:94`, `trace-queries.ts:57`), as ADR-0045 decision 10
     requires; `triviaOncePerFile` (`root-selection.ts:76`) is replaced by the line's per-read memo.
   - **Both sides of a change through one reading.** The stage is keyed by a file's path and content, never by a
     snapshot, so `impact` asks the head's reading for its base-side sources too: the base revision needs no reading
     of its own (ADR-0045 decision 3 keeps it lazy), and both sides share the request's trust, which the retained key
     carries (ADR-0035 decisions 2 and 5).
   - `core/adapters/tree-sitter` reads Java through the read's hold (ADR-0040), so the head side reuses the trees the
     query already parses and the base side parses only its changed files; the current adapter's private parser
     (`java-trivia.adapter.ts:14-26`) goes. `core/adapters/typescript` reads TypeScript with the compiler API, which
     stays there (ADR-0008).
   - `core/application/impact` applies the comparison between `selectChange` and the seed selection, with the base and
     head sources it already holds (`impact-queries.ts:466-467`).
7. **Cost.** Only changed source files (`impact`) and requested files (`callers`, `trace`) are read, once per side and
   read, and the comparison is linear in each hunk's tokens. A retained reading costs no parse at all.
8. **Retention and lifecycle: per file, never prebuilt** (the former "Retaining token readings" item, now governed by
   ADR-0045's retention tiers).
   - **Tier: per file** (ADR-0045 decision 10's closed set; ADR-0035 decision 1). The retained value is the plain
     reading of decision 6, a pure function of one file's path and content and its pack, keyed by path, content digest
     and the snapshot's trust: never a tree or a node. One changed file invalidates only its own entry. Reason: the
     same files are asked again across calls with the same content, the base side of a commit on every repeated
     `impact`, the unchanged changed files of a live head while an agent keeps editing, a range a caller re-asks; a
     per-read tier would re-parse them on every warm call, which is the regression class ADR-0045 decision 8 refuses.
   - **Never prebuilt.** This amends ADR-0045 decision 6 ("B11 prebuilt always") for this row only. The stage is asked
     per file, and only for changed or requested files; prebuilding it would parse every source of the bound snapshot
     and fill the shared budget with entries no call reads, the waste M3 measures. Its laziness is decision 3 of
     ADR-0045 unchanged.
   - **Measured, not assumed.** The stage writes its measurement stage line (RFC-0012, ADR-0045 M2: CPU, retained
     bytes, hits and misses per call). If ADR-0045's M5 run under the default 32 MiB budget shows token entries refused
     by `putFact` or evicting line entries that are then missed, the tier drops to per read in a reviewed diff, listed
     by ADR-0045's per-read tier test. Until such a measurement, no bound or projection is added (no speculative limit).
9. **Pack and profile.** Following ADR-0045 decision 12:
   - **Each language pack implements `SourceTokens`** for the paths it owns, with its tokenizer and every exception of
     decision 2 (the Java `\u` and `@deprecated` comments, the TypeScript line-break tokens, directives, pragmas and
     `import(...)` comments). These rules need the parse, so they live with the pack's adapter, pinned by the pack's
     conformance fixtures. A pack that cannot tokenize declares the stage absent and its files answer `unread`
     (decision 4).
   - **The language profile gains one field the agnostic rule reads, `importOrder`**: `insignificant` for Java,
     `significant` for TypeScript. The pack copies it into the reading, so the domain rule in `core/domain/change`
     never maps a path to a language. A new language whose imports carry no order states it in its profile and reuses
     the `import-order` reason with no edit to the comparison.
   - **The merge.** The line keeps one reading per file: the first pack whose reading is not `unread`, in pack order.
     Unlike the merges L1b keeps byte for byte, this stage has no earlier answer to preserve, so its merge is defined
     here; two packs answering one file is a defect the overlap test of ADR-0045 ("Ownership of a path by two packs")
     catches. The current set union of trivia lines (`compose.ts:177-178`) goes with the old port.
   - The capability table of ADR-0045 decision 12 changes only in its row's name: B11 tokens, `yes` for both packs.
10. **Moves keep seeding** (former open question 2). A declaration moved with unchanged tokens is not settled as
    `moved`: the moves of the measured case came with annotation swaps, so they seed under decision 2 anyway, and
    settling moves needs base-side declarations and overload matching (the per-declaration digest alternative,
    discarded below). Follow-up F2 states when this reopens.
11. **Templates are out of scope** (former open question 4). Angular templates keep today's line rules: the template
    edits of the measured commit were all behavioural, and HTML whitespace is significant inside text and `pre`, so a
    template token rule is a separate design with its own exceptions (follow-up F3). The template is a framework
    resource read by the Angular plugin over the TypeScript pack (ADR-0045 decision 12), so a template token reader, if
    it comes, enters as that plugin's stage, not as a TypeScript pack rule.
12. **An added or removed import keeps seeding the file's top-level declarations** (former open question 5). Seeding
    only the declarations that use the bound name is a precision rule over a real change, not trivia, so it is not
    decided here; whether it is worth an ADR is decided by measurement I1 below, run once at the end of this feature.

### Measurement I1: import-only hunks

| | |
|---|---|
| Question | How much reach does file-wide seeding from changed import declarations add beyond the declarations that use the names they bind? |
| Inputs | The corpus manifest's frozen `impact` queries (ADR-0039 decision 3) at this feature's candidate, plus the evaluation case IMP-JH-1, whose `translation.config.ts` and `data-utils.ts` seed every top-level declaration through an import line |
| Measured | Per changed file whose token-changed hunks touch only import declarations: (a) the top-level declarations seeded through those hunks; (b) of them, those that reference a name the changed imports bind or unbind, read from the line's per-file bindings (ADR-0045 B1 and B2a; the base side for removed names); (c) the reached entrypoints whose `ReachedEntrypoint.seeds` lie only in (a) minus (b) |
| Trigger | Once, after this feature's corpus gate passes and before it reaches `main`, serialized with the gate (one heavy run at a time), as a scratch harness outside the repository |
| Outcome (c) = 0 on every input | Decided: import changes keep seeding file-wide; the question closes with the figures recorded in this ADR |
| Outcome (c) > 0 on any input | A new ADR for name-scoped import seeding, with fixtures for the cases that must keep file-wide seeding (a side-effect import, a Java wildcard or static import, a re-export, a name used only in a type position or a decorator) and gate `impact:-`; the size of (c) sets its priority against the backlog |

## Migration

Units commit on one feature branch, each with its failing fixture first and `npm run check`. **One corpus gate runs at
the end of the feature, before `main`** (ADR-0039), with the union of the units' expectations; measurement I1 follows
it. The feature starts after the ADR-0045 units it needs have reached `main`, so the gate's base already holds them and
every moved answer belongs to this feature.

| Unit | Content | Needs on `main` | What it moves (read in the final gate's report) |
|---|---|---|---|
| U1 | `FileChange` records each hunk's base and head ranges and its removed names; `selectSeeds` unchanged | nothing; any time | nothing |
| U2 | `SourceTokens` replaces `SourceTrivia` as a stage contract; both packs implement it with conformance fixtures; the B11 tokens stage in `BaseReading` with its per-file retention and measurement line; the profiles gain `importOrder`; `callers` and `trace` derive trivia lines from the stage and drop `sourceTrivia` from their `*Deps` | ADR-0045 L1 (the line) and L1b (the pack port) | `callers` and `trace` only where a range covers a directive, pragma or `import(...)` comment outside declarations, which now selects |
| U3 | Decisions 1, 4 and 5 in `impact` for Java and TypeScript, the `settled` field and its MCP line, RFC-0010 and LLM-facing docs | U2 | `impact`: seeds, symbols and entrypoints only lose elements; `settled` appears; an answer whose every hunk settles turns `complete` |
| U4 | Decision 3 inside changed hunks and for requested ranges | U3, and the ADR-0045 unit (L1 or L2) that moves `seeds.ts` onto B-stage ownership, so the two never share one gate | `impact` loses seeds; `callers` and `trace`: a trivia range inside a class becomes an `unknown-symbol` fault instead of seeding the class |

The final gate declares `--expect impact:± --expect callers:± --expect trace:±` (a `partial` answer turning `complete`
and a new `settled` key are changed values, ADR-0039 decision 6) and `none` for every other family: `importers`,
`outline`, contract consequences, entrypoints, workspace and decisions read neither seeds nor ranges. The reviewer
attributes each moved answer to a unit by its evidence: a `settled` entry (U3), a removed seed whose lines are all
token-less (U4), an `unknown-symbol` fault over a trivia range (U4), a newly selecting directive comment (U2). A moved
answer that none of these explains is a defect, not an accepted difference.

## Conformance fixtures

Per language, one `impact` fixture per rule, each asserting seeds and `settled`:

- Java: javadoc text edit; blank line between members; comment inside a body; a body re-wrapped; two imports swapped
  (`import-order`); an import added (seeds as today); a log string literal edited (seeds); two annotations swapped
  (seeds); an annotation value edited (seeds); a generic argument edited (seeds); a `@deprecated` javadoc tag added
  (seeds); a comment holding `\u000a` (seeds); a moved method (seeds, decision 10); a side that does not parse (line
  rules, nothing settled).
- TypeScript: JSDoc edit; blank line; comment inside a body; `return x` split after `return` (seeds); arguments
  re-wrapped (seeds, the line-break token); two imports swapped (seeds, and the module origin as today); a decorator
  argument edited (seeds); a template literal edited (seeds); a type argument edited (seeds); a `@ts-expect-error`
  comment added (seeds); a magic comment inside `import(...)` edited (seeds).
- A file no pack tokenizes (a `.kt` source beside the Java pack): line rules, nothing settled, no cut.
- `callers` with a range over a javadoc inside a class: the `unknown-symbol` fault listing the class's declarations.
- The line: one test that asks the tokens stage twice for one unchanged file across two reads and asserts one
  derivation (the per-file tier), and one that edits another file and asserts the first entry still hits.

## Consequences

- A commit that only edits comments, blank lines or Java import order answers `complete` with no seeds and names what
  it set aside. A Java commit that only re-formats does too; a TypeScript one does only where no line break moved.
- A comment or blank line between members stops seeding the whole class, which was the widest form of the noise: the
  class seed reaches every user of the type, not only the users of the edited member.
- The evaluation's commit keeps its 48 entrypoints: they come from behavioural edits, moves and annotation order. The
  gain on it is 7 to 9 fewer seeds, not fewer entrypoints. The evaluation's recommendation 7 ("48 entrypoints for a
  no-op") rests on a misread commit and should be corrected in its report.
- Token readings join the line: every family that needs trivia or tokens reads one retained reading per file, and a
  new language gains the rule by implementing one stage contract in its pack and stating `importOrder` in its profile.
- `callers` and `trace` change their answer for a range of trivia lines inside a class (U4): a consumer that relied on
  the class being selected gets an `unknown-symbol` fault naming the candidates.

## Risks

- **A missed change**: a token rule that calls something trivia when a tool reads it. Decision 2 lists every exception
  known today; a new one enters through a fixture first (ADR-0013). F1 is the known open case.
- **Dependence on ADR-0045's schedule.** U2 to U4 wait for L1 and L1b, and U4 for the seeds ownership move. U1 is
  independent and can land first; the noise stays until U3.
- **Cache pressure from token entries.** A reading is about the size of its file's text; they share the 32 MiB budget.
  Mitigated by reading only changed and requested files and by decision 8's measured fallback to per read.
- **A merge with no prior answer.** The stage's merge is new (decision 9); a file two packs claim is caught by the
  ADR-0045 overlap test, not by byte identity.

## Discarded alternatives

| Alternative | For | Against | Why dropped |
|---|---|---|---|
| **Trivia lines only**: reuse `SourceTrivia` at both sides and set aside a hunk whose base and head lines are all trivia | the smallest change; covers all 7 trivia seeds of the evaluation's commit | misses re-wrapped code and Java import order, so the same line mechanism stays for formatting commits | covers the symptom observed, not the mechanism; decision 2 costs one more reading of a parse ye-ast already makes |
| **Per-declaration token digests**, matching each head declaration to its base counterpart by path and ordinal | also neutralizes moves | needs base-side declarations the head index does not hold, and overload matching that turns ambiguous on reorder | more machinery for a gain (moves) no measured case needs; the evaluation's moves also swapped annotations, so they would seed anyway |
| **AST equality per declaration** | exact for ASI and for any grammar subtlety | two parse-tree walks and a structural comparison per declaration, and the same base-side matching problem | the line-break token gives the same answer for automatic semicolon insertion at hunk granularity |
| **A whole-file token diff** (Myers over tokens) replacing git's line diff for seeds | re-aligns moved code inside a hunk | cost grows with the product of file size and edit distance, and it re-implements what git already aligned | hunk-local comparison is linear and needs no second diff |
| **Classify semantic change in a new subdomain** | a home for future equivalence rules | a subdomain without its own language: the vocabulary is the change's (`hunk`, `seed`) | AGENTS.md DDD rule: logic goes to the subdomain whose language it speaks, here `change` |
| **Token reading private to `impact`**, outside the line | no dependence on ADR-0045's units | a second assembly of per-file syntax beside the line, the pattern ADR-0045 removes; `callers` and `trace` would keep their own trivia reader | ADR-0045 decisions 1, 10 and 12 |
| **Token rules in the profile as data** (comment kinds, pragma patterns) | one place for every per-language rule | the exceptions need the parse's context (a `\u` escape javac reads before comments, a comment inside `import(...)` arguments), which pure data cannot express | ADR-0045 decision 12: a profile holds only what a base rule reads |
| **Prebuild the tokens stage with the rest of B11** | first `callers` over a range finds it warm | parses every source of the snapshot for a stage asked only for changed or requested files; fills the budget with unread entries | decision 8 |
| **No change** | zero risk of a missed change | every comment or format commit keeps seeding, and a javadoc seeds a whole class | the noise is structural and grows with how widely the class is used |

## Follow-ups

| # | Follow-up | Trigger | What it then decides |
|---|---|---|---|
| F1 | Doc comments as tokens where a build tool reads them (decision 2) | A corpus or evaluation repository whose build declares an annotation processor or library that reads doc comments | A fixture first; the Java pack keeps doc comments as tokens for a repository whose build declares such a processor, read from the build, never from comment text |
| F2 | Settle moved declarations as `moved` (decision 10) | A corpus gate report or evaluation case where a reached entrypoint is reached only through seeds of declarations that moved with unchanged tokens, diagnosed through `ReachedEntrypoint.seeds` and `via` | Reopens the per-declaration digest alternative with base-side declarations from the line |
| F3 | A template token rule (decision 11) | An evaluation or corpus commit where template-only comment or whitespace edits seed components that reach entrypoints | An ADR for an Angular plugin stage with HTML's own exceptions (text content, `pre`, `preserveWhitespaces`) |
| F4 | Name-scoped import seeding (decision 12) | Measurement I1's outcome | As I1's outcome rows state |

## Not decided here

- HTML, JSON resource and OpenAPI document trivia: their readers compare extracted facts already, except templates
  (F3).
