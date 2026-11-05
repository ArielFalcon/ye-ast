import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { compactInput, compactOutput } from "./compact-schema.ts";
import { createMcpServer, OUTLINE_OUTPUT, type McpDeps } from "./server.ts";
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
    const outputs = Buffer.byteLength(JSON.stringify(tools.map(tool => tool.outputSchema)));
    console.log(`discovery bytes: ${bytes}; input schema bytes: ${Buffer.byteLength(JSON.stringify(tools.map(tool => tool.inputSchema)))}; output schema bytes: ${outputs}; instructions chars: ${session.instructions?.length}`);
    assert.ok((session.instructions?.length ?? Infinity) <= 4000);
    assert.match(session.instructions!, /supply select and page together/);
    assert.ok(bytes <= 65_000);
    assert.ok(outputs <= 22_000);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(Object.keys(tool.inputSchema.properties ?? {}).length > 0);
      new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      for (const key of ["allOf", "anyOf", "oneOf", "if", "then", "else", "not"]) {
        assert.equal(key in tool.inputSchema, false, `${tool.name}: ${key}`);
      }
      const schema = JSON.stringify(tool.outputSchema);
      for (const field of ["snapshot", "status", "recovery", "evidence"]) {
        assert.ok(schema.includes(field), `${tool.name}: ${field}`);
      }
      new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
    }
  } finally { await session.close(); }
});

test("guide deliberately admits some invalid data while runtime validation remains exact", async () => {
  const schema = z.object({ value: z.string().min(3) });
  const wrapped = compactOutput(schema, "outline");
  const malformed = { mode: "full", status: "complete", snapshot: { kind: "sha", repo: "r", sha: "s" }, value: { files: [], unheld: [] } };
  assert.equal(new AjvJsonSchemaValidator().getValidator(wrapped["~standard"].jsonSchema.output({ target: "draft-07" }))(malformed).valid, true);
  assert.deepEqual(await wrapped["~standard"].validate(malformed), await schema["~standard"].validate(malformed));
  assert.ok(!schema.safeParse(malformed).success);
});

test("real family guide preserves the complete runtime validator behind the SDK boundary", async () => {
  const wrapped = compactOutput(OUTLINE_OUTPUT, "outline");
  const validateGuide = new AjvJsonSchemaValidator().getValidator(wrapped["~standard"].jsonSchema.output({ target: "draft-07" }));
  const snapshot = { kind: "sha", repo: "r", sha: "a".repeat(40) };
  const receipt = { mode: "summary", status: "complete", snapshot };
  assert.equal(validateGuide(receipt).valid, true);
  assert.equal(OUTLINE_OUTPUT.safeParse(receipt).success, true);
  assert.deepEqual(await wrapped["~standard"].validate(receipt), await OUTLINE_OUTPUT["~standard"].validate(receipt));
  const incomplete = { mode: "full", status: "complete", snapshot, value: { files: [], unheld: [] } };
  assert.equal(validateGuide(incomplete).valid, true);
  assert.equal(OUTLINE_OUTPUT.safeParse(incomplete).success, false);
  assert.deepEqual(await wrapped["~standard"].validate(incomplete), await OUTLINE_OUTPUT["~standard"].validate(incomplete));
  assert.equal(validateGuide({ ...receipt, status: "invented" }).valid, false);
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
