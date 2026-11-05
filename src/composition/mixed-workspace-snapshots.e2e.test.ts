import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realWorkspaceFixture } from "./mixed-workspace.testing.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const javaPath = "src/OrderController.java";
const tsPath = "src/app/order.api.ts";
const controller = (route: string) => `import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;
@RestController class OrderController {
  private final RestTemplate rt = new RestTemplate();
  @GetMapping("/${route}") public String get() { return rt.getForObject("http://external-api/${route}", String.class); }
}`;
const consumer = (route: string, marker: string) => `import { HttpClient } from "@angular/common/http";
export class OrderApi {
  constructor(private http: HttpClient) {}
  checkout() {
    const marker = "${marker}";
    return this.http.get("orders-api/${route}");
  }
}`;
function write(repo: string, path: string, content: string) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
function git(repo: string, ...args: string[]) { return execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim(); }

test("workspace change analysis uses both held live captures after originals move", { timeout: 120_000 }, async (context) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ye-ast-real-captures-")));
  const web = join(dir, "web"); const orders = join(dir, "orders"); const scratch = join(dir, "scratch");
  const abort = new AbortController();
  let releaseGate = () => {};
  let pending: Promise<unknown> | undefined;
  const cancel = () => { abort.abort(); releaseGate(); };
  context.signal.addEventListener("abort", cancel, { once: true });
  if (context.signal.aborted) cancel();
  try {
    for (const repo of [web, orders]) { mkdirSync(repo); git(repo, "init", "-q", "-b", "main"); }
    mkdirSync(scratch);
    write(web, tsPath, consumer("old", "base")); write(orders, javaPath, controller("old"));
    for (const repo of [web, orders]) { git(repo, "add", "-A"); git(repo, "commit", "-qm", "base"); }
    const heads = { web: git(web, "rev-parse", "HEAD"), orders: git(orders, "rev-parse", "HEAD") };
    const capturedWeb = consumer("captured", "captured-marker"); const capturedOrders = controller("captured");
    write(web, tsPath, capturedWeb); write(orders, javaPath, capturedOrders);
    const fixture = realWorkspaceFixture(scratch, [web, orders]);
    let enterGate = () => {};
    const entered = new Promise<void>((resolve) => { enterGate = resolve; });
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const remotes = fixture.vcs.remotes;
    let armed = true;
    fixture.vcs.remotes = async (repo, signal) => {
      if (armed && fixture.active.size === 2) {
        armed = false; fixture.guard(); enterGate();
        await Promise.race([gate, new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      }
      return remotes(repo, signal);
    };
    const request = { repo: { path: web, id: "web", live: true as const }, repos: [{ path: orders, id: "orders", live: true as const }], base: "HEAD", changed: [tsPath], budget: { depth: 1 }, signal: abort.signal };
    const running = fixture.impact.ofChange(request); pending = running;
    await Promise.race([entered, running.then((result) => { throw new Error(`query settled before gate: ${JSON.stringify(result)}`); })]);
    assert.deepEqual([...fixture.active].sort(), [orders, web].sort());
    assert.equal(fixture.reads.length, 0);
    assert.equal(fixture.extracted.length, 0);
    assert.equal(fixture.discoveries.length, 0);
    write(web, tsPath, consumer("after", "after-marker")); write(orders, javaPath, controller("after"));
    releaseGate();
    const result = await running;
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(fixture.active.size, 0);
    assert.notEqual(result.value.fact.status, "unknown");
    if (result.value.fact.status === "unknown") throw new Error("unknown");
    const value = result.value.fact.value;
    assert.ok(value.links.some(({ direction, link }) => direction === "downstream" && link.from.repo === "web" && link.to.repo === "orders"), JSON.stringify(value));
    assert.ok(value.sections.web?.status !== "unknown" && value.sections.web?.value.impact?.seeds.some(({ symbol }) => symbol === "checkout"));
    assert.ok(fixture.reads.some(({ files }) => files.some(({ path, content }) => path === tsPath && content === capturedWeb)));
    assert.ok(fixture.reads.some(({ files }) => files.some(({ path, content }) => path === javaPath && content === capturedOrders)));
    assert.equal(JSON.stringify(fixture.reads).includes("after-marker"), false);
    assert.equal(JSON.stringify(fixture.discoveries).includes("after"), false);
    assert.equal(JSON.stringify(result.value.fact).includes("after"), false);
    for (const repo of ["web", "orders"] as const) {
      const snapshot = value.repositorySnapshots.find((entry) => entry.repo === repo)?.snapshot;
      assert.ok(snapshot?.kind === "live"); assert.equal(snapshot.head, heads[repo]);
      const notice: import("../core/ports/live-queries.port.ts").WorkspaceLiveNotice | undefined = result.value.workspaceLive?.find((entry) => entry.repo === repo);
      assert.ok(notice?.kind === "stale"); assert.deepEqual(notice.snapshot, snapshot); assert.equal(notice.notice.stateId, snapshot.stateId);
      assert.deepEqual(notice.notice.changed, [repo === "web" ? tsPath : javaPath]);
      const section = value.sections[repo]; assert.ok(section && section.status !== "unknown");
      for (const read of section.value.reads) assert.deepEqual(read.fact.snapshot, snapshot);
    }
    const discovery = fixture.discoveries[0]?.fact;
    assert.ok(discovery && discovery.status !== "unknown");
    const server = discovery.value.repositories.find(({ repo }) => repo === "orders");
    const client = discovery.value.repositories.find(({ repo }) => repo === "web");
    assert.ok(server?.entrypoints.some((finding) => finding.status === "complete" && finding.value.name === "GET /captured"));
    assert.ok(client?.callSites.some((site) => site.symbol === "OrderApi.checkout" && site.target.status === "complete" && JSON.stringify(site.target.value).includes("orders-api/captured")));
    const downstream = value.sections.orders;
    assert.ok(downstream && downstream.status !== "unknown");
    assert.ok(downstream.value.reads.some(({ kind }) => kind === "downstream"), JSON.stringify(downstream));
    assert.ok(value.links.some(({ link }) => link.to.name === "GET /captured"));
    for (const repository of [server, client]) {
      assert.ok(repository);
      assert.deepEqual(repository.snapshot, value.repositorySnapshots.find(({ repo }) => repo === repository.repo)?.snapshot);
    }
    assert.equal(fixture.reads.filter(({ root }) => root.startsWith(`${web}/.ye-ast-graph/live/`)).length, 1);
    assert.equal(fixture.reads.filter(({ root }) => root.startsWith(`${orders}/.ye-ast-graph/live/`)).length, 1);
    assert.equal(fixture.reads.filter(({ root }) => root.startsWith(`${scratch}/`)).length, 1);
    assert.equal(fixture.extracted.filter((paths) => paths.includes(tsPath)).length, 2);
    assert.equal(fixture.extracted.filter((paths) => paths.includes(javaPath)).length, 1);
    assert.deepEqual(readdirSync(scratch), []);
    for (const repo of [web, orders]) assert.equal(readdirSync(join(repo, ".ye-ast-graph", "live")).some((name) => name.endsWith(".lock")), false);
    const first = value.repositorySnapshots;
    const nextPending = fixture.impact.ofChange(request); pending = nextPending;
    const next = await nextPending;
    assert.ok(next.ok && next.value.fact.status !== "unknown", JSON.stringify(next));
    for (const entry of next.value.fact.value.repositorySnapshots) {
      const previous = first.find((item) => item.repo === entry.repo)?.snapshot;
      assert.ok(previous?.kind === "live" && entry.snapshot.kind === "live");
      assert.notEqual(entry.snapshot.stateId, previous.stateId);
    }
    assert.ok(fixture.reads.some(({ files }) => files.some(({ content }) => content === consumer("after", "after-marker"))));
    assert.ok(fixture.reads.some(({ files }) => files.some(({ content }) => content === controller("after"))));
    assert.ok(next.value.fact.value.links.some(({ link }) => link.to.name === "GET /after"));
    assert.equal(fixture.active.size, 0); assert.deepEqual(readdirSync(scratch), []);
    for (const repo of [web, orders]) assert.equal(readdirSync(join(repo, ".ye-ast-graph", "live")).some((name) => name.endsWith(".lock")), false);
  } finally { context.signal.removeEventListener("abort", cancel); cancel(); await pending?.catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});
