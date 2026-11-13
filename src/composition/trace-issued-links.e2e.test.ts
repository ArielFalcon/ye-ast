import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeCli } from "./compose.ts";
import { EXIT_CODE } from "../cli/main.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

const PRODUCER = { "Users.java": `import org.springframework.web.bind.annotation.*;
@RestController
class Users {
  @GetMapping("/users/{id}")
  String user(@PathVariable String id) { return id; }
  @GetMapping("/orders/{id}")
  String order(@PathVariable String id) { return id; }
}` };

const CALLER = "src/main/java/shop/";

async function withShop(files: Record<string, string>, use: (trace: (target: string) => Promise<TraceValue>) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ye-ast-"));
  mkdirSync(join(root, "scratch"));
  const repository = (name: string, tree: Record<string, string>): string => {
    const path = join(root, name);
    mkdirSync(path);
    for (const [file, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), text);
    }
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path, env: GIT_ENV });
    execFileSync("git", ["add", "-A"], { cwd: path, env: GIT_ENV });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: path, env: GIT_ENV });
    return path;
  };
  try {
    const shop = repository("shop", Object.fromEntries(Object.entries(files).map(([name, text]) => [`${CALLER}${name}`, text])));
    const users = repository("users", PRODUCER);
    const manifest = join(root, "workspace.json");
    writeFileSync(manifest, JSON.stringify({ repos: [{ path: users, id: "users", revision: "HEAD" }], gateways: [] }));
    const run = composeCli({ scratchRoot: join(root, "scratch"), indexCache: join(root, "cache") });
    await use(async (target) => {
      const out: string[] = [], err: string[] = [];
      const code = await run(["trace", shop, `${CALLER}${target}`, "--workspace", manifest, "--offline"], { out: (line) => out.push(line), err: (line) => err.push(line) });
      assert.equal(code, EXIT_CODE.ok, err.join("\n"));
      return JSON.parse(out.join("\n")).value;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LAYERED = {
  "Controller.java": `package shop;
import org.springframework.web.bind.annotation.*;
@RestController
public class Controller {
  private UseCase useCase;
  @GetMapping("/checkout")
  public String checkout() { return useCase.run("1"); }
  @GetMapping("/other")
  public String other() { return "x"; }
}
`,
  "UseCase.java": `package shop;
import org.springframework.stereotype.Service;
@Service
public class UseCase {
  private Adapter adapter;
  public String run(String id) { return adapter.user(id); }
  public String unrelated() { return "x"; }
}
`,
  "Adapter.java": `package shop;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
@Component
public class Adapter {
  private RestTemplate http;
  public String user(String id) { return http.getForObject("/users/" + id, String.class); }
}
`,
};

const CONTROLLER = "Controller.java";
const placesOf = (value: TraceValue) => (value.links ?? []).map((link) => `${link.from.symbol} -> ${link.to.name}${link.issuedAt === undefined ? "" : ` via ${link.issuedAt.map(({ file, line }) => `${file.slice(CALLER.length)}:${line}`).join(",")}`}`);

test("a trace below the outermost caller returns the link the workspace sites at that caller, once, naming the effect that issues it", async () => {
  await withShop(LAYERED, async (trace) => {
    assert.deepEqual(placesOf(await trace("UseCase.java:UseCase.run")), ["Controller.checkout -> GET /users/{id} via UseCase.java:6"]);
    assert.deepEqual(placesOf(await trace("Adapter.java:Adapter.user")), ["Controller.checkout -> GET /users/{id} via Adapter.java:7"]);
    assert.equal((await trace(`${CONTROLLER}:Controller.checkout`)).links?.length, 1);
    const unrelated = await trace("UseCase.java:UseCase.unrelated");
    assert.deepEqual([unrelated.links, unrelated.unlinked], [[], []]);
  });
});

test("two outer callers of one body that reach one destination are both returned by a trace below them", async () => {
  const files = {
    ...LAYERED,
    "Controller.java": LAYERED["Controller.java"].replace("public String other() { return \"x\"; }", "public String other() { return useCase.run(\"2\"); }"),
  };
  await withShop(files, async (trace) => {
    assert.deepEqual(placesOf(await trace("UseCase.java:UseCase.run")).map((one) => one.split(" via ")[0]), ["Controller.checkout -> GET /users/{id}", "Controller.other -> GET /users/{id}"]);
  });
});

test("an effect that supports outer callers reaching different destinations decides none of them, while a trace from one caller keeps its own", async () => {
  const adapter = LAYERED["Adapter.java"].replace('"/users/" + id', '"/" + id + "/1"');
  const files = {
    ...LAYERED,
    "Adapter.java": adapter,
    "Controller.java": LAYERED["Controller.java"].replace('useCase.run("1")', 'useCase.run("users")').replace("public String other() { return \"x\"; }", 'public String other() { return useCase.run("orders"); }'),
  };
  await withShop(files, async (trace) => {
    const below = await trace("UseCase.java:UseCase.run");
    assert.deepEqual([below.links, below.unlinked], [[], []]);
    assert.deepEqual(placesOf(await trace(`${CONTROLLER}:Controller.other`)).map((one) => one.split(" via ")[0]), ["Controller.other -> GET /orders/{id}"]);
  });
});
