import type { DerivedFacts } from "../../ports/derived-facts.port.ts";

/** Derived facts in memory: what each derivation did is listed in `derived` (`slot path`) and in `reads` (`hit` and `miss` of `ofReads`). */
export function rememberingFacts(): DerivedFacts & { derived: string[]; reads: { hits: number; misses: number } } {
  const kept = new Map<string, string>();
  const entries = new Map<string, string>();
  const derived: string[] = [];
  const reads = { hits: 0, misses: 0 };
  return {
    derived,
    reads,
    ofFile(slot, file, derive) {
      const key = JSON.stringify([slot, file.path, file.content]);
      if (!kept.has(key)) {
        derived.push(`${slot} ${file.path}`);
        kept.set(key, JSON.stringify(derive()));
      }
      return JSON.parse(kept.get(key)!);
    },
    async ofInputs(slot, inputs, derive) {
      const key = JSON.stringify([slot, inputs]);
      if (!kept.has(key)) {
        derived.push(slot);
        kept.set(key, JSON.stringify(await derive()));
      }
      return JSON.parse(kept.get(key)!);
    },
    async ofReads(slot, subject, answerNow, derive) {
      const key = JSON.stringify([slot, subject]);
      const entry = entries.has(key) ? (JSON.parse(entries.get(key)!) as { value: never; reads: [string, string][] }) : undefined;
      if (entry !== undefined && entry.reads.every(([question, answer]) => answerNow(question) === answer)) {
        reads.hits++;
        return entry.value;
      }
      reads.misses++;
      derived.push(`${slot} ${JSON.stringify(subject)}`);
      const recorded = new Map<string, string>();
      const value = await derive((question, answer) => void recorded.set(question, answer));
      entries.set(key, JSON.stringify({ value, reads: [...recorded] }));
      return value;
    },
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, diskHits: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
}
