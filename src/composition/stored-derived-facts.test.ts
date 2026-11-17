import { test } from "node:test";
import assert from "node:assert/strict";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { javaDeclarationIndex } from "../core/adapters/spring/java-declaration-index.ts";
import { createJavaReceiverMethods } from "../core/adapters/spring/java-receiver-methods.ts";
import { createJavaRelations } from "../core/adapters/spring/java-relations.adapter.ts";
import { createSpringRoutesExtractor } from "../core/adapters/spring/spring-routes.adapter.ts";
import { createJavaMemberNames } from "../core/adapters/tree-sitter/java-member-names.adapter.ts";
import { createJavaParser, createJavaTreeHolds } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createJavaTokens } from "../core/adapters/tree-sitter/java-tokens.adapter.ts";
import { createTypeScriptMemberNames } from "../core/adapters/typescript/declared-member-names.adapter.ts";
import { createModuleDependenciesReader } from "../core/adapters/typescript/module-dependencies.adapter.ts";
import { createImportOrigins } from "../core/adapters/typescript/import-origins.adapter.ts";
import { createTypeScriptTokens } from "../core/adapters/typescript/source-tokens.adapter.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { STORED_DERIVED_FACT_VERSIONS } from "../core/domain/snapshot/stored-derived-facts.ts";
import type { DerivedFacts } from "../core/ports/derived-facts.port.ts";
import type { SourceFile } from "../core/ports/entrypoint-extractor.port.ts";

const TS_FILE: SourceFile = { path: "src/a.ts", content: ["const fn = () => 1;", "export function run(list: Repo[]): void {", "  fn.call(undefined);", "  list.save();", "}", ""].join("\n") };
const JAVA_FILE: SourceFile = { path: "src/A.java", content: ["class A {", "  void run() { B b = new B(); b.go(); Runnable r = () -> run(); }", "}", ""].join("\n") };
const JAVA_TARGET: SourceFile = { path: "src/B.java", content: "class B { void go() {} }\n" };
const JAVA_CONTROLLER: SourceFile = { path: "src/main/java/app/Orders.java", content: ["package app;", "import org.springframework.web.bind.annotation.*;", "@RestController class Orders { @GetMapping(\"/orders\") void list() {} }", ""].join("\n") };
const JAVA_WEB_CONFIG: SourceFile = {
  path: "src/main/java/app/Web.java",
  content: [
    "package app;",
    "import org.springframework.boot.autoconfigure.SpringBootApplication;",
    "import org.springframework.context.annotation.PropertySource;",
    "import org.springframework.web.servlet.config.annotation.PathMatchConfigurer;",
    "import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;",
    "@SpringBootApplication @PropertySource(\"classpath:extra.properties\") class Web {",
    "  void configure(PathMatchConfigurer configurer, Object server) { configurer.addPathPrefix(\"/api\", type -> true); server.setContextPath(\"/shop\"); }",
    "  String key = \"server.servlet.context-path\";",
    "}",
    "class Mapping extends RequestMappingHandlerMapping {}",
    "",
  ].join("\n"),
};
const JAVA_CALLBACKS: SourceFile = {
  path: "src/main/java/app/Callbacks.java",
  content: [
    "package app;",
    "import com.netflix.graphql.dgs.DgsComponent;",
    "import com.netflix.graphql.dgs.DgsData;",
    "import org.springframework.context.annotation.Bean;",
    "import org.springframework.security.core.userdetails.UserDetailsService;",
    "import org.springframework.stereotype.Service;",
    "@DgsComponent class Graph { @DgsData(parentType = \"Query\") Object orders() { return null; } }",
    "class UsersBase { public Object loadUserByUsername(String name) { return null; } }",
    "@Service class Users extends UsersBase implements UserDetailsService {}",
    "@Service class Child extends Users {}",
    "@Service class Bare implements UserDetailsService {}",
    "@Service class Lonely extends Missing implements UserDetailsService {}",
    "class Anonymous { Object service = new UserDetailsService() {}; @Bean UserDetailsService bean() { return name -> null; } }",
    "",
  ].join("\n"),
};
const JAVA_AMBIGUOUS: SourceFile = { path: "src/main/java/app/Ambiguous.java", content: ["package app;", "import first.*;", "import second.*;", "class Ambiguous implements UserDetailsService {}", ""].join("\n") };
const PARAMETER: SourceFile = { path: "src/parameter.ts", content: ["export function run(redact: () => void): void {", "  redact();", "}", ""].join("\n") };
const DYNAMIC: SourceFile = { path: "src/dynamic.ts", content: ["export function run(): void {", "  eval('x');", "  helper();", "}", ""].join("\n") };
const WRITER: SourceFile = { path: "src/writer.ts", content: ["export {};", "(Array.prototype as any).last = () => 1;", ""].join("\n") };
const SCRIPT: SourceFile = { path: "src/script.ts", content: "var scriptGlobal = 1;\n" };
const IMPORTER: SourceFile = { path: "src/importer.ts", content: ["import Later from './later';", "import { gone } from './gone';", "export const used = Later;", ""].join("\n") };
const LATER: SourceFile = { path: "src/later.ts", content: "export default class Later {}\n" };

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
  "ts-module-statements": [1, "91ab9359a95e086f838319423bdedbe521677be9a9aeeeaa9559d89865c9aaa7"],
  "ts-default-declaration": [1, "bb5c1e3feab5ef3908224d5f2c0eabde6442b0d5202265d2d7b2f4aee3b13de8"],
  "java-receiver-bindings": [1, "90990e5ddeb91598c35caee6778aaeb4bcfbeca882230eda67aed1a064c6760d"],
  "java-declarations": [1, "c071c93f19ce4e2529f88d5ec16c4e6d215754db03c734a36c5eca20db082d54"],
  "java-relations": [1, "44a95dcd724d82e01cf726296313a3daebdeb01f5dda377fb39806c7dd0b85c7"],
  "java-entrypoints": [1, "3a63c07df1763ffeacea0e437ac9a1ada4f10d0de462ec6f50ca063ea72c1cb0"],
  "java-callbacks": [1, "31e796b313e5ab7c1a14d463c85c1e147f377e0585c86f8d0742b4d0fbc8eaf9"],
  "java-receiver-sites": [1, "a6a10152c6d15d73ae90cb581762317393860044cdc48be40a7f8ed1250657d0"],
  tokens: [1, "abdbd629965c9c2d3afecd0b502ffdea9e0015537dc77bee38e7c21f012cee3c"],
  "ts-module-resolutions": [1, "06babd9d9388578f4fac7b2d6655e24b5df82a7f5c1aa5b6d5dec0c70e1125c9"],
};

