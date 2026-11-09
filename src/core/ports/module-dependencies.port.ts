import type { ModuleDependencies } from "../domain/impact/module-dependency.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

export interface ModuleDependenciesReader {
  /**
   * The module statements of the sources, resolved against all of them. With `files`, only the statements of those
   * files are read; without it, those of every source. With `listing`, every path of the snapshot, a specifier no
   * listed path could be the target of carries `namesNoFile`; without it, none does.
   */
  extract(sources: readonly SourceFile[], options?: { files?: readonly string[]; listing?: readonly string[] }): Promise<ModuleDependencies>;
}
