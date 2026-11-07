import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { compactInput, crossField } from "./compact-schema.ts";
import { createMcpServer, type McpDeps } from "./server.ts";
import { openSession } from "./test-session.testing.ts";
import { TOOL_INPUTS } from "./query-schema.ts";
import type { ToolFamily } from "./presentation.ts";

function discoveryServer() {
  const unused = <T extends object>(): T => new Proxy({} as T, {
    get() { throw new Error("unexpected query during discovery"); },
  });
  return createMcpServer({
    entrypoints: unused<McpDeps["entrypoints"]>(),
    impact: unused<McpDeps["impact"]>(),
    outline: unused<McpDeps["outline"]>(),
    trace: unused<McpDeps["trace"]>(),
    workspace: unused<McpDeps["workspace"]>(),
    workspaceImpact: unused<McpDeps["workspaceImpact"]>(),
    contractConsequences: unused<McpDeps["contractConsequences"]>(),
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
  });
}

test("catalogue advertises useful guides within budget", async () => {
  const session = await openSession(discoveryServer());
  try {
    const tools = await session.listTools();
    const bytes = Buffer.byteLength(JSON.stringify({ tools }));
    const outputs = tools.reduce((sum, tool) => sum + (tool.outputSchema === undefined ? 0 : Buffer.byteLength(JSON.stringify(tool.outputSchema))), 0);
    console.log(`discovery bytes: ${bytes}; input schema bytes: ${Buffer.byteLength(JSON.stringify(tools.map(tool => tool.inputSchema)))}; output schema bytes: ${outputs}; instructions chars: ${session.instructions?.length}`);
    assert.ok((session.instructions?.length ?? Infinity) <= 4200);
    assert.match(session.instructions!, /supply select and page together/);
    for (const rule of [
      /Content carries presentation text[^\n]*result JSON/,
      /Recovery is the recovery field/,
      /unknown never means no impact/,
      /head and stateId/,
      /merge-base commit/,
      /changed picks the diff paths that start the walk \(the seeds\); unlike scope, it does not limit where consequences are found/,
      /budget limits traversal, not response length/,
      /isError is a fault, not an empty fact/,
    ]) assert.match(session.instructions!, rule);

    const originals = tools.filter(tool => tool.name !== "ye_ast_compose");
    assert.ok(Buffer.byteLength(JSON.stringify({ tools: originals })) <= 41_000);
    assert.equal(outputs, 0);
    const compose = tools.find(tool => tool.name === "ye_ast_compose");
    assert.ok(compose);
    assert.equal(compose.outputSchema, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(compose.inputSchema)) < 40_000);
    assert.equal(compose.inputSchema.type, "object");
    assert.ok(compose.inputSchema.properties?.queries);
    assert.equal(createHash("sha256").update(JSON.stringify(canonicalConstraints(compose.inputSchema))).digest("hex"), COMPOSE_CONSTRAINTS, "ye_ast_compose: argument contract");
    const variants = (compose.inputSchema.properties.queries as { items: { oneOf: { properties: Record<string, { const?: string; type?: string; description?: string }> }[] } }).items.oneOf;
    assert.deepEqual(variants.map((variant) => variant.properties["name"]?.const), Object.keys(INPUT_CONSTRAINTS));
    for (const variant of variants) {
      assert.equal(variant.properties["arguments"]?.type, "object");
      assert.match(variant.properties["arguments"]?.description ?? "", /tool named in name/);
    }
    new AjvJsonSchemaValidator().getValidator(compose.inputSchema);
    for (const tool of originals) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(Object.keys(tool.inputSchema.properties ?? {}).length > 0);
      new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      assert.equal(createHash("sha256").update(JSON.stringify(canonicalConstraints(tool.inputSchema))).digest("hex"), { ...INPUT_CONSTRAINTS, ...CONSEQUENCES_CONSTRAINTS }[tool.name], `${tool.name}: argument contract`);
      for (const key of ["allOf", "anyOf", "oneOf"]) {
        assert.equal(key in tool.inputSchema, false, `${tool.name}: ${key}`);
      }
      assert.equal(tool.outputSchema, undefined);
    }
  } finally { await session.close(); }
});

