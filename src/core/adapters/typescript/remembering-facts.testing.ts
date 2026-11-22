import { frozenValue } from "../../domain/shared/frozen-value.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";

/** Derived facts in memory, frozen as the snapshot data cache answers them (ADR-0126), recording each derivation as `slot` or `slot path`. */
export function rememberingFacts(): DerivedFacts & { derived: string[] } {
  const kept = new Map<string, string>();
  const derived: string[] = [];
  return {
    derived,
    ofFile(slot, file, derive) {
      const key = JSON.stringify([slot, file.path, file.content]);
      if (!kept.has(key)) {
        derived.push(`${slot} ${file.path}`);
        kept.set(key, JSON.stringify(derive()));
      }
      return frozenValue(kept.get(key)!) as never;
    },
    async ofInputs(slot, inputs, derive) {
      const key = JSON.stringify([slot, inputs]);
      if (!kept.has(key)) {
        derived.push(slot);
        kept.set(key, JSON.stringify(await derive()));
      }
      return frozenValue(kept.get(key)!) as never;
    },
    ofReads: (_slot, _subject, _answerNow, derive) => derive(() => undefined),
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, diskHits: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
}
