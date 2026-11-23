import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import type { DeclaredBuildOutput } from "../core/domain/shared/build-outputs.ts";
import type { WarmingFault } from "../core/application/live/live-warming.ts";
import type { DaemonLink } from "../daemon/daemon-link.ts";
import { daemonDialectClient, DaemonUnavailableError, type DaemonDialectClient } from "../protocol/daemon-dialect-client.ts";
import type { ComposedQueries } from "./composed-queries.ts";

/**
 * Everything a client composes that can change an answer (ADR-0157 decision 2): the daemon forks one worker per
 * repository and configuration and composes it with exactly these options.
 */
export interface QueryConfiguration {
  indexCache?: string;
  cacheDirectory?: string;
  trustDirectory?: string;
  /** The build outputs the client declares for one repository, the MCP launch repository. */
  buildOutputs?: { repo: string; outputs: readonly DeclaredBuildOutput[] };
}

/** The configuration of an MCP server's worker; `init` warms the same one, so the sessions it registers find it warm. */
export function mcpConfiguration(options: { indexCache?: string | undefined; trustDirectory?: string | undefined; launch?: { repo: string; outputs: readonly DeclaredBuildOutput[] } | undefined }): QueryConfiguration {
  return {
    ...(options.indexCache !== undefined && { indexCache: options.indexCache }),
    ...(options.trustDirectory !== undefined && { trustDirectory: options.trustDirectory }),
    ...(options.launch !== undefined && options.launch.outputs.length > 0 && { buildOutputs: options.launch }),
  };
}

export interface DaemonClientOptions {
  link: DaemonLink;
  /** Read at each attach: the MCP server knows its launch repository only once it resolved it. */
  configuration(): QueryConfiguration;
  /** The MCP server starts the daemon when it finds none; a one-shot CLI command does not (ADR-0157 decision 8). */
  startsDaemon: boolean;
  /** Receives the worker's measurement lines for this client's calls; they are dropped without it. */
  measure?: (line: string) => void;
  /** Receives diagnostics: the worker's trust-record line, and why a call fell back to the process. */
  report(line: string): void;
}

/**
 * Starts the daemon when absent and asks it to prime `repo` for the MCP configuration, returning once the request is
 * written, never once the priming ended (ADR-0157 decision 8); `false` when no daemon of this version attached in time.
 */
export async function requestWarm(link: DaemonLink, repo: string, repoId: string, configuration: QueryConfiguration): Promise<boolean> {
  const attachment = await link.attachStarting(repo, { ...configuration }, START_WAIT_MS);
  if (attachment.kind !== "attached") return false;
  void daemonDialectClient({ input: attachment.socket, output: attachment.socket }, () => undefined).warm(repo, repoId).catch(() => undefined);
  await new Promise<void>((resolve) => attachment.socket.end(resolve));
  return true;
}

/** How long the launch priming waits for a daemon it started before it primes in process. */
const START_WAIT_MS = 10_000;

type Family = "entrypoints" | "impact" | "outline" | "trace" | "workspace" | "workspaceImpact" | "contractConsequences" | "decisions";

function repositoryOf(request: unknown): string | undefined {
  const repo = (request as { repo?: unknown }).repo;
  if (typeof repo === "string") return repo;
  const path = (repo as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : undefined;
}

/**
 * The composed queries with each read family answered by the daemon's worker of the request's repository when one of
 * this version attaches, and by `local` otherwise, or when the daemon cannot finish the call (ADR-0157 decision 7).
 */
export function daemonBackedQueries(local: ComposedQueries, options: DaemonClientOptions): ComposedQueries {
  const clients = new Map<string, DaemonDialectClient>();
  let mismatchSaid = false;

  const clientFor = async (repo: string, starting: boolean): Promise<DaemonDialectClient | undefined> => {
    const key = canonicalJson(repo);
    const known = clients.get(key);
    if (known !== undefined && !known.closed) return known;
    const configuration = { ...options.configuration() };
    const attachment = starting ? await options.link.attachStarting(repo, configuration, START_WAIT_MS) : await options.link.attach(repo, configuration);
    if (attachment.kind === "absent" && options.startsDaemon) options.link.start();
    if (attachment.kind === "version-mismatch" && !mismatchSaid) {
      mismatchSaid = true;
      options.report(local.redaction.redact(`ye-ast: the daemon runs ye-ast ${attachment.producer}, not ${local.version}; answering in process while it exits`));
    }
    if (attachment.kind !== "attached") return undefined;
    const client = daemonDialectClient({ input: attachment.socket, output: attachment.socket }, (kind, line) => (kind === "measure" ? options.measure?.(line) : options.report(line)));
    clients.set(key, client);
    return client;
  };

  const through = <F extends Family>(family: F, operations: readonly (keyof ComposedQueries[F] & string)[]): ComposedQueries[F] => {
    const methods: Record<string, (request: object) => Promise<unknown>> = {};
    for (const operation of operations) {
      const inProcess = (request: object): Promise<unknown> => (local[family] as unknown as Record<string, (request: object) => Promise<unknown>>)[operation]!(request);
      methods[operation] = async (request) => {
        const repo = repositoryOf(request);
        const client = repo === undefined ? undefined : await clientFor(repo, false);
        if (client === undefined) return inProcess(request);
        try {
          return await client.call(`${family}.${operation}`, request);
        } catch (error) {
          if (!(error instanceof DaemonUnavailableError)) throw error;
          if (error.reason === "closed") options.report("ye-ast: the daemon connection closed before the answer; answered in process");
          return inProcess(request);
        }
      };
    }
    return methods as unknown as ComposedQueries[F];
  };

  return {
    ...local,
    entrypoints: through("entrypoints", ["map"]),
    impact: through("impact", ["ofChange", "callers", "importers"]),
    outline: through("outline", ["outline"]),
    trace: through("trace", ["walk"]),
    workspace: through("workspace", ["outwardNames"]),
    workspaceImpact: through("workspaceImpact", ["callers", "ofChange"]),
    contractConsequences: through("contractConsequences", ["ofHypotheses", "ofChange"]),
    decisions: through("decisions", ["decisions"]),
    warmLive: async (repo, signal, repoId) => {
      const client = await clientFor(repo, options.startsDaemon);
      if (client !== undefined) {
        try {
          return (await client.warm(repo, repoId)) as WarmingFault | null;
        } catch (error) {
          if (!(error instanceof DaemonUnavailableError)) throw error;
        }
      }
      return local.warmLive(repo, signal, repoId);
    },
  };
}
