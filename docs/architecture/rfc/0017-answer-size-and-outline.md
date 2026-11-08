# RFC-0017: An answer-size rule and a file outline an agent reads around

- Status: Draft, 2026-11-03
- Related: [RFC-0002](0002-facts-contract.md) (facts, determinism, cuts), [RFC-0005](0005-transports.md) (MCP and CLI),
  [RFC-0010](0010-impact-queries.md) (impact value), [RFC-0012](0012-observability-and-measurement.md) (measurement by
  input identity), [RFC-0015](0015-answer-coordinates.md) (answer coordinates and what it refuses to add),
  [ADR-0001](../adr/0001-product-scope-and-priority.md), [ADR-0007](../adr/0007-dependency-versions.md) (exact pins),
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) (coverage grows with evidence)

**In short:** two proposals that answer the same complaint from opposite ends. First, a rendering rule: a counted
elision is never longer in bytes than listing what it hides at the same detail level. Second, one new read-only tool
that answers the shape of a file — its imports and its declarations with a start and an end line — so an agent that has
already decided to open a file reads the spans it needs instead of the whole file.

## Why

An agent building a change reads `ye_ast_impact`, gets a list of files, and then reads those files whole. The queries
answer *where*; nothing answers *what is inside this file and where*. On this repository, `src/mcp/server.ts` and
`src/mcp/render.ts` are 544 and 536 lines, 69 KB together, and the part a change actually touches is one or two
functions.

The rendering side has the mirror-image problem. The size work of `odd/tasks/mcp-answer-precision.md` and
`odd/tasks/mcp-latency-and-size.md` made answers smaller, and commit `159f46f` made a summary name the ring it leaves
out. Neither added the one rule that keeps the result honest: **a counted elision longer than the literal text it replaces is a regression**. Nothing measures it today, so it can appear with any renderer change and no test
would notice.

## 1. The rule: a counted elision is never longer than listing what it hides

The examples and measurements below retain the historical selector labels and projection. The current MCP contract
uses `mode: "summary"`, `mode: "details"` and `mode: "full"`: details is explanatory text; full delivers the
complete public fact and a navigation guide. The counted-elision rule compares an elision with the literal listing
it replaces within the same text projection. It does not guarantee that summary is smaller than details or full JSON,
and does not require expanding all associations into text. See [RFC-0005](0005-transports.md).

**Evidence that the rule is missing.** `src/mcp/render.ts:344-357`, `impactedSymbols`: a summary replaces every symbol
past depth 1 with one line. After `159f46f` that line is:

```
impacted symbols (12): 11 at depth 0-1 listed, 1 deeper (to depth 6) not listed; ask ye_ast_callers about a symbol listed here to see one ring further, or detail "full" for all
```

About 200 characters, standing for one hidden symbol line of about 50. With one deeper symbol in a file that already
lists a nearer one, the summary is roughly 150 bytes **larger** than `detail: "full"`. The same shape exists in
`cutsBlock` (`src/mcp/render.ts:262-268`): a counted cut costs a `summarized (…)` line plus a per-file count line,
against the single cut line it hides.

**The rule.** A counted elision is used only when it is not longer than listing what it counts, everything else in
that block equal: the renderer builds both texts and keeps the shorter, and a tie keeps the count so the answer still
says what it left out.

The comparison is against **the same text projection**; the historical `detail: "full"` comparison below is context, not a current selector. The cuts block holds two different
elisions: the counted one this rule governs, and a summary that names the declarations a cut could not settle to
instead of its places. The second is a different presentation of the same fact, not a count. Letting its bytes decide
would flip the shape of a cut for reasons unrelated to the fact, and would make a deterministic contract depend on
how long a path happens to be. Measured on the fixture of the existing cut tests: the declaration form costs more than
the plain listing for one cut and less for many, so a byte rule there would change the answer's shape with the size of
the fixture.

