import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import { buildEntrypointMap, declaredScope, type EntrypointMapFact, type MapBase } from "../../domain/map/entrypoint-map.ts";
import { SCHEMA, type Cut, type Finding } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { EntrypointQueries, MapRequest } from "../../ports/entrypoint-queries.port.ts";
import type { FixedLayerFault, FixedLayerStore } from "../../ports/fixed-layer-store.port.ts";
import { REDACTED, type Redaction } from "../../ports/redaction.port.ts";
import type { VcsFault } from "../../ports/vcs.port.ts";
import { ENTRYPOINTS_DIGEST_FILE, ENTRYPOINTS_FACT_FILE, createFixedLayerAdmin } from "./fixed-layer-admin.ts";

const REQUEST: MapRequest = { repo: "/work/checkout", repoId: "shop", revision: "main" };
const SHA = "a".repeat(40);
const SECRET = "hunter2-secret";

function base(overrides: { content?: string; producerVersion?: string } = {}): MapBase {
  return {
    schema: SCHEMA,
    snapshot: { repo: "shop", kind: "sha", sha: SHA },
    producer: { name: "ye-ast", version: overrides.producerVersion ?? "1.0.0" },
    inputs: {
      trust: "untrusted",
      scope: "scope-digest",
      declaredScope: declaredScope(),
      content: overrides.content ?? "content-1",
      config: "config-digest",
      declaredConfig: {},
      engines: { typescript: "6.0.3" },
    },
  };
}

function route(name: string, path: string, line: number): Finding<HttpRoute> {
  return {
    status: "complete",
    evidence: [{ path, line }],
    value: {
      kind: "http-route",
      name,
      method: "GET",
      path: name.slice(4),
      handler: { path, symbol: "OrdersController.list", line },
      basePath: { status: "complete", evidence: [], value: { default: {}, profiles: {} } },
    },
  };
}

function mapFact(
  overrides: { content?: string; producerVersion?: string; findings?: Finding<HttpRoute>[]; cut?: Cut } = {},
): EntrypointMapFact {
  const fact = buildEntrypointMap(
    base(overrides),
    overrides.findings ?? [route("GET /orders", "src/OrdersController.java", 12)],
    { files: [], skipped: [] },
  );
  if (overrides.cut === undefined) return fact;
  return { ...fact, status: "partial", cuts: [overrides.cut] };
}

class FakeStore implements FixedLayerStore {
  files = new Map<string, string>();
  writes: string[] = [];
  readFault?: FixedLayerFault;
  writeFault?: { name: string; fault: FixedLayerFault };
  async read(_root: string, name: string): Promise<Result<string | undefined, FixedLayerFault>> {
    return this.readFault ? { ok: false, fault: this.readFault } : { ok: true, value: this.files.get(name) };
  }
  async write(_root: string, name: string, content: string): Promise<Result<void, FixedLayerFault>> {
    if (this.writeFault?.name === name) return { ok: false, fault: this.writeFault.fault };
    this.files.set(name, content);
    this.writes.push(name);
    return { ok: true, value: undefined };
  }
}

const patternsOnly: Redaction = {
  redact: (text) => text.replaceAll(SECRET, REDACTED),
  redactValue: (value) => JSON.parse(JSON.stringify(value).replaceAll(SECRET, REDACTED)),
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: String,
  containsSecret: () => false,
};

function setup(facts: Result<EntrypointMapFact, VcsFault>[]) {
  const store = new FakeStore();
  const requests: MapRequest[] = [];
  const queue = [...facts];
  const entrypoints: EntrypointQueries = {
    map: async (request) => {
      requests.push(request);
      const next = queue.shift() ?? queue[0];
      assert.ok(next, "the fake has a fact to answer");
      return next;
    },
  };
  return { store, requests, admin: createFixedLayerAdmin({ entrypoints, store, redaction: patternsOnly }) };
}

const ok = (fact: EntrypointMapFact): Result<EntrypointMapFact, VcsFault> => ({ ok: true, value: fact });

test("the first refresh writes the digest and then the fact as JSON, the commit point", async () => {
  const { admin, store, requests } = setup([ok(mapFact())]);
  const result = await admin.refresh(REQUEST);
  assert.deepEqual(result, { ok: true, value: { outcome: "written", files: [ENTRYPOINTS_DIGEST_FILE, ENTRYPOINTS_FACT_FILE] } });
  assert.deepEqual(store.writes, [ENTRYPOINTS_DIGEST_FILE, ENTRYPOINTS_FACT_FILE]);
  assert.deepEqual(JSON.parse(store.files.get(ENTRYPOINTS_FACT_FILE) ?? ""), JSON.parse(JSON.stringify(mapFact())));
  assert.deepEqual(requests, [REQUEST]);
});

test("a refresh with equal inputs and producer writes nothing and leaves the bytes identical", async () => {
  const { admin, store } = setup([ok(mapFact()), ok(mapFact({ findings: [] }))]);
  await admin.refresh(REQUEST);
  const before = new Map(store.files);
  store.writes.length = 0;
  const result = await admin.refresh(REQUEST);
  assert.equal(result.ok && result.value.outcome, "unchanged");
  assert.deepEqual(store.writes, []);
  assert.deepEqual(store.files, before);
});

