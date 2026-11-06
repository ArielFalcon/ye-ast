# Plan: `trace`, the outbound walk and its reading plan

- Date: 2026-11-06; revised the same day after an independent review (findings and their resolution in section 9)
- Design: [RFC-0013](../../architecture/rfc/0013-trace-and-patterns.md) "Trace" (rules R1-R13, accepted decisions 1-3)
- Adds to the RFC: a **reading plan** view, the spans of the steps grouped by file in order of first appearance, so an
  agent opens only what the trace reached.
- Status: accepted by the owner (Q1-Q4, 2026-11-06); nothing implemented.

## 1. Goal and non-goals

Given a declaration (`file` + `symbol`) or a line range, answer what it executes: repository steps in source order with
their spans, external leaves folded by module, cuts where resolution stopped, and the reading plan. Later slices add
dispatch, entrypoint roots and effects.

Not in scope: a whole file as a root (its transitive imports are many and do not say what runs; the target shape of
`callers` is kept), evaluating conditions (decision 2), a type checker (RFC-0016 S9 measured 0-3 cuts removed for
+2.2-2.9 s and +300-480 MB; ADR-0018 rejected), `patterns` (deferred).

## 2. Technical bases: where every datum comes from

### 2.1 Reused as-is

| Datum | Source | Evidence |
|---|---|---|
| Resolved calls with call-site line and column | `CodeGraphReader.outgoingEdges(ids, kinds)`; edges carry `line`, `column` (nullable), `confidence`, `provenance`, `synthesizedBy`; codegraph copies the reference's coordinates into the edge | `src/core/ports/code-graph.port.ts:60-74,99`; adapter `codegraph.adapter.ts:298-305,336-348` |
| Edge filtering | `EDGE_POLICY`, `isIgnoredEdge`, `CALL_EDGE_KINDS` (`angular-template`, `angular-event`, `interface-impl` ignored) | `src/core/domain/impact/edge-policy.ts:14-61,82` |
| Unresolved calls: full spelling (`this.svc.get`), enclosing node, position, codegraph candidates | `unresolvedReferences(files)`, one store read per file | `code-graph.port.ts:76-84,101`; adapter `:306-318`; columns 0-based, `+1` only for syntax APIs (`inbound-edges.ts:378`) |
| Attribution of a call to its body | codegraph: anonymous arrows and function expressions keep their calls on the enclosing node; named nested functions and `const f = () => …` become their own nodes | `node_modules/@colbymchenry/codegraph-darwin-arm64/lib/dist/extraction/tree-sitter.js:6061-6065,6099` |
| Declaration spans | `GraphSymbol.startLine/endLine` via `symbolsInFiles` / `symbolsByIds` | `src/core/application/outline/outline.ts:13-27` |
| Snapshot export, trust, scope, live, store lifecycle, fact base, cuts | `createHeadReader(deps).atExport`, `try/finally` store close, `withCuts`, `Fact`, `Cut` | `src/core/application/outline/outline-queries.ts:18-54`; `src/core/domain/shared/fact.ts:114-128,159,214` |
| Name helpers for unresolved spellings | `referenceKey` (file, source, spelling, kind), `rootedName`, `nameTail`, `isBareName` | `src/core/domain/impact/impact-cuts.ts:61-99` |
| Budget fields and their cut mapping | `WALK_BOUND_FIELDS`, `WalkBounds`, `walkBounds`, cut kinds `depth` / `caller-budget` | `fact.ts:39-52`; `walk.ts:142-151`; `impact-queries.ts:78` |
| Import and global bindings, including `local-parameter` | `ImportOrigins.origins(sites)` | `src/core/ports/import-origins.port.ts:27-39`; `src/core/adapters/typescript/import-origins.adapter.ts:67` |
| HTTP and message call sites (slice 4) | `CallSiteReader.of(files, repo, libraries?)`; each `CallSite` carries `file`, `line`, `symbol`, `ancestors`, `target` | `src/core/domain/topology/call-site.ts:5-53` |

### 2.2 Extracted or extended

