import { z } from "zod";
import type { Fact } from "../core/domain/shared/fact.ts";
import type { Recovery } from "./recovery.ts";

export const responseModeSchema = z
  .enum(["summary", "details", "full"])
  .default("summary")
  .describe("Presentation only; coverage/traversal unchanged. summary=findings; details=evidence/locations; full=complete structuredContent + content navigation, without duplicate text.");

export type ResponseMode = z.infer<typeof responseModeSchema>;
export type ToolFamily = "entrypoints" | "callers" | "impact" | "importers" | "outline" | "workspace" | "decisions";
export type RenderContext = { tool: ToolFamily; recovery?: Recovery };
export type ResponseRenderer<T> = (fact: Fact<T>, mode: ResponseMode, context?: RenderContext) => string;
