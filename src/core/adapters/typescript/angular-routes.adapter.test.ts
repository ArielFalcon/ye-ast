import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { UiRoute } from "../../domain/entrypoints/ui-route.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createAngularRoutesExtractor } from "./angular-routes.adapter.ts";

const PACKAGE = JSON.stringify({ dependencies: { "@angular/core": "21.0.0", "@angular/router": "21.0.0" } });
const ROUTES = "src/app/app.routes.ts";
const HEADER = "import { Routes } from '@angular/router';\n";
/** A real application declares its root table, so the extractor never has to guess which table is the root. */
const APP_MAIN = "import { provideRouter } from '@angular/router';\nimport { routes } from './app/app.routes';\nbootstrap(App, { providers: [provideRouter(routes)] });\n";

function sources(files: Record<string, string>, manifest: string | null = PACKAGE, root = true): SourceFile[] {
  const all = manifest === null ? files : { "package.json": manifest, ...files };
  const declared = root && !("src/main.ts" in all) ? { ...all, "src/main.ts": APP_MAIN } : all;
  return Object.entries(declared).map(([path, content]) => ({ path, content }));
}

function extract(files: Record<string, string>, manifest: string | null = PACKAGE, root = true): Promise<readonly Finding<Entrypoint>[]> {
  return createAngularRoutesExtractor().extract(sources(files, manifest, root));
}

/** The table of a root routes file: the body starts at line 3, one line further per line of `header`. */
function table(body: string, header = ""): Record<string, string> {
  const lines = header === "" ? "" : `${header}\n`;
  return { [ROUTES]: `${HEADER}${lines}export const routes: Routes = [\n${body}\n];\n` };
}

function uiRoutes(findings: readonly Finding<Entrypoint>[]): UiRoute[] {
  return findings.flatMap((finding) => (finding.status === "complete" && finding.value.kind === "ui-route" ? [finding.value] : []));
}

function names(findings: readonly Finding<Entrypoint>[]): string[] {
  return uiRoutes(findings).map((route) => route.name);
}

function unknowns(findings: readonly Finding<Entrypoint>[]): string[] {
  return findings.flatMap((finding) => (finding.status === "unknown" ? [`${finding.reason}@${finding.evidence[0]?.path}:${finding.evidence[0]?.line}`] : []));
}

test("a repository whose root manifest does not name @angular/router has no UI route, whatever its sources look like", async () => {
  const files = table("  { path: 'home', component: Home },");

  assert.deepEqual(await extract(files, JSON.stringify({ dependencies: { react: "19.0.0" } })), []);
  assert.deepEqual(await extract(files, "{ not json"), []);
  assert.deepEqual(names(await extract(files, JSON.stringify({ devDependencies: { "@angular/router": "21.0.0" } }))), ["/home"]);
});

test("without a root declaration in the sources, no table is named: each entry that shows a component is unknown", async () => {
  const findings = await extract(table("  { path: '', component: Home },"), PACKAGE, false);

  assert.deepEqual(names(findings), []);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:3`]);
});

test("a TypeScript source no package.json above it holds is unknown with reason no-project, never silence", async () => {
  const files = table("  { path: 'home', component: Home },");

  assert.deepEqual(unknowns(await extract(files, null, false)), ["no-project@src/app/app.routes.ts:1"]);
  assert.deepEqual(names(await extract(files, null)), []);
});

test("a route that shows a component is named after its full path from the root table, parent paths joined", async () => {
  const body = [
    "  { path: '', component: Home },",
    "  { path: 'orders', children: [",
    "    { path: '', component: OrderList },",
    "    { path: ':id', component: OrderDetail },",
    "  ] },",
    "  { path: 'admin', component: AdminShell, children: [{ path: 'users', component: Users }] },",
    "  { path: '**', component: NotFound },",
  ].join("\n");

  assert.deepEqual((names(await extract(table(body)))), ["/", "/orders", "/orders/:id", "/admin", "/admin/users", "/**"]);
});

test("an entry that redirects is not an entrypoint, and neither is a parent that shows no component", async () => {
  const body = [
    "  { path: '', redirectTo: 'home', pathMatch: 'full' },",
    "  { path: 'home', component: Home },",
    "  { path: 'legacy', redirectTo: 'home' },",
    "  { path: 'group', canActivate: [], children: [{ path: 'inner', component: Inner }] },",
    "  { path: '**', redirectTo: '' },",
    "  { path: dynamicPath(), redirectTo: 'home' },",
  ].join("\n");

  const findings = await extract(table(body));

  assert.deepEqual(names(findings), ["/home", "/group/inner"]);
  assert.equal(findings.length, 2);
});

test("a named outlet adds its name to the route's name and is kept apart from the primary route of the same path", async () => {
  const body = ["  { path: 'compose', component: Compose },", "  { path: 'compose', component: Popup, outlet: 'popup' },"].join("\n");

  const routes = uiRoutes(await extract(table(body)));

  assert.deepEqual(routes.map((route) => route.name), ["/compose", "/compose (popup)"]);
  assert.deepEqual(routes.map((route) => route.outlet), [undefined, "popup"]);
  assert.deepEqual(routes.map((route) => route.path), ["/compose", "/compose"]);
});

test("a route carries the class it shows, found through a rename and a barrel at the line of its declaration", async () => {
  const header = "import { Home } from './home';\nimport { Shop as ShopPage } from './shop';\n";
  const body = ["  { path: '', component: Home },", "  { path: 'shop', component: ShopPage },", "  { path: 'dyn', component: pick() },", "  { path: 'ghost', component: Ghost },"].join("\n");
  const files = {
    ...table(body, header),
    "src/app/home.ts": "\n\nexport class Home {}\n",
    "src/app/shop/index.ts": "export { Shop } from './shop.component';\n",
    "src/app/shop/shop.component.ts": "@Component({})\nexport class Shop {}\n",
  };

  const routes = uiRoutes(await extract(files));

  assert.deepEqual(
    routes.map((route) => route.component),
    [{ path: "src/app/home.ts", symbol: "Home", line: 3 }, { path: "src/app/shop/shop.component.ts", symbol: "Shop", line: 2 }, "unknown", "unknown"],
  );
});

test("a lazily loaded component is the export the then-callback reads, or the default export when there is none", async () => {
  const body = [
    "  { path: 'named', loadComponent: () => import('./named').then((m) => m.NamedPage) },",
    "  { path: 'plain', loadComponent: () => import('./plain') },",
    "  { path: 'explicit', loadComponent: () => import('./plain').then((m) => m.default) },",
    "  { path: 'many', loadComponent: () => load(import('./plain'), import('./named')) },",
  ].join("\n");
  const files = {
    ...table(body),
    "src/app/named.ts": "export class NamedPage {}\n",
    "src/app/plain.ts": "\nexport default class PlainPage {}\n",
  };

  const routes = uiRoutes(await extract(files));

  assert.deepEqual(
    routes.map((route) => route.component),
    [{ path: "src/app/named.ts", symbol: "NamedPage", line: 1 }, { path: "src/app/plain.ts", symbol: "PlainPage", line: 2 }, { path: "src/app/plain.ts", symbol: "PlainPage", line: 2 }, "unknown"],
  );
});

test("a guard is placed at the file that declares it, never at a barrel; a package's and an inline one carry no file", async () => {
  const header = "import { authGuard as auth } from './guards';\nimport { UiGuard } from '@acme/ui';\nfunction own() { return true; }\n";
  const body = "  { path: 'a', canMatch: [auth], canActivate: [UiGuard, own, () => true], canActivateChild: [missing], canLoad: [], component: A },";
  const files = {
    ...table(body, header),
    "src/app/guards/index.ts": "export { authGuard } from './auth.guard';\n",
    "src/app/guards/auth.guard.ts": "export const authGuard = () => true;\n",
  };
  const manifest = JSON.stringify({ dependencies: { "@angular/router": "21.0.0", "@acme/ui": "1.0.0" } });

  const [route] = uiRoutes(await extract(files, manifest));

  assert.deepEqual(route?.guards, [
    { name: "authGuard", path: "src/app/guards/auth.guard.ts" },
    { name: "UiGuard", external: true },
    { name: "own", path: ROUTES },
    { name: "(inline)" },
  ]);
});

test("a path that is not a literal or a constant of the sources is an unknown item at its entry, and its descendants are not named", async () => {
  const body = [
    "  { path: 'ok', component: Ok, children: [{ path: dynamicPath(), component: Child }] },",
    "  { path: segments(), children: [{ path: 'below', component: Below }] },",
    "  { path: Missing.Home, component: Gone },",
  ].join("\n");

  const findings = await extract(table(body, "import { Missing } from './missing';"));

  assert.deepEqual(names(findings), ["/ok"]);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:4`, `unresolved@${ROUTES}:5`, `unresolved@${ROUTES}:6`]);
});