| Need | Today | Change |
|---|---|---|
| Root selection shared with `callers` | inlined in `impactOf`; accepts every declaration whose simple name matches (`joinsFact` ignores qualified names and overloads), and a range can select several | Extract the selection unchanged; `callers` keeps its semantics. Trace takes every selected declaration as a root (3.4) |
| Owner, members, supertypes (R2, R7) | closures in `createInboundEdges` (`inbound-edges.ts:81-206`), with per-node reads | Lift the direction-agnostic helpers into `core/application/navigation/`; the inbound-only parts (`followedEdgesInto`, `ownUsesOf`, `fieldUsesOf`, `bridgesOf`) stay |
| Name lookup (R6 member calls, R6b candidates) | no port method | `declarationsNamed(names)` on `CodeGraphReader`, over codegraph's public `getNodesByName` (one prepared SQL query per name, `db/queries.js:1147`); results cached per query; every match kept (overloads, members, top-level), then filtered by the declared scope |
| TS field receivers (R3) | `FieldOrigin` for every named class with an unreassigned `inject(T)` or `new T()` field; constructor injection only for framework-constructed classes (`angular-metadata.extractor.ts:247-273`) | Reused in slice 2; add the missing cases (`: T` locals and parameters, `const x = this.f`) |
| A repository import's declaration | `ImportOrigins` returns `repository{file}`, not the export (`src/core/domain/relations/resolved-reference.ts:15`) | Slice 2 adds the export lookup in the imported file (graph symbols of that file by exported name) |
| Java receivers and dispatch | inside the Spring adapter (`java-invocations.ts:30-68`, `java-members.ts:57-72`, `java-method-flow.ts:20-67`); `methodsOf` narrows by qualifier, `@Primary`, arity and bodies | Exposed through the `CallBindings` port by a new file in `core/adapters/spring/`; R7 semantics in 3.5 |
| Test fake | `fake-code-graph.testing.ts` implements the port and sets every edge column to `null` (`:43`) | Add `declarationsNamed`; let a fake edge carry a column |

### 2.3 New

| Piece | Layer |
|---|---|
| `TraceStep`, `TraceValue`, the walk's tree rules, folding, `readingPlan` | `core/domain/trace/` |
| Use case and query family | `core/application/trace/`, `core/ports/trace-queries.port.ts` |
| Slice 2: `CallBindings` port: for call places `{file, line, column, spelling}` it returns per receiver link `repository{file, symbol}` / `external{module, type?}` / `global{name}` / `local-parameter` / `unknown`, plus `deferred` | `core/ports/call-bindings.port.ts`; TS adapter on `sourceTree`, `findReferenceOccurrence`, `ImportOrigins`, the field-origin extractor; Java adapter in `core/adapters/spring/` over the existing helpers |

No new dependency.

## 3. Algorithm

### 3.1 Expansion of one declaration

1. **Body.** The declaration's own node. Anonymous callbacks are already attributed to it by codegraph. A named nested
   function or bound arrow is its own node: it becomes a child only when the body calls it, or (marked `deferred`) when
   the body references it as a value, for example passed as a callback. An unused nested function is never reached.
2. **Resolved calls (R1).** `outgoingEdges([node], ["calls", "instantiates"])` minus `isIgnoredEdge`.
3. **Unresolved calls.** `unresolvedReferences(file)` (cached per file for the query) restricted to `from = node` and
   call kinds; type uses and imports do not execute.
4. **Occurrence identity.** A reference is suppressed by an edge only when both have the same source, line and column
   and the edge's target name equals the reference's last name. An edge with null coordinates never suppresses. Chain
   links (`head().m()`) keep distinct names, so they stay distinct even at one position. Ties order by line, column,
   spelling, then target id.
5. **Settling, in RFC order.** R2 own-member (`this.m`, `this.m.rest` when the enclosing class declares `m`). R3-R5
   through `CallBindings` (slice 2). R6 closed world, **narrowed** (3.2). R6b otherwise: a cut `unresolved-link` at the
   place, candidates = codegraph's `candidates` ∪ `declarationsNamed`, sorted.

### 3.2 R6, narrowed to what a name lookup proves

A name lookup proves a call cannot reach repository code only when the name at the call is the name of the callee:

| Spelling | External leaf when | Otherwise |
|---|---|---|
| member call `x.m(...)` | no declaration within scope is named `m` | R6b cut |
| bare call `f(...)` | `ImportOrigins` says `external` or `ambient` | `local-parameter`, aliases and computed callees: cut (a repository function passed under another name runs repository code) |
| computed call `x[k](...)`, `(expr)(...)` | never | cut |

Slice 1 verifies with a real indexed fixture whether codegraph indexes object-literal property keys as declarations;
if not, a member call on an object literal that aliases a repository function is a declared limitation in the RFC. The
narrowing is recorded in RFC-0013 R6 with this table.

### 3.3 The walk: one canonical traversal

- Depth-first, pre-order, children in occurrence order. Depth, the `expansions` charge, cuts and `seen` are all decided
  during this traversal and nowhere else.
- A declaration is expanded at its first pre-order occurrence that lies within the bounds; later occurrences are `seen`
  pointing at it (R11; cycles end there). An occurrence stopped by a bound is a cut, not an expansion, so a later
  shallower occurrence can still expand it.
- Reads are cached per query (adjacency per node, references per file, names, symbols). Reads may be prefetched for a
  frontier, but prefetching only fills caches and never changes the tree. Prefetching is added only if measurements on
  the probe show per-node reads dominate.
