import type { DeclaredScope, ScopeSelection } from "../../domain/shared/fact.ts";
import { unmatchedIncludes } from "../../domain/shared/scope.ts";
import type { ScopeFault } from "../../ports/scope-fault.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";

export function scopeNotice(scope: DeclaredScope, matches: PathMatcher["matches"], selected: readonly string[] | undefined): Result<ScopeSelection | undefined, ScopeFault> {
  if (selected === undefined || scope.include.length === 0) return { ok: true, value: undefined };
  const unmatched = unmatchedIncludes(scope, matches, selected);
  if (unmatched.length === 0) return { ok: true, value: undefined };
  if (selected.length === 0) return { ok: false, fault: { kind: "unknown-scope-path", detail: `scope.include matches no path read from this commit: ${unmatched.join(", ")}`, globs: unmatched } };
  return { ok: true, value: { unmatchedIncludes: unmatched, selectedFiles: selected.length } };
}
