import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import { EDGE_POLICY } from "../core/domain/impact/edge-policy.ts";
import type { Cut } from "../core/domain/shared/fact.ts";

/**
 * `Page` injects `Store` and `Cart`, whose `items` is a property holding a computed signal that `Page` calls, and `Wallet`, whose
 * `balance` is a property `overdraft` assigns on an object the syntax does not place. `Other` declares `items` too, in
 * another file. `move` writes `items` and `balance` on a `Motion`, a type none of those classes is assignable to.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "20.0.0" } }),
  "src/store.ts": [
    "import { Injectable, computed } from '@angular/core';",
    "",
    "@Injectable({ providedIn: 'root' })",
    "export class Store {",
    "  readonly items = computed(() => ['a']);",
    "}",
    "",
  ].join("\n"),
  "src/other.ts": [
    "import { computed } from '@angular/core';",
    "",
    "export class Other {",
    "  readonly items = computed(() => [1]);",
    "}",
    "",
  ].join("\n"),
  "src/cart.ts": [
    "import { Injectable, computed } from '@angular/core';",
    "",
    "@Injectable({ providedIn: 'root' })",
    "export class Cart {",
    "  items = computed(() => ['a']);",
    "}",
    "",
  ].join("\n"),
  "src/wallet.ts": [
    "import { Injectable, computed } from '@angular/core';",
    "",
    "@Injectable({ providedIn: 'root' })",
    "export class Wallet {",
    "  balance = computed(() => 0);",
    "}",
    "",
  ].join("\n"),
  "src/page.ts": [
    "import { Injectable, inject } from '@angular/core';",
    "import { Cart } from './cart';",
    "import { Store } from './store';",
    "import { Wallet } from './wallet';",
    "",
    "@Injectable({ providedIn: 'root' })",
    "export class Page {",
    "  private readonly store = inject(Store);",
    "  private readonly wallet = inject(Wallet);",
    "",
    "  count(): number {",
    "    return this.store.items().length;",
    "  }",
    "",
    "  funds(): number {",
    "    return this.wallet.balance();",
    "  }",
    "",
    "  private readonly cart = inject(Cart);",
    "",
    "  total(): number {",
    "    return this.cart.items().length;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/motion.ts": ["export interface Motion {", "  items: () => string[];", "  balance: () => number;", "  velocity: number;", "}", "", "export function move(motion: Motion): void {", "  motion.items = () => [];", "  motion.balance = () => 0;", "}", ""].join("\n"),
  "src/overdraft.ts": ["export function overdraft(target: any): void {", "  target.balance = () => -1;", "}", ""].join("\n"),
};

let root: string;
let repo: string;
let scratchRoot: string;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-angular-property-member-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  await mkdir(repo);
  await mkdir(scratchRoot);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env: ENV });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const PROVEN = { confidence: EDGE_POLICY.relations.confidence, derivation: "proven" };

async function callerOf(file: string, member: string, caller: string): Promise<{ settled: unknown; cuts: unknown }> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "angular-property-member", revision: "HEAD", targets: [{ file, symbol: member }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  const found = result.value.value.symbols.find((symbol) => symbol.file === "src/page.ts" && symbol.symbol === caller);
  return { settled: found === undefined ? undefined : { confidence: found.confidence, derivation: found.via?.derivation }, cuts: result.value.status === "partial" ? result.value.cuts : [] };
}

test("a call of a property of an injected service is a proven caller of it, with no cut at the call", async () => {
  assert.deepEqual(await callerOf("src/store.ts", "items", "count"), { settled: PROVEN, cuts: [] });
});

test("a call of a property of an injected service is no name-only cut of a homonym property of another class", async () => {
  const { settled, cuts } = await callerOf("src/other.ts", "items", "count");
  assert.equal(settled, undefined);
  assert.deepEqual(cuts, []);
});

test("a call of a property that code assigns on an object the syntax does not place is a reassignable cut at the places that write it", async () => {
  const { cuts } = await callerOf("src/wallet.ts", "balance", "funds");
  assert.deepEqual((cuts as Cut[]).map(({ reason, at, cause }) => ({ reason, at, cause })), [
    { reason: "reassignable", at: ["src/page.ts", "src/page.ts:16 this.wallet.balance"], cause: ["src/overdraft.ts:2 reassignment"] },
  ]);
});

test("a property that code assigns only on a receiver typed as something the class is not assignable to is a proven caller with no cut", async () => {
  assert.deepEqual(await callerOf("src/cart.ts", "items", "total"), { settled: PROVEN, cuts: [] });
});
