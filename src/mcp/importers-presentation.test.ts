import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, type Fact, type FactBase } from "../core/domain/shared/fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import { renderImporters } from "./render.ts";
import { LISTED_ITEMS } from "./render-budget.ts";

const base: FactBase = { schema: SCHEMA, snapshot: { repo: "a", kind: "sha", sha: "abc" }, producer: { name: "test", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "c", declaredConfig: {}, engines: {} }, evidence: [] };

test("details conserve ordered category memberships per target with one path occurrence", () => {
  const value: ImportersValue = { files: [
    { file: "target-a", importers: ["a", "shared"], reexporters: ["shared", "barrel"], dynamicImporters: ["shared"], typeImporters: ["type"], users: ["shared", "other", "a"], unresolvedNamers: ["other", "shared", "unknown"] },
    { file: "target-b", importers: ["other"], users: [], unresolvedNamers: [] },
  ] };
  const original = structuredClone(value);
  const fact: Fact<ImportersValue> = { ...base, status: "complete", value };
  const output = renderImporters(fact, "details");
  const first = output.split("  target-a\n")[1]!.split("  target-b\n")[0]!;
  assert.match(first, /shared \(importers\[1\], reexporters\[0\], dynamic importers\[0\], users\[0\], also unresolved name matches\[1\]\)/);
  assert.match(first, /other \(additional users\[1\], also unresolved name matches\[0\]\)/);
  assert.match(first, /barrel \(reexporters\[1\]\)/);
  assert.match(first, /unknown \(unresolved name matches\[2\]\)/);
  for (const path of ["shared", "other", "barrel", "unknown"]) assert.equal(first.split(`${path} (`).length - 1, 1);
  assert.match(output.split("  target-b\n")[1]!, /other \(importers\[0\]\)/);
  assert.deepEqual(value, original);
});

test("details reconstruct source arrays including nonadjacent overlaps and unusual paths", () => {
  const entry = { file: "target", importers: ['x: odd', 'quote"file'], reexporters: ['quote"file', 'x: odd'], dynamicImporters: ['x: odd'], typeImporters: [], users: ['quote"file', 'extra', 'x: odd'], unresolvedNamers: ['extra', 'x: odd'] };
  const output = renderImporters({ ...base, status: "complete", value: { files: [entry] } }, "details");
  const rebuilt: Record<string, string[]> = {};
  for (const line of output.split("\n")) {
    const row = line.match(/^    (.*) \((.*)\)$/);
    if (!row) continue;
    const path = row[1]!;
    for (const membership of row[2]!.split(", ")) {
      const match = membership.match(/^(.*?)\[(\d+)\]$/)!;
      const label = match[1] === "additional users" ? "users" : match[1] === "also unresolved name matches" ? "unresolved name matches" : match[1]!;
      (rebuilt[label] ??= [])[Number(match[2])] = path;
    }
  }
  assert.deepEqual(rebuilt.importers, entry.importers);
  assert.deepEqual(rebuilt.reexporters, entry.reexporters);
  assert.deepEqual(rebuilt["dynamic importers"], entry.dynamicImporters);
  assert.deepEqual(rebuilt.users, entry.users);
  assert.deepEqual(rebuilt["unresolved name matches"], entry.unresolvedNamers);
});

test("empty results remain explicit in every mode", () => {
  const empty: Fact<ImportersValue> = { ...base, status: "complete", value: { files: [{ file: "empty", importers: [], users: [], unresolvedNamers: [] }] } };
  for (const mode of ["summary", "details", "full"] as const) {
    const text = renderImporters(empty, mode);
    assert.doesNotMatch(text, /File paths omitted/);
    if (mode !== "full") assert.match(text, /no related files/);
  }
});

test("summary names every tier-zero related file beyond the listed bound", () => {
  const render = (count: number) => renderImporters({ ...base, status: "complete", value: { files: [{ file: "target", importers: Array.from({ length: count }, (_, i) => `long/path/consumer-${i}.ts`), users: [], unresolvedNamers: [] }] } }, "summary");
  const within = render(LISTED_ITEMS);
  assert.doesNotMatch(within, /File paths omitted/);
  assert.ok(within.includes(`long/path/consumer-${LISTED_ITEMS - 1}.ts`));
  const beyond = render(LISTED_ITEMS + 1);
  assert.doesNotMatch(beyond, /File paths omitted/);
  assert.ok(beyond.includes("long/path/consumer-0.ts"));
});

test("summary preserves full memberships for multiple targets", () => {
  const paths = Array.from({ length: LISTED_ITEMS + 1 }, (_, i) => `long/path/consumer-${i}.ts`);
  const value: ImportersValue = { files: ["one", "two"].map(file => ({ file, importers: paths, reexporters: paths.slice(0, 2), users: paths, unresolvedNamers: paths.slice(0, 3) })) };
  const text = renderImporters({ ...base, status: "complete", value }, "summary");
  assert.doesNotMatch(text, /File paths omitted/);
  for (const path of paths) assert.equal(text.split(path).length - 1, 2);
  assert.equal((text.match(/reexporters\[1\]/g) ?? []).length, 2);
  assert.equal((text.match(/also unresolved name matches\[2\]/g) ?? []).length, 2);
});

test("recorded, mixed and legacy relationship places are presented honestly", () => {
  const entry = { file: "target", importers: ["a", "b"], users: [], unresolvedNamers: [] };
  const render = (places?: readonly { file: string; line: number }[]) => renderImporters({ ...base, status: "complete", value: { files: [{ ...entry, ...(places ? { places } : {}) }] } }, "details");
  const recorded = render([{ file: "a", line: 11 }, { file: "a", line: 8 }, { file: "b", line: 4 }]);
  assert.match(recorded, /a \(importers\[0\]\)\n {6}evidence: a:8,11/);
  assert.doesNotMatch(recorded, /paths only|no recorded line/);
  assert.match(render([{ file: "a", line: 8 }]), /no recorded line/);
  assert.match(render(), /These relationships are paths only; no relationship line locations were recorded\./);
});
