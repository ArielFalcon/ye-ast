import { z } from "zod";
import type { Fact } from "../core/domain/shared/fact.ts";
import type { Recovery } from "./recovery.ts";

export const responseModeSchema = z
  .enum(["summary", "details", "full"])
  .default("summary")
  .describe("Response presentation only: summary identifies consequences or findings; details adds recorded evidence and locations for investigation; full returns the complete structured result with contextual JSON navigation, without repeating the text projection. Coverage and traversal bounds do not change.");

export type ResponseMode = z.infer<typeof responseModeSchema>;
export type ToolFamily = "entrypoints" | "callers" | "impact" | "importers" | "outline" | "workspace" | "decisions";
export type RenderContext = { tool: ToolFamily; recovery?: Recovery };
export type ResponseRenderer<T> = (fact: Fact<T>, mode: ResponseMode, context?: RenderContext) => string;