**Changed areas.** A change's summary has a third candidate for its impacted symbols, under the same rule: counts per
changed area. An area is the path segment right below the directories every seed file shares, written as the
`changed` glob that walks only its seeds (a seed file directly in the shared directory is its own area). A symbol
counts under the area its recorded `via` chain starts in; a chain that does not reach a seed is counted as "origin not
recorded". The candidate exists only when the seeds fall in two or more areas and the request accepts `changed` (the
local change and the workspace trigger, never another repository's section), and it is chosen only when it is not
longer than the text it replaces.

**Scope.** Every renderer with a counted block: `impact`, `callers`, `importers`, `entrypoints`, `workspace`,
`decisions`, and the `cuts:` block each one closes with. A new renderer inherits the rule through the shared test
helper, not through a review.

**Acceptance, measured.** An impact answer whose summary counts one deeper symbol in a file that already lists a
nearer one renders **415 bytes against 295** for the full body, 41 % more. After the rule it renders the full body,
which is the correct answer at that size. Three fixtures that asserted a counted rendering were shown to be too small
for counting to pay — the count line is about 200 characters, so it only wins once it stands for several lines — and
are enlarged until it does, with the assertions they carry unchanged. A new test holds the invariant on the collapsing
fixture.

## 2. The outline: the shape of a file, with coordinates

**The question it answers.** "I have decided I must open this file. What is inside, and which ranges matter?" It is the
question an agent asks after `impact` names twelve files, and it is the one no query answers today.

**The fact.**

| Field | Shape | Why |
|---|---|---|
| `file` | repo-relative | every fact in this repository (RFC-0002) |
| `declarations[]` | `{ kind, name, line, endLine, children? }` | `kind` uses the vocabulary the other facts already use (`function`, `method`, `class`, `type`, …); the span is the retrieval pointer; the top level holds the declarations the file contains, and `children` (same shape, line then name order, absent when none) the ones a `contains` edge places directly inside a declaration |
| `imports[]` | repo-relative file | the strongest single signal for "does this file belong to my change" |
| `unheld[]` | repo-relative file, at the value level | a requested file the index holds no node of: what it declares cannot be told, which is not "nothing" |

- **Read from the graph, not from a parser.** `CodeGraphReader.symbolsInFiles(files)`
  (`src/core/ports/code-graph.port.ts:93`) already answers with `kind`, `name`, `qualifiedName`, `file`, `startLine` and
  `endLine` (`GraphSymbol`, lines 49-58), and `outgoingEdges` (line 99) carries the `imports` edges. The outline is a
  projection over a port four queries already use, so no reader, no parser and no dependency is added.
- **Nesting is the graph's, never a span's.** A declaration is a child only when a `contains` edge from another
  declaration of the same file reaches it; the file node's own `contains` edges place the top level. A declaration no
  such edge places (a route or a configuration binding a framework reader adds) stays at the top level even when its span
  lies inside another declaration's. A Java member sits under its class and the class under the file's package
  declaration, because that is what the graph records; a construct the extractor does not emit, such as a Java `record`,
  leaves its members under the nearest container it does emit. ye-ast's own Java grammar finds such a file, listed or
  focused, and the answer carries a `no-extractor` cut at it, so a misplaced listing never reads as complete; a focus
  scans only its focused files to find it.
- **It carries no file length and no silent elision.** A file's length needs a source read the projection does not do,
  and the caller gets it from the read it makes anyway. The listing names every declaration, so it has nothing to omit
  and no budget; a large file answers a large outline, which is still a fraction of the file, and the rule of section 1
  protects the caller.
