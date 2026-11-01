import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactFault, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import type { Result } from "../core/domain/shared/result.ts";
import { ERROR_CODE, METHOD, PROTOCOL, type ErrorKind } from "./protocol.ts";
import { MAX_DEADLINE_MS } from "./params.ts";
import { serveQueries, type QueryServerDeps } from "./query-server.ts";

const SECRET = "hunter2-token";

const redactText = (text: string): string => text.replaceAll(SECRET, REDACTED);
const redactDeep = (value: unknown): unknown => {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), redactDeep(item)]));
  return value;
};

const redaction: Redaction = {
  redact: redactText,
  redactValue: redactDeep,
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: (error) => redactText(error instanceof Error ? error.message : String(error)),
  containsSecret: (text) => text.includes(SECRET),
};

type Answer = Result<unknown, ImpactFault>;
type Call = { operation: string; request: Record<string, unknown> };

interface Fakes {
  deps: QueryServerDeps;
  calls: Call[];
  behave: (operation: string, behavior: (request: Record<string, unknown>) => Promise<Answer>) => void;
}

function fakes(): Fakes {
  const calls: Call[] = [];
  const behaviors = new Map<string, (request: Record<string, unknown>) => Promise<Answer>>();
  const answer = (operation: string) => (request: object): Promise<never> => {
    const record = request as Record<string, unknown>;
    calls.push({ operation, request: record });
    return (behaviors.get(operation)?.(record) ?? Promise.resolve({ ok: true, value: { operation } })) as Promise<never>;
  };
  const deps: QueryServerDeps = {
    version: "9.8.7",
    redaction,
    entrypoints: { map: answer("map") } as EntrypointQueries,
    impact: { ofChange: answer("ofChange"), callers: answer("callers"), importers: answer("importers") } as ImpactQueries,
  };
  return { deps, calls, behave: (operation, behavior) => void behaviors.set(operation, behavior) };
}

type Message = { jsonrpc: string; id?: unknown; method?: string; params?: any; result?: any; error?: { code: number; message: string; data: { kind: string; entries?: unknown } } };

interface Session {
  send(message: unknown): void;
  sendRaw(line: string): void;
  writeBytes(bytes: readonly number[]): void;
  receive(): Promise<Message>;
  end(): void;
  done: Promise<void>;
  all: Message[];
  raw: string[];
}

function open(deps: QueryServerDeps, signal?: AbortSignal): Session {
  const input = new PassThrough();
  const output = new PassThrough();
  const raw: string[] = [];
  const all: Message[] = [];
  const waiting: ((message: Message) => void)[] = [];
  const unread: Message[] = [];
  createInterface({ input: output }).on("line", (line) => {
    raw.push(line);
    const message = JSON.parse(line) as Message;
    all.push(message);
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else unread.push(message);
  });
  const done = serveQueries(deps, { input, output, ...(signal && { signal }) });
  return {
    send: (message) => void input.write(`${JSON.stringify(message)}\n`),
    sendRaw: (line) => void input.write(`${line}\n`),
    writeBytes: (bytes) => void input.write(Buffer.from(bytes)),
    receive: () => {
      const message = unread.shift();
      return message ? Promise.resolve(message) : new Promise((resolve) => waiting.push(resolve));
    },
    end: () => void input.end(),
    done,
    all,
    raw,
  };
}

