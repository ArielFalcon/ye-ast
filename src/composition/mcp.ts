import { basename, resolve } from "node:path";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { EXIT_CODE } from "../cli/main.ts";
import { createMcpServer } from "../mcp/server.ts";
import type { ProcessHost } from "./process-host.ts";

const USAGE = "usage: ye-ast mcp [<repo>]";

/**
 * `ye-ast mcp [<repo>]`: serves the read queries of one repository, the working directory by default, as MCP tools over
 * stdio until the client closes its end or the process is asked to stop. Under `trusted` it also starts building the
 * repository's live index in the background, so the first live query finds it.
 */
export async function runMcp(args: readonly string[], host: ProcessHost): Promise<number> {
  const [path, ...extra] = args;
  if (extra.length > 0 || path?.startsWith("-")) {
    host.err(USAGE);
    return EXIT_CODE.usage;
  }
  const repo = resolve(host.cwd, path ?? ".");
  const queries = host.queries({ trustRecord: true });
  const wire = new StdioServerTransport(host.stdin, host.stdout);
  const closed = new Promise<void>((done) => {
    const close = wire.close.bind(wire);
    wire.close = async () => {
      await close();
      done();
    };
  });
  const handle = serveStdio(() => createMcpServer({ ...queries, repository: { path: repo, repoId: basename(repo) } }), {
    transport: wire,
    onerror: (error) => host.err(`ye-ast: ${queries.redaction.redactError(error)}`),
  });
  void queries.warmLive(repo, host.signal).then((line) => {
    if (line !== null) host.err(line);
  });
  const stop = (): void => void handle.close();
  host.signal.addEventListener("abort", stop, { once: true });
  if (host.signal.aborted) stop();
  await closed;
  host.signal.removeEventListener("abort", stop);
  return host.signal.aborted ? EXIT_CODE.interrupted : EXIT_CODE.ok;
}