- **A focus is a cut the caller asked for, and says so.** After a first listing, `focus` replaces `files` with
  selectors: `<file>:<path>` matches the declarations whose dotted path in the `contains` tree ends with it at whole
  names (a bare name at any depth, `A.m` only an `m` that `A` contains directly), and `<file>:<line>` the innermost
  declaration the tree places around the line. Each match carries its `ancestors` (kind, name and span only, no
  siblings), the declaration with its whole subtree, `omitted`, how many of the file's declarations it leaves out, and
  `uses`, what the declaration's own body uses outside itself (plan `2026-11-06-outline-references.md` Part B): each
  use is a repository declaration (file and span), a package or a language global, with its relations and the places of
  the uses; a use no binding proves, a call the index matched by name alone included (ADR-0036), is an `unresolved-link`
  cut at the declaration, and a member used on a local value is
  not a use. A local value is one the declaration's own syntax declares, or a parameter or variable of a function
  around it that the index holds no node of; a function, class or type declaration outside the body is the node of its
  name, never a local, and a cut when no single node matches. Settling a use reads what binds its name at its place, so a focus reads the snapshot's sources as a listing
  does; who calls the declaration is `callers`, and `compose` asks both at once. No imports. Several matches are all answered, in line order, never one picked. A symbol that matches nothing is
  `unknown-symbol` with the file's dotted paths as candidates, a line no declaration holds is `top-level-line` with the
  same candidates, and a file the index does not hold is `unheld`. The path is the one `callers` resolves, through the
  same resolver over the same tree, so a path the outline prints targets exactly the same declarations there.
- **The pointer is a coordinate, not a handle.** `file:line-endLine`; the agent expands it with its own file reader. No
  hash, no cache, no TTL, no server-held state: the same request over the same revision gives the same bytes
  (RFC-0002 rule 3, RFC-0015).
- **A file the index does not hold is `unheld`, never an empty list.** The MCP fault vocabulary carries it as
  `no-extractor`/`not-exported` (`src/mcp/server.ts:44-53`): an empty `declarations` array means the file declares
  nothing, which is a different fact.
- **No threshold decides whether to answer.** Every requested file is answered or listed as `unheld`; no branch compares
  a count with a constant.

**What it refuses to carry.**

| Candidate | Why not |
|---|---|
| Parameter lists, return types, generic parameters | It is the signature RFC-0015 refused (`0015-answer-coordinates.md:105`), and it is not needed: a name, a kind and a span decide whether to open the range |
| Any line of source | The same refusal: facts about code, not code (RFC-0015, RFC-0002) |
| A body or a diff | Out of scope; the agent's own reader answers the body |
| A partial outline over an arbitrary range | A second request shape for the same fact in its first release; open question 5 |
| A token count | No tokenizer runs in this repository (RFC-0015:133); a tokenizer is a dependency (ADR-0007) |

**Why this does not reverse RFC-0015.** That RFC refuses a snippet or a signature *inside an impact answer*, where the
argument is that `kind` plus the qualified name is already enough to decide whether to open the file. The outline is
asked by a caller who has already decided to open it, and it answers with exactly what RFC-0015 called enough: a kind, a
name and a span. The refusal stands; this is the other half of the same design.

**Reuse, not a new parser.** The declaration list comes from the readers that already exist: the TypeScript compiler
API inside `core/adapters/typescript/` (ADR-0008), the Angular extractor, `tree-sitter-java`. A language with no reader
answers `unknown`; coverage grows only with evidence (ADR-0013).

**Read-only, and untrusted-safe.** The tool is a read query family like the others: nothing an agent reaches exposes a
write. Under `untrusted` it reads the export only, never the working tree, and it adds no network request. Paths and
declaration names are the same exposure the impact answers already carry; the redaction patterns apply as everywhere.

## 3. Measurement

The rule of section 1 is enforceable in bytes, and the value of section 2 is comparable in bytes: for a set of files,
`sum(outline bytes + bytes of the spans the agent reads) < sum(whole file bytes)`. Bytes, not tokens, because no
tokenizer runs here and a token claim would be unmeasured (RFC-0015:133). Any place this RFC quotes a token figure, it
is marked as an estimate.

The numbers come from a probe with no clock and no network, reproducible by input identity (RFC-0012): the same
repository, revision and requests produce the same bytes twice. Timing stays where it lives today,
`src/composition/measurement.ts`.

**Measured** on the baseline the earlier RFCs use — name-webapp at `e8699653`, trust `trusted`, this branch's working
tree, counting text and structured content separately. The table's historical `summary` and `full` labels refer to
text detail levels under the old selector, not current `mode: "full"`:

| Call | summary text | full text | saving | envelope |
|---|---|---|---|---|
| `ye_ast_entrypoints` (all) | 5,378 | 5,378 | 0 | 672 |
| `ye_ast_callers RestClientService.get` | 15,249 | 63,296 | −48,047 (−76 %) | 876 |
| `ye_ast_callers AuthService.getAccessToken` | 998 | 1,072 | −74 (−7 %) | 867 |
| `ye_ast_callers formatRating` | 4,615 | 6,677 | −2,062 (−31 %) | 847 |
| `ye_ast_callers AppButtonComponent` | 16,832 | 22,441 | −5,609 (−25 %) | 869 |

No counted elision is longer than listing what it hides, and two runs give identical bytes. The rule governs counts, not
every elision: a summary that names the declarations of an unresolved reference instead of its places is a different
presentation, and for a single place it costs more than the plain listing (292 bytes against 225 on the fixture below).
That is deliberate and reasoned in section 1; reading this table as "no summary is ever longer" would be wrong. Two readings of the table matter for
what follows:

- The saving is concentrated: one call carries 48 KB of the 55 KB saved, so a summary is worth its line on a large
  answer and near-worthless on a small one, which is exactly what the rule of section 1 encodes.
- `AuthService.getAccessToken` saves 7 %: the counted line nearly costs what it hides. That answer is the first
  candidate for the outline of section 2, because the remaining weight is the file the agent reads next, not the
  answer.
- `ye_ast_entrypoints` costs the same at both detail levels, so its summary carries no counted elision to pay for.
- The historical envelope stayed under 900 bytes on every call. A client may expose both channels; these wire sizes
  do not establish what a model saw.

## 4. Row coordinates under one shared selector

**The symptom.** On the summary of a real 185-file Angular change, `reached entrypoints (41)` was the largest block
(8.3 KB of 20.8 KB): a `Handler lookup` line printed one complete select example, and every row still repeated a JSON
handler object, plus a second line for its origin count.

**The cause, confirmed.** Three blocks offer a selector per row, and each decided its coordinate on its own between the
same two candidates, both of which print a JSON object on every row:

| Block | Literal candidate | Shared candidate before this change |
|---|---|---|
| reached entrypoints (`reachedLines`, `reachedGroup`) | `lookup example: {complete selector}` | example line + `handler: {"path","symbol","line"}` |
| module dependencies (`moduleLines`) | `[lookup example: {complete selector}]` | example line + `[module: {"file","snapshot"}]` |
| cuts (`cutCoordinates`, `impactCutBlock`) | `lookup example: {complete selector}` | example line + `cut: {"cutIndex"}` |

Once one example defines `kind`, `owner` and the shape, the per-row object only restates field names; what a row must
carry is its own values. The text already had a compact form for each: `handlerText` (`path:line[-endLine] symbol`,
used by entrypoint, changed-entrypoint and link rows) and `<snapshot> <file>` (used by module rows that cannot be
selected). The other per-row JSON in the renderers is not this pattern: `[linkId "…"]` and `[findingIndex n]` are
single values, `evidence: […]` rows are evidence, not selectors, and the compose view prints entity anchors, never a
selector.

**The rule.** A shared selector block prints one complete select example and a lookup line saying which fields each row
fills (`sharedLookup`); every row prints only its own coordinate in the block's compact text form:

| Block | Row coordinate | Fills |
|---|---|---|
| reached entrypoints | `-> <path>:<line>[-<endLine>] <symbol>` | `handler.path`, `handler.line`, `handler.symbol`; `endLine` is not a selector field |
| module dependencies | `<snapshot> <file>` | `module.snapshot`, `module.file` |
| cuts | `cutIndex <n>` | `cutIndex` |

The section 1 rule still chooses between the literal and the shared block: the shorter text wins and a tie keeps the
literal one, so a single row keeps its complete selector. A row that cannot be selected (`canSelect` false) prints the
same compact coordinate with no selector. `details` and `full` follow the same rule because the cause is the same:
`details` lists more rows of the same blocks, and `full` text uses the same renderers.

