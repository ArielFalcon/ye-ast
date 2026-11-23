import type { PlacedDataEffect } from "../domain/trace/data-effect-site.ts";
import type { Between } from "../domain/shared/work-units.ts";
import type { DerivedFacts } from "./derived-facts.port.ts";
import type { SourceFile } from "./source-file.port.ts";

export interface DataEffectReader {
  /**
   * `between` is awaited between the reading's bounded units, as `LibraryCallSiteOptions.between` (ADR-0156); `facts`
   * keeps what the reading derives from one file alone by that file's path and content (ADR-0159).
   */
  placed(files: readonly SourceFile[], options?: { between?: Between; facts?: DerivedFacts }): Promise<readonly PlacedDataEffect[]>;
}
