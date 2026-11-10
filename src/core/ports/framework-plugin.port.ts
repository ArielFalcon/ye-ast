import type { LanguageProfile } from "../domain/languages/profiles.ts";
import type { EntrypointExtractor } from "./entrypoint-extractor.port.ts";
import type { AbsentCapability } from "./language-pack.port.ts";

/** Where a framework applies (ADR-0045 decision 12), read from the snapshot as data, never from a file extension. */
export interface FrameworkSignal {
  /** Project level: the package whose dependency in the nearest manifest puts that manifest's sources under the plugin. */
  dependency: string;
  /** File level: the module whose imports are a file's references to the framework. */
  module: string;
}

/**
 * One framework's readers of the stage contracts it extends (ADR-0045 decision 12), built by composition and registered
 * there in one place. It reads the outputs of the packs of its languages and owns no path.
 */
export interface FrameworkPlugin {
  languages: readonly LanguageProfile["language"][];
  signal: FrameworkSignal;
  /** The stages it claims and cannot read, in the packs' vocabulary: the line answers `capability-absent` for them. */
  absent?: readonly AbsentCapability[];
  entrypoints?: EntrypointExtractor;
}
