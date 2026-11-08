/**
 * `ye_ast_compose` over `ye_ast_impact` and `ye_ast_contract_consequences` on one real workspace (RFC-0023 "Compose"): a
 * Spring service `api` changed between two commits, and an Angular consumer `web`, both read at pinned revisions. The
 * consequence parts join the impact parts through the handler they name, with no relation rule of their own.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeCli, composeQueries } from "./compose.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createMcpServer, type McpDeps } from "../mcp/server.ts";
import { openSession, resultFields, type Session, type ToolResult } from "../mcp/test-session.testing.ts";
import { COMPOSE_OUTPUT } from "../mcp/composition-schema.ts";
import type { ComposeQuery } from "../mcp/query-schema.ts";
import type { ComposeFull } from "../mcp/composition-contract.ts";
import type { AnchorId, CompositionGraph, EntityId, PartKind, PartOf } from "../core/ports/evidence-composition.port.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const BOOT = `package shop;

import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
class Main {}
`;

const CONTROLLER = `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
class OrdersController {
  @GetMapping("/{id}")
  public String find(@PathVariable long id) { return ""; }
}
`;

const SERVICE = `import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable } from "rxjs";

export interface Order {
  id: number;
  customer: { name: string };
}

@Injectable({ providedIn: "root" })
export class OrderService {
  private http = inject(HttpClient);

  find(id: number): Observable<Order> {
    return this.http.get<Order>(\`/api/orders/\${id}\`);
  }
}
`;

const COMPONENT = `import { Component } from "@angular/core";
import { Order, OrderService } from "./order.service";

@Component({ selector: "app-order", standalone: true, templateUrl: "./order.component.html" })
export class OrderComponent {
  order?: Order;

  constructor(private service: OrderService) {}

  load(id: number): void {
    this.service.find(id).subscribe((order) => {
      this.order = order;
    });
  }
}
`;

const TEMPLATE = "<p>{{ order.customer.name }}</p>\n";

const CONTROLLER_PATH = "src/main/java/shop/OrdersController.java";
const SERVICE_PATH = "src/app/order.service.ts";
const WEB_FILES = {
  "package.json": JSON.stringify({ dependencies: { "@angular/core": "^21.0.0", "@angular/common": "^21.0.0" } }),
  [SERVICE_PATH]: SERVICE,
  "src/app/order.component.ts": COMPONENT,
  "src/app/order.component.html": TEMPLATE,
};

type Repository = { id: string; root: string; base: string; head: string };

let root: string;
let trust: string;
let api: Repository;
let web: Repository;
let deps: McpDeps;
let session: Session;

function repository(id: string, files: Record<string, string>, change: Record<string, string> = {}): Repository {
  const dir = join(root, id);
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8" }).trim();
  const write = (entries: Record<string, string>) => {
    for (const [path, text] of Object.entries(entries)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "change");
  };
  git("init", "-q", "-b", "main");
  write(files);
  const base = git("rev-parse", "HEAD");
  if (Object.keys(change).length > 0) write(change);
  return { id, root: dir, base, head: git("rev-parse", "HEAD") };
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ye-ast-compose-consequences-")));
  trust = join(root, "trust");
  api = repository("api", { "src/main/java/shop/Main.java": BOOT, [CONTROLLER_PATH]: CONTROLLER }, { [CONTROLLER_PATH]: CONTROLLER.replace('return ""', 'return "changed"') });
  web = repository("web", WEB_FILES);
  const state = join(root, "state");
  mkdirSync(join(state, "scratch"), { recursive: true });
  const queries = composeQueries({ scratchRoot: join(state, "scratch"), indexCache: join(state, "index"), cacheDirectory: join(state, "cache"), trustDirectory: trust });
  deps = { ...queries, digest: createSha256Digest(), repository: { path: api.root, repoId: api.id }, repositories: [{ path: web.root, repoId: web.id }] };
  session = await openSession(createMcpServer(deps));
});

after(async () => {
  await session?.close();
  rmSync(root, { recursive: true, force: true });
});

const members = () => ({ repos: [{ path: web.root, id: web.id, revision: web.head }] });
const IMPACT = (): ComposeQuery => ({ name: "ye_ast_impact", arguments: { repo: api.id, base: api.base, head: api.head, workspace: members(), offline: true } });
const HYPOTHESIS = { method: "GET", path: "/api/orders/{id}", target: "response", property: "customer", change: "removed" };
const CONSEQUENCES = (): ComposeQuery => ({ name: "ye_ast_contract_consequences", arguments: { repo: api.id, revision: api.head, workspace: members(), hypotheses: [HYPOTHESIS] } });

function composed(result: ToolResult): ComposeFull {
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 2000));
  const { text: _text, ...value } = resultFields(result) as ComposeFull & { text: string };
  assert.equal(value.kind, "composition");
  assert.equal(COMPOSE_OUTPUT.safeParse(value).success, true);
  return value;
}
const compose = async (queries: ComposeQuery[]) => composed(await session.callTool("ye_ast_compose", { queries, mode: "full" }));
const parts = <K extends PartKind>(graph: CompositionGraph, kind: K): PartOf<K>[] => graph.parts.filter((part): part is PartOf<K> => part.kind === kind);
const entityOf = (graph: CompositionGraph, anchor: AnchorId): EntityId => {
  const binding = graph.bindings.find((item) => item.anchor === anchor)?.binding;
  assert.equal(binding?.status, "resolved", `anchor ${anchor} is bound to a declaration`);
  return (binding as { entity: EntityId }).entity;
};

test("a consequence joins the impact parts of the same workspace through the handler it names, at pinned revisions", async () => {
  const { graph, verification, requests } = await compose([IMPACT(), CONSEQUENCES()]);

  const [reach] = parts(graph, "entrypoint-reach");
  const [use] = parts(graph, "consequence-use");
  assert.ok(reach, "the change reaches the handler");
  assert.ok(use, "the removed property is read by the consumer");
  assert.equal(use.verdict.kind, "incompatible");
  const handler = entityOf(graph, reach.handler);
  assert.equal(entityOf(graph, use.link.handler), handler, "the consequence's handler is the declaration the change reached");
  const [admitted] = parts(graph, "workspace-link").filter((part) => part.link.to.repo === api.id);
  assert.ok(admitted, "impact admits the consumer's call as a link");
  assert.equal(entityOf(graph, admitted.link.to.handler), handler, "and the link lands in the same declaration");
  assert.equal(graph.files.find((file) => file.id === use.link.call.file)?.repo, web.id, "the call site is in the consumer");

  // The existing relation rules take the new parts in: nothing consequences-specific was added to the graph.
  const known = new Set(["serves-entrypoint", "symbol-dependence", "file-import", "file-use", "unresolved-file-name", "module-dependence", "entrypoint-origin", "module-origin", "workspace-match", "candidate-for-name", "shares-evidence"]);
  assert.ok(graph.relations.every((relation) => known.has(relation.value.kind)));

  // Re-reading at the same pins gives the same composition: the consequences request is a fresh read, the impact's a replay.
  const strategies = graph.sources.map((source) => [source.family, requests[source.requestIndex]?.status === "available" && (requests[source.requestIndex] as { strategy: string }).strategy]).sort();
  assert.deepEqual(strategies, [["contract_consequences", "fresh-read"], ["impact", "pinned-replay"]]);
  const again = await compose([IMPACT(), CONSEQUENCES()]);
  assert.deepEqual(again.verification, verification);
});

test("under live a join with a pinned source reports snapshot-difference, as for any family", async () => {
  const errors: string[] = [];
  assert.equal(await composeCli({ scratchRoot: join(root, "state", "scratch"), trustDirectory: trust })(["init", "--trust", "trusted", api.root], { out: () => {}, err: (line) => errors.push(line) }), 0, errors.join("\n"));
  const live: ComposeQuery = { name: "ye_ast_contract_consequences", arguments: { repo: api.id, live: true, workspace: members(), hypotheses: [HYPOTHESIS] } };
  const { coverage, graph } = await compose([IMPACT(), live]);

  const difference = coverage.issues.filter((issue) => issue.kind === "snapshot-difference");
  assert.equal(difference.length, 1);
  assert.equal(difference[0]?.kind === "snapshot-difference" && difference[0].repo, api.id);
  assert.ok(difference[0]?.kind === "snapshot-difference" && difference[0].snapshots.map((id) => graph.snapshots.find((snapshot) => snapshot.id === id)?.value.kind).includes("live"), "the live capture is one of the two");
});
