import { createAngularPlugin } from "../core/adapters/frameworks/angular/angular.plugin.ts";
import { createAngularRoutesExtractor } from "../core/adapters/typescript/angular-routes.adapter.ts";
import { createAngularConsumerSyntax } from "../core/adapters/typescript/angular-consumer-syntax.ts";
import { createRxjsPlugin } from "../core/adapters/frameworks/rxjs/rxjs.plugin.ts";
import { createSignalsStorePlugin } from "../core/adapters/typescript/signals-store.adapter.ts";
import type { EntrypointExtraction, SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import type { FrameworkPlugin } from "../core/ports/framework-plugin.port.ts";
import { angularProviderContribution } from "../core/adapters/typescript/angular-provider-values.ts";
import { keptOverReadSources } from "../core/application/snapshot/kept-over-read-sources.ts";
import type { DerivedFacts } from "../core/ports/derived-facts.port.ts";

/** The slot the framework entrypoints are kept under by the contents they read (ADR-0153). */
export const FRAMEWORK_ENTRYPOINTS = "framework-entrypoints";

/** Every framework plugin, each over the readers of its language it wraps: the one place a plugin is registered. */
export function composeFrameworkPlugins(): readonly FrameworkPlugin[] {
  return [createAngularPlugin({ routes: createAngularRoutesExtractor, consumer: createAngularConsumerSyntax, values: angularProviderContribution }), createSignalsStorePlugin(), createRxjsPlugin()];
}

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
