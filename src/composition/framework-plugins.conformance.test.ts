import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntrypointExtraction } from "../core/ports/entrypoint-extractor.port.ts";
import { composeFrameworkPlugins, frameworkEntrypoints } from "./framework-plugins.ts";
import { createConsumerReaders } from "../core/adapters/typescript/consumer-readers.ts";
import { buildProgram } from "../core/adapters/typescript/consumer-flow.index.ts";
import { createRequestCallLookup } from "../core/adapters/typescript/http-call-sites.adapter.ts";
import { createHttpCallSites } from "../core/adapters/typescript/http-call-sites.adapter.ts";
import { providerValueFiles } from "../core/adapters/typescript/provider-values.testing.ts";

test("core-only projects read Angular inputs but cannot claim router continuations", async () => {
  const files = [{ path: "package.json", content: '{"dependencies":{"@angular/core":"1"}}' }, { path: "a.ts", content: "import { input } from '@angular/core'; import { provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser'; export function load() {} class Page { order = input(); } const routes = [{ path: '', component: Page, resolve: { order: load } }]; bootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });" }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  assert.equal(readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "order" }, path: [] }).next.length, 1);
  assert.equal(readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 1 }, path: [] }).next.length, 0);
});

test("a router from another project cannot claim a resolver", async () => {
  const files = [
    { path: "app/package.json", content: '{"dependencies":{"@angular/core":"1","@angular/router":"1"}}' },
    { path: "other/package.json", content: '{"dependencies":{}}' },
    { path: "other/resolver.ts", content: "export function load() {}" },
    { path: "app/main.ts", content: "import { input } from '@angular/core'; import { provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser'; import { load } from '../other/resolver'; class Page { order = input(); } const routes = [{ path: '', component: Page, resolve: { order: load } }]; bootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });" },
  ];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "other/resolver.ts", symbol: "load", line: 1 }, path: [] });
  assert.equal(result.next.length, 0);
  assert.equal(result.frontiers.length, 0);
});

test("an opaque route in a different project does not add a frontier to a proven resolver", async () => {
  const files = [
    { path: "one/package.json", content: '{"dependencies":{"@angular/core":"1","@angular/router":"1"}}' },
    { path: "two/package.json", content: '{"dependencies":{"@angular/router":"1"}}' },
    { path: "one/app.ts", content: "import { input } from '@angular/core'; import { provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser'; export function load() {} class Page { order = input(); } const routes = [{ path: '', component: Page, resolve: { order: load } }]; bootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });" },
    { path: "two/app.ts", content: "import { provideRouter } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser'; class App {} const routes = [{ path: '', loadChildren: unknownLoader }]; bootstrapApplication(App, { providers: [provideRouter(routes)] });" },
  ];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "one/app.ts", symbol: "load", line: 1 }, path: [] });
  assert.equal(result.next.length, 1);
  assert.equal(result.frontiers.length, 0);
});

test("input option objects resolve const aliases and reject opaque options without falling back to the member name", async () => {
  const files = [{ path: "a.ts", content: "import { Input, input, model } from '@angular/core';\nconst options = { alias: 'publicName' }; const signalOptions = { alias: 'signalName' };\nclass Known { @Input(options) named: any; signal = input(undefined, signalOptions); }\nclass Page { @Input(dynamic) uncertain: any; @Input({ ...dynamic }) spread: any; value = input(undefined, dynamic); required = model.required(dynamic); }" }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const follow = (name: string, owner = "Page") => readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner, name }, path: [] });
  assert.equal(follow("publicName", "Known").next.length, 1);
  assert.equal(follow("signalName", "Known").next.length, 1);
  for (const name of ["named", "uncertain", "spread", "value", "required"]) {
    const result = follow(name);
    assert.equal(result.next.length, 0, name);
    assert.equal(result.frontiers[0]?.reason, "unresolved", name);
  }
});

