import { constants } from "node:os";
import { EXIT_CODE } from "../cli/main.ts";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

export interface InterruptWatch {
  /** Aborted by the first SIGINT or SIGTERM; later ones are absorbed while the run cleans up. */
  signal: AbortSignal;
  /** The code the process exits with: 128 plus the signal number when the run ended because of the signal. */
  exitCode(runCode: number): number;
}

export interface SignalSource {
  on(name: (typeof SIGNALS)[number], listener: () => void): unknown;
}

export function watchInterrupts(source: SignalSource): InterruptWatch {
  const aborter = new AbortController();
  let received: (typeof SIGNALS)[number] | undefined;
  for (const name of SIGNALS) {
    source.on(name, () => {
      received ??= name;
      aborter.abort();
    });
  }
  return {
    signal: aborter.signal,
    exitCode: (runCode) => (received !== undefined && runCode === EXIT_CODE.interrupted ? 128 + constants.signals[received] : runCode),
  };
}
