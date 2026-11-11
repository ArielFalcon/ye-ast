import { basename, resolve } from "node:path";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { EXIT_CODE, isJdkHome } from "../cli/main.ts";
import { repositoryCatalog, type RepositoryBinding } from "../mcp/repository-targeting.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import type { ProcessHost } from "./process-host.ts";
import { createEvidenceComposition } from "../core/application/composition/evidence-composition.ts";
import { javaSourcesDeclared, nodeModulesDeclared, type DeclaredBuildOutput } from "../core/domain/shared/build-outputs.ts";

const USAGE = "usage: ye-ast mcp [<launch-root>] [--repo <id> <root>]... [--node-modules [<at>=]<path>]... [--java-sources <at>=<path>]... [--jdk <path>] [--answer-bytes <n>]";

/**
 * `ye-ast mcp [<launch-root>] [--repo <id> <root>]... [--node-modules [<at>=]<path>]... [--java-sources <at>=<path>]...`:
 * serves declared repositories over stdio. Only the launch repository is warmed; each request retains its own trust
 * check. A `--node-modules` or `--java-sources` declares a build output of the launch repository (ADR-0037, ADR-0044).
 */
export async function runMcp(args: readonly string[], host: ProcessHost): Promise<number> {
  let index = 0;
  const launchPath = args[0] !== undefined && !args[0].startsWith("-") ? args[index++] : ".";
  const declarations: { repoId: string; path: string }[] = [];
  const outputs: DeclaredBuildOutput[] = [];
  let jdkPath: string | undefined;
  let answerBytes: number | undefined;
  while (index < args.length) {
    const flag = args[index++];
    if (flag === "--answer-bytes") {
      const value = args[index++];
      if (answerBytes !== undefined || value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) { host.err(USAGE); return EXIT_CODE.usage; }
      answerBytes = Number(value);
      continue;
    }
    if (flag === "--jdk") {
      const path = args[index++];
      if (!path || path.startsWith("-") || jdkPath !== undefined) {
        host.err(USAGE);
        return EXIT_CODE.usage;
      }
      jdkPath = resolve(host.cwd, path);
      continue;
    }
    if (flag === "--node-modules" || flag === "--java-sources") {
      const spec = args[index++] ?? "";
      const declared = flag === "--node-modules" ? nodeModulesDeclared(spec) : javaSourcesDeclared(spec);
      if (declared === undefined) {
        host.err(USAGE);
        return EXIT_CODE.usage;
      }
      outputs.push({ ...declared, path: resolve(host.cwd, declared.path) });
      continue;
    }
    const repoId = args[index++];
    const path = args[index++];
    if (flag !== "--repo" || !repoId || !path || repoId.startsWith("-") || path.startsWith("-")) {
      host.err(USAGE);
      return EXIT_CODE.usage;
    }
    declarations.push({ repoId, path });
  }
  if (!launchPath || (jdkPath !== undefined && !(await isJdkHome(jdkPath)))) {
    host.err(USAGE);
    return EXIT_CODE.usage;
  }
  let launchRoot: string | undefined;
  const queries = host.queries({ trustRecord: true, ...(outputs.length > 0 && { buildOutputs: (repo: string) => (repo === launchRoot ? outputs : undefined) }) });
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
  launchRoot = repo;
  const wire = new StdioServerTransport(host.stdin, host.stdout);
  const closed = new Promise<void>((done) => {
    const close = wire.close.bind(wire);
    wire.close = async () => {
      await close();
      done();
    };
  });
  const handle = serveStdio(() => {
    const digest = createSha256Digest();
    return createMcpServer({ ...queries, digest, evidenceComposition: createEvidenceComposition(digest), repository, repositories: bindings, ...(answerBytes === undefined ? {} : { answerBytes }) });
  }, {
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
