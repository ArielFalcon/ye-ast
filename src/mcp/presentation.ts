import type { UnresolvedCallSite } from "../core/domain/topology/call-site.ts";
import { z } from "zod";
import type { Cut, Fact } from "../core/domain/shared/fact.ts";
import type { TraceEffect } from "../core/domain/trace/trace-fact.ts";
import type { Recovery } from "./recovery.ts";
import type { QueryFamily } from "../core/ports/evidence-composition.port.ts";

export const responseModeSchema = z
  .enum(["summary", "details", "full"])
  .default("summary")
  .describe("Presentation: summary=findings, details=evidence, full=result JSON+navigation. Coverage unchanged.");

export type ResponseMode = z.infer<typeof responseModeSchema>;
export type RenderContext = { tool: QueryFamily; recovery?: Recovery };
export type ResponseRenderer<T> = (fact: Fact<T>, mode: ResponseMode, context?: RenderContext) => string;

export function unresolvedLabel(site: UnresolvedCallSite): string {
  const labels = { "source-not-read": "missing", "request-not-found": "read", "dispatch-disagreement": "conflict", recursive: "cycle", "destination-undecidable": "target" } as const;
  return site.reason === "source-unreadable" ? "parse" : site.diagnostic === undefined ? "unknown" : labels[site.diagnostic.cause];
}

export function dependencyDiagnosticText(dependency: NonNullable<Cut["dependency"]>): string {
  return `dependency ${dependency.name}: ${dependency.reason} (${dependency.candidates.join(", ")})`;
}

/** An effect as one phrase, with its operation and proven target. */
export function effectText(effect: TraceEffect): string {
  if (effect.kind === "data") return `data ${effect.access} ${effect.operation}${effect.target === undefined ? "" : ` ${effect.target.kind} ${effect.target.name}`}`;
  if (effect.kind === "http") return `http ${effect.target.method} ${effect.target.path}${effect.target.base === undefined ? "" : ` base ${effect.target.base}`}`;
  return `message ${effect.target.protocol} ${effect.target.destination}`;
}
