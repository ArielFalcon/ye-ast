import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realWorkspaceFixture } from "./mixed-workspace.testing.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

for (const cancelWaiter of [false, true]) {
  test(cancelWaiter ? "aborting a waiting workspace leaves the holder's leases intact" : "opposite workspace orders complete through canonical lock order", { timeout: 120_000 }, async (context) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ye-ast-concurrency-")));
    const web = join(dir, "web"), orders = join(dir, "orders"), scratch = join(dir, "scratch");
    const first = new AbortController(), second = new AbortController();
    const gate = deferred(), entered = deferred(), sleeping = deferred(), wake = deferred();
    const pending: Promise<unknown>[] = [];
    const cancel = () => { first.abort(); second.abort(); gate.resolve(); wake.resolve(); };
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
    try {
      for (const repo of [web, orders]) {
        mkdirSync(repo); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
        mkdirSync(join(repo, "src"));
        writeFileSync(join(repo, "src", repo === web ? "app.ts" : "Controller.java"), repo === web
          ? 'import { HttpClient } from "@angular/common/http"; export class Api { constructor(private http: HttpClient) {} get() { return this.http.get("orders-api/items"); } }'
          : 'import org.springframework.web.bind.annotation.*; @RestController class Controller { @GetMapping("/items") String get() { return "ok"; } }');
        execFileSync("git", ["add", "-A"], { cwd: repo, env }); execFileSync("git", ["commit", "-qm", "base"], { cwd: repo, env });
      }
      mkdirSync(scratch);
      const heads = new Map([web, orders].map((repo) => [repo, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, env, encoding: "utf8" }).trim()]));
      let sleepSignal: AbortSignal | undefined;
      const fixture = realWorkspaceFixture(scratch, [web, orders], async (_ms, signal) => {
        sleepSignal = signal; sleeping.resolve();
        if (signal?.aborted) return;
        await Promise.race([wake.promise, new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      });
      const events: { op: string; action: string; root: string }[] = [];
      const lock = fixture.mirror.lock;
      fixture.mirror.lock = async (location, signal) => {
        const op = signal === first.signal ? "first" : signal === second.signal ? "second" : "other";
        events.push({ op, action: "attempt", root: location.repo });
        const result = await lock(location, signal);
        if (!result.ok) return result;
        events.push({ op, action: "acquired", root: location.repo });
        return { ok: true, value: { release: async () => { await result.value.release(); events.push({ op, action: "released", root: location.repo }); } } };
      };
      const remotes = fixture.vcs.remotes;
      let armed = true;
      fixture.vcs.remotes = async (repo, signal) => {
        if (armed && fixture.active.size === 2) { armed = false; entered.resolve(); await gate.promise; }
        return remotes(repo, signal);
      };
      const a = { path: web, id: "web", live: true as const }, b = { path: orders, id: "orders", live: true as const };
      const one = fixture.workspace.outwardNames({ repo: a, repos: [b], signal: first.signal }); pending.push(one);
      await Promise.race([entered.promise, one.then((v) => { throw new Error(`first settled before gate: ${JSON.stringify(v)}`); })]);
      assert.deepEqual([...fixture.active].sort(), [orders, web].sort());
      const two = fixture.workspace.outwardNames({ repo: b, repos: [a], signal: second.signal }); pending.push(two);
      await Promise.race([sleeping.promise, two.then((v) => { throw new Error(`second settled before wait: ${JSON.stringify(v)}`); })]);
      assert.equal(sleepSignal, second.signal);
      const roots = [orders, web].sort();
      assert.deepEqual(events.filter((e) => e.op === "second"), [{ op: "second", action: "attempt", root: roots[0] }]);
      assert.equal(fixture.discoveries.length, 0);
      if (cancelWaiter) {
        second.abort();
        const result = await two;
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.fault.kind, "aborted");
        assert.deepEqual([...fixture.active].sort(), roots);
        assert.equal(first.signal.aborted, false);
        assert.equal(fixture.discoveries.length, 0);
        assert.deepEqual(events.filter((e) => e.op === "second" && e.action !== "attempt"), []);
      }
      gate.resolve();
      const result1 = await one;
      assert.ok(result1.ok, JSON.stringify(result1));
      assert.deepEqual(events.filter((e) => e.op === "first" && e.action === "released").map((e) => e.root), [...roots].reverse());
      wake.resolve();
      const result2 = await two;
      if (!cancelWaiter) assert.ok(result2.ok, JSON.stringify(result2));
      const completed: [string, Awaited<ReturnType<typeof fixture.workspace.outwardNames>>, string][] = [["first", result1, "web"]];
      if (!cancelWaiter) completed.push(["second", result2, "orders"]);
      for (const [op, result, primary] of completed) {
        assert.ok(result.ok && result.value.fact.status !== "unknown", JSON.stringify(result));
        const fact = result.value.fact;
        assert.equal(fact.snapshot.repo, primary);
        assert.deepEqual(fact.value.repositorySnapshots.map((x) => x.repo), ["orders", "web"]);
        for (const entry of fact.value.repositorySnapshots) {
          assert.equal(entry.snapshot.kind, "live");
          if (entry.snapshot.kind === "live") assert.equal(entry.snapshot.head, heads.get(entry.repo === "web" ? web : orders));
          assert.deepEqual(fact.value.repositories.find((x) => x.repo === entry.repo)?.snapshot, entry.snapshot);
          assert.deepEqual(fact.value.sections[entry.repo]?.snapshot, entry.snapshot);
        }
        assert.deepEqual(events.filter((e) => e.op === op && e.action === "acquired").map((e) => e.root), roots);
        assert.deepEqual(events.filter((e) => e.op === op && e.action === "released").map((e) => e.root), [...roots].reverse());
      }
      assert.equal(fixture.active.size, 0); assert.deepEqual(readdirSync(scratch), []);
      for (const repo of roots) assert.equal(readdirSync(join(repo, ".ye-ast-graph", "live")).some((name) => name.endsWith(".lock")), false);
    } finally {
      context.signal.removeEventListener("abort", cancel); cancel(); await Promise.allSettled(pending); rmSync(dir, { recursive: true, force: true });
    }
  });
}
