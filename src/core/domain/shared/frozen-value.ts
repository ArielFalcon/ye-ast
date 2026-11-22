/** `json` decoded once and deep-frozen: what the snapshot data cache keeps and answers on every hit and miss (ADR-0126). */
export function frozenValue(json: string): unknown {
  return deepFreeze(JSON.parse(json));
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