test("a stored layer stamped with an older schema is rewritten even when its inputs and producer are equal", async () => {
  const { admin, store } = setup([ok(mapFact()), ok(mapFact())]);
  await admin.refresh(REQUEST);
  const stored = JSON.parse(store.files.get(ENTRYPOINTS_FACT_FILE) ?? "") as EntrypointMapFact;
  store.files.set(ENTRYPOINTS_FACT_FILE, JSON.stringify({ ...stored, schema: "0.0.1" }));
  store.writes.length = 0;
  const result = await admin.refresh(REQUEST);
  assert.equal(result.ok && result.value.outcome, "written");
});

test("a stored layer whose values are equal in a different key order is unchanged", async () => {
  const { admin, store } = setup([ok(mapFact()), ok(mapFact())]);
  await admin.refresh(REQUEST);
  const stored = JSON.parse(store.files.get(ENTRYPOINTS_FACT_FILE) ?? "") as EntrypointMapFact;
  const reordered = {
    producer: stored.producer,
    schema: stored.schema,
    inputs: Object.fromEntries(Object.entries(stored.inputs).reverse()),
    snapshot: stored.snapshot,
  };
  store.files.set(ENTRYPOINTS_FACT_FILE, JSON.stringify(reordered));
  store.writes.length = 0;
  const result = await admin.refresh(REQUEST);
  assert.equal(result.ok && result.value.outcome, "unchanged");
  assert.deepEqual(store.writes, []);
});

test("a changed content digest rewrites both files", async () => {
  const { admin, store } = setup([ok(mapFact()), ok(mapFact({ content: "content-2" }))]);
  await admin.refresh(REQUEST);
  store.writes.length = 0;
  const result = await admin.refresh(REQUEST);
  assert.equal(result.ok && result.value.outcome, "written");
  assert.deepEqual(store.writes, [ENTRYPOINTS_DIGEST_FILE, ENTRYPOINTS_FACT_FILE]);
  assert.match(store.files.get(ENTRYPOINTS_FACT_FILE) ?? "", /content-2/);
});

test("a changed producer version rewrites both files", async () => {
  const { admin, store } = setup([ok(mapFact()), ok(mapFact({ producerVersion: "1.1.0" }))]);
  await admin.refresh(REQUEST);
  store.writes.length = 0;
  const result = await admin.refresh(REQUEST);
  assert.equal(result.ok && result.value.outcome, "written");
  assert.match(store.files.get(ENTRYPOINTS_DIGEST_FILE) ?? "", /ye-ast 1\.1\.0/);
});

test("a layer whose digest is missing is rewritten even when the stored fact has equal inputs", async () => {
  const { admin, store } = setup([ok(mapFact()), ok(mapFact())]);
  await admin.refresh(REQUEST);
  store.files.delete(ENTRYPOINTS_DIGEST_FILE);
  store.writes.length = 0;
  const result = await admin.refresh(REQUEST);
  assert.equal(result.ok && result.value.outcome, "written");
  assert.deepEqual(store.writes, [ENTRYPOINTS_DIGEST_FILE, ENTRYPOINTS_FACT_FILE]);
});

test("a stored fact that is not JSON is rewritten", async () => {
  const { admin, store } = setup([ok(mapFact())]);
  store.files.set(ENTRYPOINTS_FACT_FILE, "{ truncated");
  const result = await admin.refresh(REQUEST);
  assert.equal(result.ok && result.value.outcome, "written");
});

test("a fact cut by a deadline is never written, even over an older layer", async () => {
  const { admin, store } = setup([ok(mapFact({ cut: { kind: "deadline", at: ["src"], reason: "deadline", reach: { kind: "anything" } } }))]);
  store.files.set(ENTRYPOINTS_FACT_FILE, "old");
  const result = await admin.refresh(REQUEST);
  assert.deepEqual(result, { ok: true, value: { outcome: "not-written", reason: "deadline" } });
  assert.deepEqual(store.writes, []);
  assert.equal(store.files.get(ENTRYPOINTS_FACT_FILE), "old");
});

test("a deadline on an item is not written either", async () => {
  const unknownItem: Finding<HttpRoute> = { status: "unknown", reason: "deadline", evidence: [{ path: "src/A.java", line: 1 }] };
  const { admin, store } = setup([ok(mapFact({ findings: [unknownItem] }))]);
  const result = await admin.refresh(REQUEST);
  assert.deepEqual(result, { ok: true, value: { outcome: "not-written", reason: "deadline" } });
  assert.deepEqual(store.writes, []);
});

