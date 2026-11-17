import { test } from "node:test";
import assert from "node:assert/strict";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createJavaMemberNames } from "../core/adapters/tree-sitter/java-member-names.adapter.ts";
import { createJavaParser } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createJavaTokens } from "../core/adapters/tree-sitter/java-tokens.adapter.ts";
import { createTypeScriptMemberNames } from "../core/adapters/typescript/declared-member-names.adapter.ts";
import { createImportOrigins } from "../core/adapters/typescript/import-origins.adapter.ts";
import { createTypeScriptTokens } from "../core/adapters/typescript/source-tokens.adapter.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { STORED_DERIVED_FACT_VERSIONS } from "../core/domain/snapshot/stored-derived-facts.ts";
import type { DerivedFacts } from "../core/ports/derived-facts.port.ts";
import type { SourceFile } from "../core/ports/entrypoint-extractor.port.ts";

const TS_FILE: SourceFile = { path: "src/a.ts", content: ["const fn = () => 1;", "export function run(list: Repo[]): void {", "  fn.call(undefined);", "  list.save();", "}", ""].join("\n") };
const JAVA_FILE: SourceFile = { path: "src/A.java", content: ["class A {", "  void run() { B b = new B(); b.go(); Runnable r = () -> run(); }", "}", ""].join("\n") };
const PARAMETER: SourceFile = { path: "src/parameter.ts", content: ["export function run(redact: () => void): void {", "  redact();", "}", ""].join("\n") };
const DYNAMIC: SourceFile = { path: "src/dynamic.ts", content: ["export function run(): void {", "  eval('x');", "  helper();", "}", ""].join("\n") };
const WRITER: SourceFile = { path: "src/writer.ts", content: ["export {};", "(Array.prototype as any).last = () => 1;", ""].join("\n") };
const SCRIPT: SourceFile = { path: "src/script.ts", content: "var scriptGlobal = 1;\n" };

/**
 * What a reader of each stored slot derives from a fixed source, as a digest, beside the version the slot has: a reader
 * that changes what it derives changes its digest here, and the slot's version is bumped with it (ADR-0077).
 */
const PINNED: Readonly<Record<string, readonly [version: number, digest: string]>> = {
  "ts-member-names": [1, "4fb979c9aee25c59bce59a6bef8a4a3a8fb1b594e0dd7ce243f7d93cc0e838f7"],
  "java-member-names": [1, "2731abd79c678021e85543c1643bdd7e85ceb75b8cabe9d2394bf976acca550c"],
  "ts-binding-uses": [1, "8f82a98a0c55b411ab24f9f3420c5162a0625f944447f7c91a5fb160544be31f"],
  "ts-script-globals": [1, "66e1183b6ebfc3a46590953747633de58924ee17f5ddfd3c9a63fd24ca55702e"],
  "ts-written-roots": [1, "d557ab6096c85362657c4fabb463c21becbbc0b6b32aae0f1235b64597373e40"],
  tokens: [1, "abdbd629965c9c2d3afecd0b502ffdea9e0015537dc77bee38e7c21f012cee3c"],
};

async function derivedBySlot(): Promise<Record<string, [number, string]>> {
  const derived = new Map<string, unknown[]>();
  const record = (slot: string, value: unknown): void => void derived.set(slot, [...(derived.get(slot) ?? []), value]);
  const facts: DerivedFacts = {
    ofFile(slot, _file, derive) {
      const value = derive();
      record(slot, value);
      return value;
    },
    async ofInputs(slot, _inputs, derive) {
      const value = await derive();
      record(slot, value);
      return value;
    },
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, diskHits: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
  await createTypeScriptMemberNames().memberNames(TS_FILE, facts);
  await createJavaMemberNames(createJavaParser).memberNames(JAVA_FILE, facts);
  const origins = createImportOrigins([PARAMETER, DYNAMIC, WRITER, SCRIPT], { facts });
  await origins.rootOrigins([{ file: PARAMETER.path, line: 2, column: 3, kind: "calls", name: "redact" }, { file: DYNAMIC.path, line: 3, column: 3, kind: "calls", name: "helper" }]);
  await origins.replacedRoots();
  record("tokens", await createTypeScriptTokens().tokensOf(TS_FILE));
  record("tokens", await createJavaTokens(createJavaParser).tokensOf(JAVA_FILE));
  const digest = createSha256Digest();
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_, member) => (member instanceof Set ? [...member] : member)) ?? "null");
  return Object.fromEntries(
    Object.entries(STORED_DERIVED_FACT_VERSIONS).map(([slot, version]) => {
      const values = derived.get(slot);
      assert.ok(values !== undefined, `no fixture drives the stored slot ${slot}`);
      return [slot, [version, digest.of(canonicalJson(values.map(plain)))]];
    }),
  );
}

test("a stored slot's version is bumped with what its reader derives", async () => {
  assert.deepEqual(await derivedBySlot(), PINNED);
});