test("listed input schemas reject exactly the cross-field combinations the runtime rejects", async () => {
  const session = await openSession(discoveryServer());
  try {
    const tools = new Map((await session.listTools()).map((tool) => [tool.name, tool.inputSchema]));
    const replay = { version: 1, declaration: `ws-r1:${"c".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha", sha: "a".repeat(40) }] };
    const targets = [{ file: "src/S.java", symbol: "S.find" }];
    const hypothesis = { method: "GET", path: "/o", target: "response", property: "name", change: "nullable" };
    const cut = (owner: object) => ({ kind: "cut-places", owner, cutIndex: 0 });
    const handler = (owner: object) => ({ kind: "handler-origins", owner, handler: { path: "a", symbol: "h", line: 1 } });
    const page = { limit: 1 };
    const cases: [ToolFamily, Record<string, unknown>, boolean][] = [
      ["callers", { targets, select: cut({ kind: "fact" }), page }, true],
      ["callers", { targets, select: cut({ kind: "fact" }) }, false],
      ["callers", { targets, page }, false],
      ["callers", { targets, select: cut({ kind: "section", repo: "r" }), page }, false],
      ["callers", { targets, workspace: {}, select: cut({ kind: "section", repo: "r" }), page }, true],
      ["callers", { targets, select: { kind: "workspace-link-evidence", linkId: "l" }, page }, false],
      ["callers", { targets, workspace: {}, select: { kind: "workspace-link-evidence", linkId: "l" }, page }, true],
      ["impact", { base: "main", select: handler({ kind: "local" }), page }, true],
      ["impact", { base: "main", workspace: {}, select: handler({ kind: "local" }), page }, false],
      ["impact", { base: "main", workspace: {}, select: handler({ kind: "section", repo: "r" }), page }, true],
      ["entrypoints", { select: cut({ kind: "entrypoints" }), page }, true],
      ["entrypoints", { live: true, revision: "main" }, false],
      ["entrypoints", { live: true }, true],
      ["entrypoints", { revision: "main" }, true],
      ["impact", { base: "main", live: true, head: "x" }, false],
      ["callers", { targets, replay }, false],
      ["callers", { targets, replay, workspace: {} }, true],
      ["impact", { base: "main", workspace: {}, live: false }, false],
      ["impact", { base: "main", live: true, offline: true }, false],
      ["impact", { base: "main", live: true, offline: true, workspace: {} }, true],
      ["impact", { base: "main", offline: true }, true],
      ["outline", {}, false],
      ["outline", { files: ["a.ts"], focus: [{ file: "a.ts", line: 1 }] }, false],
      ["outline", { focus: [{ file: "a.ts", line: 1 }] }, true],
      ["workspace", { live: true, revision: "main" }, false],
      ["workspace", { repos: [{ path: "/w/a", live: true, revision: "main" }] }, false],
      ["workspace", { repos: [{ path: "/w/a", live: true }] }, true],
      ["contract_consequences", { hypotheses: [hypothesis] }, true],
      ["contract_consequences", { hypotheses: [hypothesis], live: true }, true],
      ["contract_consequences", { base: "main", head: "x" }, true],
      ["contract_consequences", {}, false],
      ["contract_consequences", { hypotheses: [] }, false],
      ["contract_consequences", { hypotheses: [hypothesis], base: "main" }, false],
      ["contract_consequences", { hypotheses: [hypothesis], head: "x" }, false],
      ["contract_consequences", { base: "main", revision: "main" }, false],
      ["contract_consequences", { base: "main", live: true }, false],
      ["contract_consequences", { base: "main", live: false }, true],
      ["contract_consequences", { hypotheses: [hypothesis], live: true, revision: "main" }, false],
    ];
    for (const [family, args, expected] of cases) {
      const listed = new AjvJsonSchemaValidator().getValidator(tools.get(`ye_ast_${family}`)!)(args).valid;
      const runtime = TOOL_INPUTS[family].safeParse(args).success;
      assert.deepEqual([listed, runtime], [expected, expected], `${family} ${JSON.stringify(args)}`);
    }
  } finally { await session.close(); }
});

test("input guide publishes declared cross-field constraints on a plain root and refuses root combinators", async () => {
  const original = z.strictObject({ a: z.string(), b: z.number().optional(), nested: z.object({ value: z.boolean() }) })
    .refine(value => !(value.a === "x" && value.b !== undefined))
    .meta(crossField({ dependentSchemas: { b: { properties: { a: { not: { const: "x" } } } } } }));
  const wrapped = compactInput(original);
  const raw = original["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  const guide = wrapped["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  for (const key of ["type", "properties", "required", "additionalProperties"]) assert.deepEqual(guide[key], raw[key]);
  const validate = new AjvJsonSchemaValidator().getValidator(guide);
  const bad = { a: "x", b: 1, nested: { value: true } };
  assert.equal(validate(bad).valid, false);
  assert.ok("issues" in await wrapped["~standard"].validate(bad));
  assert.equal(validate({ ...bad, a: "y" }).valid, true);
  const combined = compactInput(z.strictObject({ a: z.string() }).meta({ allOf: [{ required: ["a"] }] }));
  assert.throws(() => combined["~standard"].jsonSchema.input({ target: "draft-2020-12" }));
});

const INPUT_CONSTRAINTS: Record<string, string> = {
  ye_ast_entrypoints: "8f421b1b0957fe152f97695f9271762b4987b909127280814f624915062bc9c3",
  ye_ast_impact: "e8762e053413754ce955349bcd9b47ba18bdda46a269ac2b6508d605983c994b",
  ye_ast_callers: "7ee67eedc7880c1bf1e5b7beb1d3f65de5d1ef7440de26963cc554ac217f8259",
  ye_ast_importers: "5c8a30a8565d803f111f7c0878aab0c64f902e7b58f1bb9731a7ae2c75781022",
  ye_ast_outline: "2f1a5187e37a9f464453fcc2adb15c02b469b798a37de7c5c32f6cf81a612109",
  ye_ast_trace: "2de47807688347b35b5176925c11d8c6edc791e9c2d4be4bc5e817fa9c14024a",
  ye_ast_workspace: "a3eb1c0ee1dbf6c86080e0215b48283bcd1d26de492fbd78d558ba49b2ee7cda",
  ye_ast_decisions: "a3eb1c0ee1dbf6c86080e0215b48283bcd1d26de492fbd78d558ba49b2ee7cda",
};
/** Compose does not run contract_consequences until U3, so its contract is pinned apart from the composed families. */
const CONSEQUENCES_CONSTRAINTS: Record<string, string> = { ye_ast_contract_consequences: "6e05e8d94599268d755e79a4df04adfc3340e1140c84f0b32b31d968a93baf4d" };
const COMPOSE_CONSTRAINTS = "75fcd7d1645e4da54259244b4fbf1755f06fcf59fb07d1bb9dc4e4281d8e66e5";
function canonicalConstraints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConstraints);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalConstraints(child)]));
}
