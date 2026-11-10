import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { EntrypointExtraction } from "../../ports/entrypoint-extractor.port.ts";
import * as routes from "./angular-routes.adapter.ts";
import { ROUTER_VOCABULARY_DOUBLE } from "./angular-router.testing.ts";
import { parseAngularRouteFile } from "./angular-router.extractor.ts";
import { readAngularMetadataFile, type RawAngularFile, type RawOperand } from "./angular-metadata.extractor.ts";

const PACKAGE = JSON.stringify({ dependencies: { "@angular/core": "21.0.0", "@angular/router": "21.0.0" } });
const NG_MODULE = "import { NgModule } from '@angular/core';\n";
const ROUTER_MODULE = "import { RouterModule } from '@angular/router';\n";
const ROUTES_HEADER = "import { Routes } from '@angular/router';\n";

/** A repository read through the port seam: in-memory sources and the manifest that makes them an Angular project. */
function extract(files: Record<string, string>): Promise<readonly Finding<Entrypoint>[]> {
  return extraction(files).then((whole) => whole.findings);
}

function namesOf(findings: readonly Finding<Entrypoint>[]): string[] {
  return findings.flatMap((finding) => (finding.status === "complete" && finding.value.kind === "ui-route" ? [finding.value.name] : []));
}

const OWNERS_MODULE = `${NG_MODULE}import { OwnersRoutingModule } from './owners-routing.module';\n@NgModule({ imports: [OwnersRoutingModule] })\nexport class OwnersModule {}\n`;
const OWNERS_ROUTING = `${NG_MODULE}${ROUTER_MODULE}@NgModule({ imports: [RouterModule.forChild([{ path: 'owners', component: OwnerList }])] })\nexport class OwnersRoutingModule {}\n`;

/** An empty Angular metadata reading of a file: every field typed, with the classes and arrays the test sets. */
function angularFile(classes: RawAngularFile["classes"], arrays: RawAngularFile["arrays"] = new Map()): RawAngularFile {
  const empty = readAngularMetadataFile(ts.createSourceFile("app.ts", "", ts.ScriptTarget.Latest, true), { imports: new Map() });
  return { ...empty, classes, arrays };
}

test("the class a bootstrapModule call boots is read, and bootstrapModuleFactory is not", () => {
  const raw = parseAngularRouteFile(
    "src/main.ts",
    "import { AppModule } from './app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\nplatformBrowserDynamic().bootstrapModuleFactory(factory);",
  );

  assert.deepEqual(raw?.bootstraps, [{ className: "AppModule", module: "./app.module", imported: "AppModule", line: 2, endLine: 2 }]);
});

test("the module composition is projected from the Angular metadata reading, never re-read", () => {
  const imports: RawOperand[] = [
    { reference: { name: "OwnersRoutingModule" }, line: 4 },
    { unreadable: true, line: 5 },
  ];
  const projected = routes.modulesOf(
    angularFile([
      { kind: "module", name: "OwnersModule", line: 3, imports, declarations: [], exports: [], hostDirectives: [] },
      { kind: "component", name: "OwnerList", line: 9, imports: [], declarations: [], exports: [], hostDirectives: [] },
    ]),
  );

  assert.deepEqual(projected, { modules: [{ name: "OwnersModule", line: 3, imports }], arrays: new Map() });
});

test("a spread in imports projects the identifier the owner answered, and the arrays verbatim", () => {
  const shared: RawOperand[] = [{ reference: { name: "OwnersRoutingModule" }, line: 9 }];
  const projected = routes.modulesOf(
    angularFile(
      [{ kind: "module", name: "AppModule", line: 1, imports: [{ reference: { name: "SHARED" }, line: 2 }], declarations: [], exports: [], hostDirectives: [] }],
      new Map([["SHARED", shared]]),
    ),
  );

  assert.deepEqual(projected.modules[0]?.imports, [{ reference: { name: "SHARED" }, line: 2 }]);
  assert.deepEqual(projected.arrays, new Map([["SHARED", shared]]));
});

test("a forChild table a module composes is named at the root", async () => {
  const findings = await extract({
    "src/main.ts": "import { AppModule } from './app/app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\n",
    "src/app/app.module.ts": `${NG_MODULE}import { OwnersModule } from './owners/owners.module';\n@NgModule({ imports: [OwnersModule] })\nexport class AppModule {}\n`,
    "src/app/owners/owners.module.ts": OWNERS_MODULE,
    "src/app/owners/owners-routing.module.ts": OWNERS_ROUTING,
  });

  assert.deepEqual(namesOf(findings), ["/owners"]);
});

