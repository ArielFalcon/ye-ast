import type { UnresolvedCallSite } from "../core/domain/topology/call-site.ts";
import { z } from "zod";
import type { Cut, Fact } from "../core/domain/shared/fact.ts";
import type { Recovery } from "./recovery.ts";

export const responseModeSchema = z
  .enum(["summary", "details", "full"])
  .default("summary")
  .describe("Presentation only; coverage/traversal unchanged. summary=findings; details=evidence/locations; full=complete result JSON + navigation text.");

export type ResponseMode = z.infer<typeof responseModeSchema>;
export type ToolFamily = "entrypoints" | "callers" | "impact" | "importers" | "outline" | "workspace" | "decisions";
export type RenderContext = { tool: ToolFamily; recovery?: Recovery };
export type ResponseRenderer<T> = (fact: Fact<T>, mode: ResponseMode, context?: RenderContext) => string;

export function unresolvedLabel(site: UnresolvedCallSite): string {
  const labels = { "source-not-read": "missing", "request-not-found": "read", "dispatch-disagreement": "conflict", recursive: "cycle", "destination-undecidable": "target" } as const;
  return site.reason === "source-unreadable" ? "parse" : site.diagnostic === undefined ? "unknown" : labels[site.diagnostic.cause];
}

export function dependencyDiagnosticText(dependency: NonNullable<Cut["dependency"]>): string {
  return `dependency ${dependency.name}: ${dependency.reason} (${dependency.candidates.join(", ")})`;
}
