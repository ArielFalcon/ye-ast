import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EXIT_CODE } from "../cli/main.ts";
import { METHOD, PROTOCOL } from "../protocol/protocol.ts";
import type { ComposedQueries } from "./compose.ts";
import type { ProcessHost } from "./process-host.ts";
import { runServe } from "./serve.ts";

function harness(overrides: Partial<ProcessHost> = {}): { host: ProcessHost; stdin: PassThrough; lines: () => string[]; errors: string[]; composed: { count: number; options: unknown[] }; cached: string[] } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  const errors: string[] = [];
  const composed: { count: number; options: unknown[] } = { count: 0, options: [] };
  const cached: string[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const host: ProcessHost = {
    cwd: "/work",
    signal: new AbortController().signal,
    stdin,
    stdout,
    err: (line) => errors.push(line),
    queries: (options) => {
      composed.count += 1;
      composed.options.push(options);
      return { version: "0.0.0", entrypoints: {}, impact: {}, redaction: {} } as unknown as ComposedQueries;
    },
    withCache: (directory) => {
      cached.push(directory);
      return host;
    },
    ...overrides,
  };
  return { host, stdin, errors, composed, cached, lines: () => chunks.join("").split("\n").filter((line) => line !== "") };
}

test("the served connection opens with the hello and a closed input ends it with exit code ok", async () => {
  const { host, stdin, lines } = harness();
  const done = runServe([], host);

  stdin.end();

  assert.equal(await done, EXIT_CODE.ok);
  const [hello] = lines().map((line) => JSON.parse(line));
  assert.equal(hello.method, METHOD.hello);
  assert.equal(hello.params.protocol, PROTOCOL.name);
});

test("an interrupt ends the served connection with the interrupted exit code while the input is still open", async () => {
  const interrupt = new AbortController();
  const { host } = harness({ signal: interrupt.signal });
  const done = runServe([], host);

  interrupt.abort();

  assert.equal(await done, EXIT_CODE.interrupted);
});

test("an argument is a usage error that composes nothing and writes nothing to the wire", async () => {
  const { host, errors, composed, lines } = harness();

  assert.equal(await runServe(["extra"], host), EXIT_CODE.usage);

  assert.equal(composed.count, 0);
  assert.equal(errors.length, 1);
  assert.deepEqual(lines(), []);
});

test("the served connection composes its queries without the user's trust record: the host declares the mode", async () => {
  const { host, stdin, composed } = harness();
  const done = runServe([], host);

  stdin.end();
  await done;

  assert.deepEqual(composed.options, [undefined]);
});

test("a cache directory is resolved against the working directory and the connection is served from the host it names", async () => {
  const served = harness();
  const { host, cached, stdin, composed } = harness({ withCache: (directory) => (cached.push(directory), served.host) });
  const done = runServe(["--cache", "store"], host);

  stdin.end();

  assert.equal(await done, EXIT_CODE.ok);
  assert.deepEqual(cached, ["/work/store"]);
  assert.equal(served.composed.count, 1);
  assert.equal(composed.count, 0);
});

test("without a cache flag the host is used as it is", async () => {
  const { host, cached, stdin } = harness();
  const done = runServe([], host);

  stdin.end();
  await done;

  assert.deepEqual(cached, []);
});

test("a repeated cache flag, one without a value and one whose value is another flag are usage errors that compose nothing", async () => {
  for (const args of [["--cache", "/a", "--cache", "/b"], ["--cache"], ["--cache", ""], ["--cache", "--other"]]) {
    const { host, errors, composed, cached } = harness();

    assert.equal(await runServe(args, host), EXIT_CODE.usage, args.join(" "));

    assert.equal(composed.count, 0);
    assert.deepEqual(cached, []);
    assert.equal(errors.length, 1);
  }
});

test("a cache directory that is open to others is refused and nothing is composed from it", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ye-ast-cache-flag-"));
  try {
    const open = join(scratch, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const { host, errors, composed, cached } = harness();

    assert.equal(await runServe(["--cache", open], host), EXIT_CODE.usage);

    assert.equal(composed.count, 0);
    assert.deepEqual(cached, []);
    assert.equal(errors.length, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
