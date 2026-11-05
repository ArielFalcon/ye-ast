import { test } from "node:test";
import assert from "node:assert/strict";
import { createAngularMetadataReader } from "./angular-metadata.adapter.ts";

const pkg = JSON.stringify({ dependencies: { "@angular/core": "22.0.0" } });
async function read(extra: Record<string, string>, completeSource = true) {
  const files = { "package.json": pkg, "src/store.ts": "export class Store { start() {} }", "src/owner.ts": "import { inject } from '@angular/core'; import { Store } from './store'; export function run() { inject(Store).start(); }", ...extra };
  return createAngularMetadataReader().read(Object.entries(files).map(([path, content]) => ({ path, content })), { memberProofs: { completeSource } });
}
test("fresh Angular tokens do not substitute unrelated class receivers", async () => {
  for (const constructor of ["import { InjectionToken } from '@angular/core'; const TOKEN = new InjectionToken('x');", "import { InjectionToken as IT } from '@angular/core'; const TOKEN = new IT('x');", "import * as ng from '@angular/core'; const TOKEN = new ng.InjectionToken('x');"]) {
    for (const use of ["useValue: {}", "useClass: Other", "useExisting: Other", "useFactory: () => null"]) {
      const meta = await read({ "src/providers.ts": `${constructor} class Other {} const p = [{ provide: TOKEN, ${use} }];` });
      assert.equal(meta.memberUses?.length, 1, `${constructor} ${use}`);
    }
  }
});

test("direct token imports preserve identity, including namespace and same descriptions", async () => {
  const tokens = "import { InjectionToken } from '@angular/core'; export const A = new InjectionToken('same'); export const B = new InjectionToken('same');";
  for (const provider of ["import { A as T, B } from './tokens'; const p = [{ provide: T, useValue: 1 }, { provide: B, useValue: 2 }];", "import * as tokens from './tokens'; const p = [{ provide: tokens.A, useValue: 1 }];"]) {
    const result = await read({ "src/tokens.ts": tokens, "src/providers.ts": provider });
    assert.equal(result.memberUses?.length, 1, provider);
  }
});

test("a provider identity that can reach the receiver still refuses its proof", async () => {
  const token = "import { InjectionToken } from '@angular/core'; export const TOKEN = new InjectionToken('x');";
  const cases: Record<string, string>[] = [
    { "src/providers.ts": "import { Store } from './store'; const TOKEN = Store; const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/providers.ts": "import { Store } from './store'; function Unknown() { return Store; } const TOKEN = new Unknown('x'); const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/providers.ts": "import { Store } from './store'; const p = [{ provide: Store, useValue: 1 }];" },
    { "src/providers.ts": token + " const p = [{ provide: TOKEN, useValue: 1 }];", "src/store.ts": "export class Store { start() {} } Store = TOKEN;" },
    { "src/providers.ts": token + " const p = [{ provide: TOKEN, useValue: 1 }];", "src/store.ts": "export class Store { start() {} } [Store] = values;" },
    { "src/providers.ts": "import { TOKEN } from './store'; const p = [{ provide: TOKEN, useValue: 1 }];", "src/store.ts": "import { InjectionToken } from '@angular/core'; export const TOKEN = new InjectionToken('x'); export class Store { start() {} } Store = TOKEN;" },
    { "src/providers.ts": token + " const p = [{ provide: TOKEN, useValue: 1 }];", "src/mutate.ts": "import * as ns from './store'; ns.Store = other;" },
    { "src/providers.ts": "import * as ng from '@angular/core'; ng.InjectionToken = Other; const TOKEN = new ng.InjectionToken('x'); const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/providers.ts": token + " const p = [{ provide: TOKEN, useValue: 1 }];", "src/broken.ts": "const x = ;" },
  ];
  for (const files of cases) assert.deepEqual((await read(files)).memberUses, [], JSON.stringify(files));
  assert.deepEqual((await read({ "src/providers.ts": token + " const p = [{ provide: TOKEN, useValue: 1 }];" }, false)).memberUses, []);
});

test("a provider token the reader cannot prove distinct reaches only the classes its provider and declaring files name", async () => {
  const token = "import { InjectionToken } from '@angular/core'; export const TOKEN = new InjectionToken('x');";
  const cases: Record<string, string>[] = [
    { "src/providers.ts": "import { InjectionToken } from '@angular/core'; let TOKEN = new InjectionToken('x'); const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/providers.ts": "import type { InjectionToken } from '@angular/core'; const TOKEN = new InjectionToken('x'); const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/providers.ts": "import { InjectionToken } from '@angular/core'; function f(InjectionToken: unknown) {} const TOKEN = new InjectionToken('x'); const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/tokens.ts": token, "src/providers.ts": "import type { TOKEN } from './tokens'; const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/tokens.ts": token, "src/providers.ts": "import { TOKEN } from './missing'; import { TOKEN } from './tokens'; const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/tokens.ts": token, "src/providers.ts": "import { TOKEN } from './tokens'; function f(TOKEN: unknown) {} const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/providers.ts": "import { TOKEN } from './missing'; const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/tokens.ts": token, "src/barrel.ts": "export { TOKEN } from './tokens';", "src/providers.ts": "import { TOKEN } from './barrel'; const p = [{ provide: TOKEN, useValue: 1 }];" },
    { "src/tokens.ts": token, "src/barrel.ts": "export * from './tokens'; export * from './missing';", "src/providers.ts": "import { TOKEN } from './barrel'; const p = [{ provide: TOKEN, useValue: 1 }];" },
  ];
  for (const files of cases) assert.equal((await read(files)).memberUses?.length, 1, JSON.stringify(files));
});

test("token relations and potential local reach retain their existing authority", async () => {
  const meta = await read({ "src/providers.ts": "import { InjectionToken, inject } from '@angular/core'; const TOKEN = new InjectionToken('x'); const p = [{ provide: TOKEN, useValue: 1 }]; export function f() { inject(TOKEN).start(); }", "src/owner.ts": "import { inject } from '@angular/core'; import { Store } from './store'; export function run() { const s = inject(Store); s.start(); }" });
  assert.ok(meta.findings.some((f) => f.status === "complete" && f.value.to.symbol === "TOKEN"));
  assert.equal(meta.memberUses?.length, 1);
  assert.ok(meta.locals.some((local) => local.local === "s"));
});

for (const namespace of ["(ng as any)", "ng!", "(ng satisfies object)", "(<any>ng)", "((ng as any)!)"]) {
  test(`wrapped namespace mutation remains unknown for ${namespace}`, async () => {
    const meta = await read({
      "src/providers.ts": `import * as ng from '@angular/core'; import { Store } from './store'; function Replacement() { return Store; } ${namespace}.InjectionToken = Replacement; const TOKEN = new ng.InjectionToken('x'); const providers = [{ provide: TOKEN, useValue: 1 }];`,
    });
    assert.deepEqual(meta.memberUses, []);
  });
}
