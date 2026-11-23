import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { EntrypointExtraction, SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { FrameworkPlugin } from "../../ports/framework-plugin.port.ts";
import { keptOverReadSources } from "../snapshot/kept-over-read-sources.ts";

/** The slot the framework entrypoints are kept under by the contents they read (ADR-0153). */
export const FRAMEWORK_ENTRYPOINTS = "framework-entrypoints";

/**
 * The entrypoints every plugin that reads them contributes, in registration order; the caller sorts the union. With
 * `facts`, kept by the contents the plugins read (ADR-0153).
 */
export function frameworkEntrypoints(plugins: readonly FrameworkPlugin[], files: readonly SourceFile[], facts?: DerivedFacts): Promise<EntrypointExtraction> {
  return keptOverReadSources(facts, FRAMEWORK_ENTRYPOINTS, files, {}, async (read) => {
    const contributions = await Promise.all(plugins.flatMap((plugin) => (plugin.entrypoints === undefined ? [] : [plugin.entrypoints.extract(read)])));
    return { findings: contributions.flatMap((one) => one.findings), readingCuts: contributions.flatMap((one) => one.readingCuts) };
  });
}
