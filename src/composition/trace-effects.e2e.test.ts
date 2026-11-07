import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

async function trace(target: string): Promise<{ status: string; value: TraceValue; cuts?: Cut[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, target], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const effectsOf = (value: TraceValue) => value.steps.flatMap((step) => (step.effects ?? []).map((effect) => [step.symbol, effect]));

test("an Angular HttpClient request is an http effect of the body that makes it, with its path; through a wrapper, of the caller that names the path", async () => {
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

  assert.deepEqual(effectsOf(checkout.value), [["checkout", { kind: "http", line: 11, target: { method: "POST", path: "/orders/checkout" } }]]);
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
