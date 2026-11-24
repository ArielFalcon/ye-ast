import { test } from "node:test";
import assert from "node:assert/strict";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createEvidenceComposition } from "../core/application/composition/evidence-composition.ts";
import { entrypointsValue, factOf, inputsOf, outlineValue, unknownFactOf } from "../core/application/composition/composition-fixtures.testing.ts";
import { CAPABILITY_ABSENT, type Cut, type Fact } from "../core/domain/shared/fact.ts";
import type { OutlineValue } from "../core/domain/outline/outline-fact.ts";
import type { EntrypointMapFact } from "../core/domain/map/entrypoint-map.ts";
import type { EntrypointQueries, MapRequest } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactFault } from "../core/ports/impact-queries.port.ts";
import type { OutlineQueries } from "../core/ports/outline-queries.port.ts";
import type { McpDeps } from "../mcp/server.ts";
import { createMcpServer, FAULT_META } from "../mcp/server.ts";
import { ANSWER_FILES_META } from "../mcp/answer-files.ts";
import { fullReply, memoryAnswerFiles } from "../mcp/answer-files.testing.ts";
import { openSession, resultFields, textOf, type Session, type ToolResult } from "../mcp/test-session.testing.ts";
import type { AnswerFolder } from "../core/ports/answer-files.port.ts";

const redaction: McpDeps["redaction"] = {
  redact: (text) => text,
  redactValue: (value) => value,
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: (error) => String(error instanceof Error ? error.message : error),
  containsSecret: () => false,
};

/** A server whose entrypoints and outline answer from fixtures; compose runs on the real evidence composition. */
async function setup(outline: OutlineQueries["outline"] = async () => ({ ok: true, value: factOf(outlineValue()) }), answerBytes?: number): Promise<{ session: Session; maps: MapRequest[]; folders: Map<string, AnswerFolder["files"]> }> {
  const maps: MapRequest[] = [];
  const entrypoints: EntrypointQueries = { map: async (request) => (maps.push(request), { ok: true, value: factOf(entrypointsValue()) as EntrypointMapFact }) };
  const digest = createSha256Digest();
  const { files, folders } = memoryAnswerFiles();
  const server = createMcpServer({
    version: "0.0.0", entrypoints, outline: { outline },
    impact: {} as McpDeps["impact"], trace: {} as McpDeps["trace"], workspace: {} as McpDeps["workspace"], workspaceImpact: {} as McpDeps["workspaceImpact"],
    decisions: {} as McpDeps["decisions"], contractConsequences: {} as McpDeps["contractConsequences"],
    digest, evidenceComposition: createEvidenceComposition(digest), redaction, repository: { path: "/work/shop", repoId: "shop" }, answerFiles: files, ...(answerBytes === undefined ? {} : { answerBytes }),
  });
  return { session: await openSession(server), maps, folders };
}

const focusFact = (value: OutlineValue, cuts?: [Cut]): Fact<OutlineValue> =>
  factOf(value, { inputs: inputsOf({ declaredConfig: { focus: ["src/Api.ts:get"] } }), ...(cuts === undefined ? {} : { cuts }) });

test("compose honors the host text bound while keeping complete structured fields or explicit refusal", async () => {
  for (const bound of [0, 100, 100000]) {
    const { session } = await setup(undefined, bound);
    try {
      const result = await session.callTool("ye_ast_compose", { queries: [{ name: "ye_ast_outline", arguments: { files: ["src/Api.ts"] } }] });
      assert.ok(Buffer.byteLength(textOf(result)) <= bound);
      if (result.isError) assert.equal(result._meta?.kind, "answer-over-bound");
      else {
        assert.equal(result.structuredContent, undefined);
        assert.ok(result._meta?.["ye-ast/result"] !== undefined);
      }
    } finally { await session.close(); }
  }
});

test("compose preserves declared capability absence as distinct from no extractor", async () => {
  for (const reason of [CAPABILITY_ABSENT, "no-extractor"] as const) {
    const { session, folders } = await setup(async () => ({ ok: true, value: unknownFactOf<OutlineValue>(reason) }));
    try {
      const result = fullReply(await session.callTool("ye_ast_compose", { queries: [{ name: "ye_ast_outline", arguments: { files: ["src/a.ts"] } }] }), folders);
      assert.notEqual(result.isError, true, textOf(result));
      const fields = resultFields(result) as { coverage: { unknowns: { reason: string }[] } };
      assert.deepEqual(fields.coverage.unknowns.map((unknown) => unknown.reason), [reason]);
    } finally { await session.close(); }
  }
});