test("a matcher is an unknown item with no-extractor at its entry: it names no path", async () => {
  const body = ["  { matcher: urlMatcher, component: Docs, children: [{ path: 'x', component: X }] },", "  { path: 'fine', component: Fine },"].join("\n");

  const findings = await extract(table(body));

  assert.deepEqual(names(findings), ["/fine"]);
  assert.deepEqual(unknowns(findings), [`no-extractor@${ROUTES}:3`]);
});

test("a lazily loaded child table is attached under the path of the entry that loads it, in the file that declares each entry", async () => {
  const body = [
    "  { path: 'upload-menu', canMatch: [gate], loadChildren: () => import('./upload/upload.routes').then((m) => m.UPLOAD_ROUTES) },",
    "  { path: 'other', loadChildren: () => import('./other.routes') },",
  ].join("\n");
  const files = {
    ...table(body),
    "src/app/upload/upload.routes.ts": `${HEADER}export const UPLOAD_ROUTES: Routes = [\n  { path: 'preview', component: Preview },\n];\n`,
    "src/app/other.routes.ts": `${HEADER}export default [\n  { path: 'deep', component: Deep },\n] as Routes;\n`,
  };

  const findings = await extract(files);

  assert.deepEqual(names(findings), ["/other/deep", "/upload-menu/preview"]);
  assert.deepEqual(findings.map((finding) => finding.evidence[0]?.path), ["src/app/other.routes.ts", "src/app/upload/upload.routes.ts"]);
});

