import type { RequestId } from "./protocol.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const isId = (value: unknown): value is RequestId => typeof value === "string" || typeof value === "number";
