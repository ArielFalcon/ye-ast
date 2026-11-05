# MCP public contract guides

Tool discovery advertises a concise JSON Schema guide to response envelopes,
snapshots, provenance, recovery, evidence, paging, and the major value fields.
It deliberately does not enumerate every nested node or enforce every runtime
constraint. Clients must not treat the advertised schema as exhaustive payload
validation. The original exported output schemas and Standard Schema runtime
validator still validate complete responses. Published input guides retain root properties, unconditional required fields, and nested schemas, while omitting root cross-parameter conditions. The server still validates the original input schema and all refinements; clients may accept combinations that the server rejects. Parameter guidance and initialization instructions describe these rules. Published guides do not change the structured payload or replay recipe. Recovery metadata has one copy at `structuredContent.recovery`; response text points to it.

Partial results contain useful evidence but have coverage cuts; unknown means
coverage is unknown, not that no impact exists. Projection availability is
separate from source analysis status. An available recovery supplies replay
arguments and an identity, while a page's nextCursor continues the same selection
and limit. The guide describes these concepts but does not prove a model will use
them correctly; client presentation and model behavior affect usefulness.

The `/work/shop`, version `0` discovery fixture measures the compact JSON bytes
of `{tools}` and all output schemas in `compact-schema.test.ts`. The original
exhaustive catalogue measured 1,177,416 bytes (1,134,623 output schemas); the
prior lossless compaction measured approximately 190 KB. Before the editorial reduction below, the guide measured 59,816 bytes for the catalogue, 33,289 bytes for the input-schema array, 20,960 bytes for the
output-schema array, and 3,995 initialization characters (previously 63,611, 37,084, 20,960 and 9,962 respectively), within budgets of 65 KB and 22 KB respectively; actual model context savings depend
on client handling.

Input publication uses ordinary JSON Schema root object properties rather than
consumer-specific metadata or settings. Nested parameter schemas remain intact;
only root composition and conditional keywords are omitted from the published
guide. Cross-parameter restrictions remain in the original Standard Schema
validator and are explained in the instructions and parameter guidance.

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
query dependencies throw if invoked. The seven-family catalogue before composition was 49,530 bytes,
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

`compact-schema.test.ts` preserves budgets of 50 KB for the original seven-family discovery and 19 KB for its
output-schema array. It checks essential
interpretation rules, reachable output definitions, family capabilities and
unchanged runtime validation. The 4x reduction target (about 15 KB) is indicative;
this unit does not reach it and does not remove further guidance merely to do so.
Serialized sizes do not establish model context, latency or model quality gains.
Live OpenCode, Claude Code and Codex integrations remain unverified.

### Composition discovery extension (2026-11-05)

The additional `ye_ast_compose` operation advertises its seven typed query alternatives rather than accepting
unvalidated fact blobs. `compactComposeOutput()` publishes a 2,564-byte guide; its full runtime validator retains all
22 part variants, provenance, source requests and graph/issue integrity. Runtime refinements remain authoritative;
published draft-7 schemas do not express cross-record ID checks.

The same measurement command now records eight operations and 74,198 catalogue bytes, with 48993 input-schema
bytes, 20471 output-schema bytes and 3,813 initialization characters. The composition entry contributes 24,667 bytes
(21,399 input, 2,564 output). This is an additional discovery cost, not a reduction. Tests preserve the original-family
budgets and separately cap composition's input guide at 40 KB, output guide below 4 KB and initialization at 3,900
characters. The original input constraint hashes remain unchanged.

Composition removes duplicate recorded entities/evidence in responses while retaining source supports, and can connect
compatible observations. Response savings depend on overlap and mode; normalized full tables and repeat recipes add
overhead, and the server reexecutes the supplied queries. Measure both channels, discovery and the entire acquisition
path when evaluating usefulness. Smaller details text in one fixture is not evidence of universal token or latency
savings, or of improved LLM conclusions.
