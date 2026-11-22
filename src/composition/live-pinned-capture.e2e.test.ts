import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCodeGraph, defaultCodeGraphDeps } from "../core/adapters/codegraph/codegraph.adapter.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createFsSourceReader } from "../core/adapters/fs/fs-source-reader.adapter.ts";
import { createLiveMirror, defaultLiveMirrorDeps } from "../core/adapters/fs/live-mirror.adapter.ts";
import { createPathMatcher } from "../core/adapters/fs/path-matcher.adapter.ts";
import { createTempScratchDirectory } from "../core/adapters/fs/temp-scratch-directory.adapter.ts";
import { createGitVcs } from "../core/adapters/git/git-vcs.adapter.ts";
import { createGitWorkingTree } from "../core/adapters/git/git-working-tree.adapter.ts";
import { createHeadReader, withLiveCaptures, type HeadReaderDeps, type HeldLive } from "../core/application/snapshot/head-reading.ts";
import { pathSelection } from "../core/domain/shared/scope.ts";
import { isWritten, liveScope } from "../core/domain/snapshot/live-export.ts";
import type { CodeGraph } from "../core/ports/code-graph.port.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const DIR = "src/main/java/shop/";
const UTIL = `${DIR}Util.java`;
const AUDIT = `${DIR}Audit.java`;
const utilWith = (body: string): string => `package shop;\n\nclass Util {\n  static String fmt(String s) {\n    return ${body};\n  }\n}\n`;
const SERVICE = 'package shop;\n\nclass OrderService {\n  String find() {\n    return Util.fmt("x");\n  }\n}\n';
const AUDIT_SOURCE = 'package shop;\n\nclass Audit {\n  String note() {\n    return Util.fmt("audit");\n  }\n}\n';
/** How long a second process may wait for the mirror lock before the test reads its wait as the lock still covering the first query's derivation. */
const LOCK_WAIT_MS = 20_000;

let workspace: string;
let repo: string;
let shutdown: AbortController;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-pinned-"));
  repo = join(workspace, "shop");
  mkdirSync(repo);
  mkdirSync(join(workspace, "scratch"));
  shutdown = new AbortController();
  git("init", "-q", "-b", "main");
  write({ [UTIL]: utilWith("s"), [`${DIR}OrderService.java`]: SERVICE });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});

