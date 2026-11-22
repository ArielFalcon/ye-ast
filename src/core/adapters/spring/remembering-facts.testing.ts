import { frozenValue } from "../../domain/shared/frozen-value.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

export const java = (name: string, lines: readonly string[], directory = "app"): SourceFile => ({ path: `src/main/java/${directory}/${name}.java`, content: `${lines.join("\n")}\n` });
export const edited = (file: SourceFile, replace: [string, string]): SourceFile => ({ path: file.path, content: file.content.replace(...replace) });

/** Derived facts in memory, frozen as the snapshot data cache answers them (ADR-0126): what each derivation did is listed in `derived` (`slot path`) and in `reads` (`hit` and `miss` of `ofReads`, in all and by slot). */
export function rememberingFacts(): DerivedFacts & { derived: string[]; reads: { hits: number; misses: number }; readsOf: (slot: string) => { hits: number; misses: number } } {
  const kept = new Map<string, string>();
  const entries = new Map<string, string>();
  const derived: string[] = [];
  const reads = { hits: 0, misses: 0 };
  const bySlot = new Map<string, { hits: number; misses: number }>();
  const tallyOf = (slot: string) => bySlot.get(slot) ?? bySlot.set(slot, { hits: 0, misses: 0 }).get(slot)!;
  return {
    derived,
    reads,
    readsOf: (slot) => ({ ...tallyOf(slot) }),
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
    async ofReads(slot, subject, answerNow, derive) {
      const key = JSON.stringify([slot, subject]);
      const entry = entries.has(key) ? (frozenValue(entries.get(key)!) as { value: never; reads: [string, string][] }) : undefined;
      if (entry !== undefined && entry.reads.every(([question, answer]) => answerNow(question) === answer)) {
        reads.hits++;
        tallyOf(slot).hits++;
        return entry.value;
      }
      reads.misses++;
      tallyOf(slot).misses++;
      derived.push(`${slot} ${JSON.stringify(subject)}`);
      const recorded = new Map<string, string>();
      const value = await derive((question, answer) => void recorded.set(question, answer));
      entries.set(key, JSON.stringify({ value, reads: [...recorded] }));
      return (frozenValue(entries.get(key)!) as { value: typeof value }).value;
    },
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, diskHits: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
}
