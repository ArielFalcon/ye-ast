import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";

/** One reader of module statements over readers of one language each: what every reader reads, in the readers' order. */
export function combinedModuleReader(readers: readonly ModuleDependenciesReader[]): ModuleDependenciesReader {
  return {
    async extract(sources, options): Promise<ModuleDependencies> {
      const reads = await Promise.all(readers.map((reader) => reader.extract(sources, options)));
      return {
        files: reads.flatMap((read) => read.files),
        dependencies: reads.flatMap((read) => read.dependencies),
        unread: reads.flatMap((read) => read.unread),
        untraversed: reads.flatMap((read) => read.untraversed ?? []),
      };
    },
  };
}