afterEach(() => {
  shutdown.abort();
  rmSync(workspace, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function write(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

/** One ye-ast process over the repository: its own engine, image memory and mirror adapter, sharing only the files on disk. */
function instance(wrap: (graph: CodeGraph) => CodeGraph = (graph) => graph): HeadReaderDeps {
  const graph = wrap(createCodeGraph(defaultCodeGraphDeps, { liveImageBytes: 64 * 1024 * 1024, shutdown: shutdown.signal }));
  const digest = createSha256Digest();
  return {
    vcs: createGitVcs(),
    scratch: createTempScratchDirectory(join(workspace, "scratch")),
    reader: createFsSourceReader(),
    extractor: { extract: async () => ({ findings: [], readingCuts: [] }) },
    digest,
    producer: { name: "ye-ast", version: "0" },
    graph,
    matcher: createPathMatcher(),
    live: {
      workingTree: createGitWorkingTree(),
      mirror: createLiveMirror({ ...defaultLiveMirrorDeps, writes: isWritten }),
      graph,
      digest,
      versions: { codegraph: "test", store: "test", staging: "test" },
      retention: { keepScopes: 3, unusedForMs: 24 * 60 * 60 * 1000, maxBytes: 1024 * 1024 * 1024 },
      now: () => Date.now(),
      newStoreGeneration: () => randomUUID(),
    },
  };
}

async function capture<T>(deps: HeadReaderDeps, use: (held: HeldLive) => Promise<T>, signal?: AbortSignal) {
  return withLiveCaptures(deps, [{ repo, repoId: "shop", scope: liveScope(), trust: "trusted" }], signal, (captures) => use(captures.get("shop")!));
}

/** What a capture answers: its state, the sources and the graph it reads. */
async function observed(deps: HeadReaderDeps, held: HeldLive) {
  const sources = await held.sources();
  assert.ok(sources.ok, JSON.stringify(sources));
  const index = await createHeadReader(deps).liveReading(held.tree, sources.value, "trusted", held.scope, pathSelection(held.scope, deps.matcher.matches), held.head, "shop", { declaredConfig: {}, engines: {} }).open();
  assert.ok(typeof index === "object" && "store" in index, JSON.stringify(index));
  try {
    const fmt = index.store.declarationsNamed(["fmt"]).map((symbol) => symbol.id);
    const callers = index.store.symbolsByIds(index.store.incomingEdges(fmt, ["calls"]).map((edge) => edge.source)).map((symbol) => symbol.file);
    return {
      stateId: held.tree.stateId,
      util: sources.value.sources.find((source) => source.path === UTIL)?.content,
      audit: sources.value.sources.some((source) => source.path === AUDIT),
      auditSymbols: index.store.symbolsInFiles([AUDIT]).length,
      callerFiles: [...new Set(callers)].sort(),
    };
  } finally {
    index.store.close();
  }
}

function storeGeneration(): string {
  const live = join(repo, ".ye-ast-graph", "live");
  const state = readdirSync(live).find((name) => name.endsWith(".state.json"))!;
  return (JSON.parse(readFileSync(join(live, state), "utf8")) as { storeGeneration: string }).storeGeneration;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => (resolve = settle));
  return { promise, resolve };
}

test("a capture pinned after a sync answers that state's sources and graph while another process syncs a newer state", async () => {
  const first = instance();
  const second = instance();
  assert.ok((await capture(first, async () => undefined)).ok);
  write({ [UTIL]: utilWith("s.trim()") });

  const answered = await capture(first, async (held) => {
    write({ [UTIL]: utilWith("s.strip()"), [AUDIT]: AUDIT_SOURCE });
    const synced = await capture(second, (other) => observed(second, other), AbortSignal.timeout(LOCK_WAIT_MS));
    return { synced, pinned: await observed(first, held) };
  });

  assert.ok(answered.ok, JSON.stringify(answered));
  const { synced, pinned } = answered.value;
  assert.ok(synced.ok, `another process syncs the mirror while the pinned capture derives: ${JSON.stringify(synced)}`);
  assert.notEqual(pinned.stateId, synced.value.stateId);
  assert.deepEqual([pinned.util, synced.value.util], [utilWith("s.trim()"), utilWith("s.strip()")], "each capture reads its own state's bytes");
  assert.deepEqual([pinned.audit, pinned.auditSymbols, pinned.callerFiles], [false, 0, [`${DIR}OrderService.java`]], "the pinned graph holds none of the later sync");
  assert.deepEqual([synced.value.audit, synced.value.auditSymbols > 0, synced.value.callerFiles], [true, true, [AUDIT, `${DIR}OrderService.java`]]);
});

test("a query never observes a half-written store: a pinned capture reads its state while a sync writes, and a query arriving then waits for the commit", async () => {
  const written = deferred();
  const commit = deferred();
  const first = instance();
  const writer = instance((graph) => ({
    ...graph,
    syncMirror: async (...args) => {
      const synced = await graph.syncMirror(...args);
      written.resolve();
      await commit.promise;
      return synced;
    },
  }));
  const third = instance();
  assert.ok((await capture(first, async () => undefined)).ok);

  const answered = await capture(first, async (held) => {
    write({ [AUDIT]: AUDIT_SOURCE });
    const syncing = capture(writer, (other) => observed(writer, other), AbortSignal.timeout(2 * LOCK_WAIT_MS));
    const reached = await Promise.race([written.promise.then(() => true), delay(LOCK_WAIT_MS, false, { ref: false })]);
    if (!reached) {
      commit.resolve();
      return { reached, syncing: await syncing };
    }
    const midWrite = storeGeneration();
    const pinned = await observed(first, held);
    let arrived = false;
    const waiting = capture(third, (other) => observed(third, other), AbortSignal.timeout(2 * LOCK_WAIT_MS)).finally(() => (arrived = true));
    await delay(300);
    const answeredBeforeCommit = arrived;
    commit.resolve();
    return { reached, midWrite, pinned, answeredBeforeCommit, synced: await syncing, later: await waiting };
  });

  assert.ok(answered.ok, JSON.stringify(answered));
  const outcome = answered.value;
  assert.ok(outcome.reached, `a second process writes the store while the pinned capture derives: ${JSON.stringify(outcome)}`);
  const { midWrite, pinned, answeredBeforeCommit, synced, later } = outcome as Extract<typeof outcome, { midWrite: string }>;
  assert.equal(midWrite, "", "the store was written and not committed when the pinned capture read it");
  assert.deepEqual([pinned.audit, pinned.auditSymbols, pinned.callerFiles], [false, 0, [`${DIR}OrderService.java`]], "the pinned capture reads its own state, not the half-written store");
  assert.equal(answeredBeforeCommit, false, "a query arriving while the store is written waits for the commit");
  assert.ok(synced.ok && later.ok, JSON.stringify({ synced, later }));
  assert.equal(later.value.stateId, synced.value.stateId);
  assert.deepEqual([later.value.auditSymbols > 0, later.value.callerFiles], [true, [AUDIT, `${DIR}OrderService.java`]], "the query that waited reads the committed store whole");
});
