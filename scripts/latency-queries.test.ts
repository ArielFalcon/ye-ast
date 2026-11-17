import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atSnapshot, corpusRepositories, toolCallOf, type ToolCall } from "./latency-queries.ts";

describe("toolCallOf", () => {
  it("turns line and symbol targets, entrypoints and budget flags into the tool's arguments", () => {
    assert.deepEqual(toolCallOf(["trace", "{repo:app}", "--entrypoint", "callback:a.B.c", "--depth", "1"]), { tool: "ye_ast_trace", family: "trace", args: { budget: { depth: 1 }, targets: [{ kind: "callback", name: "a.B.c" }] } });
    assert.deepEqual(toolCallOf(["callers", "{repo:app}", "src/A.java:12-30", "src/B.ts:Svc.run", "--hub-fan-in", "4"]), { tool: "ye_ast_callers", family: "callers", args: { budget: { hubFanIn: 4 }, targets: [{ file: "src/A.java", start: 12, end: 30 }, { file: "src/B.ts", symbol: "Svc.run" }] } });
  });

  it("names the files of importers and outline, and maps map to the entrypoints family", () => {
    assert.deepEqual(toolCallOf(["outline", "{repo:app}", "src/A.java"]), { tool: "ye_ast_outline", family: "outline", args: { files: ["src/A.java"] } });
    assert.deepEqual(toolCallOf(["map", "{repo:app}"]), { tool: "ye_ast_entrypoints", family: "entrypoints", args: {} });
  });

  it("refuses a flag the MCP takes at launch and a command it does not serve, instead of dropping them", () => {
    assert.deepEqual(toolCallOf(["trace", "--jdk", "/jdk", "{repo:app}", "src/A.java:A.run"]), { unsupported: "flag --jdk" });
    assert.deepEqual(toolCallOf(["contract-consequences", "{repo:app}"]), { unsupported: "command contract-consequences" });
  });
});

describe("atSnapshot", () => {
  const impact: ToolCall = { tool: "ye_ast_impact", family: "impact", args: { base: "b1", head: "h1", budget: { depth: 2 } } };
  const workspace: ToolCall = { tool: "ye_ast_workspace", family: "workspace", args: { offline: true } };

  it("compares the working tree with HEAD under live, and drops offline, which live refuses", () => {
    assert.deepEqual(atSnapshot(impact, { kind: "live" }), { budget: { depth: 2 }, base: "HEAD", live: true });
    assert.deepEqual(atSnapshot(workspace, { kind: "live" }), { live: true });
  });

  it("compares the step's base with its sha at a revision, and keeps offline", () => {
    assert.deepEqual(atSnapshot(impact, { kind: "revision", sha: "s2", base: "s1" }), { budget: { depth: 2 }, base: "s1", head: "s2" });
    assert.deepEqual(atSnapshot(workspace, { kind: "revision", sha: "s2", base: "s1" }), { offline: true, revision: "s2" });
  });
});

describe("corpusRepositories", () => {
  it("keeps the queries whose only repository is the one named, never one that reads a workspace or another repository", () => {
    const directory = mkdtempSync(join(tmpdir(), "latency-queries-"));
    const manifest = join(directory, "corpus.json");
    const sha = "a".repeat(40);
    writeFileSync(manifest, JSON.stringify({
      groups: [{
        id: "g",
        repos: [{ id: "web", path: "web", sha }, { id: "api", path: "api", sha }],
        queries: [
          { id: "own", family: "callers", argv: ["callers", "{repo:web}", "a.ts:1-2"] },
          { id: "other", family: "callers", argv: ["callers", "{repo:api}", "a.java:1-2"] },
          { id: "workspace", family: "trace", argv: ["trace", "--workspace", "{workspace}", "{repo:web}", "a.ts:f"] },
        ],
      }],
    }));
    const [web] = corpusRepositories(manifest, ["g/web"]);
    assert.deepEqual(web?.queries.map((query) => query.id), ["own"]);
    assert.equal(web?.path, join(directory, "web"));
  });
});