test("a lazy section that cannot be followed is an unresolved item at the entry that loads it", async () => {
  const body = [
    "  { path: 'gone', loadChildren: () => import('./missing.routes') },",
    "  { path: 'twice', loadChildren: () => Promise.all([import('./a'), import('./b')]) },",
    "  { path: 'dyn', loadChildren: () => import(somewhere) },",
    "  { path: 'named', children: ROUTES_OF_NOWHERE },",
  ].join("\n");

  const findings = await extract(table(body));

  assert.deepEqual(names(findings), []);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:3`, `unresolved@${ROUTES}:4`, `unresolved@${ROUTES}:5`, `unresolved@${ROUTES}:6`]);
});

test("while any child reference of the repository is unresolved, no table is named: each would-be route is an unknown item at its entry and at the references", async () => {
  const body = ["  { path: 'home', component: Home },", "  { path: 'gone', loadChildren: () => import('./missing.routes') },"].join("\n");
  const files = {
    ...table(body),
    "src/app/orphan.routes.ts": `${HEADER}export const ORPHAN: Routes = [\n  { path: 'step', component: Step },\n];\n`,
  };

  const findings = await extract(files, PACKAGE, false);

  assert.deepEqual(names(findings), []);
  const wouldBe = findings.filter((finding) => finding.evidence[0]?.path === "src/app/orphan.routes.ts");
  assert.deepEqual(wouldBe.map((finding) => (finding.status === "unknown" ? finding.reason : "complete")), ["unresolved"]);
  assert.deepEqual(wouldBe[0]?.evidence.map((span) => `${span.path}:${span.line}`), ["src/app/orphan.routes.ts:3", `${ROUTES}:4`]);
  const home = findings.find((finding) => finding.evidence[0]?.line === 3 && finding.evidence[0].path === ROUTES);
  assert.equal(home?.status, "unknown");
});

test("a route records its own guards through lazy sections, without ancestor guards", async () => {
  const header = "const a = () => true;\nconst b = () => true;\nconst m = () => true;";
  const body = [
    "  { path: 'p', canMatch: [m], canActivate: [a], children: [",
    "    { path: 'c', canActivate: [a, b], component: C },",
    "    { path: 'l', canActivateChild: [b], loadChildren: () => import('./l.routes') },",
    "  ] },",
  ].join("\n");
  const files = { ...table(body, header), "src/app/l.routes.ts": `${HEADER}export default [{ path: 'x', canLoad: [() => 1], component: X }] as Routes;\n` };

  const routes = uiRoutes(await extract(files));

  assert.deepEqual(routes.map((route) => [route.name, route.guards.map((guard) => guard.name)]), [["/p/c", ["a", "b"]], ["/p/l/x", ["(inline)"]]]);
});

test("a route table under a folder named like build output is read; one under node_modules is not", async () => {
  const files = {
    ...table("  { path: 'a', loadChildren: () => import('./build/features.routes') },"),
    "src/app/build/features.routes.ts": `${HEADER}export default [{ path: 'b', component: B }] as Routes;\n`,
    "node_modules/pkg/pkg.routes.ts": `${HEADER}export default [{ path: 'hidden', component: H }] as Routes;\n`,
  };

  assert.deepEqual(names(await extract(files)), ["/a/b"]);
});

test("tables that load each other end in an unresolved item at the entry that closes the cycle, and the walk terminates", async () => {
  const lazy = (to: string, path: string): string => `${HEADER}export const routes: Routes = [\n  { path: '${path}', component: P, loadChildren: () => import('./${to}.routes') },\n];\n`;
  const files = {
    ...table("  { path: 'a', loadChildren: () => import('./a.routes') },"),
    "src/app/a.routes.ts": lazy("b", "to-b"),
    "src/app/b.routes.ts": lazy("a", "to-a"),
  };

  const findings = await extract(files);

  assert.deepEqual(names(findings), ["/a/to-b", "/a/to-b/to-a"]);
  assert.deepEqual(unknowns(findings), ["unresolved@src/app/b.routes.ts:3"]);
});

test("two tables that load each other stop at the entry that closes the cycle", async () => {
  const lazy = (to: string, path: string): string => `${HEADER}export const routes: Routes = [\n  { path: '${path}', component: P, loadChildren: () => import('./${to}.routes') },\n];\n`;
  const files = {
    ...table("  { path: 'root', component: R, loadChildren: () => import('./a.routes') },"),
    "src/app/a.routes.ts": lazy("b", "to-b"),
    "src/app/b.routes.ts": lazy("a", "to-a"),
  };

  const findings = await extract(files);

  assert.deepEqual(names(findings), ["/root/to-b", "/root", "/root/to-b/to-a"]);
  assert.deepEqual(unknowns(findings), ["unresolved@src/app/b.routes.ts:3"]);
});

test("a table that names itself as its children is a cycle, not an endless tree", async () => {
  const findings = await extract(table("  { path: 'loop', component: Loop, children: routes },"));

  assert.deepEqual(names(findings), ["/loop"]);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:3`]);
});

test("tables nest without a depth bound: ten levels of children and a lazy table below them are all followed", async () => {
  const levels = 10;
  const open = Array.from({ length: levels }, (_, level) => `{ path: 'l${level}', component: C, children: [`).join("\n");
  const body = `${open}\n{ path: 'leaf', loadChildren: () => import('./leaf.routes') }\n${"]}".repeat(levels)}`;
  const files = { ...table(body), "src/app/leaf.routes.ts": `${HEADER}export default [{ path: 'end', component: End }] as Routes;\n` };

  const found = names(await extract(files));

  const prefix = Array.from({ length: levels }, (_, level) => `l${level}`);
  assert.equal(found.at(-1), `/${[...prefix, "leaf", "end"].join("/")}`);
  assert.equal(found.length, levels + 1);
});

test("an export is followed through any number of re-exports: a chain of fifteen barrels", async () => {
  const chain = 15;
  const barrels = Object.fromEntries(Array.from({ length: chain }, (_, index) => [`src/app/b${index}.ts`, `export * from './b${index + 1}';\n`]));
  const files = {
    ...table("  { path: Paths.Home, component: Home },", "import { Paths } from './b0';"),
    ...barrels,
    [`src/app/b${chain}.ts`]: "export const Paths = { Home: 'home' } as const;\n",
  };

  assert.deepEqual(names(await extract(files)), ["/home"]);
});

test("barrels that re-export each other, with the name nowhere, end in an unresolved item rather than a loop", async () => {
  const files = {
    ...table("  { path: Paths.Home, component: Home },", "import { Paths } from './x';"),
    "src/app/x.ts": "export * from './y';\n",
    "src/app/y.ts": "export * from './x';\n",
  };

  assert.deepEqual(unknowns(await extract(files)), [`unresolved@${ROUTES}:4`]);
});

test("an entry written with shorthand properties is read like any other", async () => {
  const header = "const path = 'dash';\nconst component = Dashboard;";
  const files = table("  { path, component },", header);

  const [route] = uiRoutes(await extract(files));

  assert.equal(route?.name, "/dash");
});

