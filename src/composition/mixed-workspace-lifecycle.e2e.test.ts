import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realWorkspaceFixture } from "./mixed-workspace.testing.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
function git(repo: string, ...args: string[]) { return execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim(); }

test("second capture lock failure releases the first real lease and permits retry", { timeout: 120_000 }, async (context) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ye-ast-capture-fault-")));
  const orders = join(dir, "orders"), web = join(dir, "web"), scratch = join(dir, "scratch");
  const controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  const cancel = () => controller.abort();
  context.signal.addEventListener("abort", cancel, { once: true });
  if (context.signal.aborted) cancel();
  try {
    for (const repo of [orders, web]) {
      mkdirSync(repo); git(repo, "init", "-q", "-b", "main"); mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src", repo === orders ? "Controller.java" : "api.ts"), repo === orders
        ? 'import org.springframework.web.bind.annotation.*; @RestController class Controller { @GetMapping("/fault-items") String get() { return "ok"; } }'
        : 'import { HttpClient } from "@angular/common/http"; export class Api { constructor(private http: HttpClient) {} checkout() { return this.http.get("orders-api/fault-items"); } }');
      git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
    }
    mkdirSync(scratch);
    const fixture = realWorkspaceFixture(scratch, [orders, web]);
    const lock = fixture.mirror.lock;
    let injected = false;
    fixture.mirror.lock = async (location, signal) => {
      assert.equal(signal, controller.signal);
      if (!injected && location.repo === web) {
        injected = true;
        assert.deepEqual([...fixture.active], [orders]);
        return { ok: false, fault: { kind: "refused", detail: "injected second lock" } };
      }
      return lock(location, signal);
    };
    const request = { repo: { path: web, id: "web", live: true as const }, repos: [{ path: orders, id: "orders", live: true as const }], signal: controller.signal };
    const first = fixture.workspace.outwardNames(request); pending.push(first);
    const failed = await first;
    assert.equal(injected, true);
    assert.deepEqual(failed, { ok: false, fault: { kind: "workspace-capture-unavailable", repo: "web", detail: "live capture unavailable", cause: { kind: "live-mirror-failed", detail: "refused: injected second lock" } } });
    assert.equal(fixture.discoveries.length, 0); assert.equal(fixture.extracted.length, 0); assert.equal(fixture.reads.length, 0);
    assert.equal(fixture.active.size, 0); assert.deepEqual(readdirSync(scratch), []);
    for (const repo of [orders, web]) {
      const live = join(repo, ".ye-ast-graph", "live");
      if (existsSync(live)) assert.equal(readdirSync(live).some((name) => name.endsWith(".lock")), false);
    }
    const retry = fixture.workspace.outwardNames(request); pending.push(retry);
    const result = await retry;
    assert.ok(result.ok && result.value.fact.status !== "unknown", JSON.stringify(result));
    assert.equal(fixture.active.size, 0); assert.deepEqual(readdirSync(scratch), []);
    for (const repo of [orders, web]) assert.equal(readdirSync(join(repo, ".ye-ast-graph", "live")).some((name) => name.endsWith(".lock")), false);
  } finally {
    context.signal.removeEventListener("abort", cancel); cancel(); await Promise.allSettled(pending); rmSync(dir, { recursive: true, force: true });
  }
});

