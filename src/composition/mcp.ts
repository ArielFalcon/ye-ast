import { basename, resolve } from "node:path";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { EXIT_CODE } from "../cli/main.ts";
import { repositoryCatalog, type RepositoryBinding } from "../mcp/repository-targeting.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import type { ProcessHost } from "./process-host.ts";

const USAGE = "usage: ye-ast mcp [<launch-root>] [--repo <id> <root>]...";

/**
 * `ye-ast mcp [<launch-root>] [--repo <id> <root>]...`: serves declared repositories over stdio.
 * Only the launch repository is warmed; each request retains its own trust check.
 */
export async function runMcp(args: readonly string[], host: ProcessHost): Promise<number> {
  let index = 0;
  const launchPath = args[0] !== undefined && !args[0].startsWith("-") ? args[index++] : ".";
  const declarations: { repoId: string; path: string }[] = [];
  while (index < args.length) {
    const flag = args[index++];
    const repoId = args[index++];
    const path = args[index++];
    if (flag !== "--repo" || !repoId || !path || repoId.startsWith("-") || path.startsWith("-")) {
      host.err(USAGE);
      return EXIT_CODE.usage;
    }
    declarations.push({ repoId, path });
  }
  if (!launchPath) {
    host.err(USAGE);
    return EXIT_CODE.usage;
  }
  const queries = host.queries({ trustRecord: true });
  const canonical = async (path: string) => queries.canonicalRepositoryRoot(resolve(host.cwd, path), host.signal);
  const root = await canonical(launchPath);
  if (host.signal.aborted) return EXIT_CODE.interrupted;
  if (!root.ok) {
    host.err(`ye-ast: ${root.fault.kind}: ${queries.redaction.redact(root.fault.detail)}`);
    return root.fault.kind === "aborted" ? EXIT_CODE.interrupted : EXIT_CODE.queryFailed;
  }
  const bindings: RepositoryBinding[] = [];
  for (const declaration of declarations) {
    const result = await canonical(declaration.path);
    if (host.signal.aborted) return EXIT_CODE.interrupted;
    if (!result.ok) {
      host.err(`ye-ast: ${result.fault.kind}: ${queries.redaction.redact(result.fault.detail)}`);
      return result.fault.kind === "aborted" ? EXIT_CODE.interrupted : EXIT_CODE.queryFailed;
    }
    bindings.push({ path: result.value, repoId: declaration.repoId });
  }
  const explicit = bindings.find((binding) => binding.path === root.value);
  const named = explicit === undefined ? await queries.repositoryName(root.value, host.signal) : undefined;
  if (host.signal.aborted || (named !== undefined && !named.ok && named.fault.kind === "aborted")) return EXIT_CODE.interrupted;
  const repoId = explicit?.repoId ?? (named?.ok ? named.value : basename(root.value));
  const repository = { path: root.value, repoId };
  if (!repositoryCatalog(repository, bindings).valid) {
    host.err("ye-ast: invalid repository catalog: conflicting IDs or roots");
    return EXIT_CODE.usage;
  }
  const repo = root.value;
  const wire = new StdioServerTransport(host.stdin, host.stdout);
  const closed = new Promise<void>((done) => {
    const close = wire.close.bind(wire);
    wire.close = async () => {
      await close();
      done();
    };
  });
  const handle = serveStdio(() => createMcpServer({ ...queries, digest: createSha256Digest(), repository, repositories: bindings }), {
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
