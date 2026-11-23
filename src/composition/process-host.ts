import type { Readable, Writable } from "node:stream";
import type { AnswerFiles } from "../core/ports/answer-files.port.ts";
import { composeAnswerFiles } from "./answer-files.ts";
import type { DeclaredBuildOutput } from "../core/domain/shared/build-outputs.ts";
import type { DaemonLink } from "../daemon/daemon-link.ts";
import { composeQueries, type ComposedQueries } from "./compose.ts";
import { daemonBackedQueries, mcpConfiguration } from "./daemon-queries.ts";

export interface QueryOptions {
  trustRecord?: boolean;
  /** The build outputs declared for the launch repository, once `root` resolves it. */
  launchOutputs?: { outputs: readonly DeclaredBuildOutput[]; root(): string | undefined };
  /** Answers through the daemon when one of this version attaches, starting it when none does (the MCP server only). */
  throughDaemon?: boolean;
}

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
  queries(options?: QueryOptions): ComposedQueries;
  /** The same host over the cache directory a `--cache` flag names, which replaces the one it was built with: the index cache, the derived facts and the answer files all live in it. */
  withCache(directory: string): ProcessHost;
  /** Writes each answer as a folder of files under the per-user cache directory; absent when the host has none (ADR-0110). */
  answerFiles?: AnswerFiles;
}

/**
 * The host of the real process; `indexCache` is the directory that keeps full indexes between calls, `trustDirectory`
 * the one that holds the trust record, and `daemon` the link to the per-user daemon, absent when it is off.
 */
export function processHost(options: { signal: AbortSignal; indexCache?: string; trustDirectory?: string; daemon?: DaemonLink }): ProcessHost {
  const err = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  return {
    cwd: process.cwd(),
    signal: options.signal,
    stdin: process.stdin,
    stdout: process.stdout,
    err,
    ...(options.indexCache !== undefined && { answerFiles: composeAnswerFiles({ directory: options.indexCache, report: err }) }),
    withCache: (directory) => processHost({ ...options, indexCache: directory }),
    queries: ({ trustRecord = false, launchOutputs, throughDaemon = false } = {}) => {
      const trustDirectory = trustRecord ? options.trustDirectory : undefined;
      const local = composeQueries({
        signal: options.signal,
        measure: err,
        ...(launchOutputs !== undefined && { buildOutputs: (repo: string) => (repo === launchOutputs.root() ? launchOutputs.outputs : undefined) }),
        ...(options.indexCache !== undefined && { indexCache: options.indexCache }),
        ...(trustDirectory !== undefined && { trustDirectory, reportTrustFault: err }),
      });
      if (!throughDaemon || options.daemon === undefined) return local;
      const launch = (): { repo: string; outputs: readonly DeclaredBuildOutput[] } | undefined => {
        const repo = launchOutputs?.root();
        return launchOutputs === undefined || repo === undefined ? undefined : { repo, outputs: launchOutputs.outputs };
      };
      return daemonBackedQueries(local, { link: options.daemon, startsDaemon: true, measure: err, report: err, configuration: () => mcpConfiguration({ indexCache: options.indexCache, trustDirectory, launch: launch() }) });
    },
  };
}
