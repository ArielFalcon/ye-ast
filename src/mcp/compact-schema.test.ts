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
  ye_ast_entrypoints: "33b34a7a826fa2f3ca5f38b84d2cdfb76509a2f0344c38f8ad2999565bef612f",
  ye_ast_impact: "1c5ae9d4dec7b34997df66c2b8ccbc419bd66df019b11582ae5718820f88c66e",
  ye_ast_callers: "535000aeb939ffdc853abd55c652c5b51b8d5b91d20966ac4924073ee7b17c61",
  ye_ast_importers: "402e01b8be549c7dfb26e6ad5aa77fef1883c372654ea058c304eed3c926a492",
  ye_ast_outline: "c5b6184ef1743939d7c30e868ec8eb12c15b721213c06db553b6ae1ffa8f301b",
  ye_ast_trace: "5f4c78c25f795246dac4c44a9963578deab7a7112784f8ee00cd975353ca272c",
  ye_ast_workspace: "2da810ef72c54bb1573eb0d5b0a4906bc4dffd34af1609d7234547a12b472856",
  ye_ast_decisions: "2da810ef72c54bb1573eb0d5b0a4906bc4dffd34af1609d7234547a12b472856",
  ye_ast_contract_consequences: "cff0d21b8985ec9dc116d336f33142358e21f2fcb890010ac695627095077eaf",
};
const COMPOSE_CONSTRAINTS = "70f447d146774397f06a740ba550fa8c12569a9469f8f9f1f43ecaaa1367244f";
function canonicalConstraints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConstraints);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalConstraints(child)]));
}
