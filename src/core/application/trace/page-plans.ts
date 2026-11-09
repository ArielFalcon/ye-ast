import { ANGULAR_LIFECYCLE_HOOKS } from "../../domain/relations/angular-class.ts";
import { placeAt } from "../../domain/impact/impact-cuts.ts";
import { joinsFact } from "../../domain/shared/code-node.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import { comparePositions } from "../../domain/shared/owning-body.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { RelationExtraction } from "../relations/relation-extractor.ts";
import type { TemplateEventCall } from "../../ports/template-usage.port.ts";
import type { PagePlan } from "./trace-walk.ts";

const refKey = (ref: { path: string; symbol: string; line: number }): string => JSON.stringify([ref.path, ref.symbol, ref.line]);
const placeKey = (file: string, line: number, column: number): string => JSON.stringify([file, line, column]);

const TEMPLATE_RELATIONS: readonly string[] = ["uses-component", "uses-directive", "uses-pipe"];

/** A place of a page's template its plan cannot order: a call there may run anything. */
function unplannedAt(place: string): Cut {
  return { kind: "unresolved-link", at: [place], reason: "page-unplanned", reach: { kind: "call-at", place } };
}

/**
 * What a component runs as a page (RFC-0013 R9), from the relations: the framework's lifecycle hooks, what its template's
 * render expressions and event bindings call, and the declarations its template uses, in template order. A template call
 * is an own method, or a method the relations prove the call runs (a field's, `store.save()`); any other is a cut at the
 * binding, as are a
 * template that cannot be read, a template item the relations could not place and a used declaration the index does not hold.
 * A class the relations know no template of has no plan.
 */
export function pagePlans(store: CodeGraphReader, relations: () => Promise<Pick<RelationExtraction, "relations" | "templates" | "memberUses">>): (component: GraphSymbol) => Promise<PagePlan | undefined> {
  return async (component) => {
    const read = await relations();
    const template = read.templates?.find(({ component: ref }) => joinsFact(component, ref));
    if (template === undefined) return undefined;
    const cuts: Cut[] = template.unreadable === undefined ? [] : [unplannedAt(placeAt(template.unreadable.path, template.unreadable.line))];
    const { lines } = template;
    const inTemplate = (at: { path: string; line: number } | undefined): boolean => lines !== undefined && at !== undefined && at.path === lines.path && lines.start <= at.line && at.line <= lines.end;
    const order = new Map(template.uses.map((ref, index) => [refKey(ref), index]));
    const used: { symbol: GraphSymbol; rank: number; line: number }[] = [];
    for (const finding of read.relations) {
      const at = finding.evidence[0];
      if (finding.status === "unknown") {
        if (inTemplate(at)) cuts.push(unplannedAt(placeAt(at!.path, at!.line)));
        continue;
      }
      const { kind, from, to } = finding.value;
      if (!TEMPLATE_RELATIONS.includes(kind) || !joinsFact(component, from)) continue;
      const joined = store.symbolsInFiles([to.path]).filter((symbol) => joinsFact(symbol, to));
      if (joined.length === 1) used.push({ symbol: joined[0]!, rank: order.get(refKey(to)) ?? -1, line: at?.line ?? 0 });
      else cuts.push(unplannedAt(placeAt(at?.path ?? to.path, at?.line ?? to.line, to.symbol)));
    }
    const proven = Map.groupBy((read.memberUses ?? []).filter((use) => use.template === true), ({ reference }) => placeKey(reference.file, reference.line, reference.column));
    const settledCalls = (calls: readonly TemplateEventCall[]) => calls.flatMap((call): PagePlan["handlers"][number][] => {
      const proofs = proven.get(placeKey(call.file, call.line, call.column)) ?? [];
      const runs = proofs.length === 1 && proofs[0]!.substitutes === undefined ? store.symbolsInFiles([proofs[0]!.member.path]).filter((symbol) => symbol.kind === "method" && joinsFact(symbol, proofs[0]!.member)) : [];
      if (runs.length === 1) return [{ file: call.file, line: call.line, column: call.column, runs: runs[0]! }];
      cuts.push(unplannedAt(placeAt(call.file, call.line, call.name)));
      return [];
    });
    return {
      lifecycle: ANGULAR_LIFECYCLE_HOOKS,
      render: [...template.renderHandlers ?? [], ...settledCalls(template.renderCalls ?? [])].sort(comparePositions),
      handlers: [...template.handlers, ...settledCalls(template.eventCalls)].sort(comparePositions),
      children: used.sort((a, b) => a.rank - b.rank || a.line - b.line).map(({ symbol }) => symbol),
      cuts,
    };
  };
}
