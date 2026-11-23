/**
 * A computation split into bounded units of work (ADR-0156): each `yield` ends one unit, such as one file read or one
 * type walked, and the generator's return is the value. The units are the same however they are run, so the value is
 * too: only when the caller may run something else changes.
 */
export type Units<T> = Generator<void, T, undefined>;

/** What a reader awaits between two units: background work passes its turn to the queries of its process there. */
export type Between = () => Promise<void>;

/** The value, with every unit run at once: what a caller that never passes its turn gets. */
export function allUnits<T>(units: Units<T>): T {
  for (;;) {
    const next = units.next();
    if (next.done === true) return next.value;
  }
}

/**
 * The value of `units`: with every unit at once when `between` is absent, or with `between` awaited after each one. A
 * `between` that rejects ends the computation there: the generator is closed, so its `finally` blocks run, and the
 * rejection is the result.
 */
export async function unitsOf<T>(units: Units<T>, between: Between | undefined): Promise<T> {
  if (between === undefined) return allUnits(units);
  try {
    for (;;) {
      const next = units.next();
      if (next.done === true) return next.value;
      await between();
    }
  } finally {
    units.return(undefined as never);
  }
}
