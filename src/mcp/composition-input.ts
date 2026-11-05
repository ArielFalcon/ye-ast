/**
 * The runtime input contract of `ye_ast_compose`: a closed union of the seven query families, each a strict
 * object whose `arguments` reuse the family's semantic schema and refinements exactly, so no presentation or recovery
 * control, nested composition or unknown field is accepted. Only the three recoverable families admit an `mcp-r1`
 * assertion. The byte limit is checked by the coordinator, which reports it as a typed fault rather than a schema error.
 */
import { z } from "zod";
import { SEMANTIC_INPUTS, type RecoverableFamily } from "./query-schema.ts";
import { responseModeSchema, type ToolFamily } from "./presentation.ts";
import { compositionIdSchema } from "./composition-id-schema.ts";

/** Operational limits of version 1; they bound transport and fan-out, not evidence or output size. */
export const COMPOSE_LIMITS = {
  minQueries: 1,
  maxQueries: 16,
  /** UTF-8 bytes of `canonicalJson(input)`, inclusive. */
  maxRequestBytes: 1_048_576,
  maxDeadlineMs: 2_147_483_647,
} as const;

/** Same accepted set and published pattern as the original tools' `expect` (`RESULT_IDENTITY_PATTERN`). */
const sourceExpect = compositionIdSchema("mcp-r1").describe("Assert this source's complete public resultIdentity, as the original tool's expect does.");
const compositionExpect = compositionIdSchema("mcp-c1").describe("Assert the identity of the whole composition (verification.identity).");

function recoverable<F extends RecoverableFamily>(family: F) {
  return z.strictObject({ name: z.literal(`ye_ast_${family}` as const), arguments: SEMANTIC_INPUTS[family], expect: sourceExpect.exactOptional() });
}
function fresh<F extends Exclude<ToolFamily, RecoverableFamily>>(family: F) {
  return z.strictObject({ name: z.literal(`ye_ast_${family}` as const), arguments: SEMANTIC_INPUTS[family] });
}

/** One query of a composition; the runtime counterpart of `ComposeQuery`. */
export const COMPOSE_QUERY = z.discriminatedUnion("name", [
  recoverable("entrypoints"),
  recoverable("impact"),
  recoverable("callers"),
  fresh("importers"),
  fresh("outline"),
  fresh("workspace"),
  fresh("decisions"),
]);

export const COMPOSE_INPUT = z.strictObject({
  queries: z
    .array(COMPOSE_QUERY)
    .min(COMPOSE_LIMITS.minQueries)
    .max(COMPOSE_LIMITS.maxQueries)
    .describe("1..16 typed queries of the seven families, before deduplication; executed sequentially in a fixed order."),
  mode: responseModeSchema,
  expect: compositionExpect.exactOptional(),
  deadlineMs: z.int().min(1).max(COMPOSE_LIMITS.maxDeadlineMs).exactOptional().describe("Batch deadline in milliseconds; no default."),
});
