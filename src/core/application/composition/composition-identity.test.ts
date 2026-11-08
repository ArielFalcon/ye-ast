import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "./compose-evidence-test-sets.testing.ts";
import { SCHEMA, type Fact } from "../../domain/shared/fact.ts";
import type { PartPayload, SourceId, Support } from "../../ports/evidence-composition.port.ts";
import {
  anchorId, compositionIdentity, compositionKey, evidenceId, fileId, jsonPointer, partId, readId,
  snapshotId, sortById, sourceId, unionSupports, type SourceIdentityInput,
} from "./composition-identity.ts";
import { isCompositionId } from "../../domain/composition/composition-ids.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";

const SHA = "a".repeat(40);
const sha = (repo: string, value = SHA) => ({ repo, kind: "sha" as const, sha: value });
const v = (repo: string, value = SHA) => snapshotId(digest, sha(repo, value));
const at = (snapshot: ReturnType<typeof v>) => ({ kind: "snapshot" as const, snapshot });

test("ids carry their prefix and a 64-hex digest; malformed digests are refused", () => {
  const id = v("shop");
  assert.match(id, /^v1:[0-9a-f]{64}$/);
  assert.ok(isCompositionId("snapshot", id));
  assert.equal(isCompositionId("file", id), false);
  assert.equal(isCompositionId("snapshot", "v1:ABC"), false);
  assert.throws(() => compositionKey({ of: () => "short" }, "part", {}), /64 lowercase hex/);
});

test("snapshots differ by every field: repo, sha, sha against live, and the live state of one head", () => {
  const live = (stateId: string) => snapshotId(digest, { repo: "shop", kind: "live", head: SHA, stateId });
  const ids = [v("shop"), v("web"), v("shop", "b".repeat(40)), live("s1"), live("s2")];
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(snapshotId(digest, { sha: SHA, kind: "sha", repo: "shop" }), v("shop"), "member order does not matter");
});

test("files share an id only for the exact path at the same origin", () => {
  const file = (repo: string, path: string, origin: Parameters<typeof fileId>[1]["origin"]) => fileId(digest, { origin, repo, path });
  const base = file("shop", "src/A.java", at(v("shop")));
  assert.equal(file("shop", "src/A.java", at(v("shop"))), base);
  const different = [
    file("web", "src/A.java", at(v("web"))),
    file("shop", "src/A.java", at(v("shop", "b".repeat(40)))),
    file("shop", "src/a.java", at(v("shop"))),
    file("shop", "./src/A.java", at(v("shop"))),
    file("shop", "src/A.java", { kind: "query-context", read: `r1:${"0".repeat(64)}` }),
  ];
  for (const id of different) assert.notEqual(id, base);
  const context = { kind: "query-context" as const, read: `r1:${"0".repeat(64)}` as const };
  assert.notEqual(file("shop", "src/A.java", context), file("web", "src/A.java", context), "a context-local path keeps its owner repo");
});

test("anchors distinguish an absent endLine from one equal to the line, and evidence keeps via and confidence", () => {
  const file = fileId(digest, { origin: at(v("shop")), repo: "shop", path: "src/A.java" });
  const one = anchorId(digest, { file, symbol: "A.run", line: 4 });
  assert.notEqual(one, anchorId(digest, { file, symbol: "A.run", line: 4, endLine: 4 }));
  assert.notEqual(one, anchorId(digest, { file, symbol: "run", line: 4 }), "the literal symbol is the key");
  const evidence = (value: Parameters<typeof evidenceId>[1]["value"]) => evidenceId(digest, { origin: at(v("shop")), repo: "shop", value });
  const plain = evidence({ path: "src/A.java", line: 4 });
  assert.equal(evidence({ line: 4, path: "src/A.java" }), plain);
  assert.notEqual(evidence({ path: "src/A.java", line: 4, via: "fetch" }), plain);
  assert.notEqual(evidence({ path: "src/A.java", line: 4, confidence: 0.5 }), plain);
  assert.notEqual(evidenceId(digest, { origin: { kind: "query-context", read: `r1:${"0".repeat(64)}` }, repo: "shop", value: { path: "src/A.java", line: 4 } }), plain);
});

