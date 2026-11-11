import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { compactInput, crossField } from "./compact-schema.ts";
import { createMcpServer, type McpDeps } from "./server.ts";
import { openSession } from "./test-session.testing.ts";
import { TOOL_INPUTS } from "./query-schema.ts";
import type { QueryFamily } from "../core/ports/evidence-composition.port.ts";

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
    evidenceComposition: unused<McpDeps["evidenceComposition"]>(),
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
    assert.ok(bytes <= 36_100);
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
      assert.equal(createHash("sha256").update(JSON.stringify(canonicalConstraints(tool.inputSchema))).digest("hex"), INPUT_CONSTRAINTS[tool.name], `${tool.name}: argument contract`);
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
    const cases: [QueryFamily, Record<string, unknown>, boolean][] = [
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
  ye_ast_entrypoints: "647121c8746689c115833d07093b35e3ee032ce95596f365484863efdfc18bc8",
  ye_ast_impact: "c1341f610113d96ee9178899266e0a4d7c08f775008b66a93d3e914f3c179cef",
  ye_ast_callers: "cc59bfb6e7d7192dc6f402b7b58ac5284addca3be01cb104ae9af036f81a6a16",
  ye_ast_importers: "741b3552da816fb505b0233d6dc90540a1718fd4d970edd245d7b14524914305",
  ye_ast_outline: "600966e8b24d42a72ff5fe5046cc5901c7d59f170c7fc5c4d07135100753660e",
  ye_ast_trace: "0018c3e316361ad5a6e0b3d049ac2fa45f9329f4b908270acf95858627175086",
  ye_ast_workspace: "f31e2522a431e74895b431d8c65884b2d1288cd57f70afd9ac0433dd00699fbc",
  ye_ast_decisions: "f31e2522a431e74895b431d8c65884b2d1288cd57f70afd9ac0433dd00699fbc",
  ye_ast_contract_consequences: "ee5aff31b88d53260cbfb40c45e0c5578f6339d77202518fe4a955897b80baea",
};
const COMPOSE_CONSTRAINTS = "cf30af8869c71cce82a747af796866e15b0fdc365b5abf678ef8c5a63831fc06";
function canonicalConstraints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConstraints);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalConstraints(child)]));
}
