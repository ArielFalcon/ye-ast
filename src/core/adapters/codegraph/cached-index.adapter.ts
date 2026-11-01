import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privateToOwner } from "../../domain/shared/private-to-owner.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { CodeGraph, CodeGraphFault, IndexSummary } from "../../ports/code-graph.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { IndexCache, IndexedSnapshot } from "../../ports/index-cache.port.ts";
import { STAGING_RULES_VERSION } from "./stage-snapshot.ts";
import { SUPPORTED_STORE } from "./store-version.ts";

export interface IndexCacheDeps {
  /** Where the kept indexes live; created for its owner alone when absent. */
  directory: string;
  graph: CodeGraph;
  digest: Digest;
  /** The installed codegraph release. */
  codegraph: string;
  /** Version of the staging rules; the current ones by default. */
  stagingRules?: string;
}

const INDEXES = "indexes";
const SUMMARY_FILE = "summary.json";
const BUILD_PREFIX = ".build-";
const PRIVATE = 0o700;

type Summary = Omit<IndexSummary, "versions">;
type Entry = { state: "absent" } | { state: "unusable" } | { state: "usable"; indexed: IndexedSnapshot };

export function createIndexCache(deps: IndexCacheDeps): IndexCache {
  const indexes = join(deps.directory, INDEXES);
  const keyOf = (content: string): string =>
    deps.digest.of(JSON.stringify({ content, codegraph: deps.codegraph, store: SUPPORTED_STORE, stagingRules: deps.stagingRules ?? STAGING_RULES_VERSION }));

  async function openEntry(entry: string): Promise<Entry> {
    try {
      await stat(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
      return { state: "unusable" };
    }
    const summary = await readSummary(entry);
    const opened = deps.graph.open(entry);
    if (summary === null || !opened.ok) {
      if (opened.ok) opened.value.close();
      return { state: "unusable" };
    }
    return { state: "usable", indexed: { store: opened.value, summary: { ...summary, versions: opened.value.versions } } };
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  async function obtain({ content, snapshot, signal }: Parameters<IndexCache["obtain"]>[0]): Promise<Result<IndexedSnapshot, CodeGraphFault>> {
    const entry = join(indexes, keyOf(content));
    try {
      await mkdir(indexes, { recursive: true, mode: PRIVATE });
    } catch (error) {
      return unavailable(error);
    }
    for (const directory of [deps.directory, indexes]) {
      const reachable = await reachableByOthers(directory);
      if (reachable !== null) return unavailable(reachable);
    }
    const kept = await openEntry(entry);
    if (kept.state === "usable") return { ok: true, value: kept.indexed };

    const building = await mkdtemp(join(indexes, BUILD_PREFIX));
    let published = false;
    try {
      const built = await deps.graph.index(snapshot, building, signal);
      if (!built.ok) return built;
      const { versions: _versions, ...summary } = built.value;
      await writeFile(join(building, SUMMARY_FILE), JSON.stringify(summary));

      const stale = join(indexes, `${BUILD_PREFIX}stale-${randomUUID()}`);
      if (kept.state === "unusable") await rename(entry, stale).catch(() => undefined);
      try {
        await rename(building, entry);
        published = true;
      } catch (error) {
        if (!(await exists(entry))) return unavailable(error);
      }
      if (kept.state === "unusable") await rm(stale, { recursive: true, force: true });

      const opened = await openEntry(entry);
      return opened.state === "usable" ? { ok: true, value: opened.indexed } : { ok: false, fault: { kind: "cache-unavailable", detail: `${entry} cannot be opened after it was published` } };
    } catch (error) {
      return unavailable(error);
    } finally {
      if (!published) await rm(building, { recursive: true, force: true });
    }
  }

  return { obtain };
}

/** An entry another account could have written is no fact source, so the cache is refused rather than repaired. */
async function reachableByOthers(directory: string): Promise<string | null> {
  const ownerUid = process.getuid?.();
  if (ownerUid === undefined) return null;
  const status = await lstat(directory);
  const refusal = privateToOwner({ symbolicLink: status.isSymbolicLink(), uid: status.uid, mode: status.mode }, ownerUid);
  return refusal === null ? null : `${directory} ${refusal}`;
}

async function readSummary(entry: string): Promise<Summary | null> {
  try {
    const summary = JSON.parse(await readFile(join(entry, SUMMARY_FILE), "utf8")) as Summary;
    const counts = [summary.filesIndexed, summary.filesSkipped, summary.filesErrored];
    return counts.every(Number.isInteger) && Array.isArray(summary.filesNotIndexed) ? summary : null;
  } catch {
    return null;
  }
}

function unavailable(error: unknown): Result<never, CodeGraphFault> {
  return { ok: false, fault: { kind: "cache-unavailable", detail: error instanceof Error ? error.message : String(error) } };
}
