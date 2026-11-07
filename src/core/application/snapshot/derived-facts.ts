import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { TrustMode } from "../../domain/shared/fact.ts";
import type { DerivedFacts, DerivedFactsTally } from "../../ports/derived-facts.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SnapshotDataCache } from "./read-snapshot.ts";

type Counts = Omit<DerivedFactsTally, "factBytes" | "retainedBytes">;

const NO_COUNTS: Counts = { hits: 0, misses: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0 };

/**
 * The derived facts of one snapshot read under `trust`, kept in the snapshot data cache (ADR-0035). A key names the
 * slot, the trust and the inputs, a file's content by its digest.
 */
export function createDerivedFacts(cache: SnapshotDataCache, digest: Digest, trust: TrustMode): DerivedFacts {
  const contentDigests = new WeakMap<SourceFile, string>();
  let tally = { ...NO_COUNTS };
  const keyOf = (slot: string, inputs: object): string => digest.of(canonicalJson({ fact: slot, trust, inputs }));
  const kept = (key: string): unknown => {
    const value = cache.getFact(key);
    if (value === undefined) tally.misses++;
    else tally.hits++;
    return value;
  };
  const keep = <T>(key: string, value: T): T => {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    const admission = cache.putFact(key, json);
    tally.admitted += admission.admitted ? 1 : 0;
    tally.admittedBytes += admission.admitted ? admission.entryBytes : 0;
    tally.skipped += admission.admitted ? 0 : 1;
    tally.evicted += admission.evicted;
    return JSON.parse(json) as T;
  };
  return {
    ofFile(slot, file, derive) {
      let content = contentDigests.get(file);
      if (content === undefined) {
        content = digest.of(file.content);
        contentDigests.set(file, content);
      }
      const key = keyOf(slot, { path: file.path, content });
      const value = kept(key);
      return value === undefined ? keep(key, derive()) : (value as ReturnType<typeof derive>);
    },
    async ofInputs(slot, inputs, derive) {
      const key = keyOf(slot, inputs);
      const value = kept(key);
      return value === undefined ? keep(key, await derive()) : (value as Awaited<ReturnType<typeof derive>>);
    },
    fingerprint: (inputs) => digest.of(canonicalJson(inputs)),
    drain() {
      const drained = { ...tally, ...cache.usage() };
      tally = { ...NO_COUNTS };
      return drained;
    },
  };
}