test("a forChild table inside a lazily loaded module graph is named under the lazy route", async () => {
  const main = "import { provideRouter } from '@angular/router';\nimport { routes } from './app/app.routes';\nbootstrap(App, { providers: [provideRouter(routes)] });\n";
  const findings = await extract({
    "src/main.ts": main,
    "src/app/app.routes.ts": `${ROUTES_HEADER}export const routes: Routes = [\n  { path: 'auth', loadChildren: () => import('./auth/auth.module').then((m) => m.AuthModule) },\n];\n`,
    "src/app/auth/auth.module.ts": `${NG_MODULE}import { AuthRoutingModule } from './auth-routing.module';\n@NgModule({ imports: [AuthRoutingModule] })\nexport class AuthModule {}\n`,
    "src/app/auth/auth-routing.module.ts": `${NG_MODULE}${ROUTER_MODULE}@NgModule({ imports: [RouterModule.forChild([{ path: '', children: [{ path: 'register', component: Register }] }])] })\nexport class AuthRoutingModule {}\n`,
  });

  assert.deepEqual(namesOf(findings), ["/auth/register"]);
});

test("a module graph registered at the root and loaded lazily yields both prefixes", async () => {
  const main = "import { provideRouter } from '@angular/router';\nimport { AppModule } from './app/app.module';\nimport { routes } from './app/app.routes';\nbootstrap(App, { providers: [provideRouter(routes)] });\nplatformBrowserDynamic().bootstrapModule(AppModule);\n";
  const findings = await extract({
    "src/main.ts": main,
    "src/app/app.routes.ts": `${ROUTES_HEADER}export const routes: Routes = [\n  { path: 'lazy', loadChildren: () => import('./owners/owners.module').then((m) => m.OwnersModule) },\n];\n`,
    "src/app/app.module.ts": `${NG_MODULE}import { OwnersModule } from './owners/owners.module';\n@NgModule({ imports: [OwnersModule] })\nexport class AppModule {}\n`,
    "src/app/owners/owners.module.ts": OWNERS_MODULE,
    "src/app/owners/owners-routing.module.ts": OWNERS_ROUTING,
  });

  assert.deepEqual(namesOf(findings).sort(), ["/lazy/owners", "/owners"]);
});

test("a forChild outside the decorator's imports operand is never attributed to the module: a static field and a static method hold no route", async () => {
  const findings = await extract({
    "src/main.ts": "import { AppModule } from './app/app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\n",
    "src/app/app.module.ts": `${NG_MODULE}${ROUTER_MODULE}import { OwnersModule } from './owners/owners.module';\n@NgModule({ imports: [RouterModule.forChild([{ path: 'real', component: Real }]), OwnersModule] })\nexport class AppModule {\n  static unused = RouterModule.forChild([{ path: 'ghost', component: Ghost }]);\n  static build() { return RouterModule.forChild([{ path: 'spook', component: Spook }]); }\n}\n`,
    "src/app/owners/owners.module.ts": OWNERS_MODULE,
    "src/app/owners/owners-routing.module.ts": OWNERS_ROUTING,
  });

  assert.deepEqual(namesOf(findings), ["/real", "/owners"]);
});

test("a module graph with an import the reading could not resolve is not built: never a route from the rest of it", async () => {
  const findings = await extract({
    "src/main.ts": "import { AppModule } from './app/app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\n",
    "src/app/app.module.ts": `${NG_MODULE}import { OwnersRoutingModule } from './owners/owners-routing.module';\nimport { OtherModule } from './other.module';\n@NgModule({ imports: [OwnersRoutingModule, pick('x') ? OtherModule : Other] })\nexport class AppModule {}\n`,
    "src/app/other.module.ts": `${NG_MODULE}export class OtherModule {}\n`,
    "src/app/owners/owners-routing.module.ts": OWNERS_ROUTING,
  });

  assert.deepEqual(namesOf(findings), []);
});

test("a legacy workspace rooted at the repository resolves module graphs without a promise cycle", async () => {
  const findings = await extract({
    "angular.json": JSON.stringify({ projects: { app: { sourceRoot: "" } } }),
    "main.ts": "import { RouterModule } from '@angular/router'; RouterModule.forRoot([{path: 'feature', loadChildren: 'feature#FeatureModule'}]);",
    "feature.ts": `${NG_MODULE}${ROUTER_MODULE}@NgModule({imports: [RouterModule.forChild([{path: 'leaf', component: Leaf}])]}) export class FeatureModule {}`,
  });
  assert.deepEqual(namesOf(findings), ["/feature/leaf"]);
});

