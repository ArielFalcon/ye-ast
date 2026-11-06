# MCP public contract guides

Tool discovery publishes compact input guides; output schemas are no longer advertised. The original exported output
schemas validate the complete canonical response on the server. Input guides retain root properties, unconditional
required fields, nested schemas and declared cross-parameter conditions. The server validates the original input schema
and refinements; discovery exposes selection/page, owner/workspace and live/revision restrictions as well. Opaque replay
and composition argument objects still require the original server validators for their internal structure.
Each success delivers its presentation and result fields in one content block, including one recovery field.

Partial results contain useful evidence but have coverage cuts; unknown means
coverage is unknown, not that no impact exists. Projection availability is
separate from source analysis status. An available recovery supplies replay
arguments and an identity, while a page's nextCursor continues the same selection
and limit. The instructions describe these concepts but do not prove a model will use
them correctly; client presentation and model behavior affect usefulness.

The following sections document earlier experiments. The `/work/shop`, version `0` discovery fixture measures the compact JSON bytes
of `{tools}` and all output schemas in `compact-schema.test.ts`. The original
exhaustive catalogue measured 1,177,416 bytes (1,134,623 output schemas); the
prior lossless compaction measured approximately 190 KB. Before the editorial reduction below, the guide measured 59,816 bytes for the catalogue, 33,289 bytes for the input-schema array, 20,960 bytes for the
output-schema array, and 3,995 initialization characters (previously 63,611, 37,084, 20,960 and 9,962 respectively), within budgets of 65 KB and 22 KB respectively; actual model context savings depend
on client handling.

Input publication uses ordinary JSON Schema root object properties rather than
consumer-specific metadata or settings. Nested parameter schemas remain intact except for the explicitly opaque replay
and composition arguments described below. Declared cross-parameter restrictions are published with the SDK's JSON Schema
2020-12 dependencies and conditions, and remain enforced by the original Standard Schema validator. Clients that ignore
these keywords still receive contextual server validation errors. Compatibility with each live client is not established
by the offline schema tests.

The initialization fixture has a 3,400-character budget. The guide names routing,
coverage, repository and snapshot identity, trust, response modes, paired
selection/page controls and recovery. Detailed cut explanations remain available
with results rather than being repeated in the initial discovery manual.

Tests compile the public schemas with the SDK's Ajv validator, check visible root
parameters and verify that invalid combinations are rejected before query
execution. These are portable contract checks, not live integration tests of
OpenCode, Claude Code or Codex, and do not establish model interpretation quality.

### Reduction measurement (2026-11-05)

Run `node --import tsx scripts/measure-mcp-catalog.ts` to reproduce discovery with
version `0` and repository `/work/shop`. It sends only initialize and tools/list;
query dependencies throw if invoked. The current catalogue is 49,530 bytes,
with 27,594 input-schema bytes, 17,907 output-guide bytes and 2,835 bytes of tool
description text (schema sums exclude array punctuation). Initialization is
3,388 characters. The original comparison fixture was 59,816 bytes and 3,995
initialization characters; the first editorial pass reached 58,581 bytes.
The historical exhaustive catalogue was 1,177,416 bytes.

This unit shortens parameter and routing prose, limits recovery/projection
advertising to the three tools that support them, removes unused output
definitions and avoids describing a source analysis summary as a whole fact.
The response-channel paragraph explaining receipts, full results and the single
recovery location is preserved. All published input constraints are unchanged:
tests compare their canonical hashes with the pre-reduction fixture, excluding
only description annotations. Nested selectors, enums, bounds and required fields
remain available without a separate help call.

`compact-schema.test.ts` enforces budgets of 50 KB for discovery, 19 KB for the
output-schema array and 3,400 initialization characters. It checks essential
interpretation rules, reachable output definitions, family capabilities and
unchanged runtime validation. The 4x reduction target (about 15 KB) is indicative;
this unit does not reach it and does not remove further guidance merely to do so.
Serialized sizes do not establish model context, latency or model quality gains.
Live OpenCode, Claude Code and Codex integrations remain unverified.


### Local-reference prototype (2026-11-05)

A prototype shared identical input schema subtrees within each tool using local
`definitions` references, retaining root properties and the original runtime
validators. On the same fixture it reduced discovery from 49,530 to 49,015 bytes
(515 bytes, approximately 1.0%); the input schema array fell from 27,602 to
27,087 bytes including array punctuation. Output and initialization were
unchanged. This small saving did not justify adding a serializer and relying on
client reference presentation, so the prototype was not retained. The 4x
indicative target remains unmet. No live client or model-quality claim follows
from this experiment.


### Discriminator-union prototype (2026-11-05)

A second temporary prototype grouped object variants that differed only in a
`kind` constant into a shared shape with an enum. On the same 49,530-byte main
fixture it found three groups and produced 49,188 bytes, saving 342 bytes (0.7%).
It visited schema positions rather than instance examples or defaults. This was
a size experiment, not a completed semantic-equivalence or client-quality proof;
no production transformation was retained.

Together with the local-reference result, this gives no evidence for a worthwhile
further lossless serializer at the current boundary. It does not establish a
universal minimum size. Further changes that replace nested argument formats with
prose or hide replay/selection structure require separate usability evidence;
they must not be counted as information-preserving merely because runtime
validation stays on the server. The catalogue remains 49,530 bytes.