test("an unreadable input alias prevents claiming a complete destination for another name", async () => {
  const files = [{ path: "a.ts", content: "import { Input } from '@angular/core'; class Page { @Input('known') first: any; @Input(dynamic) second: any; }" }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "known" }, path: [] });
  assert.equal(result.next.length, 0);
  assert.equal(result.frontiers[0]?.reason, "unresolved");
});

test("input declarations sharing a proven public name remain separate destinations", async () => {
  const files = [{ path: "a.ts", content: "import { Input } from '@angular/core'; class Page { @Input('shared') first: any; @Input('shared') second: any; }" }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "shared" }, path: [] });
  assert.deepEqual(result.next.map(({ carrier }) => carrier.site.kind === "member" ? carrier.site.member : "").sort(), ["first", "second"]);
});

test("the registered Angular contribution and origins share one program in a reading", async () => {
  let builds = 0;
  const files = [{ path: "a.ts", content: "import { input } from '@angular/core';\nclass Page { value = input(); }\nfunction send() { fetch('/x', { method: 'POST', body: JSON.stringify({ id: 1 }) }); }" }];
  const readers = await createConsumerReaders(files, "repo", { buildProgram: (sources) => { builds++; return buildProgram(sources); }, createRequestCallLookup }, composeFrameworkPlugins());
  readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "value" }, path: [] });
  await readers.origins.ofBody({ file: "a.ts", line: 3, symbol: "send" }, ["id"]);
  assert.equal(builds, 1);
});

test("registered Angular inputs recognize namespace aliases and reject foreign imports", async () => {
  const files = [{ path: "a.ts", content: "import * as ng from '@angular/core';\nimport { input as foreign } from 'other';\nclass Page { value = ng.input.required({ alias: 'publicValue' }); other = foreign(); }" }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const follow = (name: string) => readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name }, path: [] });
  assert.equal(follow("publicValue").next[0]?.carrier.site.kind, "member");
  assert.equal(follow("other").next.length, 0);
});

test("input default values do not rename an input and dynamic aliases stay unresolved", async () => {
  const files = [{ path: "a.ts", content: "import { input } from '@angular/core';\nclass Known { first = input('default'); } class Page { second = input(0, { alias: dynamic }); }" }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const follow = (name: string, owner = "Page") => readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner, name }, path: [] });
  assert.equal(follow("first", "Known").next.length, 1);
  assert.equal(follow("second").next.length, 0);
  assert.equal(follow("second").frontiers[0]?.reason, "unresolved");
});

test("Angular input names only apply in their declared syntax positions", async () => {
  const files = [{ path: "a.ts", content: "import { Input, input } from '@angular/core';\nclass Page { @input() wrong: any; @Input.required() invalid: any; other = Input(); }" }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  for (const name of ["wrong", "invalid", "other"]) {
    const result = readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name }, path: [] });
    assert.equal(result.next.length, 0);
  }
});

test("Angular inputs preserve decorator, signal, model and required aliases", async () => {
  const files = [{ path: "a.ts", content: "import { Input, input, model } from '@angular/core';\nclass Page { @Input() plain: any; @Input('alias') field: any; @Input({alias: 'obj'}) object: any; sig = input(); req = input.required({alias:'required'}); both = model(undefined, {alias:'modelled'}); }" }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  for (const [name, member] of Object.entries({ plain: "plain", alias: "field", obj: "object", sig: "sig", required: "req", modelled: "both" })) {
    const result = readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name }, path: ["id"] });
    const next = result.next[0];
    assert.equal(next?.carrier.site.kind === "member" && next.carrier.site.member, member);
    assert.equal(next?.hops[0]?.step, "input");
  }
  for (const name of ["field", "missing"]) {
    const result = readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name }, path: ["id"] });
    assert.equal(result.next.length, 0);
    assert.equal(result.frontiers[0]?.reason, "unresolved");
  }
});

