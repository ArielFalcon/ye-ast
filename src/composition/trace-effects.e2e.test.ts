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
