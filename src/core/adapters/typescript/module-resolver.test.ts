import { test } from "node:test";
import assert from "node:assert/strict";
import { createModuleResolver, manifestDependencies, manifestPackages, moduleResolverOf } from "./module-resolver.ts";

const NO_PACKAGES = { dependencies: new Set<string>(), declared: new Set<string>() };

function resolverOver(files: Record<string, string>, dependencies: string[] = []) {
  return createModuleResolver(async (file) => files[file], { dependencies: new Set(dependencies), declared: new Set() });
}

test("a relative specifier names a TypeScript file as written, with an extension, or its index file; anything else is unresolved", async () => {
  const resolver = resolverOver({ "src/a.ts": "", "src/b/index.ts": "", "src/c.d.ts": "", "src/d.js": "" });

  assert.deepEqual(await resolver.resolve("src/app.ts", "./a"), { file: "src/a.ts" });
  assert.deepEqual(await resolver.resolve("src/app.ts", "./b"), { file: "src/b/index.ts" });
  assert.deepEqual(await resolver.resolve("src/x/app.ts", "../a.ts"), { file: "src/a.ts" });
  for (const specifier of ["./missing", "./c.d.ts", "./d.js", "../../../escape", "/abs/a"]) {
    assert.ok("unresolved" in (await resolver.resolve("src/app.ts", specifier)), specifier);
  }
});

