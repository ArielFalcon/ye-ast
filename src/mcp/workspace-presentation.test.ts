import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWorkspace } from "./render.ts";

const base = { schema: "0.12.0", snapshot: { repo: "a", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };

test("mixed unserved references reconstruct original order, multiplicity and qualified ownership", () => {
  const snapshot = (repo: string) => ({ ...base.snapshot, repo });
  const name = (i: number) => ({ kind: "http-host", name: `a-long-service-name-${i}.example`, evidence: [{ path: "src/a-long-shared-location.ts", line: i + 1, ...(i === 1 ? { via: "client", confidence: 0.75 } : {}) }] });
  const names = Array.from({ length: 20 }, (_, i) => name(i));
  const section = (repo: string, status: string) => ({ ...base, snapshot: snapshot(repo), status, ...(status === "partial" ? { cuts: [] } : {}), value: { names, unresolved: [{ path: "src/shared.ts", line: 4, symbol: "call", transport: "http", via: "client", stated: { method: "GET", path: "/route" } }] } });
  const qualified = (repo: string, i: number) => ({ ...names[i]!, evidence: names[i]!.evidence.map(e => ({ ...e, repo })) });
  const unserved = [qualified("b", 1), qualified("a", 0), qualified("b", 1), ...names.slice(2).map((_, i) => qualified("a", i + 2)), { ...qualified("a", 1), evidence: [{ path: "different.ts", line: 88, repo: "a" }] }, { ...name(0), evidence: [] }];
  const value = { workspace: { repos: ["a", "b", "unknown"], source: "request" }, repositorySnapshots: ["a", "b", "unknown"].map(repo => ({ repo, snapshot: snapshot(repo) })), sections: { a: section("a", "partial"), b: section("b", "complete"), unknown: { ...base, snapshot: snapshot("unknown"), status: "unknown", reason: "unavailable" } }, candidates: [], unserved };
  const fact = { ...base, status: "complete", value } as never;
  const before = JSON.stringify(fact);
  const text = renderWorkspace(fact, "details");
  const rows = text.split("no local repository serves (")[1]!.split("\nunresolved call sites")[0]!.split("\ncuts for repository")[0]!;
  const refs = [...rows.matchAll(/^  - outward ("[^"]+")\[(\d+)\]$/gm)].map(m => [JSON.parse(m[1]!), Number(m[2])]);
  assert.deepEqual(refs, [["b", 1], ["a", 0], ["b", 1], ...names.slice(2).map((_, i) => ["a", i + 2])]);
  assert.match(text, /"via":"client","confidence":0\.75/);
  assert.match(rows, /different\.ts:88/);
  assert.match(rows, /http-host a-long-service-name-0\.example/);
  assert.match(text, /unknown: unknown \(unavailable\)/);
  assert.match(text, /unresolved call sites \(2\):[\s\S]*  a:[\s\S]*src\/shared.ts[\s\S]*call \(http, through client\) GET \/route[\s\S]*  b:/);
  const invalid = { ...value, repositorySnapshots: value.repositorySnapshots.map(item => item.repo === "b" ? { ...item, snapshot: snapshot("wrong") } : item) };
  const invalidText = renderWorkspace({ ...base, status: "complete", value: invalid } as never, "details");
  assert.doesNotMatch(invalidText, /  - outward "b"\[/);
  assert.match(invalidText, /b:src\/a-long-shared-location.ts:2/);
  const wrongSnapshot = snapshot("wrong");
  const bothWrong = { ...value, sections: { ...value.sections, b: { ...value.sections.b, snapshot: wrongSnapshot } }, repositorySnapshots: value.repositorySnapshots.map(item => item.repo === "b" ? { ...item, snapshot: wrongSnapshot } : item) };
  const wrongOwnerText = renderWorkspace({ ...base, status: "complete", value: bothWrong } as never, "details");
  assert.doesNotMatch(wrongOwnerText, /  - outward "b"\[/);
  assert.match(wrongOwnerText, /b:src\/a-long-shared-location.ts:2/);
  assert.equal(JSON.stringify(fact), before);
});

test("whole-category reference requires the same order as the displayed names", () => {
  const names = Array.from({ length: 12 }, (_, i) => ({ kind: "http-host", name: `long-service-${i}.example`, evidence: [{ path: "src/a-very-long-shared-evidence-file.ts", line: i + 1 }] }));
  const unserved = names.map(name => ({ ...name, evidence: name.evidence.map(e => ({ ...e, repo: "a" })) }));
  const value = { workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [{ repo: "a", snapshot: base.snapshot }], sections: { a: { ...base, status: "complete", value: { names, unresolved: [] } } }, candidates: [], unserved: [...unserved].reverse() };
  const text = renderWorkspace({ ...base, status: "complete", value } as never, "details");
  assert.doesNotMatch(text, /all recorded outward names are unserved/);
  const indexes = [...text.matchAll(/^  - outward "a"\[(\d+)\]$/gm)].map(m => Number(m[1]));
  assert.deepEqual(indexes, names.map((_, i) => names.length - i - 1));
  for (let i = 0; i < names.length; i++) assert.ok(text.includes(`- [${i}] ${names[i]!.name} (`));
});

test("invalid snapshot ownership and tiny results retain literal rows", () => {
  const name = { kind: "http-host", name: "host", evidence: [{ path: "a.ts", line: 1 }] };
  const snapshot = { ...base.snapshot, sha: "b".repeat(40) };
  const value = { workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [{ repo: "a", snapshot }], sections: { a: { ...base, status: "complete", value: { names: [name], unresolved: [] } } }, candidates: [], unserved: [{ ...name, evidence: [{ ...name.evidence[0]!, repo: "a" }] }] };
  for (const v of [value, { ...value, repositorySnapshots: [{ repo: "a", snapshot: base.snapshot }] }]) {
    const text = renderWorkspace({ ...base, status: "complete", value: v } as never, "details");
    assert.match(text, /  - http-host host \(a:a\.ts:1\)/);
    assert.doesNotMatch(text, /  - outward /);
  }
  const empty = { ...value, unserved: [], sections: { a: { ...base, status: "complete", value: { names: [], unresolved: [] } } } };
  assert.match(renderWorkspace({ ...base, status: "complete", value: empty } as never, "details"), /no local repository serves \(0\)/);
});