const ROOT_MAIN = "import { provideRouter } from '@angular/router';\nimport { routes } from './app/app.routes';\nbootstrap(App, { providers: [provideRouter(routes)] });\n";

function extraction(files: Record<string, string>): Promise<EntrypointExtraction> {
  const sources = Object.entries({ "package.json": PACKAGE, ...files }).map(([path, content]) => ({ path, content }));
  return routes.createAngularRoutesExtractor(ROUTER_VOCABULARY_DOUBLE).extract(sources);
}

test("a loadChildren the sources do not resolve is an unknown item and one cut", async () => {
  const extracted = await extraction({
    "src/main.ts": ROOT_MAIN,
    "src/app/app.routes.ts": `${ROUTES_HEADER}export const routes: Routes = [\n  { path: 'home', component: Home },\n  { path: 'gone', loadChildren: () => import('./missing.routes') },\n];\n`,
  });

  assert.deepEqual(extracted.readingCuts, [
    { kind: "unresolved-link", at: ["src/app/app.routes.ts", "src/app/app.routes.ts:4"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } },
  ]);
  assert.deepEqual(extracted.findings.filter((finding) => finding.status === "unknown"), [{ status: "unknown", reason: "unresolved", evidence: [{ path: "src/app/app.routes.ts", line: 4, endLine: 4 }] }]);
});

test("the same place never yields two cuts: a root configuration that is both an unresolved reference and an unresolved configuration", async () => {
  const extracted = await extraction({
    "src/main.ts": "import { provideRouter } from '@angular/router';\nimport { routes } from './app/nowhere';\nbootstrap(App, { providers: [provideRouter(routes)] });\n",
  });

  assert.deepEqual(extracted.readingCuts, [
    { kind: "unresolved-link", at: ["src/main.ts", "src/main.ts:3"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } },
  ]);
});

test("an @NgModule import that names no file is one cut with the module reach", async () => {
  const extracted = await extraction({
    "src/main.ts": "import { AppModule } from './app/app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\n",
    "src/app/app.module.ts": `${NG_MODULE}import { MissingModule } from './missing.module';\n@NgModule({ imports: [MissingModule] })\nexport class AppModule {}\n`,
  });

  assert.deepEqual(extracted.readingCuts, [
    { kind: "unresolved-link", at: ["src/app/app.module.ts", "src/app/app.module.ts:3"], reason: "specifier", reach: { kind: "module", importer: "src/app/app.module.ts", specifiers: [{ specifier: "./missing.module", namesNoFile: true }] } },
  ]);
});

test("an @NgModule import of a file that does not parse is one cut of the graph, never a silent skip", async () => {
  const extracted = await extraction({
    "src/main.ts": "import { AppModule } from './app/app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\n",
    "src/app/app.module.ts": `${NG_MODULE}import { FeatureModule } from './feature.module';\n@NgModule({ imports: [FeatureModule] })\nexport class AppModule {}\n`,
    "src/app/feature.module.ts": `${NG_MODULE}${ROUTER_MODULE}@NgModule({ imports: [RouterModule.forChild([{ path: 'x', component: X }])] })\nexport class FeatureModule {\n`,
  });

  assert.deepEqual(extracted.readingCuts, [
    { kind: "unresolved-link", at: ["src/app/app.module.ts", "src/app/app.module.ts:3"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } },
  ]);
});

test("an @NgModule operand the metadata reading cannot read is one cut of the graph it sits in", async () => {
  const extracted = await extraction({
    "src/main.ts": "import { AppModule } from './app/app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\n",
    "src/app/app.module.ts": `${NG_MODULE}import { FeatureModule } from './feature.module';\n@NgModule({ imports: [makeModule(), FeatureModule] })\nexport class AppModule {}\n`,
    "src/app/feature.module.ts": `${NG_MODULE}${ROUTER_MODULE}@NgModule({ imports: [RouterModule.forChild([{ path: 'x', component: X }])] })\nexport class FeatureModule {}\n`,
  });

  assert.deepEqual(extracted.readingCuts, [
    { kind: "unresolved-link", at: ["src/app/app.module.ts", "src/app/app.module.ts:3"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } },
  ]);
});
