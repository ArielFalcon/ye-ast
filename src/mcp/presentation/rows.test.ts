import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Cut } from "../../core/domain/shared/fact.ts";
import type { ReachedEntrypoint } from "../../core/domain/impact/impact-fact.ts";
import { declarationRow, cutSection, entrypointRow } from "./rows.ts";

test("overloads, moves and repositories give different declaration keys; the same declaration gives the same key", () => {
  const outline = { kind: "method", name: "save", line: 10, endLine: 12 };
  const keys = [
    declarationRow("A.java", outline).key,
    declarationRow("A.java", { ...outline, line: 20, endLine: 22 }).key,
    declarationRow("B.java", outline).key,
    declarationRow("A.java", outline, "other").key,
    declarationRow("A.java", { ...outline, name: "load" }).key,
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(declarationRow("A.java", { ...outline, endLine: 99 }).key, keys[0]);
});

test("a declaration row carries its place, kind label, qualifiers and contained declarations", () => {
  const impacted = { file: "A.ts", symbol: "run", kind: "method", line: 4, endLine: 9, depth: 2, confidence: 0.5, fanIn: 3, via: { file: "B.ts", symbol: "b", basis: "call", derivation: "name-match" } } as const;
  assert.deepEqual(declarationRow("A.ts", impacted, "app"), {
    key: ["app", "A.ts", "4", "run"].join("\0"),
    place: { repo: "app", path: "A.ts", line: 4, endLine: 9 },
    label: "run [method]",
    qualifiers: [{ name: "depth", value: "2" }, { name: "confidence", value: "0.5" }, { name: "name match" }, { name: "fan-in", value: "3" }],
  });
  const outline = declarationRow("C.ts", { kind: "class", name: "C", line: 1, endLine: 8, children: [{ kind: "method", name: "m", line: 2, endLine: 3 }] });
  assert.deepEqual(outline.children?.map((child) => [child.label, child.place?.path, child.place?.line]), [["m [method]", "C.ts", 2]]);
});

test("cuts are one row each, the cause that cut most first, with the places as children", () => {
  const cut = (kind: Cut["kind"], reason: string, at: string[]): Cut => ({ kind, at, reason, reach: { kind: "anything" } }) as Cut;
  const section = cutSection([cut("hub", "hub", ["h1"]), cut("unresolved-link", "x", ["a:1"]), cut("unresolved-link", "x", ["b:2"])]);
  assert.equal(section.role, "completeness");
  assert.deepEqual(section.rows.map((row) => row.label), ["unresolved-link x", "unresolved-link x", "hub"]);
  assert.equal(new Set(section.rows.map((row) => row.key)).size, 3);
  assert.deepEqual(section.rows[0]!.children?.map((child) => child.label), ["a:1"]);
});

test("a finding and the same entrypoint reached from a change share one key, and the key never holds a position", () => {
  const handler = { path: "src/A.java", symbol: "A.get", line: 7, endLine: 20 };
  const finding = entrypointRow({ status: "complete", evidence: [], value: { kind: "http-route", name: "GET /a", method: "GET", path: "/a", handler, basePath: { status: "unknown", reason: "unresolved", evidence: [] } } });
  const reached: ReachedEntrypoint = { kind: "http-route", name: "GET /a", handler, depth: 2, confidence: 0.5, seeds: [0] };
  const row = entrypointRow(reached);
  assert.equal(row.key, finding.key);
  assert.deepEqual(row.place, { path: "src/A.java", line: 7, endLine: 20 });
  assert.deepEqual(row.qualifiers, [{ name: "depth", value: "2" }, { name: "origins", value: "0" }, { name: "confidence", value: "0.5" }]);
  assert.notEqual(entrypointRow({ ...reached, handler: { ...handler, line: 30 } }).key, row.key);
  assert.notEqual(entrypointRow(reached, "other").key, row.key);
  const owned = entrypointRow(reached, "other", { seeds: [{ file: "src/seed.ts", symbol: "seed", line: 4, basis: "requested" }] });
  assert.equal(owned.place?.repo, "other");
  assert.equal(owned.evidence?.[0]?.repo, "other");
});

test("a reached unknown entrypoint keeps each distinct observation as a child, and a UI route its declaration as a qualifier", () => {
  const observation = { status: "unknown", reason: "no-extractor", evidence: [{ path: "src/W.java", line: 3 }] } as const;
  const unknown = entrypointRow({ kind: "unknown", handler: { path: "src/W.java", symbol: "W.run", line: 3 }, depth: 1, confidence: 1, seeds: [], observations: [observation, observation] });
  assert.deepEqual(unknown.children?.map((child) => child.label), ["unknown (no-extractor)"]);
  const ui = entrypointRow({ kind: "ui-route", name: "/x", handler: { path: "src/X.ts", symbol: "X", line: 1 }, depth: 0, confidence: 1, seeds: [], declaredAt: { path: "src/r.ts", line: 9 } });
  assert.deepEqual(ui.qualifiers?.at(-1), { name: "at", value: "src/r.ts:9" });
});