### Single content delivery (2026-11-05)

Each success delivers presentation followed by a `result JSON:` line with its sibling fields in one text block. Findings,
recovery and full data appear once. Faults retain their `fault fields:` line. This framing is server-specific; a whole
text block is not directly JSON-parsable. No `structuredContent` or `outputSchema` is advertised, so consumers lose
published output types and client-side validation against an advertised schema. Before sending success, the server
validates the complete canonical result against the original per-family Zod schema, including selected pages.

The offline consumer routes reproduce Codex 0.166 and OpenCode 2.2.5 normal and code-mode fallbacks to content.
Claude Code 2.1.318 was also exercised with its installed binary and a local simulated Messages API provider, with no
external inference: summary, full and result-changed fault reached the next provider request with findings, recovery,
full value and fault fields as applicable. These checks do not measure model interpretation or adoption.

Discovery measures 31,280 bytes (input schemas 27,363 bytes, output schemas 0, instructions 3,323 characters) using
`scripts/measure-mcp-catalog.ts`; the catalogue budget is 32,000 bytes. The previous dual-channel catalogue measured
51,256 bytes. Response delivery also removes the duplicate wire channel; no cross-version token estimate is implied.


### Composition operation (2026-11-05)

`ye_ast_compose` publishes its seven typed query alternatives as one input guide instead of accepting unvalidated fact
blobs, and follows the single content delivery above: no `outputSchema`, and summary/details/full results in the
`result JSON:` line. Before delivery the server validates every composition against its complete runtime schema, which
keeps all 23 part variants, provenance, source requests and graph/issue reference integrity.

With the composition entry, `scripts/measure-mcp-catalog.ts` records eight operations and 53,335 catalogue bytes
(48,729 input-schema bytes, no output schemas, 3,760 instruction characters). The composition entry contributes
22,054 bytes (21,366 input). This is an additional discovery cost, not a reduction. `compact-schema.test.ts` keeps the
32,000-byte budget for the seven original families, caps composition's input guide at 40 KB and initialization at
3,900 characters, and keeps the original input constraint hashes unchanged.

Composition removes duplicate recorded entities and evidence while retaining source supports, and can connect
compatible observations. Response savings depend on overlap and mode; normalized full tables and repeat recipes add
overhead, and the server reexecutes the supplied queries. Measure the whole content block, discovery and the entire
acquisition path when evaluating usefulness. Smaller details text in one fixture is not evidence of universal token or
latency savings, or of improved model conclusions.


### Discovery guidance rewrite (2026-11-05)

The instructions are reorganized around agent tasks: a "when to call" line per tool, then reading answers,
repositories and snapshots, narrowing and paging, and errors. Every rule the budget test checks is kept; the text stays
within the 3,900-character budget (3,749 characters). Two rules moved to the answers that already carry them at the
point of use: how to repeat a composition (S# legend, verification.identity as expect) and which owner each selection
kind takes; the instructions keep the paired select/page rule and point to the answers for coordinates and owners. Tool descriptions lead with when to use the tool and drop the
completeness sentence the instructions already state.

`ye_ast_compose` publishes the nested query shapes without their descriptions: each query's arguments are the semantic
arguments of the named tool, whose own entry in the same catalogue describes them. The `queries` description itself
stays. Structure, enums, bounds and required fields are unchanged; `compact-schema.test.ts` pins the canonical
constraint hash of the composition guide beside those of the seven families. A client that loads `ye_ast_compose`
without the other tools sees every field, but not its explanation.

`scripts/measure-mcp-catalog.ts` records 43,064 catalogue bytes (previously 53,335, about 19% less) and 38,997
input-schema bytes. Shortening the shared parameter descriptions saved about 190 bytes; the rest comes from the
composition guide. Model interpretation and adoption are not measured by this change.

Internal shorthand in the published guidance was replaced with plain definitions: seeds (the diff paths that start
the walk), manifests kept readable under include, per-repository section and file-read limits, base-side line numbers
from the merge-base commit, and head/stateId as the identity of a captured working tree. The catalogue measures 43,152
bytes.


### Opaque composition arguments and replay (2026-11-06)

A bounded A/B run (`ye-ast_test` run `20261105T221452Z-slim-catalogue-ab-347195`; 12 explicit-use sessions, one
repository, one model, exploratory) compared the 43,152-byte catalogue with a slim variant. All sessions answered
correctly. Agents copied `replay` verbatim from recovery recipes with or without its published shape, and composed
queries at least as well with generic `queries[].arguments`. A loose `select` cost extra calls in both sessions that
needed it, so `select` keeps its full published shape.

`compactInput` therefore publishes `ye_ast_compose` `queries[].arguments` and the `replay` of `ye_ast_callers` and
`ye_ast_impact` as described objects; the server validates both against the original schemas, so a malformed value
is still refused before any query runs. The published guide accepts any object there; tests assert the server
refusal instead. The superseded composition description stripping is removed.

Two `select` aids came out of the same run: an invalid `select` now names every selection shape its tool accepts
(previously `select: Invalid input`), and full answers with cuts print a copyable `cut-places` lookup example when
selection is available. `scripts/measure-mcp-catalog.ts` records 32,958 catalogue bytes. Codex reported unchanged
input tokens between catalogues in that run, so the effect on model context depends on the client.
