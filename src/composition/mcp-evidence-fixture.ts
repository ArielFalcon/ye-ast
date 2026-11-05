/**
 * A small real fixture for `ye_ast_compose`: two temporary Git repositories, `shop` (Spring routes) and `web` (an Angular
 * HttpClient consumer with TypeScript imports), each with a base and a head commit, and one query per family pinned to
 * full SHAs. Every index, cache, trust and scratch directory lives under one temporary root; nothing reads the user's
 * environment, the network or a real trust store. Test-only: the e2e test and the composition evaluator share it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import type { McpDeps } from "../mcp/server.ts";
import type { ComposeQuery } from "../mcp/query-schema.ts";

export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export const CONTROLLER_PATH = "src/main/java/shop/OrderController.java";
export const CONTROLLER = `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
class OrderController {
  @GetMapping("/{id}")
  String one() {
    String combined = first() + second();
    return "x";
  }
  String first() { return "a"; }
  String second() { return "b"; }
}
`;

export const PAGE_PATH = "src/app/order.page.ts";
export const SERVICE_PATH = "src/app/order.service.ts";
export const SERVICE = `export function orderPath(id: number): string {
  return "shop-api/orders/" + id;
}
`;
export const PAGE = `import { HttpClient } from "@angular/common/http";
import { inject } from "@angular/core";
import { orderPath } from "./order.service";

export class OrderPage {
  private readonly http = inject(HttpClient);
  open(): void {
    const id = 7;
    this.http.get("shop-api/orders/7");
  }
  missing(): void {
    this.http.get("shop-api/refunds/7");
  }
  label(): string {
    return orderPath(7);
  }
}
`;

/** The repository IDs the host declares: `shop` is the launch repository, `web` an additional target. */
export const SHOP = "shop";
export const WEB = "web";
export const GATEWAYS = [{ prefix: "shop-api", repo: SHOP }] as const;

export type FixtureRepository = { id: string; root: string; base: string; head: string };

export interface CompositionFixture {
  /** Ports wired by `composeQueries` with this fixture's own index/cache/trust/scratch directories. */
  deps: McpDeps;
  /** One pinned query per family, in family order; `offline` is explicit wherever the family accepts it. */
  queries: ComposeQuery[];
  /** Base and head of the launch repository `shop`. */
  base: string;
  head: string;
  /** The temporary directory that holds both repositories and all state. */
  root: string;
  shop: FixtureRepository;
  web: FixtureRepository;
  trustDirectory: string;
  /** Fresh ports over new index/cache/scratch directories (the same trust directory): a cold session of the same repositories. */
  coldDeps(): McpDeps;
  /** `coldDeps` plus the directory that holds its index, cache and scratch, to observe what a session wrote. */
  coldState(): { deps: McpDeps; directory: string };
  git(repo: FixtureRepository, ...args: string[]): string;
  dispose(): void;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function repository(root: string, id: string, files: Record<string, string>, change: Record<string, string>): FixtureRepository {
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("branch", "comparison", base);
  for (const [path, text] of Object.entries(change)) write(root, path, text);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  return { id, root: realpathSync(root), base, head: git("rev-parse", "HEAD") };
}

export async function createCompositionFixture(): Promise<CompositionFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ye-ast-compose-")));
  const shop = repository(join(root, "shop"), SHOP, { [CONTROLLER_PATH]: CONTROLLER }, { [CONTROLLER_PATH]: CONTROLLER.replace('return "x"', 'return "changed"') });
  // The web repository also holds a controller at the same relative path, so a path alone never identifies a file.
  const web = repository(
    join(root, "web"),
    WEB,
    { [SERVICE_PATH]: SERVICE, [PAGE_PATH]: PAGE.replace("    const id = 7;\n", "").replace("return orderPath(7);", 'return "7";'), [CONTROLLER_PATH]: CONTROLLER.replace("/orders", "/foreign") },
    { [PAGE_PATH]: PAGE },
  );
  const trustDirectory = join(root, "trust");
  let generation = 0;
  const coldState = (): { deps: McpDeps; directory: string } => {
    generation += 1;
    const state = join(root, `state-${generation}`);
    mkdirSync(join(state, "scratch"), { recursive: true });
    const queries = composeQueries({ scratchRoot: join(state, "scratch"), indexCache: join(state, "index"), cacheDirectory: join(state, "cache"), trustDirectory });
    const deps: McpDeps = {
      ...queries,
      digest: createSha256Digest(),
      repository: { path: shop.root, repoId: SHOP },
      repositories: [{ path: web.root, repoId: WEB }],
    };
    return { deps, directory: state };
  };
  const coldDeps = (): McpDeps => coldState().deps;
  const members = [{ path: web.root, id: WEB, revision: web.head }];
  const crossing = { repos: members, gateways: [...GATEWAYS] };
  const queries: ComposeQuery[] = [
    { name: "ye_ast_entrypoints", arguments: { repo: SHOP, revision: shop.head } },
    { name: "ye_ast_impact", arguments: { repo: SHOP, base: shop.base, head: shop.head, changed: ["src/main/java/**"], offline: true } },
    { name: "ye_ast_callers", arguments: { repo: SHOP, revision: shop.head, targets: [{ file: CONTROLLER_PATH, symbol: "OrderController.one" }], workspace: crossing, offline: true } },
    { name: "ye_ast_importers", arguments: { repo: WEB, revision: web.head, files: [SERVICE_PATH] } },
    { name: "ye_ast_outline", arguments: { repo: SHOP, revision: shop.head, files: [CONTROLLER_PATH] } },
    { name: "ye_ast_workspace", arguments: { repo: SHOP, revision: shop.head, repos: members, gateways: [...GATEWAYS], offline: true } },
    { name: "ye_ast_decisions", arguments: { repo: SHOP, revision: shop.head, repos: members, gateways: [...GATEWAYS], offline: true } },
  ];
  return {
    deps: coldDeps(),
    queries,
    base: shop.base,
    head: shop.head,
    root,
    shop,
    web,
    trustDirectory,
    coldDeps,
    coldState,
    git: (repo, ...args) => execFileSync("git", args, { cwd: repo.root, env: GIT_ENV, encoding: "utf8" }).trim(),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
