import type { EntrypointMapFact } from "../../domain/map/entrypoint-map.ts";
import { sameIdentity, type Fact } from "../../domain/shared/fact.ts";
import type { EntrypointQueries } from "../../ports/entrypoint-queries.port.ts";
import type { FixedLayerAdmin, FixedLayerRefresh } from "../../ports/fixed-layer-admin.port.ts";
import type { FixedLayerStore } from "../../ports/fixed-layer-store.port.ts";
import type { Redaction } from "../../ports/redaction.port.ts";
import { renderEntrypointsDigest } from "./entrypoints-digest.ts";

export const ENTRYPOINTS_FACT_FILE = "entrypoints.json";
export const ENTRYPOINTS_DIGEST_FILE = "README.md";

export interface FixedLayerAdminDeps {
  entrypoints: EntrypointQueries;
  store: FixedLayerStore;
  /** Built without by-value secrets: the layer applies the patterns only (RFC-0002 rule 7). */
  redaction: Redaction;
}

export function createFixedLayerAdmin({ entrypoints, store, redaction }: FixedLayerAdminDeps): FixedLayerAdmin {
  return {
    async refresh(request) {
      const mapped = await entrypoints.map(request);
      if (!mapped.ok) return mapped;
      const unstorable = unstorableReason(mapped.value);
      if (unstorable !== undefined) return { ok: true, value: { outcome: "not-written", reason: unstorable } };

      const fact = redaction.redactValue(mapped.value) as EntrypointMapFact;
      const storedFact = await store.read(request.repo, ENTRYPOINTS_FACT_FILE);
      if (!storedFact.ok) return storedFact;
      const storedDigest = await store.read(request.repo, ENTRYPOINTS_DIGEST_FILE);
      if (!storedDigest.ok) return storedDigest;
      const layer = [
        { name: ENTRYPOINTS_DIGEST_FILE, content: renderEntrypointsDigest(fact) },
        { name: ENTRYPOINTS_FACT_FILE, content: `${JSON.stringify(fact, null, 2)}\n` },
      ];
      const files = layer.map(({ name }) => name);
      if (storedFact.value !== undefined && storedDigest.value !== undefined && sameStoredInputs(storedFact.value, fact)) {
        return { ok: true, value: { outcome: "unchanged", files } };
      }

      // The fact is written last: with the digest present it alone decides "unchanged".
      for (const { name, content } of layer) {
        const written = await store.write(request.repo, name, content);
        if (!written.ok) return written;
      }
      return { ok: true, value: { outcome: "written", files } };
    },
  };
}

function sameStoredInputs(storedJson: string, fact: EntrypointMapFact): boolean {
  try {
    const stored = JSON.parse(storedJson) as Partial<EntrypointMapFact> | null;
    if (stored?.schema === undefined || stored.inputs === undefined || stored.producer === undefined) return false;
    return sameIdentity({ schema: stored.schema, inputs: stored.inputs, producer: stored.producer }, fact);
  } catch {
    return false;
  }
}

function unstorableReason(map: EntrypointMapFact): Extract<FixedLayerRefresh, { outcome: "not-written" }>["reason"] | undefined {
  const section = map.value.entrypoints;
  const facts: Fact<unknown>[] = [map, section, ...(section.status === "unknown" ? [] : section.value)];
  const reasons = facts.map(factReason);
  return reasons.includes("deadline") ? "deadline" : reasons.includes("index-unavailable") ? "index-unavailable" : undefined;
}

function factReason(fact: Fact<unknown>): string | undefined {
  if (fact.status === "unknown") return fact.reason;
  if (fact.status === "partial") return fact.cuts.find((cut) => cut.kind === "deadline")?.kind;
  return undefined;
}