test("every module specifier resolves through the nearest configuration, its extends chain, a rename and a barrel", async () => {
  const GUARD_AT = "src/app/core/guards/native-only.guard.ts";
  const header = "import { RoutePath as Paths } from '@app/models';\nimport { nativeOnlyGuard as native } from '@app/guards';\n";
  const body = "  { path: Paths.Upload, canMatch: [native], loadChildren: () => import('@app/upload').then((m) => m.UPLOAD_ROUTES) },";
  const files = {
    ...table(body, header),
    "tsconfig.base.json": '{\n  // comments are allowed\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/core/*", "src/app/features/*"] } }\n}',
    "tsconfig.json": '{ "extends": "./tsconfig.base.json" }',
    "src/app/core/models/index.ts": "export * from './routes.model';\n",
    "src/app/core/models/routes.model.ts": "export enum RoutePath {\n  Upload = 'upload-menu',\n}\n",
    "src/app/core/guards/index.ts": "export { nativeOnlyGuard } from './native-only.guard';\n",
    [GUARD_AT]: "export const nativeOnlyGuard = () => true;\n",
    "src/app/features/upload/index.ts": "export { UPLOAD_ROUTES } from './upload.routes';\n",
    "src/app/features/upload/upload.routes.ts": `${HEADER}export const UPLOAD_ROUTES: Routes = [\n  { path: 'preview', component: PreviewPage },\n];\n`,
  };

  const [route] = uiRoutes(await extract(files));

  assert.equal(route?.name, "/upload-menu/preview");
  assert.equal(route?.path, "/upload-menu/preview");
});

test("a specifier no configuration resolves leaves the path of its entry unresolved", async () => {
  const header = "import { RoutePath as Paths } from '@app/models';";
  const files = {
    ...table("  { path: Paths.Upload, component: Upload },", header),
    "tsconfig.json": '{ "compilerOptions": { "baseUrl": "." } }',
    "src/app/core/models/index.ts": "export enum RoutePath {\n  Upload = 'upload-menu',\n}\n",
  };

  const findings = await extract(files);

  assert.deepEqual(names(findings), []);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:4`]);
});

test("a lazy section loaded through a binding is the table of the binding's one static dynamic import", async () => {
  const lazy = { "src/app/login/login.routes.ts": `${HEADER}export const LOGIN_ROUTES: Routes = [\n  { path: 'step', component: Step },\n];\n` };
  const bound = (binding: string, loadChildren: string): Record<string, string> => ({ ...lazy, ...table(`  { path: 'login', ${loadChildren} },`, binding) });
  const wire = "const feature = wire(() => import('./login/login.routes'), { name: 'login' });";

  assert.deepEqual(names(await extract(bound(wire, "loadChildren: feature.loadChildren"))), ["/login/step"]);
  assert.deepEqual(names(await extract(bound(wire, "loadChildren: feature"))), ["/login/step"]);
  for (const binding of ["const feature = wire(() => import('./login/login.routes'), () => import('./login/login.routes'));", "const feature = wire(() => import(somewhere));", "const feature = somewhere;"]) {
    const findings = await extract(bound(binding, "loadChildren: feature.loadChildren"));
    assert.equal(unknowns(findings).some((item) => item === `unresolved@${ROUTES}:4`), true, binding);
    assert.deepEqual(names(findings), [], binding);
  }
});

test("a declaration file, a test and a file that does not parse are told apart: only the last one is an unknown item", async () => {
  const body = "  { path: 'hidden', component: Hidden },";
  const files = {
    ...table("  { path: 'seen', component: Seen },"),
    "src/app/hidden.spec.ts": table(body)[ROUTES]!,
    "src/app/hidden.d.ts": table(body)[ROUTES]!,
    "src/app/__tests__/hidden.ts": table(body)[ROUTES]!,
    "src/app/broken.ts": "export const routes = [ {\n",
  };

  const findings = await extract(files);

  assert.deepEqual(names(findings), ["/seen"]);
  assert.deepEqual(unknowns(findings), ["source-unreadable@src/app/broken.ts:1"]);
});

test("findings come out sorted by evidence location whatever the order of the sources, and identical on two runs", async () => {
  const files = {
    "src/z.routes.ts": table("  { path: 'z', component: Z },")[ROUTES]!,
    "src/a.routes.ts": table("  { path: 'b', component: B },\n  { path: 'a', component: A },")[ROUTES]!,
    "src/m.routes.ts": table("  { path: 'm', component: M, matcher: m },")[ROUTES]!,
  };
  const forward = sources(files, PACKAGE, false);
  const extractor = createAngularRoutesExtractor();

  const first = await extractor.extract(forward);
  const second = await extractor.extract(forward.toReversed());

  assert.deepEqual(first.map((finding) => `${finding.evidence[0]?.path}:${finding.evidence[0]?.line}`), ["src/a.routes.ts:3", "src/a.routes.ts:4", "src/m.routes.ts:3", "src/z.routes.ts:3"]);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("a table that two parents load is named under each of them", async () => {
  const shared = { "src/app/shared.routes.ts": `${HEADER}export const SHARED: Routes = [{ path: 'x', component: X }];\n` };
  const body = ["  { path: 'one', loadChildren: () => import('./shared.routes').then((m) => m.SHARED) },", "  { path: 'two', loadChildren: () => import('./shared.routes').then((m) => m.SHARED) },"].join("\n");

  assert.deepEqual(names(await extract({ ...table(body), ...shared })), ["/one/x", "/two/x"]);
});

const MAIN_WITH = (call: string): string => `import { provideRouter, RouterModule } from '@angular/router';\nimport { importProvidersFrom } from '@angular/core';\nimport { routes } from './app/app.routes';\nbootstrap(App, { providers: [${call}] });\n`;
const ORPHAN = { "src/app/orphan.routes.ts": `${HEADER}export const ORPHAN: Routes = [\n  { path: 'step', component: Step },\n];\n` };

test("a table handed to provideRouter, RouterModule.forRoot or importProvidersFrom is a root, named in full even when a child reference elsewhere is unresolved", async () => {
  const body = ["  { path: 'home', component: Home },", "  { path: 'gone', loadChildren: () => import('./missing.routes') },"].join("\n");
  for (const call of ["provideRouter(routes, withComponentInputBinding())", "importProvidersFrom(RouterModule.forRoot(routes))", "importProvidersFrom(RouterModule.forRoot(routes, { useHash: true }))"]) {
    const findings = await extract({ ...table(body), "src/main.ts": MAIN_WITH(call) });

    assert.deepEqual(names(findings), ["/home"], call);
    assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:4`], call);
  }
});

