import type { Link } from "../core/domain/topology/link.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type { PublicRead } from "../core/ports/evidence-composition.port.ts";

/** The key of each distinct link id: its one-based position among the links of the answer, in the order they are listed. */
function keyTable(ids: Iterable<string>): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  for (const id of ids) if (!keys.has(id)) keys.set(id, String(keys.size + 1));
  return keys;
}

const keyOf = (keys: ReadonlyMap<string, string>, id: string): string => keys.get(id) ?? id;

/** A workspace impact answer with answer-local link keys; a reach entry naming no link of the answer keeps its id. */
export function keyWorkspaceImpactLinks(value: WorkspaceImpactValue): WorkspaceImpactValue {
  const keys = keyTable(value.links.map(({ link }) => link.id));
  return { ...value, links: value.links.map((item) => ({ ...item, link: { ...item.link, id: keyOf(keys, item.link.id) }, reach: item.reach.map((id) => keyOf(keys, id)) })) };
}

/** A workspace answer with answer-local link keys, numbering its internal links after the links across repositories. */
export function keyWorkspaceLinks<V extends { links: readonly Link[]; internalLinks: readonly Link[] }>(value: V): V {
  const keys = keyTable([...value.links, ...value.internalLinks].map(({ id }) => id));
  const keyed = (link: Link): Link => ({ ...link, id: keyOf(keys, link.id) });
  return { ...value, links: value.links.map(keyed), internalLinks: value.internalLinks.map(keyed) };
}

/** A trace answer with answer-local link keys. */
export function keyTraceLinks(value: TraceValue): TraceValue {
  if (value.links === undefined) return value;
  const keys = keyTable(value.links.map(({ id }) => id));
  return { ...value, links: value.links.map((link) => ({ ...link, id: keyOf(keys, link.id) })) };
}

/** The read with the value of its fact rewritten; an unknown fact has no value to rewrite. */
export function withKeyedValue<V>(read: PublicRead<V>, keyed: (value: V) => V): PublicRead<V> {
  const { fact } = read;
  return fact.status === "unknown" ? read : { ...read, fact: { ...fact, value: keyed(fact.value) } };
}