test("a registered root resolver continues to its component input", async () => {
  const files = [{ path: "a.ts", content: [
    "import { input } from '@angular/core';",
    "import { provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser';",
    "export function resolveOrder() { return {}; } export function unused() { return {}; }",
    "class Page { order = input(); }",
    "const routes = [{ path: '', component: Page, resolve: { order: resolveOrder } }];",
    "bootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });",
  ].join("\n") }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "resolveOrder", line: 3 }, path: ["id"] });
  assert.ok(result.next.some((next) => next.carrier.site.kind === "input" && next.carrier.site.name === "order"));
  const unregistered = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "unused", line: 3 }, path: ["id"] });
  assert.equal(unregistered.next.length, 0);
  assert.equal(unregistered.frontiers.length, 0);
});

test("separate bootstraps keep router settings scoped and read route data", async () => {
  const files = [{ path: "a.ts", content: [
    "import { input, inject } from '@angular/core';",
    "import * as router from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser';",
    "export function first() { return {}; }",
    "export function second() { return {}; }",
    "class First { order = input(); route = inject(router.ActivatedRoute); show() { use(this.route.snapshot.data.order.id.name); } }",
    "class Second { order = input(); }",
    "const firstRoutes = [{ path: '', component: First, resolve: { order: first } }];",
    "const secondRoutes = [{ path: '', component: Second, resolve: { order: second } }];",
    "bootstrapApplication(First, { providers: [router.provideRouter(firstRoutes, router.withComponentInputBinding())] });",
    "bootstrapApplication(Second, { providers: [router.provideRouter(secondRoutes)] });",
  ].join("\n") }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const follow = (symbol: string, line: number) => readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol, line }, path: ["id"] });
  const first = follow("first", 3);
  const second = follow("second", 4);
  assert.equal(first.next.filter((item) => item.carrier.site.kind === "input").length, 1);
  assert.ok(first.uses.some((use) => use.path.join(".").includes("id")));
  assert.equal(second.next.filter((item) => item.carrier.site.kind === "input").length, 0);
  assert.equal(second.frontiers[0]?.reason, "unresolved");
});

test("an opaque lazy route in a second application retains uncertainty without suppressing the first application's proven branch", async () => {
  const files = [
    { path: "app1.ts", content: "import { input } from '@angular/core'; import { provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser'; export function load() { return {}; } class Page { order = input(); } const routes = [{ path: '', component: Page, resolve: { order: load } }]; bootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });" },
    { path: "app2.ts", content: "import { provideRouter } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser'; class App {} const routes = [{ path: '', loadChildren: unknownLoader }]; bootstrapApplication(App, { providers: [provideRouter(routes)] });" },
  ];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "app1.ts", symbol: "load", line: 1 }, path: [] });
  assert.equal(result.next.filter((one) => one.carrier.site.kind === "input").length, 1);
  assert.ok(result.frontiers.some((one) => one.at.path === "app2.ts" && one.reason === "unresolved"));
});

test("an unassociated router configuration reports unresolved instead of guessing the application", async () => {
  const files = [{ path: "a.ts", content: ["import { input } from '@angular/core'; import { provideRouter, withComponentInputBinding } from '@angular/router';", "export function load() { return {}; }", "class Page { order = input(); }", "const routes = [{ path: '', component: Page, resolve: { order: load } }];", "export const config = provideRouter(routes, withComponentInputBinding());"].join("\n") }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 2 }, path: [] });
  assert.equal(result.next.length, 0);
  assert.equal(result.frontiers[0]?.reason, "unresolved");
});

test("unread route sources do not make resolver continuation complete", async () => {
  const files = [
    { path: "resolver.ts", content: "export function load() { return {}; }" },
    { path: "routes.ts", content: "import { provideRouter } from '@angular/router'; const routes = [" },
    { path: "other.ts", content: "import { provideRouter } from '@angular/router';" },
  ];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "resolver.ts", symbol: "load", line: 1 }, path: [] });
  assert.ok(result.frontiers.some((frontier) => frontier.at.path === "routes.ts" && frontier.reason === "source-unreadable"));
});

