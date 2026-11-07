import { ANGULAR_LIFECYCLE_HOOKS } from "../../domain/relations/angular-class.ts";
import { placeAt } from "../../domain/impact/impact-cuts.ts";
import { joinsFact } from "../../domain/shared/code-node.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { RelationExtraction } from "../relations/relation-extractor.ts";
import type { PagePlan } from "./trace-walk.ts";

const TEMPLATE_RELATIONS: readonly string[] = ["uses-component", "uses-directive", "uses-pipe"];

/**
 * What a component runs as a page (RFC-0013 R9), from the relations: the framework's lifecycle hooks, the own methods its
 * template's event bindings call, and the declarations its template uses, in template order. A template that cannot be
 * read, a template item the relations could not place and a used declaration the index does not hold are cuts.
 * A class the relations know no template of has no plan.
 */
export function pagePlans(store: CodeGraphReader, relations: () => Promise<Pick<RelationExtraction, "relations" | "templates">>): (component: GraphSymbol) => Promise<PagePlan | undefined> {
  return async (component) => {
    const read = await relations();
    const template = read.templates?.find(({ component: ref }) => joinsFact(component, ref));
    if (template === undefined) return undefined;
    const cuts: Cut[] = template.unreadable === undefined ? [] : [{ kind: "unresolved-link", at: [placeAt(template.unreadable.path, template.unreadable.line)] }];
    const { lines } = template;
    const inTemplate = (at: { path: string; line: number } | undefined): boolean => lines !== undefined && at !== undefined && at.path === lines.path && lines.start <= at.line && at.line <= lines.end;
    const used: { symbol: GraphSymbol; line: number }[] = [];
    for (const finding of read.relations) {
      const at = finding.evidence[0];
      if (finding.status === "unknown") {
        if (inTemplate(at)) cuts.push({ kind: "unresolved-link", at: [placeAt(at!.path, at!.line)] });
        continue;
      }
      const { kind, from, to } = finding.value;
      if (!TEMPLATE_RELATIONS.includes(kind) || !joinsFact(component, from)) continue;
      const joined = store.symbolsInFiles([to.path]).filter((symbol) => joinsFact(symbol, to));
      if (joined.length === 1) used.push({ symbol: joined[0]!, line: at?.line ?? 0 });
      else cuts.push({ kind: "unresolved-link", at: [placeAt(at?.path ?? to.path, at?.line ?? to.line, to.symbol)] });
    }
    return {
      lifecycle: ANGULAR_LIFECYCLE_HOOKS,
      handlers: template.handlers,
      children: used.sort((a, b) => a.line - b.line).map(({ symbol }) => symbol),
      cuts,
    };
  };
}