test("once a root is declared, each would-be route of a table no root reaches is an unknown item: no-extractor when every reference resolves, unresolved while one does not", async () => {
  const resolved = table("  { path: 'home', component: Home },");
  const broken = table(["  { path: 'home', component: Home },", "  { path: 'gone', loadChildren: () => import('./missing.routes') },"].join("\n"));

  const quiet = await extract({ ...resolved, ...ORPHAN, "src/main.ts": MAIN_WITH("provideRouter(routes)") });
  const loud = await extract({ ...broken, ...ORPHAN, "src/main.ts": MAIN_WITH("provideRouter(routes)") });

  const reasonsAt = (findings: readonly Finding<Entrypoint>[]): string[] =>
    findings.filter((finding) => finding.evidence[0]?.path === "src/app/orphan.routes.ts").map((finding) => (finding.status === "unknown" ? `${finding.reason}:${finding.evidence.length}` : "complete"));
  assert.deepEqual(names(quiet), ["/home"]);
  assert.deepEqual(reasonsAt(quiet), ["no-extractor:1"]);
  assert.deepEqual(names(loud), ["/home"]);
  assert.deepEqual(reasonsAt(loud), ["unresolved:2"]);
});

test("a table passed inline to provideRouter is a root, and a function named provideRouter that is not the router's is not", async () => {
  const main = "import { provideRouter } from '@angular/router';\nbootstrap(App, { providers: [provideRouter([{ path: 'inline', component: I }])] });\n";
  const local = "function provideRouter(x) { return x; }\nprovideRouter(table);\n";

  assert.deepEqual(names(await extract({ "src/main.ts": main })), ["/inline"]);
  const withLocal = await extract({ ...table("  { path: 'a', loadChildren: () => import('./missing.routes') },"), "src/local.ts": local });
  assert.deepEqual(unknowns(withLocal), [`unresolved@${ROUTES}:3`]);
});

test("a module loaded lazily gets its routes from the RouterModule.forChild in its decorator, and a forChild table nobody loads is not an entrypoint", async () => {
  const body = ["  { path: 'admin', loadChildren: () => import('./admin/admin.module').then((m) => m.AdminModule) },", "  { path: 'inline', loadChildren: () => import('./inline.module').then((m) => m.InlineModule) },", "  { path: 'dflt', loadChildren: () => import('./dflt.module') },"].join("\n");
  const files = {
    ...table(body),
    "src/app/app.module.ts": "import { NgModule } from '@angular/core';\nimport { RouterModule } from '@angular/router';\nimport { routes } from './app.routes';\n@NgModule({ imports: [RouterModule.forRoot(routes)] })\nexport class AppModule {}\n",
    "src/app/admin/admin.module.ts": "import { NgModule } from '@angular/core';\nimport { RouterModule } from '@angular/router';\nimport { ADMIN_ROUTES } from './admin.routes';\n@NgModule({ imports: [RouterModule.forChild(ADMIN_ROUTES)] })\nexport class AdminModule {}\n",
    "src/app/admin/admin.routes.ts": `${HEADER}export const ADMIN_ROUTES: Routes = [\n  { path: 'users', component: Users },\n];\n`,
    "src/app/inline.module.ts": "import { NgModule } from '@angular/core';\nimport { RouterModule } from '@angular/router';\n@NgModule({ imports: [RouterModule.forChild([{ path: 'item', component: Item }])] })\nexport class InlineModule {}\n",
    "src/app/dflt.module.ts": "import { NgModule } from '@angular/core';\nimport { RouterModule } from '@angular/router';\n@NgModule({ imports: [RouterModule.forChild([{ path: 'd', component: D }])] })\nexport default class DefaultModule {}\n",
    "src/app/unloaded.module.ts": "import { NgModule } from '@angular/core';\nimport { RouterModule } from '@angular/router';\n@NgModule({ imports: [RouterModule.forChild([{ path: 'nobody', component: N }])] })\nexport class UnloadedModule {}\n",
  };

  assert.deepEqual(names(await extract(files)), ["/admin/users", "/dflt/d", "/inline/item"]);
});

test("a module graph composing two forChild tables names both, and a graph with no forChild table at all is unknown (no-extractor) at the reference", async () => {
  const body = ["  { path: 'two', loadChildren: () => import('./two.module').then((m) => m.TwoModule) },", "  { path: 'none', loadChildren: () => import('./none.module').then((m) => m.NoneModule) },"].join("\n");
  const files = {
    ...table(body),
    "src/main.ts": MAIN_WITH("provideRouter(routes)"),
    "src/app/two.module.ts": "import { NgModule } from '@angular/core';\nimport { RouterModule } from '@angular/router';\n@NgModule({ imports: [RouterModule.forChild([{ path: 'a', component: A }]), RouterModule.forChild([{ path: 'b', component: B }])] })\nexport class TwoModule {}\n",
    "src/app/none.module.ts": "import { NgModule } from '@angular/core';\n@NgModule({})\nexport class NoneModule {}\n",
  };

  const findings = await extract(files);

  assert.deepEqual(names(findings), ["/two/a", "/two/b"]);
  assert.deepEqual(unknowns(findings), [`no-extractor@${ROUTES}:4`]);
});

