import { createJavaRelations } from "../core/adapters/spring/java-relations.adapter.ts";
import { createJavaNameBindings } from "../core/adapters/spring/java-name-bindings.adapter.ts";
import type { JavaParser } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createJavaMemberNames } from "../core/adapters/tree-sitter/java-member-names.adapter.ts";
import { createJavaTokens } from "../core/adapters/tree-sitter/java-tokens.adapter.ts";
import { createTypeScriptMemberNames } from "../core/adapters/typescript/declared-member-names.adapter.ts";
import { createImportOrigins } from "../core/adapters/typescript/import-origins.adapter.ts";
import { createTypeScriptTokens } from "../core/adapters/typescript/source-tokens.adapter.ts";
import { JAVA_PROFILE, TYPESCRIPT_PROFILE } from "../core/domain/languages/profiles.ts";
import type { LanguagePack } from "../core/ports/language-pack.port.ts";
import type { ModuleDependenciesReader } from "../core/ports/module-dependencies.port.ts";

/** The TypeScript and Java packs, in the order the line routes them, over each language's reader of module statements. */
export function composeLanguagePacks(javaParser: () => Promise<JavaParser>, modules: { typescript: ModuleDependenciesReader; java: ModuleDependenciesReader }): readonly LanguagePack[] {
  return [
    { profile: TYPESCRIPT_PROFILE, readsProjectFiles: true, absent: ["dispatchTargets", "receiverMethods"], memberNames: createTypeScriptMemberNames(), origins: (sources, _paths, facts) => createImportOrigins(sources, facts === undefined ? {} : { facts }), modules: modules.typescript, tokens: createTypeScriptTokens() },
    { profile: JAVA_PROFILE, relations: createJavaRelations(javaParser), memberNames: createJavaMemberNames(javaParser), origins: (sources, paths, facts, hold) => createJavaNameBindings(javaParser, sources, paths, facts, hold), modules: modules.java, tokens: createJavaTokens(javaParser) },
  ];
}