**Exactness.** A compact handler coordinate decodes exactly when the symbol is its last word and the line is the number
after the last `:` before it, which holds for any path, including one with spaces or colons. A symbol with whitespace
would break that, so a block whose handlers hold one keeps the literal selector on every row. The snapshot is always
`base` or `head`, so a module coordinate decodes for any file. The schema still accepts only what the example shows
(`subjectHandler` is strict), and the lookup line says so.

**Measured** on that change (trusted, same snapshots, two runs identical in bytes):

| Call | before | after |
|---|---|---|
| `ye_ast_impact` summary, whole text | 20,822 | 18,859 |
| — reached entrypoints | 8,326 | 6,363 |
| `ye_ast_impact` details, whole text | 185,078 | 164,048 |
| — reached entrypoints | 12,480 | 10,681 |
| — module dependencies | 107,036 | 90,279 |
| — cuts | 54,612 | 52,138 |
| `ye_ast_callers` on one page component, whole text | 1,278 | 1,273 |

Selections rebuilt only from a compact handler row and a compact module row returned results byte-identical to the
ones the literal selectors return.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | A new tool, or a parameter on an existing one? `odd/tasks/mcp-latency-and-size.md` L2 chose a parameter (`expand`) over a tool, because the same fact selected differently needs no server-held handle | A new tool: `expand` selects *more of the same fact*, while an outline answers *a different fact* about a different subject (a file, not a symbol). One tool per question is what the existing names already do (`impact`, `callers`, `importers`) |
| 2 | Does the tool take explicit `files`, or a `scope`? | Explicit `files`, resolved through the same `scope` as the other tools, because the caller's file list comes from an answer it already has |
| 3 | Does the outline list imports at all, or only declarations? | Settled by the amendment: yes. Superseded by the [outline references plan](../../superpowers/plans/2026-11-06-outline-references.md) (D1): each module statement is read from the syntax with the names it binds, its target comes from the module resolver (a repository file, a package, or unresolved with its reason), and the graph `imports` edge at a binding's position only adds the declaration it reaches |
| 4 | Does the rule of section 1 also apply to `structuredContent`? | No: the rule compares alternatives within one text projection, not text against structured JSON; clients may expose both channels |
| 5 | Should one release also answer an outline for a line range? | No. Two request shapes over the same fact before one measurement exists is the complexity this RFC refuses |
| 6 | Is a counted block ever allowed to exceed the full answer when the count is large? | Never: the rule has no exception. If the full body is shorter, the full body is the correct answer |
| 7 | Does a counted answer also name `ye_ast_outline` for the files it leaves an agent to read? | Not now. It costs about 120 bytes on every answer that lists files — 0.7 % of the 15.2 KB answer and 11 % of the 998-byte one — and nothing measures that an agent would act on it; the guidance lives in the tool description and in `INSTRUCTIONS`, where `159f46f` already put the `ye_ast_callers` pointer that had a measured saving behind it. Reopen with evidence from sessions: files named by an answer read whole, or an outline never called after it ships |
| 8 | Should the shared block with compact rows replace the literal candidate everywhere, so a block always has one form? | No. A single row is shorter with its complete selector, and the section 1 rule already decides by bytes; one extra candidate per block is the smaller rule. A row whose coordinate does not decode exactly keeps the literal selector |
| 9 | `docs/superpowers/plans/2026-11-05-mcp-category-guidance-and-single-coordinates.md` kept each row's handler or module as a JSON object so that no agent parses a rendered path. Section 4 asks the agent to read `path:line symbol` and `snapshot file` from the row. Is that acceptable? | Yes. Both forms decode exactly by a stated rule (the symbol is the last word, the line follows the last `:`; the snapshot is the first word), the one case that breaks the rule keeps the literal selector, and a single row keeps its complete selector by bytes. The JSON object per row restated field names the example already defines, which is what made the block the largest of the answer |
