import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { isTrustMode, type TrustMode } from "../../domain/shared/fact.ts";
import { privateToOwner } from "../../domain/shared/private-to-owner.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { TrustRecordFault, TrustRecords } from "../../ports/trust-record.port.ts";

export const RECORDS_DIRECTORY = "repositories";
const FORMAT_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface TrustRecordDeps {
  realpath: (path: string) => Promise<string>;
  lstat: (path: string) => Promise<Stats>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>;
  writeFile: (path: string, content: string, options: { mode: number; flag: "wx" }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string, options: { force: true }) => Promise<void>;
  /** The account the record must belong to; `undefined` where the platform has no such notion, which skips the ownership and mode checks. */
  ownerUid: number | undefined;
}

export const defaultTrustRecordDeps: TrustRecordDeps = { realpath, lstat, readFile, mkdir, writeFile, rename, rm, ownerUid: process.getuid?.() };

type Presence = "absent" | "private";

/**
 * Keeps one JSON file per repository, `repositories/<sha256 of the real path>.json` holding
 * `{ "version": 1, "repository": "<real path>", "trust": "<mode>" }`, inside `directory`, or nowhere when `directory`
 * is `null`. A directory or file that is a symbolic link, belongs to another account or is open to others is refused,
 * never repaired.
 */
export function createTrustRecords(directory: string | null, deps: TrustRecordDeps = defaultTrustRecordDeps): TrustRecords {
  const records = directory === null ? null : join(directory, RECORDS_DIRECTORY);
  const fileOf = (key: string): string => join(records!, `${createHash("sha256").update(key).digest("hex")}.json`);

  async function inspect(path: string): Promise<Result<Presence, TrustRecordFault>> {
    let status: Stats;
    try {
      status = await deps.lstat(path);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? { ok: true, value: "absent" } : fault("unreadable", error);
    }
    const refusal = deps.ownerUid === undefined ? null : privateToOwner({ symbolicLink: status.isSymbolicLink(), uid: status.uid, mode: status.mode }, deps.ownerUid);
    return refusal === null ? { ok: true, value: "private" } : { ok: false, fault: { kind: "refused", detail: `${path} ${refusal}` } };
  }

  async function inspectPresent(paths: readonly string[]): Promise<Result<Presence, TrustRecordFault>> {
    for (const path of paths) {
      const presence = await inspect(path);
      if (!presence.ok || presence.value === "absent") return presence;
    }
    return { ok: true, value: "private" };
  }

  return {
    async read(root) {
      if (directory === null || records === null) return { ok: true, value: undefined };
      const key = await deps.realpath(root).catch(() => undefined);
      if (key === undefined) return { ok: true, value: undefined };
      const file = fileOf(key);
      const presence = await inspectPresent([directory, records, file]);
      if (!presence.ok) return presence;
      if (presence.value === "absent") return { ok: true, value: undefined };
      try {
        return readMode(await deps.readFile(file, "utf8"), key, file);
      } catch (error) {
        return fault("unreadable", error);
      }
    },

    async write(root, mode) {
      if (directory === null || records === null) return { ok: false, fault: { kind: "no-location", detail: "the environment names no user configuration directory" } };
      let temporary: string | undefined;
      try {
        const key = await deps.realpath(root);
        const file = fileOf(key);
        for (const path of [directory, records]) {
          const presence = await inspect(path);
          if (!presence.ok) return presence;
          if (presence.value === "absent") await deps.mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
        }
        const held = await inspect(file);
        if (!held.ok) return held;
        if (held.value === "private") {
          const current = readMode(await deps.readFile(file, "utf8"), key, file);
          if (!current.ok) return current;
        }
        temporary = join(records, `.${randomUUID()}.tmp`);
        await deps.writeFile(temporary, `${JSON.stringify({ version: FORMAT_VERSION, repository: key, trust: mode }, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
        await deps.rename(temporary, file);
        return { ok: true, value: undefined };
      } catch (error) {
        if (temporary !== undefined) await deps.rm(temporary, { force: true }).catch(() => undefined);
        return fault("unwritable", error);
      }
    },
  };
}

function readMode(text: string, key: string, file: string): Result<TrustMode, TrustRecordFault> {
  let record: { version?: unknown; repository?: unknown; trust?: unknown } | null;
  try {
    record = JSON.parse(text);
  } catch {
    return { ok: false, fault: { kind: "unreadable", detail: `${file} is not valid JSON` } };
  }
  if (record?.version !== FORMAT_VERSION) return { ok: false, fault: { kind: "unreadable", detail: `${file} is not a version ${FORMAT_VERSION} trust record` } };
  if (record.repository !== key) return { ok: false, fault: { kind: "unreadable", detail: `${file} records another repository` } };
  if (!isTrustMode(record.trust)) return { ok: false, fault: { kind: "unreadable", detail: `${file} holds no trust mode` } };
  return { ok: true, value: record.trust };
}

function fault(kind: "unreadable" | "unwritable", error: unknown): Result<never, TrustRecordFault> {
  return { ok: false, fault: { kind, detail: error instanceof Error ? error.message : String(error) } };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
