import { takeCacheFlag } from "../cli/cache-flag.ts";
import { EXIT_CODE } from "../cli/main.ts";
import { serveQueries } from "../protocol/query-server.ts";
import { hostWithCache } from "./cache-directory-refusal.ts";
import type { ProcessHost } from "./process-host.ts";

const USAGE = "usage: ye-ast serve [--cache <dir>]";

/** `ye-ast serve`: the query protocol on the host's stdin and stdout until the input ends or the process is asked to stop. */
export async function runServe(args: readonly string[], host: ProcessHost): Promise<number> {
  const taken = takeCacheFlag(args, host.cwd);
  if (taken === undefined || taken.rest.length > 0) {
    host.err(USAGE);
    return EXIT_CODE.usage;
  }
  const served = await hostWithCache(host, taken.directory);
  if (typeof served === "string") {
    host.err(served);
    return EXIT_CODE.usage;
  }
  await serveQueries(served.queries(), { input: host.stdin, output: host.stdout, signal: host.signal });
  return host.signal.aborted ? EXIT_CODE.interrupted : EXIT_CODE.ok;
}