- Bounds (R13): `depth` and `expansions` reuse `WalkBounds` and their cuts. They are unset by default because no
  measurement justifies a default; once set, nothing past them is read. `hubFanIn` counts callers and does not apply
  outbound, so the trace input schema omits it.
- Store lifecycle: `try/finally` close as in `outline-queries.ts:39`; cancellation through the request `signal`.

### 3.4 Roots

Every declaration the shared selection returns is a root: homonyms and overloads in one file, or each declaration a
line range selects. The result is a forest in line order with one shared `seen` map. The header states how many
declarations matched, so a homonym is visible rather than silently merged. An unmatched target is `unknown-symbol`
with candidates, as in `callers`.

### 3.5 Dispatch (slice 3)

R7: `alternatives` lists every implementation (TS: `typesAround` down + `methodsOf`; Java: the project hierarchy). The
step expands in place the one implementation when there is exactly one, or the one Spring's `DispatchIndex` proves
(qualifier, `@Primary`, a named bean), noting which proof chose it. With several and no proof, none is expanded and the
step carries a cut. RFC-0013 R7 is updated to say so.

### 3.6 Folding and the reading plan

- Folding (R10) applies only to a **proven terminal** step: expanded, with no children, no cut and no effect. Such a
  step becomes an entry `{symbol, file, start, end}` in its parent's `leaves`: the text shows the name only, and the
  `full` answer keeps the location so the agent can open it without another query. A step stopped by a bound, with an unresolved call in its body, or not
  expanded stays a step, because its body is exactly what the agent must read. External leaves group by module. Nothing
  is dropped.
- `readingPlan`: the roots and every non-folded, non-`seen` step, as `{file, start, end, steps}`. Ranges of one file
  that overlap or touch are merged. Files are ordered by their first pre-order appearance and ranges within a file by
  line, so the order is file-grouped rather than execution order; each range keeps its step ids, which point back to
  the tree. Folded terminal steps are excluded: they are named in the tree, and opening their bodies is a choice the
  agent makes from that name. The total line count is stated.

### 3.7 Answer and text

- `full`: `Fact<TraceValue>` with `readingPlan`.
- `summary`: header (roots, matches, status), the line "branches are not evaluated", effects (slice 4), the reading
  plan, and cuts as `file:line spelling (candidates)`.
- `details`: the summary plus the indented tree of the RFC "Text for the agent".

### 3.8 Effects (slice 4)

