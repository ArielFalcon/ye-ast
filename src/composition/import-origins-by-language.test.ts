import { test } from "node:test";
import assert from "node:assert/strict";
import { importOriginsByLanguage } from "./import-origins-by-language.ts";
import type { ImportOrigin } from "../core/domain/relations/resolved-reference.ts";
import type { Finding } from "../core/domain/shared/fact.ts";
import type { DispatchTargets, ImportOrigins, ResolvedNameSite, RootBinding, UseSite } from "../core/ports/import-origins.port.ts";

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
