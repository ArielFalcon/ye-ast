import type { DispatchTargets } from "../../ports/import-origins.port.ts";

/** A dispatch answer without the places of its cause, for a test that pins the reason a call was refused. */
export function withoutCause(targets: DispatchTargets): DispatchTargets {
  return targets.kind === "unknown" ? { kind: "unknown", ...(targets.reason === undefined ? {} : { reason: targets.reason }) } : targets;
}