test("compose records an outline focus read whole, as the outline tool answers it", async () => {
  const value: OutlineValue = {
    focus: [{ file: "src/Api.ts", selector: "get", path: "get", ancestors: [], declaration: { kind: "function", name: "get", line: 10, endLine: 20 }, omitted: 0, uses: [{ global: "Map", relations: ["instantiates"], at: [{ line: 11, column: 3 }] }] }],
    unheld: [],
  };
  const { session, folders } = await setup(async () => ({ ok: true, value: focusFact(value) }));
  try {
    const result = fullReply(await session.callTool("ye_ast_compose", { queries: [{ name: "ye_ast_outline", arguments: { focus: [{ file: "src/Api.ts", symbol: "get" }] } }] }), folders);
    assert.notEqual(result.isError, true, textOf(result));
    assert.match(textOf(result), /1 recorded reads \(1 complete, .*graph\.parts \(1\)/s);
  } finally { await session.close(); }
});

test("a focused declaration with no proven use but an unproved one never reads as using nothing, alone or composed", async () => {
  const value: OutlineValue = { focus: [{ file: "src/Api.ts", selector: "get", path: "get", ancestors: [], declaration: { kind: "function", name: "get", line: 10, endLine: 20 }, omitted: 0, uses: [] }], unheld: [] };
  const cuts: [Cut] = [{ kind: "unresolved-link", at: ["src/Api.ts::get", "src/Api.ts:11 Buffer.byteLength"], reason: "hidden-caller", reach: { kind: "callers-of", declarations: ["src/Api.ts::get"] } }];
  const { session } = await setup(async () => ({ ok: true, value: focusFact(value, cuts) }));
  try {
    const focus = [{ file: "src/Api.ts", symbol: "get" }];
    const alone = textOf(await session.callTool("ye_ast_outline", { focus, mode: "summary" }));
    const composed = textOf(await session.callTool("ye_ast_compose", { queries: [{ name: "ye_ast_outline", arguments: { focus } }], mode: "details" }));
    assert.match(alone, /10-20 get \[function\]/);
    assert.match(composed, /outline declaration .*get/);
    for (const text of [alone, composed]) assert.doesNotMatch(text, /nothing outside its body/);
  } finally { await session.close(); }
});

test("compose names the failed queries once and corrects only at the cause, for the cause's tool", async () => {
  const fault: ImpactFault = { kind: "unknown-symbol", detail: "no such symbol", entries: [{ file: "src/a.ts", symbol: "gone", absent: false, candidates: ["a"] }] };
  const { session } = await setup(async () => ({ ok: false, fault }));
  try {
    const outline = { name: "ye_ast_outline", arguments: { focus: [{ file: "src/a.ts", symbol: "gone" }] } };
    const result = await session.callTool("ye_ast_compose", { queries: [{ name: "ye_ast_entrypoints", arguments: {} }, outline, outline] });
    assert.equal(result.isError, true);
    const published = result._meta?.[FAULT_META] as { kind: string; family: string; requestIndices: number[]; cause: { kind: string } };
    assert.deepEqual([published.kind, published.family, published.requestIndices, published.cause.kind], ["composition-source-fault", "outline", [1, 2], "unknown-symbol"]);
    const text = textOf(result);
    assert.equal(text.match(/^Next step:/gm)?.length, 1);
    assert.ok(text.indexOf("Next step:") > text.indexOf("fault: unknown-symbol"));
    assert.doesNotMatch(text, /\btargets\b/);
  } finally { await session.close(); }
});

test("compose combines public queries in every mode and verifies repeated evidence", async () => {
  const { session, maps, folders } = await setup();
  try {
    const queries = [
      { name: "ye_ast_entrypoints", arguments: {} },
      { name: "ye_ast_outline", arguments: { files: ["src/a.ts"] } },
    ];
    const response = fullReply(await session.callTool("ye_ast_compose", { queries }), folders);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const data = resultFields(response) as { kind: string; graph: { sources: unknown[] }; verification: { identity: string } };
    assert.equal(data.kind, "composition");
    assert.equal(data.graph.sources.length, 2);
    const reverse = fullReply(await session.callTool("ye_ast_compose", { queries: queries.toReversed(), expect: data.verification.identity }), folders);
    assert.deepEqual(resultFields(reverse), data);
    for (const mode of ["summary", "details"]) {
      const result = await session.callTool("ye_ast_compose", { queries, mode });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const receipt = resultFields(result) as { kind: string; text: string };
      assert.equal(receipt.kind, "composition-receipt");
      assert.ok(receipt.text.length > 0);
    }
    const previous = maps.length;
    const invalid = await session.callTool("ye_ast_compose", { queries: [{ name: "ye_ast_entrypoints", arguments: { mode: "full" } }] });
    assert.equal(invalid.isError, true);
    assert.equal((await session.callTool("ye_ast_compose", { queries, mode: "full" })).isError, true);
    assert.equal(maps.length, previous);
    const missing = await session.callTool("ye_ast_compose", { queries: [{ name: "ye_ast_entrypoints", arguments: { repo: "missing" } }] });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent, undefined);
    assert.match(textOf(missing), /unknown-repository/);
  } finally { await session.close(); }
});

