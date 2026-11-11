import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeCli, composeQueries } from "./compose.ts";
import { EXIT_CODE } from "../cli/main.ts";

test("a narrowed map reads Angular routing context for revision and live while respecting excludes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ye-ast-scoped-map-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { "@angular/core": "21.0.0", "@angular/router": "21.0.0" } }),
    "angular.json": JSON.stringify({ version: 1, projects: {} }),
    "src/main.ts": "import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'; import { AppModule } from './app/app.module'; platformBrowserDynamic().bootstrapModule(AppModule);",
    "src/app/app.module.ts": "import { NgModule } from '@angular/core'; import { RouterModule } from '@angular/router'; import { OwnersModule } from './owners/owners.module'; import { PetsModule } from './pets/pets.module'; @NgModule({ imports: [RouterModule.forRoot([]), OwnersModule, PetsModule] }) export class AppModule {}",
    "src/app/owners/owners.module.ts": "import { NgModule } from '@angular/core'; import { OwnersRoutingModule } from './routes/owners-routing.module'; @NgModule({ imports: [OwnersRoutingModule] }) export class OwnersModule {}",
    "src/app/owners/routes/owners-routing.module.ts": "import { NgModule } from '@angular/core'; import { RouterModule } from '@angular/router'; import { OwnerList } from '../owner-list'; @NgModule({ imports: [RouterModule.forChild([{ path: 'owners', component: OwnerList }])] }) export class OwnersRoutingModule {}",
    "src/app/owners/owner-list.ts": "export class OwnerList {}",
    "src/app/pets/pets.module.ts": "import { NgModule } from '@angular/core'; import { RouterModule } from '@angular/router'; import { PetList } from './pet-list'; @NgModule({ imports: [RouterModule.forChild([{ path: 'pets', component: PetList }])] }) export class PetsModule {}",
    "src/app/pets/pet-list.ts": "export class PetList {}",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } });
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    const scratchRoot = join(root, "scratch");
    const trustDirectory = join(root, "trust");
    const cacheDirectory = join(root, "cache");
    mkdirSync(scratchRoot);
    const options = { scratchRoot, trustDirectory, cacheDirectory };
    assert.equal(await composeCli(options)(["init", "--trust", "trusted", repo], { out: () => undefined, err: () => undefined }), EXIT_CODE.ok);
    const { entrypoints } = composeQueries(options);
    for (const snapshot of [{ revision: "HEAD" } as const, { live: true } as const]) {
      for (const excluded of [false, true]) {
        const scope = { include: ["src/app/owners/**"], ...(excluded ? { exclude: ["src/app/owners/routes/**"] } : {}) };
        const result = await entrypoints.map({ repo, repoId: "fixture", ...snapshot, scope });
        assert.ok(result.ok);
        const section = result.value.value.entrypoints;
        assert.ok(section.status !== "unknown");
        if (!excluded) assert.equal(section.status, "complete");
        if (section.status === "partial") assert.ok(section.cuts.every((cut) => !cut.at[0]?.startsWith("src/app/owners/routes/")));
        assert.deepEqual(section.value.map((finding) => finding.status === "complete" && finding.value.kind === "ui-route" ? [finding.value.kind, finding.value.path] : finding.status), excluded ? [] : [["ui-route", "/owners"]]);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
