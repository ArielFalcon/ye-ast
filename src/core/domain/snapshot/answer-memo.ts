import type { Fact, UnknownReason } from "../shared/fact.ts";

/**
 * The `unknown` reasons a later call at the same snapshot identity may not answer: a wall-clock deadline, an index the
 * refresh did not finish, bytes another process moved after the pin, a revision not yet fetched (ADR-0151 decision 4).
 */
const TRANSIENT_REASONS: ReadonlySet<string> = new Set<UnknownReason>(["deadline", "index-unavailable", "source-unreadable", "revision-unavailable"]);

/**
 * Whether an answer may be kept for its snapshot identity: no part of it, however deep (a section, a finding, a cut),
 * carries a transient reason, so nothing `unknown` for one nor cut by a deadline is kept.
 */
export function isKeptAnswer(fact: Fact<unknown>): boolean {
  const pending: unknown[] = [fact];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.reason === "string" && TRANSIENT_REASONS.has(record.reason)) return false;
    pending.push(...Object.values(record));
  }
  return true;
}
