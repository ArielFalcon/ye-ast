import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, type Fact, type FactBase } from "../core/domain/shared/fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import { renderImporters } from "./render.ts";

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
  assert.match(first, /shared": importers\[1\], reexporters\[0\], dynamic importers\[0\], users\[0\], unresolved name matches\[1\]/);
  assert.match(first, /other": additional users\[1\], unresolved name matches\[0\]/);
  assert.match(first, /barrel": reexporters\[1\]/);
  assert.match(first, /unknown": unresolved name matches\[2\]/);
  for (const path of ["shared", "other", "barrel", "unknown"]) assert.equal(first.split(`${JSON.stringify(path)}:`).length - 1, 1);
  assert.match(output.split("  target-b\n")[1]!, /other": importers\[0\]/);
  assert.deepEqual(value, original);
});

test("details reconstruct source arrays including nonadjacent overlaps and unusual paths", () => {
  const entry = { file: "target", importers: ['x: odd', 'quote"file'], reexporters: ['quote"file', 'x: odd'], dynamicImporters: ['x: odd'], typeImporters: [], users: ['quote"file', 'extra', 'x: odd'], unresolvedNamers: ['extra', 'x: odd'] };
  const output = renderImporters({ ...base, status: "complete", value: { files: [entry] } }, "details");
  const rebuilt: Record<string, string[]> = {};
  for (const line of output.split("\n")) {
    const row = line.match(/^    ("(?:[^"\\]|\\.)*"): (.*)$/);
    if (!row) continue;
    const path = JSON.parse(row[1]!) as string;
    for (const membership of row[2]!.split(", ")) {
      const match = membership.match(/^(.*?)\[(\d+)\]$/)!;
      const label = match[1] === "additional users" ? "users" : match[1]!;
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
    if (mode !== "full") assert.match(text, /related files \(0 distinct\)/);
  }
});

test("summary counts full memberships and shares recovery for multiple targets", () => {
  const paths = Array.from({ length: 20 }, (_, i) => `long/path/consumer-${i}.ts`);
  const value: ImportersValue = { files: ["one", "two"].map(file => ({ file, importers: paths, reexporters: paths.slice(0, 2), users: paths, unresolvedNamers: paths.slice(0, 3) })) };
  const text = renderImporters({ ...base, status: "complete", value }, "summary");
  assert.equal((text.match(/File paths omitted/g) ?? []).length, 1);
  assert.equal((text.match(/reexporters \(2\)/g) ?? []).length, 2);
  assert.equal((text.match(/users \(20; 0 additional\)/g) ?? []).length, 2);
  assert.equal((text.match(/unresolved name matches \(3\)/g) ?? []).length, 2);
});
