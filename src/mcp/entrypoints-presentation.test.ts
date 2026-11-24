import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEntrypointMap } from "./render.ts";
import { TOOL_INPUTS } from "./query-schema.ts";
import { entrypointKind } from "./composition-schema-parts.ts";
import { validRecoveryControls } from "./evidence-schema.ts";

const base = { schema: "0.12.0", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };
const render = (items: unknown[], mode: "summary" | "details") => renderEntrypointMap({ ...base, status: "complete", value: { entrypoints: { ...base, status: "complete", value: items } } } as never, mode);

test("an unknown row keeps every evidence place beyond its own, in order, with how it was found, in details only", () => {
  const shared = { path: "src/configuration/very-long-shared-unresolved-location.ts", line: 8, endLine: 9, via: "router", confidence: 0.5 };
  const different = { ...shared, via: "other" };
  const items = Array.from({ length: 20 }, (_, i) => ({ status: "unknown", reason: i === 10 ? "no-extractor" : "unresolved", evidence: [{ path: `src/route-${i}.ts`, line: i + 1 }, shared, i === 10 ? different : shared] }));
  items.splice(5, 0, { status: "unknown", reason: "unresolved", evidence: [{ path: "src/other.ts", line: 4 }] } as never);
  const details = render(items, "details");
  const rowOf = (text: string, index: number) => text.split("\n").findIndex((line) => new RegExp(`^ +${index}\\. `).test(line));
  const lines = details.split("\n");
  items.forEach((item, index) => {
    const at = rowOf(details, index);
    assert.ok(at >= 0, `row ${index}`);
    assert.match(lines[at]!, new RegExp(`${index === 5 ? 4 : (index < 5 ? index : index - 1) + 1} unknown \\(${item.reason}\\)$`));
    const evidence = lines[at + 1]!.startsWith("      evidence:") ? lines[at + 1]! : "";
    if (item.evidence.length === 1) assert.equal(evidence, "");
    else if (item.reason === "no-extractor") assert.match(evidence, /8-9 via router confidence 0\.5, .*8-9 via other confidence 0\.5$/);
    else assert.match(evidence, /8-9,8-9 via router confidence 0\.5$/);
  });
  assert.equal(render(items, "summary").includes("via router"), false);
  assert.match(render(items, "summary"), /^ {4}5\. 4 unknown \(unresolved\)$/m);
});

