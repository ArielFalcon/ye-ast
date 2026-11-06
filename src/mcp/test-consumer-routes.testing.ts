import type { ToolResult } from "./test-session.testing.ts";

/**
 * Offline reproductions of what known MCP clients hand on from a `tools/call` result. Each one mirrors the cited source
 * of an exact release; they check the standard contract against real routes and are never used by the server.
 * Claude Code has also been probed separately with its installed binary and a simulated local provider.
 */
export type ConsumerRoute = { name: string; view: (result: ToolResult) => string };

const texts = (result: ToolResult): string => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

export const CONSUMER_ROUTES: readonly ConsumerRoute[] = [
  {
    /** codex rust-v0.166.0, codex-rs/protocol/src/models.rs `CallToolResult::as_function_call_output_payload`. */
    name: "codex 0.166 normal: non-null structuredContent as JSON, else content",
    view: (result) => result.structuredContent !== undefined && result.structuredContent !== null ? JSON.stringify(result.structuredContent) : texts(result),
  },
  {
    /** codex rust-v0.166.0, codex-rs/tools/src/tool_output.rs `code_mode_result`: the whole result without `_meta`. */
    name: "codex 0.166 code mode: result without _meta",
    view: ({ _meta: _private, ...visible }) => JSON.stringify(visible),
  },
  {
    /** opencode v2.2.5, packages/core/src/tool/mcp.ts and session/runner/to-llm-message.ts: the text content parts. */
    name: "opencode 2.2.5 normal: content",
    view: texts,
  },
  {
    /** opencode v2.2.5, packages/core/src/tool/mcp.ts `output()`: structured when present, else text; errors as text. */
    name: "opencode 2.2.5 code mode: structured value, else text",
    view: (result) => result.isError !== true && result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : texts(result),
  },
];
