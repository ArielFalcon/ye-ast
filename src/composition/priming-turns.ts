import type { PrimingTurns } from "../core/application/live/live-priming.ts";

/**
 * The turns launch priming takes around the queries of its process: each query counts from the moment its family is
 * called until its answer settles, and priming waits while any query counts.
 */
export function queriesFirst(): { counted<T extends object>(family: T): T; turns: PrimingTurns } {
  let active = 0;
  let waiting: (() => void)[] = [];
  const arrivals = new Set<() => void>();
  const queriesDone = (signal?: AbortSignal): Promise<void> => {
    if (active === 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resume) => {
      waiting.push(resume);
      signal?.addEventListener("abort", () => resume(), { once: true });
    });
  };
  const finished = (): void => {
    active -= 1;
    if (active > 0) return;
    const resumed = waiting;
    waiting = [];
    for (const resume of resumed) resume();
  };
  return {
    counted<T extends object>(family: T): T {
      const wrapped: T = Object.create(family);
      for (const method in family) {
        const call = family[method];
        if (typeof call !== "function") continue;
        Object.defineProperty(wrapped, method, {
          value: async (...args: unknown[]) => {
            active += 1;
            for (const arrived of [...arrivals]) arrived();
            try {
              return await call.apply(family, args);
            } finally {
              finished();
            }
          },
        });
      }
      return wrapped;
    },
    turns: {
      queryWaiting: () => active > 0,
      queriesDone,
      passTurn: async (signal) => {
        await new Promise<void>((ran) => setImmediate(ran));
        if (active === 0 || signal?.aborted) return false;
        await queriesDone(signal);
        return true;
      },
      onQuery: (arrived) => {
        const listener = (): void => arrived();
        arrivals.add(listener);
        return () => void arrivals.delete(listener);
      },
    },
  };
}
