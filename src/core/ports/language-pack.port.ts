import type { DeclaredMemberNamesReader } from "./declared-member-names.port.ts";
import type { ImportOriginsReader } from "./import-origins.port.ts";
import type { ModuleDependenciesReader } from "./module-dependencies.port.ts";
import type { SourceTrivia } from "./source-trivia.port.ts";

/**
 * One language's readers of the stage contracts two languages implement (ADR-0045 decision 12), built by composition from
 * that language's adapters. Every reader reads the whole snapshot and answers only the files of its language; the line
 * merges the packs in the order composition registers them.
 */
export interface LanguagePack {
  memberNames: DeclaredMemberNamesReader;
  origins: ImportOriginsReader;
  modules: ModuleDependenciesReader;
  trivia: SourceTrivia;
}
