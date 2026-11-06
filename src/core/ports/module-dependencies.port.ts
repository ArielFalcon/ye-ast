import type { ModuleDependencies } from "../domain/impact/module-dependency.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

export interface ModuleDependenciesReader {
  /**
   * The module statements of the sources, resolved against all of them. With `files`, only the statements of those
   * files are read; without it, those of every source.
   */
  extract(sources: readonly SourceFile[], options?: { files?: readonly string[] }): Promise<ModuleDependencies>;
}