test("an item unknown for another reason is an answer and is written", async () => {
  const unknownItem: Finding<HttpRoute> = { status: "unknown", reason: "unresolved", evidence: [{ path: "src/A.java", line: 1 }] };
  const { admin, store } = setup([ok(mapFact({ findings: [unknownItem] }))]);
  const result = await admin.refresh(REQUEST);
  assert.equal(result.ok && result.value.outcome, "written");
  assert.match(store.files.get(ENTRYPOINTS_DIGEST_FILE) ?? "", /unknown \(unresolved\) at `src\/A\.java:1`/);
});

test("an item unknown because the index is unavailable is never written", async () => {
  const unknownItem: Finding<HttpRoute> = { status: "unknown", reason: "index-unavailable", evidence: [] };
  const { admin, store } = setup([ok(mapFact({ findings: [unknownItem] }))]);
  const result = await admin.refresh(REQUEST);
  assert.deepEqual(result, { ok: true, value: { outcome: "not-written", reason: "index-unavailable" } });
  assert.deepEqual(store.writes, []);
});

test("the digest renders snapshot, producer, schema, status, every cut with its places and each entrypoint with path:line", async () => {
  const cut: Cut = { kind: "not-exported", at: ["src/Link.java", "src/Caller.java:7 symlink"], limit: 3, reason: "unwritten", reach: { kind: "anything" } };
  const findings = [route("GET /orders", "src/OrdersController.java", 12), route("GET /users", "src/UsersController.java", 30)];
  const { admin, store } = setup([ok(mapFact({ findings, cut }))]);
  await admin.refresh(REQUEST);
  const digest = store.files.get(ENTRYPOINTS_DIGEST_FILE) ?? "";
  for (const expected of [
    `shop at \`${SHA}\``,
    "ye-ast 1.0.0",
    `Schema: ${SCHEMA}`,
    "Completeness: partial",
    "`not-exported` at `src/Link.java` (limit 3)",
    "`src/Caller.java:7 symlink`",
    "`http-route GET /orders` at `src/OrdersController.java:12`",
    "`http-route GET /users` at `src/UsersController.java:30`",
  ]) {
    assert.ok(digest.includes(expected), expected);
  }
  assert.ok(digest.indexOf("GET /orders") < digest.indexOf("GET /users"));
});

test("the digest names the include and exclude globs of the declared scope", async () => {
  const fact = mapFact();
  const scoped = { ...fact, inputs: { ...fact.inputs, declaredScope: declaredScope({ include: ["svc/**"], exclude: ["svc/static/**"] }) } };
  const { admin, store } = setup([ok(scoped)]);
  await admin.refresh(REQUEST);
  const digest = store.files.get(ENTRYPOINTS_DIGEST_FILE) ?? "";
  assert.match(digest, /include svc\/\*\*/);
  assert.match(digest, /exclude svc\/static\/\*\*/);
});

test("the digest of a complete fact without entrypoints says so", async () => {
  const { admin, store } = setup([ok(mapFact({ findings: [] }))]);
  await admin.refresh(REQUEST);
  const digest = store.files.get(ENTRYPOINTS_DIGEST_FILE) ?? "";
  assert.match(digest, /Completeness: complete/);
  assert.match(digest, /None: complete within the declared scope/);
  assert.match(digest, /None found within the declared scope/);
});

test("both files hold the redacted fact, never the secret", async () => {
  const findings = [route(`GET /orders/${SECRET}`, "src/OrdersController.java", 12)];
  const { admin, store } = setup([ok(mapFact({ findings }))]);
  await admin.refresh(REQUEST);
  for (const name of [ENTRYPOINTS_FACT_FILE, ENTRYPOINTS_DIGEST_FILE]) {
    const content = store.files.get(name) ?? "";
    assert.ok(!content.includes(SECRET), name);
    assert.ok(content.includes(REDACTED), name);
  }
});

test("the bytes of two refreshes of the same fact are identical", async () => {
  const first = setup([ok(mapFact())]);
  const second = setup([ok(mapFact())]);
  await first.admin.refresh(REQUEST);
  await second.admin.refresh(REQUEST);
  assert.deepEqual(first.store.files, second.store.files);
});

test("a map fault is answered as it is and nothing is written", async () => {
  const fault: VcsFault = { kind: "unknown-revision", detail: "no such revision" };
  const { admin, store } = setup([{ ok: false, fault }]);
  assert.deepEqual(await admin.refresh(REQUEST), { ok: false, fault });
  assert.deepEqual(store.writes, []);
});

test("a read fault of the store is answered as it is and nothing is written", async () => {
  const { admin, store } = setup([ok(mapFact())]);
  store.readFault = { kind: "unreadable", detail: "not a directory" };
  assert.deepEqual(await admin.refresh(REQUEST), { ok: false, fault: store.readFault });
  assert.deepEqual(store.writes, []);
});

test("a failed digest write is answered as it is and the fact is not written, so the next refresh retries", async () => {
  const { admin, store } = setup([ok(mapFact())]);
  const fault: FixedLayerFault = { kind: "unwritable", detail: "read-only" };
  store.writeFault = { name: ENTRYPOINTS_DIGEST_FILE, fault };
  assert.deepEqual(await admin.refresh(REQUEST), { ok: false, fault });
  assert.deepEqual(store.writes, []);
});
