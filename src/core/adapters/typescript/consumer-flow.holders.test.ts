import assert from "node:assert/strict";
import test from "node:test";
import { createConsumerReaders } from "./consumer-readers.ts";

const header = "import { HttpClient } from '@angular/common/http'; import { signal, computed, inject } from '@angular/core'; import { tap } from 'rxjs';\n";

test("a response held in a signal reaches its readonly alias and an injected reader", async () => {
  const files = [
    { path: "api.ts", content: header + [
      "export class Api {",
      "  state = signal(null);",
      "  account = this.state.asReadonly(); derived = computed(() => this.state()); ignored = computed(() => null);",
      "  constructor(private http: HttpClient) {}",
      "  load() { return this.http.get('/me').pipe(tap(account => this.state.set(account))) }",
      "  own() { return this.state()?.authorities.length }",
      "}",
    ].join("\n") },
    { path: "page.ts", content: header + "import { Api } from './api';\nclass Page { api = inject(Api); read() { const current = this.api.account; return computed(() => current()?.authorities.length) } }" },
  ];
  const { flow } = await createConsumerReaders(files, "repo", undefined, []);
  const response = flow.follow({ site: { kind: "call-site", repo: "repo", file: "api.ts", line: 6, symbol: "Api.load" }, path: ["authorities"] });
  const held = response.next.find(({ carrier }) => carrier.site.kind === "member" && carrier.site.member === "state");
  assert.ok(held !== undefined);
  const state = flow.follow(held.carrier);
  assert.ok(state.uses.some(({ site }) => site.line === 7));
  const alias = state.next.find(({ carrier }) => carrier.site.kind === "member" && carrier.site.member === "account");
  assert.ok(alias !== undefined);
  assert.ok(state.next.some(({ carrier }) => carrier.site.kind === "member" && carrier.site.member === "derived"));
  assert.equal(state.next.some(({ carrier }) => carrier.site.kind === "member" && carrier.site.member === "ignored"), false);
  const read = flow.follow({ site: { kind: "member-read", repo: "repo", file: "page.ts", line: 3, column: 1, owner: "Api", member: "account" }, path: alias.carrier.path });
  assert.ok(read.uses.some(({ site, path }) => site.path === "page.ts" && path.join(".") === "authorities.length"));
});

test("a form holder maps whole values and controls and records the value consumed by its controls", async () => {
  const files = [{ path: "form.ts", content: [
    "class Page {",
    "  form: FormGroup;",
    "  fill(account) { this.form.patchValue(account);",
    "    const value = this.form.getRawValue(); show(value.authorities.length);",
    "    show(this.form.value.authorities.length);",
    "    show(this.form.controls.authorities.value.length);",
    "  }",
    "}",
  ].join("\n") }];
  const { flow } = await createConsumerReaders(files, "repo", undefined, []);
  const write = flow.follow({ site: { kind: "method-parameter", repo: "repo", file: "form.ts", owner: "Page", method: "fill", index: 0 }, path: ["authorities"] });
  assert.equal(write.uses.length, 1);
  assert.equal(write.next.length, 1);
  const reads = write.next.map(({ carrier }) => flow.follow(carrier));
  assert.equal(reads.flatMap(({ uses }) => uses).length, 3);
  assert.deepEqual(reads.flatMap(({ uses }) => uses.map(({ site }) => site.line)).sort(), [4, 5, 6]);
  assert.deepEqual(reads.flatMap(({ uses }) => uses.map(({ changed }) => changed.join("."))).sort(), ["authorities", "authorities", "authorities.value"]);
  assert.equal(reads.flatMap(({ frontiers }) => frontiers).length, 0);
});

test("a holder outside the table preserves an explicit frontier", async () => {
  const { flow } = await createConsumerReaders([{ path: "store.ts", content: "function hold(value) { store.select(value) }" }], "repo", undefined, []);
  const result = flow.follow({ site: { kind: "parameter", repo: "repo", file: "store.ts", line: 1, symbol: "hold", index: 0 }, path: ["authorities"] });
  assert.equal(result.next.length, 0);
  assert.equal(result.frontiers[0]?.cause, "unmodelled-sink");
  assert.equal(result.frontiers[0]?.detail, "holder:select");
});


