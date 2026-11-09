import { test } from "node:test";
import assert from "node:assert/strict";
import { combinedModuleReader, importOriginsByLanguage, mergedReaders } from "./language-packs.ts";
import type { DeclaredMemberNames } from "../../ports/declared-member-names.port.ts";
import type { LanguagePack } from "../../ports/language-pack.port.ts";
import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { DispatchTargets, ImportOrigins, ResolvedNameSite, RootBinding, UseSite } from "../../ports/import-origins.port.ts";

const SITES: ResolvedNameSite[] = ["src/a.ts", "src/main/java/A.java"].map((file) => ({ file, line: 1, column: 1, kind: "calls", name: "a" }));
const unknown = (site: ResolvedNameSite): Finding<ImportOrigin> => ({ status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] });
const complete = (site: ResolvedNameSite, module: string): Finding<ImportOrigin> => ({ status: "complete", value: { kind: "external", module }, evidence: [{ path: site.file, line: site.line }] });

const NO_REPLACED = { paths: [], globalObjects: new Set<string>(), packages: new Set<string>() };

/** A reader that settles only the sites whose file ends in `extension`, binding their roots as `binding`. */
function reader(extension: string, module: string, binding: RootBinding = { kind: "ambient", root: "a" }): ImportOrigins {
  const answer = (sites: readonly ResolvedNameSite[]) => sites.map((site) => (site.file.endsWith(extension) ? complete(site, module) : unknown(site)));
  return {
    origins: async (sites) => answer(sites.map((site) => ({ ...site, column: site.column ?? 1, kind: site.kind ?? "calls" }))),
    rootOrigins: async (sites) => answer(sites),
    rootBindings: async (sites) => sites.map((site): RootBinding => (site.file.endsWith(extension) ? binding : { kind: "unknown" })),
    declaredTypes: async (sites) => sites.map(() => ({ kind: "unknown" as const })),
    dispatchTargets: async (sites) => sites.map(() => ({ kind: "unknown" as const })),
    receiverMethods: async (sites) => sites.map(() => ({ kind: "unknown" as const })),
    replacedRoots: async () => NO_REPLACED,
  };
}

test("each site takes the complete answer of the reader of its language, in the order the sites came", async () => {
  const combined = importOriginsByLanguage([reader(".ts", "ts"), reader(".java", "java")]);

  assert.deepEqual(await combined.rootOrigins(SITES), [complete(SITES[0]!, "ts"), complete(SITES[1]!, "java")]);
  assert.deepEqual(await combined.rootOrigins([SITES[1]!, { ...SITES[0]!, file: "src/a.py" }]), [complete(SITES[1]!, "java"), unknown({ ...SITES[0]!, file: "src/a.py" })]);
});

test("each use takes the binding of the reader of its language, an ambiguous one included", async () => {
  const uses: UseSite[] = ["src/a.ts", "src/main/java/A.java", "src/a.py"].map((file) => ({ file, line: 1, column: 1, spelled: "a", owner: { name: "f", line: 1, endLine: 2 } }));
  const combined = importOriginsByLanguage([reader(".ts", "ts", { kind: "local", root: "a" }), reader(".java", "java", { kind: "ambiguous", root: "a" })]);

  assert.deepEqual(await combined.rootBindings(uses), [{ kind: "local", root: "a" }, { kind: "ambiguous", root: "a" }, { kind: "unknown" }]);
});

test("dispatch preserves a veto reason when no language proves bodies and keeps body proof priority", async () => {
  const java: ImportOrigins = { ...reader(".java", "java"), dispatchTargets: async (sites) => sites.map((site): DispatchTargets => site.file.endsWith(".java") ? { kind: "unknown", reason: "aspect may replace the body" } : { kind: "unknown" }) };
  const ts: ImportOrigins = { ...reader(".ts", "ts"), dispatchTargets: async (sites) => sites.map((site): DispatchTargets => site.name === "settled" ? { kind: "bodies", bodies: [] } : { kind: "unknown" }) };
  for (const readers of [[ts, java], [java, ts]]) {
    const result = await importOriginsByLanguage(readers).dispatchTargets([
      { file: "A.java", name: "work", line: 1 },
      { file: "A.java", name: "settled", line: 1 },
      { file: "A.py", name: "work", line: 1 },
    ]);
    assert.deepEqual(result, [{ kind: "unknown", reason: "aspect may replace the body" }, { kind: "bodies", bodies: [] }, { kind: "unknown" }]);
  }
});

const FILE = { path: "src/a.ts", content: "" };

/** A pack whose readers answer only `tag`: one entry in every list, so the merged order shows which pack came first. */
function pack(tag: string, origins: LanguagePack["origins"] = () => reader(".none", tag)): LanguagePack {
  const entry = { name: tag, start: 1, nameLine: 1 } as never;
  const names: DeclaredMemberNames = { names: [tag, "shared"], functionValueCalls: [entry], callables: [entry], initializedFields: [entry], receiverBindings: [entry], functionValues: [entry], calls: [entry] };
  const modules: ModuleDependencies = { files: [entry], dependencies: [entry], unread: [entry], untraversed: [entry] };
  return {
    memberNames: { memberNames: async () => names },
    origins,
    modules: { extract: async () => modules },
    trivia: { triviaLines: async () => new Set([tag === "first" ? 2 : 1, 3]) },
  };
}

const tagsOf = (entries: readonly unknown[]): string[] => entries.map((entry) => (entry as { name: string }).name);

test("a source's syntax concatenates every pack's lists in the packs' order, its names their sorted union", async () => {
  const read = await mergedReaders([pack("first"), pack("second")]).memberNames.memberNames(FILE);

  for (const list of [read.functionValueCalls, read.callables, read.initializedFields ?? [], read.receiverBindings, read.functionValues, read.calls ?? []]) assert.deepEqual(tagsOf(list), ["first", "second"]);
  assert.deepEqual(read.names, ["first", "second", "shared"]);
});

test("a source's trivia lines are every pack's, in the packs' order", async () => {
  assert.deepEqual([...(await mergedReaders([pack("first"), pack("second")]).sourceTrivia.triviaLines(FILE))], [2, 3, 1]);
});

test("a site two packs complete takes the first pack's answer", async () => {
  const merged = mergedReaders([pack("first", () => reader(".ts", "first")), pack("second", () => reader(".ts", "second"))]);

  assert.deepEqual(await merged.importOrigins([FILE]).rootOrigins([SITES[0]!]), [complete(SITES[0]!, "first")]);
});

test("the module readers are every pack's, in the packs' order, and their reads concatenate in it", async () => {
  const { moduleReaders } = mergedReaders([pack("first"), pack("second")]);
  const read = await combinedModuleReader(moduleReaders).extract([FILE]);

  for (const list of [read.files, read.dependencies, read.unread, read.untraversed ?? []]) assert.deepEqual(tagsOf(list), ["first", "second"]);
});
