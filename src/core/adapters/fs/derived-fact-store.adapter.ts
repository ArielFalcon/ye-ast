import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateToOwner } from "../../domain/shared/private-to-owner.ts";
import { retentionDiscards } from "../../domain/snapshot/live-retention.ts";
import type { DerivedFactRetentionPolicy, DerivedFactStore } from "../../ports/derived-fact-store.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import { DEBRIS_STALE_MS } from "../../ports/live-mirror.port.ts";

export interface DerivedFactStoreDeps {
  /** ye-ast's per-user cache directory; the entries live under its `derived-facts/`. */
  directory: string;
  digest: Digest;
  /** Without it nothing is removed for age or size. */
  retention?: DerivedFactRetentionPolicy;
  now?: () => number;
}

const ROOT = "derived-facts";
const TEMPORARY_PREFIX = ".tmp-";
const SHARD_LENGTH = 2;
const PRIVATE = 0o700;
const OWNER_ONLY_FILE = 0o600;

/**
 * Entries are `<key>\n<digest of key and value>\n<value>` files, one per key, written beside their name and renamed into
 * place. The cache directory is used only while it is private to the account (as the index cache's is).
 */
export function createDerivedFactStore(deps: DerivedFactStoreDeps): DerivedFactStore {
  const root = join(deps.directory, ROOT);
  const now = deps.now ?? Date.now;
  let usable: boolean | undefined;
  let swept = false;
  let sequence = 0;
  const pathOf = (key: string): string => join(root, key.slice(0, SHARD_LENGTH), key);
  const sumOf = (key: string, json: string): string => deps.digest.of(`${key}\n${json}`);

  function prepared(): boolean {
    if (usable !== undefined) return usable;
    try {
      mkdirSync(root, { recursive: true, mode: PRIVATE });
      const ownerUid = process.getuid?.();
      for (const directory of [deps.directory, root]) {
        const status = lstatSync(directory);
        if (ownerUid !== undefined && privateToOwner({ symbolicLink: status.isSymbolicLink(), uid: status.uid, mode: status.mode }, ownerUid) !== null) return (usable = false);
      }
      return (usable = true);
    } catch {
      return (usable = false);
    }
  }

  function markUsed(path: string): void {
    const used = new Date(now());
    try {
      utimesSync(path, used, used);
    } catch {
      return;
    }
  }

  /** Removes entries by the policy and the temporary files a killed write left, once per store, never failing the write it precedes. */
  function sweep(current: string): void {
    if (swept || deps.retention === undefined) return;
    swept = true;
    try {
      const usage = new Map<string, { bytes: number; lastUsedMs: number }>();
      for (const shard of readdirSync(root, { withFileTypes: true })) {
        if (!shard.isDirectory()) continue;
        for (const entry of readdirSync(join(root, shard.name), { withFileTypes: true })) {
          const path = join(shard.name, entry.name);
          const status = statSync(join(root, path), { throwIfNoEntry: false });
          if (status === undefined) continue;
          if (!entry.name.startsWith(TEMPORARY_PREFIX)) usage.set(path, { bytes: status.size, lastUsedMs: status.mtimeMs });
          else if (now() - status.mtimeMs > DEBRIS_STALE_MS) rmSync(join(root, path), { force: true });
        }
      }
      const scopes = [...usage].map(([scope, { bytes, lastUsedMs }]) => ({ scope, bytes, lastUsedMs, locked: false, versionsMatch: true }));
      const discards = retentionDiscards({ scopes, debris: [] }, current, { keepScopes: Number.POSITIVE_INFINITY, ...deps.retention }, now());
      for (const scope of discards.scopes) rmSync(join(root, scope), { force: true });
    } catch {
      return;
    }
  }

  return {
    read(key) {
      if (!prepared()) return undefined;
      const path = pathOf(key);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
      const [stated, sum, ...rest] = text.split("\n");
      const json = rest.join("\n");
      if (stated === key && sum === sumOf(key, json)) {
        markUsed(path);
        return json;
      }
      rmSync(path, { force: true });
      return undefined;
    },
    write(key, json) {
      if (!prepared()) return;
      const path = pathOf(key);
      const staging = join(root, key.slice(0, SHARD_LENGTH), `${TEMPORARY_PREFIX}${process.pid}-${sequence++}`);
      try {
        mkdirSync(join(root, key.slice(0, SHARD_LENGTH)), { recursive: true, mode: PRIVATE });
        writeFileSync(staging, `${key}\n${sumOf(key, json)}\n${json}`, { mode: OWNER_ONLY_FILE });
        renameSync(staging, path);
        sweep(join(key.slice(0, SHARD_LENGTH), key));
      } catch {
        rmSync(staging, { force: true });
      }
    },
  };
}
