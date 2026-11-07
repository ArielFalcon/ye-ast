import type { DataEffect } from "./trace-fact.ts";

export interface DataEffectSite {
  file: string;
  line: number;
  effect: DataEffect | undefined;
}

export interface PlacedDataEffect {
  site: DataEffectSite;
  column?: number;
}

export interface DataEffectReader {
  placed(files: readonly { path: string; content: string }[]): Promise<readonly PlacedDataEffect[]>;
}