/** Facts that derive every value and tell `record` each one with the questions a derivation recorded. */
function recordingFacts(record: (slot: string, value: unknown) => void): DerivedFacts {
  return {
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
    async ofReads(slot, _subject, _answerNow, derive) {
      const reads: [string, string][] = [];
      const value = await derive((question, answer) => void reads.push([question, answer]));
      record(slot, { value, reads });
      return value;
    },
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, diskHits: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
}

async function derivedBySlot(): Promise<Record<string, [number, string]>> {
  const derived = new Map<string, unknown[]>();
  const record = (slot: string, value: unknown): void => void derived.set(slot, [...(derived.get(slot) ?? []), value]);
  const facts = recordingFacts(record);
  await createTypeScriptMemberNames().memberNames(TS_FILE, facts);
  await createJavaMemberNames(createJavaParser).memberNames(JAVA_FILE, facts);
  const origins = createImportOrigins([PARAMETER, DYNAMIC, WRITER, SCRIPT], { facts });
  await origins.rootOrigins([{ file: PARAMETER.path, line: 2, column: 3, kind: "calls", name: "redact" }, { file: DYNAMIC.path, line: 3, column: 3, kind: "calls", name: "helper" }]);
  await origins.replacedRoots();
  await createModuleDependenciesReader().extract([IMPORTER, LATER], { facts });
  await createJavaReceiverMethods(createJavaParser, [JAVA_FILE], [JAVA_FILE.path], facts)([{ file: JAVA_FILE.path, line: 2, column: 36, member: "go" }]);
  javaDeclarationIndex(facts, await createJavaParser(), [JAVA_FILE], { generatesInterfaces: false, unreadJvm: false });
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  const javaSources = [JAVA_FILE, JAVA_TARGET, JAVA_CONTROLLER, JAVA_WEB_CONFIG, JAVA_CALLBACKS, JAVA_AMBIGUOUS];
  const downstream = recordingFacts((slot, value) => slot === "java-declarations" || record(slot, value));
  await createJavaRelations(() => createJavaParser(holds)).extract(hold.keep(javaSources), { hold, facts: downstream });
  await createSpringRoutesExtractor(await createJavaParser(holds)).extract(hold.keep(javaSources), [], { hold, facts: downstream });
  const siteFacts = recordingFacts((slot, value) => slot === "java-receiver-sites" && record(slot, value));
  await createJavaReceiverMethods(() => createJavaParser(holds), javaSources, javaSources.map(({ path }) => path), siteFacts, hold)([{ file: JAVA_FILE.path, line: 2, column: 36, member: "go" }]);
  hold.release();
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
