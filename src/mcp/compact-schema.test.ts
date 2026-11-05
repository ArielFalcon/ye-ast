import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { compactInput } from "./compact-schema.ts";
import { createMcpServer, type McpDeps } from "./server.ts";
import { openSession } from "./test-session.ts";

test("catalogue advertises useful guides within budget", async () => {
  const unused = <T extends object>(): T => new Proxy({} as T, {
    get() { throw new Error("unexpected query during discovery"); },
  });
  const session = await openSession(createMcpServer({
    entrypoints: unused<McpDeps["entrypoints"]>(),
    impact: unused<McpDeps["impact"]>(),
    outline: unused<McpDeps["outline"]>(),
    workspace: unused<McpDeps["workspace"]>(),
    workspaceImpact: unused<McpDeps["workspaceImpact"]>(),
    decisions: unused<McpDeps["decisions"]>(),
    digest: unused<McpDeps["digest"]>(),
    version: "0",
    repository: { path: "/work/shop", repoId: "shop" },
    redaction: {
      redact: value => value,
      redactError: value => String(value),
      redactValue: value => value,
      detect: () => ({ redacted: false, patterns: [], count: 0 }),
      containsSecret: () => false,
    },
  }));
  try {
    const tools = await session.listTools();
    const bytes = Buffer.byteLength(JSON.stringify({ tools }));
    const outputs = tools.reduce((sum, tool) => sum + (tool.outputSchema === undefined ? 0 : Buffer.byteLength(JSON.stringify(tool.outputSchema))), 0);
    console.log(`discovery bytes: ${bytes}; input schema bytes: ${Buffer.byteLength(JSON.stringify(tools.map(tool => tool.inputSchema)))}; output schema bytes: ${outputs}; instructions chars: ${session.instructions?.length}`);
    assert.ok((session.instructions?.length ?? Infinity) <= 3400);
    assert.match(session.instructions!, /supply select and page together/);
    for (const rule of [
      /Content carries presentation text[^\n]*result JSON/,
      /Recovery is the recovery field/,
      /unknown never means no impact/,
      /head and stateId/,
      /merge-base SHA/,
      /changed selects seeds, not consequence coverage/,
      /budget limits traversal, not response length/,
      /workspace origins use section owners/,
      /isError is a fault, not an empty fact/,
    ]) assert.match(session.instructions!, rule);

    assert.ok(bytes <= 32_000);
    assert.equal(outputs, 0);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(Object.keys(tool.inputSchema.properties ?? {}).length > 0);
      new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      assert.equal(createHash("sha256").update(JSON.stringify(canonicalConstraints(tool.inputSchema))).digest("hex"), INPUT_CONSTRAINTS[tool.name], `${tool.name}: argument contract`);
      for (const key of ["allOf", "anyOf", "oneOf", "if", "then", "else", "not"]) {
        assert.equal(key in tool.inputSchema, false, `${tool.name}: ${key}`);
      }
      assert.equal(tool.outputSchema, undefined);
    }
  } finally { await session.close(); }
});

test("input guide preserves root fields and delegates refinements", async () => {
  const original = z.strictObject({ a: z.string(), b: z.number().optional(), nested: z.object({ value: z.boolean() }) })
    .refine(value => !(value.a === "x" && value.b !== undefined))
    .meta({ allOf: [{ not: { required: ["a", "b"], properties: { a: { const: "x" } } } }] });
  const wrapped = compactInput(original);
  const raw = original["~standard"].jsonSchema.input({ target: "draft-07" });
  const guide = wrapped["~standard"].jsonSchema.input({ target: "draft-07" });
  for (const key of ["type", "properties", "required", "additionalProperties"]) assert.deepEqual(guide[key], raw[key]);
  const validate = new AjvJsonSchemaValidator().getValidator(guide);
  const bad = { a: "x", b: 1, nested: { value: true } };
  assert.equal(validate(bad).valid, true);
  assert.deepEqual(await wrapped["~standard"].validate(bad), await original["~standard"].validate(bad));
  assert.ok("issues" in await original["~standard"].validate(bad));
  assert.equal(validate({ ...bad, b: "invalid" }).valid, false);
});

const INPUT_CONSTRAINTS: Record<string, string> = {
  ye_ast_entrypoints: "03757c2aa7f4941dc35cfcaefdae1542276de4b33c2a7d0feea6523de2101bb1",
  ye_ast_impact: "03a47f4294d6ced7236d78981e41031ece9a0e8b1ee709076b1933f06f73e372",
  ye_ast_callers: "86de12422509f4746dbb220ac6fe12b4ad95e5a1dcb8ee3e5f322fd725eac66d",
  ye_ast_importers: "d99d6f4643edcc0cfd0114018fe1faa2a7a2df6e2930e2c767acd9960ae39aca",
  ye_ast_outline: "d99d6f4643edcc0cfd0114018fe1faa2a7a2df6e2930e2c767acd9960ae39aca",
  ye_ast_workspace: "be2953f74d297b7d286e974b18b488c4137a6f1f9c5c94385701b1fdd2893244",
  ye_ast_decisions: "be2953f74d297b7d286e974b18b488c4137a6f1f9c5c94385701b1fdd2893244",
};
function canonicalConstraints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConstraints);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalConstraints(child)]));
}
