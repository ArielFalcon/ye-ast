import type { FlowResult } from "../../domain/contracts/consumer-flow.ts";
import type { AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import type { ConsumerTemplateReader } from "../../ports/consumer-template.port.ts";
import type { TemplateFlowReader } from "../../ports/consumer-template-flow.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { TemplateUnit, TemplateUsageReader } from "../../ports/template-usage.port.ts";
import { createAngularRelationExtractor } from "../relations/angular-relations.ts";

export interface ConsumerTemplatesDeps {
  metadata: AngularMetadataReader;
  flow: TemplateFlowReader;
}

/**
 * Follows a component member into the template of its owner. The templates and their scopes are the units the Angular
 * relation extractor builds for the same sources; a component whose template is missing or unreadable has no unit and
 * is a frontier.
 */
export async function createConsumerTemplateReader(deps: ConsumerTemplatesDeps, files: readonly SourceFile[]): Promise<ConsumerTemplateReader> {
  let units: readonly TemplateUnit[] = [];
  const recorder: TemplateUsageReader = {
    read: (found) => {
      units = found;
      return [];
    },
    effects: () => ({ calls: [], writes: [], passed: [] }),
  };
  await createAngularRelationExtractor({ metadata: deps.metadata, templates: recorder }).extract(files);
  return {
    follow(carrier) {
      const { site } = carrier;
      const unit = units.find(({ component }) => component.path === site.file && component.symbol === site.owner);
      return unit === undefined ? unreadable(site.file, site.line ?? 1) : deps.flow.follow(unit, carrier);
    },
  };
}

function unreadable(path: string, line: number): FlowResult {
  return { uses: [], next: [], frontiers: [{ at: { path, line }, cause: "template-unreadable", reason: "source-unreadable", hops: [] }] };
}
