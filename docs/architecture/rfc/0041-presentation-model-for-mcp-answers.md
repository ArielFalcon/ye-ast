# RFC-0041: A presentation model for every MCP answer, so a reply is the facts asked and little else

- Status: Draft, 2026-11-24; program approved by the owner on 2026-11-24 (S1 to S5 of `odd/tasks/answer-quality.md`)
- Related: [ADR-0160](../adr/0160-an-mcp-answer-is-written-by-one-writer-from-a-presentation-model-each-family-maps-its-fact-to.md),
  [ADR-0161](../adr/0161-the-mcp-reply-carries-a-compact-envelope-and-states-session-constants-once.md),
  [ADR-0162](../adr/0162-details-is-a-superset-of-summary-a-bound-is-filled-in-role-order-and-page-alone-pages-the-primary-list.md),
  [ADR-0163](../adr/0163-the-mcp-states-its-protocol-once-and-accepts-the-launch-repository-named-again.md),
  [ADR-0164](../adr/0164-a-declaration-carries-its-signature-as-a-fact.md) (all Proposed); ADR-0022, ADR-0051, ADR-0078,
  ADR-0109, ADR-0110, ADR-0113; RFC-0002, RFC-0005, RFC-0015, RFC-0017, RFC-0029, RFC-0030

**In short:** today each tool builds its reply as strings, so half of every reply is envelope, repeated paths and
instructions, and 40 % of the identities the engine found are not recognisable in the text. This RFC puts one neutral
**presentation model** between the fact and the text. Each family maps its fact to sections of rows by composition;
one writer owns every cross-cutting rule (a path once, no restated evidence, counted elisions, the envelope, the byte
bound, paging). `details` becomes a superset of `summary` by construction, the protocol is said once outside the
replies, and a declaration carries its signature as a core fact. No fact changes except that addition.

## 1. Target

Owner, 2026-11-24 (S1, S3, S5; original wording):

> "el objetivo es que al menos el 90% de la respuesta sea util, ya sea eliminando lo inutil, agregando info util que se
> desaprovecha o no se tiene hoy, restructurando lo que haga falta."

> "las soluciones a estos problemas se deben plantear de forma transversal, adaptable a cada herramienta mediante
> mecanismos de herencia o composicion segun mejor sea, pero no como parche ad-hoc para cada caso. Deben ser soluciones
> "de abajo hacia arriba" a nivel de arquitectura, eficientes y robustas."

> "Parte del proceso este es tambien reducir al maximo que se pueda el tamaño de las respuestas sin sacrificar calidad.
> buscar ese equilibrio."

- "Useful" is measured by metric v2 (task T1, built outside this repository): identities matched as tuples, a byte
  ledger with four accounts (needed, supporting, overhead, unneeded), and a recall floor.
- Facts do not change; their presentation does. Recall against `answer.json` must not drop (assumption A2).

## 2. Where the bytes go (measured 2026-11-24, `main` `c1091eb3c`)

Source: 127 successful replies of the evaluation `20261123T212628Z-final-latency` (76 `summary`, 51 `details`, ten
tools, five scenarios), classified byte by byte; the classes add up to each reply's size. The run, the scripts and the
full diagnosis stay outside the repository.

| Mechanism | Evidence | Share of reply bytes |
|---|---|---|
| M1. A fixed envelope closes every reply | `src/mcp/server.ts:49-54` appends `result JSON:` (mode, status and snapshot again, plus the request echoed as `recovery.query`); `answer-files.ts:64-67` prints the absolute folder and an inventory; `server.ts:559,566` a `repository root:` line; `presentation-context.ts:92-97` the same `declared scope:` in 121 of 127 replies | 14.8 % pooled; median 26 % of a `summary` reply |
| M2. No presentation model: a place is spelled in full on every row | `render.ts` (2,107 lines) and `render-composition.ts` (944) go from fact to text; `render.ts:62-64` and `presentation-context.ts:15-17` always print the whole path; about 30 local `size(a) < size(b)` choices; `render.ts:422-425` prints an `evidence:` line equal to the row's own handler place | repeated paths 17.8 %, restated evidence 5.8 % of `details`; 43 % of the median `entrypoints` details reply |
| M3. What is listed is decided per section by hand, never by the question | `render.ts:1448-1453` counts the workspace links while `1638-1666` list every place of an outward name, twice; `render.ts:1407-1408` omits the trace steps in `summary`; `render.ts:736-745` writes a count longer than the one path it hides | 38.7 % of `workspace` summary bytes are places after the third on a line; 81 % of its oracle identities are only in `answer.json` |
| M4. The two modes are not a hierarchy | `render.ts:708-730`: `details` keeps the nearest dependents and counts the rest. In `callers`, `summary` holds facts `details` lacks in 10 of 11 pairs and is larger in 9; `importers` and `outline` print the same facts in both modes. Agents asked for `details` in 121 of 133 calls | 7 % of `summary` bytes point to the other mode |
| M5. The selection and replay protocol is paid everywhere and hardly used | `select`, `page`, `expect`, `replay`, `answerBytes`, `budget` are 10,105 of the 35,454 bytes of tools/list; lookup lines and selector JSON are 14 % of `callers` and 25 % of `impact` replies. In 133 agent calls: `select` 3 (1 success), `expect` and `replay` 0. 14 of 28 invalid calls are `page` without `select` (`evidence-schema.ts:118`); 8 name the launch repository again (`workspace-plan.ts:173-181`) | guidance 6.9 % pooled |
| M6. Coordinates only | `outline-fact.ts:4-14` holds kind, name and span: three `fetchBagRelationships [method]` rows cannot be told apart. `render.ts:1265-1275` returns a reading plan; in the trace task the four MCP sessions read 15 to 17 files after the answer | not a byte share: missing facts |