const lastLine = (result: ToolResult): string => textOf(result).split("\n").at(-1)!;

test("compose writes its full composition and both texts to an answer folder its reply names, once per identity", async () => {
  const { session, folders } = await setup();
  try {
    const queries = [{ name: "ye_ast_entrypoints", arguments: {} }, { name: "ye_ast_outline", arguments: { files: ["src/a.ts"] } }];
    const summary = await session.callTool("ye_ast_compose", { queries });
    const details = await session.callTool("ye_ast_compose", { queries, mode: "details" });
    const folder = summary._meta?.[ANSWER_FILES_META] as string;
    assert.equal(details._meta?.[ANSWER_FILES_META], folder);
    for (const reply of [summary, details]) assert.equal(lastLine(reply), "answer: answers/compose/0/answer.json");
    const written = folders.get(folder)!;
    const { guide, ...composition } = JSON.parse(written["answer.json"]) as { guide: string; kind: string; mode: string; graph: { sources: unknown[] } };
    assert.equal(composition.kind, "composition");
    assert.equal(composition.mode, "full");
    assert.equal(composition.graph.sources.length, 2);
    assert.match(guide, /^Composition full: 2 sources/);
    const without = (result: ToolResult): string => textOf(result).split("\n").slice(0, -1).join("\n");
    assert.equal(written["summary.txt"], without(summary));
    assert.equal(written["details.txt"], without(details));
    assert.equal(folders.size, 1);
    const receipt = resultFields(summary) as { kind: string; graph?: unknown };
    assert.equal(receipt.kind, "composition-receipt");
    assert.equal(receipt.graph, undefined);
  } finally { await session.close(); }
});

test("a composition without an identity, or without a cache directory, says why no answer file was written", async () => {
  const { session, folders } = await setup(async () => ({ ok: true, value: unknownFactOf<OutlineValue>("deadline") }));
  try {
    const result = await session.callTool("ye_ast_compose", { queries: [{ name: "ye_ast_outline", arguments: { files: ["src/a.ts"] } }] });
    assert.equal(result._meta?.[ANSWER_FILES_META], undefined);
    assert.match(lastLine(result), /^no answer file written: the composition has no identity \(deadline\)$/);
    assert.equal(folders.size, 0);
  } finally { await session.close(); }
  const digest = createSha256Digest();
  const bare = await openSession(createMcpServer({
    version: "0.0.0", entrypoints: { map: async () => ({ ok: true, value: factOf(entrypointsValue()) as EntrypointMapFact }) }, outline: { outline: async () => ({ ok: true, value: factOf(outlineValue()) }) },
    impact: {} as McpDeps["impact"], trace: {} as McpDeps["trace"], workspace: {} as McpDeps["workspace"], workspaceImpact: {} as McpDeps["workspaceImpact"],
    decisions: {} as McpDeps["decisions"], contractConsequences: {} as McpDeps["contractConsequences"],
    digest, evidenceComposition: createEvidenceComposition(digest), redaction, repository: { path: "/work/shop", repoId: "shop" },
  }));
  try {
    const result = await bare.callTool("ye_ast_compose", { queries: [{ name: "ye_ast_entrypoints", arguments: {} }] });
    assert.match(lastLine(result), /^no answer file written: this server has no cache directory$/);
  } finally { await bare.close(); }
});
