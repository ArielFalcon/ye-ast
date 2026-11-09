import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEntrypointMap } from "./render.ts";
import { validRecoveryControls } from "./evidence-schema.ts";

const base = { schema: "0.12.0", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };
const render = (items: unknown[], mode: "summary" | "details") => renderEntrypointMap({ ...base, status: "complete", value: { entrypoints: { ...base, status: "complete", value: items } } } as never, mode);

test("multi-evidence unknowns retain exact ordered location associations including duplicates", () => {
  const shared = { path: "src/configuration/very-long-shared-unresolved-location.ts", line: 8, endLine: 9, via: "router", confidence: 0.5 };
  const different = { ...shared, via: "other" };
  const items = Array.from({ length: 20 }, (_, i) => ({ status: "unknown", reason: i === 10 ? "no-extractor" : "unresolved", evidence: [{ path: `src/route-${i}.ts`, line: i + 1 }, shared, i === 10 ? different : shared] }));
  items.splice(5, 0, { status: "unknown", reason: "unresolved", evidence: [{ path: "src/other.ts", line: 4 }] } as never);
  for (const mode of ["summary", "details"] as const) {
    const text = render(items, mode);
    const contexts = new Map([...text.matchAll(/^  evidence (\d+): (.+)$/gm)].map(m => [Number(m[1]), JSON.parse(m[2]!)]));
    const rows = [...text.matchAll(/^  - unknown \(([^)]+)\) \[findingIndex (\d+)\] evidence: (.+)$/gm)];
    assert.equal(rows.length, items.length - 1);
    rows.forEach((row, i) => {
      const index = i < 5 ? i : i + 1;
      assert.equal(Number(row[2]), index); assert.equal(row[1], items[index]!.reason);
      assert.deepEqual(JSON.parse(row[3]!).map((entry: unknown) => typeof entry === "number" ? contexts.get(entry) : entry), items[index]!.evidence);
    });
    assert.match(text, /src\/other.ts:4[^\n]*findingIndex 5/);
    assert.equal((text.match(/very-long-shared-unresolved-location/g) ?? []).length, 2);
  }
});

test("details share exact base-path context independently of row evidence and route guards", () => {
  const evidence = [{ path: "src/config/very-long-shared-configuration-source.yaml", line: 12 }];
  const items = Array.from({ length: 20 }, (_, i) => ({ status: "complete", evidence: [{ path: `src/controller-${i}.ts`, line: i + 1 }], value: { kind: "http-route", name: `GET /route-${i}`, method: "GET", path: `/route-${i}`, handler: { path: `src/controller-${i}.ts`, symbol: `route${i}`, line: i + 1 }, basePath: { status: "unknown", reason: i === 10 ? "no-extractor" : "unresolved", evidence } } }));
  items.splice(5, 0, { status: "complete", evidence: [{ path: "src/page.ts", line: 1 }], value: { kind: "ui-route", name: "/page", path: "/page", component: "unknown", guards: [{ name: "guard", path: "src/guard.ts" }] } } as never);
  const text = render(items, "details");
  assert.equal((text.match(/very-long-shared-configuration-source/g) ?? []).length, 2);
  for (let i = 0; i < items.length; i++) assert.match(text, new RegExp(`findingIndex ${i}\\]`));
  for (let i = 0; i < 20; i++) assert.match(text, new RegExp(`src/controller-${i}\\.ts:${i + 1}`));
  const baseContexts = new Map([...text.matchAll(/^  base context (\d+): base path unknown \([^)]+\) (.+)$/gm)].map(m => [Number(m[1]), JSON.parse(m[2]!) ]));
  const sections = text.split(/(?=^  - (?:http-route|ui-route) )/m);
  for (let i = 0; i < items.length; i++) {
    const section = sections.find(part => part.includes(`[findingIndex ${i}]`));
    assert.ok(section);
    const item = items[i]!;
    if (item.value.kind === "http-route") {
      const ref = section.match(/base context (\d+)/);
      if (ref) assert.deepEqual(baseContexts.get(Number(ref[1])), item.value.basePath);
      else assert.match(section, /base path unknown \(no-extractor\)/);
    }
  }
  assert.match(text, /own guards \(1\):\n\s+- guard \(src\/guard.ts\)/);
  assert.match(text, /base path unknown \(unresolved\)/); assert.match(text, /base path unknown \(no-extractor\)/);
});

test("shared cut rows print only their cutIndex, and each completes the one select example", () => {
  const cuts = Array.from({ length: 12 }, (_, index) => ({ kind: "depth", at: [`src/anchor-${index}.ts`], limit: 2, reason: "depth", reach: { kind: "anything" } }));
  const section = { ...base, status: "partial", cuts, value: [] };
  const text = renderEntrypointMap({ ...base, status: "complete", value: { entrypoints: section } } as never, "details", { tool: "entrypoints" });
  const example = JSON.parse(text.match(/Cut lookup:.*select example: (\{[^\n]+\})/)![1]!);
  const rows = [...text.matchAll(/^ {2}cutIndex (\d+) \(anchor (".*")\)$/gm)].map(([, cutIndex, anchor]) => ({ cutIndex: Number(cutIndex), anchor: JSON.parse(anchor!) }));
  assert.deepEqual(rows, cuts.map((cut, cutIndex) => ({ cutIndex, anchor: cut.at[0] })));
  assert.equal(text.split('"kind":"cut-places"').length - 1, 1);
  assert.ok(rows.every(({ cutIndex }) => validRecoveryControls("entrypoints", { select: { ...example, cutIndex }, page: { limit: 1 } })));
});