test("live change compares removed base route and untracked route with a real consumer", { timeout: 120_000 }, async (context) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ye-ast-route-diff-")));
  const orders = join(dir, "orders"), web = join(dir, "web"), scratch = join(dir, "scratch");
  const controller = new AbortController(); const pending: Promise<unknown>[] = [];
  const cancel = () => controller.abort(); context.signal.addEventListener("abort", cancel, { once: true });
  if (context.signal.aborted) cancel();
  try {
    for (const repo of [orders, web]) { mkdirSync(repo); git(repo, "init", "-q", "-b", "main"); mkdirSync(join(repo, "src")); }
    const oldPath = "src/OldController.java", newPath = "src/NewController.java", clientPath = "src/api.ts";
    const oldSource = 'import org.springframework.web.bind.annotation.*; @RestController class OldController { @GetMapping("/old") String old() { return "old"; } }';
    const newSource = 'import org.springframework.web.bind.annotation.*; @RestController class NewController { @GetMapping("/untracked") String fresh() { return "new"; } }';
    const clientSource = 'import { HttpClient } from "@angular/common/http"; export class Api { constructor(private http: HttpClient) {} checkout() { return this.http.get("orders-api/old"); } }';
    writeFileSync(join(orders, oldPath), oldSource); writeFileSync(join(web, clientPath), clientSource);
    for (const repo of [orders, web]) { git(repo, "add", "-A"); git(repo, "commit", "-qm", "base"); }
    const head = git(orders, "rev-parse", "HEAD"), webHead = git(web, "rev-parse", "HEAD");
    rmSync(join(orders, oldPath)); writeFileSync(join(orders, newPath), newSource);
    assert.equal(git(orders, "ls-files", "--others", "--exclude-standard", "--", newPath), newPath);
    assert.equal(git(orders, "ls-files", "--", newPath), "");
    mkdirSync(scratch); const fixture = realWorkspaceFixture(scratch, [orders, web]);
    const request = { repo: { path: orders, id: "orders", live: true as const }, repos: [{ path: web, id: "web", live: true as const }], base: "HEAD", budget: { depth: 1 }, signal: controller.signal };
    const query = fixture.impact.ofChange(request); pending.push(query); const result = await query;
    assert.ok(result.ok && result.value.fact.status !== "unknown", JSON.stringify(result));
    const value = result.value.fact.value;
    assert.equal(value.trigger.repo, "orders"); assert.equal(value.trigger.mergeBase, head);
    const discovery = fixture.discoveries[0]?.fact; assert.ok(discovery && discovery.status !== "unknown");
    assert.ok(discovery.value.repositories.find((repo) => repo.repo === "orders")?.entrypoints.some((finding) => finding.status === "complete" && finding.value.name === "GET /untracked"));
    assert.ok(discovery.value.repositories.find((repo) => repo.repo === "web")?.callSites.some((site) => site.symbol === "Api.checkout" && JSON.stringify(site.target).includes("orders-api/old")));
    const section = value.sections.orders; assert.ok(section && section.status !== "unknown");
    assert.ok(section.value.reads.some(({ kind }) => kind === "trigger"));
    const client = value.sections.web; assert.ok(client && client.status !== "unknown");
    assert.ok(client.value.reads.some(({ kind }) => kind === "upstream"));
    const changes = section.value.impact?.changedEntrypoints;
    assert.ok(changes?.some((change) => change.change === "removed" && change.name === "GET /old" && change.handler.path === oldPath && change.kind === "http-route" && change.handler.symbol === "OldController.old" && change.handler.line > 0), JSON.stringify(changes));
    assert.ok(changes?.some((change) => change.change === "added" && change.name === "GET /untracked" && change.handler.path === newPath && change.kind === "http-route" && change.handler.symbol === "NewController.fresh" && change.handler.line > 0), JSON.stringify(changes));
    assert.ok(value.links.some(({ direction, link }) => direction === "upstream" && link.from.repo === "web" && link.to.name === "GET /old"), JSON.stringify(value.links));
    for (const [repo, expected] of [["orders", head], ["web", webHead]] as const) {
      const snapshot = value.repositorySnapshots.find((entry) => entry.repo === repo)?.snapshot;
      assert.ok(snapshot?.kind === "live"); assert.equal(snapshot.head, expected);
      const item = value.sections[repo]; assert.ok(item && item.status !== "unknown");
      const discoveryRead = item.value.reads.find(({ kind }) => kind === "discovery");
      assert.ok(discoveryRead, `missing discovery read for ${repo}`);
      assert.deepEqual(discoveryRead.fact.snapshot, snapshot);
      for (const read of item.value.reads) assert.deepEqual(read.fact.snapshot, snapshot);
    }
    assert.ok(fixture.reads.some(({ root, files }) => root.startsWith(`${scratch}/`) && files.some(({ path, content }) => path === oldPath && content === oldSource)));
    assert.ok(fixture.reads.some(({ root, files }) => root.startsWith(`${orders}/.ye-ast-graph/live/`) && files.some(({ path, content }) => path === newPath && content === newSource)));
    assert.ok(fixture.reads.some(({ root, files }) => root.startsWith(`${web}/.ye-ast-graph/live/`) && files.some(({ path, content }) => path === clientPath && content === clientSource)));
    assert.equal(fixture.active.size, 0); assert.deepEqual(readdirSync(scratch), []);
    for (const repo of [orders, web]) assert.equal(readdirSync(join(repo, ".ye-ast-graph", "live")).some((name) => name.endsWith(".lock")), false);
  } finally { context.signal.removeEventListener("abort", cancel); cancel(); await Promise.allSettled(pending); rmSync(dir, { recursive: true, force: true }); }
});

