import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import { composeQueries, composeCli } from "./compose.ts";

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

const effectsOf = (value: TraceValue) => value.steps.flatMap((step) => (step.effects ?? []).map(({ column: _column, ...effect }) => [step.symbol, effect]));

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
  assert.deepEqual(quote.cuts?.filter((cut) => cut.at[0]?.includes("effect")), [{ kind: "unresolved-link", at: ["src/main/java/shop/OrderEvents.java:20 http effect through com.acme.rest.AcmeRestClient"], reason: "effect-unplaced", reach: { kind: "call-at", place: "src/main/java/shop/OrderEvents.java:20 http effect through com.acme.rest.AcmeRestClient" } }]);
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

test("trace reads only the artifact-proven library closure of an explicit workspace", async () => {
  commit({
    "pom.xml": '<project><groupId>sample</groupId><artifactId>app</artifactId><dependencies><dependency><groupId>transport</groupId><artifactId>gateway</artifactId></dependency></dependencies></project>',
    "src/main/java/shop/Caller.java": `package shop;
import transport.Gateway;
class Caller {
  private Gateway gateway;
  void load() { gateway.get("/inventory"); }
  void defer() { gateway.defer("/deferred"); }
  void emit() { gateway.emit("topic.deferred"); }
  void mixed() { gateway.mixed("/mixed"); }
}
`,
  });
  const library = join(workspace, "gateway");
  mkdirSync(library);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: library, env: GIT_ENV });
  writeFileSync(join(library, "pom.xml"), '<project><groupId>transport</groupId><artifactId>gateway</artifactId></project>');
  writeFileSync(join(library, "Gateway.java"), `package transport;
import org.springframework.web.client.RestTemplate;
import org.springframework.kafka.core.KafkaTemplate;
public class Gateway {
  private KafkaTemplate<String, String> kafka;
  private RestTemplate http;
  public String get(String path) { new Worker(http, path); return "ok"; }
  public void defer(String path) { Runnable dead = () -> later(path); }
  private void later(String path) { http.getForObject(path, String.class); }
  public void mixed(String path) { later(path); Runnable dead = () -> later(path); }
  public void emit(String topic) { Runnable dead = () -> kafka.send(topic, "value"); }
}
class Worker {
  Worker(RestTemplate http, String path) { http.getForObject(path, String.class); }
}
`);
  execFileSync("git", ["add", "."], { cwd: library, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: library, env: GIT_ENV });
  const queries = composeQueries({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") });
  const request = { repo, repoId: "shop", revision: "HEAD", targets: [{ file: "src/main/java/shop/Caller.java", symbol: "Caller.load" }] };
  const local = await queries.trace.walk(request);
  const linked = await queries.trace.walk({ ...request, workspace: { repos: [{ path: library }] } });
  assert.ok(local.ok && linked.ok);
  assert.ok(local.value.status !== "unknown" && linked.value.status !== "unknown");
  assert.deepEqual(local.value.value.steps.flatMap(s => s.effects ?? []), []);
  assert.deepEqual(linked.value.value.steps.flatMap(s => s.effects ?? []).map(e => e.target), [{ method: "GET", path: "/inventory" }]);
  const deferred = await queries.trace.walk({ ...request, targets: [{ file: "src/main/java/shop/Caller.java", symbol: "Caller.defer" }], workspace: { repos: [{ path: library }] } });
  assert.ok(deferred.ok && deferred.value.status === "partial");
  assert.deepEqual(deferred.value.value.steps.flatMap(s => s.effects ?? []), []);
  assert.ok(deferred.value.cuts?.some(c => c.at.some(a => a.includes("effect through"))));
  const emitted = await queries.trace.walk({ ...request, targets: [{ file: "src/main/java/shop/Caller.java", symbol: "Caller.emit" }], workspace: { repos: [{ path: library }] } });
  assert.ok(emitted.ok && emitted.value.status === "partial");
  assert.deepEqual(emitted.value.value.steps.flatMap(s => s.effects ?? []), []);
  assert.ok(emitted.value.cuts?.some(c => c.at.some(a => a.includes("message effect through"))));
  const mixed = await queries.trace.walk({ ...request, targets: [{ file: "src/main/java/shop/Caller.java", symbol: "Caller.mixed" }], workspace: { repos: [{ path: library }] } });
  assert.ok(mixed.ok && mixed.value.status === "partial");
  assert.equal(mixed.value.value.steps.flatMap(s => s.effects ?? []).length, 1);
  assert.equal(mixed.value.cuts?.filter(c => c.at.some(a => a.includes("http effect through"))).length, 1);
  const manifest = join(workspace, "workspace.json");
  writeFileSync(manifest, JSON.stringify({ repos: [{ path: library }] }));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cli = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", "--workspace", manifest, "--offline", repo, "src/main/java/shop/Caller.java:Caller.load"], { out: s => stdout.push(s), err: s => stderr.push(s) });
  assert.equal(cli, EXIT_CODE.ok, stderr.join("\n"));
  assert.equal(JSON.parse(stdout.join("\n")).value.steps.flatMap((s: { effects?: unknown[] }) => s.effects ?? []).length, 1);
  const repeated = await queries.trace.walk(request);
  assert.deepEqual(repeated, local);
});

