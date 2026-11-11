import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgram } from "./consumer-flow.index.ts";
import { createRequestCallLookup } from "./http-call-sites.adapter.ts";
import { createConsumerReaders } from "./consumer-readers.ts";
import type { FrameworkPlugin } from "../../ports/framework-plugin.port.ts";

test("without framework contributions generic flow survives while inputs report an absent capability", async () => {
  const files = [{ path: "a.ts", content: "import { Input } from '@angular/core';\nclass Page { @Input() order: any; }\nfunction use(order: any) { console.log(order.owner); }" }];
  const readers = await createConsumerReaders(files, "repo", undefined, []);
  const generic = readers.flow.follow({ site: { kind: "parameter", repo: "repo", file: "a.ts", symbol: "use", line: 3, index: 0 }, path: ["owner"] });
  assert.ok(generic.uses.length > 0);
  const input = readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "order" }, path: ["owner"] });
  assert.equal(input.next.length, 0);
  assert.equal(input.frontiers[0]?.reason, "no-extractor");
});

test("independent framework continuations survive together in deterministic order", async () => {
  const files = [{ path: "a.ts", content: "import { one } from 'first'; import { two } from 'second';\nexport function source() { return 1; }" }];
  const carrier = { site: { kind: "return" as const, repo: "repo", file: "a.ts", symbol: "source", line: 2 }, path: [] };
  const plugin = (name: string, line: number): FrameworkPlugin => ({
    languages: ["typescript"], signal: { dependency: name, module: name },
    consumer: { prepare: async () => ({ follow: () => ({ flow: { uses: [], next: [], frontiers: [] }, claims: [{ site: { path: "a.ts", line }, offset: line, context: name, evidence: [{ path: "a.ts", line }], next: [{ carrier: { site: { kind: "input", repo: "repo", file: "a.ts", owner: name, name: "value" }, path: [] }, hops: [] }] }] }) }) },
  });
  const first = plugin("first", 4);
  const second = plugin("second", 3);
  const forward = await createConsumerReaders(files, "repo", undefined, [first, second]);
  const reverse = await createConsumerReaders(files, "repo", undefined, [second, first]);
  const a = forward.flow.follow(carrier);
  const b = reverse.flow.follow(carrier);
  assert.deepEqual(a, b);
  assert.equal(a.next.length, 2);
});

test("incompatible claims for the same occurrence and context report both evidence sites", async () => {
  const files = [{ path: "a.ts", content: "import { one } from 'first'; import { two } from 'second';\nexport function source() { return 1; }" }];
  const carrier = { site: { kind: "return" as const, repo: "repo", file: "a.ts", symbol: "source", line: 2 }, path: [] };
  const plugin = (name: string, line: number): FrameworkPlugin => ({
    languages: ["typescript"], signal: { dependency: name, module: name },
    consumer: { prepare: async () => ({ follow: () => ({ flow: { uses: [], next: [], frontiers: [] }, claims: [{ site: { path: "a.ts", line: 2 }, offset: 10, context: "root", evidence: [{ path: "a.ts", line }], next: [{ carrier: { site: { kind: "input", repo: "repo", file: "a.ts", owner: name, name: "value" }, path: [] }, hops: [] }] }] }) }) },
  });
  const readers = await createConsumerReaders(files, "repo", undefined, [plugin("first", 4), plugin("second", 5)]);
  const result = readers.flow.follow(carrier);
  assert.equal(result.next.length, 0);
  assert.deepEqual(result.frontiers.map(({ at, cause, reason }) => ({ at, cause, reason })), [4, 5].map((line) => ({ at: { path: "a.ts", line }, cause: "path-conflict", reason: "unresolved" })));
});

test("claims with the same destination and different evidence do not conflict or depend on registration order", async () => {
  const files = [{ path: "a.ts", content: "import { one } from 'first'; import { two } from 'second';\nexport function source() { return 1; }" }];
  const carrier = { site: { kind: "return" as const, repo: "repo", file: "a.ts", symbol: "source", line: 2 }, path: [] };
  const plugin = (name: string, line: number): FrameworkPlugin => ({ languages: ["typescript"], signal: { dependency: name, module: name }, consumer: { prepare: async () => ({ follow: () => ({ flow: { uses: [], next: [], frontiers: [] }, claims: [{ site: { path: "a.ts", line: 2 }, offset: 10, context: "root", evidence: [{ path: "a.ts", line }], next: [{ carrier: { site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "value" }, path: [] }, hops: [{ step: "resolver-input", evidence: { path: "a.ts", line } }] }] }] }) }) } });
  const one = plugin("first", 4), two = plugin("second", 5);
  const first = (await createConsumerReaders(files, "repo", undefined, [one, two])).flow.follow(carrier);
  const second = (await createConsumerReaders(files, "repo", undefined, [two, one])).flow.follow(carrier);
  assert.deepEqual(first, second);
  assert.equal(first.next.length, 2);
  assert.deepEqual(first.next.map((one) => one.hops[0]?.evidence.line), [4, 5]);
  assert.equal(first.frontiers.length, 0);
});

test("equal destinations keep distinct claim evidence even when their hops match", async () => {
  const files = [{ path: "a.ts", content: "import { one } from 'first'; import { two } from 'second'; export function source() {}" }];
  const plugin = (name: string, line: number): FrameworkPlugin => ({ languages: ["typescript"], signal: { dependency: name, module: name }, consumer: { prepare: async () => ({ follow: () => ({ flow: { uses: [], next: [], frontiers: [] }, claims: [{ site: { path: "a.ts", line: 1 }, offset: 1, context: "root", evidence: [{ path: "a.ts", line }], next: [{ carrier: { site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "value" }, path: [] }, hops: [] }] }] }) }) } });
  const readers = await createConsumerReaders(files, "repo", undefined, [plugin("first", 4), plugin("second", 5)]);
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "source", line: 1 }, path: [] });
  assert.deepEqual(result.next.map((one) => one.evidence?.[0]?.line), [4, 5]);
});