Facts, cuts and status are 46.2 % of `summary` bytes and 50.6 % of `details` bytes. The engine holds about 95 % of the
oracle identities; the text shows 49 % (`summary`) to 57 % (`details`) in a recognisable form.

What is not the problem: the facts. Replies are byte-identical between the two engines of the run and between
repetitions, and citations are 98 to 100 % valid.

## 3. Design

### 3.1 Shape: three layers, bottom-up

```
core fact (unchanged)            Fact<V>                      src/core
  │  one mapper per family (pure, no text)
  ▼
presentation model               Presentation = sections of rows   src/mcp/presentation/model.ts
  │  one writer for every family
  ▼
reply                            envelope + text + _meta      src/mcp/presentation/writer.ts, envelope.ts
```

Placement (AGENTS.md placement rule): the model and the writer shape an answer for one entrypoint, so they live in
`src/mcp` (question 7). They decide no fact. The signature of §3.9 decides a fact about code, so it lives in the core
(questions 3 and 6). The CLI prints the fact as JSON and does not use the model; if a second entrypoint ever needs it,
the model moves to a place both may import, with its own decision.

### 3.2 The model

```ts
// src/mcp/presentation/model.ts: types only, no behaviour, no text beyond labels.
export type SectionRole = "answer" | "completeness" | "context";

export interface Place { repo?: string; path: string; line?: number; endLine?: number }

/** One stated fact about the row, printed in parentheses: depth, confidence, fan-in, via. */
export interface Qualifier { name: string; value?: string }

export interface Row {
  /** The identity of the fact the row states; never printed. Unique within its section. */
  key: string;
  /** Where the fact is. Absent for a fact with no place (a count, a name). */
  place?: Place;
  /** What the fact is: `http-route GET /api/x`, `save(account: Account): Observable<{}> [method]`. */
  label: string;
  qualifiers?: readonly Qualifier[];
  /** The places that prove the row beyond its own place. Printed in `details` only. */
  evidence?: readonly Place[];
  /** Rows the fact contains: the calls of a trace step, the members of a declaration. */
  children?: readonly Row[];
  /** 0: asked directly (a direct dependent, a link). 1 and above: reached through tier 0. Default 0. */
  tier?: number;
}

export interface Section {
  /** Stable name, also the member of `answer.json` the rows come from (`value.symbols`). */
  id: string;
  title: string;
  role: SectionRole;
  layout: "by-file" | "list" | "tree";
  rows: readonly Row[];
  /** The one section `page` pages when no `select` is given. At most one per presentation. */
  primary?: true;
}

export interface Presentation {
  status: StatusLine;                    // the completeness verdict, from renderFactStatus's inputs
  snapshots: readonly SnapshotRef[];     // one per repository read
  narrowing?: readonly string[];         // scope and change selection, only when the caller narrowed
  sections: readonly Section[];
  /** A step tied to a cut or gap of this answer and to the parameter or tool that lifts it. */
  next?: readonly { cause: string; step: string }[];
}
```

Rules of the model:

1. **A row is a fact, once.** A fact appears as one row of one section. A second place that needs it refers to its
   label; the writer never prints a fact twice.
2. **Keys come from the fact's own identity**: repository, path, line and symbol for a declaration; kind and name for
   an entrypoint; the two ends for a link; kind and place for a cut. Never an index-internal id, never a position in a
   list. Keys serve the tests of §5, the paging cursor and metric v2 (each printed row is attributable to one fact).
3. **The model has no mode.** A mapper builds the same presentation for `summary` and `details`; the writer decides
   what each mode prints (§3.5). A mapper that branches on the mode is a defect.