test("a conditional route table does not assert a definite continuation", async () => {
  const content = [
    "import { input } from '@angular/core'; import { provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser';",
    "export function load() { return {}; }",
    "class Page { order = input(); }",
    "const routes = flag ? [{ path: '', component: Page, resolve: { order: load } }] : [];",
    "bootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });",
  ].join("\n");
  const readers = await createConsumerReaders([{ path: "a.ts", content }], "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 2 }, path: [] });
  assert.equal(result.next.length, 0);
  assert.ok(result.frontiers.some((frontier) => frontier.reason === "unresolved"));
});

test("lazy route tables and lazy components retain resolver evidence", async () => {
  const files = [
    { path: "main.ts", content: "import { provideRouter as setup, withComponentInputBinding as bind } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser';\nclass App {}\nconst root = [{ path: '', loadChildren: () => import('./routes').then(m => m.routes) }];\nbootstrapApplication(App, { providers: [setup(root, bind())] });" },
    { path: "routes.ts", content: "import * as resolvers from './resolver';\nexport const routes = [{ path: 'p', loadComponent: () => import('./page').then(m => m.Page), resolve: { order: resolvers.load } }, { path: 'loop', loadChildren: () => import('./routes').then(m => m.routes) }];" },
    { path: "resolver.ts", content: "export function load() { return {}; }" },
    { path: "page.ts", content: "import { input } from '@angular/core'; export class Page { order = input(); }" },
  ];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "resolver.ts", symbol: "load", line: 1 }, path: ["id"] });
  const next = result.next.find((item) => item.carrier.site.kind === "input");
  assert.equal(result.next.filter((item) => item.carrier.site.kind === "input").length, 1);
  assert.equal(next?.carrier.site.kind === "input" && next.carrier.site.file, "page.ts");
  assert.equal(next?.hops[0]?.evidence.path, "routes.ts");
});

test("an imported application configuration proves its own root", async () => {
  const files = [
    { path: "main.ts", content: "import { bootstrapApplication } from '@angular/platform-browser'; import { config } from './config';\nclass App {}\nbootstrapApplication(App, config);" },
    { path: "config.ts", content: "import { provideRouter, withComponentInputBinding } from '@angular/router'; import { routes } from './routes';\nexport const config = { providers: [provideRouter(routes, withComponentInputBinding())] };" },
    { path: "routes.ts", content: "import { load } from './resolver'; import { Page } from './page';\nexport const routes = [{ path: '', component: Page, resolve: { order: load } }];" },
    { path: "resolver.ts", content: "export function load() { return {}; }" },
    { path: "page.ts", content: "import { input } from '@angular/core'; export class Page { order = input(); }" },
  ];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "resolver.ts", symbol: "load", line: 1 }, path: [] });
  assert.equal(result.next.filter((next) => next.carrier.site.kind === "input").length, 1);
});

test("a mutation through an imported application configuration prevents a root proof", async () => {
  const files = [
    { path: "main.ts", content: "import { bootstrapApplication } from '@angular/platform-browser'; import { config } from './config';\nclass App {}\nconfig.providers = []; bootstrapApplication(App, config);" },
    { path: "config.ts", content: "import { provideRouter, withComponentInputBinding } from '@angular/router'; import { routes } from './routes';\nexport const config = { providers: [provideRouter(routes, withComponentInputBinding())] };" },
    { path: "routes.ts", content: "import { load } from './resolver'; import { Page } from './page';\nexport const routes = [{ path: '', component: Page, resolve: { order: load } }];" },
    { path: "resolver.ts", content: "export function load() { return {}; }" },
    { path: "page.ts", content: "import { input } from '@angular/core'; export class Page { order = input(); }" },
  ];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "resolver.ts", symbol: "load", line: 1 }, path: [] });
  assert.equal(result.next.length, 0);
  assert.equal(result.frontiers[0]?.reason, "unresolved");
});