test("a project method named like a holder remains a project call", async () => {
  const files = [{ path: "custom.ts", content: "class Custom { patchValue(value) { return value } }\nclass Page { custom: Custom; fill(value) { return this.custom.patchValue(value) } }" }];
  const { flow } = await createConsumerReaders(files, "repo", undefined, []);
  const result = flow.follow({ site: { kind: "method-parameter", repo: "repo", file: "custom.ts", owner: "Page", method: "fill", index: 0 }, path: ["authorities"] });
  assert.equal(result.uses.length, 0);
  assert.ok(result.next.some(({ carrier }) => carrier.site.kind === "parameter"));
  assert.equal(result.next.some(({ carrier }) => carrier.site.kind === "member"), false);
});


test("a namespace factory needs the module declared by its holder row", async () => {
  const angular = await createConsumerReaders([{ path: "angular.ts", content: "import * as ng from '@angular/core';\nfunction hold(value) { return ng.signal(value) }" }], "repo", undefined, []);
  const held = angular.flow.follow({ site: { kind: "parameter", repo: "repo", file: "angular.ts", line: 2, symbol: "hold", index: 0 }, path: ["authorities"] });
  assert.ok(held.next.some(({ carrier }) => carrier.site.kind === "return"));
  const { flow } = await createConsumerReaders([{ path: "foreign.ts", content: "import * as foreign from 'other';\nfunction hold(value) { return foreign.signal(value) }" }], "repo", undefined, []);
  const result = flow.follow({ site: { kind: "parameter", repo: "repo", file: "foreign.ts", line: 2, symbol: "hold", index: 0 }, path: ["authorities"] });
  assert.equal(result.next.length, 0);
  assert.equal(result.uses.length, 0);
  assert.equal(result.frontiers[0]?.cause, "unmodelled-sink");
});

test("a computed holder consumes a returned dependency while a bare guard remains a test", async () => {
  const files = [{ path: "computed.ts", content: "import { computed } from '@angular/core';\nfunction hold(value) {\n const result = computed(() => value.authorities && permit());\n if (result()) render();\n if (value.authorities) ignore();\n}" }];
  const { flow } = await createConsumerReaders(files, "repo", undefined, []);
  const result = flow.follow({ site: { kind: "parameter", repo: "repo", file: "computed.ts", line: 2, symbol: "hold", index: 0 }, path: ["authorities"] });
  assert.equal(result.uses.length, 1);
  assert.equal(result.uses[0]?.operation.end.kind, "consume");
  assert.equal(result.uses[0]?.site.line, 3);
});


test("a function stored in a signal is not executed as a computed callback", async () => {
  const { flow } = await createConsumerReaders([{ path: "stored.ts", content: "import { signal } from '@angular/core';\nfunction hold(value) { const stored = signal(() => value); return stored }" }], "repo", undefined, []);
  const result = flow.follow({ site: { kind: "parameter", repo: "repo", file: "stored.ts", line: 2, symbol: "hold", index: 0 }, path: ["authorities"] });
  assert.equal(result.uses.length, 0);
  assert.equal(result.next.length, 0);
  assert.ok(result.frontiers.length > 0);
});


test("a setter name on the carried response is not a write into a holder", async () => {
  const { flow } = await createConsumerReaders([{ path: "receiver.ts", content: "function read(value) { value.patchValue() }" }], "repo", undefined, []);
  const result = flow.follow({ site: { kind: "parameter", repo: "repo", file: "receiver.ts", line: 1, symbol: "read", index: 0 }, path: ["authorities"] });
  assert.equal(result.next.length, 0);
  assert.equal(result.frontiers.length, 1);
  assert.equal(result.frontiers[0]?.cause, "unmodelled-flow");
});
