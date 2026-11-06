import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SCHEMA } from "../core/domain/shared/fact.ts";
import { createPatternRedaction } from "../core/adapters/redaction/pattern-redaction.adapter.ts";
import { createMcpServer, type McpDeps } from "../mcp/server.ts";
import { openSession, resultFields } from "../mcp/test-session.testing.ts";

const file = "src/main/java/example/OwnerRestControllerV1.java";
const imported = "src/main/java/example/AnotherServiceVersion2.java";
const secret = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456";
const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij123456";

const importOf = (path: string) => ({ line: 1, endLine: 1, specifier: "example.AnotherServiceVersion2", kind: "import", typeOnly: false, target: { kind: "repository", file: path }, bindings: [] });

test("outline preserves versioned source identities and redacts secrets through the MCP boundary", async () => {
  const deps = {
    version: "0.0.0",
    repository: { path: "/work/shop", repoId: "shop" },
    digest: { of: (value: string) => createHash("sha256").update(value).digest("hex") },
    redaction: createPatternRedaction(),
    outline: { outline: async () => ({ ok: true as const, value: {
      schema: SCHEMA, snapshot: { repo: "shop", kind: "sha" as const, sha: "a".repeat(40) },
      producer: { name: "ye-ast", version: "0.0.0" },
      inputs: { trust: "untrusted" as const, scope: "s", declaredScope: { languages: ["java"], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
      evidence: [], status: "complete" as const,
      value: { files: [{ file, declarations: [{ name: secret, kind: "class", line: 2, endLine: 8 }, { name: token, kind: "method", line: 4, endLine: 5 }], imports: [importOf(imported)] }], unheld: [] },
    } }) },
    entrypoints: {}, impact: {}, workspace: {}, workspaceImpact: {}, decisions: {},
  } as unknown as McpDeps;
  const session = await openSession(createMcpServer(deps));
  try {
    for (const mode of ["summary", "details", "full"] as const) {
      const result = await session.callTool("ye_ast_outline", { files: [file], mode });
      assert.equal(result.isError, undefined);
      const all = JSON.stringify(result);
      assert.ok(all.includes(file), mode);
      assert.ok(all.includes(imported), mode);
      assert.ok(!all.includes(secret), mode);
      assert.ok(!all.includes(token), mode);
      assert.ok(all.includes("[REDACTED]"), mode);
      if (mode === "full") {
        const value = (resultFields(result) as { value: { files: { file: string; declarations: { line: number; endLine: number }[]; imports: unknown[] }[] } }).value;
        assert.deepEqual(value.files[0]?.imports, [importOf(imported)]);
        assert.deepEqual([value.files[0]?.declarations[0]?.line, value.files[0]?.declarations[0]?.endLine], [2, 8]);
      }
    }
  } finally { await session.close(); }
});