test("an alias that can mutate an application configuration prevents a root proof", async () => {
  const files = (mutation: string) => [
    { path: "main.ts", content: `import { bootstrapApplication } from '@angular/platform-browser'; import { config } from './config'; class App {} ${mutation} bootstrapApplication(App, config);` },
    { path: "config.ts", content: "import { provideRouter, withComponentInputBinding } from '@angular/router'; import { routes } from './routes'; export const config = { providers: [provideRouter(routes, withComponentInputBinding())] };" },
    { path: "routes.ts", content: "import { load } from './resolver'; import { Page } from './page'; export const routes = [{ path: '', component: Page, resolve: { order: load } }];" },
    { path: "resolver.ts", content: "export function load() { return {}; }" },
    { path: "page.ts", content: "import { input } from '@angular/core'; export class Page { order = input(); }" },
  ];
  for (const mutation of ["const alias = config; alias.providers = [];", "mutate(config);"]) {
    const readers = await createConsumerReaders(files(mutation), "repo", undefined, composeFrameworkPlugins());
    const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "resolver.ts", symbol: "load", line: 1 }, path: [] });
    assert.equal(result.next.length, 0);
    assert.equal(result.frontiers[0]?.reason, "unresolved");
  }
});

test("a namespace import mutation prevents another file from proving the same configuration", async () => {
  const files = [
    { path: "main.ts", content: "import { bootstrapApplication } from '@angular/platform-browser'; import { config } from './config'; class App {} bootstrapApplication(App, config);" },
    { path: "mutator.ts", content: "import * as settings from './config'; settings.config.providers = [];" },
    { path: "config.ts", content: "import { provideRouter, withComponentInputBinding } from '@angular/router'; import { routes } from './routes'; export const config = { providers: [provideRouter(routes, withComponentInputBinding())] };" },
    { path: "routes.ts", content: "import { load } from './resolver'; import { Page } from './page'; export const routes = [{ path: '', component: Page, resolve: { order: load } }];" },
    { path: "resolver.ts", content: "export function load() { return {}; }" },
    { path: "page.ts", content: "import { input } from '@angular/core'; export class Page { order = input(); }" },
  ];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "resolver.ts", symbol: "load", line: 1 }, path: [] });
  assert.equal(result.next.length, 0);
  assert.equal(result.frontiers[0]?.reason, "unresolved");
});

test("a class resolver imported under an alias reaches the route input", async () => {
  const files = [
    { path: "main.ts", content: "import { provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser'; import { Resolver as Loader } from './resolver'; import { Page } from './page';\nconst routes = [{ path: '', component: Page, resolve: { order: Loader } }];\nbootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });" },
    { path: "resolver.ts", content: "export class Resolver {\n  resolve() { return {}; }\n}" },
    { path: "page.ts", content: "import { Input } from '@angular/core'; export class Page { @Input() order: any; }" },
  ];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "resolver.ts", symbol: "resolve", line: 2 }, path: [] });
  assert.equal(result.next.filter((item) => item.carrier.site.kind === "input").length, 1);
});

