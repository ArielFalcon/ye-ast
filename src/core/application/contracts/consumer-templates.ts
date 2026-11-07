import { NO_FLOW, sourceUnreadable, templateUnreadable } from "../../domain/contracts/consumer-flow.ts";
import type { AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import type { ConsumerTemplateReader } from "../../ports/consumer-template.port.ts";
import type { TemplateFlowReader } from "../../ports/consumer-template-flow.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { TemplateUnit } from "../../ports/template-usage.port.ts";
import { templateUnitsOf } from "../relations/angular-relations.ts";

export interface ConsumerTemplatesDeps {
  metadata: AngularMetadataReader;
  flow: TemplateFlowReader;
}

/**
 * Follows a component member into the template of its owner, and the result of a component method called from a
 * template back to the expression that called it. The templates and their scopes are the units the Angular relation
 * extractor builds for the same sources. A class that is not a component has no template to follow; a component whose
 * template is missing or unreadable is a frontier at the component.
 */
export async function createConsumerTemplateReader(deps: ConsumerTemplatesDeps, files: readonly SourceFile[]): Promise<ConsumerTemplateReader> {
  const { classes } = await deps.metadata.read(files);
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const units = templateUnitsOf(classes, contents).units.map((unit) => placed(unit, contents));
  return {
    follow(carrier) {
      const { site } = carrier;
      if (site.kind === "template-call-result") {
        const unit = unitAt(units, site.resource, site.start);
        return unit === undefined ? sourceUnreadable(site) : deps.flow.follow(unit, { site, path: carrier.path });
      }
      const unit = units.find(({ component }) => component.path === site.file && component.symbol === site.owner);
      if (unit !== undefined) return deps.flow.follow(unit, { site, path: carrier.path });
      const component = classes.find((candidate) => candidate.kind === "component" && candidate.ref.path === site.file && candidate.ref.symbol === site.owner);
      return component === undefined ? NO_FLOW : templateUnreadable({ path: component.ref.path, line: component.ref.line });
    },
  };
}

/** A template written in the component's own file starts at its first line; a file of its own starts at its beginning. */
function placed(unit: TemplateUnit, contents: ReadonlyMap<string, string>): TemplateUnit {
  const inline = unit.path === unit.component.path;
  return inline ? { ...unit, offset: lineStart(contents.get(unit.path) ?? "", unit.firstLine) } : unit;
}

function lineStart(text: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}

function unitAt(units: readonly TemplateUnit[], resource: string, start: number): TemplateUnit | undefined {
  const candidates = units.filter((unit) => unit.path === resource && (unit.offset ?? 0) <= start && start < (unit.offset ?? 0) + unit.text.length);
  return candidates.reduce<TemplateUnit | undefined>((nearest, unit) => ((unit.offset ?? 0) >= (nearest?.offset ?? 0) ? unit : nearest), undefined);
}
