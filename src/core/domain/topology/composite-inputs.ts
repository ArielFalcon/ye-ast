import { canonicalJson } from "../shared/canonical-json.ts";
import { compareText } from "../shared/code-node.ts";
import { sortedEngines, type DeclaredConfig, type FactBase, type FactProvenance } from "../shared/fact.ts";

/** Compose identities of actual reads and declared inputs, without hashing their result payloads. */
export function compositeBase(base: FactBase, reads: readonly { kind: string; fact: FactProvenance }[], declared: unknown, digest: (value: string) => string, config: DeclaredConfig = base.inputs.declaredConfig): FactBase {
  const contributions = reads.map(({ kind, fact }) => ({ kind, snapshot: fact.snapshot, schema: fact.schema, producer: fact.producer, inputs: fact.inputs, status: fact.status, ...(fact.status === "partial" ? { cuts: fact.cuts } : fact.status === "unknown" ? { reason: fact.reason } : {}) }))
    .toSorted((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
  const versions = new Map<string, Set<string>>();
  for (const { fact } of reads) for (const [name, version] of Object.entries(fact.inputs.engines)) {
    const held = versions.get(name) ?? new Set<string>();
    held.add(version);
    versions.set(name, held);
  }
  const engines = sortedEngines(Object.fromEntries([...versions].flatMap(([name, values]) => values.size === 1 ? [[name, [...values][0]!]] : [])));
  const { origin: _origin, ...inputs } = base.inputs;
  return { ...base, inputs: { ...inputs, content: digest(canonicalJson({ contributions, declared })), config: digest(canonicalJson({ contributions, declared, config })), declaredConfig: config, engines } };
}
