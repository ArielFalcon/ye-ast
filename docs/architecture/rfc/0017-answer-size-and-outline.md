# RFC-0017: An answer-size rule and a file outline an agent reads around

- Status: Draft, 2026-11-03
- Related: [RFC-0002](0002-facts-contract.md) (facts, determinism, cuts), [RFC-0005](0005-transports.md) (MCP and CLI),
  [RFC-0010](0010-impact-queries.md) (impact value), [RFC-0012](0012-observability-and-measurement.md) (measurement by
  input identity), [RFC-0015](0015-answer-coordinates.md) (answer coordinates and what it refuses to add),
  [ADR-0001](../adr/0001-product-scope-and-priority.md), [ADR-0007](../adr/0007-dependency-versions.md) (exact pins),
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md) (coverage grows with evidence)

**In short:** two proposals that answer the same complaint from opposite ends. First, a rendering rule: a summary is
never longer in bytes than the full answer it summarizes, whatever the answer holds. Second, one new read-only tool
that answers the shape of a file — its imports and its declarations with a start and an end line — so an agent that has
already decided to open a file reads the spans it needs instead of the whole file.

## Why

An agent building a change reads `ye_ast_impact`, gets a list of files, and then reads those files whole. The queries
answer *where*; nothing answers *what is inside this file and where*. On this repository, `src/mcp/server.ts` and
`src/mcp/render.ts` are 544 and 536 lines, 69 KB together, and the part a change actually touches is one or two
functions.

The rendering side has the mirror-image problem. The size work of `odd/tasks/mcp-answer-precision.md` and
`odd/tasks/mcp-latency-and-size.md` made answers smaller, and commit `159f46f` made a summary name the ring it leaves
out. Neither added the one rule that keeps the result honest: **a summary that is longer than the answer it stands for
is a regression, not a summary**. Nothing measures it today, so it can appear with any renderer change and no test
would notice.

## 1. The rule: a counted elision is never longer than listing what it hides

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

The comparison is against **the same detail level**, not against `detail: "full"`. The cuts block holds two different
elisions: the counted one this rule governs, and a summary that names the declarations a cut could not settle to
instead of its places. The second is a different presentation of the same fact, not a count. Letting its bytes decide
would flip the shape of a cut for reasons unrelated to the fact, and would make a deterministic contract depend on
how long a path happens to be. Measured on the fixture of the existing cut tests: the declaration form costs more than
the plain listing for one cut and less for many, so a byte rule there would change the answer's shape with the size of
the fixture.

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
| `declarations[]` | `{ kind, name, line, endLine }` | `kind` uses the vocabulary the other facts already use (`function`, `method`, `class`, `type`, …); the span is the retrieval pointer |
| `imports[]` | repo-relative file | the strongest single signal for "does this file belong to my change" |
| `unheld[]` | repo-relative file, at the value level | a requested file the index holds no node of: what it declares cannot be told, which is not "nothing" |

- **Read from the graph, not from a parser.** `CodeGraphReader.symbolsInFiles(files)`
  (`src/core/ports/code-graph.port.ts:93`) already answers with `kind`, `name`, `qualifiedName`, `file`, `startLine` and
  `endLine` (`GraphSymbol`, lines 49-58), and `outgoingEdges` (line 99) carries the `imports` edges. The outline is a
  projection over a port four queries already use, so no reader, no parser and no dependency is added.
- **It carries no file length and no elision.** Both were in the first draft and both are gone: a file's length needs a
  source read the projection does not do, and the caller gets it from the read it makes anyway; and with every
  declaration listed there is nothing to omit, so there is no budget and no `omitted` field to keep honest. A large file
  answers a large outline, which is still a fraction of the file, and the rule of section 1 protects the caller.
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
tree, the text the model reads and the envelope the host reads:

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
- The envelope stays under 900 bytes on every call: what a host pays is not what a model pays.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | A new tool, or a parameter on an existing one? `odd/tasks/mcp-latency-and-size.md` L2 chose a parameter (`expand`) over a tool, because the same fact selected differently needs no server-held handle | A new tool: `expand` selects *more of the same fact*, while an outline answers *a different fact* about a different subject (a file, not a symbol). One tool per question is what the existing names already do (`impact`, `callers`, `importers`) |
| 2 | Does the tool take explicit `files`, or a `scope`? | Explicit `files`, resolved through the same `scope` as the other tools, because the caller's file list comes from an answer it already has |
| 3 | Does the outline list imports at all, or only declarations? | Settled by the amendment: yes, as repo-relative files resolved from the graph's `imports` edges. A package outside the repository is not an edge, and the caller sees those by reading the header it already has |
| 4 | Does the rule of section 1 also apply to `structuredContent`? | No: the envelope is the host's contract and the text is what the model reads (`src/mcp/server.ts:305`). The rule governs the text |
| 5 | Should one release also answer an outline for a line range? | No. Two request shapes over the same fact before one measurement exists is the complexity this RFC refuses |
| 6 | Is a counted block ever allowed to exceed the full answer when the count is large? | Never: the rule has no exception. If the full body is shorter, the full body is the correct answer |
| 7 | Does a counted answer also name `ye_ast_outline` for the files it leaves an agent to read? | Not now. It costs about 120 bytes on every answer that lists files — 0.7 % of the 15.2 KB answer and 11 % of the 998-byte one — and nothing measures that an agent would act on it; the guidance lives in the tool description and in `INSTRUCTIONS`, where `159f46f` already put the `ye_ast_callers` pointer that had a measured saving behind it. Reopen with evidence from sessions: files named by an answer read whole, or an outline never called after it ships |