test("an @angular/core that resolves inside the snapshot is not the framework: a module graph is not read, and its lazy section is unknown, never silent", async () => {
  const files = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@angular/core": ["src/vendor/angular-core.ts"] } } }),
    "src/vendor/angular-core.ts": "export const NgModule: ClassDecorator = () => {};\n",
    ...table("  { path: 'owners', loadChildren: () => import('./owners/owners.module').then((m) => m.OwnersModule) },"),
    "src/app/owners/owners.module.ts": "import { NgModule } from '@angular/core';\nimport { OwnersRoutingModule } from './owners-routing.module';\n@NgModule({ imports: [OwnersRoutingModule] })\nexport class OwnersModule {}\n",
    "src/app/owners/owners-routing.module.ts": "import { NgModule } from '@angular/core';\nimport { RouterModule } from '@angular/router';\n@NgModule({ imports: [RouterModule.forChild([{ path: 'list', component: OwnerList }])] })\nexport class OwnersRoutingModule {}\n",
  };

  const findings = await extract(files);

  assert.deepEqual(names(findings), []);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:3`, "unresolved@src/app/owners/owners-routing.module.ts:3"]);
});

test("a router configuration whose table cannot be followed is an unknown item at the call", async () => {
  const main = "import { provideRouter } from '@angular/router';\nbootstrap(App, { providers: [provideRouter(build(flag))] });\n";

  const findings = await extract({ "src/main.ts": main, ...table("  { path: 'a', component: A },") });

  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:3`, "no-extractor@src/main.ts:2"]);
  assert.deepEqual(names(findings), []);
});

test("a spread of a named array puts its entries at the spread's position under the same parent, in the file that declares each", async () => {
  const header = "import { ADMIN_ROUTES } from './admin.routes';";
  const body = ["  { path: 'top', component: Top },", "  { path: 'g', children: [...ADMIN_ROUTES, ...LOCAL, { path: 'own', component: Own }] },"].join("\n");
  const files = {
    ...table(body, `${header}\nconst LOCAL: Routes = [{ path: 'local', component: Local }];`),
    "src/app/admin.routes.ts": `${HEADER}export const ADMIN_ROUTES: Routes = [\n  { path: 'users', component: Users },\n];\n`,
  };

  const findings = await extract(files);

  assert.deepEqual(names(findings).sort(), ["/g/local", "/g/own", "/g/users", "/top"]);
  assert.equal(findings.find((finding) => finding.status === "complete" && finding.value.name === "/g/users")?.evidence[0]?.path, "src/app/admin.routes.ts");
});

test("a spread that cannot be followed is an unknown item at the spread: its reason says whether it was a call with arguments, and a spread of the table itself is a cycle", async () => {
  const body = ["  { path: 'a', component: A },", "  ...MISSING,", "  ...compute(1),", "  ...routes,", "  ...[{ path: 'lit', component: L }],"].join("\n");

  const findings = await extract({ ...table(body, "import { MISSING } from './missing';"), "src/main.ts": MAIN_WITH("provideRouter(routes)") });

  assert.deepEqual(names(findings), ["/a", "/lit"]);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:5`, `no-extractor@${ROUTES}:6`, `unresolved@${ROUTES}:7`]);
});

test("a named array, local or imported, is the children of an entry", async () => {
  const body = ["  { path: 'a', children: LOCAL },", "  { path: 'b', children: IMPORTED },"].join("\n");
  const files = { ...table(body, "import { IMPORTED } from './imported';\nconst LOCAL: Routes = [{ path: 'x', component: X }];"), "src/app/imported.ts": `${HEADER}export const IMPORTED: Routes = [{ path: 'y', component: Y }];\n` };

  assert.deepEqual(names(await extract(files)), ["/a/x", "/b/y"]);
});

test("a table is a route array whatever type it is annotated with: an alias of Route[], an interface derived from Route, or none", async () => {
  const header = "type AppRoutes = Route[];\ninterface ScreenRoute extends Omit<Route, 'children'> { label: string }";
  const table = `${HEADER}${header}\nexport const a: AppRoutes = [{ path: 'a', component: A }];\nexport const b: ScreenRoute[] = [{ path: 'b', component: B, label: 'B' }];\nexport const c = [{ path: 'c', component: C }] satisfies Route[];\n`;

  for (const name of ["a", "b", "c"]) {
    const main = `import { provideRouter } from '@angular/router';\nimport { ${name} } from './app/app.routes';\nprovideRouter(${name});\n`;
    assert.deepEqual(names(await extract({ [ROUTES]: table, "src/main.ts": main })), [`/${name}`]);
  }
});

test("a helper that returns a route array literal is the table of a call without arguments; with arguments it is unknown with no-extractor", async () => {
  const header = "function buildRoutes(): Routes { return [{ path: 'fn', component: F }]; }\nconst arrowRoutes = (): Routes => [{ path: 'arrow', component: R }];";
  const body = ["  { path: 'a', children: buildRoutes() },", "  { path: 'b', children: arrowRoutes() },", "  { path: 'c', children: buildRoutes(true) },", "  ...buildRoutes(),"].join("\n");

  const findings = await extract({ ...table(body, header), "src/main.ts": MAIN_WITH("provideRouter(routes)") });

  assert.deepEqual(names(findings).sort(), ["/a/fn", "/b/arrow", "/fn"]);
  assert.deepEqual(unknowns(findings), [`no-extractor@${ROUTES}:7`]);
});

test("a helper table is what provideRouter receives when it is called without arguments", async () => {
  const files = { "src/app/app.routes.ts": "export function appRoutes(): Routes { return [{ path: 'h', component: H }]; }\n", "src/main.ts": "import { provideRouter } from '@angular/router';\nimport { appRoutes } from './app/app.routes';\nprovideRouter(appRoutes());\n" };

  assert.deepEqual(names(await extract(files)), ["/h"]);
});

test("a path built from a template literal, an enum member or a constant is text when every part is; otherwise it is unresolved", async () => {
  const header = [
    "import { Base } from './base';",
    "const SUFFIX = 'list';",
    "const ALIAS = Base.Shop;",
    "enum Area { Cart = 'cart' }",
  ].join("\n");
  const body = [
    "  { path: `${Base.Shop}/${SUFFIX}`, component: A },",
    "  { path: Area.Cart, component: B },",
    "  { path: ALIAS, component: C },",
    "  { path: `plain`, component: D },",
    "  { path: `${Base.Shop}/${nope}`, component: E },",
    "  { path: `${count}`, component: F },",
    "  { path: Area.Missing, component: G },",
  ].join("\n");
  const files = { ...table(body, header), "src/app/base.ts": "export const Base = { Shop: `shop-${'x'}` } as const;\n" };

  const findings = await extract(files);

  assert.deepEqual(names(findings), ["/shop-x/list", "/cart", "/shop-x", "/plain"]);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:11`, `unresolved@${ROUTES}:12`, `unresolved@${ROUTES}:13`]);
});

