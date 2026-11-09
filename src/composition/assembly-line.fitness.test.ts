import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * ADR-0045 decision 10 and decision 12, against the code as it is before the assembly line exists. Each frozen list
 * may only shrink: a site that leaves is removed from its list in the same change, and no site enters one.
 */
const SOURCE = fileURLToPath(new URL("../", import.meta.url));
const BASE_READING = "core/application/snapshot/base-reading.ts";

/** The calls of each stage constructor of decision 1 outside `BASE_READING`, by file. */
const STAGE_CONSTRUCTOR_SITES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  createEdgeTargets: {},
  createCallBinder: { "core/application/navigation/edge-targets.ts": 1 },
  createCallBindings: { "core/application/navigation/edge-targets.ts": 1 },
  createReconciledCalls: {},
  createReverseCalls: {},
  createDeclarationUses: {},
  retainedRelations: {},
  referenceProofsOf: {},
};

/** The language checks of decision 12. */
const LANGUAGE_CHECKS = ["isJavaSource", "isTypeScriptSource", "isTypeScriptFile", "isJvmTestFile", "isTypeScriptTestFile", "isJsonModuleResource", "isTypeCheckerInput"];

/** Lines outside `core/domain/languages/` that call a language check, by file, in `core/application` and `core/domain`. */
const LANGUAGE_CHECK_LINES: Readonly<Record<string, number>> = {
  "core/application/impact/impact-queries.ts": 7,
  "core/application/impact/importers.ts": 1,
  "core/domain/change/changed-file.ts": 2,
  "core/domain/impact/module-impact.ts": 5,
  "core/domain/map/entrypoint-map.ts": 2,
  "core/domain/snapshot/live-export.ts": 1,
};

/**
 * The one-owner audit's frozen sites (ADR-0045, the paragraph after the Migration table): a declaration's call edges read
 * straight from the index outside `navigation`, which owns what a body calls, and a callee's last name cut at its last dot
 * outside `nameTail`'s file, by file.
 */
const RAW_BODY_EDGE_SITES: Readonly<Record<string, number>> = {};
const NAME_TAIL_OWNER = "core/domain/shared/call-place.ts";
/**
 * Where a declaration's name is cut at its last dot: `nameTail` tails the spelling a callee is written with, while these
 * read the name a declaration already carries, in a fact, in a host's anchor or in a Java FQN.
 */
const DOT_TAIL_SITES: Readonly<Record<string, number>> = {
  // A Java FQN: the tail of a package path, never a callee's name.
  "core/adapters/spring/event-call-sites.adapter.ts": 1,
  "core/adapters/spring/java-symbols.ts": 2,
  // A declaration name a host's anchor carries.
  "core/application/composition/compose-evidence.ts": 1,
  // A declaration name a fact or a user's target writes.
  "core/application/navigation/snapshot-files.ts": 1,
  "core/domain/shared/code-node.ts": 1,
};

const FAMILIES = ["composition", "contracts", "decisions", "entrypoints", "impact", "outline", "topology", "trace"];

/** The imports from one query family into another, tests included, that `.dependency-cruiser.cjs` exempts. */
const CROSS_FAMILY_IMPORTS: readonly string[] = [
  "contracts/consumer-callers.test.ts → impact/inbound-edges.ts",
  "contracts/consumer-callers.ts → impact/inbound-edges.ts",
  "contracts/consumer-sources.ts → impact/inbound-edges.ts",
  "contracts/consumer-sources.ts → impact/inbound-origins.ts",
  "contracts/consumer-sources.ts → topology/workspace-join.ts",
  "contracts/consumer-sources.ts → topology/workspace-operation.ts",
  "contracts/consumer-sources.ts → topology/workspace-snapshots.ts",
  "decisions/decision-queries.test.ts → topology/workspace-operation.ts",
  "decisions/decision-queries.test.ts → topology/workspace-snapshots.ts",
  "decisions/decision-queries.ts → topology/workspace-defaults.ts",
  "decisions/decision-queries.ts → topology/workspace-join.ts",
  "decisions/decision-queries.ts → topology/workspace-operation.ts",
  "decisions/decision-queries.ts → topology/workspace-plan.ts",
  "topology/workspace-discovery-live.test.ts → decisions/decision-queries.ts",
  "topology/workspace-queries.test.ts → decisions/decision-queries.ts",
  "trace/trace-queries.ts → topology/workspace-operation.ts",
];

