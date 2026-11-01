import { EXIT_CODE } from "../cli/main.ts";
import { serveQueries } from "../protocol/query-server.ts";
import type { ProcessHost } from "./process-host.ts";

const USAGE = "usage: ye-ast serve";

/** `ye-ast serve`: the query protocol on the host's stdin and stdout until the input ends or the process is asked to stop. */
export async function runServe(args: readonly string[], host: ProcessHost): Promise<number> {
  if (args.length > 0) {
    host.err(USAGE);
    return EXIT_CODE.usage;
  }
  await serveQueries(host.queries(), { input: host.stdin, output: host.stdout, signal: host.signal });
  return host.signal.aborted ? EXIT_CODE.interrupted : EXIT_CODE.ok;
}