4. **Roles.** `answer`: the rows the tool's question asks for. `completeness`: cuts and unknowns that bound an answer
   row. `context`: what helps read the answer and was not asked (seeds, changed paths, outward names behind a link).
5. **Evidence is a place, not prose.** A reason travels as a qualifier.

### 3.3 How a family adapts: composition

Each family provides one pure function and nothing else:

```ts
// src/mcp/presentation/families/<family>.ts
export function present(fact: Fact<V>, context: PresentContext): Presentation;
```

It composes shared **row builders** (`src/mcp/presentation/rows.ts`), one per kind of thing the facts already share:

| Builder | Input type (unchanged core types) | Used by |
|---|---|---|
| `declarationRow` | `Seed`, `ImpactedSymbol`, `OutlineDeclaration`, `TraceStep` | callers, impact, outline, trace, compose |
| `entrypointRow` | `Finding<Entrypoint>`, `ReachedEntrypoint` | entrypoints, callers, impact, trace roots |
| `linkRow`, `callSiteRow` | `Link`, `UnlinkedCallSite`, `UnresolvedCallSite` | workspace, trace, impact (workspace), contract_consequences |
| `cutSection` | `Cut[]` | every family |
| `nameRow` | `OutwardName`, decisions | workspace, decisions |

**Why composition and not inheritance.** The families do not share a skeleton: `trace` is a tree, `workspace` is five
lists over several repositories, `outline` is a containment tree per file, `compose` nests other answers. A base
renderer with overridable steps would need a hook per difference and would bring back per-family text through the
overrides. What the families share is smaller and exact: the kinds of row and the rules of writing. So the shared
parts are functions a mapper calls (row builders) and one function that calls no family (the writer). The only shared
base is data: the `Presentation` type. A new family, or a new section of an old one, gets every rule by producing
rows.

**No family writes text.** After migration a family file imports no string-joining helper and returns no string. An
arch rule holds it: `src/mcp/presentation/families/**` may import `model.ts`, `rows.ts` and core types, never
`writer.ts`.

`compose` maps each member answer with that member's own mapper and nests the resulting sections; the attestation
pairs RFC-0030 P4 compacted become rows whose evidence is shared, which rule W4 below states once.

### 3.4 The writer and the rules it owns

`write(presentation, mode, bound?, page?) -> { text, elided, nextCursor? }` in `src/mcp/presentation/writer.ts`. It
is a pure function of its arguments.

| Rule | Statement | Algorithm, cost |
|---|---|---|
| W1 Section order | Status and snapshot lines, then `answer` sections, then `completeness`, then `context`, each group in mapper order | Stable partition, O(sections) |
| W2 Path once | In a `by-file` section rows are grouped by (repository, path) in order of first appearance; the path is a group header and a row prints its span and label. In `list` and `tree` layouts a row prints its place in full the first time the path appears in the section and as `:line` under the same file afterwards | One pass with a map from path to group, O(rows) |
| W3 Common prefix | When a section has two or more groups and their paths share whole leading directories, the section title states `under <prefix>/` and group headers are relative to it | Longest common prefix over the group paths, cut at the last `/`; O(total path length) |
| W4 Evidence that says nothing new | An evidence place equal to the row's own place is not printed. An evidence place in the row's own file prints as a line. Evidence lists equal across a run of rows print once for the run | Canonical place comparison; runs through `shareExactContext` (`presentation-sharing.ts`), O(rows) |
| W5 Shared qualifiers | A qualifier with the same value on every row of a group (or of the section) is printed once on the group header (or the title) and not on the rows, when that is shorter | Count values per group, compare bytes with `preferShorterText`; O(rows × qualifiers) |
| W6 One form of elision | Rows left out are stated as `+N more (<breakdown>): answer.json <section id>` and, when a cursor exists, `page.cursor <cursor>`. A count line is used only when it is shorter than the lines it replaces (RFC-0017 rule 1); otherwise the rows are printed | The writer renders both candidates of the section and keeps the shorter; O(rows) |
| W7 Order | Rows keep the mapper's order, which is the fact's sorted order. Grouping is stable. Nothing is ordered by size or by a hash | — |
| W8 Indentation | Two spaces per level; a tree deeper than its content needs is not padded | — |

Total cost is linear in the rows plus the path bytes of the answer. Rendering is 3 to 58 ms per call today
(RFC-0040 §2) and stays in that range.

Determinism: identical presentation, mode, bound and page give identical bytes. The writer reads no clock, no
environment and no map iteration order other than insertion.

**Risk the evaluation must check.** W2 is the layout `callers`, `outline` and `importers` already use
(`render.ts:564-584`), and agents cite from it correctly. W3 asks the reader to join a prefix and a relative path. It
ships in its own unit, last, and stays only if citation validity holds (§6, question 2).

