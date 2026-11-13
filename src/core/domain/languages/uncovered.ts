import { classOfPath, isUncoveredJvmSource } from "./path-class.ts";

/**
 * Code in a language ye-ast declares no extractor for, so it may hold what an answer cannot read. Build configuration
 * and JVM tests declare no entrypoints and are not callers.
 */
export function isUncoveredSource(path: string): boolean {
  return classOfPath(path).kind === "uncovered-source";
}

/**
 * Whether a source an answer cannot read could hold what that answer derives, so leaving it unread makes the answer
 * incomplete. A repository that holds a source of a declared language answers from it: a language no declared
 * framework reads is outside that repository's declared scope, and the fact states the scope, so it is never a cut.
 * A repository that holds none is entirely outside the declared scope, so every source it cannot read cuts, because
 * nothing else could explain it. A JVM source cuts either way: Spring reads it and no extractor parses it.
 */
export function cutsCompleteness(path: string, declaredSource: boolean): boolean {
  return isUncoveredSource(path) && (!declaredSource || isUncoveredJvmSource(path));
}
