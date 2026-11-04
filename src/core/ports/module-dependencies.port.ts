import type { ModuleDependencies } from "../domain/impact/module-dependency.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

export interface ModuleDependenciesReader {
  extract(sources: readonly SourceFile[]): Promise<ModuleDependencies>;
}
