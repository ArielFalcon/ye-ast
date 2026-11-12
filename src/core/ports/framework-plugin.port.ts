import type { LanguageProfile } from "../domain/languages/profiles.ts";
import type { EntrypointExtractor } from "./entrypoint-extractor.port.ts";
import type { AbsentCapability } from "./language-pack.port.ts";
import type { ConsumerContributionFactory } from "./consumer-contribution.port.ts";
import type { FrameworkSignal } from "./framework-signal.port.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";
import type { FrameworkMemberBindings } from "./framework-members.port.ts";
import type { FrameworkValueFactory } from "./framework-values.port.ts";
import type { FrameworkValueCells } from "./framework-cells.port.ts";
export type { FrameworkSignal } from "./framework-signal.port.ts";

/**
 * One framework's readers of the stage contracts it extends (ADR-0045 decision 12), built by composition and registered
 * there in one place. It reads the outputs of the packs of its languages and owns no path.
 */
export interface FrameworkPlugin {
  languages: readonly LanguageProfile["language"][];
  signal: FrameworkSignal;
  /** The stages it claims and cannot read, in the packs' vocabulary: the line answers `capability-absent` for them. */
  absent?: readonly (AbsentCapability | "consumer")[];
  entrypoints?: EntrypointExtractor;
  consumer?: ConsumerContributionFactory;
  members?: (sources: readonly SourceFile[]) => FrameworkMemberBindings;
  values?: FrameworkValueFactory;
  cells?: FrameworkValueCells;
}
