import type { Readable, Writable } from "node:stream";
import { composeQueries, type ComposedQueries } from "./compose.ts";

export interface ProcessHost {
  /** What a relative or omitted repository path is resolved against. */
  cwd: string;
  /** Aborted when the process is asked to stop. */
  signal: AbortSignal;
  /** The command's wire: the client's messages in, ye-ast's out. Nothing else is ever written to `stdout`. */
  stdin: Readable;
  stdout: Writable;
  /** Diagnostics; the only channel besides the wire. */
  err(line: string): void;
  /**
   * Built only once the command line is valid. With `trustRecord` the queries read the user's trust declaration of
   * each repository; without it every repository is read `untrusted`, since a host declares the mode itself.
   */
  queries(options?: { trustRecord?: boolean }): ComposedQueries;
}

/** The host of the real process; `indexCache` is the directory that keeps full indexes between calls, `trustDirectory` the one that holds the trust record. */
export function processHost(options: { signal: AbortSignal; indexCache?: string; trustDirectory?: string}): ProcessHost {
  const err = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  return {
    cwd: process.cwd(),
    signal: options.signal,
    stdin: process.stdin,
    stdout: process.stdout,
    err,
    queries: ({ trustRecord = false } = {}) =>
      composeQueries({
        measure: err,
        ...(options.indexCache !== undefined && { indexCache: options.indexCache }),
        ...(trustRecord && options.trustDirectory !== undefined && { trustDirectory: options.trustDirectory, reportTrustFault: err }),
      }),
  };
}