### 3.5 Modes: `details` is a superset of `summary`

One presentation, two readings of it:

| | `summary` | `details` |
|---|---|---|
| `answer` rows, tier 0 | all | all |
| `answer` rows, tier 1 and above | all when the section has at most `LISTED_ITEMS` rows; otherwise counted by tier (W6) | all |
| Row evidence | counted on the row (`43 places`) when there is more than the row's own place | listed, by file (W2, W4) |
| `completeness` | one line per cut kind and cause, with counts | each cut with its places |
| `context` | rows up to `LISTED_ITEMS` per section, then W6 | all |
| Children | printed where the family marks them as the answer (trace steps, outline members) | all |

Consequences that follow by construction, not by per-family care:

- Every row key printed in `summary` is printed in `details` (a test holds it for every family, §5).
- Where a family has no evidence, no upper tiers and no long context (`importers`, `outline`), the two modes produce
  the same bytes. The parameter stays in the schema for uniformity and the reply says nothing about it.
- No reply points to the other mode. The only pointer is the W6 line, to `answer.json` or to the next page.
- `LISTED_ITEMS` (`render-budget.ts:9`) keeps its value and its meaning (a presentation bound of the summary). It no
  longer hides tier-0 answer rows: the links of a workspace and the steps of a trace are tier 0.

No new constant is introduced. A caller that wants less states it with `page.limit` or `answerBytes`.

Settled in U3 (`entrypoints`): a section a selection addresses sets `numbered`, and each of its top-level rows prints its
zero-based position in the section (`3. `) in both modes, so the number is the `findingIndex` and the position in
`answer.json` and a `summary` reader can select; a UI route's own guards are children (`details`) with a `guards n`
qualifier on the row, an unguarded route states nothing per row, and a base path is one `context` row per distinct
value (`routes n`, its evidence) that a route names as the child `base <row number>`. An evidence place may carry `via`
and `confidence`, which the writer prints beside it (W4 then keeps a place equal to the row's own that adds them).

### 3.6 A byte bound is filled in role order

`answerBytes` (request or host) is today applied after rendering: the whole text, else the whole summary, else a
refusal (`render-budget.ts:28-35`). The writer instead fills the bound:

1. Reserve the envelope and one W6 line per non-empty section.
2. Print the status and the completeness summary lines.
3. Print `answer` rows in order, tier 0 first, until the next row would not fit; the remaining rows are counted (W6)
   and, when the section is the primary one, a cursor continues them.
4. With bytes left, print `completeness` places, then `context`, the same way.
5. When step 2 plus the reserves does not fit, refuse as today (`answer-over-bound`, ADR-0051 decision 3).

A bounded reply is a shorter projection with every omission counted, never a truncation, so ADR-0051 decision 3 holds.
It is deterministic for a given bound. Without a bound nothing is cut by size: the design pillar "signals, never size
thresholds" and the standing rule against default limits without measurements both hold.

### 3.7 `page` alone pages the primary list

- `page: { limit, cursor? }` without `select` pages the rows of the presentation's `primary` section, in writer
  order. Other sections print as in the requested mode. The reply states `rows <from>-<to> of <total>` and the next
  cursor.
- The cursor is the existing one (`evidence-cursor.ts`): result identity, digest of the selection (here the constant
  selection `primary`), limit and next offset; a changed result fails as today. It needs an available recovery, as a
  selected page does.
- Every family declares its primary section: entrypoints (findings), callers and impact (impacted symbols), importers
  (related files), outline (declarations of the requested files), trace (steps), workspace (links), decisions
  (decisions), contract_consequences (answers). `page` is accepted by the nine read tools.
- `select` with `page` keeps its meaning (ADR-0022 decision 6) for the three tools and the evidence kinds they have.

This removes the largest class of invalid calls: agents already send `page` this way.

### 3.8 The envelope: compact and session-aware

A reply is:

```
status: partial (cuts: 6 unresolved-link callee-unknown)
snapshot: application@6b000b5d23a36c45e01472471b84a44fa2464044
<sections>
answer: answers/trace/d5a31c1a...40eb71b0/answer.json
```

| Part today | Where it goes | Why |
|---|---|---|
| `result JSON: {mode, status, snapshot, recovery}` | `_meta["ye-ast/result"]` on the reply and the same fields in `answer.json` (already there) | `mode`, `status` and `snapshot` are the first lines of the text; `recovery.query` is the request. A client that branches reads `_meta`; an agent that replays reads `answer.json` |
| `Recovery recipe and resultIdentity: ...` line | removed | It only pointed at the line above |
| `answer files: <absolute folder> — answer.json (...): <inventory>; summary.txt, details.txt` | one closing line `answer: answers/<tool>/<key>/answer.json`, relative to the cache root the instructions name once; the absolute folder stays in `_meta["ye-ast/answer-files"]`; the inventory is what the W6 lines already name | 350 bytes become about 100; no host path in the text |
| `no answer file written: <reason>` | unchanged (ADR-0113 decision 4) | It is a fact about this reply |
| `repository root: <id> -> <path>` | the instructions list every declared repository with its root; `answer.json` keeps `repositoryRoots`. A reply prints a root only for a repository neither the instructions nor the request named (a persisted member) | A session constant |
| `declared scope: languages ...; frameworks ...` | the instructions state it for the launch repository; a reply prints it only when it differs from that | Identical in 121 of 127 replies |
| `scope:`, `change:` | kept, shortened, only when the caller narrowed (`Presentation.narrowing`) | They bound the answer |
| `test dependents: excluded; ...` | the descriptions of `ye_ast_callers` and `ye_ast_impact` (the instructions already say it) | A property of the tool, not of the answer |
| `snapshot:` | kept, one line per repository read, full sha | RFC-0002: the snapshot is recorded in every answer; the sha is what a follow-up call passes |
| `merge base:` | kept on `impact` | Needed to read base-side lines |

With a byte bound the result fields are no longer duplicated into `structuredContent`; they are in `_meta` in both
cases. Selected replies (`select` + `page`) keep their own shape (ADR-0113 decision 7) and gain the same header and
closing line.

One function builds the envelope for every family (`src/mcp/presentation/envelope.ts`); `delivered` and the
`plainText` assembly of `server.ts:559-590` reduce to a call to it.

### 3.9 The protocol is said once, and inputs are tolerant

**Guidance leaves the replies.** Each class of line has one home:

| Line today | Home |
|---|---|
| `mode "details" lists ...`, `answer.json includes all` | gone: W6 is the only pointer |
| `Handler lookup: ...`, `lookup example: {json}`, `Cut lookup`, `Module lookup` | the description of `select` in the three tools that have it, with one example each |
| `[findingIndex n]`, `importers[n]` | a numbered row (`3.`) in `details` for a section a selection addresses; the description of `select` says the index is the row number |
| `Investigation guide: Repeat callers with repo ... and revision ...` | gone: it restates the request |
| `branches are not evaluated`, `A recorded origin is an association`, `Indices are zero-based` | the tool description or the instructions |
| `ye_ast_decisions lists the declarations that would resolve these gaps` | a `next:` line, only when this answer has such gaps |

A reply may carry `next:` lines only for a cut or gap of that answer, each naming the parameter or tool that lifts it,
once per distinct cause (`Presentation.next`). `walkBoundRemedies` and the JDK step (`render.ts:948,1352`) are of this
kind and stay.

**Schema diet.** `$defs` and `$ref` do not help: a definition is local to one tool's schema, so `workspace` (one
schema in four tools, 3.7 KB) and `scope` (nine tools) cannot be shared across tools, and support for `$ref` in tool
schemas differs between clients (not verified on the harnesses in use). The alternative is flattening with the
mechanism that exists, `src/mcp/compact-schema.ts`:

| Change | Mechanism | Bytes of tools/list (estimate) |
|---|---|---|
| `select` published as an opaque object with a one-line shape and example; validation stays in zod | `withOpaque` | 5.0 KB to about 0.6 KB |
| `workspace`, `budget` and the items of compose `queries` published the same way | `withOpaque` | 8.7 KB to about 2 KB |
| Keywords that carry no information removed from the published schema: `maximum: 9007199254740991`, `minLength: 1` on identifiers, nested `additionalProperties: false` | a pruning pass beside `publishedField` | about 3 KB |
| `answerBytes` described as a ceiling: "Upper bound on the reply in bytes; a larger value adds nothing" | description | 23 of 133 calls sent it to get more |
| Instructions: the selection and answer-reading paragraphs shrink to what no description says; repository roots and the cache root are added | `instructionsFor` | 4.4 KB to about 3 KB |

Target: tools/list from 35.4 KB to under 24 KB. The server keeps validating with the full zod schemas, so a wrong
shape is still a typed fault. The risk is that a model writes an opaque field wrong more often; these fields were used
in 5 of 133 calls, and the evaluation counts invalid calls per field (§6).

**Tolerant input: the launch repository named again.** In `workspace-plan.ts:173-181` an entry of `repos` whose id is
the launch repository's is a `duplicate-repository` fault. When that entry's root is the launch repository's root, it
is the same declaration and is merged into the launch member (its `revision`, when given, is the launch repository's
for the call; a top-level `revision` that differs is the existing conflict). An entry with the same id and another
root, and two entries of `repos` with one id, stay faults. This is a behaviour change under `src/core` and passes the
corpus gate (expected movement: none, since no corpus request repeats the launch repository).

