import { createAngularPlugin } from "../core/adapters/frameworks/angular/angular.plugin.ts";
import { createAngularRoutesExtractor } from "../core/adapters/typescript/angular-routes.adapter.ts";
import { createAngularConsumerSyntax } from "../core/adapters/typescript/angular-consumer-syntax.ts";
import { createRxjsPlugin } from "../core/adapters/frameworks/rxjs/rxjs.plugin.ts";
import { createSignalsStorePlugin } from "../core/adapters/typescript/signals-store.adapter.ts";
import type { FrameworkPlugin } from "../core/ports/framework-plugin.port.ts";
import { angularProviderContribution } from "../core/adapters/typescript/angular-provider-values.ts";

/** Every framework plugin, each over the readers of its language it wraps: the one place a plugin is registered. */
export function composeFrameworkPlugins(): readonly FrameworkPlugin[] {
  return [createAngularPlugin({ routes: createAngularRoutesExtractor, consumer: createAngularConsumerSyntax, values: angularProviderContribution }), createSignalsStorePlugin(), createRxjsPlugin()];
}