test("details state each distinct base path once, with the routes that share it, and a route names its base by row number", () => {
  const evidence = [{ path: "src/config/very-long-shared-configuration-source.yaml", line: 12 }];
  const items = Array.from({ length: 20 }, (_, i) => ({ status: "complete", evidence: [{ path: `src/controller-${i}.ts`, line: i + 1 }], value: { kind: "http-route", name: `GET /route-${i}`, method: "GET", path: `/route-${i}`, handler: { path: `src/controller-${i}.ts`, symbol: `route${i}`, line: i + 1 }, basePath: { status: "unknown", reason: i === 10 ? "no-extractor" : "unresolved", evidence } } }));
  items.splice(5, 0, { status: "complete", evidence: [{ path: "src/page.ts", line: 1 }], value: { kind: "ui-route", name: "/page", path: "/page", component: "unknown", guards: [{ name: "guard", path: "src/guard.ts" }] } } as never);
  const text = render(items, "details");
  assert.equal((text.match(/very-long-shared-configuration-source/g) ?? []).length, 1);
  const bases = new Map([...text.matchAll(/^ {2}(\d+)\. base path unknown \((no-extractor|unresolved)\) \(routes (\d+)\)$/gm)].map((match) => [Number(match[1]), { reason: match[2], routes: Number(match[3]) }]));
  assert.deepEqual([...bases.values()].toSorted((a, b) => a.routes - b.routes), [{ reason: "no-extractor", routes: 1 }, { reason: "unresolved", routes: 19 }]);
  const lines = text.split("\n");
  for (let i = 0; i < 20; i++) {
    const row = lines.findIndex((line) => line.includes(`GET /route-${i} -> route${i}`));
    assert.ok(row >= 0);
    const reference = /^ +base (\d+)$/.exec(lines[row + 1]!);
    assert.equal(bases.get(Number(reference![1]))!.reason, i === 10 ? "no-extractor" : "unresolved");
    assert.match(lines.slice(0, row).reverse().find((line) => /^ {2}\S/.test(line))!, new RegExp(`src/controller-${i}\\.ts`));
  }
  assert.match(text, /guard guard|src\/guard\.ts guard guard/);
  assert.match(text, /ui-route \/page -> component unknown \(at src\/page\.ts:1, guards 1\)/);
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

test("an entrypoints row for a UI route states the place its route entry is declared at in both modes; an HTTP route row states none", () => {
  const uiRoute = { status: "complete", evidence: [{ path: "src/routes.ts", line: 12 }], value: { kind: "ui-route", name: "/orders", path: "/orders", component: { path: "src/orders.page.ts", symbol: "OrdersPage", line: 5 }, guards: [] } };
  const httpRoute = { status: "complete", evidence: [{ path: "src/orders.ts", line: 3 }], value: { kind: "http-route", name: "GET /orders", method: "GET", path: "/orders", handler: { path: "src/orders.ts", symbol: "list", line: 3 }, basePath: { status: "complete", value: { default: {}, profiles: {} }, evidence: [] } } };
  for (const mode of ["summary", "details"] as const) {
    const text = render([uiRoute, httpRoute], mode);
    assert.match(text, /^ {2}src\/orders\.page\.ts\n {4}0\. 5 ui-route \/orders -> OrdersPage \(at src\/routes\.ts:12\)$/m);
    assert.match(text, /^ {2}src\/orders\.ts\n {4}1\. 3 http-route GET \/orders -> list$/m);
  }
});

test("callback rows render bare contract names and class handlers", () => {
  const items = [
    { status: "complete", evidence: [], value: { kind: "callback", name: "a.b.C.m", contract: { type: "a.b.C", member: "m" }, handler: { path: "src/A.java", line: 7, symbol: "A.run" } } },
    { status: "complete", evidence: [], value: { kind: "callback", name: "a.b.A", contract: { type: "a.b.A" }, handler: { path: "src/B.java", line: 2, symbol: "B" } } },
  ];
  const text = render(items, "details");
  assert.match(text, /^ {4}0\. 7 callback a\.b\.C\.m -> A\.run$/m);
  assert.match(text, /^ {4}1\. 2 callback a\.b\.A -> B$/m);
});

test("published entrypoint kind accepts callbacks", () => {
  assert.equal(entrypointKind.safeParse("callback").success, true);
  assert.equal(TOOL_INPUTS.trace.safeParse({ targets: [{ kind: "callback", name: "a.b.C.m" }] }).success, true);
});

test("an unknown item states what it stands for in every presentation, and an item with a subject is never folded into a run of shared evidence", () => {
  const subject = { candidate: "listener", symbol: "Queue.take", raisedBy: "io.awspring.cloud.sqs.annotation.SqsListener" };
  const sharedPlace = { path: "src/Queue.java", line: 3 };
  const items = [
    { status: "unknown", reason: "no-extractor", evidence: [{ path: "src/Queue.java", line: 7, endLine: 9 }], subject },
    { status: "unknown", reason: "no-extractor", evidence: [{ path: "src/Queue.java", line: 12, endLine: 13 }] },
    { status: "unknown", reason: "no-extractor", evidence: [{ path: "src/Queue.java", line: 20, endLine: 22 }] },
    { status: "unknown", reason: "no-extractor", evidence: [sharedPlace, { path: "src/Base.java", line: 1 }], subject: { symbol: "Queue", raisedBy: "lib.Base" } },
    { status: "unknown", reason: "no-extractor", evidence: [sharedPlace, { path: "src/Base.java", line: 2 }] },
  ];
  for (const mode of ["summary", "details"] as const) {
    const text = render(items, mode);
    assert.match(text, /^ {4}0\. 7-9 unknown \(no-extractor\) for listener Queue\.take \(raised by [^)]+\)$/m);
    assert.match(text, /^ {4}3\. 3 unknown \(no-extractor\) for Queue \(raised by lib\.Base\)/m);
    assert.match(text, /^ {4}4\. 3 unknown \(no-extractor\)(?! for)/m);
  }
});