### 3.10 The signature of a declaration is a fact

Decided under S4 (owner: "si entiendes que esto tiene alto ROI aplicalo"). It supersedes the clause "No tool reads
source text" of ADR-0078 and the refusals of RFC-0015 and RFC-0017 for this one item; see ADR-0164.

**What it is.** The header of a callable or type declaration as its language writes it, built from syntax parts, on
one line: kept modifiers (`static`, `abstract`, `async`, visibility), name, type parameters, parameters with their
types, return type, `extends`/`implements`, `throws`. It never contains a body, a default value, an initializer, a
decorator or annotation, or a comment. Absent means no reader produced one, never "no parameters".

**Who produces it.** The two readers that already walk each declaration's syntax and report its span:

| Language | Reader | Parts |
|---|---|---|
| TypeScript, JavaScript | `core/adapters/typescript/declared-member-names.adapter.ts` (compiler API, ADR-0008) | The node's modifiers, `name`, `typeParameters`, each parameter's name, `?` and type node text, the return type node text, heritage clauses |
| Java | `core/adapters/tree-sitter/java-member-names.adapter.ts` | The fields `modifiers` (keywords only), `type_parameters`, `type`, `name`, `parameters` (type and name of each formal parameter), `throws`; `superclass` and `interfaces` for a type |

Both return it as `signature?: string` on `DeclaredDeclaration` (`core/ports/declared-member-names.port.ts`). Whitespace
runs collapse to one space, so the value depends on the tokens only. A language with no reader has no signature; a
plugin that adds a language carries conformance fixtures for it (AGENTS.md testing rule 5).

**How it reaches a fact.** The declaration model (`core/application/navigation/declaration-model.ts`) already joins a
`DeclaredDeclaration` to its graph symbol by position; `ModelDeclaration` gains `signature`. One application helper,
`signaturesOf(model, places)`, answers the signatures of a set of declaration places, reading only the files of those
places (per-file derived facts, kept by path and content like the readings beside them, ADR-0077). The value types
that name a declaration gain an optional `signature`: `OutlineDeclaration`, `ImpactedSymbol`, `Seed`, `Handler`,
`TraceStep`. One owner derives it (the reader); the use cases only carry it.

**Trust and redaction.** A signature is repository text read as data through the readers that already parse the
snapshot; nothing is run. It leaves the process inside the fact, through the same redaction the public fact already
passes (ADR-0110 decision 6). Building it from parts, without default values, literals of initializers or annotation
arguments, keeps free-form strings out of it; a literal type (`mode: "a" | "b"`) is type text and stays.

**Where it prints, and what it costs.** The signature replaces the bare name in the row label, it is not an extra
line:

| Place | `summary` | `details` |
|---|---|---|
| `outline` declarations | yes | yes |
| Rows whose name is ambiguous in their group (overloads) in any family | yes | yes |
| `callers`/`impact` symbols, entrypoint handlers, trace steps | no | yes |

Cost: parameters and return type add about 30 to 50 bytes to a row that prints it. An outline of two files (25 rows)
grows by about 1 KB, less than the envelope and repeated context it loses (§4). It is kept only if the evaluation
shows reads after the answer fall (S4).

**Cited-line text is not added.** The text of a call line on trace steps and caller rows would add 60 to 80 bytes per
row (about 1.3 KB on a 19-step trace) for content the agent can read from the exact line the row already gives. Its
return is unproven; it is reconsidered only if reads do not fall after the signature (question 3).

### 3.11 The balance between size and quality (S5)

One rule decides what a reply prints and what stays in `answer.json`:

> A byte is printed when it states a fact the question asks for, once; or bounds such a fact (status, cuts); or is the
> one pointer to the rest. Everything else is in `answer.json`, in `_meta` or in what the session already said.

| Printed in the reply | Left to `answer.json` (counted when it is an omission) |
|---|---|
| Status and one line per cut kind | Cut places in `summary` |
| Every tier-0 answer row with its place and label | Rows beyond a caller's `page.limit` or `answerBytes` |
| Qualifiers that differ between rows | Qualifiers every row shares, said once |
| Evidence in `details`, by file | Evidence in `summary` (a count on the row) |
| The signature where §3.10 says | Recovery recipe, result identity, digests, indices |
| One closing pointer | The inventory of sections, the absolute folder |