test("aborting inside a real incoming-edge walk closes readers and releases both leases", { timeout: 120_000 }, async (context) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ye-ast-walk-abort-")));
  const orders = join(dir, "orders"), web = join(dir, "web"), scratch = join(dir, "scratch");
  const controller = new AbortController(); const pending: Promise<unknown>[] = [];
  const cancel = () => controller.abort(); context.signal.addEventListener("abort", cancel, { once: true });
  if (context.signal.aborted) cancel();
  try {
    for (const repo of [orders, web]) { mkdirSync(repo); git(repo, "init", "-q", "-b", "main"); mkdirSync(join(repo, "src")); }
    writeFileSync(join(orders, "src/Controller.java"), 'import org.springframework.web.bind.annotation.*; @RestController class Controller { @GetMapping("/walk") String get() { return "ok"; } }');
    writeFileSync(join(web, "src/api.ts"), 'import { HttpClient } from "@angular/common/http"; function helper(http: HttpClient) { return http.get("orders-api/walk"); } export class Api { constructor(private http: HttpClient) {} checkout() { return helper(this.http); } }');
    for (const repo of [orders, web]) { git(repo, "add", "-A"); git(repo, "commit", "-qm", "base"); }
    mkdirSync(scratch); const fixture = realWorkspaceFixture(scratch, [orders, web]);
    const lock = fixture.mirror.lock; const lockSignals: (AbortSignal | undefined)[] = [];
    fixture.mirror.lock = (location, signal) => { lockSignals.push(signal); return lock(location, signal); };
    const open = fixture.graph.open; let opened = 0, closed = 0, walked = false;
    fixture.graph.open = (store) => {
      const result = open(store); if (!result.ok) return result;
      opened++; const reader = result.value;
      return { ok: true, value: new Proxy(reader, { get(target, property) {
        if (property === "incomingEdges") return (...args: Parameters<typeof reader.incomingEdges>) => {
          const edges = reader.incomingEdges(...args);
          if (!walked && edges.length > 0 && fixture.discoveries.length > 0 && fixture.active.size === 2) {
            assert.deepEqual(lockSignals, [controller.signal, controller.signal]);
            walked = true; assert.equal(controller.signal.aborted, false); controller.abort();
          }
          return edges;
        };
        if (property === "close") return () => { try { reader.close(); } finally { closed++; } };
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } }) };
    };
    const request = { repo: { path: web, id: "web", live: true as const }, repos: [{ path: orders, id: "orders", live: true as const }], targets: [{ file: "src/api.ts", symbol: "helper" }], signal: controller.signal };
    const query = fixture.impact.callers(request); pending.push(query); const result = await query;
    assert.equal(walked, true, JSON.stringify(result));
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.fault.kind, "aborted");
    assert.ok(opened > 0); assert.equal(closed, opened);
    assert.equal(fixture.active.size, 0); assert.deepEqual(readdirSync(scratch), []);
    for (const repo of [orders, web]) assert.equal(readdirSync(join(repo, ".ye-ast-graph", "live")).some((name) => name.endsWith(".lock")), false);
    const retry = fixture.impact.callers({ ...request, signal: context.signal }); pending.push(retry);
    const again = await retry; assert.ok(again.ok && again.value.fact.status !== "unknown", JSON.stringify(again));
    assert.equal(closed, opened); assert.equal(fixture.active.size, 0); assert.deepEqual(readdirSync(scratch), []);
  } finally { context.signal.removeEventListener("abort", cancel); cancel(); await Promise.allSettled(pending); rmSync(dir, { recursive: true, force: true }); }
});