function files(directory: string, tests: boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path, tests);
    const isTest = entry.name.endsWith(".test.ts") || entry.name.endsWith(".testing.ts");
    return entry.name.endsWith(".ts") && (tests || !isTest) ? [relative(SOURCE, path)] : [];
  });
}

const read = (file: string): string => readFileSync(join(SOURCE, file), "utf8");
const counted = (entries: readonly (readonly [string, number])[]): Record<string, number> => Object.fromEntries(entries.filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b)));

for (const [constructor, frozen] of Object.entries(STAGE_CONSTRUCTOR_SITES)) {
  test(`${constructor} is called outside the assembly line only at its frozen sites`, () => {
    const call = new RegExp(`(?<!function )\\b${constructor}\\(`, "g");
    const sites = counted(files(SOURCE, false).filter((file) => file !== BASE_READING).map((file) => [file, read(file).match(call)?.length ?? 0] as const));

    assert.deepEqual(sites, counted(Object.entries(frozen)));
  });
}

test("a declaration's edges are read straight from the index outside navigation only at their frozen sites", () => {
  const raw = /outgoingEdges\(\[\w+\.id\]/g;
  const sites = counted(files(SOURCE, false).filter((file) => !file.startsWith("core/application/navigation/")).map((file) => [file, read(file).match(raw)?.length ?? 0] as const));

  assert.deepEqual(sites, counted(Object.entries(RAW_BODY_EDGE_SITES)));
});

test("a name's last segment is cut at its last dot outside nameTail's file only at its frozen sites", () => {
  const tail = /lastIndexOf\("\."\) \+ 1/g;
  const sites = counted(files(SOURCE, false).filter((file) => file !== NAME_TAIL_OWNER).map((file) => [file, read(file).match(tail)?.length ?? 0] as const));

  assert.deepEqual(sites, counted(Object.entries(DOT_TAIL_SITES)));
});

test("language checks outside core/domain/languages stay at their frozen lines", () => {
  const check = new RegExp(`\\b(${LANGUAGE_CHECKS.join("|")})\\b`);
  const scanned = [...files(join(SOURCE, "core/application"), false), ...files(join(SOURCE, "core/domain"), false)].filter((file) => !file.startsWith("core/domain/languages/"));
  const lines = counted(scanned.map((file) => [file, read(file).split("\n").filter((line) => check.test(line) && !/^\s*import\b/.test(line)).length] as const));

  assert.deepEqual(lines, counted(Object.entries(LANGUAGE_CHECK_LINES)));
});

test("no rule outside core/domain/languages tells a language by its profile's name", () => {
  const named = /\.language\s*[!=]==|[!=]==\s*"(typescript|java)"/;
  const scanned = files(SOURCE, false).filter((file) => !file.startsWith("core/domain/languages/") && !file.startsWith("core/adapters/") && !file.startsWith("composition/"));

  assert.deepEqual(scanned.filter((file) => read(file).split("\n").some((line) => named.test(line))), []);
});

test("a query family imports another only at its frozen imports", () => {
  const family = new RegExp(`(?:from |import\\()"\\.\\./(${FAMILIES.join("|")})/([^"]+)"`, "g");
  const imports = FAMILIES.flatMap((owner) =>
    files(join(SOURCE, "core/application", owner), true).flatMap((file) =>
      [...read(file).matchAll(family)].filter(([, to]) => to !== owner).map(([, to, path]) => `${relative(join(SOURCE, "core/application"), join(SOURCE, file))} → ${to}/${path}`),
    ),
  );

  assert.deepEqual([...new Set(imports)].sort(), [...CROSS_FAMILY_IMPORTS].sort());
});