Why this balance and not a smaller reply: the anatomy shows the waste is in bytes that state no fact (48 % of a
`summary` reply at the median), while the facts themselves are under-printed (49 % of identities recognisable). So the
program removes overhead and adds rows. Estimated result from the measured classes: `summary` median 3,485 to about
1,600 bytes before the added rows and signatures, about 2,000 with them; `details` 4,886 to about 2,400, about 3,000
with them; facts, cuts and status from 46 to 51 % of bytes to 85 to 90 %.

Metric v2 treats indentation and section titles (about 3 % of bytes) as part of the row they format.

## 4. Work units

Each unit is one behaviour with its tests and docs, about 400 authored lines, on its own branch, with `npm run check`.
A unit that changes `src/core` passes the corpus gate on the exact tree (ADR-0039). Effects are estimates from §2 and
are re-measured by the evaluation.

| Unit | Task | Scope | `src/core` | Expected effect |
|---|---|---|---|---|
| U1 | T3 | Model types, row builders for declarations and cuts, writer with W1, W2, W4, W6, W7, W8 and the two modes of §3.5; arch rule for `families/**`; no family uses it yet | no | none on replies |
| U2 | T3 | Envelope of §3.8 for every reply: header, closing line, `_meta["ye-ast/result"]`, instructions carry roots, cache root and declared scope | no | transport 14.8 % to about 2 to 3 %; about 800 bytes less per `summary` reply; no host path in the text |
| U3 | T3 | `entrypoints` on the model, and the reached-entrypoint rows `callers` and `impact` share | no | `entrypoints` details about 40 % smaller (restated evidence 26 %, repeated paths 18 %) |
| U4 | T3 | `callers` and `impact` (local and workspace): symbols with tiers, seeds, changed paths, cuts | no | `details` no longer smaller than `summary`; guidance of these families falls with U12 |
| U5 | T3 | `workspace` and `decisions`: links as tier-0 answer rows, outward names as context with evidence | no | `workspace` summary: links printed, 38.7 % of bytes of place lists gone; repeat share 27 to 35 % to under 5 % |
| U6 | T3 | `trace` (tree layout, steps as tier-0 answer), `outline`, `importers` | no | `trace` summary answers the call sequence; repeat 9 to 14 % to under 5 % |
| U7 | T3 | `contract_consequences` and `compose`; removal of the legacy text helpers of `render.ts` and `render-composition.ts` | no | repeat 10 to 23 % to under 5 %; `render.ts` reduced to mappers |
| U8 | T4 | Tiers, `LISTED_ITEMS` and W6 applied uniformly; the superset test over every family; W5 shared qualifiers | no | pointers to the other mode gone (about 3 % of `summary`); qualifier bytes down |
| U9 | T4 | Role-ordered fill of `answerBytes` (§3.6) replacing the wholesale fallback | no | a bounded reply keeps its answer rows; fewer `answer-over-bound` refusals |
| U10 | T4 | `page` alone pages the primary section, on the nine tools (§3.7) | no | 14 of 28 invalid calls gone |
| U11 | T4 | W3 common prefix, gated by citation validity | no | first-occurrence path bytes (12 %) down by an estimated third |
| U12 | T5 | Guidance out of replies (§3.9 table), `next:` rule, numbered rows, descriptions and instructions rewritten | no | guidance 6.9 % to about 1 % |
| U13 | T5 | Schema diet: opaque fields, keyword pruning, `answerBytes` wording | no | tools/list 35.4 KB to under 24 KB |
| U14 | T5 | The launch repository named again in `repos` is the launch member | **yes, gate (expect none)** | 8 of 28 invalid calls gone |
| U15 | T6 | Facts already held printed as rows where a pointer stood: route guards, cut places in `details` | no | pointer lines gone; recall in the text up |
| U16 | T6 | `signature` on `DeclaredDeclaration`: TypeScript and Java readers, conformance fixtures | **yes, gate (expect none: no fact carries it yet)** | none on replies |
| U17 | T6 | `signature` on `ModelDeclaration` and the five value types, `signaturesOf`, printed per §3.10 | **yes, gate (expect outline, callers, impact, entrypoints, trace ±)** | overloads told apart; reads after a trace answer expected to fall |

Order: U1, U2, then U3 to U7 in any order (disjoint families; U3 before U4 for the shared rows), then U8 to U10, U12
to U14 in any order, U15 to U17, and U11 last. T7 evaluates after U7, after U14 and at the end.

During U3 to U7 a family is either wholly on the model or wholly legacy; the public renderer signature
(`ResponseRenderer`, `presentation.ts:18`) does not change, so `server.ts` does not know which.

## 5. Invariants held by tests during and after migration