test("Java and TypeScript constructions walk a settled constructor and cut an unsettled repository constructor", async () => {
  commit({
    "src/main/java/shop/Build.java": `package shop;
import org.springframework.web.client.RestTemplate;
import java.util.ArrayList;
class Build {
 RestTemplate http;
 void load() { new Worker(http); }
 void absent() { new Empty(); }
 void external() { new ArrayList<>(); new ArrayList<>(); }
}
class Worker {
 Worker(RestTemplate http) { http.getForObject("/java-built", String.class); }
}
class Empty {}
`,
    "build.ts": `import { HttpClient } from '@angular/common/http';
class Worker {
 constructor(http: HttpClient) { http.get('/ts-built'); }
}
class Empty {}
export class Build {
 http: HttpClient;
 load() { new Worker(this.http); }
 absent() { new Empty(); }
 external() { new Date(); new Date(); }
}
`,
  });
  const outward = await composeQueries({ scratchRoot: workspace, indexCache: join(workspace, "cache") }).workspace.outwardNames({ repo: { path: repo } });
  assert.ok(outward.ok && outward.value.fact.status !== "unknown");
  const callSites = outward.value.fact.value.repositories.flatMap(repository => repository.callSites);
  for (const [file, path] of [["src/main/java/shop/Build.java", "/java-built"], ["build.ts", "/ts-built"]] as const) {
    const loaded = await trace(`${file}:Build.load`);
    assert.ok(loaded.value.steps.some(step => ["method", "function"].includes(step.kind) && (step.symbol === "constructor" || step.symbol === "Worker")));
    assert.ok(loaded.value.steps.some(step => step.effects?.some(effect => effect.kind === "http" && effect.target.path === path)));
    assert.equal(loaded.value.steps.flatMap(step => step.effects ?? [])[0]?.column, file.endsWith(".java") ? 16 : 34);
    assert.equal(callSites.find(candidate => candidate.file === file)?.column, file.endsWith(".java") ? 16 : 34);
    const absent = await trace(`${file}:Build.absent`);
    assert.equal(absent.status, "partial");
    assert.ok(absent.cuts?.some(cut => cut.kind === "unresolved-link"));
    const external = await trace(`${file}:Build.external`);
    assert.equal(external.status, "complete");
    const groups = external.value.steps.flatMap(step => step.external ?? []);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.names.length, 1);
  }
});

test("data effects belong to project method bodies, preserve exact ownership and cut an uninvoked function value", async () => {
  commit({
    "src/main/java/shop/Store.java": `package shop;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import jakarta.persistence.EntityManager;
class Order {}
interface Orders extends JpaRepository<Order, Long> {}
class Store {
 private Orders orders;
 private JdbcTemplate jdbc;
 private EntityManager em;
 void save(Order o) { orders.save(o); } void other() { jdbc.update("delete from other"); }
 void run(Order o) { this.save(o); em.find(Order.class, 1L); }
 void dead() { Runnable value = () -> jdbc.update("delete from orders"); System.out.println("x"); }
}
`,
  });
  const run = await trace("src/main/java/shop/Store.java:Store.run");
  const saved = await trace("src/main/java/shop/Store.java:Store.save");
  assert.deepEqual([...run.value.steps, ...saved.value.steps].flatMap((step) => step.effects ?? []).filter((effect) => effect.kind === "data").map(({ operation, access, target }) => [operation, access, target]), [
    ["find", "read", { kind: "entity", name: "shop.Order" }],
    ["save", "write", { kind: "entity", name: "shop.Order" }],
  ]);
  const dead = await trace("src/main/java/shop/Store.java:Store.dead");
  assert.deepEqual(effectsOf(dead.value), []);
  assert.ok(dead.cuts?.some((cut) => cut.at[0]?.includes("data effect")));
});