test("one complete claim may contain multiple independent destinations", async () => {
  const files = [{ path: "a.ts", content: "import { one } from 'first';\nexport function source() { return 1; }" }];
  const plugin: FrameworkPlugin = { languages: ["typescript"], signal: { dependency: "first", module: "first" }, consumer: { prepare: async () => ({ follow: () => ({ flow: { uses: [], next: [], frontiers: [] }, claims: [{ site: { path: "a.ts", line: 2 }, offset: 10, context: "root", evidence: [{ path: "a.ts", line: 2 }], next: ["First", "Second"].map((owner) => ({ carrier: { site: { kind: "input" as const, repo: "repo", file: "a.ts", owner, name: "value" }, path: [] }, hops: [] })) }] }) }) } };
  const readers = await createConsumerReaders(files, "repo", undefined, [plugin]);
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "source", line: 2 }, path: [] });
  assert.equal(result.next.length, 2);
  assert.equal(result.frontiers.length, 0);
});

test("framework applicability requires project dependency and file evidence, including returns", async () => {
  const files = [{ path: "yes/package.json", content: '{"dependencies":{"first":"1"}}' }, { path: "no/package.json", content: '{"dependencies":{}}' }, { path: "yes/a.ts", content: "import { one } from 'first'; export function source() { return 1; }" }, { path: "yes/unrelated.ts", content: "export function source() { return 1; }" }, { path: "no/a.ts", content: "import { one } from 'first'; export function source() { return 1; }" }];
  const called: string[] = [];
  const plugin: FrameworkPlugin = { languages: ["typescript"], signal: { dependency: "first", module: "first" }, consumer: { prepare: async () => ({ follow: (carrier) => { called.push(carrier.site.kind === "return" ? carrier.site.file : "other"); return { flow: { uses: [], frontiers: [], next: [{ carrier: { site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "value" }, path: [] }, hops: [] }] }, claims: [] }; } }) } };
  const readers = await createConsumerReaders(files, "repo", undefined, [plugin]);
  const follow = (file: string) => readers.flow.follow({ site: { kind: "return", repo: "repo", file, symbol: "source", line: 1 }, path: [] });
  assert.equal(follow("yes/a.ts").next.length, 1);
  assert.equal(follow("yes/unrelated.ts").next.length, 0);
  assert.equal(follow("no/a.ts").next.length, 0);
  assert.deepEqual(called, ["yes/a.ts"]);
});

test("each repository reading shares request preparation between flow and origins", async () => {
  let builds = 0;
  let bodies = 0;
  const deps = {
    buildProgram: (files: Parameters<typeof buildProgram>[0]) => { builds++; return buildProgram(files); },
    createRequestCallLookup: (files: Parameters<typeof createRequestCallLookup>[0]) => { bodies++; return createRequestCallLookup(files); },
  };
  const files = [{ path: "a.ts", content: "function send() { fetch('/x', { method: 'POST', body: JSON.stringify({ id: 1 }) }); }" }];
  const first = await createConsumerReaders(files, "one", deps);
  first.flow.follow({ site: { kind: "call-site", repo: "one", file: "a.ts", line: 1, symbol: "send" }, path: ["id"] });
  assert.equal(builds, 1);
  assert.equal(bodies, 1);
  await first.origins.ofBody({ file: "a.ts", line: 1, symbol: "send" }, ["id"]);
  await first.origins.ofBody({ file: "a.ts", line: 1, symbol: "send" }, ["id"]);
  assert.equal(builds, 1);
  assert.equal(bodies, 1);
  const second = await createConsumerReaders(files, "two", deps);
  assert.equal(bodies, 2);
  await second.origins.ofBody({ file: "a.ts", line: 1, symbol: "send" }, ["id"]);
  assert.equal(builds, 2);
  assert.equal(bodies, 2);
});

test("framework factories in one reading receive the same reading object once", async () => {
  const seen: unknown[] = [];
  const plugin = (name: string): FrameworkPlugin => ({ languages: ["typescript"], signal: { dependency: name, module: name }, consumer: { async prepare(reading) { seen.push(reading); return { follow: () => undefined }; } } });
  const files = [{ path: "a.ts", content: "import { one } from 'first'; import { two } from 'second';" }];
  const readers = await createConsumerReaders(files, "repo", undefined, [plugin("first"), plugin("second")]);
  const result = readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "value" }, path: [] });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(result.frontiers[0]?.reason, "no-extractor");
});

test("a framework that declares consumer capability absent reports a frontier without preparing it", async () => {
  let prepared = false;
  const plugin: FrameworkPlugin = { languages: ["typescript"], signal: { dependency: "first", module: "first" }, absent: ["consumer"], consumer: { async prepare() { prepared = true; return { follow: () => undefined }; } } };
  const readers = await createConsumerReaders([{ path: "a.ts", content: "import { item } from 'first';" }], "repo", undefined, [plugin]);
  const result = readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "value" }, path: [] });
  assert.equal(prepared, false);
  assert.equal(result.frontiers[0]?.reason, "capability-absent");
  const none = await createConsumerReaders([{ path: "a.ts", content: "import { item } from 'first';" }], "repo", undefined, []);
  assert.equal(none.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "value" }, path: [] }).frontiers[0]?.reason, "no-extractor");
});
