import type { UnresolvedUse } from "../domain/impact/impact-cuts.ts";
import type { Relation } from "../domain/relations/relation.ts";
import type { Cut, Finding } from "../domain/shared/fact.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";
import type { ParseHold } from "./parse-holds.port.ts";
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
export type AbsentCapability = "dispatchTargets" | "receiverMethods" | "tokens" | "relations";

export interface LanguagePack {
  profile: LanguageProfile;
  /** The stages its readers cannot answer for its sources (ADR-0045 decision 12); the line never asks them there. */
  absent?: readonly AbsentCapability[];
  /** Whether it also reads the project's files no pack owns: manifests, configurations, declarations, resources. */
  readsProjectFiles?: true;
  /** The files, of those no pack owns, that state facts about the pack's build: the readers of origins and relations receive them as context, not as sources. */
  contextFiles?: (path: string) => boolean;
  memberNames: DeclaredMemberNamesReader;
  /** Over the pack's sources, with every path of the snapshot, which its proofs may read. */
  origins: ImportOriginsReader;
  modules: ModuleDependenciesReader;
  /** B4 relations over the same held sources and complete path universe as the other language stages. */
  relations?: LanguageRelationsReader;
  /** The B11 tokens of its sources; absent where the pack cannot tokenize them (ADR-0043 decision 9). */
  tokens?: SourceTokens;
}

export interface LanguageRelations {
  relations: readonly Finding<Relation>[];
  cuts: readonly Cut[];
  unresolved: readonly UnresolvedUse[];
}

export interface LanguageRelationsReader {
  /** `context`: the files the pack's `contextFiles` selects, which state its build and are never read as sources. */
  extract(sources: readonly SourceFile[], options?: { paths?: readonly string[]; completeSource?: boolean; hold?: ParseHold; signal?: AbortSignal; context?: readonly SourceFile[] }): Promise<LanguageRelations>;
}