test("compiled review counterexamples cannot invent framework identity, entity identity or overload access", async () => {
  const fixture = (name: string) => readFileSync(new URL(`../core/adapters/spring/fixtures/data-effects/${name}.java`, import.meta.url), "utf8");
  commit({ "src/LocalType.java": fixture("local-type"), "src/WrongTarget.java": fixture("wrong-target"), "src/LoopShadow.java": fixture("loop-shadow"), "src/QueryOverload.java": fixture("query-overload") });
  for (const [file, symbol] of [["LocalType", "LocalType.run"], ["LoopShadow", "LoopShadow.run"], ["QueryOverload", "QueryOverload.run"]]) {
    const result = await trace(`src/${file}.java:${symbol}`);
    assert.deepEqual(result.value.steps.flatMap((step) => step.effects ?? []).filter((effect) => effect.kind === "data"), []);
    if (file === "QueryOverload") assert.ok(result.cuts?.some((cut) => cut.at.some((at) => at.includes("data effect"))));
  }
  const entity = await trace("src/WrongTarget.java:WrongTarget.run");
  const effects = entity.value.steps.flatMap((step) => step.effects ?? []).filter((effect) => effect.kind === "data");
  assert.equal(effects.length, 1);
  assert.equal(effects[0]!.target, undefined);
});

test("construction accounts for field initializers before reporting complete", async () => {
  commit({
    "src/entry.ts": `class Worker {
  constructor() { unknownWork(); }
}
class Holder {
  worker = new Worker();
  static shared = new Worker();
  constructor() {}
}
export function run() { return new Holder(); }
`,
    "src/Entry.java": `class Worker {
  Worker() { unknownWork(); }
}
class Holder {
  Worker worker = new Worker();
  static Worker shared = new Worker();
  Holder() {}
}
class Entry {
  static Holder run() { return new Holder(); }
}
`,
  });
  const queries = composeQueries({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") });
  for (const [file, symbol] of [["src/entry.ts", "run"], ["src/Entry.java", "Entry.run"]]) {
    const result = await queries.trace.walk({ repo, repoId: "fixture", revision: "HEAD", targets: [{ file: file!, symbol: symbol! }] });
    assert.ok(result.ok);
    assert.equal(result.value.status, "partial", file);
    assert.ok(result.value.cuts?.some(cut => cut.kind === "unresolved-link"), file);
    for (const field of ["worker", "shared"]) {
      assert.ok(result.value.value.steps.some(step => step.symbol === field), `${file}: ${field}`);
    }
  }
});

test("construction skips uninitialized fields and definition-time decorators", async () => {
  commit({
    "src/entry.ts": `import { Input } from '@angular/core';
class Holder {
  @Input() brand: unknown;
  @Input() initialized = Math.random();
  constructor() {}
}
export function run() { return new Holder(); }
`,
    "src/Entry.java": `class Holder {
  Object brand;
  double initialized = Math.random();
  Holder() {}
}
class Entry {
  static Holder run() { return new Holder(); }
}
`,
  });
  const queries = composeQueries({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") });
  for (const [file, symbol] of [["src/entry.ts", "run"], ["src/Entry.java", "Entry.run"]]) {
    const result = await queries.trace.walk({ repo, repoId: "fixture", revision: "HEAD", targets: [{ file: file!, symbol: symbol! }] });
    assert.ok(result.ok);
    assert.notEqual(result.value.status, "unknown");
    if (result.value.status === "unknown") continue;
    const members = result.value.value.steps.filter(step => step.via === "member").map(step => step.symbol);
    assert.deepEqual(members, ["initialized"], file);
    assert.ok(!JSON.stringify(result.value.value.steps).includes('"Input"'), file);
  }
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
@Aspect class Advice { @org.aspectj.lang.annotation.Around("bean(worker)") Object around() { return null; } }
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

test("Java declaration selection preserves private helper traversal while aspect dispatch remains cut", async () => {
  commit({
    "src/Flow.java": `@org.aspectj.lang.annotation.Aspect class Advice { @org.aspectj.lang.annotation.Around("bean(worker)") Object around() { return null; } }
interface Port { void save(); }
class Worker implements Port { public void save() {} }
class Flow {
  private Port service;
  void run() { helper(); }
  private void helper() { service.save(); }
}
`,
  });
  const result = await trace("src/Flow.java:Flow.run");
  assert.deepEqual(result.value.steps.map((step) => step.symbol), ["run", "helper", "save"]);
  assert.equal(result.status, "partial");
  assert.equal(result.value.steps.find((step) => step.symbol === "save")?.line, 2);
  assert.ok(result.cuts?.some((cut) => cut.at[0]?.includes("src/Flow.java:2 save")));
});
