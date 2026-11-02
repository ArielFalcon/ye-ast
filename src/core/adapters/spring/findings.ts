import type { Node } from "web-tree-sitter";
import type { Job, Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { Gap, GapReason, MethodDecl } from "./java-symbols.ts";

/** A route as the code maps it, before the configuration's base path is added. */
export type MappedRoute = Omit<HttpRoute, "basePath">;

/** An entrypoint as the code declares it: only a route gets the configuration's base path afterwards. */
export type MappedEntrypoint = MappedRoute | Listener | Job;

export function spanOf(path: string, node: { startPosition: { row: number }; endPosition: { row: number } }): Evidence {
  return { path, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

/** An unknown item. Its evidence never repeats a line: a span that starts where an earlier one starts and ends no later adds nothing. */
export function unknown(reason: GapReason, evidence: readonly Evidence[]): Finding<never> {
  return { status: "unknown", reason, evidence: evidence.filter((span, index) => !evidence.slice(0, index).some((earlier) => covers(earlier, span))) };
}

/** An unknown item at the method and at the constructs that left it undecided. */
export function unknownAt(method: MethodDecl, gap: Gap, ...also: Evidence[]): Finding<never> {
  return unknown(gap.reason, [spanOf(method.owner.file.path, method.node), spanOf(gap.file.path, gap.node), ...also]);
}

/** A target the snapshot does not decide, at the node it is written, naming the library the call goes through when it is one. */
export function unknownAtNode(path: string, node: Node, via?: string): Finding<never> {
  const span = spanOf(path, node);
  return { status: "unknown", reason: "unresolved", evidence: [via === undefined ? span : { ...span, via }] };
}

export function complete<T>(value: T): Finding<T> {
  return { status: "complete", value, evidence: [] };
}

/** A target reported at the place the call is written; an undecided one keeps the library it names. */
export function withEvidence<T>(target: Finding<T>, span: Evidence): Finding<T> {
  if (target.status === "unknown") {
    const via = target.evidence[0]?.via;
    return { ...target, evidence: [via === undefined ? span : { ...span, via }] };
  }
  return { ...target, evidence: [{ path: span.path, line: span.line }] };
}

function covers(earlier: Evidence, span: Evidence): boolean {
  return earlier.path === span.path && earlier.line === span.line && (earlier.endLine ?? earlier.line) >= (span.endLine ?? span.line);
}
