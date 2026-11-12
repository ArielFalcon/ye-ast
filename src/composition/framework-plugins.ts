import { createAngularPlugin } from "../core/adapters/frameworks/angular/angular.plugin.ts";
import { createAngularRoutesExtractor } from "../core/adapters/typescript/angular-routes.adapter.ts";
import { createAngularConsumerSyntax } from "../core/adapters/typescript/angular-consumer-syntax.ts";
import { createSignalsStorePlugin } from "../core/adapters/typescript/signals-store.adapter.ts";
import type { EntrypointExtraction, SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import type { FrameworkPlugin } from "../core/ports/framework-plugin.port.ts";
import { angularProviderContribution } from "../core/adapters/typescript/angular-provider-values.ts";

/** Every framework plugin, each over the readers of its language it wraps: the one place a plugin is registered. */
export function composeFrameworkPlugins(): readonly FrameworkPlugin[] {
  return [createAngularPlugin({ routes: createAngularRoutesExtractor, consumer: createAngularConsumerSyntax, values: angularProviderContribution }), createSignalsStorePlugin()];
}

/** The entrypoints every plugin that reads them contributes, in registration order; the caller sorts the union. */
export async function frameworkEntrypoints(plugins: readonly FrameworkPlugin[], files: readonly SourceFile[]): Promise<EntrypointExtraction> {
  const contributions = await Promise.all(plugins.flatMap((plugin) => (plugin.entrypoints === undefined ? [] : [plugin.entrypoints.extract(files)])));
  return { findings: contributions.flatMap((one) => one.findings), readingCuts: contributions.flatMap((one) => one.readingCuts) };
}