test("constants that refer to each other in a loop are unresolved, not endless", async () => {
  const header = "const A = B;\nconst B = A;";

  assert.deepEqual(unknowns(await extract(table("  { path: A, component: X },", header))), [`unresolved@${ROUTES}:5`]);
});

const ROOT_MAIN = MAIN_WITH("provideRouter(routes)");

test("an identifier among the elements of a table is the route object constant it names, local or imported, placed at that constant", async () => {
  const header = "import { about } from './about';\nconst home: Route = { path: 'home', component: Home };";
  const body = ["  home,", "  about,", "  { path: 'c', children: [home, { path: 'd', component: D }] },"].join("\n");
  const files = { ...table(body, header), "src/main.ts": ROOT_MAIN, "src/app/about.ts": `${HEADER}export const about: Route = { path: 'about', component: About };\n` };

  const findings = await extract(files);

  assert.deepEqual(names(findings).sort(), ["/about", "/c/d", "/c/home", "/home"]);
  assert.equal(findings.find((finding) => finding.status === "complete" && finding.value.name === "/about")?.evidence[0]?.path, "src/app/about.ts");
});

test("a table of only identifiers is read when it is typed as routes, and is an unknown item at the router call when it is not", async () => {
  const typed = "const home = { path: 'home', component: Home };\nconst about = { path: 'about', component: About };\nexport const routes: Routes = [home, about];\n";
  const untyped = typed.replace(": Routes", "");

  assert.deepEqual(names(await extract({ "src/app/r.ts": typed, "src/main.ts": "import { provideRouter } from '@angular/router';\nimport { routes } from './app/r';\nprovideRouter(routes);\n" })).sort(), ["/about", "/home"]);
  const loud = await extract({ "src/app/r.ts": untyped, "src/main.ts": "import { provideRouter } from '@angular/router';\nimport { routes } from './app/r';\nprovideRouter(routes);\n" });
  assert.deepEqual(names(loud), []);
  assert.deepEqual(unknowns(loud), ["unresolved@src/main.ts:3"]);
});

