import assert from "node:assert/strict";
import { test } from "node:test";
import { JAVA_PROFILE, TYPESCRIPT_PROFILE, type LanguageProfile } from "../../domain/languages/profiles.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins } from "../../ports/import-origins.port.ts";
import type { LanguagePack } from "../../ports/language-pack.port.ts";
import { routedReaders } from "./language-packs.ts";

const TS = "src/a.ts";
const JAVA = "src/main/java/A.java";
const TS_TEST = "src/a.spec.ts";
const MANIFEST = "package.json";
const PATHS = [TS, JAVA, TS_TEST, MANIFEST, "src/main/kotlin/B.kt"];
const SOURCES: SourceFile[] = PATHS.map((path) => ({ path, content: "" }));

/** A pack that records every path it is handed and answers each site with its own language's tag. */
function recordingPack(profile: LanguageProfile, received: string[], readsProjectFiles?: true, universe: string[] = []): LanguagePack {
  const tag = profile.language;
  const answer = (site: { file: string; line: number }): Finding<ImportOrigin> => (received.push(site.file), { status: "complete", value: { kind: "external", module: tag }, evidence: [{ path: site.file, line: site.line }] });
  const origins: ImportOrigins = {
    origins: async (sites) => sites.map(answer),
    rootOrigins: async (sites) => sites.map(answer),
    rootBindings: async (sites) => sites.map((site) => (received.push(site.file), { kind: "ambient", root: tag })),
    declaredTypes: async (sites) => sites.map((site) => (received.push(site.file), { kind: "package", module: tag, name: tag })),
    dispatchTargets: async (sites) => sites.map((site) => (received.push(site.file), { kind: "unknown", reason: tag === "java" ? "aspect may replace the body" : "dispatch not proven" })),
    receiverMethods: async (sites) => sites.map((site) => (received.push(site.file), { kind: "unproven" })),
    replacedRoots: async () => ({ paths: [], globalObjects: new Set(), packages: new Set() }),
  };
  return {
    profile,
    ...(readsProjectFiles === undefined ? {} : { readsProjectFiles }),
    memberNames: { memberNames: async (file) => (received.push(file.path), { names: [tag], functionValueCalls: [], callables: [], receiverBindings: [], functionValues: [] }) },
    origins: (sources, paths) => (received.push(...sources.map(({ path }) => path)), universe.push(...(paths ?? [])), origins),
    modules: { extract: async (sources) => (received.push(...sources.map(({ path }) => path)), { files: [], dependencies: [], unread: sources.map(({ path }) => ({ file: path, reason: "unresolved" as const })), untraversed: [] }) },
    trivia: { triviaLines: async (file) => (received.push(file.path), new Set([tag.length])) },
  };
}

test("a site, a file or a source of one language reaches only its pack, and a site no pack reads is unknown", async () => {
  const typescript: string[] = [];
  const java: string[] = [];
  const universe: string[] = [];
  const readers = routedReaders([recordingPack(TYPESCRIPT_PROFILE, typescript, true), recordingPack(JAVA_PROFILE, java, undefined, universe)]);
  const sites = [JAVA, TS, TS_TEST, JAVA].map((file, line) => ({ file, line, column: 1, kind: "calls", name: "a", spelled: "a", member: "a", owner: { name: "f", line: 1, endLine: 9 } }));

  const origins = readers.importOrigins(SOURCES);
  const answers = [
    await origins.origins(sites),
    await origins.rootOrigins(sites),
    await origins.rootBindings(sites),
    await origins.declaredTypes(sites),
    await origins.dispatchTargets(sites),
    await origins.receiverMethods(sites),
  ];
  for (const file of SOURCES) {
    await readers.memberNames.memberNames(file);
    await readers.sourceTrivia.triviaLines(file);
  }
  await readers.modules.extract(SOURCES);

  assert.deepEqual([...new Set(java)].sort(), [JAVA]);
  assert.deepEqual(universe, PATHS);
  assert.deepEqual([...new Set(typescript)].sort(), [MANIFEST, "src/a.spec.ts", TS, "src/main/kotlin/B.kt"].sort());
  assert.ok(!typescript.includes(JAVA));
  assert.deepEqual(answers[0]!.map((finding) => (finding as Finding<ImportOrigin>).status === "complete" ? ((finding as { value: { module: string } }).value.module) : "unknown"), ["java", "typescript", "unknown", "java"]);
  assert.deepEqual(answers[2], [{ kind: "ambient", root: "java" }, { kind: "ambient", root: "typescript" }, { kind: "unknown" }, { kind: "ambient", root: "java" }]);
  assert.deepEqual(answers[4], [{ kind: "unknown", reason: "aspect may replace the body" }, { kind: "unknown", reason: "dispatch not proven" }, { kind: "unknown" }, { kind: "unknown", reason: "aspect may replace the body" }]);
  assert.deepEqual((await readers.memberNames.memberNames({ path: TS_TEST, content: "" })).names, []);
});

test("a stage a pack declares absent answers each of its sites capability-absent and is never asked, while another pack's stays its own", async () => {
  const typescript: string[] = [];
  const java: string[] = [];
  const readers = routedReaders([{ ...recordingPack(TYPESCRIPT_PROFILE, typescript, true), absent: ["dispatchTargets", "receiverMethods"] }, recordingPack(JAVA_PROFILE, java)]);
  const origins = readers.importOrigins(SOURCES);
  typescript.length = 0;

  const dispatch = await origins.dispatchTargets([{ file: TS, line: 1, name: "a" }, { file: JAVA, line: 2, name: "a" }]);
  const receivers = await origins.receiverMethods([{ file: TS, line: 1, column: 1, member: "a" }, { file: JAVA, line: 2, column: 1, member: "a" }]);

  assert.deepEqual(dispatch, [{ kind: "unknown", reason: "capability-absent" }, { kind: "unknown", reason: "aspect may replace the body" }]);
  assert.deepEqual(receivers, [{ kind: "unknown", reason: "capability-absent" }, { kind: "unproven" }]);
  assert.deepEqual(typescript, []);
});

test("one list of sources reaches a pack as one list, however many times it is read", async () => {
  const lists: (readonly SourceFile[])[] = [];
  const java: LanguagePack = { ...recordingPack(JAVA_PROFILE, []), modules: { extract: async (sources) => (lists.push(sources), { files: [], dependencies: [], unread: [] }) } };
  const readers = routedReaders([recordingPack(TYPESCRIPT_PROFILE, [], true), java]);

  await readers.modules.extract(SOURCES);
  await readers.modules.extract(SOURCES);

  assert.equal(lists.length, 2);
  assert.equal(lists[0], lists[1]);
});
