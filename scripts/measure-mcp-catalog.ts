import { createMcpServer, type McpDeps } from "../src/mcp/server.ts";
import { openSession } from "../src/mcp/test-session.testing.ts";

const unused = <T extends object>(): T => new Proxy({} as T, {
  get() { throw new Error("Catalogue measurement must not execute queries"); },
});
const session = await openSession(createMcpServer({
  version: "0",
  repository: { path: "/work/shop", repoId: "shop" },
  entrypoints: unused<McpDeps["entrypoints"]>(),
  impact: unused<McpDeps["impact"]>(),
  outline: unused<McpDeps["outline"]>(),
  trace: unused<McpDeps["trace"]>(),
  workspace: unused<McpDeps["workspace"]>(),
  workspaceImpact: unused<McpDeps["workspaceImpact"]>(),
  decisions: unused<McpDeps["decisions"]>(),
  contractConsequences: unused<McpDeps["contractConsequences"]>(),
  digest: unused<McpDeps["digest"]>(),
  redaction: {
    redact: value => value,
    redactValue: value => value,
    redactError: value => String(value),
    detect: () => ({ redacted: false, patterns: [], count: 0 }),
    containsSecret: () => false,
  },
}));
const bytes = (value: unknown) => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
try {
  const tools = await session.listTools();
  console.log(JSON.stringify({
    fixture: { version: "0", path: "/work/shop", repoId: "shop" },
    toolCount: tools.length,
    catalogueBytes: bytes({ tools }),
    inputSchemaBytes: tools.reduce((sum, tool) => sum + bytes(tool.inputSchema), 0),
    outputSchemaBytes: tools.reduce((sum, tool) => sum + bytes(tool.outputSchema), 0),
    toolDescriptionBytes: tools.reduce((sum, tool) => sum + Buffer.byteLength(tool.description ?? ""), 0),
    instructionBytes: Buffer.byteLength(session.instructions ?? ""),
    instructionCharacters: session.instructions?.length ?? 0,
    tools: tools.map(tool => ({ name: tool.name, bytes: bytes(tool), inputBytes: bytes(tool.inputSchema), outputBytes: bytes(tool.outputSchema) })),
  }, null, 2));
} finally { await session.close(); }