test("an element that cannot be read as one route is an unknown item at the element: unresolved for a name that does not resolve, no-extractor for the rest", async () => {
  const body = [
    "  { path: 'ok', component: Ok },",
    "  missing,",
    "  make(),",
    "  flag ? { path: 'x', component: X } : { path: 'y', component: Y },",
    "  { path: 'm5', ...base },",
    "  { ...base, path: 'm7' },",
  ].join("\n");

  const findings = await extract({ ...table(body), "src/main.ts": ROOT_MAIN });

  assert.deepEqual(names(findings), ["/ok"]);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:4`, `no-extractor@${ROUTES}:5`, `no-extractor@${ROUTES}:6`, `no-extractor@${ROUTES}:7`, `no-extractor@${ROUTES}:8`]);
});

test("a table in a conditional expression is not served unconditionally: its would-be routes are unknown with no-extractor", async () => {
  const file = `${HEADER}export const routes: Routes = env.prod\n  ? [{ path: 'a', component: A }]\n  : [{ path: 'b', component: B }];\n`;

  const findings = await extract({ [ROUTES]: file, "src/main.ts": ROOT_MAIN });

  assert.deepEqual(names(findings), []);
  assert.deepEqual(unknowns(findings), [`no-extractor@${ROUTES}:3`, `no-extractor@${ROUTES}:4`]);
});

test("a named outlet applies to the whole subtree of its entry; a child that names a different outlet is unknown with no-extractor, and an outlet that is not text names no descendant", async () => {
  const body = [
    "  { path: 'side', outlet: 'aux', component: Side, children: [",
    "    { path: 'b', component: B },",
    "    { path: 'c', outlet: 'aux', component: C },",
    "    { path: 'd', outlet: 'other', component: D },",
    "  ] },",
    "  { path: 'q', outlet: pick(), children: [{ path: 'z', component: Z }] },",
  ].join("\n");

  const findings = await extract(table(body));

  assert.deepEqual(names(findings), ["/side (aux)", "/side/b (aux)", "/side/c (aux)"]);
  assert.deepEqual(uiRoutes(findings).map((route) => route.outlet), ["aux", "aux", "aux"]);
  assert.deepEqual(unknowns(findings), [`no-extractor@${ROUTES}:6`, `unresolved@${ROUTES}:8`]);
});

test("canActivateChild is not an own guard of the entry or its descendants", async () => {
  const body = [
    "  { path: 'x', component: A, canActivateChild: [child], canLoad: [load], children: [",
    "    { path: 'y', component: A },",
    "  ] },",
  ].join("\n");

  const routes = uiRoutes(await extract(table(body)));

  assert.deepEqual(routes.map((route) => [route.name, route.guards.map((guard) => guard.name)]), [["/x", ["load"]], ["/x/y", []]]);
});

test("a guard list given as a name or with spreads resolves to the guards it holds; one that cannot be read makes the route unknown at the list, and so every route beneath", async () => {
  const header = ["import { shared } from './guards';", "const g1 = () => true;", "const g2 = () => true;", "const g3 = () => true;", "const local = [g1, g2];"].join("\n");
  const body = [
    "  { path: 'a', canActivate: local, component: A },",
    "  { path: 'b', canActivate: [...shared, g3], component: B },",
    "  {",
    "    path: 'c',",
    "    canActivate: unknownList,",
    "    component: C,",
    "  },",
    "  { path: 'e', canActivate: [() => true], component: E },",
    "  { path: 'd', canActivate: [...unknownSpread], component: D },",
    "  { path: 'f', canMatch: [flag ? g1 : g2], component: F },",
    "  { path: 'p', canActivateChild: nope, children: [{ path: 'q', component: Q }] },",
  ].join("\n");
  const files = { ...table(body, header), "src/app/guards.ts": "export const s1 = () => true;\nexport const s2 = () => true;\nexport const shared = [s1, s2];\n" };

  const findings = await extract(files);

  const guards = (name: string): unknown => uiRoutes(findings).find((route) => route.name === name)?.guards;
  assert.deepEqual(guards("/a"), [{ name: "g1", path: ROUTES }, { name: "g2", path: ROUTES }]);
  assert.deepEqual(guards("/b"), [{ name: "s1", path: "src/app/guards.ts" }, { name: "s2", path: "src/app/guards.ts" }, { name: "g3", path: ROUTES }]);
  assert.deepEqual(guards("/e"), [{ name: "(inline)" }]);
  assert.deepEqual(names(findings), ["/a", "/b", "/e"]);
  assert.deepEqual(unknowns(findings), [`unresolved@${ROUTES}:12`, `unresolved@${ROUTES}:16`, `unresolved@${ROUTES}:17`, `unresolved@${ROUTES}:18`]);
  const c = findings.find((finding) => finding.status === "unknown" && finding.evidence[0]?.line === 12);
  assert.deepEqual(c?.evidence.map((span) => span.line), [12, 10]);
});

const APP_ROUTES = (component: string): string => `import { Routes } from '@angular/router';\nimport { Home } from './${component}';\nexport const routes: Routes = [{ path: 'home', component: Home }];\n`;
const HOME = "export class Home {}\n";
const handlerPath = (route: UiRoute): string => (route.component === "unknown" ? route.component : route.component.path);

test("an app under a subfolder has its routes read, with repository-relative paths", async () => {
  const findings = await createAngularRoutesExtractor().extract([
    { path: "frontend/package.json", content: PACKAGE },
    { path: "frontend/src/app/app.routes.ts", content: APP_ROUTES("home") },
    { path: "frontend/src/app/home.ts", content: HOME },
    { path: "frontend/src/main.ts", content: "import { provideRouter } from '@angular/router';\nimport { routes } from './app/app.routes';\nprovideRouter(routes);\n" },
  ]);
  assert.deepEqual(names(findings), ["/home"]);
  const [route] = uiRoutes(findings);
  assert.deepEqual(route && handlerPath(route), "frontend/src/app/home.ts");
});

test("the component a route renders carries the span of its declaration", async () => {
  const findings = await extract({
    ...table("  { path: 'home', component: Home },", "import { Home } from './home';"),
    "src/app/home.ts": "export class Home {\n  title = 'home';\n}\n",
  });
  const [route] = uiRoutes(findings);
  assert.deepEqual(route?.component, { path: "src/app/home.ts", symbol: "Home", line: 1, endLine: 3 });
});

test("two apps in one repository declaring the same route stay two routes, told apart by handler", async () => {
  const findings = await createAngularRoutesExtractor().extract([
    { path: "web/package.json", content: PACKAGE },
    { path: "web/src/app.routes.ts", content: APP_ROUTES("home") },
    { path: "web/src/home.ts", content: HOME },
    { path: "web/src/main.ts", content: "import { provideRouter } from '@angular/router';\nimport { routes } from './app.routes';\nprovideRouter(routes);\n" },
    { path: "admin/package.json", content: PACKAGE },
    { path: "admin/src/app.routes.ts", content: APP_ROUTES("home") },
    { path: "admin/src/home.ts", content: HOME },
    { path: "admin/src/main.ts", content: "import { provideRouter } from '@angular/router';\nimport { routes } from './app.routes';\nprovideRouter(routes);\n" },
  ]);
  assert.deepEqual(uiRoutes(findings).map((route) => [route.name, handlerPath(route)]), [["/home", "admin/src/home.ts"], ["/home", "web/src/home.ts"]]);
});

test("a source in a project that does not name the router has no route", async () => {
  const findings = await createAngularRoutesExtractor().extract([
    { path: "frontend/package.json", content: JSON.stringify({ dependencies: { "@angular/core": "21.0.0" } }) },
    { path: "frontend/src/app.routes.ts", content: APP_ROUTES("home") },
    { path: "frontend/src/home.ts", content: HOME },
  ]);
  assert.deepEqual(findings, []);
});

test("each nested route records only its own guards when components and guards are reused", async () => {
  const body = [
    "  { path: 'group', component: Page, canActivate: [guard], children: [",
    "    { path: '', component: Page, canActivate: [guard] },",
    "    { path: ':id', component: Page, children: [{ path: 'detail', component: Page }] },",
    "  ] },",
  ].join("\n");
  const routes = uiRoutes(await extract(table(body, "const guard = () => true;")));
  assert.deepEqual(routes.map((route) => [route.name, route.guards.map((guard) => guard.name)]), [
    ["/group", ["guard"]], ["/group", ["guard"]], ["/group/:id", []], ["/group/:id/detail", []],
  ]);
});