test("route data callbacks keep guards and resolver hops", async () => {
  const files = [{ path: "a.ts", content: [
    "import { input, inject } from '@angular/core'; import { ActivatedRoute, provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser';",
    "export function load() { return {}; }",
    "class Page { order = input(); route = inject(ActivatedRoute); show() { this.route.data.subscribe(({ order }) => { if (order.owner) use(order.owner.name); }); } }",
    "const routes = [{ path: '', component: Page, resolve: { order: load } }];",
    "bootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });",
  ].join("\n") }];
  const readers = await createConsumerReaders(files, "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 2 }, path: ["owner"] });
  assert.ok(result.uses.some((use) => use.guards.length > 0 && use.hops.some((hop) => hop.step === "route-data") && use.hops.some((hop) => hop.step === "resolver-input")));
});

for (const [label, binding, routeType] of [
  ["value", "import { ActivatedRoute as Route } from '@angular/router';", "Route"],
  ["named type", "import type { ActivatedRoute as Route } from '@angular/router';", "Route"],
  ["namespace type", "import type * as router from '@angular/router';", "router.ActivatedRoute"],
]) {
  test(`route data follows ${label} ActivatedRoute imports on fields and constructor parameters`, async () => {
    const content = [
      binding,
      "import { provideRouter } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser';",
      "export function load() { return {}; }",
      `class Page { route!: ${routeType}; constructor(private other: ${routeType}) {} show() { this.route.data.subscribe(({ order }) => use(order.owner.name)); use(this.other.snapshot.data.order.owner.name); } }`,
      "const routes = [{ path: '', component: Page, resolve: { order: load } }];",
      "bootstrapApplication(Page, { providers: [provideRouter(routes)] });",
    ].join("\n");
    const readers = await createConsumerReaders([{ path: "a.ts", content }], "repo", undefined, composeFrameworkPlugins());
    const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 3 }, path: ["owner"] });
    assert.equal(result.uses.filter((use) => use.hops.some((hop) => hop.step === "route-data")).length, 2, binding);
  });
}

test("type-only imports do not prove runtime Angular input or router calls", async () => {
  const content = [
    "import type { Input } from '@angular/core'; import type { provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser';",
    "export function load() { return {}; }",
    "class Page { @Input() order: any; }",
    "const routes = [{ path: '', component: Page, resolve: { order: load } }];",
    "bootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });",
  ].join("\n");
  const readers = await createConsumerReaders([{ path: "a.ts", content }], "repo", undefined, composeFrameworkPlugins());
  const input = readers.flow.follow({ site: { kind: "input", repo: "repo", file: "a.ts", owner: "Page", name: "order" }, path: [] });
  const returned = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 2 }, path: [] });
  assert.equal(input.next.length, 0);
  assert.equal(returned.next.length, 0);
});

test("only router-bound feature imports enable input binding, including aliased feature spreads", async () => {
  const run = async (featureModule: string, argument: string) => {
    const content = [
      "import { input } from '@angular/core'; import { provideRouter } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser';",
      `import { withComponentInputBinding as bind } from '${featureModule}';`,
      "export function load() { return {}; }",
      "class Page { order = input(); }",
      "const routes = [{ path: '', component: Page, resolve: { order: load } }];",
      "const features = [bind()];",
      `bootstrapApplication(Page, { providers: [provideRouter(routes, ${argument})] });`,
    ].join("\n");
    const readers = await createConsumerReaders([{ path: "a.ts", content }], "repo", undefined, composeFrameworkPlugins());
    return readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 3 }, path: [] });
  };
  assert.equal((await run("@angular/router", "...features")).next.length, 1);
  const foreign = await run("foreign-router", "bind()");
  assert.equal(foreign.next.length, 0);
  assert.equal(foreign.frontiers[0]?.reason, "unresolved");
  const unknown = await run("@angular/router", "...unknownFeatures");
  assert.equal(unknown.next.length, 0);
  assert.equal(unknown.frontiers[0]?.reason, "unresolved");
});

test("mutated feature arrays are unresolved instead of being read from their initializer", async () => {
  const template = [
    "import { input } from '@angular/core'; import { provideRouter, withComponentInputBinding } from '@angular/router'; import { bootstrapApplication } from '@angular/platform-browser';",
    "export function load() { return {}; }",
    "class Page { order = input(); }",
    "const routes = [{ path: '', component: Page, resolve: { order: load } }];",
    "const features = [withComponentInputBinding()]; MUTATION",
    "bootstrapApplication(Page, { providers: [provideRouter(routes, ...features)] });",
  ].join("\n");
  for (const mutation of ["features.pop();", "features[0] = other();"]) {
    const readers = await createConsumerReaders([{ path: "a.ts", content: template.replace("MUTATION", mutation) }], "repo", undefined, composeFrameworkPlugins());
    const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 2 }, path: [] });
    assert.equal(result.next.length, 0);
    assert.equal(result.frontiers[0]?.reason, "unresolved");
  }
});

