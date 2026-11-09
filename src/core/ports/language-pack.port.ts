import type { LanguageProfile } from "../domain/languages/profiles.ts";
import type { DeclaredMemberNamesReader } from "./declared-member-names.port.ts";
import type { ImportOriginsReader } from "./import-origins.port.ts";
import type { ModuleDependenciesReader } from "./module-dependencies.port.ts";
import type { SourceTokens } from "./source-tokens.port.ts";

/**
 * One language's readers of the stage contracts two languages implement (ADR-0045 decision 12), built by composition from
 * that language's adapters. The line hands each reader only the sites, files and sources of the paths its profile reads,
 * so a reader never tells its language's files apart itself.
 */
/** The stage contracts a pack may declare it cannot implement: the line answers each site `capability-absent` for it. */
export type AbsentCapability = "dispatchTargets" | "receiverMethods" | "tokens";

export interface LanguagePack {
  profile: LanguageProfile;
  /** The stages its readers cannot answer for its sources (ADR-0045 decision 12); the line never asks them there. */
  absent?: readonly AbsentCapability[];
  /** Whether it also reads the project's files no pack owns: manifests, configurations, declarations, resources. */
  readsProjectFiles?: true;
  memberNames: DeclaredMemberNamesReader;
  /** Over the pack's sources, with every path of the snapshot, which its proofs may read. */
  origins: ImportOriginsReader;
  modules: ModuleDependenciesReader;
  /** The B11 tokens of its sources; absent where the pack cannot tokenize them (ADR-0043 decision 9). */
  tokens?: SourceTokens;
}