test("an unresolved specifier names no file only where the resolver applied its rules over the snapshot and they reach no file of it", async () => {
  const resolver = resolverOver({ "src/c.d.ts": "", "src/d.js": "", "web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }) });
  const proof = async (from: string, specifier: string) => {
    const resolution = await resolver.resolve(from, specifier);
    return "unresolved" in resolution && resolution.namesNoFile === true;
  };

  assert.deepEqual(
    await Promise.all([["src/app.ts", "./missing"], ["src/app.ts", "../../escape"], ["src/app.ts", "node:nothing"], ["web/src/app.ts", "@app/missing"]].map(([from, specifier]) => proof(from!, specifier!))),
    [true, true, true, true],
  );
  assert.deepEqual(
    await Promise.all([["src/app.ts", "./c.d.ts"], ["src/app.ts", "./d.js"], ["src/app.ts", "/abs/a"], ["src/app.ts", "@app/missing"]].map(([from, specifier]) => proof(from!, specifier!))),
    [false, false, false, false],
  );
});

test("a specifier resolves through the paths of the nearest configuration, however long its extends chain is", async () => {
  const hops = 9;
  const chain = Object.fromEntries(Array.from({ length: hops }, (_, hop) => [`tsconfig.${hop}.json`, `{ "extends": "./tsconfig.${hop + 1}.json" }`]));
  const resolver = resolverOver({
    ...chain,
    [`tsconfig.${hops}.json`]: '{ "compilerOptions": { "paths": { "@lib/*": ["src/lib/*"] } } }',
    "tsconfig.json": '{ "extends": "./tsconfig.0.json" }',
    "src/lib/util.ts": "",
    "apps/web/tsconfig.json": '{ "compilerOptions": { "baseUrl": "../..", "paths": { "@lib/*": ["other/*"] } } }',
    "other/util.ts": "",
  });

  assert.deepEqual(await resolver.resolve("src/app.ts", "@lib/util"), { file: "src/lib/util.ts" });
  assert.deepEqual(await resolver.resolve("apps/web/main.ts", "@lib/util"), { file: "other/util.ts" });
});

test("baseUrl alone resolves a specifier written from the root, and a manifest dependency the configuration cannot name stays external", async () => {
  const resolver = resolverOver({ "tsconfig.json": '{ "compilerOptions": { "baseUrl": "." } }', "src/models.ts": "" }, ["rxjs"]);

  assert.deepEqual(await resolver.resolve("src/app.ts", "src/models"), { file: "src/models.ts" });
  assert.deepEqual(await resolver.resolve("src/app.ts", "rxjs/operators"), { external: true });
  assert.ok("unresolved" in (await resolver.resolve("src/app.ts", "@unknown/pkg")));
});

test("a non-relative specifier with no governing configuration is external only when the manifest names its package", async () => {
  const resolver = resolverOver({}, ["@angular/router"]);

  assert.deepEqual(await resolver.resolve("src/app.ts", "@angular/router"), { external: true });
  assert.ok("unresolved" in (await resolver.resolve("src/app.ts", "@angular/core")));
});

test("a package a manifest of the snapshot names is never external, whether a configuration governs the importer or not", async () => {
  const packages = manifestPackages([
    { path: "shared/package.json", content: JSON.stringify({ name: "@r/shared" }) },
    { path: "app/package.json", content: JSON.stringify({ name: "app", dependencies: { "@r/shared": "workspace:*", rxjs: "1" } }) },
    { path: "broken/package.json", content: "{ nope" },
  ]);
  const files: Record<string, string> = { "app/tsconfig.json": "{}" };
  const resolver = createModuleResolver(async (file) => files[file], packages);

  for (const from of ["app/src/use.ts", "lib/use.ts"]) {
    assert.ok("unresolved" in (await resolver.resolve(from, "@r/shared")), from);
    assert.ok("unresolved" in (await resolver.resolve(from, "@r/shared/sub")), from);
    assert.deepEqual(await resolver.resolve(from, "rxjs"), { external: true }, from);
  }
});

test("the dependencies of a manifest are the names in dependencies, devDependencies and peerDependencies; a manifest that is missing or not JSON names none", () => {
  const manifest = JSON.stringify({ dependencies: { a: "1" }, devDependencies: { b: "1" }, peerDependencies: { c: "1" }, optionalDependencies: { d: "1" } });

  assert.deepEqual([...manifestDependencies(manifest)].sort(), ["a", "b", "c"]);
  assert.equal(manifestDependencies(undefined).size, 0);
  assert.equal(manifestDependencies("{ nope").size, 0);
});

test("only validated node-prefixed builtins are external without reading sources", async () => {
  let reads = 0;
  const resolver = createModuleResolver(async () => { reads++; return undefined; }, NO_PACKAGES);
  assert.deepEqual(await resolver.resolve("src/app.ts", "node:fs/promises"), { external: true });
  assert.deepEqual(await resolver.resolve("src/app.ts", "node:fs/promises"), { external: true });
  assert.equal(reads, 0);
  assert.ok("unresolved" in await resolver.resolve("src/app.ts", "node:not-a-real-builtin"));
});

test("explicit JSON resources resolve only when opted in and present", async () => {
  const files: Record<string, string> = {
    "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@data/*": ["data/*"] } } }',
    "data/config.json": "not parsed as JSON",
    "data/index.json": "{}",
    "data/only.json.ts": "",
  };
  const reads = new Map<string, number>();
  const read = async (file: string) => { reads.set(file, (reads.get(file) ?? 0) + 1); return files[file]; };
  const resolver = createModuleResolver(read, NO_PACKAGES, { jsonModules: true });
  assert.deepEqual(await resolver.resolve("src/app.ts", "../data/config.json"), { file: "data/config.json" });
  assert.deepEqual(await resolver.resolve("src/app.ts", "../data/config.json"), { file: "data/config.json" });
  assert.equal(reads.get("data/config.json"), 1);
  assert.deepEqual(await resolver.resolve("src/app.ts", "@data/config.json"), { file: "data/config.json" });
  assert.deepEqual(await resolver.resolve("src/app.ts", "data/config.json"), { file: "data/config.json" });
  for (const specifier of ["../data/missing.json", "@data/missing.json", "@data/only.json", "../data/config", "../data", "../../data/config.json"]) {
    assert.ok("unresolved" in await resolver.resolve("src/app.ts", specifier), specifier);
  }
  const defaultResolver = createModuleResolver(read, NO_PACKAGES);
  assert.ok("unresolved" in await defaultResolver.resolve("src/app.ts", "../data/config.json"));
  assert.ok("unresolved" in await defaultResolver.resolve("src/app.ts", "@data/config.json"));
});

test("every reader of one source list shares its resolver per option, and answers as a resolver of its own would", async () => {
  const sources = [{ path: "src/a.ts", content: "" }, { path: "src/b.ts", content: "" }, { path: "data.json", content: "{}" }];
  const shared = moduleResolverOf(sources);
  assert.equal(moduleResolverOf(sources), shared);
  assert.notEqual(moduleResolverOf(sources, { jsonModules: true }), shared);
  assert.equal(moduleResolverOf(sources, { jsonModules: true }), moduleResolverOf(sources, { jsonModules: true }));
  assert.notEqual(moduleResolverOf([...sources]), shared);
  assert.deepEqual(await shared.resolve("src/a.ts", "./b"), { file: "src/b.ts" });
  assert.deepEqual(await moduleResolverOf(sources, { jsonModules: true }).resolve("src/a.ts", "../data.json"), { file: "data.json" });
  assert.deepEqual(await shared.resolve("src/a.ts", "../data.json"), await createModuleResolver(async (file) => sources.find((source) => source.path === file)?.content, manifestPackages(sources)).resolve("src/a.ts", "../data.json"));
});
