import { compareText } from "../shared/code-node.ts";
import type { DataEffect } from "./trace-fact.ts";
import type { Between } from "../shared/work-units.ts";

/** Why a call that is a data operation could not be placed as one. */
export type UnplacedCause = "mapper-statement-absent" | "mapper-statement-ambiguous";

export interface DataEffectSite {
  file: string;
  line: number;
  effect: DataEffect | undefined;
  cause?: UnplacedCause;
}

export interface PlacedDataEffect {
  site: DataEffectSite;
  column?: number;
}

export interface DataEffectReader {
  /** `between` is awaited between the reading's bounded units, as `LibraryCallSiteOptions.between` (ADR-0156). */
  placed(files: readonly { path: string; content: string }[], options?: { between?: Between }): Promise<readonly PlacedDataEffect[]>;
}

type Placement = { site: { file: string; line: number }; column?: number };

export function comparePlacement(a: Placement, b: Placement): number {
  return compareText(a.site.file, b.site.file) || a.site.line - b.site.line || (a.column ?? 0) - (b.column ?? 0);
}
