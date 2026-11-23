import { test } from "node:test";
import assert from "node:assert/strict";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { javaDeclarationIndex } from "../core/adapters/spring/java-declaration-index.ts";
import { createJavaImportsReader } from "../core/adapters/spring/java-imports.adapter.ts";
import { createJavaNameBindings } from "../core/adapters/spring/java-name-bindings.adapter.ts";
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
const JAVA_SPACED: SourceFile = { path: "src/main/java/app/Spaced.java", content: ["package app;", "class Spaced implements app . Port, app.", "    Store { Object o = new java . lang . Thread() {}; }", ""].join("\n") };
const JAVA_AMBIGUOUS: SourceFile = { path: "src/main/java/app/Ambiguous.java", content: ["package app;", "import first.*;", "import second.*;", "class Ambiguous implements UserDetailsService {}", ""].join("\n") };
const JAVA_ENUM: SourceFile = { path: "src/main/java/app/Unit.java", content: ["package app;", "enum Unit {", "  ONE {", "    int area() { return 1; }", "  };", "  int area() { return 2; }", "}", ""].join("\n") };
const JAVA_CHAINS: SourceFile = { path: "src/main/java/app/Chains.java", content: ["package app;", "class Parent { Parent() {} }", "class Child extends Parent {}", "class Plain {}", "class Sub extends Plain {}", "class Sized { Sized(int size) {} }", "class Big extends Sized {}", "class Orphan extends Missing {}", ""].join("\n") };
const JAVA_COUNTS: SourceFile = { path: "src/main/java/app/Counts.java", content: ["package app;", "class Tool {", "  Tool(int size) {}", "  void use(String... names) {}", "  void use(int a, int b) {}", "}", "class User { void run(Tool tool) { tool.use(1, 2); new Tool(3); tool.use(\"a\").use(\"b\"); } }", ""].join("\n") };
const JAVA_IMPLEMENTS: SourceFile = { path: "src/main/java/app/Implements.java", content: ["package app;", "interface Store {", "  void save(String value);", "}", "class Disk implements Store {", "  public void save(String value) {}", "  <T> void generic(T value) {}", "}", "class Tool {", "  void use() {}", "}", ""].join("\n") };
const JAVA_FITS: SourceFile = { path: "src/main/java/app/Fits.java", content: ["package app;", "interface Mapper<S, T> { T convert(S source); }", "class Tax {}", "class Rate {}", "class Cat {}", "class TaxMapper implements Mapper<Tax, Rate> {", "  public Rate convert(Tax source) { return null; }", "}", "class Other { Mapper<Cat, Rate> mapper; void run() { mapper.convert(null); } }", "class Same { Mapper<Tax, Rate> mapper; void run() { mapper.convert(null); } }", ""].join("\n") };
const JAVA_IMPORTS: SourceFile = { path: "src/main/java/app/Imports.java", content: ["package app;", "import app.Orders;", "import static app.Orders.LIMIT;", "import app.*;", "import java.util.List;", "import com.acme.Missing;", "class Imports {}", ""].join("\n") };
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
  "java-declarations": [3, "59a853a37051542aa9e4d64ea5e394852d0052252bfd57bff9ea9ac6ccdd9b5e"],
  "java-relations": [1, "44a95dcd724d82e01cf726296313a3daebdeb01f5dda377fb39806c7dd0b85c7"],
  "java-entrypoints": [1, "3a63c07df1763ffeacea0e437ac9a1ada4f10d0de462ec6f50ca063ea72c1cb0"],
  "java-callbacks": [1, "31e796b313e5ab7c1a14d463c85c1e147f377e0585c86f8d0742b4d0fbc8eaf9"],
  "java-receiver-sites": [1, "a6a10152c6d15d73ae90cb581762317393860044cdc48be40a7f8ed1250657d0"],
  "java-argument-counts": [1, "470a1bdbb5025f531531f3b6c7e47a35c2060b9f9e79b42e8c51156198208b84"],
  "java-import-statements": [1, "fe7cb1f88d1be1da7a34da4ce94417c360d8c286d8c4ae1a0b09b70e33907a7d"],
  "java-import-targets": [1, "e12ac75e3999be57bad6e62ca2ace609ff5e43d3d9d763e0114f7a52feea4519"],
  "java-accepted-counts": [1, "46a2118d21d79f7565b33d6bc4f95c5eb8fe796382fc6f1ba47c07bf438926a7"],
  "java-receiver-fits": [1, "e0663b4d88d03a139c713cd0a2bdf4432899622d600fed98ed81a6e15da70934"],
  "java-implemented-declarations": [1, "1548f363531649fe08135d3449aec499e77c24649017b3076b1f9e6beb097297"],
  "java-implicit-chains": [1, "851729aee28f2536adf62614a5323d7ab2d36bc6c7be23a6a052cd7ee4eca1fb"],
  "java-declared-supertypes": [1, "b8ae346f455499547b6d9b411349b1f46826c212414f75bcccd21caa3d56d95c"],
  "java-root-origins": [1, "b143a99258135457f3739eb131887755ec6e559865bafe4b9ed73554922d3050"],
  "java-root-bindings": [1, "2c10462e845e2c3348bccdf8c552f52edd4625b9c6f3410dd699f93952d90813"],
  "java-declared-types": [1, "ca83ebbb6ddfc18a3e70166b58a6fb5dee2b93f159d2289c6d7b48af2deb8142"],
  "java-opens-platform-types": [1, "61693a10663b507ea9b8a64be73d0bf9ad1ecf7181ceb9edd763eb65e2b32763"],
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
  javaDeclarationIndex(facts, await createJavaParser(), [JAVA_FILE, JAVA_SPACED], { generatesInterfaces: false, unreadJvm: false });
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  const javaSources = [JAVA_FILE, JAVA_TARGET, JAVA_CONTROLLER, JAVA_WEB_CONFIG, JAVA_CALLBACKS, JAVA_AMBIGUOUS];
  const downstream = recordingFacts((slot, value) => slot === "java-declarations" || record(slot, value));
  await createJavaRelations(() => createJavaParser(holds)).extract(hold.keep(javaSources), { hold, facts: downstream });
  await createSpringRoutesExtractor(await createJavaParser(holds)).extract(hold.keep(javaSources), [], { hold, facts: downstream });
  const siteFacts = recordingFacts((slot, value) => slot === "java-receiver-sites" && record(slot, value));
  await createJavaReceiverMethods(() => createJavaParser(holds), javaSources, javaSources.map(({ path }) => path), siteFacts, hold)([{ file: JAVA_FILE.path, line: 2, column: 36, member: "go" }]);
  const supertypeSources = [...javaSources, JAVA_ENUM];
  const supertypeFacts = recordingFacts((slot, value) => slot === "java-declared-supertypes" && record(slot, value));
  const at = (file: SourceFile, name: string) => ({ file: file.path, line: file.content.split("\n").findIndex((text) => new RegExp(`class ${name}\\b`).test(text)) + 1, name });
  await createJavaNameBindings(() => createJavaParser(holds), supertypeSources, supertypeSources.map(({ path }) => path), supertypeFacts, hold).declaredSupertypes!([at(JAVA_CALLBACKS, "Users"), at(JAVA_CALLBACKS, "Lonely"), at(JAVA_AMBIGUOUS, "Ambiguous"), { file: JAVA_ENUM.path, line: 3, name: "ONE" }, { file: JAVA_CALLBACKS.path, line: 1, name: "Nowhere" }]);
  const chainSources = [...javaSources, JAVA_CHAINS];
  const chainFacts = recordingFacts((slot, value) => slot === "java-implicit-chains" && record(slot, value));
  await createJavaNameBindings(() => createJavaParser(holds), chainSources, chainSources.map(({ path }) => path), chainFacts, hold).implicitChains!(["Child", "Sub", "Big", "Orphan", "Parent"].map((name) => at(JAVA_CHAINS, name)));
  const countSources = [...javaSources, JAVA_COUNTS];
  const countFacts = recordingFacts((slot, value) => (slot === "java-argument-counts" || slot === "java-accepted-counts") && record(slot, value));
  const counting = createJavaNameBindings(() => createJavaParser(holds), countSources, countSources.map(({ path }) => path), countFacts, hold);
  const written = JAVA_COUNTS.content.split("\n")[6]!;
  const call = (text: string, member: string) => ({ file: JAVA_COUNTS.path, line: 7, column: written.indexOf(text) + 1, member });
  await counting.argumentCounts!([call("tool.use(1, 2)", "use"), call("new Tool(3)", "Tool"), call("tool.use(\"a\")", "use")]);
  await counting.acceptedCounts!([{ file: JAVA_COUNTS.path, start: 3, name: "Tool" }, { file: JAVA_COUNTS.path, start: 4, name: "use" }, { file: JAVA_COUNTS.path, start: 5, name: "use" }, { file: JAVA_COUNTS.path, start: 9, name: "none" }]);
  const implementSources = [...javaSources, JAVA_IMPLEMENTS];
  const implementFacts = recordingFacts((slot, value) => slot === "java-implemented-declarations" && record(slot, value));
  await createJavaNameBindings(() => createJavaParser(holds), implementSources, implementSources.map(({ path }) => path), implementFacts, hold).implementedDeclarations!([[6, "save"], [7, "generic"], [10, "use"], [99, "none"]].map(([start, name]) => ({ file: JAVA_IMPLEMENTS.path, start: start as number, name: name as string })));
  const fitSources = [...javaSources, JAVA_FITS];
  const fitFacts = recordingFacts((slot, value) => slot === "java-receiver-fits" && record(slot, value));
  const fitCall = (line: number) => ({ file: JAVA_FITS.path, line, column: JAVA_FITS.content.split("\n")[line - 1]!.indexOf("mapper.convert") + 1, member: "convert", implementation: { file: JAVA_FITS.path, start: 7, name: "convert" } });
  await createJavaNameBindings(() => createJavaParser(holds), fitSources, fitSources.map(({ path }) => path), fitFacts, hold).receiverFits!([fitCall(9), fitCall(10)]);
  const importFacts = recordingFacts((slot, value) => (slot === "java-import-statements" || slot === "java-import-targets") && record(slot, value));
  await createJavaImportsReader(await createJavaParser()).extract([...javaSources, JAVA_IMPORTS], { facts: importFacts });
  const rootFacts = recordingFacts((slot, value) => slot === "java-root-origins" && record(slot, value));
  const rootSite = (file: SourceFile, line: number, written: string, kind: "calls" | "instantiates", name: string) => ({ file: file.path, line, column: file.content.split("\n")[line - 1]!.indexOf(written) + 1, kind, name });
  await createJavaNameBindings(() => createJavaParser(holds), javaSources, javaSources.map(({ path }) => path), rootFacts, hold).rootOrigins([rootSite(JAVA_FILE, 2, "new B()", "instantiates", "B"), rootSite(JAVA_FILE, 2, "b.go()", "calls", "go"), rootSite(JAVA_TARGET, 1, "go", "calls", "go")]);
  const bindingFacts = recordingFacts((slot, value) => slot === "java-root-bindings" && record(slot, value));
  const useSite = (written: string, spelled: string) => ({ file: JAVA_FILE.path, line: 2, column: JAVA_FILE.content.split("\n")[1]!.indexOf(written) + 1, spelled, owner: { name: "run", line: 2, endLine: 2 } });
  await createJavaNameBindings(() => createJavaParser(holds), javaSources, javaSources.map(({ path }) => path), bindingFacts, hold).rootBindings([useSite("new B()", "B"), useSite("b.go()", "b"), useSite("Runnable", "Runnable")]);
  const typedFacts = recordingFacts((slot, value) => (slot === "java-declared-types" || slot === "java-opens-platform-types") && record(slot, value));
  const typed: SourceFile = { path: "src/main/java/app/Typed.java", content: "package app;\nimport java.util.List;\nclass Typed { void run(List<String> items, Object other) {} }\n" };
  const typedSite = (spelled: string) => ({ file: typed.path, line: 3, column: typed.content.split("\n")[2]!.indexOf(spelled) + 1, spelled, owner: { name: "run", line: 3, endLine: 3 } });
  for (const typedSources of [[JAVA_TARGET, typed], [JAVA_TARGET, typed, JAVA_FILE]]) await createJavaNameBindings(() => createJavaParser(holds), typedSources, typedSources.map(({ path }) => path), typedFacts, hold).declaredTypes([typedSite("List"), typedSite("Object")]);
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
