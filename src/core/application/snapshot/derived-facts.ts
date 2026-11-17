import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { SCHEMA, type TrustMode } from "../../domain/shared/fact.ts";
import type { DerivedFactDisk } from "../../ports/derived-fact-store.port.ts";
import type { DerivedFacts, DerivedFactsTally } from "../../ports/derived-facts.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SnapshotDataCache } from "./read-snapshot.ts";

type Counts = Omit<DerivedFactsTally, "factBytes" | "retainedBytes">;

const NO_COUNTS: Counts = { hits: 0, misses: 0, diskHits: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0 };

interface Address {
  /** In the snapshot data cache: the slot, the trust and the inputs. */
  key: string;
  /** On disk: the slot, its reader's version and the inputs, whatever the trust; absent for a slot with no version. Named only when the memory tier missed. */
  diskKey(): string | undefined;
}

/**
 * The derived facts of one snapshot read under `trust`, kept in the snapshot data cache (ADR-0035) and, for a slot that
 * `disk` gives a version, in its store across processes (ADR-0077). An input that is a file's content is named by its digest.
 */
export function createDerivedFacts(cache: SnapshotDataCache, digest: Digest, trust: TrustMode, disk?: DerivedFactDisk): DerivedFacts {
  const contentDigests = new WeakMap<SourceFile, string>();
  let tally = { ...NO_COUNTS };
  const addressOf = (slot: string, inputs: object): Address => {
    const version = disk?.versions[slot];
    let named: { key: string | undefined } | undefined;
    return {
      key: digest.of(canonicalJson({ schema: SCHEMA, fact: slot, trust, inputs })),
      diskKey: () => (named ??= { key: version === undefined ? undefined : digest.of(canonicalJson({ schema: SCHEMA, fact: slot, version, inputs })) }).key,
    };
  };
  const admit = (key: string, json: string): unknown => {
    const admission = cache.putFact(key, json);
    tally.admitted += admission.admitted ? 1 : 0;
    tally.admittedBytes += admission.admitted ? admission.entryBytes : 0;
    tally.skipped += admission.admitted ? 0 : 1;
    tally.evicted += admission.evicted;
    return JSON.parse(json);
  };
  const kept = ({ key, diskKey: diskKeyOf }: Address): unknown => {
    const value = cache.getFact(key);
    if (value !== undefined) {
      tally.hits++;
      return value;
    }
    const diskKey = diskKeyOf();
    const json = diskKey === undefined ? undefined : disk?.store.read(diskKey);
    if (json === undefined) {
      tally.misses++;
      return undefined;
    }
    tally.hits++;
    tally.diskHits++;
    return admit(key, json);
  };
  const keep = <T>({ key, diskKey: diskKeyOf }: Address, value: T): T => {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    const diskKey = diskKeyOf();
    if (diskKey !== undefined) disk?.store.write(diskKey, json);
    return admit(key, json) as T;
  };
  return {
    ofFile(slot, file, derive) {
      let content = contentDigests.get(file);
      if (content === undefined) {
        content = digest.of(file.content);
        contentDigests.set(file, content);
      }
      const address = addressOf(slot, { path: file.path, content });
      const value = kept(address);
      return value === undefined ? keep(address, derive()) : (value as ReturnType<typeof derive>);
    },
    async ofInputs(slot, inputs, derive) {
      const address = addressOf(slot, inputs);
      const value = kept(address);
      return value === undefined ? keep(address, await derive()) : (value as Awaited<ReturnType<typeof derive>>);
    },
    fingerprint: (inputs) => digest.of(canonicalJson(inputs)),
    drain() {
      const drained = { ...tally, ...cache.usage() };
      tally = { ...NO_COUNTS };
      return drained;
    },
  };
}
