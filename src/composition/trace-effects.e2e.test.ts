import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import { composeCli } from "./compose.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let workspace: string;
let repo: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(workspace, "shop");
  mkdirSync(repo);
  mkdirSync(join(workspace, "scratch"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function commit(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo, env: GIT_ENV });
}

async function trace(target: string, ...also: string[]): Promise<{ status: string; value: TraceValue; cuts?: Cut[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, target, ...also], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const effectsOf = (value: TraceValue) => value.steps.flatMap((step) => (step.effects ?? []).map((effect) => [step.symbol, effect]));

test("a direct Angular HttpClient request has its effect and an unexpanded wrapper remains an effect cut", async () => {
  commit({
    "src/api.client.ts": `import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);

  post(path: string, body: unknown) {
    return this.http.post('/api' + path, body);
  }
}
`,
    "src/orders.api.ts": `import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api.client';

@Injectable({ providedIn: 'root' })
export class OrdersApi {
  private readonly api = inject(ApiClient);
  private readonly http = inject(HttpClient);

  checkout(body: unknown) {
    return this.api.post('/orders/checkout', body);
  }

  cancel(id: string) {
    return this.http.delete(\`/api/orders/\${id}\`);
  }
}
`,
  });

  const checkout = await trace("src/orders.api.ts:OrdersApi.checkout");
  const cancel = await trace("src/orders.api.ts:OrdersApi.cancel");

  assert.deepEqual(effectsOf(checkout.value), []);
  assert.ok(checkout.cuts?.some((cut) => cut.at[0]?.includes("http effect")));
  assert.deepEqual(effectsOf(cancel.value), [["cancel", { kind: "http", line: 15, target: { method: "DELETE", path: "/api/orders/{}" } }]]);
});

test("a Kafka publish is a message effect with its topic, and a call through a client library whose source the snapshot lacks is a cut naming it", async () => {
  commit({
    "src/main/java/shop/OrderEvents.java": `package shop;

import org.springframework.kafka.core.KafkaTemplate;
import com.acme.rest.AcmeRestClient;

class OrderEvents {
  private final KafkaTemplate<String, String> kafka;
  private final AcmeRestClient rest;

  OrderEvents(KafkaTemplate<String, String> kafka, AcmeRestClient rest) {
    this.kafka = kafka;
    this.rest = rest;
  }

  void created(String id) {
    kafka.send("orders.created", id);
  }

  void quote(String id) {
    rest.execute(id);
  }
}
`,
  });

  const created = await trace("src/main/java/shop/OrderEvents.java:OrderEvents.created");
  const quote = await trace("src/main/java/shop/OrderEvents.java:OrderEvents.quote");

  assert.deepEqual(effectsOf(created.value), [["created", { kind: "message", line: 16, target: { protocol: "kafka", destination: "orders.created", role: "publish" } }]]);
  assert.deepEqual(effectsOf(quote.value), []);
  assert.deepEqual(quote.cuts?.filter((cut) => cut.at[0]?.includes("effect")), [{ kind: "unresolved-link", at: ["src/main/java/shop/OrderEvents.java:20 http effect through com.acme.rest.AcmeRestClient"] }]);
});

test("a call site belongs to the declaration that owns its exact place: a same-line sibling's or an uninvoked inner function's request is no effect of the body traced", async () => {
  commit({
    "api.ts": `import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
export class Api {
 private http = inject(HttpClient);
 a() { this.http.get('/a'); } b() { this.http.get('/b'); }
 run() { const dead = () => this.http.get('/dead'); console.log('x'); }
}
`,
    "src/main/java/shop/Events.java": `package shop;

import org.springframework.kafka.core.KafkaTemplate;

class Events {
  private final KafkaTemplate<String, String> kafka;
  Events(KafkaTemplate<String, String> kafka) { this.kafka = kafka; }
  void a() { kafka.send("topic.a", "v"); } void b() { kafka.send("topic.b", "v"); }
}
`,
  });

  const a = await trace("api.ts:Api.a");
  const run = await trace("api.ts:Api.run");
  const published = await trace("src/main/java/shop/Events.java:Events.a");

  assert.deepEqual(effectsOf(a.value), [["a", { kind: "http", line: 5, target: { method: "GET", path: "/a" } }]]);
  assert.deepEqual(effectsOf(run.value), []);
  assert.equal(run.cuts?.some((cut) => cut.at[0]?.includes(" effect")) ?? false, false);
  assert.deepEqual(effectsOf(published.value), [["a", { kind: "message", line: 8, target: { protocol: "kafka", destination: "topic.a", role: "publish" } }]]);
});

test("a request or a publish inside a function value nothing proves runs is a cut of the body around it, never its effect", async () => {
  commit({
    "src/main/java/shop/Events.java": `package shop;

import org.springframework.kafka.core.KafkaTemplate;

class Events {
 private KafkaTemplate<String,String> kafka;
 void run() { Runnable dead = () -> kafka.send("topic.dead", "v"); System.out.println("x"); }
}
`,
    "api.ts": `import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
export class Api {
 private http = inject(HttpClient);
 load() { return [1].map(() => this.http.get('/each')); }
}
`,
  });

  const run = await trace("src/main/java/shop/Events.java:Events.run");
  const load = await trace("api.ts:Api.load");

  assert.deepEqual([effectsOf(run.value), run.cuts?.filter((cut) => cut.at[0]?.includes(" effect")).map((cut) => cut.at[0])], [[], ["src/main/java/shop/Events.java:7 message effect"]]);
  assert.deepEqual([effectsOf(load.value), load.cuts?.filter((cut) => cut.at[0]?.includes(" effect")).map((cut) => cut.at[0])], [[], ["api.ts:5 http effect"]]);
});

test("unproven signal reads never step into interface or unrelated model fields", async () => {
  commit({
    "src/article.ts": `export interface Article { title: string; body: string; }`,
    "src/comment.ts": `export interface Comment { body: string; }`,
    "src/state.ts": `import { inject } from '@angular/core';
import { signalStore, withState } from '@ngrx/signals';
import { Article } from './article';
const Store = signalStore(withState({ data: {} as Article }));
export class Editor {
  private store = inject(Store);
  edit() {
    this.store.data.title();
    this.store.data.body();
  }
}
`,
  });
  const result = await trace("src/state.ts:Editor.edit");
  assert.deepEqual(result.value.steps.map((step) => step.symbol), ["edit"]);
  assert.equal(result.status, "partial");
  assert.equal(result.cuts?.filter((cut) => cut.kind === "unresolved-link").length, 2);
});

test("effects propagated through an unexpanded Java body remain cuts", async () => {
  commit({
    "src/Flow.java": `import org.springframework.context.ApplicationEventPublisher;
import org.aspectj.lang.annotation.Aspect;
interface Processor { void process(); }
class ImageEvent {}
class Worker implements Processor {
  private ApplicationEventPublisher publisher;
  public void process() { publisher.publishEvent(new ImageEvent()); }
}
@Aspect class Advice {}
class Flow {
  private Processor processor;
  public void run() { processor.process(); }
}
`,
  });
  const result = await trace("src/Flow.java:Flow.run");
  assert.deepEqual(effectsOf(result.value), []);
  assert.equal(result.status, "partial");
  assert.ok(result.cuts?.some((cut) => cut.at[0]?.includes("message effect")));
  const separateRoot = await trace("src/Flow.java:Flow.run", "src/Flow.java:Worker.process");
  assert.equal(separateRoot.value.steps.find((step) => step.symbol === "run")?.effects, undefined);
});

test("identical effects at one propagated Java call are deduplicated", async () => {
  commit({
    "src/Flow.java": `import org.springframework.context.ApplicationEventPublisher;
class ImageEvent {}
class Flow {
  private ApplicationEventPublisher publisher;
  public void run() { publish(); }
  private void publish() {
    publisher.publishEvent(new ImageEvent());
    publisher.publishEvent(new ImageEvent());
  }
}
`,
  });
  const result = await trace("src/Flow.java:Flow.run");
  assert.equal(result.value.steps.find((step) => step.symbol === "run")?.effects?.length, 1);
});

test("Java overloads select the sole signature of the call arity and cut unresolved signatures", async () => {
  commit({
    "src/Flow.java": `class Facade {
  void process(String a, String b, String c, String d) { }
  void process(String a, String b, String c, String d, String e) { }
  void ambiguous(String value) { }
  void ambiguous(Integer value) { }
}
class Flow {
  private Facade facade;
  void run() { facade.process(null, null, null, null, null); }
  void unsettled() { facade.ambiguous((String) null); }
}
`,
  });
  const run = await trace("src/Flow.java:Flow.run");
  const reached = run.value.steps.flatMap((step) => [
    { symbol: step.symbol, line: step.line },
    ...(step.leaves ?? []).map((leaf) => ({ symbol: leaf.symbol, line: leaf.start })),
  ]).filter(({ symbol }) => symbol === "process");
  assert.deepEqual(reached, [{ symbol: "process", line: 3 }]);
  const unsettled = await trace("src/Flow.java:Flow.unsettled");
  assert.deepEqual(unsettled.value.steps.map((step) => step.symbol), ["unsettled"]);
  assert.equal(unsettled.status, "partial");
  assert.ok(unsettled.cuts?.some((cut) => cut.at.includes("src/Flow.java:4 Facade.ambiguous") && cut.at.includes("src/Flow.java:5 Facade.ambiguous")));
});

test("Java inherited members follow the declared receiver instead of a sibling name match", async () => {
  commit({
    "src/base/Port.java": `package base; public interface Port<T> { void create(T value); }`,
    "src/left/Left.java": `package left; public interface Left extends base.Port<String> { }`,
    "src/right/Right.java": `package right; public interface Right extends base.Port<Integer> { void create(Integer value); }`,
    "src/base/Base.java": `package base; public class Base { public Other Left; public void create(String value) { } }`,
    "src/base/Other.java": `package base; public class Other { public void create(String value) {} }`,
    "src/Flow.java": `import left.Left;
class Flow extends base.Base {
  Left receiver;
  Flow(Left receiver) { this.receiver = receiver; }
  void run() { receiver.create("value"); this.create("value"); }
  <T extends Left> void unknown(T value) { value.create("value"); }
  void shadow() { var Left = new Other(); Left.create("value"); }
  void inheritedShadow() { Left.create("value"); }
}
class Other { void create(String value) {} }
`,
  });
  const result = await trace("src/Flow.java:Flow.run");
  const declarations = result.value.steps.flatMap((step) => [step.file, ...(step.leaves ?? []).map((leaf) => leaf.file)]);
  assert.ok(!declarations.includes("src/right/Right.java"));
  assert.ok(declarations.includes("src/base/Port.java"));
  assert.ok(declarations.includes("src/base/Base.java"));
  assert.equal(result.status, "partial");
  const unknown = await trace("src/Flow.java:Flow.unknown");
  assert.equal(unknown.status, "partial");
  assert.deepEqual(unknown.value.steps.map((step) => step.symbol), ["unknown"]);
  const shadow = await trace("src/Flow.java:Flow.shadow");
  assert.equal(shadow.status, "partial");
  assert.ok(!shadow.value.steps.some((step) => step.symbol === "create"));
  assert.ok(!shadow.value.steps.flatMap((step) => step.leaves ?? []).some((leaf) => leaf.symbol === "create"));
  const inheritedShadow = await trace("src/Flow.java:Flow.inheritedShadow");
  assert.equal(inheritedShadow.status, "partial");
  assert.ok(!inheritedShadow.value.steps.some((step) => step.symbol === "create"));
});

test("a Java client method root retains its own effect or effect cut even when another method calls it", async () => {
  commit({
    "src/Flow.java": `import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.context.ApplicationEventPublisher;
class ImageEvent {}
class Client {
  private WebClient web = WebClient.create("http://customers");
  private ApplicationEventPublisher publisher;
  Object fetch(String id) { return web.get().uri("/customers/" + id); }
  Object undecided(String path) { return web.get().uri(path); }
  void emit() { publisher.publishEvent(new ImageEvent()); }
}
class Flow {
  private Client client;
  void run() { client.fetch("one"); client.undecided("/known"); client.emit(); }
}
`,
  });
  const fetch = await trace("src/Flow.java:Client.fetch");
  assert.ok(effectsOf(fetch.value).some(([, effect]) => typeof effect === "object" && effect.kind === "http"));
  const undecided = await trace("src/Flow.java:Client.undecided");
  assert.equal(undecided.status, "partial");
  assert.ok(undecided.cuts?.some((cut) => cut.at[0]?.includes("http effect")));
  const emit = await trace("src/Flow.java:Client.emit");
  assert.ok(effectsOf(emit.value).some(([, effect]) => typeof effect === "object" && effect.kind === "message"));
});

test("TypeScript wrapper effects require a traversed wrapper body and remain visible at that body as a root", async () => {
  commit({
    "src/client.ts": `import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
export class Client {
  http = inject(HttpClient);
  post(path: string) { return this.http.post(path, {}); }
}
export function run(client: Client) { client.post('/unproven'); }
export class NominalClient {
  private readonly http = inject(HttpClient);
  post(path: string) { return this.http.post('/api' + path, {}); }
}
export function proven(client: NominalClient) { client.post('/proven'); }
`,
  });
  const run = await trace("src/client.ts:run");
  assert.deepEqual(effectsOf(run.value), []);
  assert.ok(run.cuts?.some((cut) => cut.at[0]?.includes("http effect")));
  const proven = await trace("src/client.ts:proven");
  assert.equal(effectsOf(proven.value).length, 1);
  assert.ok(!proven.cuts?.some((cut) => cut.at[0]?.includes("http effect")));
  const client = await trace("src/client.ts:Client.post");
  assert.ok(client.cuts?.some((cut) => cut.at[0]?.includes("http effect")));
});
