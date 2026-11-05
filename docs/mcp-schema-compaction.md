# MCP public contract guides

Tool discovery advertises a concise JSON Schema guide to response envelopes,
snapshots, provenance, recovery, evidence, paging, and the major value fields.
It deliberately does not enumerate every nested node or enforce every runtime
constraint. Clients must not treat the advertised schema as exhaustive payload
validation. The original exported output schemas and Standard Schema runtime
validator still validate complete responses. Published input guides retain root properties, unconditional required fields, and nested schemas, while omitting root cross-parameter conditions. The server still validates the original input schema and all refinements; clients may accept combinations that the server rejects. Parameter guidance and initialization instructions describe these rules. Payloads, text modes, and recovery behavior are unchanged.

Partial results contain useful evidence but have coverage cuts; unknown means
coverage is unknown, not that no impact exists. Projection availability is
separate from source analysis status. An available recovery supplies replay
arguments and an identity, while a page's nextCursor continues the same selection
and limit. The guide describes these concepts but does not prove a model will use
them correctly; client presentation and model behavior affect usefulness.

The `/work/shop`, version `0` discovery fixture measures the compact JSON bytes
of `{tools}` and all output schemas in `compact-schema.test.ts`. The original
exhaustive catalogue measured 1,177,416 bytes (1,134,623 output schemas); the
prior lossless compaction measured approximately 190 KB. The guide measures 59,816 bytes for the catalogue, 33,289 bytes for the input-schema array, 20,960 bytes for the
output-schema array, and 3,995 initialization characters (previously 63,611, 37,084, 20,960 and 9,962 respectively), within budgets of 65 KB and 22 KB respectively; actual model context savings depend
on client handling.

Input publication uses ordinary JSON Schema root object properties rather than
consumer-specific metadata or settings. Nested parameter schemas remain intact;
only root composition and conditional keywords are omitted from the published
guide. Cross-parameter restrictions remain in the original Standard Schema
validator and are explained in the instructions and parameter guidance.

The initialization fixture has a 4,000-character budget. The guide names routing,
coverage, repository and snapshot identity, trust, response modes, paired
selection/page controls and recovery. Detailed cut explanations remain available
with results rather than being repeated in the initial discovery manual.

Tests compile the public schemas with the SDK's Ajv validator, check visible root
parameters and verify that invalid combinations are rejected before query
execution. These are portable contract checks, not live integration tests of
OpenCode, Claude Code or Codex, and do not establish model interpretation quality.