test("foreign router configuration cannot prove an Angular application root", async () => {
  const content = [
    "import { input } from '@angular/core'; import { bootstrapApplication } from '@angular/platform-browser';",
    "import { provideRouter, withComponentInputBinding } from 'foreign-router';",
    "export function load() { return {}; }",
    "class Page { order = input(); }",
    "const routes = [{ path: '', component: Page, resolve: { order: load } }];",
    "bootstrapApplication(Page, { providers: [provideRouter(routes, withComponentInputBinding())] });",
  ].join("\n");
  const readers = await createConsumerReaders([{ path: "a.ts", content }], "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 3 }, path: [] });
  assert.equal(result.next.length, 0);
  assert.equal(result.frontiers[0]?.reason, "unresolved");
});

test("a bootstrapped NgModule associates forRoot settings with its route graph", async () => {
  const content = [
    "import { NgModule, input } from '@angular/core'; import { RouterModule } from '@angular/router'; import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';",
    "export function load() { return {}; }",
    "class Page { order = input(); }",
    "const routes = [{ path: '', component: Page, resolve: { order: load } }];",
    "@NgModule({ imports: [RouterModule.forRoot(routes, { bindToComponentInputs: true })] }) class AppModule {}",
    "platformBrowserDynamic().bootstrapModule(AppModule);",
  ].join("\n");
  const readers = await createConsumerReaders([{ path: "package.json", content: '{"dependencies":{"@angular/core":"1","@angular/router":"1","@angular/platform-browser-dynamic":"1"}}' }, { path: "a.ts", content }], "repo", undefined, composeFrameworkPlugins());
  const result = readers.flow.follow({ site: { kind: "return", repo: "repo", file: "a.ts", symbol: "load", line: 2 }, path: [] });
  assert.equal(result.next.filter((item) => item.carrier.site.kind === "input").length, 1);
});

/** RFC-0007 Conformance: each fixture is a minimal repository and the facts the registered plugins read from it. */
const ROUTES = fileURLToPath(new URL("../core/adapters/frameworks/angular/fixtures/routes/", import.meta.url));

test("removing the registered Angular value contribution disables provider proof and preserves generic HTTP reading", async () => {
  const files = providerValueFiles();
  for (const registered of [true, false]) {
    const plugins = registered ? composeFrameworkPlugins() : [];
    const values = plugins.flatMap((plugin) => plugin.values ?? []);
    const sites = await createHttpCallSites(values).of(files, "repo", [], { completeSource: true });
    assert.equal(sites.some((site) => site.target.status === "complete" && "path" in site.target.value && site.target.value.path === "https://example.test/api/items"), registered);
    const ordinary = await createHttpCallSites(values).of([{ path: "generic.ts", content: "fetch('/ordinary')" }], "repo");
    assert.ok(ordinary.some((site) => site.target.status === "complete"));
  }
});

for (const name of readdirSync(ROUTES).filter((file) => file.endsWith(".json")).sort()) {
  test(`the Angular route fixture ${name} yields its expected entrypoints`, async () => {
    const fixture: { files: Record<string, string>; expected: EntrypointExtraction } = JSON.parse(readFileSync(join(ROUTES, name), "utf8"));
    const files = Object.entries(fixture.files).map(([path, content]) => ({ path, content }));

    assert.deepEqual(await frameworkEntrypoints(composeFrameworkPlugins(), files), fixture.expected);
  });
}