test("an occurrence makes an id local to one public position", () => {
  const payload: PartPayload = { kind: "unheld-file", file: `f1:${"1".repeat(64)}` };
  const support = (pointer: string): Support => ({ source: `s1:${"2".repeat(64)}`, read: `r1:${"3".repeat(64)}`, pointer });
  assert.equal(partId(digest, payload), partId(digest, { file: payload.file, kind: "unheld-file" }));
  assert.notEqual(partId(digest, payload, support("/value/unheld/0")), partId(digest, payload));
  assert.notEqual(partId(digest, payload, support("/value/unheld/0")), partId(digest, payload, support("/value/unheld/1")));
  const reach = (ids: string[]): PartPayload => ({ kind: "workspace-link", direction: "upstream", reach: ids.map((linkId) => ({ status: "missing", linkId })), link: { id: "x", from: { repo: "web", symbol: "f", file: payload.file, line: 1 }, to: { repo: "shop", kind: "http-route", name: "GET /", handler: `a1:${"4".repeat(64)}` }, transport: "http", basis: "exact", confidence: 1 } });
  assert.notEqual(partId(digest, reach(["a", "b"])), partId(digest, reach(["b", "a"])), "ordered arrays keep their order");
});

test("source and read ids follow family, context, fact and discriminator; reads never merge across owners", () => {
  const fact: Fact<unknown> = { schema: SCHEMA, snapshot: sha("shop"), producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [], status: "unknown", reason: "no-project" };
  const context = { repo: "shop", snapshot: fact.snapshot, declaredScope: fact.inputs.declaredScope, declaredConfig: {} };
  const input: SourceIdentityInput = { family: "outline", context: { kind: "fresh", context }, fact };
  const id = sourceId(digest, input);
  assert.match(id, /^s1:/);
  assert.notEqual(sourceId(digest, { ...input, discriminator: 0 }), id);
  assert.notEqual(sourceId(digest, { ...input, family: "importers" }), id);
  assert.notEqual(sourceId(digest, { ...input, context: { kind: "fresh", context: { ...context, offline: true } } }), id);
  assert.notEqual(sourceId(digest, { ...input, fact: { ...fact, inputs: { ...fact.inputs, trust: "trusted" } } }), id);
  assert.notEqual(sourceId(digest, { family: "impact", branch: "local", context: { kind: "fresh", context }, fact }), sourceId(digest, { family: "impact", branch: "workspace", context: { kind: "fresh", context }, fact }));
  const read = (owner: Parameters<typeof readId>[2]) => readId(digest, id, owner);
  const ids = [read({ kind: "fact" }), read({ kind: "entrypoints" }), read({ kind: "section", repo: "shop" }), read({ kind: "read", repo: "shop", index: 0, readKind: "trigger" }), read({ kind: "read", repo: "shop", index: 1, readKind: "trigger" })];
  assert.equal(new Set(ids).size, ids.length);
});

test("the composition identity is the set of its sources", () => {
  const [a, b] = [`s1:${"a".repeat(64)}`, `s1:${"b".repeat(64)}`] as SourceId[];
  const id = compositionIdentity(digest, [a!, b!]);
  assert.match(id, /^mcp-c1:[0-9a-f]{64}$/);
  assert.equal(compositionIdentity(digest, [b!, a!, b!]), id);
  assert.notEqual(compositionIdentity(digest, [a!]), id);
});

test("pointers escape RFC 6901 tokens and support sets are commutative, associative and idempotent", () => {
  assert.equal(jsonPointer(["value", "sections", "a/b~c", 2]), "/value/sections/a~1b~0c/2");
  assert.equal(jsonPointer([]), "");
  const s = (source: string, pointer: string): Support => ({ source: `s1:${source.repeat(64)}`, read: `r1:${"0".repeat(64)}`, pointer });
  const [x, y, z] = [[s("b", "/1"), s("a", "/2")], [s("a", "/2"), s("a", "/10")], [s("c", "/0")]];
  assert.deepEqual(unionSupports(x, y), unionSupports(y, x));
  assert.deepEqual(unionSupports(unionSupports(x, y), z), unionSupports(x, unionSupports(y, z)));
  assert.deepEqual(unionSupports(x, x), unionSupports(x));
  assert.deepEqual(unionSupports(x, y).map((item) => item.pointer), ["/10", "/2", "/1"], "code-unit order by source, read, pointer");
  assert.deepEqual(sortedUnique(["b", "a", "b", "B"]), ["B", "a", "b"]);
  assert.deepEqual(sortById([{ id: "p1:b" }, { id: "p1:a" }]).map((item) => item.id), ["p1:a", "p1:b"]);
});