async function untrusted(deps: QueryServerDeps, signal?: AbortSignal): Promise<Session> {
  const session = open(deps, signal);
  await session.receive();
  session.send({ jsonrpc: "2.0", id: 0, method: METHOD.declareTrust, params: { mode: "untrusted" } });
  await session.receive();
  return session;
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

const request = (id: number, method: string, params: unknown = {}): unknown => ({ jsonrpc: "2.0", id, method, params });

const MAP_PARAMS = { repo: "/work/shop", repoId: "shop", revision: "HEAD" };

test("the first line of a connection is the hello with the protocol, its version and ye-ast's version, before any input", async () => {
  const session = open(fakes().deps);

  const hello = await session.receive();

  assert.deepEqual(hello, { jsonrpc: "2.0", method: METHOD.hello, params: { protocol: PROTOCOL.name, version: PROTOCOL.version, producer: "9.8.7" } });
});

test("a query before the host declares a trust mode is refused and reaches no query family", async () => {
  const { deps, calls } = fakes();
  const session = open(deps);
  await session.receive();

  session.send(request(1, METHOD.entrypointsMap, MAP_PARAMS));
  const answer = await session.receive();

  assert.equal(answer.error?.code, ERROR_CODE["trust-not-declared"]);
  assert.deepEqual(calls, []);
});

test("declaring `untrusted` is accepted and opens the queries", async () => {
  const session = open(fakes().deps);
  await session.receive();

  session.send(request(1, METHOD.declareTrust, { mode: "untrusted" }));

  assert.deepEqual(await session.receive(), { jsonrpc: "2.0", id: 1, result: { trust: "untrusted" } });
});

test("declaring `trusted` is refused with its own code and leaves the queries closed", async () => {
  const { deps, calls } = fakes();
  const session = open(deps);
  await session.receive();

  session.send(request(1, METHOD.declareTrust, { mode: "trusted" }));
  const refused = await session.receive();
  session.send(request(2, METHOD.entrypointsMap, MAP_PARAMS));
  const query = await session.receive();

  assert.equal(refused.error?.code, ERROR_CODE["trust-unsupported"]);
  assert.equal(query.error?.code, ERROR_CODE["trust-not-declared"]);
  assert.deepEqual(calls, []);
});

test("a trust mode that is neither is an invalid param", async () => {
  const session = open(fakes().deps);
  await session.receive();

  session.send(request(1, METHOD.declareTrust, { mode: "root" }));

  assert.equal((await session.receive()).error?.code, ERROR_CODE["invalid-params"]);
});

const BUDGET = { depth: 3, hubFanIn: 4, expansions: 5 };

const OPERATIONS = [
  { method: METHOD.entrypointsMap, operation: "map", params: MAP_PARAMS },
  { method: METHOD.impactOfChange, operation: "ofChange", params: { repo: "/work/shop", repoId: "shop", base: "main", head: "feature", budget: BUDGET } },
  {
    method: METHOD.impactCallers,
    operation: "callers",
    params: { repo: "/work/shop", repoId: "shop", revision: "v1", targets: [{ file: "a.ts", symbol: "run" }, { file: "b.ts", start: 2, end: 9 }], budget: BUDGET },
  },
  { method: METHOD.impactImporters, operation: "importers", params: { repo: "/work/shop", repoId: "shop", revision: "v2", files: ["a.ts", "b.ts"] } },
] as const;

for (const { method, operation, params } of OPERATIONS) {
  test(`${method} calls ${operation} with its params and an abort signal, and answers the fact redacted`, async () => {
    const { deps, calls, behave } = fakes();
    behave(operation, async () => ({ ok: true, value: { path: `src/${SECRET}.ts`, [SECRET]: [SECRET] } }));
    const session = await untrusted(deps);

    session.send(request(7, method, params));
    const answer = await session.receive();

    assert.deepEqual(answer, { jsonrpc: "2.0", id: 7, result: { path: `src/${REDACTED}.ts`, [REDACTED]: [REDACTED] } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.operation, operation);
    const { signal, ...received } = calls[0]!.request;
    assert.deepEqual(received, params);
    assert.ok(signal instanceof AbortSignal);
  });
}

const SCOPE = { include: ["svc/**"], exclude: ["svc/static/**"] };

for (const { method, operation, params } of OPERATIONS) {
  test(`${method} passes the scope param to ${operation} as a typed value`, async () => {
    const { deps, calls } = fakes();
    const session = await untrusted(deps);

    session.send(request(1, method, { ...params, scope: SCOPE }));
    await session.receive();

    assert.deepEqual(calls[0]?.request.scope, SCOPE);
  });
}

test("a scope that is not an object of valid glob lists, or names another field, is an invalid param", async () => {
  const { deps, calls } = fakes();
  const session = await untrusted(deps);
  const scopes = [[], { include: "svc/**" }, { include: [""] }, { include: ["./x/**"] }, { exclude: ["../x"] }, { exclude: [1] }, { languages: ["java"] }];

  for (const [id, scope] of scopes.entries()) session.send(request(id, METHOD.entrypointsMap, { ...MAP_PARAMS, scope }));
  for (let n = 0; n < scopes.length; n++) assert.equal((await session.receive()).error?.code, ERROR_CODE["invalid-params"]);
  assert.deepEqual(calls, []);
});

test("a line that is not JSON, a message that is not a request, an unknown method and wrong params each answer their code", async () => {
  const { deps, calls } = fakes();
  const session = await untrusted(deps);

  session.sendRaw("{not json");
  session.send({ jsonrpc: "2.0", id: 1 });
  session.send([request(2, METHOD.entrypointsMap, MAP_PARAMS)]);
  session.send(request(3, "entrypoints.nope"));
  session.send(request(4, METHOD.entrypointsMap, { ...MAP_PARAMS, extra: 1 }));
  session.send(request(5, METHOD.entrypointsMap, { repo: "/work/shop" }));
  session.send(request(6, METHOD.impactOfChange, { ...OPERATIONS[1].params, budget: { depth: 0 } }));
  session.send(request(8, METHOD.impactCallers, { ...OPERATIONS[2].params, targets: [{ file: "a.ts", start: 9, end: 2 }] }));
  const answers = [];
  for (let n = 0; n < 8; n++) answers.push(await session.receive());

  const byId = new Map(answers.map((answer) => [answer.id ?? null, answer.error?.code]));
  assert.equal(answers.filter((answer) => answer.error?.code === ERROR_CODE["parse-error"]).length, 1);
  assert.equal(answers.filter((answer) => answer.error?.code === ERROR_CODE["invalid-request"]).length, 2);
  assert.equal(byId.get(3), ERROR_CODE["method-not-found"]);
  for (const id of [4, 5, 6, 8]) assert.equal(byId.get(id), ERROR_CODE["invalid-params"], `id ${id}`);
  assert.deepEqual(calls, []);
});

test("a method named like an inherited object property is an unknown method", async () => {
  const session = await untrusted(fakes().deps);

  session.send(request(1, "constructor"));

  assert.equal((await session.receive()).error?.code, ERROR_CODE["method-not-found"]);
});

const FAULT_KINDS = ["unknown-revision", "git-failed", "not-repository-root", "object-missing", "no-merge-base", "export-write-failed", "aborted"] as const satisfies readonly ErrorKind[];

test("every fault the ports answer maps to its own code, with its detail redacted", async () => {
  const { deps, behave } = fakes();
  const session = await untrusted(deps);

  for (const [index, kind] of FAULT_KINDS.entries()) {
    behave("map", async () => ({ ok: false, fault: { kind, detail: `  failed near ${SECRET}\nsecond line ` } }));
    session.send(request(index + 1, METHOD.entrypointsMap, MAP_PARAMS));
    const answer = await session.receive();

    assert.equal(answer.error?.code, ERROR_CODE[kind], kind);
    assert.equal(answer.error?.data.kind, kind);
    assert.ok(!answer.error?.message.includes(SECRET), kind);
    assert.ok(answer.error?.message.includes(REDACTED), kind);
  }
});

test("an unknown symbol answers its code and names every entry, redacted", async () => {
  const { deps, behave } = fakes();
  behave("callers", async () => ({ ok: false, fault: { kind: "unknown-symbol", detail: "no node", entries: [{ file: "a.ts", symbol: `run${SECRET}`, candidates: [`load${SECRET}`] }] } }));
  const session = await untrusted(deps);

  session.send(request(1, METHOD.impactCallers, OPERATIONS[2].params));
  const answer = await session.receive();

  assert.equal(answer.error?.code, ERROR_CODE["unknown-symbol"]);
  assert.deepEqual(answer.error?.data.entries, [{ file: "a.ts", symbol: `run${REDACTED}`, candidates: [`load${REDACTED}`] }]);
});

test("a query family that throws answers `internal-error` with the first line of the message redacted, and the server keeps serving", async () => {
  const { deps, behave } = fakes();
  behave("map", async () => {
    throw new Error(`boom ${SECRET}\nstack`);
  });
  const session = await untrusted(deps);

  session.send(request(1, METHOD.entrypointsMap, MAP_PARAMS));
  const failed = await session.receive();
  behave("map", async () => ({ ok: true, value: "fine" }));
  session.send(request(2, METHOD.entrypointsMap, MAP_PARAMS));
  const next = await session.receive();

  assert.equal(failed.error?.code, ERROR_CODE["internal-error"]);
  assert.equal(failed.error?.message, `boom ${REDACTED}`);
  assert.equal(next.result, "fine");
});

function waitsForAbort(): (request: Record<string, unknown>) => Promise<Answer> {
  return (received) =>
    new Promise((resolve) => {
      const signal = received.signal as AbortSignal;
      signal.addEventListener("abort", () => resolve({ ok: false, fault: { kind: "aborted", detail: "stopped" } }), { once: true });
    });
}

test("a cancel notification aborts the call it names and no other", async () => {
  const { deps, behave } = fakes();
  let finish: (answer: Answer) => void = () => {};
  const pending: Promise<Answer>[] = [];
  behave("map", (received) => {
    const call = pending.length === 0 ? waitsForAbort()(received) : new Promise<Answer>((resolve) => (finish = resolve));
    pending.push(call);
    return call;
  });
  const session = await untrusted(deps);
  session.send(request(1, METHOD.entrypointsMap, MAP_PARAMS));
  session.send(request(2, METHOD.entrypointsMap, MAP_PARAMS));
  await until(() => pending.length === 2);

  session.send({ jsonrpc: "2.0", method: METHOD.cancel, params: { id: 1 } });
  const cancelled = await session.receive();
  finish({ ok: true, value: "second" });
  const completed = await session.receive();

  assert.deepEqual([cancelled.id, cancelled.error?.code], [1, ERROR_CODE.aborted]);
  assert.deepEqual([completed.id, completed.result], [2, "second"]);
});

test("a deadline aborts the call when it elapses and answers `deadline`, not `aborted`", async () => {
  const { deps, behave } = fakes();
  behave("map", waitsForAbort());
  const session = await untrusted(deps);

  session.send(request(1, METHOD.entrypointsMap, { ...MAP_PARAMS, deadlineMs: 5 }));
  const answer = await session.receive();

  assert.equal(answer.error?.code, ERROR_CODE.deadline);
});

test("a call that finishes before its deadline is answered and the elapsed deadline leaves its signal alone", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout"] });
  const { deps, behave } = fakes();
  let signal: AbortSignal | undefined;
  behave("map", async (received) => {
    signal = received.signal as AbortSignal;
    return { ok: true, value: "quick" };
  });
  const session = await untrusted(deps);

  session.send(request(1, METHOD.entrypointsMap, { ...MAP_PARAMS, deadlineMs: MAX_DEADLINE_MS }));
  const answer = await session.receive();
  mock.timers.tick(MAX_DEADLINE_MS);

  assert.equal(answer.result, "quick");
  assert.equal(signal?.aborted, false);
});

for (const deadlineMs of [0, MAX_DEADLINE_MS + 1]) {
  test(`a deadline of ${deadlineMs} ms is an invalid param`, async () => {
    const { deps, calls } = fakes();
    const session = await untrusted(deps);

    session.send(request(1, METHOD.entrypointsMap, { ...MAP_PARAMS, deadlineMs }));

    assert.equal((await session.receive()).error?.code, ERROR_CODE["invalid-params"]);
    assert.deepEqual(calls, []);
  });
}

test("concurrent requests are answered by id, in the order they finish", async () => {
  const { deps, behave } = fakes();
  const releases = new Map<string, () => void>();
  behave("map", (received) => new Promise((resolve) => releases.set(received.revision as string, () => resolve({ ok: true, value: received.revision }))));
  const session = await untrusted(deps);
  session.send(request(1, METHOD.entrypointsMap, { ...MAP_PARAMS, revision: "slow" }));
  session.send(request(2, METHOD.entrypointsMap, { ...MAP_PARAMS, revision: "fast" }));
  await until(() => releases.size === 2);

  releases.get("fast")?.();
  const first = await session.receive();
  releases.get("slow")?.();
  const second = await session.receive();

  assert.deepEqual([first.id, first.result, second.id, second.result], [2, "fast", 1, "slow"]);
});

test("a request id that is still in flight is refused instead of answered twice", async () => {
  const { deps, behave } = fakes();
  behave("map", waitsForAbort());
  const session = await untrusted(deps);
  session.send(request(1, METHOD.entrypointsMap, MAP_PARAMS));
  session.send(request(1, METHOD.entrypointsMap, MAP_PARAMS));

  const refused = await session.receive();

  assert.equal(refused.error?.code, ERROR_CODE["invalid-request"]);
});

test("when the input ends the in-flight calls are still answered before the server finishes", async () => {
  const { deps, behave } = fakes();
  let release: () => void = () => {};
  behave("map", () => new Promise((resolve) => (release = () => resolve({ ok: true, value: "late" }))));
  const session = await untrusted(deps);
  session.send(request(1, METHOD.entrypointsMap, MAP_PARAMS));
  session.end();
  const settled = session.done.then(() => "finished");
  const afterTicks = (async () => {
    for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
    return "waiting";
  })();
  assert.equal(await Promise.race([settled, afterTicks]), "waiting");

  release();
  const answer = await session.receive();
  await session.done;

  assert.equal(answer.result, "late");
});

test("the shutdown signal aborts every in-flight call and ends the server", async () => {
  const { deps, calls, behave } = fakes();
  behave("map", waitsForAbort());
  const shutdown = new AbortController();
  const session = await untrusted(deps, shutdown.signal);
  session.send(request(1, METHOD.entrypointsMap, MAP_PARAMS));
  await until(() => calls.length === 1);

  shutdown.abort();
  await session.done;

  assert.equal(session.all.at(-1)?.error?.code, ERROR_CODE.aborted);
});

test("every line the server writes is one JSON-RPC 2.0 message, whatever the host sent", async () => {
  const { deps } = fakes();
  const session = open(deps);
  await session.receive();
  session.sendRaw("garbage");
  session.send(request(1, METHOD.entrypointsMap, MAP_PARAMS));
  session.send(request(2, "nope"));
  session.send({ jsonrpc: "2.0", method: METHOD.cancel, params: { id: 99 } });
  session.send({ jsonrpc: "2.0", method: "unknown.notification" });
  session.end();
  await session.done;

  assert.equal(session.raw.length, session.all.length);
  assert.ok(session.all.every((message) => message.jsonrpc === "2.0"));
  assert.equal(session.all.length, 1 + 3);
});

test("a request written byte by byte, through the halves of multi-byte characters and a U+2028 inside a string, gets exactly one answer", async () => {
  const { deps, calls } = fakes();
  const session = await untrusted(deps);
  const repoId = "caf\u00e9\u2028\u20ac\u{1f600}";

  for (const byte of Buffer.from(`${JSON.stringify(request(1, METHOD.entrypointsMap, { ...MAP_PARAMS, repoId }))}\n`)) session.writeBytes([byte]);
  const answer = await session.receive();
  session.end();
  await session.done;

  assert.equal(answer.id, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.request.repoId, repoId);
  assert.equal(session.all.length, 3);
});

test("answers that cannot be written do not stop the server from finishing once the input ends", async () => {
  const { deps } = fakes();
  const input = new PassThrough();
  let writes = 0;
  const done = serveQueries(deps, {
    input,
    output: {
      write: () => {
        if (++writes > 2) throw new Error("broken pipe");
      },
    },
  });

  input.write(`${JSON.stringify(request(0, METHOD.declareTrust, { mode: "untrusted" }))}\n`);
  await until(() => writes >= 2);
  input.write(`${JSON.stringify(request(1, METHOD.entrypointsMap, MAP_PARAMS))}\n`);
  await until(() => writes > 2);
  input.end();

  await done;
});