| # | Invariant | Test |
|---|---|---|
| I1 | **No fact is lost.** For every fixture fact of a migrated family, each identity the legacy text of a mode states (route, `path:line`, declaration name with its file) is stated by the new text of that mode or counted by a W6 line of its section. The one allowed move is evidence from `summary` to `details` (§3.5), listed per family in the test | A token extractor in a `*.testing.ts` over the existing fixtures of `render.test.ts`, `impact-presentation.test.ts`, `workspace-presentation.test.ts`, `entrypoints-presentation.test.ts` |
| I2 | **`summary` is a subset of `details`**: the set of row keys the writer prints in `summary` is included in the set it prints in `details`, for every fixture and family | One parameterised test over the mappers |
| I3 | **Determinism**: writing the same presentation twice gives the same bytes; a presentation built from a fact with its lists in the same order gives the same bytes | Unit test of the writer; the evaluation's r1/r2 hash check |
| I4 | **Every row is a fact of the answer**: each row key resolves to an entry of the full projection (`answer.json`) of the same fact | A resolver per section id in a `*.testing.ts` |
| I5 | **Writer rules**: a path appears once per group (W2); no evidence equals its row's place (W4); a W6 line is never longer than what it replaces | Property-style tests over generated presentations with a fixed seed |
| I6 | **No family writes text** | The arch rule of §3.3 in `npm run arch:check` |
| I7 | **The core fact is untouched** by U1 to U13 and U15 | `npm run check`; the CLI and protocol outputs are not in the diff |

Committed tests never read the legacy renderer after its removal in U7: I1's expected tokens are frozen as fixtures at
the migration of each family.

## 6. What the evaluation must show

Same workload and oracles as the baseline run, technical track and agent track, with metric v2 (T1).

| After | Must move | Falsifies the design |
|---|---|---|
| U2 | Overhead account down by the transport share; recall unchanged | Agents open the answer folder less than today (14 of 40 sessions): the relative pointer is not followed |
| U7 | Useful share above 80 % in both modes; `details` median under 3 KB; recall in the text up from 0.49/0.57 toward the engine's 0.95 | Agent item recall or citation validity (0.98) falls: grouped paths are misread |
| U10, U14 | Invalid calls from 28 to under 8 | Invalid calls move to another shape |
| U13 | tools/list under 24 KB; invalid calls on opaque fields not above today's | A client rejects the published schema, or opaque fields are written wrong more often |
| U17 | Source reads after a trace answer from 15 to 17 toward under 6; tokens per session below the arm without the MCP | Reads do not fall: the cause is distrust of `partial`, and the lever is the cuts, not content. The signature then stays only for overloads |
| U11 | First-occurrence path bytes down; citation validity unchanged | Any drop in citation validity: W3 is removed |
| End | Useful share at least 90 % (S1) with recall not below the floor; median reply smaller than today in both modes (S5) | — |

## 7. Decisions

| # | Decision | ADR |
|---|---|---|
| D1 | One writer renders every MCP answer from a presentation model; each family maps its fact by composition and writes no text | ADR-0160 |
| D2 | The reply carries a compact envelope; session constants are stated once; result fields move to `_meta` and `answer.json` | ADR-0161 |
| D3 | `details` is a superset of `summary`; a byte bound is filled in role order; `page` alone pages the primary list | ADR-0162 |
| D4 | The protocol is stated once outside the replies; the published schemas are flattened; the launch repository named again is accepted | ADR-0163 |
| D5 | A declaration carries its signature as a fact; cited-line text is not added | ADR-0164 |

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Is the closing pointer relative to a cache root named in the instructions, or the absolute `answer.json` path? | Relative. It removes the host path from every reply (and from agent answers) and saves about 100 bytes. Fall back to the absolute path alone, without inventory, if the evaluation after U2 shows fewer sessions opening the folder. |
| 2 | Does W3 (a common prefix stated once) ship? | Yes, last and gated: it stays only if citation validity does not move. W2 alone already removes most repeated paths. |
| 3 | Is the text of a cited line added on request? | No, not in this program. The row already gives the exact line; the cost is about 1.3 KB on a typical trace. Reopen only if U17's evaluation shows reads after the answer did not fall. |
| 4 | Do annotations and decorators of a declaration become a fact too (the outline oracle lists them)? | Not now. Their arguments are free-form literals, which the signature deliberately leaves out; decide with evidence of a need after U17, under ADR-0013. |
| 5 | Should `mode` disappear from `importers` and `outline`, where both modes are equal? | Keep it in the schema. One parameter with one meaning across ten tools costs 66 bytes per tool and removes a special case. |
| 6 | Is `answerBytes` renamed? | No. Reword its description as a ceiling. A rename is a second change for the same effect. |
| 7 | Do test dependents in `callers` and `impact`, non-code artifacts on a path, and the context-path mismatch of `contract_consequences` belong here? | No. They are coverage, not presentation (ADR-0013); they are listed in the diagnosis for their own decisions. |
