import type { Node } from "web-tree-sitter";
import type { Job, Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import { distinctEvidence, spanCovers, type Evidence, type Finding, type UnknownReason } from "../../domain/shared/fact.ts";
import type { Gap, MethodDecl } from "./java-symbols.ts";
import type { CallSite, PlacedCallSite } from "../../domain/topology/call-site.ts";

/** A route as the code maps it, before the configuration's base path is added. */
export type MappedRoute = Omit<HttpRoute, "basePath">;

/** An entrypoint as the code declares it: only a route gets the configuration's base path afterwards. */
export type MappedEntrypoint = MappedRoute | Listener | Job;

export function spanOf(path: string, node: { startPosition: { row: number }; endPosition: { row: number } }): Evidence {
  return { path, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

/** An unknown item. Its evidence never repeats a line: a span that starts where an earlier one starts and ends no later adds nothing. */
export function unknown(reason: UnknownReason, evidence: readonly Evidence[]): Finding<never> {
  return { status: "unknown", reason, evidence: distinctEvidence(evidence) };
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
    return { ...target, evidence: [via === undefined ? span : { ...span, via }, ...target.evidence.filter((cause) => !spanCovers(span, cause))] };
  }
  return { ...target, evidence: [{ path: span.path, line: span.line }] };
}

/** Where each site a Java reader builds starts, kept beside the site so the facts that report call sites never carry it. */
export const CALL_PLACES = new WeakMap<CallSite, Omit<PlacedCallSite, "site">>();

/** The site, with its place recorded: the column its call node starts at, or the declaration that states it. */
export function placed(site: CallSite, node: { startPosition: { column: number } }, declaration = false): CallSite {
  CALL_PLACES.set(site, declaration ? { declaration: true } : { column: node.startPosition.column });
  return site;
}

/** Records the source bodies and leaf occurrences that produced a propagated call site, outside its public fact. */
export function fromBodies(site: CallSite, groups: readonly { leaf: { invocation: { type: { file: { path: string } }; node: Node } }; bodies: ReadonlySet<MethodDecl> }[]): CallSite {
  const origins = groups.flatMap(({ leaf, bodies }) => [
    ...[...bodies].map((method) => ({ file: method.owner.file.path, node: method.node.childForFieldName("name") ?? method.node })),
    { file: leaf.invocation.type.file.path, node: leaf.invocation.node },
  ]).map(({ file, node }) => ({ file, line: node.startPosition.row + 1, column: node.startPosition.column }));
  CALL_PLACES.set(site, { ...CALL_PLACES.get(site), origins });
  return site;
}
