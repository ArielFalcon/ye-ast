import { compareText } from "./code-node.ts";

/** A JSON string that depends on values only: object members sorted by key, `undefined` members dropped, arrays in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((member) => canonical(member));
  if (value === null || typeof value !== "object") return value;
  const members = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  return Object.fromEntries(members.map(([key, member]) => [key, canonical(member)]));
}
