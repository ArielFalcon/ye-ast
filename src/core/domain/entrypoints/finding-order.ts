import type { Evidence, Finding } from "../shared/fact.ts";
import { compareText } from "../shared/code-node.ts";

/**
 * The order the extractor port promises: by evidence location, then by kind and name, an unknown item after the
 * entrypoints at its location; a finding that repeats another one is kept once.
 */
export function sortFindings<T extends { kind: string; name: string }>(findings: readonly Finding<T>[]): Finding<T>[] {
  const unique = new Map(findings.map((finding) => [JSON.stringify(finding), finding]));
  return [...unique.values()].sort((a, b) => {
    const [from, to] = [where(a), where(b)];
    return compareText(from.path, to.path) || from.line - to.line || compareText(tieBreak(a), tieBreak(b));
  });
}

function where(finding: Finding<unknown>): Evidence {
  return finding.evidence[0] ?? { path: "", line: 0 };
}

function tieBreak(finding: Finding<{ kind: string; name: string }>): string {
  if (finding.status === "complete") return `0 ${finding.value.kind} ${finding.value.name}`;
  return `1 ${finding.reason} ${finding.evidence.map((evidence) => `${evidence.path}:${evidence.line}`).join(" ")}`;
}