`CallSiteReader` runs with the same inputs `workspace-queries.ts:136` gives it (the repository's sources and libraries),
because its readers build module resolution, wrappers and field types from them. A site joins a step by declaration
identity: its `symbol` and `ancestors` against the step's qualified name, never by span alone, so an effect inside a
nested declaration is not attributed to its encloser. The cost is measured; caching the sites per snapshot content
needs evidence first. Data effects come only with a vocabulary admitted under ADR-0013.

## 4. Slices

| Slice | Delivers | Accepted by |
|---|---|---|
| 1 | Shared root selection, `navigation/` helpers, `declarationsNamed`, domain tree, folding and `readingPlan`, R1, R2, R6 narrowed, R6b, R8 order, R10, R11, R13; `ye_ast_trace` with compose, `ye-ast trace`, protocol `trace.walk`; schema minor bump | per-rule tests; real indexed fixtures for codegraph attribution (3.1) and object-literal keys (3.2); parity across CLI, protocol and MCP; settled share and cuts on the owner's probe workspaces recorded in the RFC |
| 2 | `CallBindings` and its TS and Java adapters; R3, R4, R5 (declared return types; codegraph `returns` edges first), `deferred` | per-binding-kind tests per language; settled share before and after on the same probe |
| 3 | R7 per 3.5; R9 roots from the entrypoints fact through its port, never its use case; UI roots after measuring codegraph's `angular-event` synthesized edges as the source of template handlers | the service checkout and page traces of the RFC acceptance table |
| 4 | R12 per 3.8 | each effect row of the acceptance table |

RFC-0013 is updated in slice 1: R3 moves to slice 2 (it needs the binding port), and R6 and R7 carry 3.2 and 3.5. If
cuts are most of the places on the probe after slice 1, slice 2 comes before any presentation work.

## 5. Files

New: `src/core/domain/trace/{trace-fact,trace-tree,reading-plan}.ts`, `src/core/ports/trace-queries.port.ts`,
`src/core/application/trace/{trace-queries,trace-walk}.ts`, `src/core/application/navigation/`, tests beside each.
Slice 2: `src/core/ports/call-bindings.port.ts`, `src/core/adapters/typescript/call-bindings.adapter.ts`,
`src/core/adapters/spring/java-call-bindings.adapter.ts`.

Edited: `code-graph.port.ts`, `codegraph.adapter.ts`, `fake-code-graph.testing.ts` (`declarationsNamed`, edge
columns); `impact-queries.ts` and `inbound-edges.ts` (extractions only); `fact.ts` (`DeclaredConfig` root, `SCHEMA`
minor; no store-version bump); `composition/{compose,measurement}.ts`; `cli/main.ts`;
`protocol/{protocol,params,query-server}.ts`; `mcp/{presentation,query-schema,query-runner,server,render}.ts`; the
compose files `mcp/{composition-input,compose-request,composition-normalize,composition-schema,composition-schema-parts,composition-contract,render-composition,composition-fixtures}.ts`;
`.dependency-cruiser.cjs` (`one-query-family-never-imports-another` covers `trace`); `docs/architecture/rfc/0002-facts-contract.md`
schema history; RFC-0013; README and site schema version; `AGENTS.md` command list.

## 6. Tests (one rule each, through the public seam)

Use case through `TraceQueries`:

- Steps and settling: a resolved call becomes a step at its call site; an ignored synthesizer is not a step; own-member
  settles `this.m`; a member call whose name no declaration has is an external leaf; a member call with repository
  declarations of that name is a cut listing them; a bare call through a parameter is a cut.
- Bodies, on real indexed fixtures: a call in an anonymous callback belongs to its encloser; a named callback passed as
  a value is a `deferred` step; an unused nested function is not reached; a called nested function is a step once.
- Order and occurrence identity: children follow line then column; `head().m()` keeps both links; repeated same-line
  calls, column zero and null-coordinate edges.
- Walk and bounds: a second occurrence is `seen`; a cycle ends at `seen`; the shared-target case (root → A, B;
  A → X → B) under `depth` and `expansions`; bounds cut with their limit and status `partial`; shuffled store order
  gives identical bytes.
- Folding: a proven terminal step folds; a step with an unresolved-only body or a bound-stopped child does not.
- Roots: homonyms and overloads give a forest; a range selecting two declarations gives two roots; an unknown symbol
  faults with candidates; an out-of-scope root is `unknown`.
- Lifecycle: success, store failure, cancellation, trusted live capture and an untrusted export.
- `readingPlan`: merges touching ranges, groups by first appearance, keeps step ids, excludes `seen` and folded steps.
- Adapter: `declarationsNamed` against a real indexed fixture.
- Regression: the `callers` and `impact` suites stay green after the extractions, plus one differential `callers` run on
  a probe repository before and after.

## 7. Risks

- Item 3 (contracts others consume): new MCP tool, CLI command, protocol method and schema minor bump. They are
  additions, but `ToolFamily` and the compose union are shared, so every exhaustive switch changes.
- The extractions touch `callers` and `impact`. They are behavior-preserving and go in their own commit before any
  trace code.
- On TypeScript, slice 1 will often answer `partial` (RFC probe: 5,562 resolved against 8,936 unresolved calls). The
  narrowed R6 turns more places into cuts than the RFC's R6 did. That is honest and measured, and it is what makes
  slice 2 likely the next priority.

## 8. Decisions (accepted by the owner, 2026-11-06)

| # | Question | Decision |
|---|---|---|
| Q1 | Where the Java binding reader lives | `core/adapters/spring/`, where the Java receiver code is; a new `java/` adapter would need a second adapter-to-adapter exception, and that list only shrinks |
| Q2 | Where the lifted navigation helpers live | `core/application/navigation/`, outside any query family, imported by `impact` and `trace`; keeping them in `impact` would need an exception to the family rule |
| Q3 | `trace` in `ye_ast_compose` from slice 1 | Yes: a trace is most useful composed with `callers` |
| Q4 | Reading-plan spans for folded terminal steps | Excluded from the reading plan, never dropped: they stay in the tree as `leaves` with their location in the `full` answer (3.6); only proven terminal steps fold |

## 9. Review resolution (GPT-6.1 Sol, high effort, 2026-11-06)

| Finding | Resolution |
|---|---|
| Transitive containment is not execution ownership | 3.1 step 1: own node only; nested declarations reached by call or by reference |
| Name absence does not prove an external call | 3.2: R6 narrowed per spelling; RFC R6 updated |
| BFS ownership versus pre-order `seen` breaks bounds | 3.3: one canonical DFS decides everything; prefetching only fills caches |
| Root selection is not one root | 3.4: a forest with a shared `seen`, matches stated |
| Folding hides unresolved or bounded steps | 3.6: only proven terminal steps fold |
| Span-only effect join misattributes | 3.8: join by symbol and ancestors, with full reader inputs |
| Coverage claims (field origins, import origins, Java `methodsOf`), missing files | 2.2, 3.5, section 5 corrected |
| Occurrence identity and null coordinates | 3.1 step 4 |
| Cost model | 3.3: per-query caches; prefetching only with measurements |
| Summary needs cut locations; reading order wording | 3.6, 3.7 |
