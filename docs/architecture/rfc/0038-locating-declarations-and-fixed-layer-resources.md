# RFC-0038: Locating a declaration by name, and the fixed layer as MCP resources

- Status: Draft, 2026-11-13
- Related: ADR-0013 (decision 1: a new family needs an ADR), ADR-0032, ADR-0051, RFC-0005, RFC-0015, RFC-0017, RFC-0029,
  RFC-0030, RFC-0031, ADR-0078 (the decision this RFC designs)

**In short:** every tool of the MCP takes a coordinate, a file and a symbol, and none gives one. An agent that knows
only a name guesses the path, and the guess faults. In the agent evaluation of 2026-11-08, 28% of the calls to the
engine faulted and every `unknown-symbol` fault came from a path the agent invented. Half of the fallbacks to plain
search happened where a tool covered the need and the agent never tried it. This RFC adds the one missing step, a
query that turns a name into coordinates, and exposes the fixed layer `ye-ast init` already writes as MCP resources,
so a session can start oriented.

## Problem

| Fact | Evidence |
|---|---|
| The MCP registers ten tools; each query tool takes coordinates | `src/mcp/server.ts:604-722` |
| It registers no resource and no prompt | no `registerResource` or `registerPrompt` under `src/mcp/` |
| The store can already answer "every declaration of this name" | `declarationsNamed`, `src/core/ports/code-graph.port.ts:102`; used inside trace only (`trace-walk.ts:217,237,245`) |
| A fault for an unknown symbol lists the file's candidate declarations | `src/core/domain/impact/impact-fact.ts:115` |
| `ye-ast init` writes the entrypoints fact and its digest under `.ye-ast/` | `src/core/application/fixed-layer/fixed-layer-admin.ts:9-10` |
| The tool catalogue is 33,807 bytes against a tested ceiling of 36,100 | `docs/evaluations/trace-quality/2026-11-07-findings.md:139`, `src/mcp/compact-schema.test.ts:60` |

From the agent evaluation of 2026-11-08 (296 graded needs in 110 sessions; the run is kept outside the repository):

| Finding | Number |
|---|---|
| Calls to the engine that faulted | 28% |
| `unknown-symbol` faults caused by a guessed or nonexistent path | 29 of 29 |
| Sessions that recovered from such a fault | 20 of 23 |
| Fallbacks to search where a family covered the need and the agent did not try it | 61, or 52% of the addressable fallbacks |
| Needs no family covers (reading source, configuration, literals) | 72 |

RFC-0029 and RFC-0030 already address the largest group of that evaluation, answers that hid or misstated a held fact.
What remains on the surface is the entry: finding the coordinate, and knowing which tool to try.

## Part A: the `locate` family

### What it answers

Names and path fragments in, coordinates out. Nothing is ranked by a score.

| Input | Output |
|---|---|
| `names`: one or more simple or qualified names | per name, the declarations: file, symbol path, kind, start and end line, and the class of the match |
| `paths`: one or more path fragments | per fragment, the files whose repository-relative path ends with it or contains it as whole segments |
| the scope every family takes (`include`, `exclude`) | applied before matching |

| Match class | Meaning |
|---|---|
| `exact` | the declared name equals the input |
| `qualified` | the input is a qualified name and its last segments equal the declaration's owner path and name |
| `case` | equal but for letter case |

Rules:

1. Deterministic: matches sorted by class, then file, line and symbol. No fuzzy distance and no score. A match class
   is a fact about two strings.
2. Declarations come from the declaration model every family shares (RFC-0027), so a coordinate `locate` returns is
   one every other tool accepts.
3. Completeness follows the facts contract: a snapshot with files the index does not hold answers `partial` with the
   cut that says so, never a shorter list.
4. A name with no declaration answers an empty list for that name with status `complete`. "No declaration of this name
   in the indexed snapshot" is a fact.
5. No default bound on the answer. A host that declares a bound gets the shorter projection or a refusal (ADR-0051).

### Why a family and not a field

ADR-0013 decision 1 asks for an ADR for a new family. `locate` asserts something no existing family does: "these are
all the declarations of that name". It needs its own completeness rule, so it is a family, and ADR-0078 is its ADR.
ADR-0032 then applies: the family is done when the library, the CLI, the query protocol and the MCP expose it.

### Faults use it

A fault that rejects a coordinate carries what `locate` would answer for it:

| Fault | Carries |
|---|---|
| A file no commit entry holds (ADR-0051) | the files whose path ends with the same segments |
| `unknown-symbol` | today's candidates of the file, plus the declarations of that name in other files |

One owner writes fault text (RFC-0029); it calls the same matcher. An agent that guessed a path gets the right one in
the fault and does not need a second call.

### The catalogue budget

The new tool must fit under the tested ceiling. Its description is written against the measured bytes
(`scripts/measure-mcp-catalog.ts`); if it does not fit, guidance repeated across tools is centralized further, as the
2026-11-07 work did. The ceiling is not raised to make room.

## Part B: the fixed layer as resources

| Resource | Content | Source |
|---|---|---|
| The entrypoints fact | the same bytes `ye-ast init` writes | `FixedLayerStore` |
| Its digest | the same bytes | `FixedLayerStore` |
| The workspace overview, when a workspace is declared | repositories, pinned revisions and link counts by transport | the `workspace` family |

Rules:

1. A resource is read-only and is a projection of a fact a family already answers. It adds no write and no new fact.
2. The MCP entrypoint still receives only read query families. The fixed layer is read through its store port.
3. A resource states the snapshot it reflects. A stale fixed layer says so, as the CLI does for a stale live answer.
4. Nothing is added to the server's `instructions` beyond naming the resources.

Whether clients read resources unprompted is not known. The outcome control (RFC-0031) measures it: the share of
addressable needs where the agent did not try the covering family, before and after.

## What this RFC does not do

- It adds no tool that reads source text, configuration or literals. Those 72 needs belong to the agent's own tools.
- It sets no default answer size.
- It does not change what `impact` says about tests. `impact` already classifies test files
  (`src/core/application/impact/impact-queries.ts:279`); whether the answer should group them is a presentation
  question for RFC-0029's owner.

## Slices

| # | Slice | Proof |
|---|---|---|
| 1 | The matcher in the domain, pure, with its three classes | unit tests per class and per ordering rule |
| 2 | The `locate` family, its port, CLI command and MCP tool | conformance fixtures per language pack; catalogue bytes under the ceiling |
| 3 | Faults carry the matcher's answer | the fault share of calls in the outcome control |
| 4 | The resources | the adoption measure of the outcome control |

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Does `locate` match a substring of a name? | No. Substring matching returns noise that grows with the repository and needs a rank to be usable. A `case` and a `qualified` class cover the measured failures, which were wrong paths, not partial names |
| 2 | Does `locate` search across the repositories of a workspace? | Yes when a workspace is declared, with the repository on each match. Cross-repository work is where an agent knows a name and not its repository |
| 3 | Are prompts registered too? | No. A prompt is guidance for one client's interface; nothing measured asks for it |
| 4 | Is Part B worth building before the outcome control exists? | Build Part A first. Part B waits for the baseline, since its only evidence is an adoption number that the control must show moving |
